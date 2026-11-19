const { sendJson } = require("./_lib");
const { cnEtfBacktest } = require("./_cn-etf-backtest");

module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { error: "请使用 GET 请求回测" }, { cache: false });
  }
  try {
    sendJson(res, 200, cnEtfBacktest(req.query || {}), { cache: false });
  } catch (error) {
    const status = error.statusCode ?? 500;
    if (status === 500) console.error(error);
    sendJson(res, status, { error: status === 500 ? "场内 ETF 回测暂时不可用" : error.message }, { cache: false });
  }
};
