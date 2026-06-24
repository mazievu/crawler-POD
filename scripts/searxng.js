// SearXNG Search Module
// Tìm URLs từ nhiều nguồn

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';

async function search(query, options = {}) {
  const {
    engines = 'google,bing,duckduckgo',
    categories = 'general',
    pageno = 1,
    time_range = ''
  } = options;

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    engines,
    categories,
    pageno: pageno.toString()
  });

  if (time_range) params.set('time_range', time_range);

  const response = await fetch(`${SEARXNG_URL}/search?${params}`);
  if (!response.ok) throw new Error(`SearXNG error: ${response.status}`);

  const data = await response.json();
  return {
    query,
    results: (data.results || []).map(r => ({
      url: r.url,
      title: r.title,
      content: r.content,
      engine: r.engine,
      score: r.score || 0,
      publishedDate: r.publishedDate
    })),
    suggestions: data.suggestions || [],
    totalResults: data.number_of_results || 0
  };
}

// Search for platform-specific URLs
async function discoverUrls(keyword) {
  const queries = [
    { query: `"${keyword}" facebook ads library`, category: 'social media' },
    { query: `"${keyword}" shopify store`, category: 'shopping' },
    { query: `"${keyword}" tiktok shop`, category: 'social media' },
    { query: `"${keyword}" etsy product`, category: 'shopping' },
    { query: `"${keyword}" instagram shop`, category: 'social media' }
  ];

  const allResults = [];
  for (const q of queries) {
    try {
      const result = await search(q.query, { categories: q.category });
      allResults.push({
        platform: extractPlatform(q.query),
        query: q.query,
        results: result.results.slice(0, 10) // Top 10 per query
      });
      // Rate limit
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`Search failed for "${q.query}":`, err.message);
    }
  }

  return allResults;
}

function extractPlatform(query) {
  if (query.includes('facebook')) return 'facebook';
  if (query.includes('shopify')) return 'shopify';
  if (query.includes('tiktok')) return 'tiktok';
  if (query.includes('etsy')) return 'etsy';
  if (query.includes('instagram')) return 'instagram';
  return 'other';
}

module.exports = { search, discoverUrls };
