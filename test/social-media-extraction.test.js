/**
 * TASK-3 — media (image/video) extraction for Reddit, X/Twitter and Facebook
 * Posts.
 *
 * Pure unit tests: no database, no network, no browser. They exercise exactly
 * the two layers that decide whether a post reaches product_current with a
 * usable image/video:
 *
 *   src/scrapers/reddit.js      field mapping of the Reddit t3 payload
 *   src/image-utils.js          heterogeneous media resolution
 *   src/normalize/social-post.js  the shared social normalizer
 *
 * Run with:  node --test test/social-media-extraction.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractRedditImage,
  extractRedditVideo,
  isEndpointFailure,
  isBoundedRetryable,
} = require('../src/scrapers/reddit');
const {
  extractImage,
  extractTwitterVideo,
  extractVideoCover,
  generateTextPostCapture,
  generateVideoCoverCapture,
} = require('../src/image-utils');
const normalizeSocialPost = require('../src/normalize/social-post');

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------

test('reddit: a v.redd.it video post yields a playable video URL', () => {
  const t3 = {
    id: 'vid1',
    title: 'Nail transformation',
    is_video: true,
    media: { reddit_video: { fallback_url: 'https://v.redd.it/xyz9876/DASH_720.mp4?source=fallback' } },
    preview: { images: [{ source: { url: 'https://external-preview.redd.it/vidthumb.jpg?auto=webp' } }] },
  };
  assert.equal(extractRedditVideo(t3), 'https://v.redd.it/xyz9876/DASH_720.mp4?source=fallback');
  // The poster image must still resolve — a video post is not an image-less post.
  assert.equal(extractRedditImage(t3), 'https://external-preview.redd.it/vidthumb.jpg?auto=webp');
});

test('reddit: secure_media and reddit_video_preview are read too', () => {
  assert.equal(
    extractRedditVideo({ secure_media: { reddit_video: { fallback_url: 'https://v.redd.it/aaa/DASH_480.mp4' } } }),
    'https://v.redd.it/aaa/DASH_480.mp4'
  );
  assert.equal(
    extractRedditVideo({ preview: { reddit_video_preview: { fallback_url: 'https://v.redd.it/bbb/DASH_360.mp4' } } }),
    'https://v.redd.it/bbb/DASH_360.mp4'
  );
});

test('reddit: a text post reports no video and no image, never a substitute', () => {
  const t3 = { id: 'txt', title: 'How do you test broad match keywords?', thumbnail: 'self', selftext: 'words' };
  assert.equal(extractRedditVideo(t3), '');
  assert.equal(extractRedditImage(t3), '');
});

test('reddit: the scraper item shape survives the normalizer with image AND video', () => {
  // Exactly the object src/scrapers/reddit.js:scrapeApi() now emits.
  const scraperItem = {
    platform: 'reddit',
    title: 'Nail transformation',
    url: 'https://reddit.com/r/Nails/comments/vid1/x',
    author: 'someone',
    likes: 486,
    comments: 112,
    shares: 0,
    views: 0,
    image: 'https://external-preview.redd.it/vidthumb.jpg?auto=webp',
    videoUrl: 'https://v.redd.it/xyz9876/DASH_720.mp4',
    created_utc: '2026-09-01T00:00:00.000Z',
    subreddit: 'Nails',
    domain: 'v.redd.it',
    selftext: '',
    thumbnail: '',
    score: 486,
    upvote_ratio: 0.98,
    id: 'vid1',
  };
  const n = normalizeSocialPost(scraperItem, { platform: 'reddit' });
  assert.equal(n.image, 'https://external-preview.redd.it/vidthumb.jpg?auto=webp');
  assert.equal(n.videoUrl, 'https://v.redd.it/xyz9876/DASH_720.mp4');
  assert.equal(n.mediaType, 'video');
});

test('reddit: a plain image post still normalizes to an image, unchanged', () => {
  const n = normalizeSocialPost({
    platform: 'reddit', title: 'Look', url: 'https://reddit.com/r/Nails/comments/def/y',
    author: 'someone', likes: 1, comments: 0, image: 'https://i.redd.it/somepic1234.jpg',
    videoUrl: '', subreddit: 'Nails', thumbnail: 'self', id: 'def',
  }, { platform: 'reddit' });
  assert.equal(n.image, 'https://i.redd.it/somepic1234.jpg');
  assert.equal(n.videoUrl, '');
  assert.equal(n.mediaType, 'image');
});

test('reddit: an undici "fetch failed" error is classified from err.cause, not dropped', () => {
  // Reproduces exactly what global fetch() throws when the connection is
  // refused: message is the useless "fetch failed", the real code is in cause.
  const undiciError = new Error('fetch failed');
  undiciError.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
  assert.equal(isBoundedRetryable(undiciError), true,
    'a refused connection must be retryable/escalatable, not an unclassified hard failure');

  const dnsError = new Error('fetch failed');
  dnsError.cause = Object.assign(new Error('getaddrinfo ENOTFOUND www.reddit.com'), { code: 'ENOTFOUND' });
  assert.equal(isBoundedRetryable(dnsError), true);
});

test('reddit: existing message-based classification is unchanged', () => {
  assert.equal(isEndpointFailure(new Error('HTTP 404: Not Found')), true);
  assert.equal(isEndpointFailure(new Error('BLOCKED_IP: Reddit blocked this IP.')), true);
  assert.equal(isBoundedRetryable(new Error('HTTP 429: Too Many Requests')), true);
  assert.equal(isBoundedRetryable(new Error('TimeoutError')), true);
  // EMPTY_RESULT stays unclassified on purpose — it must propagate, never
  // trigger a browser escalation.
  const empty = new Error('EMPTY_RESULT: no posts found');
  assert.equal(isEndpointFailure(empty), false);
  assert.equal(isBoundedRetryable(empty), false);
  // A null/undefined error must not throw.
  assert.equal(isEndpointFailure(null), false);
  assert.equal(isBoundedRetryable(undefined), false);
});

// ---------------------------------------------------------------------------
// X / Twitter
// ---------------------------------------------------------------------------

test('twitter: a video tweet yields the highest-bitrate mp4 plus its poster', () => {
  const tweet = {
    id: '5',
    text: 'tweet with video',
    url: 'https://x.com/a/status/5',
    extended_entities: {
      media: [{
        type: 'video',
        media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/5/pu/img/thumb.jpg',
        video_info: {
          variants: [
            { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/5/pu/pl/playlist.m3u8' },
            { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/5/pu/vid/320x568/low.mp4' },
            { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/5/pu/vid/720x1280/high.mp4' },
          ],
        },
      }],
    },
  };
  assert.equal(extractTwitterVideo(tweet), 'https://video.twimg.com/ext_tw_video/5/pu/vid/720x1280/high.mp4');

  const n = normalizeSocialPost(tweet, { platform: 'twitter' });
  assert.equal(n.image, 'https://pbs.twimg.com/ext_tw_video_thumb/5/pu/img/thumb.jpg');
  assert.equal(n.videoUrl, 'https://video.twimg.com/ext_tw_video/5/pu/vid/720x1280/high.mp4');
  assert.equal(n.mediaType, 'video');
});

test('twitter: a photo tweet is unchanged — image only, no video', () => {
  const n = normalizeSocialPost({
    id: '1', text: 'tweet', url: 'https://x.com/a/status/1',
    mediaUrls: ['https://pbs.twimg.com/media/ABC123.jpg'],
  }, { platform: 'twitter' });
  assert.equal(n.image, 'https://pbs.twimg.com/media/ABC123.jpg');
  assert.equal(n.videoUrl, '');
  assert.equal(n.mediaType, 'image');
});

test('twitter: a text-only tweet generates a capture preview image and no video', () => {
  const n = normalizeSocialPost({ id: '6', text: 'just words', url: 'https://x.com/a/status/6' }, { platform: 'twitter' });
  assert.match(n.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(n.videoUrl, '');
});

test('twitter video extraction cannot leak into another platform', () => {
  // The normalizer is shared. A non-Twitter payload carrying a video_info-like
  // structure whose URL is not video.twimg.com must resolve to nothing.
  assert.equal(extractTwitterVideo({
    extended_entities: { media: [{ video_info: { variants: [{ bitrate: 1, url: 'https://evil.example.com/a.mp4' }] } }] },
  }), '');
  const n = normalizeSocialPost({
    id: 'p', url: 'https://www.pinterest.com/pin/1/', title: 'pin',
    images: ['https://i.pinimg.com/originals/aa/bb/cc/aabbcc.jpg'],
    extended_entities: { media: [{ video_info: { variants: [{ bitrate: 1, url: 'https://cdn.pinimg.com/x.mp4' }] } }] },
  }, { platform: 'pinterest' });
  assert.equal(n.videoUrl, '');
});

// ---------------------------------------------------------------------------
// Facebook Posts
// ---------------------------------------------------------------------------

test('facebook: media[].photo_image.uri resolves to the post image', () => {
  const post = {
    post_id: 'p1',
    message: 'post',
    url: 'https://www.facebook.com/groups/1/posts/2',
    media: [{ photo_image: { uri: 'https://scontent.fbcdn.net/v/t39/abc1234.jpg' } }],
  };
  assert.equal(extractImage(post), 'https://scontent.fbcdn.net/v/t39/abc1234.jpg');
  assert.equal(normalizeSocialPost(post, { platform: 'facebook_posts' }).image,
    'https://scontent.fbcdn.net/v/t39/abc1234.jpg');
});

test('facebook: shapes that already worked keep working', () => {
  const cases = [
    [{ attachments: [{ media: { image: { uri: 'https://scontent.fbcdn.net/v/t39/def5678.jpg' } } }] },
      'https://scontent.fbcdn.net/v/t39/def5678.jpg'],
    [{ image: { uri: 'https://scontent.fbcdn.net/v/t39/ghi9012.jpg' } },
      'https://scontent.fbcdn.net/v/t39/ghi9012.jpg'],
    [{ thumbnailUrl: 'https://scontent.fpaz3-1.fna.fbcdn.net/v/t51.71878-10/753990199.jpg' },
      'https://scontent.fpaz3-1.fna.fbcdn.net/v/t51.71878-10/753990199.jpg'],
    [{ album_preview: [{ image_file_uri: 'https://scontent.fbcdn.net/v/t39/alb.jpg' }] },
      'https://scontent.fbcdn.net/v/t39/alb.jpg'],
  ];
  for (const [raw, expected] of cases) assert.equal(extractImage(raw), expected);
});

test('facebook: a facebook.com page URL is still rejected as an image', () => {
  // Regression guard on cleanImageUrl()'s HTML-page exclusion.
  assert.equal(extractImage({ image: 'https://www.facebook.com/groups/123/posts/456' }), '');
});

test('facebook: scraper_one post shape normalizes with postText, postId, reactions, shares, and attachment images', () => {
  const post = {
    url: 'https://www.facebook.com/cutepolish/posts/pfbid0xpc7w4bozKeXQksLSTbs7YvM7V8UfcQmtciXK6RtfCvayNJjF39enjekwEPEw3FMl',
    timestamp: 1789389001000,
    postText: 'The perfect colors for the fall season #nails #nailart',
    reactionsCount: 571,
    reactions: { like: 489, love: 79 },
    commentsCount: 5,
    sharesCount: 60,
    postId: '1628761185277632',
    author: { id: '100044312985667', name: 'cutepolish' },
    attachments: [
      {
        type: 'photo',
        url: 'https://scontent-iad6-1.xx.fbcdn.net/v/t39.30808-6/808847578_1627854785368272_1149881197520267200_n.jpg',
        id: '1628761151944302'
      }
    ]
  };

  const n = normalizeSocialPost(post, { platform: 'facebook_posts' });
  assert.equal(n.uid, 'facebook_posts:1628761185277632');
  assert.equal(n.author, 'cutepolish');
  assert.equal(n.title, 'The perfect colors for the fall season #nails #nailart');
  assert.equal(n.body, 'The perfect colors for the fall season #nails #nailart');
  assert.equal(n.likes, 571);
  assert.equal(n.comments, 5);
  assert.equal(n.shares, 60);
  assert.equal(n.image, 'https://scontent-iad6-1.xx.fbcdn.net/v/t39.30808-6/808847578_1627854785368272_1149881197520267200_n.jpg');
  assert.equal(n.mediaCount, 1);
  assert.equal(n.mediaItems[0].imageUrl, 'https://scontent-iad6-1.xx.fbcdn.net/v/t39.30808-6/808847578_1627854785368272_1149881197520267200_n.jpg');
});

test('reddit: fatihtahta post shape normalizes with score, num_comments, gallery_images and media_assets', () => {
  const post = {
    kind: 'post',
    id: '1v9tulr',
    title: 'Mom’s Recent Sets of Nails (She’s 78)',
    author: 'selfcarethings',
    score: 8792,
    num_comments: 297,
    url: 'https://www.reddit.com/r/beauty/comments/1v9tulr/',
    thumbnail: 'https://preview.redd.it/ijs728rhlkvg1.jpg?width=140',
    gallery_images: [
      { url: 'https://preview.redd.it/ijs728rhlkvg1.jpg?width=3024' },
      { url: 'https://preview.redd.it/kc0xe4rhlkvg1.jpg?width=3024' }
    ],
    media_assets: [
      { original_url: 'https://preview.redd.it/ijs728rhlkvg1.jpg?width=3024' },
      { original_url: 'https://preview.redd.it/kc0xe4rhlkvg1.jpg?width=3024' }
    ]
  };

  const n = normalizeSocialPost(post, { platform: 'reddit' });
  assert.equal(n.uid, 'reddit:1v9tulr');
  assert.equal(n.author, 'selfcarethings');
  assert.equal(n.title, 'Mom’s Recent Sets of Nails (She’s 78)');
  assert.equal(n.likes, 8792);
  assert.equal(n.comments, 297);
  assert.equal(n.image, 'https://preview.redd.it/ijs728rhlkvg1.jpg?width=3024');
  assert.equal(n.mediaCount, 2);
  assert.equal(n.mediaItems.length, 2);
  assert.equal(n.mediaItems[0].imageUrl, 'https://preview.redd.it/ijs728rhlkvg1.jpg?width=3024');
  assert.equal(n.mediaItems[1].imageUrl, 'https://preview.redd.it/kc0xe4rhlkvg1.jpg?width=3024');
});

// ---------------------------------------------------------------------------
// Video Cover & Text Post Capture Cards
// ---------------------------------------------------------------------------

test('reddit: text-only post without image generates SVG post capture preview card', () => {
  const textPost = {
    id: 'post_txt_1',
    title: 'Press on nails discussion and tips',
    body: 'What are the best tips for applying press on nails that last 2+ weeks?',
    author: 'nail_enthusiast',
    score: 142,
    num_comments: 38,
    subreddit: 'Nails',
    url: 'https://reddit.com/r/Nails/comments/post_txt_1',
    thumbnail: 'self'
  };

  const n = normalizeSocialPost(textPost, { platform: 'reddit' });
  assert.ok(n.image, 'Must carry an image');
  assert.match(n.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(n.captureImage, n.image);
  assert.equal(n.videoUrl, '');
  assert.equal(n.mediaType, 'image');

  // Verify SVG content decoding
  const base64Data = n.image.replace(/^data:image\/svg\+xml;base64,/, '');
  const svgText = Buffer.from(base64Data, 'base64').toString('utf8');
  assert.ok(svgText.includes('r/Nails'));
  assert.ok(svgText.includes('nail_enthusiast'));
  assert.ok(svgText.includes('Press on nails discussion'));
  assert.ok(svgText.includes('142')); // likes
  assert.ok(svgText.includes('38'));  // comments
});

test('video: extracts video cover from candidate fields across platforms', () => {
  // TikTok video with videoMeta.coverUrl
  const tiktokItem = {
    id: 'tk1',
    title: 'Viral nail tutorial',
    videoMeta: {
      coverUrl: 'https://p16-sign.tiktokcdn.com/cover123.jpg'
    },
    videoUrl: 'https://v16.tiktokcdn.com/video123.mp4'
  };
  assert.equal(extractVideoCover(tiktokItem), 'https://p16-sign.tiktokcdn.com/cover123.jpg');
  const nTk = normalizeSocialPost(tiktokItem, { platform: 'tiktok_videos' });
  assert.equal(nTk.image, 'https://p16-sign.tiktokcdn.com/cover123.jpg');
  assert.equal(nTk.mediaType, 'video');

  // Reddit video with preview.images
  const redditVideo = {
    id: 'rv1',
    title: 'Nail transformation video',
    is_video: true,
    videoUrl: 'https://v.redd.it/test/DASH_720.mp4',
    preview: {
      images: [{ source: { url: 'https://external-preview.redd.it/cover789.jpg' } }]
    }
  };
  assert.equal(extractVideoCover(redditVideo), 'https://external-preview.redd.it/cover789.jpg');
  const nRv = normalizeSocialPost(redditVideo, { platform: 'reddit' });
  assert.equal(nRv.image, 'https://external-preview.redd.it/cover789.jpg');
  assert.equal(nRv.mediaType, 'video');
});

test('video: generates fallback video poster when remote API provides no cover thumbnail', () => {
  const videoWithoutPoster = {
    id: 'vid_no_cover',
    title: 'Demonstration video without thumbnail',
    videoUrl: 'https://v.redd.it/no_thumb/video.mp4',
    author: 'creator123',
    type: 'video'
  };

  const n = normalizeSocialPost(videoWithoutPoster, { platform: 'reddit' });
  assert.ok(n.image, 'Must carry an image');
  assert.match(n.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(n.mediaType, 'video');

  const base64Data = n.image.replace(/^data:image\/svg\+xml;base64,/, '');
  const svgText = Buffer.from(base64Data, 'base64').toString('utf8');
  assert.ok(svgText.includes('VIDEO'));
  assert.ok(svgText.includes('Demonstration video'));
});



