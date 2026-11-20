import { formatAmounts, onBudgetChange } from "./etf-budget.js";

const node = (id) => document.getElementById(id);
const fundPicker = node("etfBacktestFunds");
const budgetInput = node("etfBacktestBudget");
const dateStart = node("etfBacktestStart");
const dateEnd = node("etfBacktestEnd");
const run = node("etfRunBacktest");
const canvas = node("etfEquityChart");
const drawdownCanvas = node("etfDrawdownChart");
const status = node("etfBacktestStatus");
const viewControl = node("etfBacktestView");
const limitControl = node("etfPremiumLimit");
const strategySet = node("etfStrategySet");
const orderStrategy = node("etfFixedOrderStrategy");

const presentation = {
  once: { name: "一次买入", color: "#1d4ed8" },
  monthly: { name: "12 笔分批", color: "#0f766e" },
  signal: { name: "三信号（无杠杆）", color: "#b45309" },
  factor: { name: "趋势 · 波动控仓 · 溢价择券", color: "#a21caf" },
  firstOpen: { name: "仅月初开盘限价", color: "#475467" },
  anyOpen: { name: "月内开盘限价", color: "#6d28d9" },
  resting: { name: "盘中限价", color: "#b45309" },
  monthly10: { name: "12 笔分批（万十）", color: "#0f766e" },
  anyOpen10: { name: "月内开盘限价（万十）", color: "#6d28d9" },
  restingStrict: { name: "盘中限价（穿 3 档、万十）", color: "#b45309" },
  trend: { name: "仅趋势控仓", color: "#1d4ed8" },
  vol: { name: "仅波动控仓", color: "#b45309" },
  trendVol: { name: "趋势和波动控仓", color: "#a21caf" },
  base80: { name: "80% 分批，20% 持现", color: "#475467" },
  reserveRsi: { name: "80% 分批 + RSI 加仓", color: "#0f766e" },
  reserveDrawdown: { name: "80% 分批 + 回撤加仓", color: "#a21caf" },
};
const fixedViews = {
  entry: {
    ids: ["once", "monthly", "firstOpen", "anyOpen", "resting"],
    primary: "anyOpen",
    note: "月内限价待到当月首次满足条件的开盘。盘中候选用同样的盘前限价，最低价至少穿过一档才估算成交。",
  },
  sizing: {
    ids: ["monthly", "anyOpen", "trend", "vol", "trendVol"],
    primary: "trendVol",
    note: "过去 126 个美股交易日趋势非正、20 日波动率高于历史第 80 百分位，各使本月额度减半。",
  },
  reserve: {
    ids: ["anyOpen", "base80", "reserveRsi", "reserveDrawdown"],
    primary: "reserveRsi",
    note: "20% 预留现金分两档。RSI(14) 阈值为 30 和 20。回撤阈值为 12% 和 20%，以 252 个交易日内 5 日均价的峰值为基准。各指数各档最多成交一次，并须满足开盘限价。",
  },
  stress: {
    ids: ["monthly10", "anyOpen10", "restingStrict"],
    primary: "restingStrict",
    note: "统一用单边万分之十交易摩擦。盘中候选要求最低价穿过盘前限价至少三档，按限价模拟。",
  },
  delayed: {
    ids: ["anyOpen", "resting", "base80", "reserveRsi", "reserveDrawdown"],
    primary: "anyOpen",
    note: "净值假设延迟五个沪深交易日可用，并以相同口径在 2023 至 2024 年重新计算溢价阈值。",
  },
};
const indexNames = { NDX: "纳指 100", NBI: "纳指生物科技" };
const actionLabels = {
  bottomAttack: "底部加仓",
  rampTqqq: "低位渐进",
  smallDipBuy: "小幅回撤加仓",
  crashDefense: "急跌减仓",
  trimHeat: "过热减仓",
  pauseAtHigh: "暂停加仓",
  normalDca: "正常投入",
};
const percentage = (fraction) => (fraction * 100).toFixed(2) + "%";
const budgetChanged = "初始资金已修改，运行回测可更新下方结果。";
let funds = [];
let shown;
let active;
let busy = false;
let orderOptions = [];
let orderMode;
const plots = new Map();

function selectedCodes() {
  return Array.from(fundPicker.querySelectorAll("input:checked"), (input) => input.value);
}

function renderFundPicker(data) {
  funds = data.funds;
  fundPicker.replaceChildren(...funds.map(({ code, manager, index }) => {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = code;
    input.checked = data.selected.includes(code);
    const label = document.createElement("label");
    label.append(input, index === "纳斯达克100" ? `${code} ${manager}` : `${code} 生物科技`);
    return label;
  }));
}

function applyDateBounds(codes) {
  const selected = funds.filter(({ code }) => codes.includes(code));
  if (!selected.length) return;
  const first = selected.map(({ start }) => start).sort().at(-1);
  const last = selected.map(({ end }) => end).sort()[0];
  for (const input of [dateStart, dateEnd]) {
    input.min = first;
    input.max = last;
    if (input.value && input.value < first) input.value = first;
    if (input.value > last) input.value = last;
  }
}

function strategyPresentation(strategy) {
  return strategy.id === "premium"
    ? { name: `溢价 ≤ ${strategy.limit}%`, color: "#6d28d9" }
    : presentation[strategy.id];
}

function readout(index) {
  const { unit, format } = formatAmounts(active.budget);
  const values = active.strategies.map((item) =>
    `${strategyPresentation(item).name} ${format(item.equity[index])} ${unit} / ${percentage(item.drawdowns[index])}`);
  node("etfEquityReadout").textContent = `${active.sessions[index]} · ${values.join(" · ")}`;
}

function drawChart(chart, key, selectedDay) {
  if (!active || !chart.clientWidth) return;
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  chart.width = Math.round(width * ratio);
  chart.height = Math.round(height * ratio);
  const ctx = chart.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.font = "12px system-ui";
  const { budget, sessions, strategies } = active;
  const drawdown = key === "drawdowns";
  const reference = drawdown ? 0 : budget;
  const format = drawdown ? percentage : formatAmounts(budget).format;
  const low = Math.min(reference, ...strategies.map((item) => Math.min(...item[key])));
  const high = Math.max(reference, ...strategies.map((item) => Math.max(...item[key])));
  const minStep = drawdown ? 0.001 : budget >= 10_000 ? 100 : 1;
  const targetStep = Math.max(minStep, (high - low) / 4);
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const step = Math.ceil(targetStep / magnitude) * magnitude;
  const min = Math.floor((drawdown ? Math.min(-step, low) : low) / step) * step;
  const max = Math.max(min + step, Math.ceil(high / step) * step);
  const left = Math.max(56, Math.ceil(Math.max(ctx.measureText(format(min)).width, ctx.measureText(format(max)).width)) + 15);
  const right = width - 15;
  const top = 12;
  const bottom = height - 26;
  const x = (index) => left + index / Math.max(1, sessions.length - 1) * (right - left);
  const y = (value) => bottom - (value - min) / (max - min) * (bottom - top);
  plots.set(chart, { left, right, count: sessions.length });

  for (let level = Math.round(min / step); level <= Math.round(max / step); level += 1) {
    const value = level * step;
    ctx.strokeStyle = value === reference ? "#98a2b3" : "#d4dbe5";
    ctx.beginPath();
    ctx.moveTo(left, y(value));
    ctx.lineTo(right, y(value));
    ctx.stroke();
    ctx.fillStyle = "#475467";
    ctx.textAlign = "right";
    ctx.fillText(format(value), left - 8, y(value) + 4);
  }
  strategies.forEach((strategy) => {
    ctx.strokeStyle = strategyPresentation(strategy).color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [index, value] of strategy[key].entries()) {
      if (index === 0) ctx.moveTo(x(index), y(value));
      else ctx.lineTo(x(index), y(value));
    }
    ctx.stroke();
  });

  const labels = width > 640 ? [0, Math.round((sessions.length - 1) / 2), sessions.length - 1] : [0, sessions.length - 1];
  for (const [index, dayIndex] of labels.entries()) {
    ctx.textAlign = index === 0 ? "left" : index === labels.length - 1 ? "right" : "center";
    ctx.fillStyle = "#475467";
    ctx.fillText(sessions[dayIndex], x(dayIndex), height - 5);
  }

  if (selectedDay !== undefined) {
    ctx.strokeStyle = "#667085";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(selectedDay), top);
    ctx.lineTo(x(selectedDay), bottom);
    ctx.stroke();
  }
}

function drawCharts(selectedDay) {
  drawChart(canvas, "equity", selectedDay);
  drawChart(drawdownCanvas, "drawdowns", selectedDay);
}

function option(value, label) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function dataRow(values, firstHeading = true) {
  const row = document.createElement("tr");
  for (const [index, value] of values.entries()) {
    const cell = document.createElement(firstHeading && index === 0 ? "th" : "td");
    if (cell.tagName === "TH") cell.scope = "row";
    cell.textContent = value;
    row.append(cell);
  }
  return row;
}

function renderPurchases(trial) {
  node("etfPremiumPurchases").hidden = !trial;
  if (!trial) return;
  const rows = trial.purchases.map((fill) => dataRow([
    fill.date, fill.code, fill.open.toFixed(3), fill.nav.toFixed(4),
    fill.navDate, percentage(fill.open / fill.nav - 1),
  ]));
  node("etfPremiumFills").replaceChildren(...rows);
  node("etfPremiumFillsWrap").hidden = !rows.length;
  node("etfPremiumNoPurchases").hidden = Boolean(rows.length);
}

function renderFactorLog(factor, visible) {
  const info = node("etfFactorStatus");
  info.hidden = !visible;
  node("etfFactorLog").hidden = !visible || !factor?.strategy;
  if (!visible) return;
  if (!factor?.strategy) {
    const unavailable = {
      beforeSample: `因子样本外比较从 ${shown.factorSampleStart} 开始，请调整开始日期。`,
      unsupported: `当前组合含因子数据未覆盖的 ETF（${factor?.unsupported?.join("、") ?? ""}）。可以切换到已覆盖的单只 ETF。`,
      missingInputs: "因子所需的历史指数或净值尚未就绪。下方显示同区间的基准策略。",
    };
    info.textContent = unavailable[factor?.unavailable] ?? unavailable.missingInputs;
    return;
  }
  const groups = factor.groups.map(({ index, weight }) => `${indexNames[index]} ${Math.round(weight * 100)}%`).join("、");
  info.textContent =
    `按 ${factor.policy.fitStart} 至 ${factor.policy.fitEnd} 的数据定阈值 · 组合预算 ${groups} · 溢价用当时可用的单位净值估算`;
  const { format } = formatAmounts(1);
  const reasons = {
    indexUnavailable: "开盘前的指数数据不足，持有现金。",
    priorPremiumUnavailable: "缺少近期的候选溢价，持有现金。",
    openingUnavailable: "缺少当时可用的净值或当天开盘价，持有现金。",
    aboveLimit: "开盘价超过限价，未成交。",
    limitMet: "开盘价满足限价，模拟成交。",
  };
  const rows = factor.decisions.map((decision) => {
    const { signal, volatilityLimit, code, index, open, limitPrice, amount, proposedAmount } = decision;
    const signalText = signal ? `趋势 ${percentage(signal.trend)} · 波动 ${percentage(signal.volatility)}` : "—";
    const row = dataRow([
      decision.date,
      code ?? "—",
      signalText,
      open === undefined ? "—" : `${open.toFixed(3)} / ${limitPrice.toFixed(4)} 元`,
      proposedAmount === undefined ? "—" : `${format(proposedAmount)} 元`,
      `${format(amount)} 元`,
      reasons[decision.reason],
    ]);
    row.dataset.reason = decision.reason;
    const details = (column, value) => {
      const text = document.createElement("small");
      text.textContent = value;
      row.cells[column].append(text);
    };
    details(1, indexNames[index]);
    if (signal) {
      const cuts = [];
      if (decision.trendReduced) cuts.push("趋势非正，额度减半");
      if (decision.volatilityReduced) cuts.push("波动超阈值，额度减半");
      details(2, `截至 ${signal.date} · 波动阈值 ${percentage(volatilityLimit)}`);
      details(6, cuts.length ? cuts.join("。") : "趋势为正、波动在阈值内，使用本组当月额度。");
    }
    if (decision.candidates) {
      const selection = decision.candidates.length > 1 ? "择取前次估算溢价最低的一只" : "本组的候选 ETF";
      const premiums = decision.candidates.map((candidate) =>
        `${candidate.code} ${percentage(candidate.premium)}（${candidate.date}）`).join("、");
      details(6, `${selection}。前次估算 ${premiums}。`);
    }
    if (open !== undefined) {
      details(3, `开盘估算 ${percentage(decision.openingPremium)} · 阈值 ${percentage(decision.premiumLimit)}`);
      details(6, `用于限价的净值为 ${decision.navDate} 估值，${decision.navUsableDate} 起可用。`);
    }
    if (amount > 0) details(5, `含交易摩擦 ${format(decision.fee)} 元`);
    return row;
  });
  node("etfFactorRows").replaceChildren(...rows);
}

function renderFixedOrders() {
  const strategy = orderOptions.find(({ id }) => id === orderStrategy.value);
  if (!strategy) return;
  const { format } = formatAmounts(1);
  const rows = strategy.fills.map((fill) => {
    const { date, code, price, cap, size, amount, fee, execution, signalDate, navDate, navUsableDate } = fill;
    const reasons = [cap === undefined
      ? (strategy.id === "once" ? "区间首日开盘" : "本月首日开盘")
      : execution === "intraday" ? "日内最低价穿过盘前限价" : "开盘价满足盘前限价"];
    if (fill.trendReduced) reasons.push("趋势非正，额度减半");
    if (fill.volatilityReduced) reasons.push("波动超过阈值，额度减半");
    if (fill.reserveAmount > 0) {
      const signal = strategy.id === "reserveRsi" ? `RSI ${fill.signalValue.toFixed(2)}` : `回撤 ${percentage(-fill.signalValue)}`;
      reasons.push(`${signal}，本笔含加仓 ${format(fill.reserveAmount)} 元`);
    }
    const row = dataRow([
      date, code, `${price.toFixed(3)} / ${cap === undefined ? "—" : cap.toFixed(3)}`,
      String(size), `${format(amount)} 元`, reasons.join("。"),
    ]);
    const feeNote = document.createElement("small");
    feeNote.textContent = `交易费用 ${format(fee)} 元`;
    row.cells[4].append(feeNote);
    if (signalDate) {
      const inputNote = document.createElement("small");
      inputNote.textContent = `指数信号 ${signalDate} · 净值估值 ${navDate} · ${navUsableDate} 起可用`;
      row.cells[5].append(inputNote);
    }
    return row;
  });
  node("etfFixedOrderRows").replaceChildren(...rows);
  node("etfFixedOrdersWrap").hidden = !rows.length;
  node("etfFixedOrderCount").textContent = `此策略在所选区间模拟成交 ${rows.length} 笔。`;
}

function fixedView(scope, mode) {
  const view = fixedViews[mode];
  const status = node("etfFixedStatus");
  const study = mode === "delayed" ? scope.fixed?.late : scope.fixed;
  const ready = view && study?.strategies;
  status.hidden = !view;
  node("etfFixedLog").hidden = !ready;
  node("etfFixedMatched").hidden = true;
  if (!view) return null;
  if (!ready) {
    const issues = {
      beforeSample: `固定策略从 ${shown.factorSampleStart} 开始评估，请调整开始日期。`,
      unsupported: `组合含固定策略暂未覆盖的 ETF（${scope.fixed?.unsupported?.join("、") ?? ""}）。可切换到四只已覆盖的单只 ETF。`,
      missingInputs: "缺少用来定阈值的指数或溢价历史。更新因子与溢价数据后重试。",
      missingBars: "未复权开盘价或最低价未覆盖所选区间。更新历史溢价数据后重试。",
    };
    status.textContent = (issues[scope.fixed?.unavailable] ?? "缺少五日延迟净值序列，更新历史溢价数据后重试。") +
      " 下方显示同区间的基础策略。";
    return null;
  }
  status.textContent = view.note;
  orderOptions = view.ids.map((id) => study.strategies[id]);
  const old = mode === orderMode ? orderStrategy.value : view.primary;
  orderMode = mode;
  orderStrategy.replaceChildren(...orderOptions.map((item) => option(item.id, strategyPresentation(item).name)));
  orderStrategy.value = view.ids.includes(old) ? old : view.primary;
  renderFixedOrders();

  const rows = Object.entries(study.matched).filter(([id]) => view.ids.includes(id)).map(([id, matched]) => {
    const strategy = study.strategies[id];
    return dataRow([presentation[id].name, percentage(strategy.investedRatio),
      percentage(strategy.totalReturn), percentage(matched.totalReturn),
      percentage(strategy.maxDrawdown), percentage(matched.maxDrawdown)]);
  });
  node("etfFixedMatchedRows").replaceChildren(...rows);
  node("etfFixedMatched").hidden = !rows.length;
  return { strategies: orderOptions, primary: study.strategies[view.primary] };
}

function renderView() {
  const code = viewControl.value;
  const scope = shown.byFund[code] ?? shown;
  const mode = strategySet.value;
  const showFactors = mode === "factor";
  const showLegacy = mode === "all";
  const fixed = fixedView(scope, mode);
  const previousLimit = Number(limitControl.value || 3);
  const trials = scope.premium.strategies;
  limitControl.replaceChildren(...trials.map(({ limit }) => option(limit, `≤ ${limit}%`)));
  const trial = trials.find(({ limit }) => limit === previousLimit) ?? trials[0];
  if (trial) limitControl.value = String(trial.limit);
  node("etfPremiumChoice").hidden = !showLegacy || !trial;
  const factor = scope.factor;
  const baseStrategies = showLegacy ? scope.strategies : scope.strategies.filter(({ id }) => id !== "signal");
  const compared = showFactors && factor?.strategy ? [...baseStrategies, factor.strategy] : baseStrategies;
  active = {
    budget: shown.budget,
    sessions: scope.sessions,
    strategies: fixed?.strategies ?? (showLegacy && trial ? [...compared, trial] : compared),
  };

  const codes = code || shown.selected.join("、");
  const start = scope.sessions[0];
  const end = scope.sessions.at(-1);
  const scopeLabel = code ? "单只" : "选中组合";
  const { unit, format } = formatAmounts(shown.budget);
  node("etfEquityUnit").textContent = `账户资产（${unit}）`;
  node("etfBacktestScope").textContent =
    `${scopeLabel} · ${codes} · ${start} 至 ${end} · ${scope.sessions.length} 个交易日 · 初始 ${format(shown.budget)} ${unit}`;

  node("etfBacktestLegend").replaceChildren(...active.strategies.map((strategy) => {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "etf-swatch";
    const { name, color } = strategyPresentation(strategy);
    swatch.style.background = color;
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, name);
    return item;
  }));
  const tableStrategies = fixed?.strategies ?? (showLegacy ? [...compared, ...trials] : compared);
  const highlighted = fixed?.primary ?? (showFactors ? factor?.strategy : showLegacy ? trial : null);
  node("etfBacktestRows").replaceChildren(...tableStrategies.map((strategy) => {
    const row = dataRow([
      strategyPresentation(strategy).name,
      `${format(strategy.finalValue)} ${unit}`,
      percentage(strategy.totalReturn),
      percentage(strategy.maxDrawdown),
      String(strategy.buyCount),
      strategy.investedRatio == null ? "—" : percentage(strategy.investedRatio),
      `${format(strategy.cash)} ${unit}`,
    ]);
    row.dataset.strategy = strategy.id;
    if (strategy.id === "premium") row.dataset.limit = strategy.limit;
    row.classList.toggle("etf-backtest-active", strategy === highlighted);
    return row;
  }));

  const actions = Object.entries(scope.signalActions).map(([key, count]) => `${actionLabels[key] ?? key} ${count} 次`);
  const hasActions = actions.length ? actions.join("、") : "本区间无适用信号";
  node("etfSignalNotes").textContent = `信号数据截至 ${shown.signalThrough}。本区间 ${hasActions}。`;
  node("etfSignalNotes").hidden = !showLegacy;
  const premium = scope.premium;
  node("etfPremiumNotes").textContent = premium.unsupported.length
    ? `当前范围有 ${premium.unsupported.length} 只缺少历史折溢价。门槛覆盖 159660、513110、159941、513290，可切到单只查看。`
    : `门槛按开盘价和可用官方净值估算，月度检查点覆盖 ${premium.observations}/${premium.checkpoints}。买入次数按模拟成交笔数统计。`;
  node("etfPremiumNotes").hidden = !showLegacy;
  renderPurchases(showLegacy ? trial : null);
  renderFactorLog(factor, showFactors);
  readout(scope.sessions.length - 1);
  drawCharts();
}

function renderBacktest(result) {
  shown = result;
  const previousScope = viewControl.value;
  const selectedFunds = funds.filter(({ code }) => result.selected.includes(code));
  const managerLabel = (fund) => fund.index === "纳斯达克100" ? fund.manager : "生物科技";
  viewControl.replaceChildren(
    option("", "选中组合"),
    ...selectedFunds.map((fund) => option(fund.code, `${fund.code} ${managerLabel(fund)}`)),
  );
  viewControl.value = result.selected.includes(previousScope) ? previousScope : "";
  status.textContent = result.budget === budgetInput.valueAsNumber ? "" : budgetChanged;
  status.classList.remove("etf-status-error");
  node("etfBacktestResult").hidden = false;
  renderView();
}

async function loadBacktest(params) {
  busy = true;
  run.disabled = true;
  dateStart.disabled = true;
  dateEnd.disabled = true;
  fundPicker.closest("fieldset").disabled = true;
  status.classList.remove("etf-status-error");
  status.textContent = "正在计算场内回测…";
  try {
    const query = new URLSearchParams({ budget: budgetInput.valueAsNumber, ...(params ?? { sample: "out" }) });
    const response = await fetch(`/api/cn-etf-backtest?${query}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "回测接口暂不可用");
    renderFundPicker(result);
    dateStart.value = params?.start ?? result.sessions[0];
    dateEnd.value = params?.end ?? result.sessions.at(-1);
    applyDateBounds(result.selected);
    renderBacktest(result);
  } catch (error) {
    status.classList.add("etf-status-error");
    status.textContent = `${error.message}${shown ? "，下方保留你上次的结果。" : "。请重试。"}`;
  } finally {
    busy = false;
    dateStart.disabled = !funds.length;
    dateEnd.disabled = !funds.length;
    fundPicker.closest("fieldset").disabled = false;
    run.disabled = funds.length ? !selectedCodes().length : false;
  }
}

node("etfBacktestForm").addEventListener("change", (event) => {
  if (busy || event.target === budgetInput) return;
  const codes = selectedCodes();
  applyDateBounds(codes);
  run.disabled = !codes.length;
  status.textContent = codes.length ? "选择已修改，运行回测可更新下方结果。" : "请至少选择一只 ETF。";
});
node("etfBacktestForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  if (!funds.length) {
    loadBacktest();
    return;
  }
  loadBacktest({ codes: selectedCodes().join(","), start: dateStart.value, end: dateEnd.value });
});
onBudgetChange(() => {
  if (busy || !shown) return;
  status.textContent = budgetChanged;
  status.classList.remove("etf-status-error");
});
viewControl.addEventListener("change", renderView);
limitControl.addEventListener("change", renderView);
strategySet.addEventListener("change", renderView);
orderStrategy.addEventListener("change", renderFixedOrders);
const observer = new ResizeObserver(() => drawCharts());
for (const chart of [canvas, drawdownCanvas]) {
  observer.observe(chart);
  chart.addEventListener("pointermove", (event) => {
    const plot = plots.get(chart);
    if (!plot) return;
    const relative = (event.clientX - chart.getBoundingClientRect().left - plot.left) / (plot.right - plot.left);
    const index = Math.max(0, Math.min(plot.count - 1, Math.round(relative * (plot.count - 1))));
    readout(index);
    drawCharts(index);
  });
  chart.addEventListener("pointerleave", () => {
    if (active) {
      readout(active.sessions.length - 1);
      drawCharts();
    }
  });
}

loadBacktest();
