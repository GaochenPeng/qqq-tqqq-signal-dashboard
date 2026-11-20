const { factorGroups, factorPolicy, openingDecision } = require("./_cn-etf-factor");

const policy = Object.freeze({
  lotSize: 100,
  feeBps: 5,
  stressFeeBps: 10,
  restingTicks: 1,
  stressRestingTicks: 3,
  reserveFraction: 0.20,
  rsiPeriod: 14,
  rsiLevels: [30, 20],
  drawdownDays: 252,
  drawdownAverageDays: 5,
  drawdownLevels: [-0.12, -0.20],
});
const variants = {
  once: { baseline: "once" },
  monthly: { baseline: "monthly" },
  monthly10: { baseline: "monthly", stress: true },
  firstOpen: { firstOnly: true },
  anyOpen: {},
  anyOpen10: { stress: true },
  resting: { resting: true },
  restingStrict: { resting: true, stress: true },
  trend: { trend: true },
  vol: { vol: true },
  trendVol: { trend: true, vol: true },
  base80: { keepReserve: true },
  reserveDrawdown: { keepReserve: true, reserve: "drawdown" },
  reserveRsi: { keepReserve: true, reserve: "rsi" },
};
const lateNavVariants = ["anyOpen", "resting", "base80", "reserveRsi", "reserveDrawdown"];
const resizeVariants = ["trend", "vol", "trendVol"];
const timingVariants = ["reserveDrawdown", "reserveRsi"];
const minTick = 0.001;
const precision = 1e-9;
const closeCents = (value) => Math.round(value * 100) / 100;
const monthsBetween = (a, b) => (Number(a.slice(0, 4)) - Number(b.slice(0, 4))) * 12
  + Number(a.slice(5, 7)) - Number(b.slice(5, 7));

function reserveSignals(indexes) {
  return Object.fromEntries(Object.entries(indexes).map(([index, rows]) => {
    const means = [];
    const factors = new Map();
    let gain = 0;
    let loss = 0;
    for (const [i, [date, close]] of rows.entries()) {
      const changes = i > 0 ? close - rows[i - 1][1] : 0;
      const up = Math.max(changes, 0);
      const down = Math.max(-changes, 0);
      const n = policy.rsiPeriod;
      gain = i <= n ? gain + up / n : ((n - 1) * gain + up) / n;
      loss = i <= n ? loss + down / n : ((n - 1) * loss + down) / n;
      const smooth = policy.drawdownAverageDays;
      if (i >= smooth - 1) means.push(rows.slice(i + 1 - smooth, i + 1)
        .reduce((total, [, price]) => total + price, 0) / smooth);
      factors.set(date, {
        rsi: i < n ? null : gain + loss === 0 ? 50 : 100 * gain / (gain + loss),
        drawdown: means.length < policy.drawdownDays
          ? null : means.at(-1) / Math.max(...means.slice(-policy.drawdownDays)) - 1,
      });
    }
    return [index, factors];
  }));
}

function plannedDays(codes, sessions, prices, budget, calibration, premiums, signals) {
  const groups = [...new Set(codes.map((code) => factorGroups[code]))].map((index) => {
    const members = codes.filter((code) => factorGroups[code] === index);
    return { index, members, capital: budget * members.length / codes.length };
  });
  return sessions.filter((date) => monthsBetween(date, sessions[0]) < factorPolicy.installments).map((date, i) => ({
    date,
    month: date.slice(0, 7),
    firstDay: i === 0,
    firstOfMonth: i === 0 || !sessions[i - 1].startsWith(date.slice(0, 7)),
    entries: groups.map((group) => {
      const tranche = group.capital / factorPolicy.installments;
      const decision = openingDecision(group, date, tranche, calibration, premiums);
      const signal = signals[group.index].get(decision.signal?.date);
      return { group, tranche, decision, signal };
    }),
    prices: Object.fromEntries(codes.map((code) => [code, prices.get(code).get(date)])),
  }));
}

function ordersByDay(days, variant, matchedCapital) {
  const monthly = new Set();
  const reserves = new Set();
  const rate = (variant.stress ? policy.stressFeeBps : policy.feeBps) / 10_000;
  const months = days.filter((day) => day.firstOfMonth).length;
  const orders = new Map();
  for (const { date, month, firstDay, firstOfMonth, entries, prices } of days) {
    const trades = [];
    for (const { group, tranche, decision, signal } of entries) {
      const { index, capital, members } = group;
      if (variant.baseline) {
        const once = variant.baseline === "once";
        if (once ? firstDay : firstOfMonth) {
          const gross = (matchedCapital ? matchedCapital[index] / months : once ? capital : tranche) / members.length;
          for (const code of members) trades.push({ code, index, gross, price: prices[code].open, execution: "open" });
        }
        continue;
      }
      if ((variant.firstOnly && !firstOfMonth) || decision.limitPrice === undefined) continue;
      const { code, navDate, navUsableDate } = decision;
      const { open, low } = prices[code];
      const cap = Math.floor((decision.limitPrice + 1e-12) / minTick) * minTick;
      const atOpen = open <= cap + precision;
      const ticks = variant.stress ? policy.stressRestingTicks : policy.restingTicks;
      if (!atOpen && (!variant.resting || low > cap - ticks * minTick + precision)) continue;

      const key = index + "/" + month;
      const trendReduced = Boolean(variant.trend && decision.trendReduced);
      const volatilityReduced = Boolean(variant.vol && decision.volatilityReduced);
      const baseFraction = variant.keepReserve ? 1 - policy.reserveFraction : 1;
      const reduced = factorPolicy.reducedFraction ** (Number(trendReduced) + Number(volatilityReduced));
      const base = monthly.has(key) ? 0 : tranche * baseFraction * reduced;
      const signalValue = variant.reserve ? signal?.[variant.reserve] : undefined;
      const levels = variant.reserve && signalValue != null ? policy[variant.reserve + "Levels"] : [];
      const tiers = levels.filter((level) => signalValue <= level && !reserves.has(index + "/" + level));
      const reserve = tiers.length ? capital * policy.reserveFraction * tiers.length / levels.length : 0;
      const price = atOpen ? open : cap;
      if (base + reserve + precision < policy.lotSize * price * (1 + rate)) continue;
      if (base > 0) monthly.add(key);
      for (const level of tiers) reserves.add(index + "/" + level);
      trades.push({ code, index, gross: base + reserve, reserve, tiers, signalValue,
        price, cap, execution: atOpen ? "open" : "intraday", signalDate: decision.signal.date,
        navDate, navUsableDate, trendReduced, volatilityReduced });
    }
    if (trades.length) orders.set(date, trades);
  }
  return orders;
}

function replay(id, codes, sessions, marks, raw, budget, orders, feeBps, fractional = false) {
  const shares = Object.fromEntries(codes.map((code) => [code, 0]));
  const invested = Object.fromEntries(codes.map((code) => [factorGroups[code], 0]));
  const fills = [];
  const drawdowns = [];
  const feeRate = feeBps / 10_000;
  let cash = budget;
  let peak = budget;
  let maxDrawdown = 0;
  let fees = 0;
  const equity = sessions.map((date) => {
    for (const order of orders.get(date) ?? []) {
      const { code, index, price } = order;
      const available = Math.min(cash, order.gross);
      const sharesBeforeRounding = available / (price * (1 + feeRate));
      const size = fractional ? sharesBeforeRounding
        : Math.floor((sharesBeforeRounding + precision) / policy.lotSize) * policy.lotSize;
      if (size <= 0) continue;
      const fee = size * price * feeRate;
      const amount = fractional ? available : size * price + fee;
      // 以未复权份额成交，再换成与前复权收盘价匹配的持仓份额。
      shares[code] += size * raw.get(code).get(date).open / marks[code].get(date).open;
      cash -= amount;
      fees += fee;
      invested[index] += amount;
      fills.push({ date, ...order, size, amount, fee,
        reserveAmount: order.reserve ? amount * order.reserve / order.gross : 0 });
    }
    const total = cash + codes.reduce((value, code) => value + shares[code] * marks[code].get(date).close, 0);
    peak = Math.max(peak, total);
    const drawdown = 1 - total / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    drawdowns.push(-Math.round(drawdown * 1e6) / 1e6);
    return closeCents(total);
  });
  const finalValue = equity.at(-1);
  return { id, equity, drawdowns, finalValue, totalReturn: finalValue / budget - 1, maxDrawdown, invested, fees, cash,
    investedRatio: 1 - cash / budget, buyCount: fills.length, fills };
}

function matchedReserveOrders(base, candidate) {
  const orders = new Map();
  const counts = {};
  for (const { index } of base.fills) counts[index] = (counts[index] ?? 0) + 1;
  if (Object.entries(candidate.invested).some(([index, amount]) => amount > 0 && !counts[index])) return null;
  for (const fill of base.fills) {
    const { index, date } = fill;
    const reserve = (candidate.invested[index] - base.invested[index]) / counts[index];
    const order = { ...fill, gross: fill.amount + reserve };
    if (!orders.has(date)) orders.set(date, []);
    orders.get(date).push(order);
  }
  return orders;
}

function comparison(result) {
  const { totalReturn, maxDrawdown, investedRatio } = result;
  return { totalReturn, maxDrawdown, investedRatio };
}

function fixedBacktests(codes, sessions, histories, {
  budget, calibration, lateCalibration, premiums, latePremiums, raw, signals,
}) {
  if (sessions[0] < factorPolicy.sampleStart || !sessions.length) return { unavailable: "beforeSample" };
  const unsupported = codes.filter((code) => !Object.hasOwn(factorGroups, code));
  if (unsupported.length) return { unavailable: "unsupported", unsupported };
  const calibrated = (inputs) => inputs && codes.every((code) =>
    inputs.funds[code] && inputs.groups[factorGroups[code]]);
  if (!calibrated(calibration)) return { unavailable: "missingInputs" };
  if (codes.some((code) => sessions.some((date) => !raw.get(code)?.has(date)))) {
    return { unavailable: "missingBars" };
  }

  const marks = Object.fromEntries(codes.map((code, i) => [code, histories[i]]));
  const run = (id, orders, feeBps = policy.feeBps, fractional = false) =>
    replay(id, codes, sessions, marks, raw, budget, orders, feeBps, fractional);
  const replayVariants = (prices, inputs, ids) => {
    const days = plannedDays(codes, sessions, raw, budget, inputs, prices, signals);
    const strategies = Object.fromEntries(ids.map((id) => {
      const variant = variants[id];
      const fee = variant.stress ? policy.stressFeeBps : policy.feeBps;
      return [id, run(id, ordersByDay(days, variant), fee)];
    }));
    const matched = {};
    for (const id of resizeVariants.filter((id) => strategies[id])) {
      const orders = ordersByDay(days, variants.monthly, strategies[id].invested);
      matched[id] = comparison(run(id, orders, policy.feeBps, true));
    }
    for (const id of timingVariants.filter((id) => strategies[id])) {
      const orders = matchedReserveOrders(strategies.base80, strategies[id]);
      if (orders) matched[id] = comparison(run(id, orders, policy.feeBps, true));
    }
    return { strategies, matched };
  };
  const main = replayVariants(premiums, calibration, Object.keys(variants));
  const late = calibrated(lateCalibration) ? replayVariants(latePremiums, lateCalibration, lateNavVariants) : null;
  return { ...main, late };
}

module.exports = { fixedBacktests, reserveSignals };
