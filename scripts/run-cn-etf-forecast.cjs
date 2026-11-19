const { runForecast } = require("../api/_etf-forecast");
const { closeForecastStore } = require("../api/_etf-forecast-store");

async function main() {
  try {
    const { id, result } = await runForecast({
      refresh: !process.argv.includes("--from-snapshot"),
      rulesOnly: process.argv.includes("--rules-only"),
    });
    console.log(`已入库 #${id}，截至 ${result.origin}，选用 ${result.selected}`);
    console.table(result.models.map(({ name, metrics }) => ({
      模型: name,
      分位数误差百分点: (100 * metrics.pinball).toFixed(3),
      中位预测误差百分点: (100 * metrics.mae).toFixed(3),
      覆盖率: (100 * metrics.coverage).toFixed(2) + "%",
    })));
    if (result.skipped.length) console.log("跳过的候选", result.skipped);
  } finally {
    await closeForecastStore();
  }
}
main().catch((error) => {
  console.error(error.code ?? error.message);
  process.exitCode = 1;
});
