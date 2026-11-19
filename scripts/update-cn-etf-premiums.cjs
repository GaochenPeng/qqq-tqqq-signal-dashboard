const fs = require("node:fs/promises");
const path = require("node:path");

const codes = ["159660", "513110", "159941", "513290"];
const historyFile = path.join(__dirname, "../data/cn-etf-history.json");
const destination = path.join(__dirname, "../data/cn-etf-premium-history.json");
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const usableAfterSessions = 3;

async function get(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} 返回 HTTP ${response.status}`);
  return response;
}

async function unadjustedBars(secid, from, through) {
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
    const [date, rawOpen, , , , rawVolume] = line.split(",");
    const open = Number(rawOpen);
    const volume = Number(rawVolume);
    if (!dayPattern.test(date) || date <= previous || date > through ||
        !Number.isFinite(open) || open <= 0 || !Number.isFinite(volume) || volume < 0) {
      throw new Error(`${secid} 历史日线无效 ${date}`);
    }
    previous = date;
    if (volume > 0) rows.set(date, open);
  }
  return rows;
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

function pairInputs(sessions, openingPrices, netValues, calendar) {
  const indexOf = new Map(calendar.map((date, index) => [date, index]));
  let calendarIndex = 0;
  const available = [];
  for (const row of netValues) {
    while (calendarIndex < calendar.length && calendar[calendarIndex] < row.date) calendarIndex += 1;
    const usableDay = calendar[calendarIndex + usableAfterSessions];
    if (!usableDay) break;
    available.push({ ...row, usableDay });
  }

  const actionDates = netValues.filter(({ action }) => action).map(({ date }) => date);
  let nextNav = 0;
  let nextAction = 0;
  let current;
  let latestAction = "";
  const pairs = [];
  for (const [date] of sessions) {
    const open = openingPrices.get(date);
    if (open === undefined || !indexOf.has(date)) continue;
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
      pairs.push([date, open, current.date, current.nav, current.usableDay]);
    }
  }
  return pairs;
}

async function main() {
  const { funds: history } = JSON.parse(await fs.readFile(historyFile, "utf8"));
  const first = codes.map((code) => history[code][0][0]).sort()[0];
  const through = codes.map((code) => history[code].at(-1)[0]).sort().at(-1);
  const beforeFirst = new Date(Date.parse(first) - 45 * 86400_000).toISOString().slice(0, 10);
  const calendar = Array.from((await unadjustedBars("1.000001", beforeFirst, through)).keys());
  const funds = {};
  for (const code of codes) {
    const secid = `${code.startsWith("15") ? 0 : 1}.${code}`;
    const [openingPrices, nav] = await Promise.all([
      unadjustedBars(secid, first, through), disclosedNav(code),
    ]);
    const rows = pairInputs(history[code], openingPrices, nav, calendar);
    if (rows.length < 230 || rows.at(-1)[0] !== history[code].at(-1)[0]) {
      throw new Error(`${code} 历史折溢价输入不完整`);
    }
    funds[code] = rows;
    console.log(`${code} ${rows.length} 条开盘估算，${rows[0][0]} 至 ${rows.at(-1)[0]}`);
  }

  const entries = Object.entries(funds).map(([code, rows]) =>
    `    "${code}": [\n      ${rows.map((row) => JSON.stringify(row)).join(",\n      ")}\n    ]`);
  const content = `{\n  "generatedAt": "${new Date().toISOString()}",\n  "usableAfterSessions": ${usableAfterSessions},\n  "funds": {\n${entries.join(",\n")}\n  }\n}\n`;
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { flag: "wx" });
  try {
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
