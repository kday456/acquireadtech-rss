#!/usr/bin/env node
// Daily deal-signals job.
//   node scripts/daily.js [--out ../data] [--date YYYY-MM-DD] [--window 3] [--top 10]
//                         [--feed-file path.xml ...] [--edgar-file path.json ...] [--no-edgar]
// Writes <out>/signals-YYYY-MM-DD.json and <out>/brief-YYYY-MM-DD.md.
// Exits 0 even if some sources fail (errors are listed in both outputs);
// exits 2 if every source failed so a scheduler can alert.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFeed } from "../src/lib/feeds.js";
import { parseEdgarHits } from "../src/lib/edgar.js";
import { runPipeline } from "../src/lib/pipeline.js";
import { renderBrief } from "../src/lib/brief.js";
import { SOURCES } from "../src/lib/sources.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const a = { out: path.resolve(here, "../../data"), window: 3, top: 10, feedFiles: [], edgarFiles: [], edgar: true, date: null, historyDays: 90 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--out") a.out = path.resolve(v());
    else if (k === "--date") a.date = v();
    else if (k === "--window") a.window = Number(v());
    else if (k === "--top") a.top = Number(v());
    else if (k === "--feed-file") a.feedFiles.push(v());
    else if (k === "--edgar-file") a.edgarFiles.push(v());
    else if (k === "--no-edgar") a.edgar = false;
    else if (k === "--history-days") a.historyDays = Number(v());
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

function loadHistory(dir, today, days) {
  if (!fs.existsSync(dir)) return [];
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - days * 86400000;
  return fs
    .readdirSync(dir)
    .filter((f) => /^signals-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(8, 18) < today)
    .filter((f) => new Date(`${f.slice(8, 18)}T00:00:00Z`).getTime() >= cutoff)
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).signals || []; } catch { return []; }
    });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const now = args.date ? new Date(`${args.date}T23:59:59Z`) : new Date();
  const today = now.toISOString().slice(0, 10);

  let items = null;
  if (args.feedFiles.length || args.edgarFiles.length) {
    items = [];
    for (const f of args.feedFiles) items.push(...parseFeed(fs.readFileSync(f, "utf8"), { id: path.basename(f), name: path.basename(f) }));
    for (const f of args.edgarFiles) items.push(...parseEdgarHits(JSON.parse(fs.readFileSync(f, "utf8")), "fixture"));
  }

  const doc = await runPipeline({
    now,
    windowDays: args.window,
    items,
    env,
    edgar: args.edgar,
    history: loadHistory(args.out, today, args.historyDays),
    log: (m) => console.error(m),
  });

  fs.mkdirSync(args.out, { recursive: true });
  const jsonPath = path.join(args.out, `signals-${today}.json`);
  const mdPath = path.join(args.out, `brief-${today}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + "\n");
  fs.writeFileSync(mdPath, renderBrief(doc.signals, { date: today, top: args.top, errors: doc.errors, llm: doc.llm.calls ? doc.llm : null }));
  console.error(`wrote ${jsonPath}\nwrote ${mdPath}`);

  const feedErrors = doc.errors.filter((e) => e.source !== "sec-edgar").length;
  if (!items && feedErrors === SOURCES.length) {
    console.error("all feed sources failed");
    return 2;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
