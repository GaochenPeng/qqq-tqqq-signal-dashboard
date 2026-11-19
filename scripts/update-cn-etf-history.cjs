const fs = require("node:fs/promises");
const path = require("node:path");
const { fundTerms } = require("../api/_cn-etf-market");

const file = path.resolve(__dirname, "../data/cn-etf-history.json");
const codes = [...fundTerms.map(({ code }) => code), "513290"];
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

async function fetchSeries(code, lastDay) {
  const exchange = code.startsWith("15") ? 0 : 1;
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.search = new URLSearchParams({
    secid: `${exchange}.${code}`,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56",
    klt: "101",
    fqt: "1",
    beg: "20130101",
    end: lastDay.replaceAll("-", ""),
    lmt: "10000",
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${code} 日线接口返回 HTTP ${response.status}`);
  const { data } = await response.json();
  if (data?.code !== code || !Array.isArray(data.klines)) throw new Error(`缺少 ${code} 日线`);

  let previous = "";
  const points = [];
  for (const line of data.klines) {
    const [date, rawOpen, rawClose, , , rawVolume] = line.split(",");
    if (!dayPattern.test(date) || date <= previous || date > lastDay) throw new Error(`${code} 日线日期无效 ${date}`);
    previous = date;
    const volume = Number(rawVolume);
    if (!Number.isFinite(volume) || volume < 0) throw new Error(`${code} 成交量无效 ${date}`);
    if (volume === 0) continue;
    const open = Number(rawOpen);
    const close = Number(rawClose);
    if (!(open > 0) || !(close > 0) || !Number.isFinite(open) || !Number.isFinite(close)) {
      throw new Error(`${code} 复权价格无效 ${date}`);
    }
    points.push([date, open, close]);
  }
  if (points.length < 120) throw new Error(`${code} 日线样本不足`);
  return points;
}

async function main() {
  const now = new Date();
  const clock = new Date(now.getTime() + 8 * 3600_000).toISOString();
  // 收盘后给供应商留出更新日线的时间。
  const latestDay = clock.slice(11, 16) >= "15:10"
    ? clock.slice(0, 10)
    : new Date(Date.parse(clock) - 86400_000).toISOString().slice(0, 10);
  const funds = {};
  for (const code of codes) {
    funds[code] = await fetchSeries(code, latestDay);
    console.log(`${code} ${funds[code].length} 条 ${funds[code][0][0]} 至 ${funds[code].at(-1)[0]}`);
  }

  let before;
  try {
    before = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const code of codes) {
    if (before?.funds[code] && before.funds[code].at(-1)[0] > funds[code].at(-1)[0]) {
      throw new Error(`${code} 的日线比本地快照旧`);
    }
  }
  const formattedSeries = Object.entries(funds).map(([code, points]) =>
    `    "${code}": [\n      ${points.map((point) => JSON.stringify(point)).join(",\n      ")}\n    ]`);
  const content = `{\n  "generatedAt": "${now.toISOString()}",\n  "funds": {\n${formattedSeries.join(",\n")}\n  }\n}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { flag: "wx" });
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
