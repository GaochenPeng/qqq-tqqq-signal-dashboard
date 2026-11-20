import { formatAmounts } from "./etf-budget.js";

const at = (id) => document.getElementById(id);
const refreshButton = at("etfTodayRefresh");
const budgetInput = at("etfPlanBudget");
const startInput = at("etfPlanStart");
const savePlanButton = at("etfPlanSave");
const saveTradeButton = at("etfTradeSave");
const tradeDate = at("etfTradeDate");
const { format } = formatAmounts(1);
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const quoteClock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });
const indexNames = { NDX: "纳指 100", NBI: "纳指生物科技" };
const money = (cents) => `${format(cents / 100)} 元`;
const percent = (ratio) => ratio == null ? "—" : `${(100 * ratio).toFixed(2)}%`;
let planState;
let decision;
let refreshing;
let mutating = false;
let pendingTrade;
let expires;

function el(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

function tableRow(values) {
  const row = document.createElement("tr");
  const label = el("th", values[0]);
  label.scope = "row";
  row.append(label, ...values.slice(1).map((value) => el("td", value)));
  return row;
}

function setStatus(id, text, error = false) {
  const target = at(id);
  target.textContent = text;
  target.classList.toggle("etf-status-error", error);
}

function enableActions() {
  const ready = Boolean(planState?.enabled && !planState?.error && !mutating);
  savePlanButton.disabled = !ready || Boolean(planState?.trades.length);
  saveTradeButton.disabled = !ready || !planState?.plan;
  refreshButton.disabled = Boolean(refreshing || mutating);
}

function renderPlan(state, date) {
  const plan = state.plan;
  const locked = Boolean(state.trades.length);
  const changed = plan?.budget !== planState?.plan?.budget || plan?.startMonth !== planState?.plan?.startMonth;
  if (plan && (locked || changed)) {
    budgetInput.value = String(plan.budget);
    startInput.value = plan.startMonth;
  } else if (!startInput.value && date) {
    startInput.value = date.slice(0, 7);
  }
  if (state.error) {
    planState = { ...(planState ?? state), error: state.error };
    setStatus("etfPlanStatus", state.error, true);
    enableActions();
    return;
  }
  planState = state;
  budgetInput.readOnly = locked;
  startInput.readOnly = locked;
  const saved = plan ? `已保存 ${plan.startMonth} 起的计划 · 本金 ${integer.format(plan.budget)} 元 · ${plan.installments} 批` : "";
  setStatus("etfPlanStatus", saved || (state.enabled ? "按输入金额试算。保存计划后可以录入已有成交。" : "连接本机 PostgreSQL 后可保存计划。"));
  at("etfTradeForm").hidden = !plan;
  if (plan) {
    tradeDate.min = plan.startMonth + "-01";
    if (date) tradeDate.max = date;
    if (!tradeDate.value && date) tradeDate.value = date;
  }
  at("etfTradeHistory").hidden = !state.trades.length;
  at("etfTradeCount").textContent = `已录入成交（${state.trades.length} 笔）`;
  at("etfTradeRows").replaceChildren(...state.trades.slice().reverse().map((trade) => tableRow([
    trade.date, trade.code, trade.side === "buy" ? "买入" : "卖出", integer.format(trade.shares), money(trade.amountCents),
  ])));
  setStatus("etfTradesStatus", plan
    ? "按券商成交记录填写。买入填含费金额，卖出填实际到账。"
    : "保存计划后可录入已有成交。");
  enableActions();
}

function renderGroup(group, preview) {
  const card = el("article", "", "etf-today-group");
  card.dataset.index = group.index;
  card.append(el("h3", indexNames[group.index]));
  const check = group.decision;
  if (group.close) {
    const sign = group.close.dailyReturn > 0 ? "+" : "";
    card.append(el("p", `${group.close.date} 收盘 ${format(group.close.value)} · ${sign}${percent(group.close.dailyReturn)} · ${group.close.source}`, "muted"));
  }
  if (check?.signal) {
    const trend = check.trendReduced ? "额度减半" : "保留额度";
    const risk = check.volatilityReduced ? "额度减半" : "保留额度";
    card.append(
      el("p", `126 日趋势 ${percent(check.signal.trend)} · ${trend}`),
      el("p", `20 日年化波动 ${percent(check.signal.volatility)} / 阈值 ${percent(check.volatilityLimit)} · ${risk}`),
      el("p", `风控额度 ${money(group.riskBudgetCents)} · 本月已买 ${money(group.boughtThisMonthCents)} · 可用额度 ${money(group.remainingOrderCents)}`, "muted"),
    );
  }
  if (check?.code) {
    const prior = check.candidates[0];
    card.append(el("p", `候选 ${check.code} · ${prior.date} 开盘估算溢价 ${percent(prior.premium)}`, "muted"));
  }
  if (check?.open !== undefined) {
    card.append(el("p", `开盘估算溢价 ${percent(check.openingPremium)} / 门槛 ${percent(check.premiumLimit)} · 限价 ${check.limitPrice.toFixed(4)} 元`, "muted"));
  }
  if (group.bestAsk != null) {
    card.append(el("p", `当前卖一 ${group.bestAsk.toFixed(3)} 元 · 同口径估算溢价 ${percent(group.askPremium)}`, "muted"));
  }
  if (group.reasons.length) {
    const labels = {
      calendarUnavailable: "本月共同交易日暂未核实",
      afterMonthlyCheck: "本月首个共同交易日已过",
      awaitCommonOpening: "尚无四只 ETF 当日共同开盘记录",
      outsideTradingHours: "当前在沪深连续竞价时段之外",
      planNotStarted: "投资计划尚未到起始月",
      planEnded: "12 个计划月份已结束",
      planUnavailable: "实际计划暂不可读，请刷新",
      policyUnavailable: "计划绑定的规则版本暂不可用",
      indexUnavailable: "最新指数收盘尚未核实",
      calibrationUnavailable: "该组缺少校准期指数或净值数据",
      priorPremiumUnavailable: "缺少近期可用的开盘溢价，暂时无法择券",
      openingUnavailable: "缺少当天开盘价或当时可用净值",
      aboveLimit: "今天开盘价高于计划限价",
      askAboveLimit: "当前卖一高于计划限价",
      quoteUnavailable: "最新的当日参考净值或盘口报价未核实",
      noAsks: "当前拿不到可买的卖盘",
      monthlyBudgetUsed: "当月已买金额达到该组风控额度",
      planBudgetUsed: "计划本金或该组预算已用完",
      belowLot: "剩余额度和限价内卖盘未满足一手",
    };
    const reasons = document.createElement("ul");
    reasons.append(...group.reasons.map((code) => {
      const item = el("li", labels[code] ?? code);
      item.dataset.reason = code;
      return item;
    }));
    card.append(reasons);
  }
  const outcome = group.amountCents > 0
    ? `${preview ? "试算可买" : "可买"} ${check.code} · 约 ${integer.format(group.shares)} 份 · ${money(group.amountCents)}`
    : "本组加仓 0 元";
  const result = document.createElement("p");
  result.append(el("strong", outcome, "etf-today-order"));
  card.append(result);
  return card;
}

function renderDecision(data) {
  decision = data;
  renderPlan(data.planState, data.date);
  const summary = data.preview ? "按输入金额试算" : "按已保存计划计算";
  const month = data.monthIndex >= 0 && data.monthIndex < data.installments ? ` · 第 ${data.monthIndex + 1}/${data.installments} 批` : "";
  const checked = quoteClock.format(Date.parse(data.checkedAt));
  const day = data.monthlyCheck ? ` · 本月检查日 ${data.monthlyCheck}` : "";
  setStatus("etfTodayStatus", `${checked} 北京时间 · ${summary}${month}${day}${data.quoteMode === "snapshot" ? " · 行情使用最近有效快照" : ""}`);
  at("etfPlanSummary").hidden = Boolean(data.planState.error);
  at("etfTodayAmount").textContent = money(data.totalCents);
  at("etfPlanUsed").textContent = data.preview ? "—" : money(data.boughtCents);
  at("etfPlanRemaining").textContent = data.preview ? "—" : money(data.remainingCents);
  at("etfTodayGroups").replaceChildren(...data.groups.map((group) => renderGroup(group, data.preview)));
  at("etfTodayQuotesWrap").hidden = false;
  at("etfTodayQuotes").replaceChildren(...data.quotes.map((quote) => tableRow([
    [quote.code, quote.name].join(" ").trim(), quote.price?.toFixed(3) ?? "—", quote.iopv?.toFixed(4) ?? "—",
    percent(quote.premium), quote.quoteAt ? quoteClock.format(Date.parse(quote.quoteAt)) : "—",
  ])));
  if (!data.planState.error) {
    at("etfHoldingsWrap").hidden = data.preview;
    at("etfHoldingsRows").replaceChildren(...Object.entries(data.holdings).map(([code, position]) => tableRow([
      code, integer.format(position.shares), money(position.boughtCents),
    ])));
  }
  if (data.totalCents > 0) {
    const timestamps = data.groups.filter((group) => group.amountCents > 0).map((group) =>
      Date.parse(data.quotes.find(({ code }) => code === group.decision.code).quoteAt));
    expires = setTimeout(() => {
      at("etfTodayAmount").textContent = "待刷新";
      document.querySelectorAll(".etf-today-order").forEach((value) => { value.textContent = "请刷新确认本组额度"; });
      setStatus("etfTodayStatus", "报价已超过两分钟，请刷新确认当前可买金额。");
    }, Math.max(0, Math.min(...timestamps) + 120_000 - Date.now()));
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? (response.status === 404 ? "请在本机 ETF 服务打开投资计划。" : "请求失败，请重试。"));
  }
  return response.json();
}

async function refreshToday() {
  if (mutating || !budgetInput.reportValidity()) return;
  refreshing?.abort();
  clearTimeout(expires);
  const controller = new AbortController();
  refreshing = controller;
  enableActions();
  at("etfTodayAmount").textContent = "待刷新";
  at("etfTodayGroups").replaceChildren();
  setStatus("etfTodayStatus", "正在核对指数、开盘价和计划余额…");
  try {
    const data = await requestJson(`/api/cn-etf-today?budget=${budgetInput.valueAsNumber}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(28_000)]),
    });
    if (refreshing === controller) renderDecision(data);
  } catch (error) {
    if (refreshing === controller) setStatus("etfTodayStatus", error.message, true);
  } finally {
    if (refreshing === controller) refreshing = null;
    enableActions();
  }
}

async function save(url, data, messageId) {
  if (mutating) return false;
  mutating = true;
  refreshing?.abort();
  refreshing = null;
  enableActions();
  setStatus(messageId, "正在保存…");
  try {
    const state = await requestJson(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data), signal: AbortSignal.timeout(8_000),
    });
    renderPlan(state, decision?.date);
    return true;
  } catch (error) {
    setStatus(messageId, error.message, true);
    return false;
  } finally {
    mutating = false;
    enableActions();
  }
}

at("etfPlanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = { budget: budgetInput.valueAsNumber, startMonth: startInput.value };
  if (await save("/api/cn-etf-plan", data, "etfPlanStatus")) refreshToday();
});

at("etfTradeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fields = {
    code: at("etfTradeFund").value, side: at("etfTradeSide").value, date: tradeDate.value,
    shares: at("etfTradeShares").valueAsNumber,
    amountCents: Math.round(at("etfTradeAmount").valueAsNumber * 100),
  };
  const signature = JSON.stringify(fields);
  if (pendingTrade?.signature !== signature) pendingTrade = { signature, key: crypto.randomUUID() };
  if (await save("/api/cn-etf-trade", { ...fields, key: pendingTrade.key }, "etfTradesStatus")) {
    pendingTrade = undefined;
    at("etfTradeShares").value = "";
    at("etfTradeAmount").value = "";
    refreshToday();
  }
});

refreshButton.addEventListener("click", refreshToday);
at("etfRefresh").addEventListener("click", refreshToday);
budgetInput.addEventListener("change", () => {
  if (!planState?.plan) refreshToday();
});
requestJson("/api/cn-etf-plan", { signal: AbortSignal.timeout(5_000) })
  .then((state) => { if (!planState) renderPlan(state); })
  .catch(() => {});
refreshToday();
