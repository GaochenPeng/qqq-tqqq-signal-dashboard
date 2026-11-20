const fs = require("node:fs");
const path = require("node:path");

const factorPolicy = Object.freeze({
  version: "trend-vol-premium-v1",
  fitStart: "2023-01-01",
  fitEnd: "2024-12-31",
  sampleStart: "2025-01-01",
  trendDays: 126,
  volatilityDays: 20,
  volatilityPercentile: 0.8,
  premiumPercentile: 0.8,
  reducedFraction: 0.5,
  installments: 12,
});
const factorGroups = Object.freeze({
  "159660": "NDX",
  "513110": "NDX",
  "159941": "NDX",
  "513290": "NBI",
});
const indexFile = path.join(__dirname, "../data/cn-etf-factor-indexes.json");
const dayMs = 86_400_000;
let cache;

function readFactorIndexes() {
  let mtimeMs;
  try {
    ({ mtimeMs } = fs.statSync(indexFile));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (cache?.mtimeMs === mtimeMs) return cache.indexes;
  const { indexes } = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  for (const key of ["NDX", "NBI"]) {
    let previous = "";
    if (!Array.isArray(indexes?.[key]) || indexes[key].length <= factorPolicy.trendDays) {
      throw new Error(`${key} 因子历史不足`);
    }
    for (const [date, close] of indexes[key]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= previous || !Number.isFinite(close) || close <= 0) {
        throw new Error(`${key} 指数收盘数据无效 ${date}`);
      }
      previous = date;
    }
  }
  cache = { mtimeMs, indexes };
  return indexes;
}

function indexFactors(rows) {
  const { trendDays, volatilityDays } = factorPolicy;
  const returns = rows.map(([, close], i) => i === 0 ? 0 : Math.log(close / rows[i - 1][1]));
  return rows.slice(trendDays).map(([date, close], offset) => {
    const i = offset + trendDays;
    const recent = returns.slice(i + 1 - volatilityDays, i + 1);
    const mean = recent.reduce((sum, value) => sum + value, 0) / volatilityDays;
    const variance = recent.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (volatilityDays - 1);
    return { date, trend: close / rows[i - trendDays][1] - 1, volatility: Math.sqrt(252 * variance) };
  });
}

function preceding(items, date, dayOf) {
  let first = 0;
  let end = items.length;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    if (dayOf(items[middle]) < date) first = middle + 1;
    else end = middle;
  }
  return items[first - 1];
}

function inFitPeriod(date) {
  return date >= factorPolicy.fitStart && date <= factorPolicy.fitEnd;
}

function quantile(values, percentile) {
  const sorted = values.sort((a, b) => a - b);
  const offset = (sorted.length - 1) * percentile;
  const lower = Math.floor(offset);
  return sorted[lower] + (sorted[Math.ceil(offset)] - sorted[lower]) * (offset - lower);
}

function premiumRate({ open, nav }) {
  return open / nav - 1;
}

function calibrateFactor(indexes, premiums) {
  const groups = {};
  const funds = {};
  for (const [index, rows] of Object.entries(indexes)) {
    const states = indexFactors(rows);
    // 12 月 31 日沪深收盘前，只能使用更早日期的美股收盘。
    const fit = states.filter(({ date }) => inFitPeriod(date) && date < factorPolicy.fitEnd);
    if (fit.length < 60) continue;
    groups[index] = {
      states,
      through: states.at(-1).date,
      fitCount: fit.length,
      volatilityLimit: quantile(fit.map(({ volatility }) => volatility), factorPolicy.volatilityPercentile),
    };
  }
  for (const code of Object.keys(factorGroups)) {
    const pairs = [...(premiums.get(code) ?? [])];
    const fit = pairs.filter(([date]) => inFitPeriod(date));
    if (fit.length < 60) continue;
    funds[code] = {
      pairs,
      fitCount: fit.length,
      fitFrom: fit[0][0],
      fitThrough: fit.at(-1)[0],
      premiumLimit: quantile(fit.map(([, pair]) => premiumRate(pair)), factorPolicy.premiumPercentile),
    };
  }
  return { groups, funds };
}

function openingDecision(group, date, baseAmount, calibration, premiums) {
  const { index, members } = group;
  const { states, volatilityLimit } = calibration.groups[index];
  const signal = preceding(states, date, (item) => item.date);
  const decision = { date, index, baseAmount, volatilityLimit };
  if (!signal || Date.parse(date) - Date.parse(signal.date) > 7 * dayMs) {
    return { ...decision, reason: "indexUnavailable" };
  }
  const trendReduced = signal.trend <= 0;
  const volatilityReduced = signal.volatility > volatilityLimit;
  const proposedAmount = baseAmount * factorPolicy.reducedFraction ** (Number(trendReduced) + Number(volatilityReduced));
  Object.assign(decision, { signal, trendReduced, volatilityReduced, proposedAmount });

  const candidates = members.map((code) => {
    const prior = preceding(calibration.funds[code].pairs, date, ([day]) => day);
    if (!prior || Date.parse(date) - Date.parse(prior[0]) > 14 * dayMs) return null;
    return { code, date: prior[0], premium: premiumRate(prior[1]) };
  });
  if (candidates.some((candidate) => candidate === null)) return { ...decision, reason: "priorPremiumUnavailable" };
  candidates.sort((a, b) => a.premium - b.premium || a.code.localeCompare(b.code));
  const { code } = candidates[0];
  const { premiumLimit } = calibration.funds[code];
  Object.assign(decision, { code, candidates, premiumLimit });
  // 择券已在读取当日开盘价前确定。限价未成交时不在同一开盘改买另一只。
  const pair = premiums.get(code).get(date);
  if (!pair) return { ...decision, reason: "openingUnavailable" };
  const limitPrice = pair.nav * (1 + premiumLimit);
  return {
    ...decision,
    open: pair.open,
    nav: pair.nav,
    navDate: pair.navDate,
    navUsableDate: pair.usableDay,
    limitPrice,
    openingPremium: premiumRate(pair),
    reason: pair.open <= limitPrice + 1e-12 ? "limitMet" : "aboveLimit",
  };
}

function planFactorBuys(codes, dates, budget, installments, calibration, premiums) {
  if (dates[0] < factorPolicy.sampleStart) return { unavailable: "beforeSample" };
  const unsupported = codes.filter((code) => !Object.hasOwn(factorGroups, code));
  if (unsupported.length) return { unavailable: "unsupported", unsupported };
  if (!calibration || codes.some((code) => !calibration.funds[code] || !calibration.groups[factorGroups[code]])) {
    return { unavailable: "missingInputs" };
  }

  const groups = [...new Set(codes.map((code) => factorGroups[code]))].map((index) => ({
    index,
    members: codes.filter((code) => factorGroups[code] === index),
  }));
  const decisions = [];
  const orders = new Map();
  for (const date of dates.slice(0, installments)) {
    const dailyOrders = new Map();
    for (const group of groups) {
      const base = budget * (group.members.length / codes.length) / installments;
      const decision = openingDecision(group, date, base, calibration, premiums);
      if (decision.reason === "limitMet") {
        dailyOrders.set(codes.indexOf(decision.code), { amount: decision.proposedAmount, decisionId: decisions.length });
      }
      decisions.push(decision);
    }
    orders.set(date, dailyOrders);
  }
  return {
    policy: factorPolicy,
    groups: groups.map(({ index, members }) => {
      const { volatilityLimit, fitCount, through } = calibration.groups[index];
      return { index, weight: members.length / codes.length, volatilityLimit, fitCount, through };
    }),
    funds: codes.map((code) => {
      const { premiumLimit, fitCount, fitFrom, fitThrough } = calibration.funds[code];
      return { code, premiumLimit, fitCount, fitFrom, fitThrough };
    }),
    decisions,
    orders,
  };
}

module.exports = { factorPolicy, factorGroups, readFactorIndexes, calibrateFactor, openingDecision, planFactorBuys };
