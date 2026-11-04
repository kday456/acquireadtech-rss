import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, parseArgs } from "../scripts/daily.js";
import { FIXTURES } from "./helpers.js";

test("daily job writes signals JSON and Top 10 brief from fixtures", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "dn-"));
  const code = await main([
    "--out", out, "--date", "2026-11-04", "--window", "7",
    "--feed-file", path.join(FIXTURES, "rss-sample.xml"),
    "--feed-file", path.join(FIXTURES, "atom-sample.xml"),
    "--edgar-file", path.join(FIXTURES, "edgar-sample.json"),
  ], {});
  assert.equal(code, 0);
  const doc = JSON.parse(fs.readFileSync(path.join(out, "signals-2026-11-04.json"), "utf8"));
  assert.equal(doc.date, "2026-11-04");
  assert.equal(doc.signals.length, 11);
  assert.equal(doc.signals[0].target, "Pixelshelf");
  for (const s of doc.signals) {
    for (const k of ["headline", "link", "date", "summary", "signal_type", "dn_fit", "why_dn"]) assert.ok(k in s, k);
    assert.ok(!("snippet" in s));
  }
  assert.ok(!fs.readFileSync(path.join(out, "signals-2026-11-04.json"), "utf8").includes("MUST NEVER"));
  const md = fs.readFileSync(path.join(out, "brief-2026-11-04.md"), "utf8");
  assert.match(md, /^# Top 10 DN deal signals: 2026-11-04/);
  assert.equal((md.match(/^\| \d+ \|/gm) || []).length, 10);
  assert.ok(!md.includes("Holiday Recipes"), "non-signals are excluded from the brief");
});

test("history from earlier files marks repeat acquirers", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "dn-"));
  const prior = { signals: [{ signal_type: "acquisition", buyer: "Acme Ads" }] };
  fs.writeFileSync(path.join(out, "signals-2026-11-01.json"), JSON.stringify(prior));
  await main(["--out", out, "--date", "2026-11-04", "--window", "7", "--feed-file", path.join(FIXTURES, "rss-sample.xml")], {});
  const doc = JSON.parse(fs.readFileSync(path.join(out, "signals-2026-11-04.json"), "utf8"));
  assert.ok(doc.active_acquirers.includes("acme ads"));
});

test("rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});
