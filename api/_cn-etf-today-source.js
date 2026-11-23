const { cnEtfMarket } = require("./_cn-etf-market");
const { loadPremiums } = require("./_cn-etf-backtest");
const { readFactorIndexes, factorGroups } = require("./_cn-etf-factor");
const { unadjustedBars, disclosedNav, usableNavs, series, fredIndexCloses, nasdaqIndexCloses } = require("./_cn-etf-history-source");
const { completedUsThrough } = require("./_cn-etf-risk");
const { refreshRiskCloses } = require("./_cn-etf-risk-source");
const { refreshEvents } = require("./_cn-etf-event-source");

const codes = Object.keys(factorGroups);
const dayMs = 86_400_000;
let pending;

function shiftDate(day, days) {
  return new Date(Date.parse(day) + days * dayMs).toISOString().slice(0, 10);
}

async function refreshIndex(symbol, saved, through) {
  const prior = saved.filter(([day]) => day <= through);
  const oldestRefresh = shiftDate(through, -300);
  let baseline = prior;
  if (!prior.length || prior.at(-1)[0] < oldestRefresh) {
    baseline = await fredIndexCloses(series[symbol], undefined, 5_000)
      .then((rows) => rows.filter(([day]) => day <= through), () => prior);
  }
  const from = baseline.length ? shiftDate(baseline.at(-1)[0], -14) : oldestRefresh;
  try {
    const current = await nasdaqIndexCloses(symbol, from, through);
    const merged = new Map(baseline);
    for (const [day, close] of current) merged.set(day, close);
    const rows = [...merged].sort(([a], [b]) => a.localeCompare(b));
    const fresh = current.at(-1)[0] === rows.at(-1)[0] && rows.at(-1)[0] >= shiftDate(through, -5);
    return { rows, source: "Nasdaq", fresh };
  } catch {
    try {
      const rows = (await fredIndexCloses(series[symbol], undefined, 5_000)).filter(([day]) => day <= through);
      let lastWeekday = through;
      while ([0, 6].includes(new Date(lastWeekday).getUTCDay())) lastWeekday = shiftDate(lastWeekday, -1);
      if (rows.length && (!baseline.length || rows.at(-1)[0] >= baseline.at(-1)[0])) {
        return { rows, source: "FRED", fresh: rows.at(-1)[0] === lastWeekday };
      }
    } catch {
      // 源暂不可用时，只保留带日期的已知收盘。
    }
    return { rows: baseline, source: "本地快照", fresh: false };
  }
}

async function refreshPremiums(date) {
  const monthStart = date.slice(0, 7) + "-01";
  const [calendarBars, recent] = await Promise.all([
    unadjustedBars("1.000001", shiftDate(monthStart, -21), date),
    Promise.allSettled(codes.map(disclosedNav)),
  ]);
  const calendar = [...calendarBars.keys()];
  const navs = new Map();
  for (const [i, result] of recent.entries()) {
    if (result.status === "rejected") continue;
    const [latest] = usableNavs([date], result.value, calendar);
    const nav = latest?.[1];
    if (nav && nav.navDate >= shiftDate(date, -14)) navs.set(codes[i], nav);
  }
  return { calendar, navs, premiums: loadPremiums() };
}

async function marketInputs(date, through, now) {
  const saved = readFactorIndexes() ?? {};
  const [market, history, closes, feeds, ...indexResults] = await Promise.allSettled([
    cnEtfMarket(),
    refreshPremiums(date),
    refreshRiskCloses(shiftDate(through, -14), through),
    refreshEvents(now),
    ...Object.keys(series).map(async (symbol) => [
      symbol,
      await refreshIndex(symbol, saved[symbol] ?? [], through),
    ]),
  ]);
  const indexes = Object.fromEntries(indexResults.filter((item) => item.status === "fulfilled").map((item) => item.value));
  return {
    market: market.value ?? null,
    history: history.value ?? { calendar: [], navs: new Map(), premiums: loadPremiums() },
    indexes,
    riskInputs: { closes: closes.value, feeds: feeds.value },
  };
}

function refreshTodayInputs(date, now = new Date()) {
  const through = completedUsThrough(now);
  const key = date + "/" + through;
  if (pending?.key === key) return pending.promise;
  const request = { key };
  request.promise = marketInputs(date, through, now).finally(() => {
    if (pending === request) pending = undefined;
  });
  pending = request;
  return request.promise;
}

module.exports = { refreshTodayInputs, shiftDate };
