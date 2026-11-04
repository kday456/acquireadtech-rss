import { test } from "node:test";
import assert from "node:assert/strict";
import { refineWithLlm, llmConfig } from "../src/lib/llm.js";
import { buildSignals } from "../src/lib/signals.js";

const items = [
  { title: "Affiliate Network LinkLoop Exploring Sale", snippet: "", link: "https://x/1", date: "2026-11-03T00:00:00Z", source: "S" },
  { title: "CTV firm Streamlytics raises $12M", snippet: "", link: "https://x/2", date: "2026-11-02T00:00:00Z", source: "S" },
  { title: "Retail media startup Shelfy hires bankers", snippet: "", link: "https://x/3", date: "2026-11-01T00:00:00Z", source: "S" },
];

function fakeClient(responder) {
  const calls = [];
  return { calls, beta: { messages: { create: async (req) => { calls.push(req); return responder(req, calls.length); } } } };
}
const ok = (obj) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(obj) }] });

test("disabled by default: no calls", async () => {
  const client = fakeClient(() => { throw new Error("should not be called"); });
  const r = await refineWithLlm(buildSignals(items), items, { env: {}, client });
  assert.equal(client.calls.length, 0);
  assert.match(r.stats.skipped, /DN_LLM_ENABLED/);
  assert.equal(llmConfig({}).maxCalls, 20);
});

test("respects the call budget", async () => {
  const client = fakeClient(() => ok({ signal_type: "for_sale", companies: ["X"], buyer: null, target: null, deal_size_usd: null, one_line_summary: "X is for sale." }));
  const r = await refineWithLlm(buildSignals(items), items, { env: { DN_LLM_ENABLED: "1", DN_LLM_MAX_CALLS: "2", DN_LLM_MIN_FIT: "0" }, client });
  assert.equal(client.calls.length, 2);
  assert.equal(r.stats.refined, 2);
  assert.equal(r.stats.skipped, "budget exhausted");
  assert.equal(r.signals.filter((s) => s.method === "rules+llm").length, 2);
});

test("backs off on retryable errors, counting retries against the budget", async () => {
  const client = fakeClient((req, n) => {
    if (n === 1) throw Object.assign(new Error("rate limited"), { retryable: true });
    return ok({ signal_type: "funding", companies: ["Streamlytics"], buyer: null, target: null, deal_size_usd: 12000000, one_line_summary: "Streamlytics raised a round." });
  });
  const r = await refineWithLlm(buildSignals(items), items, { env: { DN_LLM_ENABLED: "1", DN_LLM_MAX_CALLS: "2", DN_LLM_MIN_FIT: "0", DN_LLM_BACKOFF_MS: "1" }, client });
  assert.equal(client.calls.length, 2);
  assert.equal(r.stats.refined, 1);
  const req = client.calls[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.ok(!JSON.stringify(req).includes("FULL"), "only headline + blurb are sent");
});

test("non-retryable errors and refusals leave rules output in place", async () => {
  const client = fakeClient((req, n) => {
    if (n === 1) throw new Error("bad request");
    return { stop_reason: "refusal", content: [] };
  });
  const before = buildSignals(items);
  const r = await refineWithLlm(before, items, { env: { DN_LLM_ENABLED: "1", DN_LLM_MIN_FIT: "0" }, client });
  assert.equal(r.stats.errors, 1);
  assert.ok(r.signals.every((s) => s.method === "rules"));
});

test("LLM can downgrade a false positive to other", async () => {
  const client = fakeClient(() => ok({ signal_type: "other", companies: [], buyer: null, target: null, deal_size_usd: null, one_line_summary: "Not a deal." }));
  const r = await refineWithLlm(buildSignals(items.slice(0, 1)), items.slice(0, 1), { env: { DN_LLM_ENABLED: "1", DN_LLM_MIN_FIT: "0" }, client });
  assert.equal(r.signals[0].signal_type, "other");
  assert.equal(r.signals[0].summary, "Not a deal.");
});
