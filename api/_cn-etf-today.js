const { factorPolicy, factorGroups, calibrateFactor, openingDecision } = require("./_cn-etf-factor");

const codes = Object.keys(factorGroups);
const indexesToCodes = Object.fromEntries(["NDX", "NBI"].map((index) =>
  [index, codes.filter((code) => factorGroups[code] === index)]));
const shanghaiClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const quoteMaxAgeMs = 120_000;
const lotSize = 100;
const costRate = 0.0005;

function chinaClock(now = new Date()) {
  const parts = Object.fromEntries(shanghaiClock.formatToParts(now).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function monthNumber(month) {
  const [year, number] = month.split("-").map(Number);
  return year * 12 + number;
}

function summarizePlan(trades, month, budgetCents) {
  const groups = { NDX: { bought: 0, boughtThisMonth: 0 }, NBI: { bought: 0, boughtThisMonth: 0 } };
  const positions = Object.fromEntries(codes.map((code) => [code, { shares: 0, boughtCents: 0 }]));
  let boughtCents = 0;
  for (const trade of trades) {
    const position = positions[trade.code];
    if (trade.side === "sell") {
      position.shares -= trade.shares;
      continue;
    }
    position.shares += trade.shares;
    position.boughtCents += trade.amountCents;
    const group = groups[factorGroups[trade.code]];
    group.bought += trade.amountCents;
    if (trade.date.slice(0, 7) === month) group.boughtThisMonth += trade.amountCents;
    boughtCents += trade.amountCents;
  }
  return { groups, positions, boughtCents, remainingCents: Math.max(0, budgetCents - boughtCents) };
}

function estimateLots(asks, limit, budgetCents) {
  let shares = 0;
  let amountCents = 0;
  for (const ask of asks) {
    if (ask.price > limit + 1e-12) break;
    const lotCents = Math.ceil(Math.round(ask.price * lotSize * 100) * (1 + costRate));
    const lots = Math.min(ask.lots, Math.floor((budgetCents - amountCents) / lotCents));
    shares += lots * lotSize;
    amountCents += lots * lotCents;
  }
  return { shares, amountCents };
}

function checkSession({ date, minutes }, history) {
  const month = date.slice(0, 7);
  const first = history.common.find((day) => day.startsWith(month));
  const reasons = [];
  if (!history.calendar.length) reasons.push("calendarUnavailable");
  else if (first && first < date) reasons.push("afterMonthlyCheck");
  else if (!history.common.includes(date)) reasons.push("awaitCommonOpening");
  const continuous = (minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 897);
  if (!continuous) reasons.push("outsideTradingHours");
  return { first: first ?? null, reasons };
}

function inspectGroup({ index, decision, reference, quote, sum, budgetCents, totalRemaining, baseReasons, date, nowMs, marketMode }) {
  const groupBudgetCents = budgetCents * indexesToCodes[index].length / codes.length;
  const riskBudgetCents = Math.floor((decision?.proposedAmount ?? 0) * 100 + 1e-8);
  const remainingGroupCents = Math.max(0, groupBudgetCents - sum.bought);
  const remainingOrderCents = Math.max(0, Math.min(
    riskBudgetCents - sum.boughtThisMonth, remainingGroupCents, totalRemaining,
  ));

  const reasons = [...baseReasons];
  if (!reference?.fresh) reasons.push("indexUnavailable");
  if (!decision && reference?.fresh) reasons.push("calibrationUnavailable");
  if (decision && decision.reason !== "limitMet") reasons.push(decision.reason);
  if (riskBudgetCents > 0 && remainingOrderCents === 0) {
    reasons.push(totalRemaining === 0 || remainingGroupCents === 0 ? "planBudgetUsed" : "monthlyBudgetUsed");
  }

  const quoteAge = nowMs - Date.parse(quote?.quoteAt);
  const quoteFresh = marketMode === "upstream" && quote?.quoteAt?.slice(0, 10) === date &&
    quoteAge >= -10_000 && quoteAge <= quoteMaxAgeMs && quote.iopv > 0;
  if (decision?.code && !quoteFresh) reasons.push("quoteUnavailable");
  const bestAsk = quoteFresh ? quote.asks[0]?.price : undefined;
  const askPremium = bestAsk && decision?.nav ? bestAsk / decision.nav - 1 : null;
  if (quoteFresh && decision?.limitPrice) {
    if (!bestAsk) reasons.push("noAsks");
    else if (bestAsk > decision.limitPrice + 1e-12) reasons.push("askAboveLimit");
  }

  let order = { shares: 0, amountCents: 0 };
  if (!reasons.length && decision?.limitPrice) {
    order = estimateLots(quote.asks, decision.limitPrice, remainingOrderCents);
    if (!order.shares) reasons.push("belowLot");
  }
  const latest = reference?.rows.at(-1);
  const before = reference?.rows.at(-2);
  return {
    index, decision: decision ?? null, reasons: [...new Set(reasons)],
    close: latest ? { date: latest[0], value: latest[1], dailyReturn: before ? latest[1] / before[1] - 1 : null,
      source: reference.source, fresh: reference.fresh } : null,
    boughtThisMonthCents: sum.boughtThisMonth, remainingGroupCents, riskBudgetCents, remainingOrderCents,
    bestAsk: bestAsk ?? null, askPremium, ...order,
  };
}

function todayDecision({ now, budget, planState, history, indexes, market }) {
  const clock = chinaClock(now);
  const month = clock.date.slice(0, 7);
  const plan = planState.plan ?? { budget, startMonth: month };
  const installments = plan.installments ?? factorPolicy.installments;
  const monthIndex = monthNumber(month) - monthNumber(plan.startMonth);
  const session = checkSession(clock, history);
  const baseReasons = [...session.reasons];
  if (monthIndex < 0) baseReasons.push("planNotStarted");
  else if (monthIndex >= installments) baseReasons.push("planEnded");
  if (planState.error) baseReasons.push("planUnavailable");
  if (plan.policyVersion && plan.policyVersion !== factorPolicy.version) baseReasons.push("policyUnavailable");

  const budgetCents = plan.budget * 100;
  const exposure = summarizePlan(planState.trades, month, budgetCents);
  const inputRows = Object.fromEntries(Object.entries(indexes).map(([index, { rows }]) => [index, rows]));
  const calibration = calibrateFactor(inputRows, history.premiums);
  const quotesByCode = new Map([...(market?.funds ?? []), ...(market?.forecastQuote ? [market.forecastQuote] : [])]
    .map((quote) => [quote.code, quote]));
  let totalRemaining = exposure.remainingCents;
  const groups = Object.entries(indexesToCodes).map(([index, members]) => {
    const calibrated = calibration.groups[index] && members.every((code) => calibration.funds[code]);
    const baseAmount = plan.budget * members.length / codes.length / installments;
    const decision = calibrated
      ? openingDecision({ index, members }, clock.date, baseAmount, calibration, history.premiums)
      : null;
    const verdict = inspectGroup({
      index, decision, reference: indexes[index], quote: quotesByCode.get(decision?.code),
      sum: exposure.groups[index], budgetCents, totalRemaining, baseReasons, date: clock.date,
      nowMs: now.getTime(), marketMode: market?.mode,
    });
    totalRemaining -= verdict.amountCents;
    return verdict;
  });
  const quotes = codes.map((code) => {
    const quote = quotesByCode.get(code);
    return {
      code, name: quote?.manager ?? "",
      price: quote?.lastPrice ?? null, quoteAt: quote?.quoteAt ?? null, iopv: quote?.iopv ?? null,
      premium: quote?.iopv > 0 ? quote.lastPrice / quote.iopv - 1 : null,
    };
  });
  return {
    date: clock.date, checkedAt: now.toISOString(), monthlyCheck: session.first,
    planBudget: plan.budget, monthIndex, installments,
    preview: !planState.plan, planState, holdings: exposure.positions,
    boughtCents: exposure.boughtCents, remainingCents: exposure.remainingCents,
    totalCents: groups.reduce((sum, group) => sum + group.amountCents, 0),
    groups, quotes, quoteMode: market?.mode ?? null,
  };
}

module.exports = { chinaClock, todayDecision };
