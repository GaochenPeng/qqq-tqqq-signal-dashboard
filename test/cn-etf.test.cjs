const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const path = require("node:path");
const hasHistory = existsSync(path.join(__dirname, "../data/cn-etf-history.json"));
const hasPremiums = existsSync(path.join(__dirname, "../data/cn-etf-premium-history.json"));
const hasFactorIndexes = existsSync(path.join(__dirname, "../data/cn-etf-factor-indexes.json"));
const snapshot = require("../data/cn-etf-snapshot.json");
const { cnEtfMarket, parseQuoteBatch } = require("../api/_cn-etf-market");
const { buildSignalSchedule, cnEtfBacktest, simulate } = require("../api/_cn-etf-backtest");
const { factorPolicy, calibrateFactor, planFactorBuys } = require("../api/_cn-etf-factor");
const { fixedBacktests } = require("../api/_cn-etf-fixed");
const { pairInputs, usableNavs } = require("../api/_cn-etf-history-source");
const { monthlyPolicy, todayDecision } = require("../api/_cn-etf-today");

function rawBatch(timestamp, missingIopv = null) {
  return snapshot.funds.map((fund) => {
    const fields = Array(82).fill("");
    fields[2] = fund.code;
    fields[3] = fund.lastPrice;
    fields[30] = timestamp;
    fields[61] = "ETF";
    if (fund.code !== missingIopv) {
      fields[77] = (100 * (fund.lastPrice / fund.iopv - 1)).toFixed(2);
      fields[78] = fund.iopv;
    }
    for (const [index, { price, lots }] of fund.asks.entries()) {
      fields[19 + 2 * index] = price;
      fields[20 + 2 * index] = lots;
    }
    const exchange = fund.code.startsWith("15") ? "sz" : "sh";
    return `v_${exchange}${fund.code}="${fields.join("~")}";`;
  }).join("\n");
}

test("same-batch quote parsing preserves the price, IOPV, quote time, and depth", () => {
  const batch = parseQuoteBatch(rawBatch("20261119141000"));
  assert.equal(batch.asOf, "2026-11-19T14:10:00+08:00");
  assert.equal(batch.funds.length, 12);
  for (const [index, fund] of batch.funds.entries()) {
    assert.equal(fund.lastPrice, snapshot.funds[index].lastPrice);
    assert.equal(fund.iopv, snapshot.funds[index].iopv);
    assert.deepEqual(fund.asks, snapshot.funds[index].asks);
  }
  assert.equal(parseQuoteBatch(rawBatch("20261119141000", "159660")).funds.find((fund) => fund.code === "159660").iopv, null);
  assert.throws(() => parseQuoteBatch(""), /ETF 行情/);
});

test("concurrent quote requests share a source call and failures keep the last valid batch", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-19T14:12:00+08:00"));
  let calls = 0;
  let stamp = "20261119141000";
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return stamp === null ? new Response("", { status: 503 }) : new Response(rawBatch(stamp));
  });
  const first = cnEtfMarket();
  assert.equal(first, cnEtfMarket());
  assert.equal((await first).mode, "upstream");
  assert.equal(calls, 1);
  stamp = "20261119141100";
  assert.equal((await cnEtfMarket()).asOf, "2026-11-19T14:11:00+08:00");
  stamp = "20261119140900";
  const stale = await cnEtfMarket();
  assert.equal(stale.mode, "snapshot");
  assert.equal(stale.asOf, "2026-11-19T14:11:00+08:00");
  stamp = null;
  assert.equal((await cnEtfMarket()).mode, "snapshot");
  assert.equal(calls, 4);
});

test("a U.S. signal executes on the next common Chinese session, never the same calendar day", () => {
  const sessions = ["2026-01-05", "2026-01-09", "2026-02-03"];
  const nasdaq = ["2026-01-05", "2026-02-02"].map((date) => ({ date }));
  const state = { capePercentile: 50, drawdownPct: -5, crash25dPct: 1, vix: 20, vixAvailable: true };
  const schedule = buildSignalSchedule(sessions, nasdaq, [state, state], "2026-02-02");
  assert.deepEqual([...schedule].map(([tradeDate, { decisionDate }]) => [tradeDate, decisionDate]), [
    ["2026-01-09", "2026-01-05"], ["2026-02-03", "2026-02-02"],
  ]);
});

test("drawdown includes waiting cash and the initial trading cost", () => {
  const sessions = ["2026-01-05", "2026-01-06"];
  const prices = new Map([
    [sessions[0], { open: 10, close: 10 }],
    [sessions[1], { open: 10, close: 5 }],
  ]);
  const once = simulate("once", sessions, [prices]);
  assert.equal(once.finalValue, 499750.12);
  assert.ok(Math.abs(once.maxDrawdown - (1 - 0.5 / 1.0005)) < 1e-8);
  assert.deepEqual(once.drawdowns, [-0.0005, -0.50025]);
  const monthly = simulate("monthly", sessions, [prices]);
  assert.ok(monthly.finalValue > 950_000);
  assert.ok(monthly.maxDrawdown < 0.05);
  assert.equal(simulate("signal", sessions, [prices]).finalValue, 1_000_000);
});

test("fixed replays preselect the fund, enforce whole lots and distinguish opening and intraday limits", () => {
  const codes = ["159660", "513110"];
  const sessions = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"];
  const raw = new Map([
    [codes[0], new Map(sessions.map((day, i) => [day, { open: i === 0 ? 1.06 : 1.04, low: i === 0 ? 1.049 : 1.019 }]))],
    [codes[1], new Map(sessions.map((day) => [day, { open: 1.03, low: 1.025 }]))],
  ]);
  const histories = codes.map((code) => new Map(sessions.map((day, i) =>
    [day, { open: raw.get(code).get(day).open, close: i === 2 ? 0.90 : 1.06 }])));
  const premiums = new Map(codes.map((code, i) => [code, new Map([
    ["2024-12-31", { open: 1 + i * 0.02, nav: 1 }],
    ...sessions.map((day) => [day, { open: raw.get(code).get(day).open, nav: 1,
      navDate: "2024-12-24", usableDay: "2024-12-27" }]),
  ])]));
  const calibration = {
    funds: Object.fromEntries(codes.map((code) => [code, { premiumLimit: 0.05, pairs: [...premiums.get(code)] }])),
    groups: { NDX: { volatilityLimit: 0.25, states: [
      { date: "2024-12-31", trend: 0.02, volatility: 0.2 },
      { date: "2025-01-02", trend: -0.02, volatility: 0.4 },
    ] } },
  };
  const signals = { NDX: new Map([
    ["2024-12-31", { rsi: 40, drawdown: -0.09 }],
    ["2025-01-02", { rsi: 18, drawdown: -0.21 }],
  ]) };
  const inputs = { raw, premiums, calibration, signals, budget: 1_000_000 };
  const { strategies, matched } = fixedBacktests(codes, sessions, histories, inputs);
  assert.equal(strategies.firstOpen.buyCount, 0);
  const signature = (id) => strategies[id].fills.map(({ date, code, execution }) => [date, code, execution]);
  assert.deepEqual(signature("resting"), [["2025-01-02", "159660", "intraday"]]);
  assert.deepEqual(signature("anyOpen"), [["2025-01-03", "513110", "open"]]);
  assert.deepEqual(signature("restingStrict"), signature("anyOpen"));
  assert.deepEqual(strategies.reserveRsi.fills[0].tiers, [30, 20]);
  assert.deepEqual(strategies.reserveDrawdown.fills[0].tiers, [-0.12, -0.20]);
  assert.equal(strategies.reserveRsi.buyCount, 1);
  assert.equal(strategies.reserveRsi.fills[0].signalDate, "2025-01-02");
  assert.ok(strategies.trendVol.fills[0].amount < strategies.anyOpen.fills[0].amount / 3);
  assert.ok(Math.abs(matched.reserveRsi.investedRatio - strategies.reserveRsi.investedRatio) < 1e-10);
  for (const strategy of Object.values(strategies)) {
    assert.equal(strategy.equity.length, sessions.length);
    assert.equal(strategy.drawdowns.length, sessions.length);
    assert.ok(Math.abs(Math.min(...strategy.drawdowns) + strategy.maxDrawdown) < 1e-6);
    assert.ok(strategy.fills.every((fill) => fill.size % 100 === 0));
    assert.ok(Math.abs(strategy.cash + strategy.fills.reduce((sum, fill) => sum + fill.amount, 0) - inputs.budget) < 1e-8);
  }
  const tooSmall = fixedBacktests(codes, sessions, histories, { ...inputs, budget: 1 });
  assert.equal(tooSmall.strategies.reserveRsi.buyCount, 0);
  assert.equal(tooSmall.strategies.reserveRsi.cash, 1);
  assert.deepEqual(fixedBacktests(codes, sessions, histories, { ...inputs, raw: new Map() }), { unavailable: "missingBars" });
});

test("late NAV sensitivity shifts availability using exchange sessions", () => {
  const calendar = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08", "2025-01-09"];
  const opens = new Map(calendar.map((day) => [day, 1]));
  const nav = [{ date: calendar[0], nav: 1, action: false }];
  assert.equal(pairInputs(opens, opens, nav, calendar)[0][0], "2025-01-07");
  assert.deepEqual(pairInputs(opens, opens, nav, calendar, 5), [["2025-01-09", 1, "2025-01-02", 1, "2025-01-09"]]);
  assert.deepEqual([...usableNavs([calendar[3]], nav, calendar)], [
    ["2025-01-07", { nav: 1, navDate: "2025-01-02", usableDay: "2025-01-07" }],
  ]);
});

test("backtest rejects invalid or repeated budget parameters before reading market data", () => {
  for (const budget of ["", "0", "-1", "1.5", "5e5", "Infinity", "90071992547410", ["500000", "500000"]]) {
    assert.throws(() => cnEtfBacktest({ budget }), { statusCode: 400, message: /初始资金/ });
  }
});

test("the default basket and selectable single funds use actual common ETF dates",
  { skip: !hasHistory && "local history snapshot not bootstrapped" }, () => {
  const result = cnEtfBacktest();
  assert.equal(result.budget, 1_000_000);
  assert.deepEqual(result.selected, ["159660", "513110", "159941", "513290"]);
  assert.equal(result.funds.length, 13);
  assert.equal(result.sessions.at(-1), result.available.end);
  assert.ok(result.sessions.length >= 230);
  assert.ok(result.strategies.every((strategy) => strategy.equity.length === result.sessions.length));
  const single = cnEtfBacktest({ codes: "513290", start: "2024-01-01", end: "2024-03-31" });
  assert.deepEqual(single.selected, ["513290"]);
  assert.ok(single.sessions.at(-1) <= "2024-03-31");
  assert.throws(() => cnEtfBacktest({ codes: "QQQ" }), { statusCode: 400 });
  assert.throws(() => cnEtfBacktest({ start: "2026-02-30" }), { statusCode: 400 });
});

test("premium thresholds check month-opening price against the available NAV and buy each fund at most once", () => {
  const sessions = ["2026-01-05", "2026-01-06", "2026-02-02", "2026-03-02"];
  const prices = new Map(sessions.map((date) => [date, { open: 5, close: 5 }]));
  const observations = new Map([
    [sessions[0], { open: 104, nav: 100, navDate: "2025-12-26", usableDay: "2025-12-31" }],
    [sessions[1], { open: 100, nav: 100, navDate: "2025-12-29", usableDay: "2026-01-05" }],
    [sessions[2], { open: 103, nav: 100, navDate: "2026-01-28", usableDay: "2026-02-02" }],
    [sessions[3], { open: 98, nav: 100, navDate: "2026-02-25", usableDay: "2026-03-02" }],
  ]);
  const control = { codes: ["159660"], points: [observations], limit: 3 };
  const tested = simulate("premium", sessions, [prices], { premium: control });
  assert.equal(tested.buyCount, 1);
  assert.equal(tested.purchases[0].date, sessions[2]);
  assert.equal(tested.equity[1], 1_000_000);
  assert.equal(tested.finalValue, 999500.25);
  assert.equal(tested.cash, 0);
});

test("portfolio and individual views report separate purchase counts and premium coverage",
  { skip: !(hasHistory && hasPremiums) && "local history snapshots not bootstrapped" }, () => {
  const result = cnEtfBacktest({ start: "2025-11-18", end: "2026-11-18" });
  assert.equal(result.premium.observations, 52);
  assert.equal(result.premium.checkpoints, 52);
  assert.deepEqual(result.premium.strategies.map((trial) => trial.limit), [1, 3, 5, 8]);
  assert.equal(result.strategies[0].buyCount, 4);
  assert.equal(result.strategies[1].buyCount, 48);
  assert.equal(result.byFund["513290"].strategies[0].buyCount, 1);
  assert.equal(result.byFund["513290"].strategies[1].buyCount, 12);
  assert.equal(result.byFund["159941"].premium.strategies[0].buyCount, 0);
  for (const { limit, buyCount, purchases } of result.premium.strategies) {
    assert.equal(purchases.length, buyCount);
    assert.equal(new Set(purchases.map(({ code }) => code)).size, buyCount);
    assert(purchases.every((fill) => fill.navDate < fill.usableDay && fill.usableDay <= fill.date
      && fill.open / fill.nav - 1 <= limit / 100 + 1e-12));
  }
  const mixed = cnEtfBacktest({ codes: "159660,159501" });
  assert.deepEqual(mixed.premium.unsupported, ["159501"]);
  assert.equal(mixed.premium.strategies.length, 0);
  assert.equal(mixed.byFund["159660"].premium.strategies.length, 4);
  assert.equal(mixed.byFund["159501"].strategies.length, 3);
  assert.equal(mixed.byFund["159501"].premium.strategies.length, 0);
});

test("custom budget funds all strategies in both portfolio and individual backtests",
  { skip: !(hasHistory && hasPremiums) && "local history snapshots not bootstrapped" }, () => {
  const dates = { start: "2025-11-18", end: "2026-11-18" };
  const baseline = cnEtfBacktest(dates);
  const custom = cnEtfBacktest({ ...dates, budget: "500000" });
  assert.equal(custom.budget, 500_000);
  for (const code of ["", ...baseline.selected]) {
    const original = code ? baseline.byFund[code] : baseline;
    const updated = code ? custom.byFund[code] : custom;
    const originalStrategies = [...original.strategies, ...original.premium.strategies];
    const updatedStrategies = [...updated.strategies, ...updated.premium.strategies];
    assert.equal(updatedStrategies.length, originalStrategies.length);
    for (const [index, strategy] of updatedStrategies.entries()) {
      const previous = originalStrategies[index];
      assert.equal(strategy.buyCount, previous.buyCount);
      assert.ok(Math.abs(strategy.cash - previous.cash / 2) < 0.01);
      assert.ok(Math.abs(strategy.maxDrawdown - previous.maxDrawdown) < 1e-10);
      assert.equal(strategy.equity.length, previous.equity.length);
      assert.ok(strategy.equity.every((value, day) => Math.abs(value - previous.equity[day] / 2) < 0.01));
    }
  }
});

test("factor calibration excludes all evaluation-period prices and premium observations", () => {
  const rows = Array.from({ length: 1200 }, (_, i) => [
    new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    100 + i + 2 * Math.sin(i),
  ]);
  const fund = (changeAfterCutoff) => new Map(rows.map(([date, close]) => [
    date, { open: (changeAfterCutoff && date > factorPolicy.fitEnd ? 10 : 1) * close, nav: close },
  ]));
  const original = calibrateFactor({ NDX: rows }, new Map([["159660", fund(false)]]));
  const changed = calibrateFactor({ NDX: rows.map(([date, close]) =>
    [date, date > factorPolicy.fitEnd ? close * 10 : close]) }, new Map([["159660", fund(true)]]));
  assert.equal(original.groups.NDX.volatilityLimit, changed.groups.NDX.volatilityLimit);
  assert.ok(original.groups.NDX.volatilityLimit > 0);
  assert.equal(original.funds["159660"].premiumLimit, 0);
  assert.equal(original.funds["159660"].premiumLimit, changed.funds["159660"].premiumLimit);
});

test("pre-open ranking and budget use prior information, and an unfilled limit cannot switch funds at the same open", () => {
  const date = "2025-02-05";
  const codes = ["159660", "513110", "159941", "513290"];
  const premiums = new Map(codes.map((code, i) => [code, new Map([
    ["2025-02-04", { open: 100 + i, nav: 100 }],
    [date, { open: i === 0 ? 110 : 99, nav: 100, navDate: "2025-01-23", usableDay: date }],
  ])]));
  const calibration = {
    funds: Object.fromEntries(codes.map((code) => [code, { premiumLimit: 0.03, pairs: [...premiums.get(code)] }])),
    groups: {
      NDX: { volatilityLimit: 0.25, states: [
        { date: "2025-02-04", trend: -0.1, volatility: 0.3 },
        { date, trend: 0.5, volatility: 0.1 },
      ] },
      NBI: { volatilityLimit: 0.3, states: [{ date: "2025-02-04", trend: 0.1, volatility: 0.15 }] },
    },
  };
  const result = planFactorBuys(codes, [date], 1_000_000, 12, calibration, premiums);
  assert.equal(result.decisions[0].code, "159660");
  assert.equal(result.decisions[0].signal.date, "2025-02-04");
  assert.equal(result.decisions[0].proposedAmount, 15_625);
  assert.equal(result.decisions[0].reason, "aboveLimit");
  assert.deepEqual([...result.orders.get(date).keys()], [3]);
  assert.equal(result.decisions[1].reason, "limitMet");
  assert.equal(result.decisions[1].proposedAmount, 250_000 / 12);
  assert.deepEqual(planFactorBuys(codes, ["2024-12-31"], 1_000_000, 12, calibration, premiums), { unavailable: "beforeSample" });
});

test("out-of-sample factor portfolio and individual ETFs reconcile every fill with cash and trading fees",
  { skip: !(hasHistory && hasPremiums && hasFactorIndexes) && "local ETF history or index closes not bootstrapped" }, () => {
  const sample = cnEtfBacktest({ sample: "out", end: "2026-11-19" });
  assert.equal(sample.sessions[0], "2025-01-02");
  assert.deepEqual(sample.factor.groups.map(({ index, weight }) => [index, weight]), [["NDX", 0.75], ["NBI", 0.25]]);
  for (const view of [sample, ...Object.values(sample.byFund)]) {
    const { strategy, decisions } = view.factor;
    const fills = decisions.filter(({ amount }) => amount > 0);
    assert.equal(strategy.buyCount, fills.length);
    assert.equal(strategy.equity.length, view.sessions.length);
    assert.ok(fills.every((decision) => decision.signal.date < decision.date &&
      decision.candidates.every((item) => item.date < decision.date) &&
      decision.navUsableDate <= decision.date && decision.open <= decision.limitPrice + 1e-12));
    assert.ok(Math.abs(strategy.cash + fills.reduce((total, { amount }) => total + amount, 0) - sample.budget) < 1e-6);
    assert.ok(Math.abs(strategy.fees - fills.reduce((total, { fee }) => total + fee, 0)) < 1e-6);
    assert.ok(Math.abs(strategy.investedRatio - (1 - strategy.cash / sample.budget)) < 1e-12);
    assert.equal(view.strategies[0].investedRatio, 1);
    assert.ok(Math.abs(view.strategies[1].investedRatio - 1) < 1e-12);
  }
  assert.equal(sample.factor.decisions.length, 24);
  assert.ok(sample.factor.strategy.buyCount > 0);
});

function todayFixture(date = "2025-01-03") {
  const before = "2024-12-31";
  const codes = ["159660", "513110", "159941", "513290"];
  const rows = Array.from({ length: 1096 }, (_, i) => [
    new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10), 1_000 + i,
  ]).filter(([day]) => day <= before);
  const premiums = new Map(codes.map((code, i) => [code, new Map(rows.filter(([day]) => day >= "2023-12-01")
    .map(([day]) => [day, { open: 1.02 + i * 0.005, nav: 1 }]))]));
  const navs = new Map(codes.map((code) => [code, { nav: 1, navDate: "2024-12-26", usableDay: "2025-01-02" }]));
  const calendar = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2025, 0, i + 2)))
    .filter((day) => day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
    .map((day) => day.toISOString().slice(0, 10)).filter((day) => day <= date);
  const quote = (code) => ({
    code, lastPrice: 1, quoteAt: date + "T10:00:00+08:00", iopv: 0.99,
    asks: [{ price: 1, lots: 10_000 }],
  });
  return {
    now: new Date(date + "T10:00:01+08:00"),
    budget: 1_000_000,
    planState: { enabled: true, plan: null, trades: [] },
    history: { calendar, premiums, navs },
    indexes: Object.fromEntries(["NDX", "NBI"].map((index) => [index, { rows, source: "test", fresh: true }])),
    market: { mode: "upstream", funds: codes.slice(0, 3).map(quote), forecastQuote: quote("513290") },
  };
}

function setAsk(fixture, code, ask, iopv) {
  const quote = fixture.market.funds.find((item) => item.code === code) ?? fixture.market.forecastQuote;
  quote.iopv = iopv;
  quote.asks[0].price = ask;
  return quote;
}

test("a non-month-start decision selects a passing ETF and explains each failed price guard", () => {
  const fixture = todayFixture();
  setAsk(fixture, "159660", 1.02, 0.9);
  setAsk(fixture, "513110", 1.025, 1.02);
  setAsk(fixture, "159941", 1.031, 1.02);
  const data = todayDecision(fixture);
  const [ndx, nbi] = data.groups;
  assert.deepEqual(ndx.reasons, []);
  assert.deepEqual(nbi.reasons, []);
  assert.equal(data.tradingDay, 2);
  assert.equal(data.preview, true);
  assert.equal(ndx.decision.code, "513110");
  assert.equal(ndx.monthlyBudgetCents, 6_250_000);
  assert.deepEqual(ndx.candidates[0].reasons, ["iopvPremiumAboveLimit"]);
  assert.deepEqual(ndx.candidates.find(({ code }) => code === "159941").reasons, ["askAboveLimit"]);
  assert.ok(ndx.shares > 0 && ndx.shares % 100 === 0);
  assert.ok(ndx.amountCents <= ndx.monthlyBudgetCents);
  assert.ok(nbi.amountCents > 0);
  assert.equal(data.totalCents, ndx.amountCents + nbi.amountCents);
  assert.equal(data.groups.flatMap((group) => group.candidates).length, 4);
});

test("the saved plan overrides a preview and debits the actual monthly buys across the same index", () => {
  const fixture = todayFixture();
  const planState = {
    enabled: true,
    plan: { budget: 800_000, startMonth: "2024-12", installments: 12, policyVersion: monthlyPolicy.version },
    trades: [
      { date: "2024-12-03", side: "buy", code: "159941", shares: 1_000, amountCents: 100_000 },
      { date: "2025-01-02", side: "buy", code: "513110", shares: 30_000, amountCents: 3_000_000 },
      { date: "2025-01-02", side: "sell", code: "513110", shares: 10_000, amountCents: 1_000_000 },
    ],
  };
  const replay = todayDecision({ ...fixture, planState });
  assert.equal(replay.planBudget, 800_000);
  assert.equal(replay.monthIndex, 1);
  assert.equal(replay.preview, false);
  assert.equal(replay.holdings["513110"].shares, 20_000);
  assert.equal(replay.groups[0].boughtThisMonthCents, 3_000_000);
  assert.equal(replay.groups[0].remainingMonthCents, 2_000_000);
  assert.equal(replay.remainingCents, 76_900_000);
  planState.trades[1].amountCents = 5_000_000;
  const spent = todayDecision({ ...fixture, planState });
  assert.ok(spent.groups[0].reasons.includes("monthlyBudgetUsed"));
  assert.ok(spent.groups[0].candidates.every((item) => item.buyAt === null));
  assert.equal(spent.groups[0].amountCents, 0);
  assert.ok(spent.groups[1].amountCents > 0);
});

test("late-month buys honor the small quota, both caps and covered depth", () => {
  const fixture = todayFixture("2025-01-16");
  fixture.planState.plan = { budget: 1_000_000, startMonth: "2025-01", installments: 12, policyVersion: monthlyPolicy.version };
  const fills = fixture.planState.trades;
  fills.push({ date: "2025-01-10", code: "159941", side: "buy", shares: 10_000, amountCents: 1_000_000 });
  for (const quote of fixture.market.funds) setAsk(fixture, quote.code, 1.08, 1);
  const best = fixture.market.funds[0];
  best.asks[0].lots = 1;
  best.asks.push({ price: 1.081, lots: 10_000 });
  fixture.market.funds[1].asks = [];
  fixture.market.funds[2].asks = [];
  const data = todayDecision(fixture);
  assert.equal(data.tradingDay, 11);
  const ndx = data.groups[0];
  assert.equal(ndx.decision.tier, "small");
  assert.equal(ndx.decision.effectiveLimit, 1.08);
  assert.equal(ndx.decision.buyAt, 1.08);
  assert.equal(ndx.shares, 100);
  assert.equal(ndx.smallRemainingCents, 562_500);
  assert.equal(ndx.remainingMonthCents, 5_250_000);
  best.asks[0].lots = 10_000;
  assert.ok(todayDecision(fixture).groups[0].amountCents <= 562_500);

  best.iopv = 0.99;
  const refChanged = todayDecision(fixture).groups[0];
  assert.equal(refChanged.amountCents, 0);
  assert.equal(refChanged.candidates[0].iopvLimit, 1.069);
  assert.equal(refChanged.candidates[0].buyAt, 1.069);
  assert.deepEqual(refChanged.candidates[0].reasons, ["iopvPremiumAboveLimit"]);

  best.iopv = 1;
  fills[0].amountCents = 1_562_500;
  const spent = todayDecision(fixture).groups[0];
  assert.equal(spent.amountCents, 0);
  assert.equal(spent.candidates[0].buyAt, 1.05);
  assert.deepEqual(spent.candidates[0].reasons, ["smallBudgetUsed"]);
  best.asks[0].price = 1.05;
  const normal = todayDecision(fixture).groups[0];
  assert.equal(normal.decision.tier, "normal");
  assert.equal(normal.decision.remainingOrderCents, 4_687_500);
  assert.ok(normal.amountCents > 0 && normal.amountCents <= 4_687_500);
});

test("the explained entry price reflects the tier that would apply after the offer falls", () => {
  const fixture = todayFixture("2025-01-16");
  fixture.market.funds.slice(1).forEach((quote) => { quote.asks = []; });
  const quote = setAsk(fixture, "159660", 1.081, 0.97);
  const unavailable = todayDecision(fixture).groups[0].candidates[0];
  assert.equal(unavailable.tier, "small");
  assert.equal(unavailable.buyAt, 1.047);
  quote.asks[0].price = 1.048;
  assert.equal(todayDecision(fixture).groups[0].decision, null);
  quote.asks[0].price = unavailable.buyAt;
  const reached = todayDecision(fixture).groups[0].decision;
  assert.equal(reached.tier, "normal");
  assert.equal(reached.effectiveLimit, unavailable.buyAt);
  assert.ok(reached.amountCents > 0);
});

test("the explained entry price also fits one lot after fees", () => {
  const fixture = todayFixture("2025-01-16");
  fixture.planState.trades.push({ date: "2025-01-10", code: "159941", side: "buy", shares: 62_000, amountCents: 6_239_500 });
  fixture.market.funds.slice(1).forEach((quote) => { quote.asks = []; });
  const quote = setAsk(fixture, "159660", 1.05, 1);
  const remaining = todayDecision(fixture).groups[0];
  const at = remaining.candidates[0].buyAt;
  assert.equal(remaining.remainingMonthCents, 10_500);
  assert.equal(at, 1.049);
  assert.deepEqual(remaining.candidates[0].reasons, ["belowLot"]);
  quote.asks[0].price = at;
  assert.equal(todayDecision(fixture).groups[0].decision.shares, 100);
});

test("a failed fund valuation or optional index source leaves other eligible funds usable", () => {
  const fixture = todayFixture();
  fixture.history.navs.delete("159660");
  fixture.indexes = {};
  setAsk(fixture, "513110", 1.015, 1);
  setAsk(fixture, "159941", 1.015, 0.99);
  const [ndx, nbi] = todayDecision(fixture).groups;
  assert.equal(ndx.decision.code, "513110");
  assert.equal(ndx.close, null);
  assert.ok(nbi.amountCents > 0);
  assert.deepEqual(ndx.candidates[0].reasons, ["navUnavailable"]);
});

test("stale quotes, the end of continuous trading and unreadable plan state block buy suggestions", () => {
  const stale = todayFixture();
  stale.now = new Date("2025-01-03T10:04:00+08:00");
  const staleResult = todayDecision(stale);
  assert.equal(staleResult.totalCents, 0);
  assert.ok(staleResult.groups[0].candidates.every((item) =>
    item.reasons.includes("quoteUnavailable") && item.buyAt === null));

  const nearLunch = todayFixture();
  nearLunch.market.funds[0].quoteAt = "2025-01-03T11:29:55+08:00";
  nearLunch.now = new Date("2025-01-03T11:29:56+08:00");
  assert.equal(todayDecision(nearLunch).orderExpiresAt, "2025-01-03T03:30:00.000Z");
  nearLunch.now = new Date("2025-01-03T11:30:01+08:00");
  assert.ok(todayDecision(nearLunch).groups[0].reasons.includes("outsideTradingHours"));
  const planFailure = todayFixture();
  planFailure.planState.error = "test";
  assert.equal(todayDecision(planFailure).totalCents, 0);
  assert.ok(todayDecision(planFailure).groups[0].reasons.includes("planUnavailable"));
});
