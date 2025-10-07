export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // List of sources to merge
    const SOURCES = [
      "https://adexchanger.com/feed/",
      "https://digiday.com/feed/",
      "https://techcrunch.com/tag/ma/feed/",
      "https://www.adweek.com/category/mergers-acquisitions/feed/",
      "https://www.marketingdive.com/feeds/news/"
    ];

    // Function to fetch and parse feeds
    async function fetchFeed(src) {
      try {
        const resp = await fetch(src);
        const text = await resp.text();
        return text;
      } catch (e) {
        return null;
      }
    }

    // Merge feeds into one XML or JSON
    if (url.pathname.endsWith("/rss.xml")) {
      let items = [];
      for (const src of SOURCES) {
        const xml = await fetchFeed(src);
        if (xml) items.push(`\n${xml}`);
      }
      return new Response(items.join("\n"), {
        headers: { "Content-Type": "application/rss+xml" }
      });
    }

    if (url.pathname.endsWith("/json")) {
      let results = [];
      for (const src of SOURCES) {
        const xml = await fetchFeed(src);
        if (xml) {
          results.push({ source: src, raw: xml });
        }
      }
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Simple homepage
    return new Response(
      `<html><body><h1>Acquire AdTech M&A Feed</h1>
      <p>Subscribe to <a href="/rss.xml">RSS</a> or view as <a href="/json">JSON</a>.</p>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }
};