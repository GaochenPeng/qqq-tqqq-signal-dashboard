import { formatAmounts, getBudget, onBudgetChange } from "./etf-budget.js";

const node = (id) => document.getElementById(id);
const fundPicker = node("etfBacktestFunds");
const budgetInput = node("etfBacktestBudget");
const dateStart = node("etfBacktestStart");
const dateEnd = node("etfBacktestEnd");
const run = node("etfRunBacktest");
const canvas = node("etfEquityChart");
const status = node("etfBacktestStatus");
const viewControl = node("etfBacktestView");
const limitControl = node("etfPremiumLimit");
const strategySet = node("etfStrategySet");

const presentation = {
  once: { name: "一次买入", color: "#1d4ed8" },
  monthly: { name: "12 笔分批", color: "#0f766e" },
  signal: { name: "三信号（无杠杆）", color: "#b45309" },
  factor: { name: "趋势 · 波动控仓 · 溢价择券", color: "#a21caf" },
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
let plot;

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
  const values = active.strategies.map((item) => `${strategyPresentation(item).name} ${format(item.equity[index])} ${unit}`);
  node("etfEquityReadout").textContent = `${active.sessions[index]} · ${values.join(" · ")}`;
}

function drawChart(selectedDay) {
  if (!active || !canvas.clientWidth) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.font = "12px system-ui";
  const { budget, sessions, strategies } = active;
  const { format } = formatAmounts(budget);
  const low = Math.min(budget, ...strategies.map((item) => Math.min(...item.equity)));
  const high = Math.max(budget, ...strategies.map((item) => Math.max(...item.equity)));
  const targetStep = Math.max(budget >= 10_000 ? 100 : 1, (high - low) / 4);
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const step = Math.ceil(targetStep / magnitude) * magnitude;
  const min = Math.floor(low / step) * step;
  const max = Math.max(min + step, Math.ceil(high / step) * step);
  const left = Math.max(56, Math.ceil(ctx.measureText(format(max)).width) + 15);
  const right = width - 15;
  const top = 12;
  const bottom = height - 26;
  const x = (index) => left + index / (sessions.length - 1) * (right - left);
  const y = (value) => bottom - (value - min) / (max - min) * (bottom - top);
  plot = { left, right, count: sessions.length };

  for (let value = min; value <= max; value += step) {
    ctx.strokeStyle = value === budget ? "#98a2b3" : "#d4dbe5";
    ctx.beginPath();
    ctx.moveTo(left, y(value));
    ctx.lineTo(right, y(value));
    ctx.stroke();
    ctx.fillStyle = "#475467";
    ctx.textAlign = "right";
    ctx.fillText(format(value), left - 8, y(value) + 4);
  }
  strategies.forEach((strategy) => {
    const { equity } = strategy;
    ctx.strokeStyle = strategyPresentation(strategy).color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [index, value] of equity.entries()) {
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

function renderView() {
  const code = viewControl.value;
  const scope = shown.byFund[code] ?? shown;
  const showFactors = strategySet.value === "factor";
  const previousLimit = Number(limitControl.value || 3);
  const trials = scope.premium.strategies;
  limitControl.replaceChildren(...trials.map(({ limit }) => option(limit, `≤ ${limit}%`)));
  const trial = trials.find(({ limit }) => limit === previousLimit) ?? trials[0];
  if (trial) limitControl.value = String(trial.limit);
  node("etfPremiumChoice").hidden = showFactors || !trial;
  const factor = scope.factor;
  const baseStrategies = showFactors ? scope.strategies.filter(({ id }) => id !== "signal") : scope.strategies;
  const compared = factor?.strategy ? [...baseStrategies, factor.strategy] : baseStrategies;
  active = {
    budget: shown.budget,
    sessions: scope.sessions,
    strategies: !showFactors && trial ? [...compared, trial] : compared,
  };

  const codes = code || shown.selected.join("、");
  const start = scope.sessions[0];
  const end = scope.sessions.at(-1);
  const mode = code ? "单只" : "选中组合";
  const { unit, format } = formatAmounts(shown.budget);
  node("etfEquityUnit").textContent = `账户资产（${unit}）`;
  node("etfBacktestScope").textContent =
    `${mode} · ${codes} · ${start} 至 ${end} · ${scope.sessions.length} 个交易日 · 初始 ${format(shown.budget)} ${unit}`;

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
  const tableStrategies = showFactors ? compared : [...compared, ...trials];
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
    row.classList.toggle("etf-backtest-active", strategy === (showFactors ? factor?.strategy : trial));
    return row;
  }));

  const actions = Object.entries(scope.signalActions).map(([key, count]) => `${actionLabels[key] ?? key} ${count} 次`);
  const hasActions = actions.length ? actions.join("、") : "本区间无适用信号";
  node("etfSignalNotes").textContent = `信号数据截至 ${shown.signalThrough}。本区间 ${hasActions}。`;
  node("etfSignalNotes").hidden = showFactors;
  const premium = scope.premium;
  node("etfPremiumNotes").textContent = premium.unsupported.length
    ? `当前范围有 ${premium.unsupported.length} 只缺少历史折溢价。门槛覆盖 159660、513110、159941、513290，可切到单只查看。`
    : `门槛按开盘价和可用官方净值估算，月度检查点覆盖 ${premium.observations}/${premium.checkpoints}。买入次数按模拟成交笔数统计。`;
  node("etfPremiumNotes").hidden = showFactors;
  renderPurchases(showFactors ? null : trial);
  renderFactorLog(factor, showFactors);
  readout(scope.sessions.length - 1);
  drawChart();
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
  status.textContent = result.budget === getBudget() ? "" : budgetChanged;
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
    const query = new URLSearchParams({ budget: getBudget(), ...(params ?? { sample: "out" }) });
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
new ResizeObserver(() => drawChart()).observe(canvas);
canvas.addEventListener("pointermove", (event) => {
  if (!plot) return;
  const relative = (event.clientX - canvas.getBoundingClientRect().left - plot.left) / (plot.right - plot.left);
  const index = Math.max(0, Math.min(plot.count - 1, Math.round(relative * (plot.count - 1))));
  readout(index);
  drawChart(index);
});
canvas.addEventListener("pointerleave", () => {
  if (active) {
    readout(active.sessions.length - 1);
    drawChart();
  }
});

loadBacktest();
