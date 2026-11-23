const reutersSearch = new URL("https://news.google.com/rss/search");
reutersSearch.search = new URLSearchParams({
  q: '(Nvidia OR Microsoft OR AMD OR Broadcom OR Micron OR Anthropic OR Alphabet OR Meta OR Amazon) ("accounting" OR "probe" OR "export restrictions" OR "chip sales" OR "CEO" OR "forecast") site:reuters.com when:7d',
  hl: "en-US",
  gl: "US",
  ceid: "US:en",
});

const eventFeeds = {
  fed: {
    name: "美联储",
    url: "https://www.federalreserve.gov/feeds/press_monetary.xml",
    host: "www.federalreserve.gov",
    scope: ["NDX", "NBI"],
  },
  nvidia: {
    name: "英伟达公告",
    url: "https://nvidianews.nvidia.com/cats/press_release.xml",
    host: "nvidianews.nvidia.com",
    scope: ["NDX"],
  },
  reuters: {
    name: "路透社（新闻索引）",
    url: reutersSearch.href,
    host: "news.google.com",
    scope: ["NDX"],
  },
};

const companies = {
  NVIDIA: "英伟达", Microsoft: "微软", AMD: "AMD", Broadcom: "博通", Micron: "美光",
  Anthropic: "Anthropic", Alphabet: "谷歌", Google: "谷歌", Meta: "Meta", Amazon: "亚马逊",
};
const companyPattern = new RegExp(`\\b(${Object.keys(companies).join("|")})\\b`, "i");

function xmlField(xml, name) {
  const value = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(xml)?.[1]?.trim() ?? "";
  if (value.startsWith("<![CDATA[") && value.endsWith("]]>")) return value.slice(9, -3).trim();
  const entities = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">" };
  return value.replace(/&(amp|apos|quot|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity, key) => {
    if (key in entities) return entities[key];
    const point = key[1] === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function eventTopic(feed, title) {
  if (feed === "fed") {
    if (/\bFOMC statement\b/i.test(title)) return ["fed-decision", "美联储发布利率决议"];
    if (/^Minutes of the Federal Open Market Committee/i.test(title)) return ["fed-minutes", "美联储发布会议纪要"];
    return null;
  }
  if (feed === "nvidia") {
    if (/announces financial results/i.test(title)) return ["英伟达-earnings", "英伟达公布财报"];
    if (/announces CEO transition/i.test(title)) return ["英伟达-ceo", "英伟达宣布更换 CEO"];
    return null;
  }
  const company = companyPattern.exec(title)?.[0];
  if (!company) return null;
  const name = companies[Object.keys(companies).find((key) => key.toLowerCase() === company.toLowerCase())];
  if (/\b(restate[ds]?|restatement|SEC (?:probe|investigat\w+|inquiry))\b/i.test(title) ||
      (/\baccounting\b/i.test(title) && /\b(probe|investigat\w+|inquiry)\b/i.test(title))) {
    return [`${name}-accounting`, `路透报道${name}涉会计或监管调查`];
  }
  if (/\b(?:stops?|halts?|suspends?) (?:shipping|shipments|sales|exports)\b/i.test(title) ||
      /\b(?:tightens?|imposes?)\b.{0,36}\bexport (?:controls|restrictions)\b/i.test(title)) {
    return [`${name}-exports`, `路透报道${name}出货或出口限制有变动`];
  }
  if (/\b(?:cuts?|lowers?|withdraws?) (?:its )?(?:annual |quarterly )?(?:guidance|forecast|outlook)\b/i.test(title)) {
    return [`${name}-guidance`, `路透报道${name}下调或撤回业绩指引`];
  }
  return null;
}

function parseEventFeed(feed, xml, now) {
  const config = eventFeeds[feed];
  if (!/<rss\b/i.test(xml) || !/<\/channel>\s*<\/rss>\s*$/i.test(xml)) {
    throw new Error(`${config.name}未返回 RSS`);
  }
  const cutoff = now.getTime() - 7 * 86_400_000;
  const events = [];
  let datedItems = 0;
  for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = xmlField(item, "title").replace(/ - Reuters$/i, "");
    const published = Date.parse(xmlField(item, "pubDate"));
    const href = xmlField(item, "link");
    const link = URL.canParse(href) ? new URL(href) : null;
    if (!title || !Number.isFinite(published) || link?.protocol !== "https:" ||
        link.hostname !== config.host || link.username || link.password) continue;
    if (feed === "reuters" && (!link.pathname.startsWith("/rss/articles/") ||
        !/<source\b[^>]*\burl="https:\/\/(?:www\.)?reuters\.com\/?"[^>]*>\s*Reuters\s*<\/source>/i.test(item))) continue;
    datedItems += 1;
    if (published < cutoff || published > now.getTime()) continue;
    const topic = eventTopic(feed, title);
    if (!topic) continue;
    events.push({
      topic: topic[0],
      summary: topic[1],
      title,
      link: link.href,
      publishedAt: new Date(published).toISOString(),
      kind: feed === "reuters" ? "report" : "official",
      source: config.name,
      scope: config.scope,
    });
  }
  if (!datedItems && /<item\b/i.test(xml)) throw new Error(`${config.name}缺少有效发布时间或链接`);
  // 同一来源重复报道同类事件时保留首次收录的时间，避免每次更新标题都重置等待期。
  events.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const earliest = new Map();
  for (const event of events) {
    const existing = earliest.get(event.topic);
    if (!existing || Date.parse(event.publishedAt) - Date.parse(existing.publishedAt) >= 2 * 86_400_000) {
      earliest.set(event.topic, event);
    }
  }
  return [...earliest.values()];
}

async function refreshEvents(now) {
  return Promise.all(Object.entries(eventFeeds).map(async ([feed, config]) => {
    try {
      const response = await fetch(config.url, {
        headers: { Accept: "application/rss+xml,application/xml,text/xml", "User-Agent": "Mozilla/5.0" },
        cache: "no-store",
        signal: AbortSignal.timeout(9_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = parseEventFeed(feed, await response.text(), now);
      return { feed, name: config.name, scope: config.scope, available: true, items };
    } catch (error) {
      console.warn(`刷新 ETF 事件失败 ${feed}`, error.message);
      return { feed, name: config.name, scope: config.scope, available: false, items: [] };
    }
  }));
}

module.exports = { parseEventFeed, refreshEvents };
