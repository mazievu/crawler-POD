/**
 * Shopify Scraper — public products.json, no API key.
 * Input can be store domain or full URL.
 */

function normalizeHost(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('query/store url is required');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  return u.hostname.replace(/^www\./, '');
}

async function fetchProductsJson(host, limit) {
  const url = 'https://' + host + '/products.json?limit=' + limit;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
    },
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' at ' + url);
  const ct = resp.headers.get('content-type') || '';
  const text = await resp.text();
  if (!ct.includes('json') && !text.trim().startsWith('{')) throw new Error('INVALID_RESPONSE: not JSON at ' + url);
  return JSON.parse(text);
}

async function scrape(query, options) {
  options = options || {};
  const limit = options.limit || 50;
  const host = normalizeHost(query);
  const data = await fetchProductsJson(host, limit);
  const products = data.products || [];
  if (!products.length) throw new Error('EMPTY_RESULT: no Shopify products found for ' + host);

  const items = products.slice(0, limit).map(p => {
    const v = p.variants && p.variants[0] ? p.variants[0] : {};
    const img = p.images && p.images[0] ? p.images[0].src : '';
    return {
      platform: 'shopify',
      store: host,
      title: p.title || '',
      url: 'https://' + host + '/products/' + (p.handle || ''),
      price: parseFloat(v.price || 0) || 0,
      currency: v.currency || p.currency || data.currency || '',
      image: img || '',
      vendor: p.vendor || '',
      productType: p.product_type || '',
      tags: Array.isArray(p.tags) ? p.tags.join(', ') : String(p.tags || ''),
      available: v.available !== false,
      likes: 0,
      comments: 0,
      shares: 0,
      views: 0,
    };
  }).filter(i => i.title && i.url);

  if (!items.length) throw new Error('EMPTY_RESULT: products parsed but no valid items');
  return { items };
}

module.exports = { scrape };
