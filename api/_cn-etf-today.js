const { factorPolicy, factorGroups, calibrateFactor } = require("./_cn-etf-factor");
const { assessMarketRisk } = require("./_cn-etf-risk");

const monthlyPolicy = Object.freeze({
  version: "monthly-premium-v2",
  installments: factorPolicy.installments,
  earlyDays: 10,
  normalPremium: 0.05,
  maximumPremium: 0.08,
  smallFraction: 0.25,
});

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
const precision = 1e-10;

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
    if (ask.price > limit + precision) break;
    const lotCents = Math.ceil(Math.round(ask.price * lotSize * 100) * (1 + costRate));
    const lots = Math.min(ask.lots, Math.floor((budgetCents - amountCents) / lotCents));
    shares += lots * lotSize;
    amountCents += lots * lotCents;
  }
  return { shares, amountCents };
}

function checkSession({ date, minutes }, calendar) {
  const month = date.slice(0, 7);
  const tradingDay = calendar.filter((day) => day.startsWith(month)).indexOf(date) + 1;
  const reasons = [];
  if (!calendar.length) reasons.push("calendarUnavailable");
  else if (!tradingDay) reasons.push("notTradingDate");
  const continuous = (minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 897);
  if (!continuous) reasons.push("outsideTradingHours");
  const closes = minutes < 690 ? "11:30" : "14:57";
  const endsAt = continuous ? Date.parse(date + "T" + closes + ":00+08:00") : null;
  return { tradingDay: tradingDay || null, endsAt, reasons };
}

function limitAtTick(reference, premium) {
  return Math.floor((reference * (1 + premium) + precision) * 1_000) / 1_000;
}

function affordableLimit(limit, budgetCents) {
  if (!limit || !budgetCents) return null;
  const lotPrice = budgetCents / (lotSize * 100 * (1 + costRate));
  return Math.min(limit, limitAtTick(lotPrice, 0)) || null;
}

function inspectFund({
  code, index, quote, marketMode, valuation, fittedPremium, late,
  date, nowMs, remainingMonthCents, smallRemainingCents, groupBlocked, smallWait, continuous,
}) {
  const reasons = [];
  const quoteAge = nowMs - Date.parse(quote?.quoteAt);
  const quoteFresh = continuous && marketMode === "upstream" && quote?.quoteAt?.slice(0, 10) === date &&
    quoteAge >= -10_000 && quoteAge <= quoteMaxAgeMs;
  const observedIopv = quote?.iopv > 0 ? quote.iopv : null;
  const observedAsk = quote?.asks[0]?.price ?? null;
  const iopv = quoteFresh ? observedIopv : null;
  const bestAsk = quoteFresh ? observedAsk : null;
  if (!quoteFresh) reasons.push("quoteUnavailable");
  else if (!iopv) reasons.push("iopvUnavailable");
  else if (!bestAsk) reasons.push("noAsks");

  const normalPremium = late ? monthlyPolicy.normalPremium : fittedPremium;
  if (!valuation) reasons.push("navUnavailable");
  if (normalPremium === undefined) reasons.push("calibrationUnavailable");
  const normalLimit = valuation && normalPremium !== undefined ? limitAtTick(valuation.nav, normalPremium) : null;
  const smallLimit = valuation && late ? limitAtTick(valuation.nav, monthlyPolicy.maximumPremium) : null;
  const iopvLimit = index === "NDX" && observedIopv ? limitAtTick(observedIopv, monthlyPolicy.maximumPremium) : null;
  const askPremium = bestAsk && iopv ? bestAsk / iopv - 1 : null;
  const strategyMax = smallLimit ?? normalLimit;
  if (bestAsk && strategyMax !== null && bestAsk > strategyMax + precision) reasons.push("askAboveLimit");
  if (bestAsk && iopvLimit !== null && bestAsk > iopvLimit + precision) reasons.push("iopvPremiumAboveLimit");

  const small = late && bestAsk && normalLimit !== null && bestAsk > normalLimit + precision;
  const tier = small ? "small" : "normal";
  const premiumCap = iopvLimit ?? Infinity;
  const normalCap = normalLimit === null ? null : Math.min(normalLimit, premiumCap);
  const smallCap = smallLimit === null ? null : Math.min(smallLimit, premiumCap);
  const effectiveLimit = small ? smallCap : normalCap;
  const remainingOrderCents = small ? smallRemainingCents : remainingMonthCents;
  if (small && bestAsk <= smallLimit + precision && remainingOrderCents === 0 && remainingMonthCents > 0) {
    reasons.push("smallBudgetUsed");
  }
  if (small && smallWait.length) reasons.push("marketConfirmation");

  let order = { shares: 0, amountCents: 0 };
  if (!groupBlocked && !reasons.length && effectiveLimit !== null) {
    order = estimateLots(quote.asks, effectiveLimit, remainingOrderCents);
    if (!order.shares) reasons.push("belowLot");
  }
  const normalBuyAt = affordableLimit(normalCap, remainingMonthCents);
  const smallBuyAt = affordableLimit(smallCap, smallRemainingCents);
  const priceOnlyBuyAt = observedIopv && (smallBuyAt !== null && smallBuyAt > normalLimit ? smallBuyAt : normalBuyAt);
  const referenceBuyAt = observedIopv && (smallWait.length ? normalBuyAt : priceOnlyBuyAt);
  const lastQuote = quote && !quoteFresh ? {
    bestAsk: observedAsk, iopv: observedIopv, lastPrice: quote.lastPrice,
    premium: observedIopv ? (observedAsk ?? quote.lastPrice) / observedIopv - 1 : null,
  } : null;
  return {
    code, name: quote?.manager ?? "", quoteAt: quote?.quoteAt ?? null, bestAsk, iopv, askPremium,
    nav: valuation?.nav ?? null, navDate: valuation?.navDate ?? null, normalLimit, smallLimit,
    iopvLimit, effectiveLimit, buyAt: quoteFresh ? referenceBuyAt : null,
    referenceBuyAt, priceOnlyBuyAt, lastQuote, tier, remainingOrderCents, reasons, ...order,
  };
}

function inspectGroup({
  index, reference, quotes, history, calibration, sum, budgetCents, installments, totalRemaining, session, date, nowMs, marketMode, risk,
}) {
  const members = indexesToCodes[index];
  const groupBudgetCents = Math.floor(budgetCents * (members.length / codes.length));
  const monthlyBudgetCents = Math.floor(groupBudgetCents / installments);
  const remainingGroupCents = Math.max(0, groupBudgetCents - sum.bought);
  const availableCents = Math.min(remainingGroupCents, totalRemaining);
  const remainingMonthCents = Math.max(0, Math.min(monthlyBudgetCents - sum.boughtThisMonth, availableCents));
  const late = index === "NDX" && session.tradingDay > monthlyPolicy.earlyDays;
  const smallBudgetCents = late ? Math.floor(monthlyBudgetCents * monthlyPolicy.smallFraction) : null;
  // 每组当月实盘买入占用本组额度，换一只同指数 ETF 也不会重置额度。
  const smallRemainingCents = late ? Math.max(0, Math.min(smallBudgetCents - sum.boughtThisMonth, availableCents)) : null;
  const reasons = [...session.reasons];
  if (availableCents === 0) reasons.push("planBudgetUsed");
  else if (remainingMonthCents === 0) reasons.push("monthlyBudgetUsed");
  if (risk.blockers.length) reasons.push("marketRisk");
  const smallWait = late ? risk.smallWait : [];
  const candidates = members.map((code) => inspectFund({
    code, index, quote: quotes.get(code), marketMode, valuation: history.navs.get(code),
    fittedPremium: calibration.funds[code]?.premiumLimit, late, date, nowMs, remainingMonthCents, smallRemainingCents,
    groupBlocked: reasons.length > 0, smallWait, continuous: session.endsAt !== null,
  }));
  const eligible = candidates.filter((item) => item.amountCents > 0)
    .sort((a, b) => a.askPremium - b.askPremium || a.code.localeCompare(b.code));
  const decision = eligible[0] ?? null;
  if (!decision && !reasons.length) reasons.push("noEligibleFund");
  const latest = reference?.rows.at(-1);
  const before = reference?.rows.at(-2);
  const indicator = calibration.groups[index];
  return {
    index, decision, candidates, reasons, risk: { blockers: risk.blockers, smallWait },
    close: latest ? { date: latest[0], value: latest[1], dailyReturn: before ? latest[1] / before[1] - 1 : null,
      source: reference.source, fresh: reference.fresh } : null,
    signal: indicator?.states.at(-1) ?? null, volatilityLimit: indicator?.volatilityLimit ?? null,
    monthlyBudgetCents, boughtThisMonthCents: sum.boughtThisMonth, remainingMonthCents, smallBudgetCents, smallRemainingCents,
    shares: decision?.shares ?? 0, amountCents: decision?.amountCents ?? 0,
  };
}

function todayDecision({ now, budget, planState, history, indexes, market, riskInputs, calendar }) {
  const clock = chinaClock(now);
  const month = clock.date.slice(0, 7);
  const plan = planState.plan ?? { budget, startMonth: month };
  const installments = plan.installments ?? monthlyPolicy.installments;
  const monthIndex = monthNumber(month) - monthNumber(plan.startMonth);
  const session = checkSession(clock, history.calendar);
  if (monthIndex < 0) session.reasons.push("planNotStarted");
  else if (monthIndex >= installments) session.reasons.push("planEnded");
  if (planState.error) session.reasons.push("planUnavailable");
  if (plan.policyVersion && plan.policyVersion !== monthlyPolicy.version) session.reasons.push("policyUnavailable");

  const budgetCents = plan.budget * 100;
  const exposure = summarizePlan(planState.trades, month, budgetCents);
  const inputRows = Object.fromEntries(Object.entries(indexes).map(([index, { rows }]) => [index, rows]));
  const calibration = calibrateFactor(inputRows, history.premiums);
  const { groups: riskByIndex, ...marketRisk } = assessMarketRisk({ now, indexes, riskInputs, calendar });
  const quotesByCode = new Map([...(market?.funds ?? []), ...(market?.forecastQuote ? [market.forecastQuote] : [])]
    .map((quote) => [quote.code, quote]));
  let totalRemaining = exposure.remainingCents;
  const groups = Object.keys(indexesToCodes).map((index) => {
    const verdict = inspectGroup({
      index, reference: indexes[index], quotes: quotesByCode, history, calibration, session, installments,
      sum: exposure.groups[index], budgetCents, totalRemaining, date: clock.date,
      nowMs: now.getTime(), marketMode: market?.mode,
      risk: riskByIndex[index],
    });
    totalRemaining -= verdict.amountCents;
    return verdict;
  });
  const orderExpiries = groups.filter((group) => group.decision)
    .map(({ decision }) => Date.parse(decision.quoteAt) + quoteMaxAgeMs);
  return {
    date: clock.date, checkedAt: now.toISOString(), tradingDay: session.tradingDay,
    planBudget: plan.budget, monthIndex, installments,
    preview: !planState.plan, planState, holdings: exposure.positions,
    boughtCents: exposure.boughtCents, remainingCents: exposure.remainingCents,
    totalCents: groups.reduce((sum, group) => sum + group.amountCents, 0),
    groups, marketRisk, calendar, quoteMode: market?.mode ?? null,
    orderExpiresAt: orderExpiries.length ? new Date(Math.min(session.endsAt, ...orderExpiries)).toISOString() : null,
  };
}

module.exports = { chinaClock, monthlyPolicy, todayDecision };
