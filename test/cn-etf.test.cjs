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
  const monthly = simulate("monthly", sessions, [prices]);
  assert.ok(monthly.finalValue > 950_000);
  assert.ok(monthly.maxDrawdown < 0.05);
  assert.equal(simulate("signal", sessions, [prices]).finalValue, 1_000_000);
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
