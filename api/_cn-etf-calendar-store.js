const { forecastPool, forecastStoreEnabled } = require("./_etf-forecast-store");
const { calendarMetadata, refreshCalendarSources } = require("./_cn-etf-calendar-source");

async function archiveCalendar(items) {
  const observations = items.flatMap((item) => {
    const base = { key: item.key, kind: item.type, release_at: item.releaseAt };
    const forecastObservedAt = item.forecastObservedAt ?? item.observedAt;
    const rows = [];
    if (item.forecast !== null && forecastObservedAt < item.releaseAt) rows.push({
      ...base, observed_at: forecastObservedAt, forecast: item.forecast, forecast_source: item.forecastSource.name,
    });
    if (item.actual !== null) rows.push({
      ...base, observed_at: item.observedAt, actual: item.actual, actual_source: item.actualSource.name,
    });
    return rows;
  });
  const db = await forecastPool();
  if (observations.length) {
    await db.query(`
      INSERT INTO etf_calendar_observations (event_key, event_kind, release_at, observed_at, forecast, actual, forecast_source, actual_source)
      SELECT key, kind, release_at, observed_at, forecast, actual, forecast_source, actual_source
      FROM jsonb_to_recordset($1::jsonb) AS x(
        key text, kind text, release_at timestamptz, observed_at timestamptz, forecast float8, actual float8,
        forecast_source text, actual_source text
      )
      ON CONFLICT (event_key, observed_at) DO NOTHING
    `, [JSON.stringify(observations)]);
  }
  const { rows } = await db.query(`
    WITH events AS (
      SELECT key FROM unnest($1::text[]) AS keys(key)
      UNION
      SELECT event_key FROM etf_calendar_observations
      WHERE release_at BETWEEN $2::timestamptz - interval '7 days' AND $2::timestamptz + interval '7 days'
    )
    SELECT e.key, COALESCE(f.release_at, a.release_at) AS release_at,
      f.forecast, f.observed_at AS forecast_at, a.actual, a.observed_at AS actual_at
    FROM events e
    LEFT JOIN LATERAL (
      SELECT forecast, observed_at, release_at FROM etf_calendar_observations
      WHERE event_key = e.key AND forecast IS NOT NULL AND observed_at < release_at
      ORDER BY observed_at DESC LIMIT 1
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT actual, observed_at, release_at FROM etf_calendar_observations
      WHERE event_key = e.key AND actual IS NOT NULL AND observed_at >= release_at
      ORDER BY observed_at LIMIT 1
    ) a ON true
  `, [items.map(({ key }) => key), new Date()]);
  return new Map(rows.map((row) => [row.key, row]));
}

function summarizeCalendar(items, archived) {
  const byKey = new Map(items.map((item) => [item.key, item]));
  for (const [key, saved] of archived) {
    if (byKey.has(key) || !saved.release_at) continue;
    const metadata = calendarMetadata(key, saved.release_at.toISOString());
    if (metadata) byKey.set(key, { ...metadata, forecast: null, actual: null, fromArchive: true });
  }
  return [...byKey.values()].map((item) => {
    const saved = archived.get(item.key);
    const forecast = saved?.forecast ?? item.forecast;
    const actual = saved?.actual ?? item.actual;
    return {
      ...item,
      forecast, actual,
      forecastAt: saved?.forecast_at?.toISOString() ?? null,
      actualAt: saved?.actual_at?.toISOString() ?? (item.actual === null ? null : item.observedAt),
      surprise: forecast === null || actual === null ? null : Math.round((actual - forecast) * 1e6) / 1e6,
    };
  });
}

async function refreshCalendar(now) {
  const { items, unavailable } = await refreshCalendarSources(now);
  let archived = new Map();
  let archive = "disabled";
  if (forecastStoreEnabled()) {
    try {
      archived = await archiveCalendar(items);
      archive = "ok";
    } catch (error) {
      archive = "error";
      console.warn("保存 ETF 事件数值失败", error.code ?? error.message);
    }
  }
  return { items: summarizeCalendar(items, archived), unavailable, archive };
}

module.exports = { refreshCalendar, summarizeCalendar };
