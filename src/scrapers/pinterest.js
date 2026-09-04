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
  const token = options.token || process.env.PINTEREST_TOKEN;
  if (!token) throw new Error('AUTH_REQUIRED: Pinterest token is required');

  const params = new URLSearchParams({
    query,
    page_size: String(options.limit || 50),
  });

  const url = `${BASE}/search/pins?${params}`;

  const resp = await fetch(url, {
    signal: options.signal,
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
 * Fast pin details enricher. Fetches raw pin HTML and parses GraphQL payload.
 */
async function enrichPinMetrics(pinId, signal) {
  if (!pinId) return null;
  try {
    const url = 'https://www.pinterest.com/pin/' + pinId + '/';
    const resp = await fetch(url, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    let best = null;
    while ((match = regex.exec(html)) !== null) {
      const content = match[1];
      if (content.includes('v3GetPinQuery') || content.includes('PinResponse') || content.includes('repinCount')) {
        const jsonStart = content.indexOf('{"data":');
        if (jsonStart !== -1) {
          try {
            const cleanJson = content.slice(jsonStart, content.lastIndexOf('}') + 1);
            const parsed = JSON.parse(cleanJson);
            const d = parsed.data?.v3GetPinQueryv2?.data || parsed.data?.v3GetPinQuery?.data;
            if (d) {
              const shares = Number(d.repinCount || d.aggregatedPinData?.aggregatedStats?.saves || 0);
              const comments = Number(d.aggregatedPinData?.commentCount || d.commentCount || 0);
              const likes = Number(d.totalReactionCount || d.reactionCounts || (d.reaction_counts ? Object.values(d.reaction_counts).reduce((a, b) => a + b, 0) : 0) || 0);
              const views = Number(d.viewCount || d.views || d.impressions || 0);
              const author = d.nativeCreator?.fullName || d.closeupUnifiedAttribution?.fullName || d.pinner?.username || d.closeupAttribution?.fullName || '';
              const title = d.title || d.seoTitle || d.unauthOnPageTitle || '';
              const image = d.images_orig?.url || d.imageLargeUrl || d.images_736x?.url || '';
              const description = d.description || d.seoDescription || '';
              best = { shares, comments, likes, views, author, title, image, description };
            }
          } catch {}
        }
      }
    }
    return best;
  } catch (_e) {
    return null;
  }
}

/**
 * Scrape public Pinterest search results without API credentials.
 * This reads rendered pin links, images, and enriches them with real engagement metrics.
 */
async function scrapePublic(query, options = {}) {
  const limit = options.limit || 50;
  const browser = await launchStealth({
    proxyUrl: options.proxyUrl || process.env.PINTEREST_PROXY || null,
    cdpUrl: options.cdpUrl || null,
    headless: options.headless !== false,
  });

  const onAbort = () => {
    browser.close().catch(() => {});
  };
  if (options.signal) {
    if (options.signal.aborted) {
      await browser.close();
      throw new Error('ABORTED: execution cancelled');
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

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

        const img = a.querySelector('img');
        const image = img ? img.src : '';
        const text = a.textContent || '';
        const title = titleFromText(text) || cleanText(img?.alt || '', 120);

        pins.push({
          id: match[1],
          url: 'https://www.pinterest.com/pin/' + match[1] + '/',
          title,
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
        title: d.title || 'Pinterest Pin ' + d.id,
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

    // Enrich pins with real metrics (likes, comments, repins/shares, views, real author)
    const enrichedResults = await Promise.allSettled(
      mapped.map(async (item) => {
        const meta = await enrichPinMetrics(item.pinId, options.signal);
        if (meta) {
          return {
            ...item,
            title: meta.title || item.title,
            author: meta.author || item.author,
            image: meta.image || item.image,
            description: meta.description || item.description,
            likes: meta.likes !== undefined ? meta.likes : item.likes,
            comments: meta.comments !== undefined ? meta.comments : item.comments,
            shares: meta.shares !== undefined ? meta.shares : item.shares,
            views: meta.views !== undefined ? meta.views : item.views,
          };
        }
        return item;
      })
    );

    const finalItems = enrichedResults.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
    return { items: finalItems.length ? finalItems : mapped };
  } finally {
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}

async function scrape(query, options = {}) {
  const token = process.env.PINTEREST_TOKEN;
  if (token) return scrapeApi(query, { ...options, token });
  return scrapePublic(query, options);
}

module.exports = { scrape, enrichPinMetrics };
