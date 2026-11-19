const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const configFile = path.join(root, ".env.local");
try {
  process.loadEnvFile?.(configFile);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

let connection;
let initialized;

function forecastStoreEnabled() {
  return Boolean(process.env.ETF_DATABASE_URL);
}

async function forecastPool() {
  if (!forecastStoreEnabled()) throw new Error("本地预测数据库尚未配置");
  if (!connection) {
    const { Pool } = require("pg");
    connection = new Pool({
      connectionString: process.env.ETF_DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 2_500,
    });
    connection.on("error", (error) => console.warn("本地 PostgreSQL 连接中断", error.code ?? "unknown"));
  }
  if (!initialized) {
    initialized = fs.readFile(path.join(root, "forecast/schema.sql"), "utf8")
      .then((schema) => connection.query(schema))
      .catch((error) => {
        initialized = undefined;
        throw error;
      });
  }
  await initialized;
  return connection;
}

async function syncEtfBars() {
  const db = await forecastPool();
  const { funds } = JSON.parse(await fs.readFile(path.join(root, "data/cn-etf-history.json"), "utf8"));
  const rows = Object.entries(funds).flatMap(([code, series]) =>
    series.map(([day, open, close]) => ({ code, day, open, close })));
  if (!rows.length || rows.some(({ code, day, open, close }) =>
    !/^\d{6}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(open) || open <= 0 || !Number.isFinite(close) || close <= 0)) {
    throw new Error("ETF 前复权日线格式有误");
  }
  const result = await db.query(`
    INSERT INTO etf_daily_bars (fund_code, session_date, open_price, close_price)
    SELECT code, day, open, close
      FROM jsonb_to_recordset($1::jsonb) AS bar(code text, day date, open float8, close float8)
    ON CONFLICT (fund_code, session_date) DO UPDATE
      SET open_price = EXCLUDED.open_price, close_price = EXCLUDED.close_price
      WHERE (etf_daily_bars.open_price, etf_daily_bars.close_price)
          IS DISTINCT FROM (EXCLUDED.open_price, EXCLUDED.close_price)
  `, [JSON.stringify(rows)]);
  return result.rowCount;
}

async function archiveEtfQuotes(market) {
  if (!forecastStoreEnabled() || market.mode !== "upstream") return 0;
  const funds = [...market.funds, ...(market.forecastQuote ? [market.forecastQuote] : [])];
  const rows = funds.filter((fund) => fund.lastPrice > 0 && fund.iopv > 0 && fund.quoteAt)
    .map((fund) => ({ code: fund.code, quote: fund.quoteAt, price: fund.lastPrice, iopv: fund.iopv }));
  if (!rows.length) return 0;
  const db = await forecastPool();
  const result = await db.query(`
    INSERT INTO etf_iopv_quotes (fund_code, quoted_at, last_price, iopv)
    SELECT code, quote, price, iopv
      FROM jsonb_to_recordset($1::jsonb) AS row(code text, quote timestamptz, price float8, iopv float8)
    ON CONFLICT (fund_code, quoted_at) DO NOTHING
  `, [JSON.stringify(rows)]);
  return result.rowCount;
}

async function forecastCloses(codes) {
  const db = await forecastPool();
  const { rows } = await db.query(`
    SELECT fund_code, session_date::text AS day, close_price
      FROM etf_daily_bars
      WHERE fund_code = ANY($1::text[])
      ORDER BY fund_code, session_date
  `, [codes]);
  const funds = Object.fromEntries(codes.map((code) => [code, []]));
  for (const { fund_code, day, close_price } of rows) funds[fund_code].push([day, close_price]);
  return funds;
}

async function saveForecast(result, fingerprint) {
  const db = await forecastPool();
  const { rows } = await db.query(`
    INSERT INTO etf_forecast_runs (origin_date, horizon, input_sha256, result)
    VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (input_sha256) DO NOTHING
    RETURNING id, generated_at
  `, [result.origin, result.horizon, fingerprint, JSON.stringify(result)]);
  if (rows[0]) return rows[0];
  const previous = await db.query("SELECT id, generated_at FROM etf_forecast_runs WHERE input_sha256 = $1", [fingerprint]);
  return previous.rows[0];
}

async function forecastStatus() {
  const db = await forecastPool();
  const [{ rows: [latest] }, { rows: [counts] }] = await Promise.all([
    db.query("SELECT id, generated_at, result FROM etf_forecast_runs ORDER BY id DESC LIMIT 1"),
    db.query(`SELECT (SELECT count(*)::int FROM etf_daily_bars) AS bars,
      (SELECT count(*)::int FROM etf_iopv_quotes) AS quotes,
      (SELECT count(*)::int FROM etf_forecast_runs) AS runs`),
  ]);
  return { latest: latest ?? null, counts };
}

async function closeForecastStore() {
  if (connection) await connection.end();
  connection = undefined;
  initialized = undefined;
}

module.exports = {
  forecastStoreEnabled, syncEtfBars, archiveEtfQuotes, forecastCloses,
  saveForecast, forecastStatus, closeForecastStore,
};
