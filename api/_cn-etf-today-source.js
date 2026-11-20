const { cnEtfMarket } = require("./_cn-etf-market");
const { loadPremiums } = require("./_cn-etf-backtest");
const { readFactorIndexes, factorGroups } = require("./_cn-etf-factor");
const { unadjustedBars, disclosedNav, pairInputs, series, fredIndexCloses, nasdaqIndexCloses } = require("./_cn-etf-history-source");

const codes = Object.keys(factorGroups);
const dayMs = 86_400_000;
let pending;

function shiftDate(day, days) {
  return new Date(Date.parse(day) + days * dayMs).toISOString().slice(0, 10);
}

async function refreshIndex(symbol, saved, date) {
  const through = shiftDate(date, -1);
  const prior = saved.filter(([day]) => day <= through);
  const oldestRefresh = shiftDate(date, -300);
  let baseline = prior;
  if (!prior.length || prior.at(-1)[0] < oldestRefresh) {
    baseline = (await fredIndexCloses(series[symbol])).filter(([day]) => day <= through);
  }
  const from = shiftDate(baseline.at(-1)[0], -14);
  try {
    const current = await nasdaqIndexCloses(symbol, from, through);
    const merged = new Map(baseline);
    for (const [day, close] of current) merged.set(day, close);
    const rows = [...merged].sort(([a], [b]) => a.localeCompare(b));
    const fresh = current.at(-1)[0] === rows.at(-1)[0] && rows.at(-1)[0] >= shiftDate(date, -5);
    return { rows, source: "Nasdaq", fresh };
  } catch {
    try {
      const rows = (await fredIndexCloses(series[symbol])).filter(([day]) => day <= through);
      let lastWeekday = through;
      while ([0, 6].includes(new Date(lastWeekday).getUTCDay())) lastWeekday = shiftDate(lastWeekday, -1);
      if (rows.at(-1)?.[0] >= baseline.at(-1)[0]) {
        return { rows, source: "FRED", fresh: rows.at(-1)[0] === lastWeekday };
      }
    } catch {
      // 源暂不可用时保留有日期标记的已知收盘，并关闭当日买入判断。
    }
    return { rows: baseline, source: "本地快照", fresh: false };
  }
}

async function refreshPremiums(date) {
  const from = shiftDate(date, -42);
  const [calendarBars, ...recent] = await Promise.all([
    unadjustedBars("1.000001", from, date),
    ...codes.map(async (code) => {
      const exchange = code.startsWith("15") ? "0" : "1";
      const [bars, nav] = await Promise.all([unadjustedBars(`${exchange}.${code}`, from, date), disclosedNav(code)]);
      return { code, bars, nav };
    }),
  ]);
  const calendar = [...calendarBars.keys()];
  const common = calendar.filter((day) => recent.every(({ bars }) => bars.has(day)));
  const archive = loadPremiums();
  const holdings = recent.map(({ code, bars, nav }) => {
    const rows = pairInputs([...bars.keys()].map((day) => [day]), bars, nav, calendar);
    const saved = new Map(archive.get(code));
    for (const [day, open, navDate, value, usableDay] of rows) {
      if (day >= shiftDate(date, -10)) saved.set(day, { open, navDate, nav: value, usableDay });
    }
    return [code, new Map([...saved].sort(([a], [b]) => a.localeCompare(b)))];
  });
  return { calendar, common, premiums: new Map(holdings) };
}

async function marketInputs(date) {
  const saved = readFactorIndexes() ?? {};
  const [market, history, ...indexResults] = await Promise.allSettled([
    cnEtfMarket(),
    refreshPremiums(date),
    ...Object.keys(series).map(async (symbol) => [
      symbol,
      await refreshIndex(symbol, saved[symbol] ?? [], date),
    ]),
  ]);
  const indexes = Object.fromEntries(indexResults.filter((item) => item.status === "fulfilled").map((item) => item.value));
  return {
    market: market.value ?? null,
    history: history.value ?? { calendar: [], common: [], premiums: loadPremiums() },
    indexes,
  };
}

function refreshTodayInputs(date) {
  if (pending?.date === date) return pending.promise;
  const request = { date };
  request.promise = marketInputs(date).finally(() => {
    if (pending === request) pending = undefined;
  });
  pending = request;
  return request.promise;
}

module.exports = { refreshTodayInputs, shiftDate };
