import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker, { renderRss } from "../src/index.js";
import { parseFeed } from "../src/lib/feeds.js";
import { fixture, fakeFetch } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("/rss.xml is one valid RSS document with headline, link, date only", async () => {
  globalThis.fetch = fakeFetch((u) => (u.includes("digiday") ? fixture("atom-sample.xml") : fixture("rss-sample.xml")));
  const resp = await worker.fetch(new Request("https://w.test/rss.xml"), {}, {});
  const xml = await resp.text();
  assert.equal((xml.match(/<\?xml/g) || []).length, 1);
  assert.equal((xml.match(/<rss\b/g) || []).length, 1);
  assert.ok(!xml.includes("MUST NEVER BE STORED"));
  assert.ok(!xml.includes("<description><![CDATA["));
  const back = parseFeed(xml);
  assert.equal(back.length, 9); // 8 RSS + 1 unique Atom entry, duplicates removed
  assert.equal(resp.headers.get("X-Source-Errors"), "0");
});

test("/json returns normalized items, no raw XML", async () => {
  globalThis.fetch = fakeFetch((u) => (u.includes("adexchanger") ? new Error("down") : fixture("rss-sample.xml")));
  const body = await (await worker.fetch(new Request("https://w.test/json"), {}, {})).json();
  assert.deepEqual(Object.keys(body.items[0]).sort(), ["date", "link", "source", "title"]);
  assert.equal(body.errors.length, 1);
  assert.ok(!JSON.stringify(body).includes("<rss"));
});

test("/signals classifies items; LLM is never called from the Worker", async () => {
  globalThis.fetch = fakeFetch(() => fixture("rss-sample.xml"));
  const doc = await (await worker.fetch(new Request("https://w.test/signals"), { DN_LLM_ENABLED: "1" }, {})).json();
  assert.ok(doc.signals.length > 0);
  assert.match(doc.llm.skipped, /DN_LLM_ENABLED/);
});

test("renderRss escapes XML special characters", () => {
  const xml = renderRss([{ title: "A & B <c>", link: "https://x/?a=1&b=2", date: null, source: "S" }], "https://w/rss.xml");
  assert.match(xml, /A &amp; B &lt;c&gt;/);
  assert.match(xml, /a=1&amp;b=2/);
});
