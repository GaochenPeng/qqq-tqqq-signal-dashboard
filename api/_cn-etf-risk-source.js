const { fredIndexCloses, nasdaqIndexCloses } = require("./_cn-etf-history-source");

function parseUsCloses(csv, closeColumn, from, through) {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const columns = header.split(",").map((field) => field.replaceAll('"', "").trim());
  const closeIndex = columns.indexOf(closeColumn);
  if (columns[0]?.toLowerCase() !== "date" || closeIndex < 1) throw new Error("收盘数据列不完整");
  const rows = new Map();
  for (const line of lines) {
    const fields = line.split(",");
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(fields[0]?.replaceAll('"', ""));
    if (!match) throw new Error("收盘日期格式不正确");
    const [, m, d, y] = match;
    const day = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (day < from || day > through) continue;
    const raw = fields[closeIndex]?.trim();
    if (!raw || raw === "N/A") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || (closeColumn === "CLOSE" && value <= 0) || rows.has(day)) {
      throw new Error("收盘数据无效 " + day);
    }
    rows.set(day, value);
  }
  return [...rows].sort(([a], [b]) => a.localeCompare(b));
}

async function publicCsv(url, closeColumn, from, through) {
  const response = await fetch(url, {
    headers: { Accept: "text/csv" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseUsCloses(await response.text(), closeColumn, from, through);
}

async function stockCloses(symbol, fredId, from, through) {
  try {
    const rows = await nasdaqIndexCloses(symbol, from, through);
    return { rows, source: "Nasdaq", url: `https://indexes.nasdaq.com/Index/Overview/${symbol}` };
  } catch {
    const rows = await fredIndexCloses(fredId, from, 5_000);
    return { rows: rows.filter(([day]) => day <= through), source: "Nasdaq（FRED 转发）", url: `https://fred.stlouisfed.org/series/${fredId}` };
  }
}

async function vixCloses(from, through) {
  try {
    const rows = await publicCsv("https://cdn-api.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv", "CLOSE", from, through);
    return { rows, source: "Cboe", url: "https://www.cboe.com/tradable_products/vix/vix_historical_data/" };
  } catch {
    const rows = await fredIndexCloses("VIXCLS", from, 5_000);
    return { rows: rows.filter(([day]) => day <= through), source: "Cboe（FRED 转发）", url: "https://fred.stlouisfed.org/series/VIXCLS" };
  }
}

async function treasuryCloses(from, through) {
  const years = new Set([from.slice(0, 4), through.slice(0, 4)]);
  const rows = await Promise.all([...years].map((year) => {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
    return publicCsv(url, "10 Yr", from, through);
  }));
  return {
    rows: rows.flat(),
    source: "美国财政部",
    url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve",
  };
}

async function refreshRiskCloses(from, through) {
  const sources = {
    equalWeight: stockCloses("NDXE", "NASDAQNDXE", from, through),
    semiconductor: stockCloses("SOX", "NASDAQSOX", from, through),
    vix: vixCloses(from, through),
    treasury: treasuryCloses(from, through),
  };
  const entries = await Promise.all(Object.entries(sources).map(async ([key, promise]) => {
    try {
      return [key, await promise];
    } catch (error) {
      console.warn(`刷新 ETF 因子失败 ${key}`, error.message);
      return [key, null];
    }
  }));
  return Object.fromEntries(entries);
}

module.exports = { parseUsCloses, refreshRiskCloses };
