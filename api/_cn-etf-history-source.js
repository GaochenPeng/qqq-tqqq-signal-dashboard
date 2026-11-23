const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const usableAfterSessions = 3;
const delayedNavSessions = 5;

async function get(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} 返回 HTTP ${response.status}`);
  return response;
}

async function unadjustedOpenLows(secid, from, through) {
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.search = new URLSearchParams({
    secid,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56",
    klt: "101",
    fqt: "0",
    beg: from.replaceAll("-", ""),
    end: through.replaceAll("-", ""),
    lmt: "10000",
  }).toString();
  const response = await get(url);
  const { data } = await response.json();
  if (data?.code !== secid.split(".")[1] || !Array.isArray(data.klines) || !data.klines.length) {
    throw new Error(`${secid} 缺少历史成交日线`);
  }
  const rows = new Map();
  let previous = "";
  for (const line of data.klines) {
    const [date, rawOpen, , , rawLow, rawVolume] = line.split(",");
    const open = Number(rawOpen);
    const low = Number(rawLow);
    const volume = Number(rawVolume);
    if (!dayPattern.test(date) || date <= previous || date > through ||
        !Number.isFinite(open) || open <= 0 || !Number.isFinite(volume) || volume < 0 ||
        (volume > 0 && (!Number.isFinite(low) || low <= 0 || low > open))) {
      throw new Error(`${secid} 历史日线无效 ${date}`);
    }
    previous = date;
    if (volume > 0) rows.set(date, { open, low });
  }
  return rows;
}

async function unadjustedBars(secid, from, through) {
  const rows = await unadjustedOpenLows(secid, from, through);
  return new Map(Array.from(rows, ([day, { open }]) => [day, open]));
}

async function disclosedNav(code) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
  const response = await get(url, { Referer: `https://fund.eastmoney.com/${code}.html` });
  const text = await response.text();
  const match = text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error(`${code} 缺少官方单位净值档案`);

  let previous = "";
  return JSON.parse(match[1]).map(({ x, y, unitMoney }) => {
    const date = new Date(x + 8 * 3600_000).toISOString().slice(0, 10);
    if (!dayPattern.test(date) || date <= previous || !Number.isFinite(y) || y <= 0) {
      throw new Error(`${code} 净值数据无效 ${date}`);
    }
    previous = date;
    const action = Boolean(unitMoney && !/^0(?:\.0+)?$/.test(String(unitMoney)));
    return { date, nav: y, action };
  });
}

function* usableNavs(sessions, netValues, calendar, delay = usableAfterSessions) {
  const tradingDates = new Set(calendar);
  let calendarIndex = 0;
  const available = [];
  for (const row of netValues) {
    while (calendarIndex < calendar.length && calendar[calendarIndex] < row.date) calendarIndex += 1;
    const usableDay = calendar[calendarIndex + delay];
    if (!usableDay) break;
    available.push({ ...row, usableDay });
  }

  const actionDates = netValues.filter(({ action }) => action).map(({ date }) => date);
  let nextNav = 0;
  let nextAction = 0;
  let current;
  let latestAction = "";
  for (const date of sessions) {
    if (!tradingDates.has(date)) continue;
    while (nextNav < available.length && available[nextNav].usableDay <= date) {
      current = available[nextNav];
      nextNav += 1;
    }
    while (nextAction < actionDates.length && actionDates[nextAction] <= date) {
      latestAction = actionDates[nextAction];
      nextAction += 1;
    }
    // 份额折算或分红后，等到新价格口径下的净值可用再比较。
    if (current && current.date >= latestAction) {
      yield [date, { nav: current.nav, navDate: current.date, usableDay: current.usableDay }];
    }
  }
}

function pairInputs(sessions, openingPrices, netValues, calendar, delay = usableAfterSessions) {
  const days = Array.from(sessions, ([date]) => date).filter((date) => openingPrices.has(date));
  return Array.from(usableNavs(days, netValues, calendar, delay), ([date, { nav, navDate, usableDay }]) =>
    [date, openingPrices.get(date), navDate, nav, usableDay]);
}

const series = { NDX: "NASDAQ100", NBI: "NASDAQNBI" };

async function fredIndexCloses(seriesId, from = "2022-01-01", timeoutMs = 15_000) {
  const source = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv");
  source.search = new URLSearchParams({ id: seriesId, cosd: from });
  const response = await fetch(source, { headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`FRED ${seriesId} 返回 HTTP ${response.status}`);
  const csv = await response.text();
  const [columns, ...lines] = csv.trim().split(/\r?\n/);
  if (columns !== `observation_date,${seriesId}` && columns !== `DATE,${seriesId}`) {
    throw new Error(`FRED ${seriesId} 指数列不完整`);
  }
  const rows = [];
  let previous = "";
  for (const line of lines) {
    const [date, raw, extra] = line.split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= previous || extra !== undefined) {
      throw new Error(`FRED 指数日期无效 ${date}`);
    }
    previous = date;
    if (raw === "" || raw === ".") continue;
    const close = Number(raw);
    if (!Number.isFinite(close) || close <= 0) throw new Error(`${seriesId} 收盘价无效 ${date}`);
    rows.push([date, close]);
  }
  return rows;
}

async function nasdaqIndexCloses(symbol, from, through) {
  const url = new URL(`https://api.nasdaq.com/api/quote/${symbol}/historical`);
  url.search = new URLSearchParams({ assetclass: "index", fromdate: from, todate: through, limit: "400" });
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.nasdaq.com/",
      Origin: "https://www.nasdaq.com",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Nasdaq ${symbol} 返回 HTTP ${response.status}`);
  const { data } = await response.json();
  const rows = data?.tradesTable?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${symbol} 缺少 Nasdaq 收盘历史`);
  const points = rows.map(({ date, close }) => {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
    const day = match ? `${match[3]}-${match[1]}-${match[2]}` : "";
    const value = Number(String(close).replaceAll(",", ""));
    if (day < from || day > through || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${symbol} 的 Nasdaq 收盘数据无效`);
    }
    return [day, value];
  }).sort(([a], [b]) => a.localeCompare(b));
  if (new Set(points.map(([date]) => date)).size !== points.length) throw new Error(`${symbol} 日线日期重复`);
  return points;
}

module.exports = { unadjustedBars, unadjustedOpenLows, disclosedNav, pairInputs, usableNavs, usableAfterSessions,
  delayedNavSessions, series, fredIndexCloses, nasdaqIndexCloses };
