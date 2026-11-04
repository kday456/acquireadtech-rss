import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, dedupeItems, normalizeUrl, cleanText, fetchAllFeeds } from "../src/lib/feeds.js";
import { fixture, fakeFetch } from "./helpers.js";

test("parses RSS 2.0 items with CDATA and dates", () => {
  const items = parseFeed(fixture("rss-sample.xml"), { id: "x", name: "X News" });
  assert.equal(items.length, 8);
  assert.equal(items[0].title, "Acme Ads Acquires Pixelshelf, a Retail Media Startup, for $45 Million");
  assert.equal(items[0].link, "https://news.example.com/2026/11/acme-ads-acquires-pixelshelf");
  assert.equal(items[0].date, "2026-11-03T14:00:00.000Z");
  assert.equal(items[0].source, "X News");
  assert.match(items[0].snippet, /retail media platform Pixelshelf/);
});

test("parses Atom entries and alternate links", () => {
  const items = parseFeed(fixture("atom-sample.xml"), { id: "a" });
  assert.equal(items.length, 2);
  assert.equal(items[0].link, "https://atom.example.com/signalwise-acquired");
  assert.equal(items[0].date, "2026-11-03T11:00:00.000Z");
});

test("never reads full article content", () => {
  const all = [...parseFeed(fixture("rss-sample.xml")), ...parseFeed(fixture("atom-sample.xml"))];
  assert.ok(!JSON.stringify(all).includes("MUST NEVER BE STORED"));
});

test("decodes entities and strips tags", () => {
  assert.equal(cleanText("<![CDATA[<b>M&amp;A</b> &#8217;s &#x2014; ok]]>"), "M&A ’s — ok");
  assert.equal(cleanText("&lt;p&gt;Hi&lt;/p&gt;"), "Hi");
});

test("normalizeUrl drops tracking params and hash", () => {
  assert.equal(normalizeUrl("https://a.com/x?utm_source=rss&id=2#top"), "https://a.com/x?id=2");
});

test("dedupe keeps earliest report and returns newest first", () => {
  const items = dedupeItems([
    ...parseFeed(fixture("rss-sample.xml"), { name: "RSS" }),
    ...parseFeed(fixture("atom-sample.xml"), { name: "Atom" }),
  ]);
  const acme = items.filter((i) => /Pixelshelf/.test(i.title));
  assert.equal(acme.length, 1);
  assert.equal(acme[0].source, "RSS");
  for (let i = 1; i < items.length; i++) assert.ok((items[i - 1].date || "") >= (items[i].date || ""));
});

test("fetchAllFeeds reports failures instead of swallowing them", async () => {
  const f = fakeFetch((u) => (u.includes("good") ? fixture("rss-sample.xml") : u.includes("404") ? { status: 404 } : new Error("boom")));
  const { items, errors } = await fetchAllFeeds(
    [{ id: "good", url: "https://good/" }, { id: "nf", url: "https://404/" }, { id: "down", url: "https://down/" }],
    { fetchImpl: f, userAgent: "test" }
  );
  assert.equal(items.length, 8);
  assert.deepEqual(errors.map((e) => [e.source, e.error]), [["nf", "HTTP 404"], ["down", "boom"]]);
  assert.equal(f.calls[0].init.headers["User-Agent"], "test");
});
