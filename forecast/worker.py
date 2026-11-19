"""评价四只场内 ETF 的 20 日收益分位数。每个起点只读取已收盘的历史。"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from statistics import fmean
import sys

HORIZON = 20
CONTEXT = 512
DECAY = 0.94
START_TEST = "2025-11-18"
END_TEST = "2026-11-18"
LEVELS = (0.1, 0.5, 0.9)
RULES = {
    "flat": "持平 + 历史区间",
    "mean": "历史均值 + 历史区间",
    "ewma": "持平 + EWMA 波动区间",
}


def quantile(values, level):
    ordered = sorted(values)
    if not ordered:
        raise ValueError("历史样本不足")
    at = (len(ordered) - 1) * level
    rank = math.floor(at)
    weight = at - rank
    return ordered[rank] * (1 - weight) + ordered[min(rank + 1, len(ordered) - 1)] * weight


def history(funds):
    histories = {code: dict(series) for code, series in funds.items()}
    days = sorted(set.intersection(*(set(series) for series in histories.values())))
    values = {code: [math.log(series[day]) for day in days] for code, series in histories.items()}
    return days, values


def ewma_volatility(log_prices):
    variance = 0.0
    path = [0.0]
    for before, after in zip(log_prices, log_prices[1:]):
        variance = DECAY * variance + (1 - DECAY) * (after - before) ** 2
        path.append(math.sqrt(variance))
    return path


def full_windows(origin):
    # 向前取互不重叠的 20 日窗口，终点均已在预测当日可见。
    return range(origin - HORIZON, HORIZON - 1, -HORIZON)


def rule_forecasts(log_prices, volatility, origin):
    starts = list(full_windows(origin))
    realized = [log_prices[start + HORIZON] - log_prices[start] for start in starts]
    empirical = [quantile(realized, level) for level in LEVELS]
    flat = [value - empirical[1] for value in empirical]
    mean = fmean(realized)
    drift = [value + mean for value in flat]
    scaled = [
        value / max(volatility[start], 1e-6)
        for start, value in zip(starts, realized)
    ]
    distribution = [quantile(scaled, level) for level in LEVELS]
    risk = [(value - distribution[1]) * volatility[origin] for value in distribution]
    return {
        "flat": [math.expm1(value) for value in flat],
        "mean": [math.expm1(value) for value in drift],
        "ewma": [math.expm1(value) for value in risk],
    }


def model_forecasts(model, checkpoint, values, origins):
    import torch

    torch.set_num_threads(4)
    if model == "simons":
        from simons import Simons

        pipeline = Simons.from_pretrained(str(checkpoint), device="cpu")
    elif model == "chronos":
        from chronos import Chronos2Pipeline

        pipeline = Chronos2Pipeline.from_pretrained(str(checkpoint), device_map="cpu")
    else:
        raise ValueError("未知模型")

    forecasts = {}
    with torch.inference_mode():
        for origin in origins:
            contexts = torch.tensor([
                [price - prices[origin] for price in prices[max(0, origin - CONTEXT + 1):origin + 1]]
                for prices in values.values()
            ], dtype=torch.float32)

            if model == "simons":
                prediction = pipeline.forecast(contexts, horizon=HORIZON)[:, -1, [0, 4, 8]]
            else:
                quantiles, _ = pipeline.predict_quantiles(
                    [prices[None, :] for prices in contexts],
                    prediction_length=HORIZON,
                    quantile_levels=list(LEVELS),
                    cross_learning=False,
                )
                prediction = torch.stack([prediction[0, -1] for prediction in quantiles])

            if prediction.shape != (len(values), len(LEVELS)) or not torch.isfinite(prediction).all():
                raise ValueError("模型返回了无效的分位数")
            forecasts[origin] = [
                sorted(math.expm1(value) for value in triplet)
                for triplet in prediction.detach().cpu().tolist()
            ]
    return forecasts


def pinball(estimate, actual):
    return fmean(max(level * (actual - value), (level - 1) * (actual - value))
                 for level, value in zip(LEVELS, estimate))


def summarize(model, latest, forecasts, values, evaluation, name, revision):
    samples = []
    for origin in evaluation:
        for index, prices in enumerate(values.values()):
            realized = math.expm1(prices[origin + HORIZON] - prices[origin])
            samples.append((forecasts[origin][index], realized))
    return {
        "id": model,
        "name": name,
        "revision": revision,
        "predictions": {
            code: {"close": math.exp(values[code][latest]), "quantiles": estimate}
            for code, estimate in zip(values, forecasts[latest])
        },
        "metrics": {
            "pinball": fmean(pinball(estimate, actual) for estimate, actual in samples),
            "mae": fmean(abs(estimate[1] - actual) for estimate, actual in samples),
            "coverage": fmean(estimate[0] <= actual <= estimate[2] for estimate, actual in samples),
            "width": fmean(estimate[2] - estimate[0] for estimate, _ in samples),
        },
    }


def evaluate(funds, model_dir, rules_only=False):
    days, values = history(funds)
    start = next(index for index, day in enumerate(days) if day >= START_TEST)
    end = max(index for index, day in enumerate(days) if day <= END_TEST)
    evaluation = list(range(start, end - HORIZON + 1, HORIZON))
    if start < 100 or len(evaluation) < 3:
        raise ValueError("固定检验区间内的历史不足")
    latest = len(days) - 1
    origins = [*evaluation, latest]
    volatility = {code: ewma_volatility(prices) for code, prices in values.items()}
    all_rules = {model: {} for model in RULES}
    for origin in origins:
        for series, prices in values.items():
            rules = rule_forecasts(prices, volatility[series], origin)
            for model, estimate in rules.items():
                all_rules[model].setdefault(origin, []).append(estimate)
    ranked = [
        summarize(model, latest, forecasts, values, evaluation, RULES[model], "rules-v1")
        for model, forecasts in all_rules.items()
    ]
    skipped = []
    specs = json.loads(Path(__file__).with_name("models.json").read_text())
    if not rules_only:
        for spec in specs:
            checkpoint = model_dir / spec["id"]
            if not (checkpoint / "model.safetensors").is_file():
                skipped.append({"name": spec["name"], "reason": "模型权重未安装"})
                continue
            try:
                print(f"正在检验 {spec['name']}，{len(evaluation)} 个时间窗口", file=sys.stderr, flush=True)
                forecasts = model_forecasts(spec["id"], checkpoint, values, origins)
                ranked.append(summarize(spec["id"], latest, forecasts, values, evaluation, spec["name"], spec["revision"]))
            except Exception as error:
                print(f"{spec['name']}: {error}", file=sys.stderr, flush=True)
                skipped.append({"name": spec["name"], "reason": f"推理失败（{type(error).__name__}）"})

    ranked.sort(key=lambda model: model["metrics"]["pinball"])
    return {
        "origin": days[latest],
        "horizon": HORIZON,
        "historicalStart": days[0],
        "benchmark": {
            "from": days[evaluation[0]],
            "through": days[evaluation[-1] + HORIZON],
            "windows": len(evaluation),
            "fundObservations": len(evaluation) * len(values),
        },
        "selected": ranked[0]["id"],
        "models": ranked,
        "skipped": skipped,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, default=Path(__file__).parent / ".models")
    parser.add_argument("--rules-only", action="store_true")
    args = parser.parse_args()
    result = evaluate(json.load(sys.stdin), args.model_dir, args.rules_only)
    json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)


if __name__ == "__main__":
    main()
