const { fredIndexCloses } = require("./_cn-etf-history-source");

const macroApi = "https://xoomar.com/api/markets/calendar";
const consensusFeed = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const earningsApi = "https://api.nasdaq.com/api/calendar/earnings";
const xoomarSource = { name: "XOOMAR", url: "https://xoomar.com/markets/api/calendar" };
const forexSource = { name: "Forex Factory", url: "https://www.forexfactory.com/calendar" };
const pceSource = { name: "BEA（FRED 转发）", url: "https://fred.stlouisfed.org/series/PCEPILFE" };
const nasdaqSource = { name: "Nasdaq 财报日历", url: "https://www.nasdaq.com/market-activity/earnings" };
const nasdaqHeaders = {
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
};
const newYork = "America/New_York";
const usDate = new Intl.DateTimeFormat("en-CA", { timeZone: newYork, dateStyle: "short" });
const usOffset = new Intl.DateTimeFormat("en", { timeZone: newYork, timeZoneName: "shortOffset" });
const dayMs = 86_400_000;
const stockSymbols = new Set(["NVDA", "MSFT", "AAPL", "AMZN", "GOOGL", "META", "AVGO", "AMD", "MU", "TSLA"]);

// 同场发布的不同指标按标题、发布机构和单位配对。
const macroIndicators = [
  { id: "cpi", name: "美国 CPI 同比", agency: "bls", release: /^CPI \(Consumer Price Index\)$/, title: "CPI y/y", unit: "%", sourceUnit: /^% y\/y, all items$/i },
  { id: "corePce", name: "美国核心 PCE 环比", agency: "bea", release: /^Personal Income and Outlays \(PCE\)$/, title: "Core PCE Price Index m/m", unit: "%" },
  { id: "payrolls", name: "美国非农新增就业", agency: "bls", release: /^Nonfarm Payrolls \(Employment Situation\)$/, title: "Non-Farm Employment Change", unit: "千人", sourceUnit: /thousands, monthly change/i },
  { id: "claims", name: "美国初请失业金", agency: "dol", release: /^Initial Jobless Claims$/, title: "Unemployment Claims", unit: "千人", sourceUnit: /thousands/i },
  { id: "gdp", name: "美国 GDP 第二次估计（环比年化）", agency: "bea", release: /^GDP \(Second Estimate\)/, title: "Prelim GDP q/q", unit: "%", sourceUnit: /^% q\/q annualized, real GDP$/i },
];

function shiftDate(day, offset) {
  return new Date(Date.parse(day) + offset * dayMs).toISOString().slice(0, 10);
}

function usDayStart(day) {
  const noon = new Date(day + "T12:00:00Z");
  const offset = usOffset.formatToParts(noon).find(({ type }) => type === "timeZoneName").value;
  return new Date(Date.parse(day) - Number(offset.slice(3)) * 3_600_000).toISOString();
}

function numberField(input, notation = "") {
  if (input == null || input === "") return null;
  let value = String(input).trim().replaceAll(",", "").replaceAll("−", "-");
  if (notation === "$") {
    value = value.replace(/^\((\$?\d+(?:\.\d+)?)\)$/, "-$1");
    if (!/^(?:[+-]?\$?\d+(?:\.\d+)?|\$[+-]\d+(?:\.\d+)?)$/.test(value)) return null;
    return Number(value.replace("$", ""));
  }
  const match = /^([+-]?\d+(?:\.\d+)?)([%K])?$/i.exec(value);
  if (!match) return null;
  if (notation && match[2]?.toUpperCase() !== notation) return null;
  if (!notation && match[2]) return null;
  return Number(match[1]);
}

async function jsonApi(url, headers, timeoutMs = 6_000) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const isoInstant = (value) => {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

function corePceChange(period, rows) {
  if (!/^[A-Za-z]+ \d{4}$/.test(period ?? "")) return null;
  const month = Date.parse(period.replace(" ", " 1, ") + " UTC");
  if (!Number.isFinite(month)) return null;
  const preceding = new Date(month);
  preceding.setUTCMonth(preceding.getUTCMonth() - 1);
  const current = rows.get(new Date(month).toISOString().slice(0, 10));
  const before = rows.get(preceding.toISOString().slice(0, 10));
  return current > 0 && before > 0 ? Math.round((current / before - 1) * 1000) / 10 : null;
}

function calendarMetadata(key, releaseAt) {
  const [type, id] = key.split(":");
  if (type === "earnings" && stockSymbols.has(id)) {
    return {
      key, type, indicator: id, label: `${id} 财报每股盈利`, unit: "美元/股",
      releaseAt, releaseDate: releaseAt.slice(0, 10),
      calendarSource: nasdaqSource, forecastSource: nasdaqSource, actualSource: nasdaqSource,
    };
  }
  const indicator = type === "macro" && macroIndicators.find((item) => item.id === id);
  if (!indicator) return null;
  return {
    key, type, indicator: id, label: indicator.name, unit: indicator.unit, releaseAt, releaseDate: null,
    calendarSource: xoomarSource, forecastSource: forexSource, actualSource: id === "corePce" ? pceSource : xoomarSource,
  };
}

function macroRows(releases, consensus, corePce, seenAt, forecastObservedAt = seenAt) {
  const forecastByReport = new Map();
  for (const item of consensus) {
    const date = isoInstant(item?.date);
    if (item?.country === "USD" && date && typeof item.title === "string") {
      const key = item.title + "/" + date;
      // 同时刻重复且预期冲突时留空，避免误配不同口径。
      forecastByReport.set(key, forecastByReport.has(key) && forecastByReport.get(key) !== item.forecast ? null : item.forecast);
    }
  }
  return releases.flatMap((row) => {
    const indicator = macroIndicators.find((x) => row?.source === x.agency && x.release.test(row.eventName));
    const releaseAt = isoInstant(row?.scheduledAt);
    if (!indicator || !releaseAt) return [];
    const isPce = indicator.id === "corePce";
    const print = isPce ? corePceChange(row.periodLabel, corePce) : numberField(row.actual);
    const forecast = print !== null && releaseAt > seenAt ? null :
      numberField(forecastByReport.get(indicator.title + "/" + releaseAt), indicator.unit === "%" ? "%" : "K");
    const actual = releaseAt <= seenAt && (isPce || indicator.sourceUnit.test(row.unit ?? "")) ? print : null;
    return [{
      ...calendarMetadata(`macro:${indicator.id}:${releaseAt}`, releaseAt),
      observedAt: seenAt, forecastObservedAt, forecast, actual,
    }];
  });
}

function earningsRows(rows, day, seenAt) {
  const releaseAt = usDayStart(day);
  return rows.flatMap((row) => {
    if (!stockSymbols.has(row?.symbol) || !/^[A-Z][a-z]{2}\/\d{4}$/.test(row.fiscalQuarterEnding ?? "")) return [];
    const print = numberField(row.eps, "$");
    const forecast = print !== null && releaseAt > seenAt ? null : numberField(row.epsForecast, "$");
    const actual = releaseAt <= seenAt ? print : null;
    const key = `earnings:${row.symbol}:${row.fiscalQuarterEnding}:${day}`;
    return [{ ...calendarMetadata(key, releaseAt), observedAt: seenAt, forecast, actual }];
  });
}

let calendarCache;
let consensusCache;
const earningsCache = new Map();

function weeklyConsensus(now) {
  if (consensusCache && now.getTime() - consensusCache.startedAt < 5 * 60_000) return consensusCache.request;
  const request = jsonApi(consensusFeed)
    .then((rows) => ({ rows, seenAt: new Date().toISOString() }));
  consensusCache = { startedAt: now.getTime(), request };
  return request;
}

async function earningsDay(day, today, now) {
  const cached = earningsCache.get(day);
  const maxAge = day < today ? 15 * 60_000 : 60_000;
  if (cached && now.getTime() - Date.parse(cached.seenAt) < maxAge) return cached.items;
  const result = await jsonApi(`${earningsApi}?date=${day}`, nasdaqHeaders);
  const data = result?.data;
  const responseDay = new Date(data?.asOf + " UTC");
  if (result?.status?.rCode !== 200 || !Number.isFinite(responseDay.getTime()) ||
      responseDay.toISOString().slice(0, 10) !== day || (data.rows != null && !Array.isArray(data.rows))) {
    throw new Error("Nasdaq 财报日期或数据格式不符");
  }
  const seenAt = new Date().toISOString();
  const items = earningsRows(data.rows ?? [], day, seenAt);
  earningsCache.set(day, { items, seenAt });
  return items;
}

async function recentEarnings(from, through, today, now) {
  const dates = [];
  for (let day = from; day <= through; day = shiftDate(day, 1)) {
    if (new Date(day).getUTCDay() % 6 !== 0) dates.push(day);
  }
  for (const day of earningsCache.keys()) if (day < from || day > through) earningsCache.delete(day);
  const items = [];
  let unavailable = 0;
  for (let i = 0; i < dates.length; i += 5) {
    const batch = dates.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map((day) => earningsDay(day, today, now)));
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") items.push(...result.value);
      else {
        unavailable += 1;
        items.push(...(earningsCache.get(batch[index])?.items ?? []));
      }
    }
  }
  return { items, unavailable };
}

async function loadCalendar(now) {
  const today = usDate.format(now);
  const from = shiftDate(today, -7);
  const through = shiftDate(today, 7);
  const [calendar, consensus, corePce, earnings] = await Promise.allSettled([
    jsonApi(macroApi, undefined, 10_000),
    weeklyConsensus(now),
    fredIndexCloses("PCEPILFE", shiftDate(today, -150), 5_000),
    recentEarnings(from, through, today, now),
  ]);
  const releases = calendar.value?.data;
  const expectations = consensus.value?.rows;
  const seenAt = new Date().toISOString();
  const unavailable = [];
  if (!Array.isArray(releases)) unavailable.push("XOOMAR 宏观日历");
  if (!Array.isArray(expectations)) unavailable.push("Forex Factory 预期");
  if (!corePce.value) unavailable.push("FRED 核心 PCE");
  if (!earnings.value || earnings.value.unavailable) unavailable.push("Nasdaq 部分财报日期");
  const macro = macroRows(
    Array.isArray(releases) ? releases : [],
    Array.isArray(expectations) ? expectations : [],
    new Map(corePce.value ?? []),
    seenAt,
    consensus.value?.seenAt,
  ).filter(({ releaseAt }) => releaseAt.slice(0, 10) >= from && releaseAt.slice(0, 10) <= through);
  const items = new Map([...macro, ...(earnings.value?.items ?? [])].map((item) => [item.key, item]));
  return { items: [...items.values()], unavailable };
}

function refreshCalendarSources(now) {
  if (calendarCache && now.getTime() - calendarCache.startedAt < 30_000) return calendarCache.request;
  const request = loadCalendar(now);
  calendarCache = { startedAt: now.getTime(), request };
  return request;
}

module.exports = { refreshCalendarSources, calendarMetadata, macroRows, earningsRows };
