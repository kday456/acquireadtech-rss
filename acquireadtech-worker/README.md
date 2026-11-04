# AcquireAdTech: M&A feed and DN deal signals

Two things live here:

1. A **Cloudflare Worker** that merges public ad tech / media RSS feeds and serves them.
2. A **daily deal-signals job** (`scripts/daily.js`) that turns the same feeds, plus SEC EDGAR 8-K filings, into
   `data/signals-YYYY-MM-DD.json` and a markdown brief, "Top 10 DN deal signals".

Both share the same zero-dependency code in `src/lib/` and run on Node 20+ or Workers.

## Worker endpoints

| path | returns |
|---|---|
| `/rss.xml` | one valid RSS 2.0 document: headline, link, date and source for each item (deduplicated, newest first) |
| `/json` | `{items: [{title, link, date, source}], errors: [...]}` |
| `/signals` | the same deal-signals document the daily job writes (rules only, never calls an LLM) |
| `/brief.md` | the Top 10 brief as markdown |
| `/` | links to the above |

Responses are cached for 15 minutes via the Workers Cache API. Source failures are reported in `errors`
(and an `X-Source-Errors` header on `/rss.xml`) instead of silently returning nothing.

## Daily deal signals

```bash
cd acquireadtech-worker
node scripts/daily.js                       # live fetch, writes ../data/
node scripts/daily.js --window 7 --top 15   # wider window, longer brief
node scripts/daily.js --feed-file test/fixtures/rss-sample.xml --edgar-file test/fixtures/edgar-sample.json --out /tmp/out   # offline
```

Pipeline: fetch feeds → parse → dedupe (earliest report wins) → keep the last `--window` days →
classify → extract companies, buyer/target and deal size → score DN fit → (optional) LLM refine → write JSON + brief.

**Signal types:** acquisition, funding, for sale / exploring options, exec change, layoffs, shutdown (else `other`).
Classification is keyword/regex rules in `src/lib/signals.js`. Edit the pattern lists there to tune it.

**DN fit (0-100)** = sector (0-40: ad tech, mar tech, affiliate, lead gen, CTV, retail media, app monetization;
adjacent media/marketing gets 12) + signal (for sale 30, acquisition 25, shutdown 18, layoffs 15, funding 12, exec change 10)
+ size (-20 to +20: $5M-$500M best, undisclosed +8, >$2B -20) + roles (buyer/target identified, **repeat acquirer** +6
when a buyer appears in 2+ acquisition signals over the last 90 days of `data/`). Mega-cap subjects get -15.
Each signal carries `fit_reasons`.

### SEC EDGAR (free)

Full-text search (`efts.sec.gov`) for 8-Ks that mention ad tech keywords and report **Item 1.01** (material definitive
agreement) or **Item 2.01** (completed acquisition/disposition). Item 1.01-only filings are flagged and scored lower,
because many are credit or supply agreements. The SEC requires a descriptive User-Agent with contact details, so EDGAR is
**skipped unless `SEC_USER_AGENT` is set**, e.g. `SEC_USER_AGENT="Digital Nations dealflow ops@yourdomain.com"`.
Requests are sequential with a 250 ms gap (well under the SEC's 10 req/s limit). Set `DN_EDGAR=0` to disable it.

### Optional LLM step (off by default)

No paid API is needed. To have Claude re-check the higher-scoring signals (type, buyer/target, one-line summary):

| env | default | |
|---|---|---|
| `DN_LLM_ENABLED` | unset | `1` to enable |
| `ANTHROPIC_API_KEY` | | required when enabled |
| `DN_LLM_MAX_CALLS` | `20` | hard per-run budget; retries count against it |
| `DN_LLM_MIN_FIT` | `40` | only refine signals scoring at least this |
| `DN_LLM_MODEL` | `claude-opus-5-5` | |
| `DN_LLM_BACKOFF_MS` | `1000` | exponential backoff base for 429/5xx/connection errors |

Requires `npm install` (installs the optional `@anthropic-ai/sdk`). Only the headline and the feed's short blurb are
sent. The Worker never calls the LLM.

### Content policy

We store and re-serve only **headline, link, date, source name and our own one-line summary** (plus derived fields such as
type, companies, and score). Feed descriptions are used in memory for classification and never written out. Full article
bodies (`content:encoded`, Atom `content`) are never read. Links always point to the publisher.

## Tests and CI

```bash
npm test     # node:test, no install needed
```

`.github/workflows/ci.yml` runs the tests on Node 20 and 22 plus an offline smoke run of the daily job.
`.github/workflows/daily-signals.yml` runs the job **manually** (workflow_dispatch) and uploads `data/` as an artifact.
A cron schedule is included but commented out.

## Deploying the Worker

```bash
npm install
npm run dev      # local
npm run deploy   # Cloudflare (requires `wrangler login`)
```

Optional Worker vars: `FEED_USER_AGENT`, `SEC_USER_AGENT`.

## Customize sources

Edit `src/lib/sources.js`. Be polite: requests time out after 10 s, send a descriptive User-Agent, and stay out of paywalled
content. Respect each publisher's terms and robots.txt.
