const snapshot = require("../data/cn-etf-snapshot.json");

const fundTerms = snapshot.funds.map(({ code, manager, managementFeeRate, custodyFeeRate }) => ({
  code, manager, managementFeeRate, custodyFeeRate,
}));
const symbols = fundTerms.map(({ code }) => `${code.startsWith("15") ? "sz" : "sh"}${code}`);
const quoteUrl = `https://qt.gtimg.cn/q=${[...symbols, "sh513290"].join(",")}`;
let lastGood = {
  asOf: snapshot.asOf,
  budgetCny: snapshot.budgetCny,
  funds: snapshot.funds.map((fund) => ({ ...fund, quoteAt: fund.quoteAt ?? snapshot.asOf })),
};
let pending;

function quoteTime(value) {
  if (!/^\d{14}$/.test(value)) throw new Error("行情时间格式有误");
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`;
  if (!Number.isFinite(Date.parse(iso))) throw new Error("行情时间无效");
  return iso;
}

function parseQuoteBatch(text) {
  const received = new Map();
  for (const match of text.matchAll(/v_(?:sz|sh)\d{6}="([^"]+)"/g)) {
    const fields = match[1].split("~");
    const code = fields[2];
    if (received.has(code)) throw new Error(`${code} 行情重复`);
    received.set(code, fields);
  }

  const normalize = (fund) => {
    const fields = received.get(fund.code);
    if (!fields || fields[61] !== "ETF") throw new Error(`缺少 ${fund.code} 的 ETF 行情`);
    const lastPrice = Number(fields[3]);
    const iopv = Number(fields[78]);
    const premium = lastPrice / iopv - 1;
    const reported = fields[77]?.trim();
    const reportedPremium = reported ? Number(reported) / 100 : null;
    if (!(lastPrice > 0) || !Number.isFinite(lastPrice)) throw new Error(`${fund.code} 的场内价无效`);
    if (!(iopv > 0) || !Number.isFinite(iopv)) {
      return { ...fund, lastPrice, iopv: null, quoteAt: quoteTime(fields[30]), asks: [] };
    }
    if (Number.isFinite(reportedPremium) && Math.abs(premium - reportedPremium) > 0.0002) {
      throw new Error(`${fund.code} 的参考净值与行情溢价不一致`);
    }
    const asks = [19, 21, 23, 25, 27].map((index) => ({
      price: Number(fields[index]),
      lots: Number(fields[index + 1]),
    })).filter(({ price, lots }) => Number.isFinite(price) && price > 0 && Number.isSafeInteger(lots) && lots > 0);
    if (asks.some(({ price }, index) => index > 0 && price < asks[index - 1].price)) {
      throw new Error(`${fund.code} 卖盘档位顺序无效`);
    }

    return { ...fund, lastPrice, iopv, quoteAt: quoteTime(fields[30]), asks };
  };

  const funds = fundTerms.map(normalize);
  let forecastQuote;
  if (received.has("513290")) {
    try {
      forecastQuote = normalize({ code: "513290", manager: "汇添富" });
    } catch (error) {
      console.warn("513290 行情暂不可存档", error.message);
    }
  }
  const asOf = funds.map(({ quoteAt }) => quoteAt).sort().at(-1);
  return { asOf, budgetCny: snapshot.budgetCny, funds, forecastQuote };
}

async function refreshQuotes() {
  try {
    const response = await fetch(quoteUrl, {
      headers: { Referer: "https://gu.qq.com/", "Cache-Control": "no-cache" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`行情源返回 HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const current = parseQuoteBatch(new TextDecoder("gb18030").decode(buffer));
    const observedAt = Date.parse(current.asOf);
    if (observedAt > Date.now() + 60_000 || observedAt < Date.parse(lastGood.asOf)) {
      throw new Error("行情时间超前或早于最近一次有效快照");
    }
    lastGood = current;
    return { ...current, mode: "upstream", source: "腾讯行情" };
  } catch (error) {
    console.warn(`场内 ETF 行情刷新失败 ${error.message}`);
    return { ...lastGood, mode: "snapshot", source: "腾讯行情" };
  }
}

function cnEtfMarket() {
  // 同时到达的刷新共享一次请求，下一次点击会重新向行情源请求。
  if (!pending) {
    pending = refreshQuotes().finally(() => { pending = undefined; });
  }
  return pending;
}

module.exports = { cnEtfMarket, parseQuoteBatch, fundTerms };
