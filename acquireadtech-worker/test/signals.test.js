import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, extractParties, extractDealSize, toSignal, buildSignals, activeAcquirers, cleanCompany } from "../src/lib/signals.js";

const sig = (title, snippet = "") => toSignal({ title, snippet, link: `https://x.test/${encodeURIComponent(title)}`, date: "2026-11-03T00:00:00Z", source: "T" });

test("classifies the six signal types", () => {
  const cases = [
    ["Acme Ads Acquires Pixelshelf", "acquisition"],
    ["Signalwise Acquired by Brightpath", "acquisition"],
    ["Outbrain and Teads merge", "acquisition"],
    ["Streamlytics Raises $12M Series A", "funding"],
    ["LinkLoop Exploring Sale, Hires Bankers", "for_sale"],
    ["Criteo explores strategic alternatives for retail media unit", "for_sale"],
    ["BidHouse Names New CEO", "exec_change"],
    ["Founder and CEO of Kargo steps down", "exec_change"],
    ["TapYield Lays Off 20% of Staff", "layoffs"],
    ["AdCo cuts 15% of its workforce", "layoffs"],
    ["FormFunnel to Shut Down Operations", "shutdown"],
    ["Ad network files for Chapter 11 bankruptcy", "shutdown"],
    ["Ten Holiday Recipes Our Editors Love", "other"],
  ];
  for (const [t, want] of cases) assert.equal(classify(t).type, want, t);
});

test("for-sale beats acquisition vocabulary in the same headline", () => {
  assert.equal(classify("Affiliate network weighs sale, seeks buyer to acquire it").type, "for_sale");
});

test("extracts buyer and target in active and passive voice", () => {
  assert.deepEqual(extractParties("Acme Ads Acquires Pixelshelf, a Retail Media Startup, for $45 Million"), { buyer: "Acme Ads", target: "Pixelshelf" });
  assert.deepEqual(extractParties("Martech Firm Signalwise Acquired by Brightpath Holdings"), { buyer: "Brightpath Holdings", target: "Signalwise" });
  assert.deepEqual(extractParties("Kargo snaps up CTV startup Parsec"), { buyer: "Kargo", target: "Parsec" });
  assert.deepEqual(extractParties("Pubmatic agrees to acquire Mobile Ad Network Martin in all-cash deal"), { buyer: "Pubmatic", target: "Martin" });
});

test("cleanCompany strips descriptors but keeps names", () => {
  assert.equal(cleanCompany("Lead Gen Platform FormFunnel"), "FormFunnel");
  assert.equal(cleanCompany("The Trade Desk"), "The Trade Desk");
  assert.equal(cleanCompany("Acme Ads"), "Acme Ads");
});

test("extracts deal size", () => {
  assert.equal(extractDealSize("for $45 Million").amount_usd, 45e6);
  assert.equal(extractDealSize("raises $12M Series A").amount_usd, 12e6);
  assert.equal(extractDealSize("in $1.9B take-private").amount_usd, 1.9e9);
  assert.equal(extractDealSize("a $28 billion deal").amount_usd, 28e9);
  assert.equal(extractDealSize("$2,500,000 seed").amount_usd, 2.5e6);
  assert.equal(extractDealSize("€10 million").currency, "EUR");
  assert.equal(extractDealSize("no money here"), null);
  assert.equal(extractDealSize("costs $5"), null);
});

test("DN fit: in-lane sellers and mid-size deals outrank mega deals and off-topic news", () => {
  const sale = sig("Affiliate Network LinkLoop Exploring Sale");
  const mid = sig("Acme Ads Acquires Retail Media Startup Pixelshelf for $45 Million");
  const mega = sig("Megacorp Agrees to Buy Global Telecom Giant in $28 Billion Deal");
  const offTopic = sig("Ten Holiday Recipes Our Editors Love");
  const megaTarget = sig("Google explores sale of ad tech unit");
  assert.ok(mid.dn_fit >= 80, `mid ${mid.dn_fit}`);
  assert.ok(sale.dn_fit >= 70, `sale ${sale.dn_fit}`);
  assert.ok(mega.dn_fit < 40, `mega ${mega.dn_fit}`);
  assert.ok(offTopic.dn_fit < 20, `off ${offTopic.dn_fit}`);
  assert.ok(megaTarget.dn_fit < sale.dn_fit);
  for (const s of [sale, mid, mega, offTopic]) assert.ok(s.dn_fit >= 0 && s.dn_fit <= 100);
});

test("known ad tech companies map to a segment without keywords", () => {
  assert.deepEqual(sig("LiveRamp lays off 10% of staff").segments, ["ad tech"]);
});

test("repeat acquirers get a boost", () => {
  const items = [
    { title: "Acme Ads acquires Pixelshelf", link: "https://x/1", date: "2026-11-01T00:00:00Z" },
    { title: "Acme Ads acquires Bidly, a programmatic startup", link: "https://x/2", date: "2026-11-02T00:00:00Z" },
  ];
  const first = buildSignals(items);
  const known = activeAcquirers([first]);
  assert.ok(known.has("acme ads"));
  const second = buildSignals(items, { knownAcquirers: known });
  const b = second.find((s) => s.target === "Bidly");
  assert.ok(b.fit_reasons.some((r) => r.includes("repeat acquirer")));
  assert.ok(b.dn_fit > first.find((s) => s.target === "Bidly").dn_fit);
});

test("signal record holds only headline, link, date and our own summary (no source text)", () => {
  const s = toSignal({ title: "LinkLoop Exploring Sale", snippet: "SECRET SNIPPET TEXT from the article", link: "https://x/l", date: null, source: "S" });
  const json = JSON.stringify(s);
  assert.ok(!json.includes("SECRET SNIPPET"));
  assert.ok(!("snippet" in s));
  assert.match(s.summary, /^For sale/);
  assert.ok(s.why_dn.length > 10);
  assert.equal(s.method, "rules");
});
