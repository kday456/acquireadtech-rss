// OPTIONAL LLM refinement of rules-based signals. Off by default.
//
// Enable with:
//   DN_LLM_ENABLED=1  ANTHROPIC_API_KEY=...  (and `npm install` so the optional
//   @anthropic-ai/sdk dependency is present)
// Knobs:
//   DN_LLM_MAX_CALLS   hard budget of API requests per run, retries included (default 20)
//   DN_LLM_MIN_FIT     only refine signals whose rules score >= this (default 40)
//   DN_LLM_MODEL       default "claude-opus-5-5"
//
// Only the headline and the feed's own short description are sent; nothing is stored
// except the structured fields and a one-line summary the model writes.

import { toSignal } from "./signals.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["signal_type", "companies", "buyer", "target", "deal_size_usd", "one_line_summary"],
  properties: {
    signal_type: { type: "string", enum: ["acquisition", "funding", "for_sale", "exec_change", "layoffs", "shutdown", "other"] },
    companies: { type: "array", items: { type: "string" } },
    buyer: { type: ["string", "null"] },
    target: { type: ["string", "null"] },
    deal_size_usd: { type: ["number", "null"] },
    one_line_summary: { type: "string" },
  },
};

const SYSTEM =
  "You label ad tech / mar tech news for an M&A advisor. Use only the headline and blurb given. " +
  "for_sale means the company is exploring a sale, strategic alternatives, or has hired bankers. " +
  "Set buyer/target only for acquisitions or mergers, null otherwise. deal_size_usd only if a figure is stated. " +
  "one_line_summary: at most 25 words, your own words, no quotes from the source.";

export function llmConfig(env = {}) {
  return {
    enabled: env.DN_LLM_ENABLED === "1" || env.DN_LLM_ENABLED === "true",
    maxCalls: Math.max(0, parseInt(env.DN_LLM_MAX_CALLS ?? "20", 10) || 0),
    minFit: parseInt(env.DN_LLM_MIN_FIT ?? "40", 10),
    model: env.DN_LLM_MODEL || "claude-opus-5-5",
    baseDelayMs: parseInt(env.DN_LLM_BACKOFF_MS ?? "1000", 10),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err, Anthropic) {
  if (!Anthropic) return Boolean(err?.retryable);
  return err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError;
}

/**
 * Refine signals in place (returns a new array). `client` / `Anthropic` can be
 * injected for tests; otherwise the SDK is imported lazily.
 */
export async function refineWithLlm(signals, items, { env = {}, client, Anthropic, knownAcquirers, log = () => {} } = {}) {
  const cfg = llmConfig(env);
  const stats = { calls: 0, budget: cfg.maxCalls, refined: 0, errors: 0, skipped: null };
  if (!cfg.enabled) return { signals, stats: { ...stats, skipped: "DN_LLM_ENABLED not set" } };
  if (!client) {
    try {
      Anthropic = (await import("@anthropic-ai/sdk")).default;
    } catch {
      return { signals, stats: { ...stats, skipped: "@anthropic-ai/sdk not installed" } };
    }
    // We own retries so every attempt counts against the budget.
    client = new Anthropic({ maxRetries: 0 });
  }
  const byId = new Map(items.map((it) => [toSignal(it).id, it]));
  const out = [...signals];

  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s.dn_fit < cfg.minFit || s.source === "SEC EDGAR 8-K") continue;
    const item = byId.get(s.id);
    if (!item) continue;

    let result = null;
    for (let attempt = 0; attempt < 4 && stats.calls < cfg.maxCalls; attempt++) {
      stats.calls++;
      try {
        const resp = await client.beta.messages.create({
          model: cfg.model,
          max_tokens: 1024,
          system: SYSTEM,
          output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          messages: [{ role: "user", content: `Headline: ${item.title}\nBlurb: ${item.snippet || "(none)"}` }],
        });
        if (resp.stop_reason === "refusal") break;
        const text = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
        result = JSON.parse(text);
        break;
      } catch (err) {
        if (!isRetryable(err, Anthropic)) { stats.errors++; log(`llm: ${s.id} failed: ${err?.message || err}`); break; }
        const delay = cfg.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
        log(`llm: retryable error, backing off ${delay}ms`);
        await sleep(delay);
      }
    }
    if (!result) {
      if (stats.calls >= cfg.maxCalls) { stats.skipped = "budget exhausted"; break; }
      continue;
    }

    const hinted = toSignal(
      {
        ...item,
        hint: {
          type: result.signal_type,
          buyer: result.buyer || null,
          target: result.target || null,
          companies: result.companies || [],
        },
      },
      { knownAcquirers }
    );
    if (result.one_line_summary) hinted.summary = String(result.one_line_summary).slice(0, 220);
    hinted.method = "rules+llm";
    out[i] = hinted;
    stats.refined++;
    if (stats.calls >= cfg.maxCalls) { stats.skipped = "budget exhausted"; break; }
  }
  out.sort((a, b) => b.dn_fit - a.dn_fit || (b.date || "").localeCompare(a.date || ""));
  return { signals: out, stats };
}
