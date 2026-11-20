const fs = require("node:fs");
const path = require("node:path");
const {
  applySignalQqqAction,
  buildStates,
  buyQQQ,
  capeSeriesForBacktest,
  createSignalMachine,
  emptyPortfolio,
  loadSnapshotData,
  signalMachineClose,
} = require("./_lib");
const { fundTerms } = require("./_cn-etf-market");
const { factorPolicy, readFactorIndexes, calibrateFactor, planFactorBuys } = require("./_cn-etf-factor");

const defaultBudget = 1_000_000;
const maxBudget = Math.floor(Number.MAX_SAFE_INTEGER / 100);
const costBps = 5;
const { installments } = factorPolicy;
const defaultCodes = ["159660", "513110", "159941", "513290"];
const catalog = [
  ...fundTerms.map(({ code, manager }) => ({ code, manager, index: "纳斯达克100" })),
  { code: "513290", manager: "汇添富", index: "纳斯达克生物科技" },
];
const historyFile = path.join(__dirname, "../data/cn-etf-history.json");
let historyCache;
const premiumFile = path.join(__dirname, "../data/cn-etf-premium-history.json");
const premiumLimits = [1, 3, 5, 8];
let premiumCache;

function loadHistories() {
  if (!fs.existsSync(historyFile)) {
    throw Object.assign(new Error("本地日线待生成，可在 20 日预测板块点击更新，或运行日线更新命令。"), { statusCode: 503 });
  }
  const mtimeMs = fs.statSync(historyFile).mtimeMs;
  if (historyCache?.mtimeMs === mtimeMs) return historyCache.funds;
  const raw = JSON.parse(fs.readFileSync(historyFile, "utf8")).funds;
  const funds = new Map(catalog.map(({ code }) => {
    const rows = raw?.[code];
    if (!Array.isArray(rows) || rows.length < 2) throw new Error(`${code} 缺少历史日线`);
    const points = new Map();
    let previous = "";
    for (const [day, open, close] of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day <= previous ||
          !Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) {
        throw new Error(`${code} 历史日线有误 ${day}`);
      }
      points.set(day, { open, close });
      previous = day;
    }
    return [code, { points, start: rows[0][0], end: rows.at(-1)[0] }];
  }));
  historyCache = { mtimeMs, funds };
  return funds;
}

function loadPremiums() {
  let mtimeMs;
  try {
    ({ mtimeMs } = fs.statSync(premiumFile));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  if (premiumCache?.mtimeMs === mtimeMs) return premiumCache.funds;
  const { funds: raw } = JSON.parse(fs.readFileSync(premiumFile, "utf8"));
  const funds = new Map(Object.entries(raw).map(([code, rows]) => {
    const points = new Map();
    let latestDay = "";
    for (const [day, open, navDate, nav, usableDay] of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day <= latestDay ||
          !Number.isFinite(open) || open <= 0 || !Number.isFinite(nav) || nav <= 0 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(navDate) || !/^\d{4}-\d{2}-\d{2}$/.test(usableDay) ||
          navDate >= usableDay || usableDay > day) {
        throw new Error(`${code} 的折溢价历史无效 ${day}`);
      }
      points.set(day, { open, nav, navDate, usableDay });
      latestDay = day;
    }
    return [code, points];
  }));
  premiumCache = { mtimeMs, funds };
  return funds;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function queryDate(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`${label}应使用 YYYY-MM-DD`);
  }
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw badRequest(`${label}无效`);
  }
  return value;
}

function queryBudget(value) {
  if (value === undefined) return defaultBudget;
  const amount = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxBudget) {
    throw badRequest("初始资金须填写有效的人民币整数金额，至少 1 元");
  }
  return amount;
}

function buildSignalSchedule(sessions, nasdaq, states, availableThrough) {
  const machine = createSignalMachine();
  const schedule = new Map();
  let sessionIndex = 0;
  for (const [index, { date }] of nasdaq.entries()) {
    if (!states[index] || date < sessions[0]) continue;
    if (date > availableThrough) break;
    // 美东收盘对应北京时间的次日，按严格晚于信号日期的首个共同开盘执行。
    while (sessionIndex < sessions.length && sessions[sessionIndex] <= date) sessionIndex += 1;
    if (sessionIndex === sessions.length) break;
    const pending = signalMachineClose(machine, states[index], date);
    if (pending) schedule.set(sessions[sessionIndex], pending);
  }
  return schedule;
}

function simulate(id, sessions, histories, { budget = defaultBudget, schedule, premium, orders } = {}) {
  const allocation = budget / histories.length;
  const perMonth = allocation / installments;
  const useReserve = id === "signal" || Boolean(orders);
  let reserve = useReserve ? budget : 0;
  const positions = histories.map(() => {
    const portfolio = emptyPortfolio(costBps);
    if (!useReserve) portfolio.cash = allocation;
    return portfolio;
  });

  let lastMonth = "";
  let monthCount = 0;
  let peak = budget;
  let maxDrawdown = 0;
  let buyCount = 0;
  const purchases = [];
  const orderFills = [];

  const equity = sessions.map((date, dayIndex) => {
    const month = date.slice(0, 7);
    const newMonth = month !== lastMonth;
    const trancheDue = newMonth && monthCount < installments;
    if (newMonth) {
      monthCount += 1;
      lastMonth = month;
    }

    const dailyOrders = orders?.get(date);
    let value = 0;
    positions.forEach((portfolio, index) => {
      const { open, close } = histories[index].get(date);
      const beforeShares = portfolio.qqq;
      if (id === "once" && dayIndex === 0) buyQQQ(portfolio, allocation, open);
      if (id === "monthly" && trancheDue) buyQQQ(portfolio, perMonth, open);
      if (id === "signal") {
        if (trancheDue) {
          const released = Math.min(perMonth, reserve);
          portfolio.cash += released;
          reserve -= released;
        }
        const due = schedule?.get(date);
        if (due) applySignalQqqAction(portfolio, due.decision, { qqq: open }, perMonth);
      }
      if (premium && newMonth && portfolio.cash > 0) {
        const inputs = premium.points[index].get(date);
        // 已知单位净值决定盘前限价，成交时只读取当日未复权开盘价。
        if (inputs && inputs.open <= inputs.nav * (1 + premium.limit / 100) + 1e-12) {
          buyQQQ(portfolio, portfolio.cash, open);
          purchases.push({ date, code: premium.codes[index], ...inputs });
        }
      }
      const order = dailyOrders?.get(index);
      if (order) {
        const amount = Math.min(order.amount, reserve);
        const beforeFees = portfolio.fees;
        portfolio.cash += amount;
        reserve -= amount;
        buyQQQ(portfolio, amount, open);
        if (portfolio.qqq > beforeShares) orderFills.push({ decisionId: order.decisionId, amount, fee: portfolio.fees - beforeFees });
      }
      if (portfolio.qqq > beforeShares) buyCount += 1;
      value += portfolio.cash + portfolio.qqq * close;
    });
    value += reserve;
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, 1 - value / peak);
    return Math.round(value * 100) / 100;
  });

  const finalValue = equity.at(-1);
  const cash = positions.reduce((sum, wallet) => sum + wallet.cash, reserve);
  const fees = positions.reduce((sum, wallet) => sum + wallet.fees, 0);
  const investedRatio = id === "signal" ? null : Math.max(0, Math.min(1, 1 - cash / budget));
  const result = { id, finalValue, totalReturn: finalValue / budget - 1, maxDrawdown, cash, buyCount, fees, investedRatio, equity };
  if (premium) return { ...result, limit: premium.limit, purchases };
  if (orders) return { ...result, orderFills };
  return result;
}

function monthOpenings(sessions) {
  return sessions.filter((day, index) => index === 0 || day.slice(0, 7) !== sessions[index - 1].slice(0, 7));
}

function premiumBacktests(codes, sessions, histories, premiums, budget) {
  const unsupported = codes.filter((code) => !premiums.has(code));
  if (unsupported.length) return { unsupported, observations: 0, checkpoints: 0, strategies: [] };
  const monthStarts = monthOpenings(sessions);
  const points = codes.map((code) => premiums.get(code));
  const observations = points.reduce((count, days) =>
    count + monthStarts.filter((day) => days.has(day)).length, 0);
  const checkpoints = monthStarts.length * codes.length;
  const strategies = observations ? premiumLimits.map((limit) =>
    simulate("premium", sessions, histories, { budget, premium: { codes, points, limit } })) : [];
  return { unsupported, observations, checkpoints, strategies };
}

function factorBacktest(codes, sessions, histories, { budget, calibration, premiums }) {
  const { orders, ...plan } = planFactorBuys(codes, monthOpenings(sessions), budget, installments, calibration, premiums);
  if (!orders) return plan;
  const { orderFills, ...strategy } = simulate("factor", sessions, histories, { budget, orders });
  const byDecision = new Map(orderFills.map(({ decisionId, ...fill }) => [decisionId, fill]));
  return {
    ...plan,
    strategy,
    decisions: plan.decisions.map((decision, index) => ({ ...decision, ...(byDecision.get(index) ?? { amount: 0, fee: 0 }) })),
  };
}

function backtestView(codes, sessions, histories, inputs) {
  const { premiums, nasdaq, states, signalThrough, budget } = inputs;
  const schedule = buildSignalSchedule(sessions, nasdaq, states, signalThrough);
  const signalActions = {};
  for (const { decision } of schedule.values()) {
    signalActions[decision.key] = (signalActions[decision.key] ?? 0) + 1;
  }
  return {
    sessions,
    signalActions,
    strategies: ["once", "monthly", "signal"].map((id) => simulate(id, sessions, histories, { budget, schedule })),
    premium: premiumBacktests(codes, sessions, histories, premiums, budget),
    factor: factorBacktest(codes, sessions, histories, inputs),
  };
}

function cnEtfBacktest({ codes, start, end, sample, budget: budgetQuery } = {}) {
  const budget = queryBudget(budgetQuery);
  if (sample !== undefined && sample !== "out") throw badRequest("样本范围无效");
  if (codes !== undefined && (typeof codes !== "string" || codes.length > 100)) {
    throw badRequest("请选择有效的场内 ETF");
  }
  const histories = loadHistories();
  const selected = codes === undefined ? defaultCodes : Array.from(new Set(codes.split(",")));
  if (!selected.length || selected.some((code) => !histories.has(code))) throw badRequest("请选择有效的场内 ETF");
  const points = selected.map((code) => histories.get(code).points);
  const common = Array.from(points[0].keys()).filter((date) => points.every((series) => series.has(date)));
  if (common.length < 2) throw badRequest("所选 ETF 的共同交易日不足");
  const endDate = queryDate(end, "结束日期") ?? common.at(-1);
  const defaultStart = sample === "out" ? factorPolicy.sampleStart
    : new Date(Date.parse(endDate) - 365 * 86400_000).toISOString().slice(0, 10);
  const startDate = queryDate(start, "开始日期") ?? (defaultStart < common[0] ? common[0] : defaultStart);
  if (startDate > endDate) throw badRequest("开始日期应早于结束日期");
  const sessions = common.filter((day) => day >= startDate && day <= endDate);
  if (sessions.length < 2) throw badRequest("所选区间需要至少两个共同交易日");

  const { nasdaq, vix, capeLatestFirst } = loadSnapshotData();
  const signalThrough = [nasdaq.at(-1).date, vix.at(-1).date].sort()[0];
  const capeChrono = capeSeriesForBacktest(capeLatestFirst).reverse();
  const states = buildStates(nasdaq, nasdaq, vix, capeChrono);
  const premiums = loadPremiums();
  const indexes = sessions[0] >= factorPolicy.sampleStart ? readFactorIndexes() : null;
  const calibration = indexes ? calibrateFactor(indexes, premiums) : null;
  const inputs = { premiums, nasdaq, states, signalThrough, budget, calibration };
  const combined = backtestView(selected, sessions, points, inputs);
  const byFund = Object.fromEntries(selected.map((code, index) => {
    if (selected.length === 1) return [code, combined];
    const dates = [...points[index].keys()].filter((day) => day >= startDate && day <= endDate);
    const result = backtestView([code], dates, [points[index]], inputs);
    return [code, result];
  }));

  return {
    budget,
    costBps,
    funds: catalog.map((fund) => {
      const { start, end } = histories.get(fund.code);
      return { ...fund, start, end };
    }),
    selected,
    available: { start: common[0], end: common.at(-1) },
    factorSampleStart: factorPolicy.sampleStart,
    signalThrough,
    ...combined,
    byFund,
  };
}

module.exports = { cnEtfBacktest, buildSignalSchedule, simulate, loadPremiums, queryDate, queryBudget };
