import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEdgarUrl, parseEdgarHits, fetchEdgar, cleanFilerName } from "../src/lib/edgar.js";
import { toSignal } from "../src/lib/signals.js";
import { fixture, fakeFetch } from "./helpers.js";

const json = JSON.parse(fixture("edgar-sample.json"));

test("builds an EFTS 8-K query", () => {
  const u = new URL(buildEdgarUrl("ad tech", "2026-11-01", "2026-11-04"));
  assert.equal(u.host, "efts.sec.gov");
  assert.equal(u.searchParams.get("q"), '"ad tech"');
  assert.equal(u.searchParams.get("forms"), "8-K");
  assert.equal(u.searchParams.get("startdt"), "2026-11-01");
});

test("keeps only Item 1.01 / 2.01 filings and links to the filing index", () => {
  const items = parseEdgarHits(json, "programmatic advertising");
  assert.equal(items.length, 2);
  assert.equal(items[0].link, "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000123/0001234567-26-000123-index.htm");
  assert.match(items[0].title, /Item 2\.01/);
  assert.equal(items[0].hint.penalty, null);
  assert.ok(items[1].hint.penalty, "1.01-only filings are flagged");
  assert.equal(cleanFilerName("Example AdCo Inc.  (ADCO)  (CIK 0001234567)"), "Example AdCo Inc.");
});

test("EDGAR items become acquisition signals; 1.01-only scores lower", () => {
  const [a, b] = parseEdgarHits(json, "programmatic advertising").map((it) => toSignal(it));
  assert.equal(a.signal_type, "acquisition");
  assert.deepEqual(a.segments, ["ad tech"]);
  assert.ok(a.dn_fit > b.dn_fit);
  assert.equal(b.confidence, "low");
});

test("fetchEdgar requires a contact User-Agent", async () => {
  const f = fakeFetch(() => "{}");
  const r = await fetchEdgar({ userAgent: "", startDate: "2026-11-01", endDate: "2026-11-04", fetchImpl: f });
  assert.equal(f.calls.length, 0);
  assert.match(r.errors[0].error, /SEC_USER_AGENT/);
});

test("fetchEdgar merges keywords per filing and records errors", async () => {
  const f = fakeFetch((u) => (u.includes("retail") ? { status: 503 } : fixture("edgar-sample.json")));
  const r = await fetchEdgar({ userAgent: "DN test ops@example.com", startDate: "2026-11-01", endDate: "2026-11-04", keywords: ["ad tech", "retail media", "adtech"], fetchImpl: f, delayMs: 0 });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].init.headers["User-Agent"], "DN test ops@example.com");
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].hint.sector, "ad tech, adtech");
  assert.equal(r.errors.length, 1);
});
