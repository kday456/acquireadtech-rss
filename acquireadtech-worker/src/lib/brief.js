// Markdown daily brief: "Top 10 DN deal signals".

function esc(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderBrief(signals, { date, top = 10, minScore = 0, errors = [], llm = null } = {}) {
  const picked = signals.filter((s) => s.signal_type !== "other" && s.dn_fit >= minScore).slice(0, top);
  const lines = [];
  lines.push(`# Top ${top} DN deal signals: ${date}`, "");
  lines.push(
    `${signals.length} items scanned, ${signals.filter((s) => s.signal_type !== "other").length} classified as deal signals. ` +
      `Ranked by DN fit (0-100). Headlines link to the original source; summaries are our own.`,
    ""
  );
  if (!picked.length) {
    lines.push("_No deal signals today._", "");
  } else {
    lines.push("| # | Fit | Company | Signal | Why it matters for DN | Source |", "|---|---|---|---|---|---|");
    picked.forEach((s, i) => {
      const company = s.target && s.buyer ? `${s.target} (buyer: ${s.buyer})` : s.companies.join(" / ") || "n/a";
      const sig = `${s.signal_label}${s.deal_size ? `, ${s.deal_size.text}` : ""}`;
      lines.push(`| ${i + 1} | ${s.dn_fit} | ${esc(company)} | ${esc(sig)} | ${esc(s.why_dn)} | [${esc(s.source)}](${s.link}) |`);
    });
    lines.push("", "## Details", "");
    picked.forEach((s, i) => {
      lines.push(`${i + 1}. **[${esc(s.headline)}](${s.link})** (${s.source}, ${s.date ? s.date.slice(0, 10) : "undated"})`);
      lines.push(`   - ${s.summary}`);
      lines.push(`   - Fit ${s.dn_fit}: ${s.fit_reasons.join("; ")}`);
    });
    lines.push("");
  }
  if (errors.length) {
    lines.push("## Source errors", "");
    for (const e of errors) lines.push(`- ${e.source}${e.keyword ? ` (${e.keyword})` : ""}: ${e.error}`);
    lines.push("");
  }
  if (llm) lines.push(`_LLM refinement: ${llm.calls} call(s) used of budget ${llm.budget}${llm.errors ? `, ${llm.errors} failed` : ""}._`, "");
  return lines.join("\n");
}
