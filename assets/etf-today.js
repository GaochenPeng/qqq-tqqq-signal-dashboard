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
const price = (value, digits = 3) => value?.toFixed(digits) ?? "—";
const reasonLabels = {
  calendarUnavailable: "暂时拿不到交易日历",
  notTradingDate: "今天暂时没有开市记录",
  outsideTradingHours: "等沪深市场恢复正常买卖时再刷新",
  planNotStarted: "投资计划尚未到起始月",
  planEnded: "计划分批月份已结束",
  planUnavailable: "暂时读不到你的投资计划和成交记录",
  policyUnavailable: "计划绑定的规则版本暂不可用",
  noEligibleFund: "本组暂无符合条件的 ETF，原因见下表",
  calibrationUnavailable: "缺少历史数据，算不出计划限价",
  navUnavailable: "暂时缺少计算计划限价的净值",
  askAboveLimit: "卖价高于计划限价",
  iopvPremiumAboveLimit: "比当天参考值多付超过 8%",
  quoteUnavailable: "暂时拿不到当天的新报价",
  iopvUnavailable: "暂时拿不到当天的资产参考值",
  noAsks: "当前拿不到卖价",
  monthlyBudgetUsed: "本组当月额度已用完",
  smallBudgetUsed: "小笔额度已用完，等待正常限价",
  planBudgetUsed: "计划本金或本组预算已用完",
  belowLot: "剩余额度或限价内卖盘不足一手",
  marketConfirmation: "小额档还在等盘面确认",
};
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
  const outcome = group.amountCents > 0
    ? `${preview ? "试算可买" : "可买"} ${check.code} · 约 ${integer.format(group.shares)} 份 · ${money(group.amountCents)}`
    : "先等，本次买 0 元";
  const result = document.createElement("p");
  result.append(el("strong", outcome, "etf-today-order"));
  card.append(result, renderWhy(group));
  if (check) card.dataset.buyable = "true";

  const details = document.createElement("details");
  details.className = "etf-today-context";
  details.append(el("summary", `本月还可用 ${money(group.remainingMonthCents)}`));
  details.append(el("p", `本月额度 ${money(group.monthlyBudgetCents)} · 已买 ${money(group.boughtThisMonthCents)}`, "muted"));
  if (group.smallBudgetCents !== null) {
    details.append(el("p", `小笔上限 ${money(group.smallBudgetCents)} · 小笔剩余 ${money(group.smallRemainingCents)}`, "muted"));
  }
  if (group.close) {
    const sign = group.close.dailyReturn > 0 ? "+" : "";
    details.append(el("p", `${group.close.date} 收盘 ${format(group.close.value)} · ${sign}${percent(group.close.dailyReturn)} · ${group.close.source}`, "muted"));
  }
  if (group.signal) {
    details.append(el("p", `126 日趋势 ${percent(group.signal.trend)} · 20 日年化波动 ${percent(group.signal.volatility)}`, "muted"));
  }
  card.append(details);
  return card;
}

function renderWhy(group) {
  const explanation = el("div", "", "etf-today-explanation");
  const candidates = group.candidates.map((item) => ({
    ...item,
    ask: item.bestAsk ?? item.lastQuote?.bestAsk ?? item.lastQuote?.lastPrice,
    reference: item.iopv ?? item.lastQuote?.iopv,
    premium: item.askPremium ?? item.lastQuote?.premium,
  }));
  const priced = candidates.filter((item) => item.ask != null && item.reference != null);
  const nearest = priced.filter((item) => item.referenceBuyAt != null)
    .sort((a, b) => a.ask / a.referenceBuyAt - b.ask / b.referenceBuyAt)[0];
  const quote = candidates.find((item) => item.code === group.decision?.code)
    ?? nearest ?? priced.sort((a, b) => a.premium - b.premium)[0] ?? candidates[0];
  const block = group.reasons.find((reason) => reasonLabels[reason] && reason !== "noEligibleFund");
  const priceReason = quote?.reasons.find((reason) => reason !== "marketConfirmation");
  const why = block ?? priceReason;
  if (!group.decision && why) explanation.append(el("p", reasonLabels[why] + "。"));
  for (const reason of group.risk.blockers) explanation.append(el("p", reason.why));

  if (quote?.ask != null && quote.reference != null) {
    const difference = quote.ask - quote.reference;
    const comparison = difference > 0
      ? `每份贵 ${price(difference, 4)} 元（${percent(quote.premium)}）。`
      : difference < 0 ? `每份低 ${price(-difference, 4)} 元。` : "价格和参考净值相同。";
    const label = quote.lastQuote ? (quote.lastQuote.bestAsk ? "最近卖一" : "最近成交价") : "卖一";
    explanation.append(el("p", `${quote.code} ${label} ${price(quote.ask)} 元，参考净值每份 ${price(quote.reference, 4)} 元。${comparison}`));
  }
  if (group.decision) {
    const label = quote.tier === "small" ? "小笔" : "常规";
    explanation.append(el("p", `市场条件已过关，卖一也在 ${price(quote.effectiveLimit)} 元以内。用本月剩余额度按${label}档买，金额含费用。`));
  } else if (quote?.referenceBuyAt != null) {
    const gap = quote.ask - quote.referenceBuyAt;
    const threshold = `${price(quote.referenceBuyAt)} 元`;
    const aim = gap > 1e-10
      ? `卖一要降到 ${threshold} 或更低，每份还差 ${price(gap)} 元。`
      : `卖一在 ${threshold} 或以下，价格条件就过关。`;
    explanation.append(el("p", `${quote.lastQuote ? "按最近参考净值估算，" : ""}${aim}`, "etf-today-target"));
  }
  if (!group.decision && quote?.priceOnlyBuyAt > quote.referenceBuyAt && group.risk.smallWait.length) {
    explanation.append(el("p", `若卖一只回到小额档的 ${price(quote.priceOnlyBuyAt)} 元以内，还要等${group.risk.smallWait.join("、")}。`));
  }
  for (const reason of group.risk.blockers) explanation.append(el("p", reason.next, "etf-today-target"));
  return explanation;
}

function renderCandidate(candidate, group) {
  const { code, name, bestAsk, iopv, askPremium, normalLimit, smallLimit, iopvLimit, navDate, quoteAt, reasons } = candidate;
  const selected = group.decision?.code === code;
  const recent = candidate.lastQuote;
  const outcome = reasons.length ? reasons.map((key) => reasonLabels[key]).join("、")
    : selected ? "通过 · 已选中" : group.reasons.length ? "价格条件通过" : "通过 · 未选中";
  const strategyPrice = smallLimit == null ? price(normalLimit) : `${price(normalLimit)} / ${price(smallLimit)}`;
  const row = tableRow([
    [code, name].filter(Boolean).join(" "), price(bestAsk ?? recent?.bestAsk), price(iopv ?? recent?.iopv, 4),
    percent(askPremium ?? recent?.premium), strategyPrice,
    price(iopvLimit), price(candidate.referenceBuyAt), quoteAt ? quoteClock.format(Date.parse(quoteAt)) : "—", outcome,
  ]);
  row.dataset.code = code;
  if (recent) row.cells[7].append(el("small", group.reasons.includes("outsideTradingHours")
    ? "非交易时段，仅供参考" : "最近报价，仅供参考"));
  if (recent && !recent.bestAsk) row.cells[3].append(el("small", "按最近成交价"));
  if (navDate) row.cells[4].append(el("small", `${smallLimit == null ? "" : "正常 / 小笔 · "}${navDate} 净值`));
  return row;
}

function sourceLink(label, url) {
  const link = el("a", label);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function renderMarketRisk(risk) {
  at("etfTodayEvidence").hidden = false;
  at("etfTodayMarketDate").textContent = risk.date
    ? `美股 ${risk.date} 收盘，对比 ${risk.beforeDate}。消息时间为北京时间。`
    : "暂时缺少可核对的近期美股收盘。";
  const factorCells = Object.entries(risk.factors).map(([key, item]) => {
    const cell = el("div", "");
    const name = el("dt", item.url ? "" : item.label);
    if (item.url) name.append(sourceLink(item.label, item.url));
    const sign = item.change > 0 ? "+" : "";
    const value = key === "treasury" && item.latest != null ? `${item.latest.toFixed(2)}%` : price(item.latest, 2);
    const movement = key === "treasury" ? `${item.change} 个基点` : percent(item.change);
    const result = item.available ? `${value} · ${sign}${movement}` : "缺少同日数据";
    cell.append(name, el("dd", result), el("dd", [item.date, item.source].filter(Boolean).join(" · "), "muted"));
    return cell;
  });
  at("etfTodayFactors").replaceChildren(...factorCells);
  const eventRows = risk.events.slice(0, 5).map((event) => {
    const item = el("li", "");
    item.append(sourceLink(event.summary, event.link));
    item.lastChild.title = event.title;
    const time = quoteClock.format(Date.parse(event.publishedAt));
    const status = event.pending ? "等完整美股收盘" : "已有完整美股收盘";
    const kind = { official: "官方发布", report: "媒体报道", data: "预期差" }[event.kind];
    item.append(el("span", ` · ${time} · ${kind} · ${status}`, "muted"));
    return item;
  });
  at("etfTodayEvents").replaceChildren(...eventRows);
  const missing = risk.missingFeeds.length ? `暂缺 ${risk.missingFeeds.join("、")}。` : "";
  at("etfTodayEventStatus").textContent = missing || (eventRows.length ? "" : "关注来源最近七天暂无命中规则的消息。");
}

function renderCalendar(calendar) {
  const section = at("etfTodayCalendar");
  section.hidden = !calendar;
  if (!calendar) return;
  const sorted = calendar.items.slice().sort((a, b) => a.releaseAt.localeCompare(b.releaseAt));
  const amount = (value, unit) => value == null ? "—" : `${format(value)}${unit === "%" ? "%" : " " + unit}`;
  const rows = sorted.map((item) => {
    const row = el("li", "");
    const time = item.releaseDate ? `${item.releaseDate} 美东日期` : `${quoteClock.format(Date.parse(item.releaseAt))} 北京时间`;
    row.append(el("strong", item.label), el("span", ` · ${time}`, "muted"));
    const values = [`预期 ${amount(item.forecast, item.unit)}`, `实际 ${amount(item.actual, item.unit)}`];
    if (item.surprise != null) {
      const unit = item.unit === "%" ? "个百分点" : item.unit;
      values.push(`预期差 ${item.surprise > 0 ? "+" : ""}${amount(item.surprise, unit)}`);
    }
    row.append(el("div", values.join(" · ")));
    const note = item.forecastAt ? `公布前已存于 ${quoteClock.format(Date.parse(item.forecastAt))}`
      : item.forecast == null ? "暂无同口径预期"
      : item.actual == null ? "本次读取的预期" : "供应商历史预期，缺少本地公布前快照";
    const sources = new Map([item.calendarSource, item.forecastSource, item.actualSource].map((source) => [source.url, source]));
    const detail = el("span", (item.fromArchive ? "上次存档 · " : "") + note, "muted");
    for (const source of sources.values()) detail.append(" · ", sourceLink(source.name, source.url));
    row.append(detail);
    return row;
  });
  at("etfTodayCalendarRows").replaceChildren(...rows);
  const status = [];
  if (!rows.length) status.push("这一周暂无已匹配的宏观或财报日历数据。");
  if (calendar.unavailable.length) status.push(`暂缺 ${calendar.unavailable.join("、")}。`);
  if (calendar.archive !== "ok") status.push("PG 的公布前快照暂不可用。");
  at("etfTodayCalendarStatus").textContent = status.join("");
}

function renderDecision(data) {
  decision = data;
  renderPlan(data.planState, data.date);
  const summary = data.preview ? "按输入金额试算" : "按已保存计划计算";
  const month = data.monthIndex >= 0 && data.monthIndex < data.installments ? ` · 第 ${data.monthIndex + 1}/${data.installments} 批` : "";
  const checked = quoteClock.format(Date.parse(data.checkedAt));
  const day = data.tradingDay ? ` · 本月第 ${data.tradingDay} 个交易日` : "";
  setStatus("etfTodayStatus", `${checked} 北京时间 · ${summary}${month}${day}${data.quoteMode === "snapshot" ? " · 行情使用最近有效快照" : ""}`);
  at("etfPlanSummary").hidden = Boolean(data.planState.error);
  at("etfTodayAmount").textContent = money(data.totalCents);
  at("etfPlanUsed").textContent = data.preview ? "—" : money(data.boughtCents);
  at("etfPlanRemaining").textContent = data.preview ? "—" : money(data.remainingCents);
  at("etfTodayGroups").replaceChildren(...data.groups.map((group) => renderGroup(group, data.preview)));
  renderMarketRisk(data.marketRisk);
  renderCalendar(data.calendar);
  at("etfTodayQuoteDetails").hidden = false;
  at("etfTodayQuotes").replaceChildren(...data.groups.flatMap((group) =>
    group.candidates.map((candidate) => renderCandidate(candidate, group))));
  if (!data.planState.error) {
    at("etfHoldingsWrap").hidden = data.preview;
    at("etfHoldingsRows").replaceChildren(...Object.entries(data.holdings).map(([code, position]) => tableRow([
      code, integer.format(position.shares), money(position.boughtCents),
    ])));
  }
  if (data.orderExpiresAt) {
    expires = setTimeout(() => {
      at("etfTodayAmount").textContent = "待刷新";
      document.querySelectorAll("[data-buyable] .etf-today-order").forEach((value) => { value.textContent = "请刷新确认本组额度"; });
      document.querySelectorAll("[data-buyable] .etf-today-explanation").forEach((value) => {
        value.replaceChildren(el("p", "刚才的买价已过时，刷新后再看当前能买多少。"));
      });
      setStatus("etfTodayStatus", "盘口或竞价时段已变化，请刷新确认当前可买金额。");
    }, Math.max(0, Date.parse(data.orderExpiresAt) - Date.now()));
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
  at("etfTodayEvidence").hidden = true;
  at("etfTodayQuoteDetails").hidden = true;
  setStatus("etfTodayStatus", "正在核对最新消息、美股收盘、ETF 卖盘和已录入成交…");
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
