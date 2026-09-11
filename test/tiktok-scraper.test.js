/**
 * TikTok Scraper Tests — Calling real exported module functions
 *
 * Tests the core parsing and scraping logic of src/scrapers/tiktok.js:
 *   - URL detection and video ID extraction (real isVideoUrl, extractVideoId)
 *   - Number parsing (real parseNum)
 *   - Item struct parsing (real parseItemStruct)
 *   - Rehydration HTML extraction via mock fetch (real fetchVideoMetrics)
 *   - Error branches: HTTP error, REHYDRATION_MISSING, VIDEO_REMOVED
 *   - End-to-end scrape() for single video URL
 *   - Normalizer and ingestion filter compatibility
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  scrape,
  fetchVideoMetrics,
  parseItemStruct,
  parseNum,
  isVideoUrl,
  extractVideoId,
  TIKTOK_VIDEO_URL_RE,
  TIKTOK_SHORT_URL_RE,
} = require('../src/scrapers/tiktok');

const normalizeSocialPost = require('../src/normalize/social-post');

// ─── Mock Fixtures ──────────────────────────────────────────────────────────

const MOCK_ITEM_STRUCT = {
  id: '7345678901234567890',
  desc: 'Check out this amazing POD trend! #tiktokmademebuyit #podtrend',
  createTime: 1718000000,
  video: {
    duration: 15,
    ratio: '720p',
    width: 576,
    height: 1024,
    cover: 'https://p16-sign.tiktokcdn.com/cover.jpg',
    originCover: 'https://p16-sign.tiktokcdn.com/origin-cover.jpg',
    dynamicCover: 'https://p16-sign.tiktokcdn.com/dynamic-cover.gif',
    playAddr: 'https://v16-webapp.tiktok.com/play.mp4',
    downloadAddr: 'https://v16-webapp.tiktok.com/download.mp4',
  },
  author: {
    id: '123456',
    secUid: 'MS4wLjABAAAA...',
    uniqueId: 'creatorname',
    nickname: 'Creator Display Name',
    avatarThumb: 'https://p16-sign.tiktokcdn.com/avatar-thumb.jpg',
    avatarMedium: 'https://p16-sign.tiktokcdn.com/avatar-medium.jpg',
    signature: 'POD creator | 🎨 Custom designs',
    verified: true,
  },
  authorStats: {
    followerCount: 1250000,
    heartCount: 45000000,
    videoCount: 342,
  },
  statsV2: {
    diggCount: '15200',
    commentCount: '340',
    shareCount: '1280',
    collectCount: '890',
    playCount: '524000',
    repostCount: '45',
  },
  music: {
    id: '7000000000000',
    title: 'Original Sound',
    authorName: 'creatorname',
    original: true,
    duration: 15,
    playUrl: 'https://sf16-webapp.tiktok.com/music.mp3',
  },
  textExtra: [
    { hashtagName: 'tiktokmademebuyit', hashtagId: '111' },
    { hashtagName: 'podtrend', hashtagId: '222' },
    { userId: '999', userUniqueId: 'taggeduser' },
  ],
  challenges: [
    { id: '111', title: 'tiktokmademebuyit', desc: 'Products that went viral on TikTok' },
  ],
  poi: {
    name: 'Ho Chi Minh City',
    address: '123 Nguyen Hue',
    city: 'HCMC',
    country: 'Vietnam',
  },
  anchors: [
    { type: 6, id: 'prod_001', keyword: 'Custom T-Shirt', logExtra: { product_url: 'https://tiktok.com/shop/product/001' } },
  ],
  contents: [{ desc: 'Auto-generated subtitles text' }],
};

function makeRehydrationHtml(payload) {
  return `<!DOCTYPE html>
<html>
<head><title>TikTok</title></head>
<body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
${JSON.stringify(payload)}
</script>
</body>
</html>`;
}

const VALID_REHYDRATION_HTML = makeRehydrationHtml({
  __DEFAULT_SCOPE__: {
    'webapp.video-detail': {
      itemInfo: {
        itemStruct: MOCK_ITEM_STRUCT,
      },
    },
  },
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TikTok Scraper — URL Detection (Direct Module Calls)', () => {
  it('should detect standard video URL via isVideoUrl', () => {
    assert.equal(isVideoUrl('https://www.tiktok.com/@creator/video/7345678901234567890'), true);
  });

  it('should extract video ID from URL via extractVideoId', () => {
    assert.equal(extractVideoId('https://www.tiktok.com/@creator/video/7345678901234567890'), '7345678901234567890');
  });

  it('should detect short URL via isVideoUrl', () => {
    assert.equal(isVideoUrl('https://vm.tiktok.com/ZMrABC123/'), true);
  });

  it('should return null when extracting video ID from non-video URL', () => {
    assert.equal(extractVideoId('https://www.tiktok.com/@creator'), null);
  });

  it('should reject keywords and hashtags in isVideoUrl', () => {
    assert.equal(isVideoUrl('#tiktokmademebuyit'), false);
    assert.equal(isVideoUrl('pod trend custom mug'), false);
  });

  it('should handle URL with query parameters', () => {
    assert.equal(isVideoUrl('https://www.tiktok.com/@creator/video/7345678901234567890?is_from_webapp=1'), true);
    assert.equal(extractVideoId('https://www.tiktok.com/@creator/video/7345678901234567890?is_from_webapp=1'), '7345678901234567890');
  });

  it('should handle creator handles containing dots and underscores', () => {
    assert.equal(isVideoUrl('https://www.tiktok.com/@creator.name_official/video/7345678901234567890'), true);
    assert.equal(extractVideoId('https://www.tiktok.com/@creator.name_official/video/7345678901234567890'), '7345678901234567890');
  });
});

describe('TikTok Scraper — Number Parsing (Direct Module Calls)', () => {
  it('should parse raw numbers correctly', () => {
    assert.equal(parseNum(15200), 15200);
    assert.equal(parseNum(0), 0);
  });

  it('should parse string shorthand numbers (K, M, B)', () => {
    assert.equal(parseNum('1.5K'), 1500);
    assert.equal(parseNum('2.3M'), 2300000);
    assert.equal(parseNum('1B'), 1000000000);
    assert.equal(parseNum('524k'), 524000);
  });

  it('should handle null, undefined, empty string gracefully', () => {
    assert.equal(parseNum(null), 0);
    assert.equal(parseNum(undefined), 0);
    assert.equal(parseNum(''), 0);
    assert.equal(parseNum('no numbers here'), 0);
  });

  it('should normalize negative sentinel values to 0', () => {
    assert.equal(parseNum(-1), 0);
    assert.equal(parseNum(-999), 0);
  });
});

describe('TikTok Scraper — parseItemStruct (Direct Module Calls)', () => {
  const item = parseItemStruct(MOCK_ITEM_STRUCT);

  it('should parse identity and URL', () => {
    assert.equal(item.id, '7345678901234567890');
    assert.equal(item.platform, 'tiktok_videos');
    assert.equal(item.title, 'Check out this amazing POD trend! #tiktokmademebuyit #podtrend');
    assert.equal(item.url, 'https://www.tiktok.com/@creatorname/video/7345678901234567890');
    assert.equal(item.image, 'https://p16-sign.tiktokcdn.com/origin-cover.jpg');
  });

  it('should parse core engagement metrics and aliases', () => {
    assert.equal(item.diggCount, 15200);
    assert.equal(item.likes, 15200);
    assert.equal(item.commentCount, 340);
    assert.equal(item.comments, 340);
    assert.equal(item.shareCount, 1280);
    assert.equal(item.shares, 1280);
    assert.equal(item.collectCount, 890);
    assert.equal(item.playCount, 524000);
    assert.equal(item.views, 524000);
    assert.equal(item.repostCount, 45);
  });

  it('should extract detailed creator information', () => {
    assert.equal(item.author.uniqueId, 'creatorname');
    assert.equal(item.author.nickname, 'Creator Display Name');
    assert.equal(item.author.verified, true);
    assert.equal(item.author.followerCount, 1250000);
    assert.equal(item.author.heartCount, 45000000);
    assert.ok(item.author.signature.includes('POD creator'));
  });

  it('should extract music metadata', () => {
    assert.equal(item.music.title, 'Original Sound');
    assert.equal(item.music.authorName, 'creatorname');
    assert.equal(item.music.original, true);
    assert.equal(item.music.duration, 15);
  });

  it('should extract hashtags and challenges', () => {
    assert.deepEqual(item.hashtags, ['tiktokmademebuyit', 'podtrend']);
    assert.equal(item.challenges.length, 1);
    assert.equal(item.challenges[0].title, 'tiktokmademebuyit');
  });

  it('should extract video media parameters', () => {
    assert.equal(item.video.duration, 15);
    assert.equal(item.video.ratio, '720p');
    assert.equal(item.video.width, 576);
    assert.equal(item.video.height, 1024);
    assert.ok(item.video.coverUrl.includes('origin-cover.jpg'));
    assert.ok(item.video.downloadUrl.includes('download.mp4'));
  });

  it('should extract POI geolocation and shop products', () => {
    assert.equal(item.poi.name, 'Ho Chi Minh City');
    assert.equal(item.poi.country, 'Vietnam');
    assert.equal(item.shopProducts.length, 1);
    assert.equal(item.shopProducts[0].productId, 'prod_001');
    assert.equal(item.shopProducts[0].name, 'Custom T-Shirt');
  });

  it('should parse timestamps into ISO string', () => {
    assert.ok(item.publishedAt.startsWith('2024-06-10'));
  });
});

describe('TikTok Scraper — fetchVideoMetrics (Direct Module Call with Mock Fetch)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should successfully fetch and parse metrics from rehydration HTML', async () => {
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () => VALID_REHYDRATION_HTML,
    });

    const result = await fetchVideoMetrics('https://www.tiktok.com/@creator/video/7345678901234567890');
    assert.equal(result.id, '7345678901234567890');
    assert.equal(result.likes, 15200);
    assert.equal(result.shares, 1280);
    assert.equal(result.collectCount, 890);
    assert.equal(result.views, 524000);
    assert.equal(result.author.uniqueId, 'creatorname');
  });

  it('should throw HTTP status error when response is not ok', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await assert.rejects(
      () => fetchVideoMetrics('https://www.tiktok.com/@creator/video/9999999999999'),
      /HTTP_404/
    );
  });

  it('should throw REHYDRATION_MISSING when HTML lacks the script tag', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><body><div>Bot blocked</div></body></html>',
    });

    await assert.rejects(
      () => fetchVideoMetrics('https://www.tiktok.com/@creator/video/7345678901234567890'),
      /REHYDRATION_MISSING/
    );
  });

  it('should throw VIDEO_REMOVED when status code is 10204', async () => {
    const removedHtml = makeRehydrationHtml({
      __DEFAULT_SCOPE__: {
        'webapp.video-detail': {
          statusCode: 10204,
        },
      },
    });

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => removedHtml,
    });

    await assert.rejects(
      () => fetchVideoMetrics('https://www.tiktok.com/@creator/video/7345678901234567890'),
      /VIDEO_REMOVED/
    );
  });

  it('should throw REHYDRATION_JSON_INVALID when script contains malformed JSON', async () => {
    const malformedHtml = `<html><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{invalid json</script></body></html>`;

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => malformedHtml,
    });

    await assert.rejects(
      () => fetchVideoMetrics('https://www.tiktok.com/@creator/video/7345678901234567890'),
      /REHYDRATION_JSON_INVALID/
    );
  });
});

describe('TikTok Scraper — scrape() Single Video URL (Direct Module Call with Mock Fetch)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return valid crawl result object for a single video URL', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => VALID_REHYDRATION_HTML,
    });

    const res = await scrape('https://www.tiktok.com/@creator/video/7345678901234567890');
    assert.equal(res.source, 'tiktok_local');
    assert.equal(res.isLive, true);
    assert.equal(Array.isArray(res.items), true);
    assert.equal(res.items.length, 1);

    const first = res.items[0];
    assert.equal(first.id, '7345678901234567890');
    assert.equal(first.likes, 15200);
    assert.equal(first.comments, 340);
    assert.equal(first.shares, 1280);
    assert.equal(first.views, 524000);
    assert.equal(first.collectCount, 890);
  });
});

describe('TikTok Scraper — Normalizer & Ingestion Pipeline Compatibility', () => {
  it('should normalize cleanly through normalizeSocialPost without falling back to Twitter URL', () => {
    const parsedItem = parseItemStruct(MOCK_ITEM_STRUCT);
    const normalized = normalizeSocialPost(parsedItem, { platform: 'tiktok_videos' });

    assert.equal(normalized.type, 'social_post');
    assert.equal(normalized.platform, 'tiktok_videos');
    assert.equal(normalized.author, 'creatorname');
    assert.equal(normalized.url, 'https://www.tiktok.com/@creatorname/video/7345678901234567890');
    assert.ok(!normalized.url.includes('x.com'), 'Must never fall back to x.com for TikTok video');
    assert.equal(normalized.likes, 15200);
    assert.equal(normalized.comments, 340);
    assert.equal(normalized.shares, 1280);
    assert.equal(normalized.views, 524000);
  });

  it('should carry a non-empty image URL to satisfy runs.service.js:122 ingestion filter', () => {
    const parsedItem = parseItemStruct(MOCK_ITEM_STRUCT);
    assert.ok(parsedItem.image, 'Must carry an image URL');
    assert.ok(parsedItem.image.startsWith('https://'), 'Image URL must be secure HTTPS');
  });
});
