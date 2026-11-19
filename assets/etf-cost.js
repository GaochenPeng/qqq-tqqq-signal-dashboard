import { formatAmounts, getBudget, onBudgetChange } from "./etf-budget.js";

const element = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const percent = (rate) => `${number.format(rate * 100)}%`;

function makeElement(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function estimatePosition(fund, budget, useBook) {
  const asks = useBook ? fund.asks : [{ price: fund.lastPrice, lots: Number.MAX_SAFE_INTEGER }];
  if (!asks.length) return null;
  // 盘口数量按手，使用整数分计算每手金额。
  let remaining = budget * 100;
  let shares = 0;
  let lastLotCost = 0;
  for (const { price, lots } of asks) {
    const lotCost = Math.round(price * 10_000);
    if (lotCost <= 0) return null;
    const buyLots = Math.min(lots, Math.floor(remaining / lotCost));
    shares += buyLots * 100;
    remaining -= buyLots * lotCost;
    lastLotCost = lotCost;
  }
  if (remaining >= lastLotCost) return null;
  if (!shares) return { ...fund, costUnavailable: "金额不足一手" };

  const investment = budget - remaining / 100;
  const netAssets = shares * fund.iopv;
  return {
    ...fund,
    executionPrice: investment / shares,
    premiumRate: investment / netAssets - 1,
    premiumCost: investment - netAssets,
    netAssets,
  };
}

function holdingCost(position, years) {
  const annualRate = position.managementFeeRate + position.custodyFeeRate;
  return position.netAssets * -Math.expm1(-annualRate * years);
}

function chartScale(positions, maxYears) {
  const low = Math.min(0, ...positions.map((fund) => fund.premiumCost));
  const high = Math.max(0, ...positions.map((fund) => Math.max(fund.premiumCost, 0) + holdingCost(fund, maxYears)));
  const targetStep = Math.max(1, (high - low) / 4);
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const step = Math.ceil(targetStep / magnitude) * magnitude;
  const min = Math.floor(low / step) * step;
  const max = Math.max(min + step, Math.ceil(high / step) * step);
  const ticks = [];
  for (let value = min; value <= max; value += step) ticks.push(value);
  return { ticks, percentAt: (value) => (value - min) / (max - min) * 100 };
}

function chartBar(start, end, className, scale) {
  const bar = makeElement("span", undefined, `etf-bar ${className}`);
  bar.style.left = `${scale.percentAt(start)}%`;
  bar.style.width = `${scale.percentAt(end) - scale.percentAt(start)}%`;
  return bar;
}

function chartRow(fund, scale, { unit, format }) {
  const row = makeElement("li", undefined, "etf-chart-grid");
  row.dataset.code = fund.code;
  const label = makeElement("span", undefined, "etf-fund");
  label.append(makeElement("strong", fund.code), makeElement("span", fund.manager));
  const track = makeElement("div", undefined, "etf-track");
  const feeStart = Math.max(fund.premiumCost, 0);
  track.title = `入场溢价 ${format(fund.premiumCost)} ${unit} · 管理费及托管费 ${format(fund.holdingCost)} ${unit}`;
  track.append(
    chartBar(Math.min(fund.premiumCost, 0), feeStart, "etf-premium", scale),
    chartBar(feeStart, feeStart + fund.holdingCost, "etf-holding", scale),
  );
  if (scale.ticks[0] < 0) {
    const zero = makeElement("span", undefined, "etf-zero");
    zero.style.left = `${scale.percentAt(0)}%`;
    track.append(zero);
  }
  row.append(label, track, makeElement("strong", format(fund.totalCost), "etf-total"));
  row.setAttribute(
    "aria-label",
    `${fund.code} ${fund.manager}，综合成本 ${format(fund.totalCost)} ${unit}，${track.title}`,
  );
  return row;
}

const quoteClock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "medium",
  timeStyle: "medium",
});
let current;
const picker = element("etfYears");

function tableRow(fund, amounts) {
  const row = makeElement("tr");
  row.dataset.code = fund.code;
  const heading = makeElement("th", `${fund.code} ${fund.manager}`);
  heading.scope = "row";
  const format = (value, digits) => Number.isFinite(value) ? value.toFixed(digits) : "—";
  const asPercent = (value) => Number.isFinite(value) ? percent(value) : "—";
  row.append(heading, ...[
    format(fund.lastPrice, 3),
    format(fund.iopv, 4),
    fund.lastPrice > 0 && fund.iopv > 0 ? asPercent(fund.lastPrice / fund.iopv - 1) : "—",
    format(fund.executionPrice, 5),
    asPercent(fund.premiumRate),
    percent(fund.managementFeeRate),
    percent(fund.custodyFeeRate),
    Number.isFinite(fund.totalCost) ? `${amounts.format(fund.totalCost)} ${amounts.unit}` : (fund.costUnavailable ?? "待同期报价"),
  ].map((value) => makeElement("td", value)));
  return row;
}

function render() {
  if (!current) return;
  const budget = getBudget();
  const amounts = formatAmounts(budget);
  const { unit, format } = amounts;
  const quoteAt = Date.parse(current.asOf);
  const comparable = current.funds.filter((fund) => fund.iopv > 0
    && quoteAt - Date.parse(fund.quoteAt) <= 120_000);
  const book = comparable.map((fund) => estimatePosition(fund, budget, true));
  const useBook = book.every(Boolean);
  const estimates = useBook ? book : comparable.map((fund) => estimatePosition(fund, budget, false)).filter(Boolean);
  const byCode = new Map(estimates.map((fund) => [fund.code, fund]));
  const positions = estimates.filter((fund) => fund.netAssets > 0);
  const maxYears = Math.max(...Array.from(picker.options, (option) => Number(option.value)));
  const scale = chartScale(positions, maxYears);
  const years = Number(picker.value);
  const ranked = positions.map((fund) => {
    const fees = holdingCost(fund, years);
    return { ...fund, holdingCost: fees, totalCost: fund.premiumCost + fees };
  }).sort((first, second) => first.totalCost - second.totalCost);
  const rankedCodes = new Set(ranked.map((fund) => fund.code));
  const unavailable = current.funds.filter((fund) => !rankedCodes.has(fund.code)).map((fund) => byCode.get(fund.code) ?? fund);
  const [lowest, next] = ranked;
  if (lowest) {
    element("etfLeaderName").textContent = `${lowest.code} ${lowest.manager} · ${format(lowest.totalCost)} ${unit}`;
    const components = `入场溢价 ${format(lowest.premiumCost)} ${unit}，持有费用 ${format(lowest.holdingCost)} ${unit}`;
    element("etfLeaderGap").textContent = next
      ? `${components}。比第二名 ${next.code} 少约 ${whole.format(next.totalCost - lowest.totalCost)} 元。`
      : components;
  } else {
    element("etfLeaderName").textContent = estimates.some((fund) => fund.costUnavailable)
      ? "投入金额不足一手"
      : "等待可比较报价";
    element("etfLeaderGap").textContent = "盘口表仍可查看来源返回的场内价和参考净值。";
  }
  element("etfScope").textContent = `投入 ${whole.format(budget)} 元人民币 · ${current.funds.length} 只同指数 ETF`;
  const usingSaved = current.mode === "snapshot";
  const summary = usingSaved ? "行情源暂不可用，已显示最近有效快照。" : "已从腾讯行情获取最新可用报价。";
  const basis = useBook ? "按五档卖盘估算。" : "本批盘口深度不足，统一按最新场内价估算。";
  const missing = current.funds.length - comparable.length;
  const insufficient = comparable.length - positions.length;
  element("etfQuoteStatus").textContent = summary + (comparable.length ? basis : "")
    + (missing ? `${missing} 只缺少同期有效报价。` : "")
    + (insufficient ? `${insufficient} 只金额不足一手。` : "");
  element("etfCostUnit").textContent = unit;
  element("etfAxis").replaceChildren(...scale.ticks.map((value) => {
    const tick = makeElement("span", format(value), "etf-axis-tick");
    tick.style.left = `${scale.percentAt(value)}%`;
    return tick;
  }));
  element("etfChart").replaceChildren(...ranked.map((fund) => chartRow(fund, scale, amounts)));
  element("etfCostRows").replaceChildren(...[...ranked, ...unavailable].map((fund) => tableRow(fund, amounts)));
}

function applyMarket(market) {
  const quoteAt = Date.parse(market.asOf);
  if (!Number.isFinite(quoteAt) || !Array.isArray(market.funds) || !market.funds.length) {
    throw new Error("行情数据不完整");
  }
  current = market;
  const timeLabel = makeElement("time", quoteClock.format(quoteAt));
  timeLabel.dateTime = market.asOf;
  const usingSaved = market.mode === "snapshot";
  element("etfSnapshotTime").replaceChildren(usingSaved ? "最近有效快照 · 北京时间 " : "最近报价 · 北京时间 ", timeLabel);
  render();
  element("etfCostView").hidden = false;
}

async function refreshMarket() {
  const button = element("etfRefresh");
  const loading = element("etfLoading");
  const alert = element("etfError");
  button.disabled = true;
  loading.hidden = false;
  alert.hidden = true;
  try {
    const response = await fetch("/api/cn-etf-market", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error("本地行情接口暂不可用");
    applyMarket(await response.json());
  } catch (error) {
    alert.textContent = `更新行情失败。 ${error.message}${current ? "，保留已显示的报价。" : "。"}`;
    alert.hidden = false;
  } finally {
    button.disabled = false;
    loading.hidden = true;
  }
}

picker.addEventListener("change", render);
onBudgetChange(render);
element("etfRefresh").addEventListener("click", refreshMarket);
refreshMarket();
