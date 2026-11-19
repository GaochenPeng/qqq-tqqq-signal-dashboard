const fs = require("node:fs/promises");
const path = require("node:path");
const { forecastStoreEnabled, syncFactorIndexCloses, closeForecastStore } = require("../api/_etf-forecast-store");

const destination = path.join(__dirname, "../data/cn-etf-factor-indexes.json");
const series = { NDX: "NASDAQ100", NBI: "NASDAQNBI" };

async function fetchIndexCloses(seriesId) {
  const source = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv");
  source.search = new URLSearchParams({ id: seriesId, cosd: "2022-01-01" });
  const response = await fetch(source, { headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(15_000) });
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

async function main() {
  const indexes = Object.fromEntries(await Promise.all(Object.entries(series).map(async ([index, seriesId]) =>
    [index, await fetchIndexCloses(seriesId)])));
  let existing;
  try {
    existing = JSON.parse(await fs.readFile(destination, "utf8")).indexes;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const [name, rows] of Object.entries(indexes)) {
    if (rows.length < 700 || rows[0][0] > "2022-01-07" || rows.at(-1)[0] < "2025-01-02" ||
        (existing?.[name] && rows.at(-1)[0] < existing[name].at(-1)[0])) {
      throw new Error(`${name} 因子日线不完整或早于已有数据`);
    }
  }

  const temporary = `${destination}.${process.pid}.tmp`;
  const content = { source: "Nasdaq via FRED", series, generatedAt: new Date().toISOString(), indexes };
  await fs.writeFile(temporary, JSON.stringify(content) + "\n", { flag: "wx" });
  try {
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  for (const [name, rows] of Object.entries(indexes)) {
    console.log(`${name} ${rows.length} 条 ${rows[0][0]} 至 ${rows.at(-1)[0]}`);
  }
  if (forecastStoreEnabled()) {
    try {
      const changed = await syncFactorIndexCloses(indexes);
      console.log(`PostgreSQL 新增或更新 ${changed} 条指数日线`);
    } finally {
      await closeForecastStore();
    }
  }
}

main().catch((error) => {
  console.error(error.message, error.cause?.code ?? "");
  process.exitCode = 1;
});
