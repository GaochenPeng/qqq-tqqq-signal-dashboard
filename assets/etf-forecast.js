const at = (id) => document.getElementById(id);
const button = at("etfForecastRun");
const picker = at("etfForecastModel");
const status = at("etfForecastStatus");
const endpoint = "/api/cn-etf-forecast";
let loaded;
let timer;

function percent(value) {
  return (100 * value).toFixed(2) + "%";
}

function points(value) {
  return (100 * value).toFixed(3) + " 个百分点";
}

function span(type, className, text) {
  const node = document.createElement(type);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderRanges() {
  const model = loaded.result.models.find(({ id }) => id === picker.value);
  if (!model) return;
  const predictions = Object.entries(model.predictions);
  const edges = predictions.flatMap(([, { quantiles }]) => quantiles);
  const low = Math.min(0, ...edges);
  const high = Math.max(0, ...edges);
  const location = (value) => (value - low) / Math.max(0.001, high - low) * 100;
  at("etfForecastRanges").replaceChildren(...predictions.map(([code, { close, quantiles }]) => {
    const [lower, middle, upper] = quantiles;
    const row = span("li", "etf-chart-grid");
    row.dataset.code = code;
    const label = span("strong", "etf-fund", code);
    const track = span("div", "etf-track");
    const band = span("span", "etf-bar etf-forecast-range");
    const zero = span("span", "etf-zero");
    const median = span("span", "etf-forecast-mid");
    band.style.left = location(lower) + "%";
    band.style.width = location(upper) - location(lower) + "%";
    zero.style.left = location(0) + "%";
    median.style.left = location(middle) + "%";
    track.setAttribute("aria-hidden", "true");
    track.append(band, zero, median);
    const summary = span("span", "etf-forecast-values", `${percent(lower)} 至 ${percent(upper)} · 中位 ${percent(middle)}`);
    summary.title = `基准收盘 ${close.toFixed(3)} 元。区间 ${(close * (1 + lower)).toFixed(3)} 至 ${(close * (1 + upper)).toFixed(3)} 元。`;
    row.append(label, track, summary);
    return row;
  }));
  for (const row of at("etfForecastScores").rows) {
    row.classList.toggle("etf-backtest-active", row.dataset.model === model.id);
  }
}

function renderForecast(record) {
  loaded = record;
  const { result } = record;
  const { models, benchmark, origin, horizon, selected } = result;
  picker.replaceChildren(...models.map((model) => {
    const item = span("option", "", model.name);
    item.value = model.id;
    return item;
  }));
  picker.value = selected;
  const name = models.find(({ id }) => id === selected).name;
  at("etfForecastMeta").textContent = `收盘基准 ${origin} · ${horizon} 个交易日 · 本次按分位数误差选用 ${name} · P10—P90 收益区间`;
  at("etfForecastScores").replaceChildren(...models.map((model) => {
    const { metrics } = model;
    const row = document.createElement("tr");
    row.dataset.model = model.id;
    const heading = span("th", "", model.name);
    heading.scope = "row";
    row.append(heading, ...[
      points(metrics.pinball), points(metrics.mae), percent(metrics.coverage), points(metrics.width),
    ].map(value => span("td", "", value)));
    return row;
  }));
  at("etfForecastEvidence").textContent = `历史检验 ${benchmark.from} 至 ${benchmark.through} · ${benchmark.windows} 个不重叠窗口，${benchmark.fundObservations} 条 ETF 结果。误差越小越好。覆盖率是实际落入 P10—P90 的比例。预训练模型的历史得分用于筛选，入库后按预测生成时间验证新行情。`;
  const messages = [...(result.warnings ?? []), ...result.skipped.map(item => `${item.name} ${item.reason}`)];
  at("etfForecastWarnings").textContent = messages.join(" ");
  at("etfForecastWarnings").hidden = !messages.length;
  at("etfForecastResult").hidden = false;
  renderRanges();
}

async function refreshStatus() {
  clearTimeout(timer);
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "预测库暂不可用");
    if (!data.enabled) {
      status.textContent = "连接本地 PostgreSQL 后可运行预测。";
      button.disabled = true;
      return;
    }
    if (data.latest && loaded?.id !== data.latest.id) renderForecast(data.latest);
    button.disabled = data.running;
    if (data.running) {
      status.textContent = "正在更新日线并运行本地模型…";
      timer = setTimeout(refreshStatus, 1800);
    } else if (data.failure) {
      status.textContent = data.failure;
    } else if (data.latest) {
      status.textContent = `已存 PostgreSQL · 预测记录 #${data.latest.id} · ${data.counts.bars} 条日线 · ${data.counts.quotes} 份 IOPV 记录`;
    } else {
      status.textContent = "本地库已连接，点击更新生成首份预测。";
    }
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    const response = await fetch(endpoint, { method: "POST", cache: "no-store" });
    if (!response.ok) throw new Error("本地预测暂时无法启动");
    await refreshStatus();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
picker.addEventListener("change", renderRanges);
refreshStatus();
