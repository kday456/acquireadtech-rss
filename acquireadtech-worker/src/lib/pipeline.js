import { SOURCES, DEFAULT_USER_AGENT } from "./sources.js";
import { fetchAllFeeds, dedupeItems } from "./feeds.js";
import { fetchEdgar } from "./edgar.js";
import { buildSignals, activeAcquirers } from "./signals.js";
import { refineWithLlm } from "./llm.js";

export const SCHEMA_VERSION = 1;

export function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/** Keep items published within `windowDays` of `now` (undated items are kept). */
export function inWindow(items, now, windowDays) {
  const cutoff = new Date(now).getTime() - windowDays * 86400000;
  return items.filter((it) => !it.date || new Date(it.date).getTime() >= cutoff);
}

/**
 * Fetch sources (or use provided `items`), classify, score, optionally refine
 * with an LLM. Returns the JSON document written to data/signals-YYYY-MM-DD.json.
 */
export async function runPipeline({
  now = new Date(),
  windowDays = 3,
  sources = SOURCES,
  items: providedItems = null,
  env = {},
  fetchImpl = fetch,
  history = [],
  edgar = true,
  log = () => {},
} = {}) {
  const errors = [];
  let items = [];
  if (providedItems) {
    items = providedItems;
  } else {
    const feeds = await fetchAllFeeds(sources, { userAgent: env.FEED_USER_AGENT || DEFAULT_USER_AGENT, fetchImpl });
    items.push(...feeds.items);
    errors.push(...feeds.errors);
    if (edgar && env.DN_EDGAR !== "0") {
      const end = isoDay(now);
      const start = isoDay(new Date(now).getTime() - windowDays * 86400000);
      const ed = await fetchEdgar({ userAgent: env.SEC_USER_AGENT, startDate: start, endDate: end, fetchImpl });
      items.push(...ed.items);
      errors.push(...ed.errors);
    }
  }
  items = inWindow(dedupeItems(items), now, windowDays);
  log(`items in window: ${items.length}; source errors: ${errors.length}`);

  // Active acquirers = buyers seen in >= 2 acquisition signals across history + today.
  const firstPass = buildSignals(items);
  const known = activeAcquirers([...history, firstPass]);
  let signals = buildSignals(items, { knownAcquirers: known });

  const llm = await refineWithLlm(signals, items, { env, knownAcquirers: known, log });
  signals = llm.signals;

  const counts = { items: items.length };
  for (const s of signals) counts[s.signal_type] = (counts[s.signal_type] || 0) + 1;

  return {
    schema_version: SCHEMA_VERSION,
    date: isoDay(now),
    generated_at: new Date(now).toISOString(),
    window_days: windowDays,
    sources: [...sources.map((s) => s.id), ...(edgar && !providedItems ? ["sec-edgar"] : [])],
    counts,
    errors,
    llm: llm.stats,
    active_acquirers: [...known],
    signals,
  };
}
