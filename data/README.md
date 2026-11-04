# data/

Daily outputs of `acquireadtech-worker/scripts/daily.js`:

- `signals-YYYY-MM-DD.json`: every item in the look-back window, classified and scored (schema below).
- `brief-YYYY-MM-DD.md`: "Top 10 DN deal signals" brief.

Earlier `signals-*.json` files here are read back (last 90 days) to spot **repeat acquirers**.

Content policy: we store only the **headline, link, date, source name and our own one-line summary**
(plus derived fields). Feed descriptions are used in memory for classification and are never written,
and full article text is never fetched.

## Signal fields

| field | meaning |
|---|---|
| `headline`, `link`, `date`, `source` | from the feed (link goes to the publisher) |
| `signal_type` | `acquisition`, `funding`, `for_sale`, `exec_change`, `layoffs`, `shutdown`, or `other` |
| `signals_all` | every type that matched, strongest first |
| `confidence` | `high` / `medium` / `low` / `none` (rule-match strength) |
| `companies`, `buyer`, `target` | extracted names (`buyer`/`target` only for M&A) |
| `deal_size` | `{text, amount_usd, currency}` if a figure is stated, else `null` |
| `segments` | DN focus segments matched (ad tech, mar tech, affiliate, lead gen, CTV, retail media, app monetization) |
| `dn_fit` | 0-100 fit score; `fit_reasons` explains it |
| `summary` | our own one-liner generated from the fields above |
| `why_dn` | why the item matters for Digital Nations |
| `method` | `rules` or `rules+llm` |
