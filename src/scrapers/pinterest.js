/**
 * Pinterest Scraper
 * Free-first order:
 *   1. Official API when PINTEREST_TOKEN is available.
 *   2. Public search page fallback (no token), parsed from rendered pins.
 */

const { launchStealth } = require('../../anti-bot/stealth-launcher');

const BASE = 'https://api.pinterest.com/v5';

function cleanText(value, maxLength = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function titleFromText(value) {
  const text = cleanText(value, 180);
  if (!text) return '';
  const stop = text.search(/[.!?]\s/);
  return stop > 20 ? text.slice(0, stop + 1) : text;
}

/**
 * Scrape Pinterest through official API.
 * @param {string} query
 * @param {object} options
 * @returns {Promise<{items: object[]}>}
 */
async function scrapeApi(query, options = {}) {
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

/**
 * Scrape public Pinterest search results without API credentials.
 * This is intentionally small: it reads rendered pin links, images, and alt text.
 */
async function scrapePublic(query, options = {}) {
  const limit = options.limit || 50;
  const browser = await launchStealth({
    proxyUrl: options.proxyUrl || process.env.PINTEREST_PROXY || null,
    headless: options.headless !== false,
  });

  try {
    const page = browser.page;
    const url = 'https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(query);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(options.initialDelay || 7000);

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1400));
      await page.waitForTimeout(1200);
    }

    const items = await page.evaluate((max) => {
      const seen = new Set();
      const pins = [];
      const anchors = Array.from(document.querySelectorAll('a[href*="/pin/"]'));

      for (const a of anchors) {
        const href = a.href || '';
        const match = href.match(/\/pin\/(\d+)/);
        if (!match || seen.has(match[1])) continue;
        seen.add(match[1]);

        const card = a.closest('[data-test-id="pin"], div[role="listitem"]') || a.parentElement || a;
        const img = card.querySelector('img') || a.querySelector('img');
        const text = img?.alt || a.getAttribute('aria-label') || '';
        const image = img?.src || '';

        pins.push({
          id: match[1],
          url: href,
          image,
          text,
        });

        if (pins.length >= max) break;
      }

      return pins;
    }, limit);

    const mapped = items
      .map(d => ({
        platform: 'pinterest',
        title: titleFromText(d.text) || 'Pinterest pin ' + d.id,
        url: d.url,
        image: d.image,
        description: cleanText(d.text, 500),
        pinId: d.id,
        boardName: '',
        boardUrl: '',
        domain: '',
        likes: 0,
        comments: 0,
        shares: 0,
        views: 0,
      }))
      .filter(i => i.url && i.image);

    if (!mapped.length) throw new Error('EMPTY_RESULT: no Pinterest pins parsed');
    return { items: mapped };
  } finally {
    await browser.close();
  }
}

async function scrape(query, options = {}) {
  const token = process.env.PINTEREST_TOKEN;
  if (token) return scrapeApi(query, options);
  return scrapePublic(query, options);
}

module.exports = { scrape };
