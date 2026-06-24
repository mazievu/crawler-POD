/**
 * Etsy Scraper — Etsy Open API (free tier)
 * Rate limit: 10 req/sec, 10K listings/day
 * Need: Etsy API key (register app at https://www.etsy.com/developers)
 */

const BASE = 'https://openapi.etsy.com/v3/application/listings/search';

/**
 * Scrape Etsy search results
 * @param {string} query
 * @param {object} options
 * @returns {Promise<{items: object[]}>}
 */
async function scrape(query, options = {}) {
  const apiKey = process.env.ETSY_API_KEY;

  if (!apiKey) {
    throw new Error(`AUTH_REQUIRED: ETSY_API_KEY not set. Add to .env
  Get at: https://www.etsy.com/developers/register`);
  }

  const params = new URLSearchParams({
    keywords: query,
    limit: String(options.limit || 100),
  });

  const url = `${BASE}?${params}`;

  const resp = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('AUTH_REQUIRED: invalid Etsy API key');
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

  const body = await resp.json();

  const results = body.results || [];
  if (results.length === 0) throw new Error('EMPTY_RESULT: no listings found');

  const items = results.map(d => ({
    platform: 'etsy',
    title: d.title || '',
    url: d.url || `https://www.etsy.com/listing/${d.listing_id}`,
    price: parseFloat(d.price?.amount || d.price || 0),
    currency: d.price?.currency_code || 'USD',
    image: d.Images?.[0]?.url_fullxfull || d.MainImage?.url_fullxfull || '',
    description: (d.description || '').slice(0, 300),
    shopName: d.Shop?.shop_name || '',
    listingId: d.listing_id,
    tags: (d.tags || []).join(', '),
    materials: (d.materials || []).join(', '),
    views: d.views || 0,
    likes: d.num_favorers || 0,
    comments: 0,
    shares: 0,
  }));

  return { items };
}

module.exports = { scrape };
