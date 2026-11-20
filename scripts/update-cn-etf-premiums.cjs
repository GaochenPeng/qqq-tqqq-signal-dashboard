const fs = require("node:fs/promises");
const path = require("node:path");

const codes = ["159660", "513110", "159941", "513290"];
const historyFile = path.join(__dirname, "../data/cn-etf-history.json");
const destination = path.join(__dirname, "../data/cn-etf-premium-history.json");
const { unadjustedBars, disclosedNav, pairInputs, usableAfterSessions } = require("../api/_cn-etf-history-source");

async function main() {
  const { funds: history } = JSON.parse(await fs.readFile(historyFile, "utf8"));
  const first = codes.map((code) => history[code][0][0]).sort()[0];
  const through = codes.map((code) => history[code].at(-1)[0]).sort().at(-1);
  const beforeFirst = new Date(Date.parse(first) - 45 * 86400_000).toISOString().slice(0, 10);
  const calendar = Array.from((await unadjustedBars("1.000001", beforeFirst, through)).keys());
  const funds = {};
  for (const code of codes) {
    const secid = `${code.startsWith("15") ? 0 : 1}.${code}`;
    const [openingPrices, nav] = await Promise.all([
      unadjustedBars(secid, first, through), disclosedNav(code),
    ]);
    const rows = pairInputs(history[code], openingPrices, nav, calendar);
    if (rows.length < 230 || rows.at(-1)[0] !== history[code].at(-1)[0]) {
      throw new Error(`${code} 历史折溢价输入不完整`);
    }
    funds[code] = rows;
    console.log(`${code} ${rows.length} 条开盘估算，${rows[0][0]} 至 ${rows.at(-1)[0]}`);
  }

  const entries = Object.entries(funds).map(([code, rows]) =>
    `    "${code}": [\n      ${rows.map((row) => JSON.stringify(row)).join(",\n      ")}\n    ]`);
  const content = `{\n  "generatedAt": "${new Date().toISOString()}",\n  "usableAfterSessions": ${usableAfterSessions},\n  "funds": {\n${entries.join(",\n")}\n  }\n}\n`;
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { flag: "wx" });
  try {
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
