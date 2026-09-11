/**
 * TikTok Video Scraper — Free, self-hosted, no paid API keys
 *
 * Strategy (2-tier):
 *   Tier 1 (Metrics):  HTTP GET + parse __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON tag
 *                      (~200-400ms/video, zero browser overhead)
 *   Tier 2 (Comments): Playwright network interceptor — scrolls page, captures
 *                      /api/comment/list/ responses with replies
 *   Fallback:          TikWM public gateway mirror (1 req/sec rate limit)
 *
 * Handles both:
 *   - Single video URL: https://www.tiktok.com/@user/video/123
 *   - Keyword/hashtag search: #tiktokmademebuyit, "pod trend", etc.
 *
 * Anti-bot notes:
 *   - TikTok blocks datacenter IPs aggressively. Residential proxy recommended.
 *   - Rehydration JSON parsing does NOT require a_bogus/msToken signatures.
 *   - Comment API requires valid browser session (handled by Playwright interceptor).
 */

const { launchStealth } = require('../../anti-bot/stealth-launcher');

// ─── Constants ───────────────────────────────────────────────────────────────

const TIKTOK_VIDEO_URL_RE = /tiktok\.com\/@[\w.]+\/video\/(\d+)/i;
const TIKTOK_SHORT_URL_RE = /vm\.tiktok\.com\/[\w]+/i;
const REHYDRATION_SCRIPT_ID = '__UNIVERSAL_DATA_FOR_REHYDRATION__';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

const TIKWM_BASE = 'https://www.tikwm.com/api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitter(minMs, maxMs) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  const s = String(v ?? '');
  const match = s.replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
  if (!match) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(match[1]) * mult) || 0;
}

function isVideoUrl(query) {
  return TIKTOK_VIDEO_URL_RE.test(query) || TIKTOK_SHORT_URL_RE.test(query);
}

function extractVideoId(url) {
  const match = url.match(TIKTOK_VIDEO_URL_RE);
  return match ? match[1] : null;
}

// ─── Tier 1: HTTP GET + Rehydration JSON Parse ──────────────────────────────

/**
 * Fetch a TikTok video page via plain HTTP and extract all metrics from the
 * server-rendered __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON blob.
 *
 * This avoids any browser overhead and does NOT need a_bogus/msToken because
 * the rehydration data is embedded in the initial HTML response.
 */
async function fetchVideoMetrics(videoUrl, options = {}) {
  const { signal, proxyUrl } = options;
  const ua = randomUA();

  const fetchOpts = {
    signal,
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="8"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
    },
    redirect: 'follow',
  };

  // Proxy support via ProxyAgent (same pattern as reddit.js)
  if (proxyUrl) {
    try {
      const { ProxyAgent } = require('proxy-agent');
      fetchOpts.agent = new ProxyAgent(proxyUrl);
    } catch (_) {
      // proxy-agent not available, proceed without proxy
    }
  }

  const resp = await fetch(videoUrl, fetchOpts);
  if (!resp.ok) {
    throw new Error(`HTTP_${resp.status}: TikTok returned ${resp.status} for ${videoUrl}`);
  }

  const html = await resp.text();

  // Extract rehydration JSON
  const scriptStart = html.indexOf(`id="${REHYDRATION_SCRIPT_ID}"`);
  if (scriptStart === -1) {
    throw new Error('REHYDRATION_MISSING: Could not find __UNIVERSAL_DATA_FOR_REHYDRATION__ script tag');
  }

  const jsonStart = html.indexOf('>', scriptStart) + 1;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  if (jsonStart <= 0 || jsonEnd === -1) {
    throw new Error('REHYDRATION_PARSE_FAILED: Could not extract JSON from rehydration script');
  }

  const jsonStr = html.substring(jsonStart, jsonEnd).trim();
  let rehydration;
  try {
    rehydration = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`REHYDRATION_JSON_INVALID: ${e.message}`);
  }

  // Navigate to itemStruct
  const videoDetail = rehydration?.['__DEFAULT_SCOPE__']?.['webapp.video-detail'];
  const itemStruct = videoDetail?.itemInfo?.itemStruct;

  if (!itemStruct) {
    // Try alternate path for different TikTok page versions
    const statusCode = videoDetail?.statusCode;
    if (statusCode === 10204) {
      throw new Error('VIDEO_REMOVED: Video has been removed or is unavailable');
    }
    throw new Error('ITEM_STRUCT_MISSING: Could not find itemStruct in rehydration data');
  }

  return parseItemStruct(itemStruct);
}

/**
 * Parse TikTok itemStruct into a normalized item object.
 */
function parseItemStruct(item) {
  const stats = item.statsV2 || item.stats || {};
  const author = item.author || {};
  const authorStats = item.authorStats || {};
  const music = item.music || {};
  const video = item.video || {};
  const challenges = Array.isArray(item.challenges) ? item.challenges : [];
  const textExtra = Array.isArray(item.textExtra) ? item.textExtra : [];

  // Extract hashtags from textExtra
  const hashtags = textExtra
    .filter(t => t.hashtagName)
    .map(t => t.hashtagName);

  // Extract shop product anchors if present
  const shopProducts = [];
  if (Array.isArray(item.anchors)) {
    for (const anchor of item.anchors) {
      if (anchor.type === 6 || anchor.keyword) {
        shopProducts.push({
          productId: anchor.id || '',
          name: anchor.keyword || anchor.description || '',
          url: anchor.logExtra?.product_url || '',
        });
      }
    }
  }

  // Extract POI (location) if present
  const poi = item.poi ? {
    name: item.poi.name || '',
    address: item.poi.address || '',
    city: item.poi.city || '',
    country: item.poi.country || '',
  } : null;

  // Build cover image URL — prefer originCover (highest quality)
  const coverImage = video.originCover || video.cover || video.dynamicCover || '';

  return {
    id: item.id || item.aweme_id || '',
    platform: 'tiktok_videos',
    title: item.desc || '',
    url: `https://www.tiktok.com/@${author.uniqueId || 'unknown'}/video/${item.id}`,
    image: coverImage,

    // Core stats (mapped to social-post normalizer fields)
    diggCount: parseNum(stats.diggCount),
    commentCount: parseNum(stats.commentCount),
    shareCount: parseNum(stats.shareCount),
    collectCount: parseNum(stats.collectCount),
    playCount: parseNum(stats.playCount),
    repostCount: parseNum(stats.repostCount),

    // Aliases for normalizer compatibility
    likes: parseNum(stats.diggCount),
    comments: parseNum(stats.commentCount),
    shares: parseNum(stats.shareCount),
    views: parseNum(stats.playCount),

    // Creator info
    author: {
      uniqueId: author.uniqueId || '',
      nickname: author.nickname || '',
      verified: !!author.verified,
      signature: author.signature || '',
      avatarThumb: author.avatarThumb || '',
      avatarMedium: author.avatarMedium || '',
      followerCount: parseNum(authorStats.followerCount),
      heartCount: parseNum(authorStats.heartCount),
      videoCount: parseNum(authorStats.videoCount),
    },

    // Music
    music: {
      id: music.id || '',
      title: music.title || '',
      authorName: music.authorName || '',
      original: !!music.original,
      duration: music.duration || 0,
      playUrl: music.playUrl || '',
    },

    // Hashtags & challenges
    hashtags,
    challenges: challenges.map(c => ({
      id: c.id || '',
      title: c.title || '',
      desc: c.desc || '',
    })),

    // Video metadata
    video: {
      duration: video.duration || 0,
      ratio: video.ratio || '',
      width: video.width || 0,
      height: video.height || 0,
      coverUrl: coverImage,
      downloadUrl: video.downloadAddr || video.playAddr || '',
    },

    // Location
    poi,

    // Shop products (if attached)
    shopProducts,

    // Subtitles / captions
    contents: item.contents || null,

    // Timestamps
    createTime: item.createTime || 0,
    publishedAt: item.createTime
      ? new Date(item.createTime * 1000).toISOString()
      : new Date().toISOString(),

    // Full comments placeholder (populated by Tier 2 if requested)
    fullComments: null,
  };
}

// ─── Tier 2a: Comments via TikWM Gateway (Fallback, no browser) ─────────────

/**
 * Fetch comments through the free TikWM public gateway.
 * Rate limited to 1 request/second. Returns top-level comments with metadata.
 */
async function fetchCommentsViaGateway(videoUrl, options = {}) {
  const { maxComments = 200, signal } = options;
  const comments = [];
  let cursor = 0;
  let hasMore = true;

  while (hasMore && comments.length < maxComments) {
    if (signal?.aborted) throw new Error('ABORTED: execution cancelled');

    const url = `${TIKWM_BASE}/comment/list?url=${encodeURIComponent(videoUrl)}&cursor=${cursor}&count=50`;
    const resp = await fetch(url, { signal });

    if (!resp.ok) {
      console.warn(`[tiktok] TikWM comment API returned ${resp.status}, stopping`);
      break;
    }

    const data = await resp.json();
    if (data.code !== 0 || !data.data?.comments?.length) break;

    for (const c of data.data.comments) {
      comments.push({
        cid: c.cid || c.id || '',
        text: c.text || '',
        likes: parseNum(c.digg_count),
        replyCount: parseNum(c.reply_comment_total || c.reply_count),
        createTime: c.create_time || 0,
        author: c.user?.unique_id || '',
        nickname: c.user?.nickname || '',
        avatarUrl: c.user?.avatar_thumb?.url_list?.[0] || '',
        replies: [], // TikWM does not return inline replies
      });
    }

    hasMore = !!data.data.has_more;
    cursor = data.data.cursor || cursor + 50;

    // Respect TikWM rate limit: 1 req/sec
    await sleep(1200);
  }

  return comments;
}

// ─── Tier 2b: Comments via Playwright Network Interceptor ───────────────────

/**
 * Opens the video page in a stealth browser, scrolls to load comments,
 * and intercepts /api/comment/list/ responses to capture full comment data
 * including reply threads.
 *
 * This bypasses TikTok's a_bogus signature requirement because TikTok's own
 * JS signs the requests — we just listen to the responses.
 */
async function fetchCommentsViaPlaywright(videoUrl, options = {}) {
  const { maxComments = 300, signal } = options;
  const allComments = new Map(); // cid → comment object
  let hasMore = true;

  let browser, context, page;
  try {
    const launched = await launchStealth({
      headless: true,
      signal,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    browser = launched.browser;
    context = launched.context || await browser.newContext({
      userAgent: randomUA(),
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });
    page = launched.page || await context.newPage();

    // Intercept comment API responses
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/api/comment/list')) return;

      try {
        const data = await response.json();
        const commentList = data.comments || [];
        for (const c of commentList) {
          if (allComments.has(c.cid)) continue;
          allComments.set(c.cid, {
            cid: c.cid || '',
            text: c.text || '',
            likes: parseNum(c.digg_count),
            replyCount: parseNum(c.reply_comment_total),
            createTime: c.create_time || 0,
            author: c.user?.unique_id || '',
            nickname: c.user?.nickname || '',
            avatarUrl: c.user?.avatar_thumb?.url_list?.[0] || '',
            replies: [],
          });
        }
        hasMore = data.has_more === 1 || data.has_more === true;
      } catch (_) { /* non-JSON response, skip */ }
    });

    // Also intercept reply responses
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/api/comment/list/reply')) return;

      try {
        const data = await response.json();
        const replies = data.comments || [];
        // Find parent comment ID from URL params
        const urlObj = new URL(url);
        const parentCid = urlObj.searchParams.get('comment_id');
        const parent = parentCid ? allComments.get(parentCid) : null;

        for (const r of replies) {
          const reply = {
            cid: r.cid || '',
            text: r.text || '',
            likes: parseNum(r.digg_count),
            createTime: r.create_time || 0,
            author: r.user?.unique_id || '',
            nickname: r.user?.nickname || '',
          };
          if (parent) {
            parent.replies.push(reply);
          }
        }
      } catch (_) { /* skip */ }
    });

    // Navigate to video page
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await jitter(2000, 3000);

    // Scroll to load comments
    let prevCount = 0;
    let stagnantRounds = 0;

    while (allComments.size < maxComments && hasMore && stagnantRounds < 6) {
      if (signal?.aborted) break;

      await page.mouse.wheel(0, 800);
      await jitter(1500, 3000);

      // Try to expand replies
      try {
        const replyBtns = await page.$$('[data-e2e="comment-reply-expand"], [class*="ReplyActionText"]');
        for (const btn of replyBtns.slice(0, 3)) {
          try { await btn.click(); await jitter(500, 1000); } catch (_) {}
        }
      } catch (_) {}

      if (allComments.size === prevCount) {
        stagnantRounds++;
      } else {
        stagnantRounds = 0;
        prevCount = allComments.size;
      }
    }
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { if (context) await context.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
  }

  return Array.from(allComments.values());
}

// ─── Keyword/Hashtag Search ─────────────────────────────────────────────────

/**
 * Search TikTok by keyword/hashtag. Uses TikWM search first (lightweight),
 * falls back to Playwright stealth search if needed.
 */
async function searchByKeyword(query, options = {}) {
  const { limit = 20, signal, proxyUrl } = options;

  // Tier 1: Try TikWM search API (lightweight, no browser)
  try {
    const searchUrl = `${TIKWM_BASE}/?url=${encodeURIComponent(`https://www.tiktok.com/search?q=${encodeURIComponent(query)}`)}`;
    // TikWM also has a feed/search endpoint
    const feedUrl = `${TIKWM_BASE}/feed/search?keywords=${encodeURIComponent(query)}&count=${Math.min(limit, 30)}&cursor=0`;

    const resp = await fetch(feedUrl, {
      signal,
      headers: { 'Accept': 'application/json' },
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.code === 0 && data.data?.videos?.length) {
        const videoUrls = data.data.videos
          .slice(0, limit)
          .map(v => `https://www.tiktok.com/@${v.author?.unique_id || 'unknown'}/video/${v.video_id || v.aweme_id}`)
          .filter(u => TIKTOK_VIDEO_URL_RE.test(u));
        return videoUrls;
      }
    }
  } catch (e) {
    console.warn(`[tiktok] TikWM search failed: ${e.message}, falling back to Playwright`);
  }

  // Tier 2: Playwright stealth search
  let browser, context, page;
  try {
    const launched = await launchStealth({
      headless: true,
      signal,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    browser = launched.browser;
    context = launched.context || await browser.newContext({
      userAgent: randomUA(),
      viewport: { width: 1280, height: 720 },
    });
    page = launched.page || await context.newPage();

    const searchQuery = query.startsWith('#') ? query : encodeURIComponent(query);
    await page.goto(`https://www.tiktok.com/search?q=${searchQuery}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await jitter(3000, 5000);

    // Scroll to load more results
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1000);
      await jitter(1500, 2500);
    }

    // Extract video URLs from search results
    const videoUrls = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/video/"]');
      const urls = new Set();
      for (const link of links) {
        const href = link.href;
        if (href && /\/@[\w.]+\/video\/\d+/.test(href)) {
          urls.add(href.split('?')[0]);
        }
      }
      return Array.from(urls);
    });

    return videoUrls.slice(0, limit);
  } catch (e) {
    console.warn(`[tiktok] Playwright search also failed: ${e.message}`);
    return [];
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { if (context) await context.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
  }
}

// ─── Main Scraper Entry Point ───────────────────────────────────────────────

/**
 * Main scrape function matching the project's scraper interface.
 *
 * @param {string} query - TikTok video URL or keyword/hashtag
 * @param {object} options
 * @param {number} options.limit - Max items to return (default 20)
 * @param {boolean} options.includeComments - Whether to fetch full comments (default false)
 * @param {number} options.maxComments - Max comments per video (default 200)
 * @param {AbortSignal} options.signal - Cancellation signal
 * @param {string} options.proxyUrl - Proxy URL for HTTP requests
 * @returns {Promise<{items: Array}>}
 */
async function scrape(query, options = {}) {
  const {
    limit = 20,
    includeComments = false,
    maxComments = 200,
    signal,
    proxyUrl,
  } = options;

  let items = [];

  if (isVideoUrl(query)) {
    // ── Single video URL ──
    const item = await fetchVideoMetrics(query, { signal, proxyUrl });

    if (includeComments) {
      try {
        item.fullComments = await fetchCommentsViaPlaywright(query, { maxComments, signal });
      } catch (e) {
        console.warn(`[tiktok] Playwright comments failed: ${e.message}, trying TikWM fallback`);
        try {
          item.fullComments = await fetchCommentsViaGateway(query, { maxComments, signal });
        } catch (e2) {
          console.warn(`[tiktok] TikWM comments also failed: ${e2.message}`);
          item.fullComments = [];
        }
      }
    }

    items = [item];
  } else {
    // ── Keyword/hashtag search → multi-video ──
    const videoUrls = await searchByKeyword(query, { limit, signal, proxyUrl });

    if (videoUrls.length === 0) {
      throw new Error(`EMPTY_RESULT: No TikTok videos found for query "${query}"`);
    }

    // Fetch metrics for each video in batches of 5
    const BATCH_SIZE = 5;
    for (let i = 0; i < videoUrls.length; i += BATCH_SIZE) {
      if (signal?.aborted) break;

      const batch = videoUrls.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(url => fetchVideoMetrics(url, { signal, proxyUrl }))
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          items.push(result.value);
        } else {
          console.warn(`[tiktok] Failed to fetch video metrics: ${result.reason?.message}`);
        }
      }

      // Pacing between batches
      if (i + BATCH_SIZE < videoUrls.length) {
        await jitter(2000, 4000);
      }
    }

    // Optionally fetch comments for top N videos (most viewed)
    if (includeComments && items.length > 0) {
      const topItems = [...items]
        .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
        .slice(0, 5); // Only top 5 to avoid excessive browser usage

      for (const item of topItems) {
        if (signal?.aborted) break;
        try {
          item.fullComments = await fetchCommentsViaGateway(item.url, { maxComments: Math.min(maxComments, 100), signal });
        } catch (e) {
          console.warn(`[tiktok] Comments failed for ${item.id}: ${e.message}`);
          item.fullComments = [];
        }
      }
    }
  }

  if (items.length === 0) {
    throw new Error(`EMPTY_RESULT: No TikTok videos could be scraped for "${query}"`);
  }

  return {
    items,
    source: 'tiktok_local',
    isLive: true,
    _debug: {
      query,
      totalFetched: items.length,
      includeComments,
      timestamp: new Date().toISOString(),
    },
  };
}

module.exports = { scrape };
