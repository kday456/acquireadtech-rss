// SEC EDGAR full-text search (free, no key) for 8-K filings that report
// Item 1.01 (Entry into a Material Definitive Agreement) or Item 2.01
// (Completion of Acquisition or Disposition of Assets) and mention ad tech terms.
//
// SEC fair-access rules: declare a User-Agent with a real contact
// (set SEC_USER_AGENT, e.g. "Digital Nations dealflow ops@example.com") and
// stay under 10 requests/second. We send one request per keyword, sequentially.

export const EDGAR_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";

export const EDGAR_KEYWORDS = [
  "ad tech",
  "adtech",
  "advertising technology",
  "programmatic advertising",
  "connected TV advertising",
  "retail media",
  "affiliate marketing",
  "lead generation",
  "marketing technology",
  "app monetization",
];

export const EDGAR_ITEMS = {
  "1.01": "Entry into a Material Definitive Agreement",
  "2.01": "Completion of Acquisition or Disposition of Assets",
};

export function buildEdgarUrl(keyword, startDate, endDate) {
  const u = new URL(EDGAR_SEARCH_URL);
  u.searchParams.set("q", `"${keyword}"`);
  u.searchParams.set("forms", "8-K");
  u.searchParams.set("dateRange", "custom");
  u.searchParams.set("startdt", startDate);
  u.searchParams.set("enddt", endDate);
  return u.toString();
}

export function cleanFilerName(displayName) {
  return String(displayName || "").replace(/\s*\((?:CIK\s+)?[^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

/** Convert one EFTS response into feed-like items with classification hints. */
export function parseEdgarHits(json, keyword) {
  const hits = json?.hits?.hits || [];
  const out = [];
  for (const h of hits) {
    const src = h._source || {};
    const items = (src.items || []).filter((i) => EDGAR_ITEMS[i]);
    if (!items.length) continue;
    const adsh = src.adsh || String(h._id || "").split(":")[0];
    const cik = String((src.ciks || [])[0] || "").replace(/^0+/, "");
    if (!adsh || !cik) continue;
    const filer = cleanFilerName((src.display_names || [])[0]);
    const itemText = items.map((i) => `Item ${i} (${EDGAR_ITEMS[i]})`).join(" + ");
    const only101 = !items.includes("2.01");
    out.push({
      title: `8-K ${itemText}: ${filer}`,
      link: `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, "")}/${adsh}-index.htm`,
      date: src.file_date ? new Date(`${src.file_date}T00:00:00Z`).toISOString() : null,
      source: "SEC EDGAR 8-K",
      sourceId: "sec-edgar",
      snippet: "",
      adsh,
      keywords: [keyword],
      hint: {
        type: "acquisition",
        companies: filer ? [filer] : [],
        sector: keyword,
        // Item 1.01 alone is often a credit or supply agreement, not M&A.
        penalty: only101 ? { points: 12, reason: "8-K Item 1.01 only: may be a non-M&A agreement, verify" } : null,
      },
    });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchEdgar({ userAgent, startDate, endDate, keywords = EDGAR_KEYWORDS, fetchImpl = fetch, delayMs = 250, timeoutMs = 15000 } = {}) {
  if (!userAgent) return { items: [], errors: [{ source: "sec-edgar", error: "SEC_USER_AGENT not set; skipped (SEC requires a contact User-Agent)" }] };
  const byAdsh = new Map();
  const errors = [];
  for (const kw of keywords) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(buildEdgarUrl(kw, startDate, endDate), {
        signal: ctrl.signal,
        headers: { "User-Agent": userAgent, Accept: "application/json" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      for (const it of parseEdgarHits(await resp.json(), kw)) {
        const prev = byAdsh.get(it.adsh);
        if (prev) prev.keywords.push(kw);
        else byAdsh.set(it.adsh, it);
      }
    } catch (e) {
      errors.push({ source: "sec-edgar", keyword: kw, error: String(e?.message || e) });
    } finally {
      clearTimeout(timer);
    }
    if (delayMs) await sleep(delayMs);
  }
  const items = [...byAdsh.values()].map((it) => {
    it.hint.sector = it.keywords.join(", ");
    const { adsh, keywords, ...rest } = it;
    return rest;
  });
  return { items, errors };
}
