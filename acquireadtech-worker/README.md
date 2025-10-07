# AcquireAdTech – RSS Aggregator (Cloudflare Worker)

This is a **ready-to-deploy** Cloudflare Worker that merges RSS/Atom feeds from AdTech/Media sources and serves:
- `GET /rss.xml` – merged RSS
- `GET /json` – merged items as JSON
- `GET /` – a simple HTML list of headlines

## Step 1: Deploy on a free workers.dev URL (no DNS changes yet)

1. Create a free Cloudflare account: https://dash.cloudflare.com
2. Install Wrangler (the CF CLI):
   ```bash
   npm i -g wrangler
   ```
3. Authenticate:
   ```bash
   wrangler login
   ```
4. From this folder, run locally (optional):
   ```bash
   npm install
   npm run dev
   ```
5. Deploy:
   ```bash
   npm run deploy
   ```

You’ll get a URL like `https://acquireadtech-rss.<yourname>.workers.dev`.
- Visit `/` to see headlines.
- Subscribe to `/rss.xml` from your feed reader or newsletter tool.

## Step 2 (later): Put it on your domain

**Easiest next step:** create a subdomain like `feed.acqurieadtech.com` and route it to this Worker via Cloudflare DNS + Routes. Your main site can stay hosted at Spectrum.

## Customize sources

Edit `src/index.js`: update the `SOURCES` array with sites/sections you want. The Worker auto-discovers feed URLs from pages and falls back to common feed paths.

## Notes
- Be polite with fetches (the code already has timeouts and caps per source).
- Don’t scrape behind paywalls. Respect robots.txt.
- You can add Cloudflare Cron Triggers later to cache results on a schedule.
