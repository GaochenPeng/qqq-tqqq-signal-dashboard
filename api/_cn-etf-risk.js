const newYorkClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dayMs = 86_400_000;
const usOpen = 9 * 60 + 30;
const vixClose = 16 * 60 + 15;
const rateLimitBps = 10;

function usMarketClock(instant) {
  const parts = Object.fromEntries(newYorkClock.formatToParts(instant).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function completedUsThrough(now) {
  const { date, minutes } = usMarketClock(now);
  if (minutes >= vixClose) return date;
  return new Date(Date.parse(date) - dayMs).toISOString().slice(0, 10);
}

const labels = {
  equalWeight: "纳指 100 等权",
  semiconductor: "半导体",
  vix: "VIX",
  treasury: "美国 10 年期国债收益率",
  biotech: "纳指生物科技",
};

function lastSessionPair(inputs, through) {
  const pairs = inputs.map((input) => input?.rows.filter(([date]) => date <= through).slice(-2) ?? []);
  const recent = pairs.filter((pair) => pair.length === 2 && Date.parse(through) - Date.parse(pair[1][0]) <= 5 * dayMs);
  recent.sort((a, b) => b[1][0].localeCompare(a[1][0]) || b[0][0].localeCompare(a[0][0]));
  return recent[0]?.map(([date]) => date) ?? [null, null];
}

function compareCloses(key, input, beforeDate, date, through) {
  const rows = input?.rows ?? [];
  const latest = rows.findLast(([day]) => day <= through);
  const current = rows.find(([day]) => day === date)?.[1] ?? null;
  const before = rows.find(([day]) => day === beforeDate)?.[1] ?? null;
  const available = current !== null && before !== null;
  const change = !available ? null : key === "treasury" ? Math.round((current - before) * 100) : current / before - 1;
  return {
    label: labels[key], available, change, latest: latest?.[1] ?? null, date: latest?.[0] ?? null,
    source: input?.source ?? null, url: input?.url ?? null,
  };
}

function marketGroup(index, factors, feeds, events) {
  const ndx = index === "NDX";
  const equityKeys = ndx ? ["equalWeight", "semiconductor"] : ["biotech"];
  const missingFactors = [...equityKeys, "vix", "treasury"].filter((key) => !factors[key].available);
  const unavailableFeeds = feeds.filter(({ available, scope }) => !available && scope.includes(index));
  const pendingEvents = events.filter(({ pending, scope }) => pending && scope.includes(index));
  const blockers = [];
  if (missingFactors.length) blockers.push({
    code: "marketDataUnavailable",
    why: `${missingFactors.map((key) => labels[key]).join("、")}缺少可比较的美股收盘数据。`,
    next: "等上述数据补齐到同一对交易日。",
  });
  if (!feeds.length || unavailableFeeds.length) blockers.push({
    code: "eventFeedUnavailable",
    why: unavailableFeeds.length ? `${unavailableFeeds.map(({ name }) => name).join("、")}暂时刷不到。` : "关键消息来源暂时刷不到。",
    next: "等消息源恢复后刷新。",
  });
  if (pendingEvents.length) blockers.push({
    code: "eventPending",
    why: `${pendingEvents.map(({ summary }) => summary).join("、")}。消息之后还没有一整场美股收盘可观察。`,
    next: "等消息公布后的第一个完整美股交易日收盘，再看市场反应。",
  });
  if (equityKeys.every((key) => factors[key].change < 0) && factors.vix.change > 0) blockers.push({
    code: "equitySelloff",
    why: ndx ? "芯片和纳指 100 等权都在跌，同时 VIX 上升。" : "纳指生物科技在跌，同时 VIX 上升。",
    next: ndx ? "等芯片或等权指数止跌，或者 VIX 持平、回落。" : "等生物科技指数止跌，或者 VIX 持平、回落。",
  });
  if (factors.treasury.change >= rateLimitBps) blockers.push({
    code: "rateShock",
    why: `10 年期美债收益率单日上行 ${factors.treasury.change} 个基点。`,
    next: `等美债收益率的单日升幅小于 ${rateLimitBps} 个基点。`,
  });

  const smallWait = ndx ? [
    ...equityKeys.filter((key) => factors[key].available && factors[key].change < 0)
      .map((key) => `${labels[key]}收盘至少持平`),
    ...(factors.vix.available && factors.vix.change >= 0 ? ["VIX 低于上一交易日"] : []),
  ] : [];
  return { blockers, smallWait };
}

function assessMarketRisk({ now, indexes, riskInputs }) {
  const through = completedUsThrough(now);
  const { closes = {}, feeds = [] } = riskInputs ?? {};
  const ndx = indexes.NDX?.fresh ? indexes.NDX : null;
  const nbi = indexes.NBI?.fresh ? indexes.NBI : null;
  const [beforeDate, date] = lastSessionPair([ndx, nbi, closes.equalWeight, closes.semiconductor, closes.vix], through);
  const inputs = { ...closes, biotech: nbi && { ...nbi, url: "https://indexes.nasdaq.com/Index/Overview/NBI" } };
  const factors = Object.fromEntries(Object.keys(labels)
    .map((key) => [key, compareCloses(key, inputs[key], beforeDate, date, through)]));
  const events = feeds.flatMap(({ items }) => items ?? [])
    .filter(({ publishedAt }) => Date.parse(publishedAt) <= now.getTime())
    .map((event) => {
      const published = usMarketClock(new Date(event.publishedAt));
      // 盘中或盘后出现的消息，留到下一场完整的常规交易结束后复看。
      const pending = !date || published.date > date || (published.date === date && published.minutes >= usOpen);
      return { ...event, pending };
    })
    .sort((a, b) => Number(b.pending) - Number(a.pending) || b.publishedAt.localeCompare(a.publishedAt));
  return {
    version: "event-market-v1",
    date, beforeDate, factors, events,
    missingFeeds: feeds.filter(({ available }) => !available).map(({ name }) => name),
    groups: Object.fromEntries(["NDX", "NBI"].map((index) => [index, marketGroup(index, factors, feeds, events)])),
  };
}

module.exports = { assessMarketRisk, completedUsThrough };
