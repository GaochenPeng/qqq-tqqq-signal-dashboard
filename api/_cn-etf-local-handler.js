const { sendJson } = require("./_lib");
const { queryDate, queryBudget } = require("./_cn-etf-backtest");
const { factorGroups } = require("./_cn-etf-factor");
const { chinaClock, todayDecision } = require("./_cn-etf-today");
const { refreshTodayInputs } = require("./_cn-etf-today-source");
const { readPlan, savePlan, addPlanTrade } = require("./_cn-etf-plan-store");

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function readJson(req) {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw httpError(415, "请用页面提交投资记录。");
  }
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw httpError(413, "录入内容过长。");
  }
  try {
    const value = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // 统一提示表单内容无效。
  }
  throw httpError(400, "录入内容无效。");
}

function parsePlan(payload) {
  if (payload.budget === undefined || typeof payload.startMonth !== "string" || !/^\d{4}-\d{2}$/.test(payload.startMonth)) {
    throw httpError(400, "请填写本金和计划起始月份。");
  }
  queryDate(payload.startMonth + "-01", "起始月份");
  return { budget: queryBudget(payload.budget), startMonth: payload.startMonth };
}

function parseTrade(payload, today) {
  const { key, code, date, side, shares, amountCents } = payload;
  if (typeof key !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key) ||
      typeof code !== "string" || !Object.hasOwn(factorGroups, code) || !["buy", "sell"].includes(side) ||
      !Number.isSafeInteger(shares) || shares <= 0 || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw httpError(400, "请检查基金、买卖方向、成交份额和金额。");
  }
  if (date === undefined || queryDate(date, "成交日期") > today) throw httpError(400, "请选择已经发生的成交日期。");
  return { key: key.toLowerCase(), code, date, side, shares, amountCents };
}

function verifyLocalOrigin(req) {
  const host = req.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    throw httpError(403, "请从本机 ETF 面板访问投资计划。");
  }
}

async function localEtfHandler(req, res, route) {
  try {
    verifyLocalOrigin(req);
    if (route === "today" && req.method === "GET") {
      const budget = queryBudget(req.query?.budget);
      const now = new Date();
      const [inputs, planState] = await Promise.all([
        refreshTodayInputs(chinaClock(now).date, now),
        readPlan().catch((error) => {
          console.warn("读取本机投资计划失败", error.code ?? "unknown");
          return { enabled: true, plan: null, trades: [], error: "本机投资计划暂时读不到，已暂停加仓判断。" };
        }),
      ]);
      return sendJson(res, 200, todayDecision({ now: new Date(), budget, planState, ...inputs }), { cache: false });
    }
    if (route === "plan" && req.method === "POST") {
      return sendJson(res, 200, await savePlan(parsePlan(await readJson(req))), { cache: false });
    }
    if (route === "plan" && req.method === "GET") {
      return sendJson(res, 200, await readPlan(), { cache: false });
    }
    if (route === "trade" && req.method === "POST") {
      return sendJson(res, 200, await addPlanTrade(parseTrade(await readJson(req), chinaClock().date)), { cache: false });
    }
    res.setHeader("Allow", { today: "GET", plan: "GET, POST", trade: "POST" }[route]);
    return sendJson(res, 405, { error: "操作方式有误。" }, { cache: false });
  } catch (error) {
    const status = error.statusCode ?? 500;
    if (status === 500) console.warn("本机 ETF 计划接口失败", error.code ?? error.message);
    return sendJson(res, status, { error: status === 500 ? "本机投资计划暂时不可用，请刷新重试。" : error.message }, { cache: false });
  }
}

module.exports = localEtfHandler;
