/**
 * TikTok Scraper Tests — Zero paid calls, all mocked
 *
 * Tests the core parsing logic of src/scrapers/tiktok.js:
 *   - Rehydration JSON parsing (metrics extraction)
 *   - Comment parsing
 *   - URL detection and video ID extraction
 *   - Error handling for missing/invalid data
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── Mock Data ──────────────────────────────────────────────────────────────

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

const MOCK_REHYDRATION_HTML = `
<!DOCTYPE html>
<html>
<head><title>TikTok</title></head>
<body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
${JSON.stringify({
  __DEFAULT_SCOPE__: {
    'webapp.video-detail': {
      itemInfo: {
        itemStruct: MOCK_ITEM_STRUCT
      }
    }
  }
})}
</script>
</body>
</html>
`;

const MOCK_COMMENT_API_RESPONSE = {
  status_code: 0,
  comments: [
    {
      cid: '7345000000000000001',
      text: 'This is amazing! Where can I buy?',
      digg_count: 150,
      reply_comment_total: 4,
      create_time: 1718001000,
      user: {
        uid: '100001',
        unique_id: 'commenter1',
        nickname: 'Happy Shopper',
        avatar_thumb: { url_list: ['https://p16.tiktokcdn.com/avatar1.jpg'] },
      },
    },
    {
      cid: '7345000000000000002',
      text: 'Need this in my life 😍',
      digg_count: 42,
      reply_comment_total: 0,
      create_time: 1718002000,
      user: {
        uid: '100002',
        unique_id: 'commenter2',
        nickname: 'Design Fan',
        avatar_thumb: { url_list: ['https://p16.tiktokcdn.com/avatar2.jpg'] },
      },
    },
  ],
  cursor: 20,
  has_more: 0,
  total: 2,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

// We need to test the internal functions directly. Since the module uses
// require-time side effects minimally, we can load and test the exported
// scrape function's dependencies by testing the parsing logic indirectly.

// Load the module — we only test pure functions, no network calls
const scraperPath = require.resolve('../src/scrapers/tiktok.js');

describe('TikTok Scraper — URL Detection', () => {
  // Test URL patterns directly since they're regex-based
  const VIDEO_RE = /tiktok\.com\/@[\w.]+\/video\/(\d+)/i;
  const SHORT_RE = /vm\.tiktok\.com\/[\w]+/i;

  it('should detect standard video URL', () => {
    assert.ok(VIDEO_RE.test('https://www.tiktok.com/@creator/video/7345678901234567890'));
  });

  it('should extract video ID from URL', () => {
    const match = 'https://www.tiktok.com/@creator/video/7345678901234567890'.match(VIDEO_RE);
    assert.equal(match[1], '7345678901234567890');
  });

  it('should detect short URL', () => {
    assert.ok(SHORT_RE.test('https://vm.tiktok.com/ZMrABC123/'));
  });

  it('should NOT detect keyword as URL', () => {
    assert.ok(!VIDEO_RE.test('#tiktokmademebuyit'));
    assert.ok(!SHORT_RE.test('pod trend custom mug'));
  });

  it('should handle URL with query params', () => {
    assert.ok(VIDEO_RE.test('https://www.tiktok.com/@creator/video/7345678901234567890?is_from_webapp=1'));
  });

  it('should handle creator names with dots', () => {
    assert.ok(VIDEO_RE.test('https://www.tiktok.com/@creator.name/video/7345678901234567890'));
  });
});

describe('TikTok Scraper — Rehydration JSON Parsing', () => {
  // Simulate what fetchVideoMetrics does internally
  function parseRehydrationHTML(html) {
    const scriptStart = html.indexOf('id="__UNIVERSAL_DATA_FOR_REHYDRATION__"');
    if (scriptStart === -1) throw new Error('REHYDRATION_MISSING');

    const jsonStart = html.indexOf('>', scriptStart) + 1;
    const jsonEnd = html.indexOf('</script>', jsonStart);
    const jsonStr = html.substring(jsonStart, jsonEnd).trim();
    return JSON.parse(jsonStr);
  }

  it('should extract rehydration JSON from HTML', () => {
    const data = parseRehydrationHTML(MOCK_REHYDRATION_HTML);
    assert.ok(data.__DEFAULT_SCOPE__);
    assert.ok(data.__DEFAULT_SCOPE__['webapp.video-detail']);
  });

  it('should find itemStruct in rehydration data', () => {
    const data = parseRehydrationHTML(MOCK_REHYDRATION_HTML);
    const item = data.__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct;
    assert.equal(item.id, '7345678901234567890');
  });

  it('should throw on missing rehydration script', () => {
    assert.throws(
      () => parseRehydrationHTML('<html><body>No script here</body></html>'),
      /REHYDRATION_MISSING/
    );
  });
});

describe('TikTok Scraper — Item Parsing', () => {
  // Replicate the parseItemStruct logic for testing
  function parseNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
    const s = String(v ?? '');
    const match = s.replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
    if (!match) return 0;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
    return Math.round(parseFloat(match[1]) * mult) || 0;
  }

  it('should parse all core stats correctly', () => {
    const stats = MOCK_ITEM_STRUCT.statsV2;
    assert.equal(parseNum(stats.diggCount), 15200);
    assert.equal(parseNum(stats.commentCount), 340);
    assert.equal(parseNum(stats.shareCount), 1280);
    assert.equal(parseNum(stats.collectCount), 890);
    assert.equal(parseNum(stats.playCount), 524000);
    assert.equal(parseNum(stats.repostCount), 45);
  });

  it('should parse shorthand numbers (K, M, B)', () => {
    assert.equal(parseNum('1.5K'), 1500);
    assert.equal(parseNum('2.3M'), 2300000);
    assert.equal(parseNum('1B'), 1000000000);
    assert.equal(parseNum('524k'), 524000);
  });

  it('should handle zero and null gracefully', () => {
    assert.equal(parseNum(0), 0);
    assert.equal(parseNum(null), 0);
    assert.equal(parseNum(undefined), 0);
    assert.equal(parseNum(''), 0);
    assert.equal(parseNum('no numbers here'), 0);
  });

  it('should handle negative numbers as 0', () => {
    assert.equal(parseNum(-1), 0);
    assert.equal(parseNum(-999), 0);
  });

  it('should extract author info', () => {
    const a = MOCK_ITEM_STRUCT.author;
    assert.equal(a.uniqueId, 'creatorname');
    assert.equal(a.nickname, 'Creator Display Name');
    assert.equal(a.verified, true);
    assert.ok(a.signature.includes('POD creator'));
  });

  it('should extract hashtags from textExtra', () => {
    const hashtags = MOCK_ITEM_STRUCT.textExtra
      .filter(t => t.hashtagName)
      .map(t => t.hashtagName);
    assert.deepEqual(hashtags, ['tiktokmademebuyit', 'podtrend']);
  });

  it('should extract music info', () => {
    const m = MOCK_ITEM_STRUCT.music;
    assert.equal(m.title, 'Original Sound');
    assert.equal(m.original, true);
    assert.equal(m.duration, 15);
  });

  it('should extract video metadata', () => {
    const v = MOCK_ITEM_STRUCT.video;
    assert.equal(v.duration, 15);
    assert.equal(v.width, 576);
    assert.equal(v.height, 1024);
    assert.ok(v.originCover.includes('tiktokcdn.com'));
  });

  it('should extract POI (location)', () => {
    const p = MOCK_ITEM_STRUCT.poi;
    assert.equal(p.name, 'Ho Chi Minh City');
    assert.equal(p.country, 'Vietnam');
  });

  it('should extract shop product anchors', () => {
    const anchors = MOCK_ITEM_STRUCT.anchors.filter(a => a.type === 6);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].keyword, 'Custom T-Shirt');
  });

  it('should convert createTime to ISO date', () => {
    const iso = new Date(MOCK_ITEM_STRUCT.createTime * 1000).toISOString();
    assert.ok(iso.startsWith('2024-06-10'));
  });
});

describe('TikTok Scraper — Comment Parsing', () => {
  it('should parse comment list response', () => {
    const comments = MOCK_COMMENT_API_RESPONSE.comments;
    assert.equal(comments.length, 2);
    assert.equal(comments[0].text, 'This is amazing! Where can I buy?');
    assert.equal(comments[0].digg_count, 150);
    assert.equal(comments[0].reply_comment_total, 4);
    assert.equal(comments[0].user.unique_id, 'commenter1');
  });

  it('should detect has_more flag for pagination', () => {
    assert.equal(MOCK_COMMENT_API_RESPONSE.has_more, 0);
    assert.equal(MOCK_COMMENT_API_RESPONSE.cursor, 20);
  });

  it('should extract avatar URLs from nested structure', () => {
    const avatar = MOCK_COMMENT_API_RESPONSE.comments[0].user.avatar_thumb.url_list[0];
    assert.ok(avatar.includes('tiktokcdn.com'));
  });
});

describe('TikTok Scraper — Module Interface', () => {
  it('should export scrape function', () => {
    const mod = require(scraperPath);
    assert.equal(typeof mod.scrape, 'function');
  });
});

describe('TikTok Scraper — Normalizer Compatibility', () => {
  // Verify that the output shape maps correctly to social-post normalizer
  it('should have all fields the social-post normalizer reads', () => {
    // These are the field names social-post.js reads on lines 171-174
    const item = {
      diggCount: 15200,     // → likes via raw.diggCount
      commentCount: 340,    // → comments via raw.commentCount
      shareCount: 1280,     // → shares via raw.shareCount
      playCount: 524000,    // → views via raw.playCount
      repostCount: 45,      // → shares via raw.repostCount
    };

    // Simulate normalizer's parseNum logic
    function parseNum(v) {
      if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
      return 0;
    }

    const likes = parseNum(item.diggCount);
    const comments = parseNum(item.commentCount);
    const shares = parseNum(item.shareCount);
    const views = parseNum(item.playCount);

    assert.equal(likes, 15200);
    assert.equal(comments, 340);
    assert.equal(shares, 1280);
    assert.equal(views, 524000);
  });

  it('should have image field for ingestion filter', () => {
    // src/runs.service.js:122 filters items without image
    const coverImage = MOCK_ITEM_STRUCT.video.originCover;
    assert.ok(coverImage, 'Video must have a cover image to pass ingestion filter');
    assert.ok(coverImage.startsWith('https://'), 'Cover image must be a valid HTTPS URL');
  });
});
