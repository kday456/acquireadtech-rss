// News sources merged by the worker and the daily signals job.
// Only headline, link, date and our own one-line summary are ever persisted
// or re-served; feed descriptions are used transiently for classification.
export const SOURCES = [
  { id: "adexchanger", name: "AdExchanger", url: "https://adexchanger.com/feed/" },
  { id: "digiday", name: "Digiday", url: "https://digiday.com/feed/" },
  { id: "techcrunch-ma", name: "TechCrunch M&A", url: "https://techcrunch.com/tag/ma/feed/" },
  { id: "adweek-ma", name: "Adweek M&A", url: "https://www.adweek.com/category/mergers-acquisitions/feed/" },
  { id: "marketingdive", name: "Marketing Dive", url: "https://www.marketingdive.com/feeds/news/" },
];

export const DEFAULT_USER_AGENT =
  "acquireadtech-rss/0.2 (+https://github.com/kday456/acquireadtech-rss)";
