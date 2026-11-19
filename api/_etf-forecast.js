const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { existsSync } = require("node:fs");
const { cnEtfMarket } = require("./_cn-etf-market");
const {
  archiveEtfQuotes, syncEtfBars, forecastCloses, saveForecast, forecastStatus,
} = require("./_etf-forecast-store");

const execute = promisify(execFile);
const root = path.resolve(__dirname, "..");
const codes = ["159660", "513110", "159941", "513290"];
let active;
let failure;

function predict(funds, rulesOnly) {
  const worker = path.join(root, "forecast/worker.py");
  const isolatedPython = path.join(root, "forecast/.venv/bin/python");
  const python = process.env.ETF_FORECAST_PYTHON || (existsSync(isolatedPython) ? isolatedPython : "python3");
  const modelDir = process.env.ETF_FORECAST_MODEL_DIR || path.join(root, "forecast/.models");
  const args = [worker, "--model-dir", modelDir];
  if (rulesOnly) args.push("--rules-only");
  const env = { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", PYTHONUNBUFFERED: "1" };
  delete env.ETF_DATABASE_URL;
  delete env.ETF_POSTGRES_PASSWORD;
  return new Promise((resolve, reject) => {
    const child = execFile(python, args, { cwd: root, timeout: 240_000, maxBuffer: 2_000_000, env }, (error, stdout, stderr) => {
      if (stderr.trim()) console.log(stderr.trim());
      if (error) {
        reject(new Error("本地预测运行失败，检查模型依赖或执行日志"));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error("本地预测结果无法解析", { cause: error }));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(funds));
  });
}

async function runForecast({ refresh = true, rulesOnly = false } = {}) {
  const warnings = [];
  if (refresh) {
    try {
      await execute(process.execPath, ["scripts/update-cn-etf-history.cjs"], { cwd: root, timeout: 22_000 });
      await execute(process.execPath, ["scripts/update-cn-etf-premiums.cjs"], { cwd: root, timeout: 22_000 });
    } catch {
      warnings.push("行情档案更新未完整完成，按本地可用日线生成。");
    }
  }
  try {
    await archiveEtfQuotes(await cnEtfMarket());
  } catch {
    warnings.push("本次最新 IOPV 未能保存。");
  }
  await syncEtfBars();
  const funds = await forecastCloses(codes);
  const result = await predict(funds, rulesOnly);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ funds, modelVersions: result.models.map(({ id, revision }) => [id, revision]) }))
    .digest("hex");
  const record = await saveForecast({ ...result, warnings }, fingerprint);
  return { ...record, result };
}

function beginForecast() {
  if (!active) {
    failure = undefined;
    active = runForecast()
      .catch((error) => {
        console.warn("本地预测更新失败", error.code ?? error.message);
        failure = "本地预测更新失败，可重试。";
      })
      .finally(() => { active = undefined; });
  }
}

async function currentForecast() {
  return { ...await forecastStatus(), running: Boolean(active), failure: failure ?? null };
}

module.exports = { beginForecast, currentForecast, runForecast };
