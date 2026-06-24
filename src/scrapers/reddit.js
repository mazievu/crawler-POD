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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
];

function cleanText(value, maxLength = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function proxiedFetch(url, options, proxyUrl) {
  if (!proxyUrl) return fetch(url, options);

  const agent = new ProxyAgent(proxyUrl);
  return new Promise((resolve, reject) => {
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
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TimeoutError')); });
    req.end();
  });
}

async function scrapeApi(query, options) {
  options = options || {};
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const proxyUrl = options.proxyUrl || process.env.REDDIT_PROXY || null;

  const params = new URLSearchParams({
    q: query,
    limit: String(options.limit || 100),
    sort: options.sort || 'new',
    raw_json: '1',
  });

  const url = BASE + '?' + params.toString();
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const resp = await proxiedFetch(url, { headers }, proxyUrl);

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
        image: (d.preview?.images?.[0]?.source?.url || '').replace(/&amp;/g, '&'),
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

  return { items, results: items };
}

async function scrapePublic(query, options) {
  options = options || {};
  const limit = options.limit || 50;
  const browser = await launchStealth({
    proxyUrl: options.proxyUrl || null,
    headless: options.headless !== false,
  });

  try {
    const page = browser.page;
    const url = 'https://www.reddit.com/search/?q=' + encodeURIComponent(query) + '&type=posts';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(options.initialDelay || 15000);

    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
      await page.waitForTimeout(1200);
    }

    const items = await page.evaluate((max) => {
      const seen = new Set();
      const out = [];
      const links = Array.from(document.querySelectorAll('a[href*="/comments/"]'));

      for (const a of links) {
        const href = a.href || '';
        const match = href.match(/\/r\/([^/]+)\/comments\/([^/]+)\/([^/?#]+)/);
        if (!match || seen.has(match[2])) continue;
        seen.add(match[2]);

        const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title) continue;

        out.push({
          title,
          url: href,
          subreddit: match[1],
          id: match[2],
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
      likes: 0,
      comments: 0,
      shares: 0,
      views: 0,
      image: '',
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
    return { items: mapped, results: mapped };
  } finally {
    await browser.close();
  }
}

async function scrape(query, options) {
  options = options || {};
  try {
    return await scrapeApi(query, options);
  } catch (err) {
    if (!/BLOCKED_IP|HTTP 403|403|Please wait for verification/i.test(err.message || '')) throw err;

    try {
      return await scrapePublic(query, { ...options, proxyUrl: null });
    } catch (publicErr) {
      if (!options.proxyUrl) throw publicErr;
      return scrapePublic(query, options);
    }
  }
}

module.exports = { scrape };
