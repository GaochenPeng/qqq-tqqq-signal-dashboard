const fs = require("node:fs/promises");
const path = require("node:path");
const { forecastStoreEnabled, syncFactorIndexCloses, closeForecastStore } = require("../api/_etf-forecast-store");

const destination = path.join(__dirname, "../data/cn-etf-factor-indexes.json");
const { series, fredIndexCloses } = require("../api/_cn-etf-history-source");

async function main() {
  const indexes = Object.fromEntries(await Promise.all(Object.entries(series).map(async ([index, seriesId]) =>
    [index, await fredIndexCloses(seriesId)])));
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
