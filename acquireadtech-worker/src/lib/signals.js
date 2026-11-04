// Rules-first "deal signals" layer: classify, extract, score.
// No network, no paid APIs. Pure functions so they run in Workers and Node.

export const SIGNAL_TYPES = ["for_sale", "acquisition", "shutdown", "layoffs", "funding", "exec_change"];

export const SIGNAL_LABELS = {
  for_sale: "For sale / exploring options",
  acquisition: "Acquisition",
  funding: "Funding",
  exec_change: "Exec change",
  layoffs: "Layoffs",
  shutdown: "Shutdown",
  other: "Other",
};

// Order matters only for tie-breaks: earlier = more important to DN.
const SIGNAL_PATTERNS = {
  for_sale: [
    /\bexplor(es|ing|e)\s+(a\s+|potential\s+|possible\s+)?(sale|sell|options|strategic\s+(alternatives|options))/i,
    /\bstrategic\s+(review|alternatives)\b/i,
    /\b(up|put)\s+for\s+sale\b/i,
    /\bfor\s+sale\b/i,
    /\b(seeks?|seeking|looking\s+for)\s+(a\s+)?(buyer|acquirer|suitor)s?\b/i,
    /\bhires?\s+(investment\s+)?(bankers?|advis[eo]rs?)\b/i,
    /\b(weighs|weighing|considers|considering|mulls|mulling)\s+(a\s+)?(sale|selling|sell)\b/i,
    /\bsale\s+process\b/i,
    /\bon\s+the\s+(auction\s+)?block\b/i,
  ],
  acquisition: [
    /\bacquir(es|ed|ing|e)\b/i,
    /\bacquisitions?\b/i,
    /\b(to\s+)?(buys?|bought|buying)\b/i,
    /\bmerg(e|es|ed|er|ing)\b/i,
    /\btakeover\b/i,
    /\btake[s-]?\s+private\b/i,
    /\b(snaps?|snapped|scoops?|scooped)\s+up\b/i,
    /\btuck-?in\b/i,
    /\broll-?up\b/i,
    /\bsold\s+to\b/i,
  ],
  shutdown: [
    /\bshut(s|ting)?\s+down\b/i,
    /\bshutter(s|ed|ing)?\b/i,
    /\bwind(s|ing)?\s+down\b/i,
    /\bceas(e|es|ing)\s+operations\b/i,
    /\bbankrupt(cy)?\b/i,
    /\bchapter\s+(7|11)\b/i,
    /\binsolven(t|cy)\b/i,
    /\bliquidat(e|es|ion|ing)\b/i,
    /\b(closes|closing)\s+(its\s+)?doors\b/i,
  ],
  layoffs: [
    /\blay(s|ing)?\s*-?\s*offs?\b/i,
    /\blaid\s+off\b/i,
    /\bjob\s+cuts?\b/i,
    /\bcut(s|ting)?\s+(\d+%?\s+)?(of\s+)?(its\s+)?(staff|jobs|workforce|employees|headcount)\b/i,
    /\brestructur(e|es|ing)\b/i,
    /\bdownsiz(e|es|ing)\b/i,
    /\breduction\s+in\s+force\b/i,
  ],
  funding: [
    /\brais(es|ed|ing)\s+(\$|€|£|\d)/i,
    /\braises?\b.*\b(round|funding|series|seed)\b/i,
    /\bfunding\b/i,
    /\bseries\s+[a-f]\b/i,
    /\bseed\s+(round|funding)\b/i,
    /\bgrowth\s+(equity|investment)\b/i,
    /\bsecures?\s+(\$|€|£)/i,
    /\b(minority|strategic)\s+investment\b/i,
  ],
  exec_change: [
    /\b(names|named|appoints|appointed|hires|hired|taps|tapped|promotes|promoted)\b.*\b(ceo|cfo|coo|cro|cto|cmo|president|chief\s+\w+\s+officer|chair(man|woman)?)\b/i,
    /\bnew\s+(ceo|cfo|coo|cro|cto|president|chief\s+\w+\s+officer)\b/i,
    /\b(ceo|cfo|coo|cro|founder|president)\b.*\b(steps?\s+down|resigns?|departs?|exits?|leaves|ousted|retires?)\b/i,
    /\b(steps?\s+down|resigns?)\s+as\s+(ceo|cfo|president|chief)/i,
  ],
};

// DN focus segments. "strong" match = in DN's wheelhouse.
export const SEGMENTS = {
  "ad tech": [
    /\bad\s?tech\b/i, /\badvertising\s+technology\b/i, /\bprogrammatic\b/i, /\b(ssp|dsp)s?\b/i,
    /\bsupply[- ]side\s+platform\b/i, /\bdemand[- ]side\s+platform\b/i, /\bad\s+(network|exchange|server|serving|platform|verification|fraud)s?\b/i,
    /\bheader\s+bidding\b/i, /\bpublisher\s+monetization\b/i, /\bidentity\s+(graph|resolution|solution)\b/i,
    /\bcookieless\b/i, /\battribution\b/i, /\bad\s+measurement\b/i, /\bcontextual\s+(advertising|targeting)\b/i,
    /\bdigital\s+advertising\b/i, /\bclean\s+room\b/i,
  ],
  "mar tech": [
    /\bmar\s?tech\b/i, /\bmarketing\s+(technology|tech|automation|cloud|platform|software)\b/i,
    /\bcustomer\s+data\s+platform\b/i, /\bcdps?\b/i, /\bemail\s+marketing\b/i, /\bcustomer\s+engagement\b/i,
    /\bsocial\s+media\s+management\b/i, /\bpersonalization\b/i,
  ],
  affiliate: [/\baffiliate\b/i, /\bperformance\s+marketing\b/i, /\bpartner(ship)?\s+marketing\b/i, /\binfluencer\s+(marketing|platform)\b/i, /\bcreator\s+economy\b/i],
  "lead gen": [/\blead[- ]?gen(eration)?\b/i, /\bpay[- ]per[- ](call|lead)\b/i, /\bcustomer\s+acquisition\s+platform\b/i],
  CTV: [/\bctv\b/i, /\bconnected\s+tv\b/i, /\bott\b/i, /\bstreaming\s+(ads?|advertising|tv)\b/i, /\bfast\s+channels?\b/i, /\baddressable\s+tv\b/i],
  "retail media": [/\bretail\s+media\b/i, /\bcommerce\s+media\b/i, /\bshoppable\b/i, /\bin-?store\s+media\b/i],
  "app monetization": [/\bapp\s+monetization\b/i, /\bmobile\s+(ad|advertising|marketing|game)s?\b/i, /\bin-?app\b/i, /\bmediation\b/i, /\bmobile\s+measurement\b/i, /\bapp\s+(marketing|growth|install)s?\b/i, /\boffer\s?wall\b/i],
};

// Well-known ad tech / mar tech names, so headlines without sector keywords
// ("The Trade Desk names new CFO") still map to a segment. Extend freely.
export const KNOWN_COMPANIES = {
  "ad tech": ["the trade desk", "trade desk", "pubmatic", "magnite", "criteo", "liveramp", "integral ad science", "ias", "doubleverify",
    "outbrain", "teads", "taboola", "viant", "mediaocean", "innovid", "flashtalking", "index exchange", "openx", "sovrn", "kargo",
    "nexxen", "tremor", "zeta global", "stackadapt", "basis technologies", "quantcast", "adform", "equativ", "sharethrough",
    "triplelift", "gumgum", "seedtag", "madhive", "simpli.fi", "mntn", "illumin", "perion", "digital turbine", "verve", "mobilefuse"],
  "mar tech": ["braze", "klaviyo", "iterable", "attentive", "bloomreach", "sprinklr", "hubspot", "zeta", "cordial", "movable ink", "amperity"],
  affiliate: ["impact.com", "partnerize", "awin", "rakuten advertising", "cj affiliate", "everflow", "tune", "skimlinks", "sovrn commerce"],
  CTV: ["vizio", "roku", "samba tv", "ispot", "wurl", "frequency", "simulmedia", "tvision"],
  "app monetization": ["applovin", "unity ads", "ironsource", "liftoff", "moloco", "appsflyer", "adjust", "singular", "branch", "digital turbine"],
  "retail media": ["pacvue", "skai", "citrus ad", "citrusad", "koddi", "topsort", "criteo retail media", "rokt"],
};

const WEAK_SECTOR = [/\badvertis(ing|er|ers)\b/i, /\bmarketing\b/i, /\bagency\b/i, /\bmedia\b/i, /\bpublisher\b/i, /\bads?\b/i, /\bcommerce\b/i, /\banalytics\b/i, /\bdata\b/i];

// Mega-caps rarely hire boutique advisors; as targets they are outside DN's lane.
const MEGA_CAPS = /\b(google|alphabet|meta|facebook|amazon|microsoft|apple|comcast|disney|netflix|oracle|salesforce|adobe|verizon|at&t|walmart|paramount|warner\s+bros|omnicom|interpublic|wpp|publicis|dentsu|havas)\b/i;

// Words that describe a company rather than name it ("Retail Media Startup Pixelshelf").
const DESCRIPTOR = new Set(
  ("a an ad ads adtech ad-tech advertising martech mar-tech marketing tech technology data analytics measurement ctv ott " +
    "connected tv streaming retail commerce media mobile app apps in-app affiliate performance lead gen lead-gen generation " +
    "programmatic ssp dsp platform platforms network networks startup start-up firm company provider vendor agency " +
    "exchange marketplace software saas giant specialist player maker developer owner operator holding group unit " +
    "identity attribution email influencer creator video audio podcast digital online global uk us u.s. european israeli " +
    "french german canadian australian indian chinese japanese british american customer cdp publisher monetization " +
    "rival competitor parent").split(/\s+/)
);

const STOP_AFTER = /\s*(?:,|;|:|\s[-–—]\s|\s\(|\b(?:for|in|from|to|at|amid|after|as|with|on|over|and\s+(?:its|their)|valued|worth|reportedly|report|sources|says?)\b)/i;

const ACQ_FORWARD = /^(.+?)\s+(?:has\s+|have\s+)?(?:agrees?\s+to\s+(?:acquire|buy)|to\s+(?:acquire|buy)|acquires|acquired|buys|bought|snaps\s+up|snapped\s+up|scoops\s+up|scooped\s+up|completes\s+(?:its\s+)?acquisition\s+of|closes\s+(?:its\s+)?acquisition\s+of|announces\s+(?:the\s+)?acquisition\s+of|picks\s+up|takes\s+over|is\s+acquiring|acquiring|merges\s+with|to\s+merge\s+with)\s+(.+)$/i;
const ACQ_PASSIVE = /^(.+?)\s+(?:is\s+|has\s+been\s+|was\s+|to\s+be\s+)?(?:acquired|bought|purchased|sold|snapped\s+up|picked\s+up)\s+(?:by|to)\s+(.+)$/i;
const MERGE = /^(.+?)\s+and\s+(.+?)\s+(?:to\s+)?merge\b/i;

const SUBJECT_VERB = /\s+(?:is\s+|has\s+|have\s+)?(?:raises?|raised|secures?|closes?|lands?|nabs?|explor(?:es|ing)|weighs|considers|mulls|hires?|names|appoints|taps|promotes|lays?\s+off|cuts?|to\s+cut|to\s+lay|to\s+shut|shuts?|shutters?|to\s+shutter|winds?\s+down|to\s+wind|files?|ceases?|puts?|seeks?|announces?|says|launches|ceo|cfo|founder|co-?founder|chief|president|in\s+talks|could|may|might|will|reportedly|up\s+for|on\s+the\s+block)\b/i;

function isCapitalized(tok) {
  return /^[A-Z0-9$&]/.test(tok) || /^[a-z]+[A-Z]/.test(tok); // allow camelCase brands (e.g. "iSpot")
}

/** Turn a noun phrase into a company name by dropping descriptors and trailing clauses. */
export function cleanCompany(phrase) {
  if (!phrase) return null;
  let p = String(phrase).split(STOP_AFTER)[0].trim();
  p = p.replace(/^['"“‘]+|['"”’.,]+$/g, "").replace(/['’]s$/i, "").trim();
  let toks = p.split(/\s+/).filter(Boolean);
  while (toks.length > 1 && DESCRIPTOR.has(toks[0].toLowerCase().replace(/[^a-z.-]/g, ""))) toks.shift();
  // Keep the leading run of capitalized tokens (company names are proper nouns).
  const run = [];
  for (const t of toks) {
    if (!isCapitalized(t) && run.length) break;
    if (isCapitalized(t)) run.push(t);
  }
  const name = run.join(" ").replace(/[,.;:]+$/, "").trim();
  if (!name || name.length < 2 || DESCRIPTOR.has(name.toLowerCase())) return null;
  if (run.length > 6) return null;
  return name;
}

export function extractParties(title) {
  const t = String(title).replace(/\s+/g, " ").trim();
  let m = t.match(ACQ_PASSIVE);
  if (m && !/\bacquires|buys\b/i.test(m[1])) return { target: cleanCompany(m[1]), buyer: cleanCompany(m[2]) };
  m = t.match(MERGE);
  if (m) return { buyer: null, target: null, parties: [cleanCompany(m[1]), cleanCompany(m[2])].filter(Boolean) };
  m = t.match(ACQ_FORWARD);
  if (m) return { buyer: cleanCompany(m[1]), target: cleanCompany(m[2]) };
  return { buyer: null, target: null };
}

export function extractSubject(title) {
  const t = String(title).replace(/\s+/g, " ").trim();
  const m = t.split(SUBJECT_VERB);
  if (m.length > 1) return cleanCompany(m[0]);
  return null;
}

const SIZE_RE = /(?:US)?([$€£])\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(billion|bn|b|million|mn|mm|m|thousand|k)?\b/i;
const FX = { $: 1, "€": 1.08, "£": 1.27 }; // rough; only used for size buckets

export function extractDealSize(text) {
  const m = String(text || "").match(SIZE_RE);
  if (!m) return null;
  const n = parseFloat(m[2].replace(/,/g, ""));
  const unit = (m[3] || "").toLowerCase();
  const mult = { billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, mn: 1e6, mm: 1e6, m: 1e6, thousand: 1e3, k: 1e3 }[unit] || 1;
  const amount = n * mult;
  if (amount < 1e5) return null; // "$5" on its own is noise, not a deal size
  return { text: m[0].trim(), amount_usd: Math.round(amount * (FX[m[1]] || 1)), currency: { $: "USD", "€": "EUR", "£": "GBP" }[m[1]] };
}

export function classify(title, snippet = "") {
  const scores = {};
  const matched = {};
  for (const type of SIGNAL_TYPES) {
    let s = 0;
    for (const re of SIGNAL_PATTERNS[type]) {
      if (re.test(title)) { s += 2; (matched[type] ||= []).push(re.source); }
      else if (snippet && re.test(snippet)) { s += 1; (matched[type] ||= []).push(re.source); }
    }
    if (s) scores[type] = s;
  }
  // "acquisition" verbs inside a for-sale story ("exploring sale to a buyer") should not win.
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || SIGNAL_TYPES.indexOf(a[0]) - SIGNAL_TYPES.indexOf(b[0]));
  if (scores.for_sale && ranked[0][0] !== "for_sale" && scores.for_sale >= 2) ranked.unshift(["for_sale", scores.for_sale]);
  const type = ranked.length ? ranked[0][0] : "other";
  const top = ranked.length ? ranked[0][1] : 0;
  return {
    type,
    all: [...new Set(ranked.map((r) => r[0]))],
    confidence: top >= 4 ? "high" : top >= 2 ? "medium" : top > 0 ? "low" : "none",
  };
}

export function detectSegments(text, companies = []) {
  const segs = [];
  for (const [seg, res] of Object.entries(SEGMENTS)) if (res.some((re) => re.test(text))) segs.push(seg);
  const names = companies.map((c) => c.toLowerCase());
  for (const [seg, list] of Object.entries(KNOWN_COMPANIES)) {
    if (!segs.includes(seg) && names.some((n) => list.includes(n))) segs.push(seg);
  }
  const weak = !segs.length && WEAK_SECTOR.some((re) => re.test(text));
  return { segments: segs, weak };
}

const TYPE_POINTS = { for_sale: 30, acquisition: 25, shutdown: 18, layoffs: 15, funding: 12, exec_change: 10, other: 0 };

/**
 * DN fit 0-100 = sector (0-40) + signal (0-30) + size (-20..+20) + roles (0-10).
 * Sellers and active acquirers score high; mega deals and off-sector news score low.
 */
export function scoreFit({ type, segments, weakSector, dealSize, buyer, target, companies = [], knownAcquirers = new Set() }) {
  const reasons = [];
  let score = 0;

  if (segments.length) { score += segments.length > 1 ? 40 : 35; reasons.push(`in focus segment: ${segments.join(", ")}`); }
  else if (weakSector) { score += 12; reasons.push("adjacent sector (media/marketing)"); }
  else reasons.push("no ad tech / mar tech segment detected");

  score += TYPE_POINTS[type] ?? 0;
  if (type !== "other") reasons.push(`${SIGNAL_LABELS[type].toLowerCase()} signal`);

  const amt = dealSize?.amount_usd;
  if (amt == null) { score += 8; reasons.push("size undisclosed (often small/mid)"); }
  else if (amt < 5e6) { score += 10; reasons.push("small deal (<$5M)"); }
  else if (amt <= 500e6) { score += 20; reasons.push("mid-market size ($5M-$500M)"); }
  else if (amt <= 2e9) { score += 5; reasons.push("upper mid-market ($500M-$2B)"); }
  else { score -= 20; reasons.push("mega deal (>$2B), outside DN's lane"); }

  const megaTarget = (target && MEGA_CAPS.test(target)) || (!target && companies.some((c) => MEGA_CAPS.test(c)) && type !== "acquisition");
  if (megaTarget) { score -= 15; reasons.push("mega-cap subject"); }

  if (target && type === "acquisition") { score += 4; reasons.push("target identified (peer sellers may be in play)"); }
  if (buyer) {
    score += 4;
    if (knownAcquirers.has(buyer.toLowerCase())) { score += 6; reasons.push(`repeat acquirer: ${buyer}`); }
    else reasons.push(`buyer identified: ${buyer}`);
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

const WHY = {
  for_sale: (s) => `${s.target || s.companies[0] || "Company"} appears to be in market: pitch a sell-side mandate or bring vetted buyers.`,
  acquisition: (s) =>
    s.buyer
      ? `${s.buyer} is actively buying${s.segments[0] ? ` in ${s.segments[0]}` : ""}: add to buyer list and pitch adjacent targets; ${s.target ? `${s.target}'s` : "the target's"} competitors may now be in play.`
      : `Consolidation in ${s.segments[0] || "the space"}: competitors of the target may now be open to a sale.`,
  shutdown: (s) => `${s.companies[0] || "Company"} winding down: tech, customer contracts or team may be acquirable. Match with buyers quickly.`,
  layoffs: (s) => `${s.companies[0] || "Company"} is cutting costs, which can come before a sale or recap. Check runway and open a conversation.`,
  funding: (s) => `${s.companies[0] || "Company"} newly funded: a future tuck-in buyer now, a seller in 2-4 years. Start the relationship.`,
  exec_change: (s) => `New leadership at ${s.companies[0] || "the company"} often triggers a strategic review: early sell-side or buy-side conversation.`,
  other: () => "Market context only.",
};

function fmtUsd(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n % 1e9 ? 1 : 0)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`;
  return `$${Math.round(n / 1e3)}K`;
}

/** Our own one-line summary, generated from extracted fields (never copied article text). */
export function summarize(s) {
  const label = SIGNAL_LABELS[s.signal_type];
  const seg = s.segments.length ? ` (${s.segments.join(", ")})` : "";
  const size = s.deal_size ? `, ${fmtUsd(s.deal_size.amount_usd)}` : "";
  if (s.signal_type === "acquisition" && (s.buyer || s.target)) {
    return `${label}: ${s.buyer || "undisclosed buyer"} acquiring ${s.target || "undisclosed target"}${size}${seg}`.replace(/\.+$/, "") + ".";
  }
  const who = s.companies.length ? s.companies.join(" / ") : "Unnamed company";
  return `${label}: ${who}${size}${seg}`.replace(/\.+$/, "") + ".";
}

export function hashId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Build a full signal record for one item. Output never includes the feed snippet. */
export function toSignal(item, { knownAcquirers = new Set() } = {}) {
  const text = `${item.title} ${item.snippet || ""}`;
  const cls = item.hint?.type ? { type: item.hint.type, all: [item.hint.type], confidence: "high" } : classify(item.title, item.snippet);
  const parties = cls.type === "acquisition" || cls.all.includes("acquisition") ? extractParties(item.title) : { buyer: null, target: null };
  const buyer = item.hint?.buyer ?? parties.buyer ?? null;
  const target = item.hint?.target ?? parties.target ?? null;
  const companies = [...new Set([buyer, target, ...(parties.parties || []), ...(item.hint?.companies || []), extractSubject(item.title)].filter(Boolean))];
  const seg = detectSegments(`${text} ${item.hint?.sector || ""}`, companies);
  const dealSize = extractDealSize(item.title) || extractDealSize(item.snippet);
  const fit = scoreFit({ type: cls.type, segments: seg.segments, weakSector: seg.weak, dealSize, buyer, target, companies, knownAcquirers });
  if (item.hint?.penalty) {
    fit.score = Math.max(0, fit.score - item.hint.penalty.points);
    fit.reasons.push(item.hint.penalty.reason);
    cls.confidence = "low";
  }

  const s = {
    id: hashId(item.link),
    date: item.date,
    source: item.source,
    headline: item.title,
    link: item.link,
    signal_type: cls.type,
    signal_label: SIGNAL_LABELS[cls.type],
    signals_all: cls.all,
    confidence: cls.confidence,
    companies,
    buyer,
    target,
    deal_size: dealSize,
    segments: seg.segments,
    dn_fit: fit.score,
    fit_reasons: fit.reasons,
    method: "rules",
  };
  s.summary = summarize(s);
  s.why_dn =
    item.sourceId === "sec-edgar"
      ? `${companies[0] || "Public filer"} filed an M&A-type 8-K: open the filing to identify the counterparty; both sides are buyer/seller leads.`
      : WHY[cls.type](s);
  return s;
}

export function buildSignals(items, opts = {}) {
  return items
    .map((it) => toSignal(it, opts))
    .sort((a, b) => b.dn_fit - a.dn_fit || (b.date || "").localeCompare(a.date || ""));
}

/** Buyers that appear in >= minDeals acquisition signals (history + today). */
export function activeAcquirers(signalLists, minDeals = 2) {
  const counts = new Map();
  for (const list of signalLists) for (const s of list || []) {
    if (s.signal_type === "acquisition" && s.buyer) counts.set(s.buyer.toLowerCase(), (counts.get(s.buyer.toLowerCase()) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= minDeals).map(([k]) => k));
}
