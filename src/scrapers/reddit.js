/**
 * Reddit Scraper — Free, no auth needed
 * API: https://www.reddit.com/search.json?q={query}&limit=100
 * Rate limit: 60 requests/minute (unauthenticated)
 * Note: Reddit blocks datacenter IPs (Cloudflare). Needs proxy.
 */

const { ProxyAgent } = require('proxy-agent');
const https = require('https');
const { launchStealth } = require('../../anti-bot/stealth-launcher');

const BASE = 'https://www.reddit.com/search.json';
const OLD_REDDIT_BASE = 'https://old.reddit.com/search.json';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
];

function cleanText(value, maxLength = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// Reddit values not eligible as a real post image — mirrors the invalid-value
// filtering already applied to product images elsewhere in the codebase.
const INVALID_REDDIT_IMAGE_VALUES = new Set(['self', 'default', 'nsfw', 'spoiler', '', 'image', 'none', 'null']);

/**
 * A real post image lives in one of several different shapes depending on
 * post type — this only checked `preview.images[0].source.url`, which is
 * empty for: gallery posts (media_metadata instead), and any post where
 * Reddit only populated the lighter-weight `thumbnail` field. Text-only
 * posts genuinely have none of these — that is a correct, real "no image",
 * not a bug (the caller must not paper over it with a fake placeholder).
 */
function extractRedditImage(d) {
  const preview = d.preview?.images?.[0]?.source?.url;
  if (preview) return preview.replace(/&amp;/g, '&');

  if (d.is_gallery && d.media_metadata && typeof d.media_metadata === 'object') {
    const firstMedia = Object.values(d.media_metadata)[0];
    const galleryUrl = firstMedia?.s?.u || firstMedia?.s?.gif;
    if (galleryUrl) return galleryUrl.replace(/&amp;/g, '&');
  }

  const thumbnail = String(d.thumbnail || '').trim();
  if (thumbnail && /^https?:\/\//i.test(thumbnail) && !INVALID_REDDIT_IMAGE_VALUES.has(thumbnail.toLowerCase())) {
    return thumbnail.replace(/&amp;/g, '&');
  }

  // A direct image link post (i.redd.it/xyz.jpg) with no preview generated yet.
  const destUrl = String(d.url_overridden_by_dest || '').trim();
  if (/\.(jpe?g|png|gif|webp)$/i.test(destUrl)) return destUrl;

  return '';
}

function proxiedFetch(url, options, proxyUrl) {
  if (!proxyUrl) return fetch(url, options);

  const agent = new ProxyAgent(proxyUrl);
  return new Promise((resolve, reject) => {
    if (options.signal && options.signal.aborted) {
      return reject(new Error('ABORTED: execution cancelled'));
    }
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent,
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage,
        json: () => JSON.parse(data),
        text: () => data,
      }));
    });
    const onAbort = () => {
      req.destroy(new Error('ABORTED: execution cancelled'));
      reject(new Error('ABORTED: execution cancelled'));
    };
    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (err) => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.on('timeout', () => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      req.destroy();
      reject(new Error('TimeoutError'));
    });
    req.end();
  });
}

async function scrapeApi(query, options, baseUrl = BASE) {
  options = options || {};
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const proxyUrl = options.proxyUrl || process.env.REDDIT_PROXY || null;

  const params = new URLSearchParams({
    q: query,
    limit: String(options.limit || 100),
    sort: options.sort || 'new',
    raw_json: '1',
  });

  const url = baseUrl + '?' + params.toString();
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const resp = await proxiedFetch(url, { headers, signal: options.signal }, proxyUrl);

  if (resp.status === 403) {
    throw new Error('BLOCKED_IP: Reddit blocked this IP. Provide a proxy via proxyUrl or REDDIT_PROXY env');
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);

  const body = await resp.json();
  const children = body?.data?.children || [];
  if (children.length === 0) throw new Error('EMPTY_RESULT: no posts found');

  const items = children
    .filter(c => c.kind === 't3')
    .map(c => {
      const d = c.data;
      return {
        platform: 'reddit',
        title: d.title || '',
        url: 'https://reddit.com' + (d.permalink || ''),
        author: d.author || '',
        likes: d.ups || 0,
        comments: d.num_comments || 0,
        shares: 0,
        views: 0,
        image: extractRedditImage(d),
        created_utc: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
        subreddit: d.subreddit || '',
        domain: d.domain || '',
        selftext: (d.selftext || '').slice(0, 500),
        thumbnail: d.thumbnail || '',
        score: d.score || 0,
        upvote_ratio: d.upvote_ratio || 0,
        id: d.id,
      };
    });

  return { items, results: items, source: baseUrl === OLD_REDDIT_BASE ? 'reddit_api_old' : 'reddit_api' };
}

async function scrapePublic(query, options) {
  options = options || {};
  const limit = options.limit || 50;
  const browser = await launchStealth({
    proxyUrl: options.proxyUrl || process.env.REDDIT_PROXY || null,
    headless: options.headless !== false,
    cdpUrl: options.cdpUrl || null,
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
    const url = 'https://www.reddit.com/search/?q=' + encodeURIComponent(query) + '&type=posts';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="/comments/"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(options.initialDelay || 3000);

    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
      await page.waitForTimeout(1000);
    }

    const items = await page.evaluate((max) => {
      const seen = new Set();
      const out = [];
      const links = Array.from(document.querySelectorAll('a[href*="/comments/"]'));

      for (const a of links) {
        const href = a.href || '';
        const match = href.match(/\/r\/([^/]+)\/comments\/([^/]+)/);
        if (!match || seen.has(match[2])) continue;

        // Walk up to find the card container that has the votes/comments text
        let card = a;
        for (let i = 0; i < 8 && card.parentElement; i++) {
          card = card.parentElement;
          const text = card.innerText || '';
          if ((text.includes('vote') || text.includes('comment')) && text.length > 30) {
            break;
          }
        }

        seen.add(match[2]);
        const cardText = card ? card.innerText : '';

        // Parse votes/upvotes: "486 votes" or "1.2k upvotes"
        const voteMatch = cardText.match(/([\d,.]+)\s*([km]?)\s*(?:upvotes?|votes?)/i);
        let upvotes = 0;
        if (voteMatch) {
          const val = parseFloat(voteMatch[1].replace(/,/g, ''));
          const mult = { k: 1000, m: 1000000 }[String(voteMatch[2] || '').toLowerCase()] || 1;
          upvotes = Math.round(val * mult);
        }

        // Parse comments: "112 comments" or "1.5k comments"
        const commentMatch = cardText.match(/([\d,.]+)\s*([km]?)\s*comments?/i);
        let comments = 0;
        if (commentMatch) {
          const val = parseFloat(commentMatch[1].replace(/,/g, ''));
          const mult = { k: 1000, m: 1000000 }[String(commentMatch[2] || '').toLowerCase()] || 1;
          comments = Math.round(val * mult);
        }

        // Find image in card
        const img = card ? Array.from(card.querySelectorAll('img')).find((im) => {
          const src = im.currentSrc || im.src || '';
          return src && /^https?:\/\//i.test(src) && !/avatar|icon|favicon|emoji/i.test(src);
        }) : null;

        const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title) continue;

        out.push({
          title,
          url: href,
          subreddit: match[1],
          id: match[2],
          image: img ? (img.currentSrc || img.src) : '',
          likes: upvotes,
          comments: comments,
        });

        if (out.length >= max) break;
      }

      return out;
    }, limit);

    const mapped = items.map(d => ({
      platform: 'reddit',
      title: cleanText(d.title, 220),
      url: d.url,
      author: '',
      likes: d.likes || 0,
      comments: d.comments || 0,
      shares: 0,
      views: 0,
      image: d.image || '',
      created_utc: '',
      subreddit: d.subreddit || '',
      domain: 'reddit.com',
      selftext: '',
      thumbnail: '',
      score: 0,
      upvote_ratio: 0,
      id: d.id,
    })).filter(i => i.title && i.url);

    if (!mapped.length) throw new Error('EMPTY_RESULT: no Reddit posts parsed from public search');
    return { items: mapped, results: mapped, source: 'reddit_browser' };
  } finally {
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}

// §16: not every non-2xx failure means "this tier is unusable, move on."
//   ENDPOINT_FAILURE (403/404/BLOCKED_IP/Cloudflare challenge) — the tier
//     itself is genuinely blocked right now; escalating immediately is correct.
//   RATE_LIMITED (429) / SERVER_TRANSIENT (5xx) / network timeouts — likely
//     temporary. Spending Browser capacity immediately for a blip that would
//     resolve on its own is wasteful and slow. These get a bounded
//     retry/backoff via the OUTER scrapeWithRetry loop (anti-bot/scraper-factory.js,
//     exponential backoff + proxy rotation between attempts) first, and only
//     escalate to old.reddit/browser once that budget (options.attempt vs
//     options.maxAttempts) is exhausted.
const ENDPOINT_FAILURE_PATTERN = /BLOCKED_IP|HTTP 403|HTTP 404|Please wait for verification/i;
const BOUNDED_RETRYABLE_PATTERN = /HTTP 429|HTTP 50[0234]|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|TimeoutError|socket hang up/i;

function isEndpointFailure(err) {
  return ENDPOINT_FAILURE_PATTERN.test(err?.message || '');
}
function isBoundedRetryable(err) {
  return BOUNDED_RETRYABLE_PATTERN.test(err?.message || '');
}

async function scrape(query, options) {
  options = options || {};
  const attempt = Number(options.attempt || 1);
  const maxAttempts = Number(options.maxAttempts || 1);
  const outerRetriesExhausted = attempt >= maxAttempts;

  try {
    return await scrapeApi(query, options);
  } catch (err) {
    if (isBoundedRetryable(err) && !outerRetriesExhausted) {
      throw err; // Let the outer bounded-retry/backoff loop handle it — no tier escalation yet.
    }
    if (!isEndpointFailure(err) && !isBoundedRetryable(err)) {
      throw err; // Unclassified (e.g. EMPTY_RESULT): propagate as-is, never guessed at.
    }

    try {
      // This endpoint is often accessible when the main Reddit host returns a
      // Cloudflare challenge, and does not require a browser process.
      return await scrapeApi(query, options, OLD_REDDIT_BASE);
    } catch (legacyError) {
      if (isBoundedRetryable(legacyError) && !outerRetriesExhausted) throw legacyError;
      if (!isEndpointFailure(legacyError) && !isBoundedRetryable(legacyError)) throw legacyError;
    }
    // Direct/API tiers are truly unavailable (endpoint failure) or the outer
    // retry budget is exhausted (transient failure that never recovered) —
    // only now does browser fallback spend that capacity.
    return scrapePublic(query, {
      ...options,
      proxyUrl: options.proxyUrl || process.env.REDDIT_PROXY || null,
    });
  }
}

module.exports = { scrape };
