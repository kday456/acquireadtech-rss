import { SOURCES, DEFAULT_USER_AGENT } from "./lib/sources.js";
import { fetchAllFeeds } from "./lib/feeds.js";
import { runPipeline } from "./lib/pipeline.js";
import { renderBrief } from "./lib/brief.js";

const CACHE_SECONDS = 900;

export function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Strip characters that are illegal in XML 1.0.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** One valid RSS 2.0 document with headline, link, date and source only. */
export function renderRss(items, selfUrl) {
  const body = items
    .map(
      (it) => `    <item>
      <title>${xmlEscape(it.title)}</title>
      <link>${xmlEscape(it.link)}</link>
      <guid isPermaLink="true">${xmlEscape(it.link)}</guid>
      ${it.date ? `<pubDate>${new Date(it.date).toUTCString()}</pubDate>` : ""}
      <source url="${xmlEscape(selfUrl)}">${xmlEscape(it.source)}</source>
    </item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Acquire AdTech M&amp;A Feed</title>
    <link>${xmlEscape(selfUrl)}</link>
    <description>Ad tech and mar tech M&amp;A headlines merged from public feeds. Links go to the original publishers.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${body}
  </channel>
</rss>
`;
}

// Public shape: never re-serve feed descriptions or article bodies.
const publicItem = ({ title, link, date, source }) => ({ title, link, date, source });

async function cached(request, ctx, build) {
  const cache = globalThis.caches?.default;
  if (cache) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  const resp = await build();
  resp.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
  if (cache && resp.ok) ctx?.waitUntil?.(cache.put(request, resp.clone()));
  return resp;
}

export default {
  async fetch(request, env = {}, ctx) {
    const url = new URL(request.url);
    const opts = { userAgent: env.FEED_USER_AGENT || DEFAULT_USER_AGENT };

    if (url.pathname.endsWith("/rss.xml")) {
      return cached(request, ctx, async () => {
        const { items, errors } = await fetchAllFeeds(SOURCES, opts);
        return new Response(renderRss(items, url.origin + "/rss.xml"), {
          headers: { "Content-Type": "application/rss+xml; charset=utf-8", "X-Source-Errors": String(errors.length) },
        });
      });
    }

    if (url.pathname.endsWith("/json")) {
      return cached(request, ctx, async () => {
        const { items, errors } = await fetchAllFeeds(SOURCES, opts);
        return Response.json({ items: items.map(publicItem), errors });
      });
    }

    if (url.pathname.endsWith("/signals") || url.pathname.endsWith("/brief.md")) {
      return cached(request, ctx, async () => {
        // The Worker never calls an LLM; that step is batch-only (scripts/daily.js).
        const doc = await runPipeline({ env: { ...env, DN_LLM_ENABLED: "0" } });
        if (url.pathname.endsWith("/signals")) return Response.json(doc);
        return new Response(renderBrief(doc.signals, { date: doc.date, errors: doc.errors }), {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      });
    }

    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Acquire AdTech M&amp;A Feed</title></head><body>
<h1>Acquire AdTech M&amp;A Feed</h1>
<ul>
<li><a href="/rss.xml">RSS</a> (merged headlines)</li>
<li><a href="/json">JSON</a> (headline, link, date, source)</li>
<li><a href="/signals">Deal signals JSON</a> and <a href="/brief.md">Top 10 brief</a></li>
</ul></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
