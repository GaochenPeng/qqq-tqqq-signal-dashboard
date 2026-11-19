const { sendJson } = require("./_lib");
const { cnEtfMarket } = require("./_cn-etf-market");
const { archiveEtfQuotes } = require("./_etf-forecast-store");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { error: "请使用 GET 刷新行情" }, { cache: false });
  }
  const market = await cnEtfMarket();
  try {
    await archiveEtfQuotes(market);
  } catch (error) {
    console.warn("ETF 行情写入 PostgreSQL 失败", error.code ?? "unknown");
  }
  sendJson(res, 200, market, { cache: false });
};
