const { sendJson } = require("./_lib");
const { forecastStoreEnabled } = require("./_etf-forecast-store");
const { beginForecast, currentForecast } = require("./_etf-forecast");

module.exports = async function handler(req, res) {
  if (!forecastStoreEnabled()) return sendJson(res, 200, { enabled: false }, { cache: false });
  try {
    if (req.method === "POST") {
      if (req.headers["sec-fetch-site"] === "cross-site") {
        return sendJson(res, 403, { error: "请从本地项目页面发起更新" }, { cache: false });
      }
      beginForecast();
      return sendJson(res, 202, { enabled: true, running: true }, { cache: false });
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, POST");
      return sendJson(res, 405, { error: "预测接口支持 GET 或 POST" }, { cache: false });
    }
    sendJson(res, 200, { enabled: true, ...await currentForecast() }, { cache: false });
  } catch (error) {
    console.warn("本地预测读取失败", error.code ?? "unknown");
    sendJson(res, 503, { error: "本地预测库暂时不可用" }, { cache: false });
  }
};
