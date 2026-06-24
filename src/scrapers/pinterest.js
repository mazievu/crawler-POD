/**
 * Pinterest Scraper — Pinterest API v5 (free tier)
 * Rate limit: 10 req/sec
 * Need: Pinterest App + Access Token (OAuth)
 *
 * Quick token: https://developers.pinterest.com/tools/access_token/
 */

const BASE = 'https://api.pinterest.com/v5';

/**
 * Scrape Pinterest search pins
 * @param {string} query
 * @param {object} options
 * @returns {Promise<{items: object[]}>}
 */
async function scrape(query, options = {}) {
  const token = process.env.PINTEREST_TOKEN;

  if (!token) {
    throw new Error(`AUTH_REQUIRED: PINTEREST_TOKEN not set. Add to .env
  Get a quick token at: https://developers.pinterest.com/tools/access_token/
  Scopes needed: pins:read, boards:read`);
  }

  const params = new URLSearchParams({
    query,
    page_size: String(options.limit || 50),
  });

  const url = `${BASE}/search/pins?${params}`;

  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });

  if (resp.status === 401) throw new Error('AUTH_REQUIRED: Pinterest token expired or invalid');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

  const body = await resp.json();

  const pins = body.items || [];
  if (pins.length === 0) throw new Error('EMPTY_RESULT: no pins found');

  const items = pins.map(d => ({
    platform: 'pinterest',
    title: d.title || d.alt_text || '',
    url: d.link || `https://pinterest.com/pin/${d.id}`,
    image: d.media?.images?.originals?.url || d.images?.original?.url || '',
    description: (d.description || '').slice(0, 300),
    pinId: d.id,
    boardName: d.board?.name || '',
    boardUrl: d.board?.url || '',
    domain: d.domain || '',
    likes: 0,
    comments: 0,
    shares: d.repin_count || 0,
    views: 0,
  }));

  return { items };
}

module.exports = { scrape };
