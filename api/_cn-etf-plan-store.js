const { forecastPool, forecastStoreEnabled } = require("./_etf-forecast-store");
const { factorPolicy } = require("./_cn-etf-factor");

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function record(row) {
  return {
    key: row.entry_key,
    code: row.fund_code,
    date: row.traded_on,
    side: row.side,
    shares: Number(row.shares),
    amountCents: Number(row.amount_cents),
  };
}

async function readPlan() {
  if (!forecastStoreEnabled()) return { enabled: false, plan: null, trades: [] };
  const db = await forecastPool();
  const { rows } = await db.query(`
    SELECT p.budget_yuan, p.start_month::text, p.installments, p.policy_version,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.traded_on, t.recorded_at, t.entry_key)
        FROM etf_plan_trades t WHERE t.plan_id = p.id
      ), '[]'::jsonb) AS trades
    FROM etf_investment_plan p WHERE p.id = 1
  `);
  const [row] = rows;
  if (!row) return { enabled: true, plan: null, trades: [] };
  return {
    enabled: true,
    plan: {
      budget: Number(row.budget_yuan), startMonth: row.start_month.slice(0, 7),
      installments: row.installments, policyVersion: row.policy_version,
    },
    trades: row.trades.map(record),
  };
}

async function inTransaction(callback) {
  if (!forecastStoreEnabled()) {
    throw Object.assign(new Error("请先连接本机 PostgreSQL"), { statusCode: 503 });
  }
  const db = await forecastPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await callback(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return readPlan();
}

function savePlan({ budget, startMonth }) {
  const day = startMonth + "-01";
  return inTransaction(async (client) => {
    await client.query(`
      INSERT INTO etf_investment_plan (budget_yuan, start_month, installments, policy_version)
      VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING
    `, [budget, day, factorPolicy.installments, factorPolicy.version]);
    const { rows: [plan] } = await client.query(`
      SELECT budget_yuan, start_month::text FROM etf_investment_plan WHERE id = 1 FOR UPDATE
    `);
    if (Number(plan.budget_yuan) === budget && plan.start_month === day) return;
    const { rowCount } = await client.query("SELECT 1 FROM etf_plan_trades WHERE plan_id = 1 LIMIT 1");
    if (rowCount) throw conflict("计划已有实际成交，后续判断将沿用原计划本金和起始月。");
    await client.query("UPDATE etf_investment_plan SET budget_yuan = $1, start_month = $2 WHERE id = 1", [budget, day]);
  });
}

function addPlanTrade(trade) {
  return inTransaction(async (client) => {
    const { rows: [plan] } = await client.query(`
      SELECT start_month::text FROM etf_investment_plan WHERE id = 1 FOR UPDATE
    `);
    if (!plan) throw conflict("请先保存投资计划。");
    if (trade.date < plan.start_month) throw conflict("成交日期早于计划起始月。");
    const { rows: [existing] } = await client.query(`
      SELECT entry_key, fund_code, traded_on::text, side, shares, amount_cents
      FROM etf_plan_trades WHERE entry_key = $1
    `, [trade.key]);
    if (existing) {
      const before = record(existing);
      if (Object.keys(trade).every((field) => before[field] === trade[field])) return;
      throw conflict("这次录入已保存，请刷新后查看记录。");
    }
    await client.query(`
      INSERT INTO etf_plan_trades (entry_key, fund_code, traded_on, side, shares, amount_cents)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [trade.key, trade.code, trade.date, trade.side, trade.shares, trade.amountCents]);
    const { rowCount } = await client.query(`
      SELECT 1 FROM (
        SELECT SUM(CASE WHEN side = 'buy' THEN shares ELSE -shares END) OVER
          (ORDER BY traded_on, recorded_at, entry_key ROWS UNBOUNDED PRECEDING) AS balance
        FROM etf_plan_trades WHERE plan_id = 1 AND fund_code = $1
      ) AS positions WHERE balance < 0 LIMIT 1
    `, [trade.code]);
    if (rowCount) throw conflict("卖出份额超过当日已录入的持仓，请先补录对应买入。");
  });
}

module.exports = { readPlan, savePlan, addPlanTrade };
