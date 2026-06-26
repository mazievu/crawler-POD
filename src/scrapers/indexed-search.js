/**
 * SearXNG indexed-result scraper for platforms where public indexed URLs are
 * the current free-first data source.
 */

const { search } = require('../../scripts/searxng');

const CONFIGS = {
  amazon: {
    queries: query => [
      'site:amazon.com/dp ' + query,
      'site:amazon.com/gp/product ' + query,
    ],
    urlPattern: /amazon\.[^/]+\/(?:[^?]*\/)?(?:dp|gp\/product)\//i,
  },
  facebook_posts: {
    queries: query => [
      'site:facebook.com ' + query + ' posts',
      'site:facebook.com/groups ' + query,
      'site:facebook.com/reel ' + query,
    ],
    urlPattern: /facebook\.com\/(?:groups\/[^/]+\/posts|[^/]+\/posts|reel\/)/i,
  },
  twitter: {
    queries: query => [
      'site:x.com ' + query,
      'site:twitter.com ' + query,
    ],
    urlPattern: /(?:x|twitter)\.com\/[^/]+\/status\/\d+/i,
  },
  instagram: {
    queries: query => [
      'site:instagram.com/p ' + query,
      'site:instagram.com/reel ' + query,
    ],
    urlPattern: /instagram\.com\/(?:p|reel)\//i,
  },
  tiktok_shop: {
    queries: query => [
      'site:tiktok.com/@ ' + query,
      'site:tiktok.com/tag ' + query,
    ],
    urlPattern: /tiktok\.com\/(?:@[^/]+\/(?:video|photo)|tag)\//i,
  },
};

function cleanText(value, maxLength = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function scrapeIndexedPlatform(platform, query, options = {}) {
  const config = CONFIGS[platform];
  if (!config) throw new Error('Unsupported indexed platform: ' + platform);

  const limit = options.limit || 20;
  const seen = new Set();
  const items = [];

  for (const q of config.queries(query)) {
    const result = await search(q, {
      engines: options.engines || 'google,bing,duckduckgo',
      categories: 'general',
    });

    for (const row of result.results || []) {
      if (!config.urlPattern.test(row.url || '')) continue;
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      items.push({
        platform,
        title: cleanText(row.title, 220),
        url: row.url,
        description: cleanText(row.content, 500),
        source: 'searxng',
        engine: row.engine || '',
        likes: 0,
        comments: 0,
        shares: 0,
        views: 0,
      });
      if (items.length >= limit) break;
    }

    if (items.length >= limit) break;
  }

  if (!items.length) throw new Error('EMPTY_RESULT: no indexed ' + platform + ' results found');
  return { items };
}

module.exports = { scrapeIndexedPlatform, CONFIGS };
