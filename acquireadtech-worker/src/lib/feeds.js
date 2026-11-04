// Minimal, dependency-free RSS 2.0 / Atom parser that runs in both
// Cloudflare Workers (no DOMParser) and Node 18+.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripCdata(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

export function cleanText(s) {
  if (s == null) return "";
  return decodeEntities(stripCdata(s).replace(/<[^>]+>/g, " "))
    .replace(/<[^>]+>/g, " ") // tags that were entity-encoded
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = block.match(re);
  return m ? m[1] : null;
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const attr = (a, n) => (a.match(new RegExp(`${n}\\s*=\\s*["']([^"']*)["']`, "i")) || [])[1];
  const alt = links.find((a) => !attr(a, "rel") || attr(a, "rel") === "alternate");
  return alt ? decodeEntities(attr(alt, "href") || "") : "";
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref)$/i;

export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) url.searchParams.delete(k);
    url.hash = "";
    return url.toString();
  } catch {
    return String(u || "").trim();
  }
}

export function toIsoDate(s) {
  if (!s) return null;
  const d = new Date(cleanText(s));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse an RSS or Atom document into normalized items.
 * Returned `snippet` is the feed's own short description, kept in memory only
 * for classification; callers must not persist or re-serve it.
 * Full-content fields (content:encoded, atom:content) are never read.
 */
export function parseFeed(xml, source = {}) {
  const text = String(xml || "");
  const items = [];
  const isAtom = /<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(text) && !/<rss\b/i.test(text);
  const blocks = isAtom
    ? [...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...text.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);

  for (const b of blocks) {
    const title = cleanText(tag(b, "title"));
    const link = isAtom ? atomLink(b) : cleanText(tag(b, "link")) || cleanText(tag(b, "guid"));
    const date = toIsoDate(
      isAtom ? tag(b, "published") || tag(b, "updated") : tag(b, "pubDate") || tag(b, "dc:date")
    );
    const snippet = cleanText(isAtom ? tag(b, "summary") : tag(b, "description")).slice(0, 400);
    if (!title || !link) continue;
    items.push({
      title,
      link: normalizeUrl(link),
      date,
      source: source.name || source.id || "",
      sourceId: source.id || "",
      snippet,
    });
  }
  return items;
}

export function titleKey(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** De-duplicate by normalized link and normalized headline; result is newest first. */
export function dedupeItems(items) {
  const seenLinks = new Set();
  const seenTitles = new Set();
  const out = [];
  // Earliest report wins (usually the original source), undated items last.
  const sorted = [...items].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  for (const it of sorted) {
    const lk = normalizeUrl(it.link);
    const tk = titleKey(it.title);
    if (seenLinks.has(lk) || seenTitles.has(tk)) continue;
    seenLinks.add(lk);
    seenTitles.add(tk);
    out.push(it);
  }
  return out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

export async function fetchText(url, { timeoutMs = 10000, userAgent, fetchImpl = fetch, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": userAgent, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5", ...headers },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all sources concurrently. Never throws: failures are returned in
 * `errors` so callers can surface them instead of silently serving nothing.
 */
export async function fetchAllFeeds(sources, opts = {}) {
  const { maxItemsPerSource = 50 } = opts;
  const results = await Promise.allSettled(
    sources.map(async (s) => parseFeed(await fetchText(s.url, opts), s).slice(0, maxItemsPerSource))
  );
  const items = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors.push({ source: sources[i].id, url: sources[i].url, error: String(r.reason?.message || r.reason) });
  });
  return { items: dedupeItems(items), errors };
}
