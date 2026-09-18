/**
 * TASK — a video item must carry THAT VIDEO'S COVER FRAME as its image.
 *
 * User report (verbatim):
 *   "3. video thì phải lấy đc ảnh bìa của video đó nữa nhé"
 *   "5. ... tiktok videos thì ảnh lấy đc đang bị sai, phải là ảnh bìa của
 *       video đó chứ ko phải ảnh avt tài khoản"
 *
 * Every fixture below is trimmed from a REAL stored payload, not invented:
 *
 *   tiktok_videos    clockworks/tiktok-scraper, run 949 / dataset
 *                    2VvOrR0hbk1BfqcFJ, query "gái xinh", 2026-09-18.
 *   facebook_posts   apify facebook-posts, dataset est9wYPdtqkvHl4sf.
 *   facebook_ads     memo23 facebook-ads-library-scraper-ppe, dataset
 *                    1q4aWMCb1a1dFEoCB, advertiser MoxieLash.
 *
 * Signed CDN query strings are stripped from the fixtures — they expire, and
 * none of the behaviour under test depends on them.
 *
 * Covered by src/normalize/social-post.js and src/image-utils.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const normalizeSocialPost = require('../src/normalize/social-post');
const normalizeAdCreative = require('../src/normalize/ad-creative');
const {
  extractVideoCover,
  extractExplicitVideoCover,
  isVideoFileUrl,
} = require('../src/image-utils');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TIKTOK_COVER = 'https://p19-common-sign.tiktokcdn-us.com/tos-alisg-p-0037/oYdmSqgpfAQmRxegDDRq4GBsvEBUFEklUrmQV5~tplv-tiktokx-origin.image';
const TIKTOK_AVATAR = 'https://p16-common-sign.tiktokcdn-us.com/musically-maliva-obj/1594805258216454~tplv-tiktokx-cropcenter:720:720.jpeg';

/**
 * The key ORDER here is load-bearing and is the actor's own: authorMeta is
 * emitted before videoMeta. extractImage() walks Object.entries() in insertion
 * order and `authormeta` / `avatar` are both in IMAGE_VALUE_KEYS, so the walk
 * used to reach the creator's avatar before it ever saw videoMeta.coverUrl.
 */
function tiktokVideoItem(overrides = {}) {
  return {
    id: '7685036939292019989',
    text: 'Thả tim em tự tìm tới #gaixinhtiktok #gaixinhvn123',
    createTimeISO: '2026-09-16T04:12:33.000Z',
    isAd: false,
    authorMeta: {
      id: '7016548818983273498',
      name: 'gaixinhtonghop11',
      nickName: 'Gái Xinh Tổng Hợp',
      avatar: TIKTOK_AVATAR,
      originalAvatarUrl: TIKTOK_AVATAR,
      fans: 12800,
    },
    musicMeta: { musicName: 'original sound', musicAuthor: 'gaixinhtonghop11' },
    webVideoUrl: 'https://www.tiktok.com/@gaixinhtonghop11/video/7685036939292019989',
    videoMeta: {
      height: 1024,
      width: 576,
      duration: 8,
      coverUrl: TIKTOK_COVER,
      definition: '540p',
      format: 'mp4',
      originalCoverUrl: TIKTOK_COVER,
    },
    diggCount: 30,
    shareCount: 0,
    playCount: 314,
    collectCount: 0,
    commentCount: 2,
    isSlideshow: false,
    // shouldDownloadVideos is false in the actor input builder, so the real
    // payload carries no playable URL at all.
    mediaUrls: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) + (b) TikTok — the cover, never the avatar
// ---------------------------------------------------------------------------

test('tiktok: a video resolves videoMeta.coverUrl as its image', () => {
  const n = normalizeSocialPost(tiktokVideoItem(), { platform: 'tiktok_videos' });
  assert.equal(n.image, TIKTOK_COVER);
  assert.equal(n.captureImage, TIKTOK_COVER);
});

test('tiktok: the same payload never resolves the author avatar', () => {
  const raw = tiktokVideoItem();
  const n = normalizeSocialPost(raw, { platform: 'tiktok_videos' });

  // This is the exact defect the user reported: run 949 stored every TikTok row
  // wearing its creator's profile picture.
  assert.notEqual(n.image, raw.authorMeta.avatar);
  assert.notEqual(n.image, raw.authorMeta.originalAvatarUrl);
  // `avt` is TikTok's own path segment for avatar assets; `musically-maliva-obj`
  // is the other bucket the avatars in run 949 came from.
  assert.doesNotMatch(n.image, /-avt-|musically-maliva-obj/);
  // The author is still read — only the picture is refused.
  assert.equal(n.author, 'gaixinhtonghop11');
});

test('tiktok: an avatar cannot stand in even when videoMeta carries no cover', () => {
  // (d) — a video with no cover anywhere must report none, not substitute the
  // nearest available picture.
  const raw = tiktokVideoItem({
    videoMeta: { height: 1024, width: 576, duration: 8, definition: '540p', format: 'mp4' },
  });
  assert.equal(extractExplicitVideoCover(raw), '');

  const n = normalizeSocialPost(raw, { platform: 'tiktok_videos' });
  assert.notEqual(n.image, TIKTOK_AVATAR);
  // The only acceptable stand-in is the project's existing generated poster.
  assert.match(n.image, /^data:image\/svg\+xml;base64,/);
});

test('tiktok: a video is typed as video even with no playable URL in the payload', () => {
  const n = normalizeSocialPost(tiktokVideoItem(), { platform: 'tiktok_videos' });
  assert.equal(n.mediaType, 'video');
  assert.equal(n.videoUrl, '');
});

test('tiktok: originalCoverUrl carries the cover when coverUrl is absent', () => {
  const raw = tiktokVideoItem({
    videoMeta: { duration: 8, format: 'mp4', originalCoverUrl: TIKTOK_COVER },
  });
  assert.equal(extractExplicitVideoCover(raw), TIKTOK_COVER);
  assert.equal(normalizeSocialPost(raw, { platform: 'tiktok_videos' }).image, TIKTOK_COVER);
});

// ---------------------------------------------------------------------------
// (d) Facebook posts — a video whose payload genuinely has no cover
// ---------------------------------------------------------------------------

const FB_VIDEO_MP4 = 'https://video-iad6-1.xx.fbcdn.net/o1/v/t2/f2/m366/AQNYmAXfak_YGkebpb7CYcTVJ-LSg.mp4';
const FB_AUTHOR_AVATAR = 'https://scontent-iad3-1.xx.fbcdn.net/v/t39.30808-1/745541959_122107619913385560_5735567536102412858_n.jpg';

function facebookVideoPost() {
  return {
    url: 'https://www.facebook.com/reel/4261615430757729/',
    timestamp: '2026-09-14T09:03:00.000Z',
    postText: 'These press-ons last three weeks',
    reactionsCount: 412,
    commentsCount: 18,
    sharesCount: 7,
    postId: '122108269953385560',
    author: { id: '61591566824097', name: 'The Nail Edit', profilePicture: FB_AUTHOR_AVATAR },
    attachments: [{ type: 'video', url: FB_VIDEO_MP4 }],
  };
}

test('facebook_posts: a video post never stores the mp4 itself as its image', () => {
  const n = normalizeSocialPost(facebookVideoPost(), { platform: 'facebook_posts' });

  // The generic walk reads `attachments` then `url`, so the mp4 was being
  // rendered into an <img>. Verified on dataset est9wYPdtqkvHl4sf.
  assert.notEqual(n.image, FB_VIDEO_MP4);
  assert.doesNotMatch(n.image, /\.mp4/);
  // The playable URL is still captured, just in the right field.
  assert.equal(n.videoUrl, FB_VIDEO_MP4);
  assert.equal(n.mediaType, 'video');
});

test('facebook_posts: a video post with no cover in the payload falls back to the generated poster, not the author avatar', () => {
  // Exhaustively checked on the real item: the ONLY URLs the payload contains
  // are the permalink, the author's avatar, the author's profile link and the
  // mp4. There is no cover field to find, so reporting one would be inventing.
  const n = normalizeSocialPost(facebookVideoPost(), { platform: 'facebook_posts' });
  assert.notEqual(n.image, FB_AUTHOR_AVATAR);
  assert.match(n.image, /^data:image\/svg\+xml;base64,/);
});

test('facebook_posts: a photo post is unaffected', () => {
  const photo = 'https://scontent-iad3-2.xx.fbcdn.net/v/t39.30808-6/791996922_1058936233512958_n.jpg';
  const n = normalizeSocialPost({
    url: 'https://www.facebook.com/permalink/1/',
    postText: 'new drop',
    postId: '1058937216846193',
    author: { name: 'The Nail Edit', profilePicture: FB_AUTHOR_AVATAR },
    attachments: [{ type: 'photo', url: photo, accessibilityCaption: 'May be an image of anklet' }],
  }, { platform: 'facebook_posts' });

  assert.equal(n.image, photo);
  assert.equal(n.mediaType, 'image');
  assert.equal(n.videoUrl, '');
});

// ---------------------------------------------------------------------------
// (c) facebook_ads — an advertiser's page picture is the RIGHT image for an ad
// ---------------------------------------------------------------------------

const ADS_VIDEO_POSTER = 'https://scontent.fcmb3-2.fna.fbcdn.net/v/t39.35426-6/671644952_1576054330166441_n.jpg';
const ADS_VIDEO_SD = 'https://video.fcmb12-1.fna.fbcdn.net/o1/v/t2/f2/m412/AQM_CUWJgCc1f0jbOrH7pDhSC44.mp4';
const ADS_PAGE_PICTURE = 'https://scontent.fcmb3-3.fna.fbcdn.net/v/t39.35426-6/671727420_1458018552471060_n.jpg';

test('facebook_ads: a video ad still resolves video_preview_image_url as its cover', () => {
  const n = normalizeAdCreative({
    ad_archive_id: '1658551088822389',
    page_name: 'MoxieLash',
    is_active: true,
    snapshot: {
      page_name: 'MoxieLash',
      page_profile_picture_url: ADS_PAGE_PICTURE,
      videos: [{
        video_preview_image_url: ADS_VIDEO_POSTER,
        video_sd_url: ADS_VIDEO_SD,
      }],
      cards: [],
      images: [],
    },
  }, { platform: 'facebook_ads' });

  assert.equal(n.image, ADS_VIDEO_POSTER);
  assert.equal(n.videoUrl, ADS_VIDEO_SD);
  assert.equal(n.mediaType, 'video');
});

test('facebook_ads: an ad with no creative image still falls back to the page profile picture', () => {
  // Deliberately UNCHANGED behaviour. An advertiser's page picture is a
  // legitimate image for an ad, which is why the avatar refusal above is scoped
  // to the social-post video path and never touches this normalizer.
  const n = normalizeAdCreative({
    ad_archive_id: '999',
    page_name: 'MoxieLash',
    snapshot: {
      page_name: 'MoxieLash',
      page_profile_picture_url: ADS_PAGE_PICTURE,
      cards: [],
      images: [],
      videos: [],
    },
  }, { platform: 'facebook_ads' });

  assert.equal(n.image, ADS_PAGE_PICTURE);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('isVideoFileUrl recognises video files and leaves pictures alone', () => {
  assert.equal(isVideoFileUrl(FB_VIDEO_MP4), true);
  assert.equal(isVideoFileUrl('https://v.redd.it/xyz/DASH_720.mp4?source=fallback'), true);
  assert.equal(isVideoFileUrl('https://video.twimg.com/ext/pl/playlist.m3u8'), true);
  assert.equal(isVideoFileUrl(TIKTOK_COVER), false);
  assert.equal(isVideoFileUrl(ADS_VIDEO_POSTER), false);
  assert.equal(isVideoFileUrl(''), false);
  assert.equal(isVideoFileUrl(null), false);
});

test('extractExplicitVideoCover only answers for keys that name a video cover', () => {
  assert.equal(extractExplicitVideoCover({ videoMeta: { coverUrl: TIKTOK_COVER } }), TIKTOK_COVER);
  assert.equal(extractExplicitVideoCover({ video_preview_image_url: ADS_VIDEO_POSTER }), ADS_VIDEO_POSTER);
  // A generic thumbnail/displayUrl is NOT unambiguous, so it stays with
  // extractVideoCover() as a last resort and never pre-empts the post's own
  // stated image.
  assert.equal(extractExplicitVideoCover({ thumbnail: 'https://example.com/t.jpg' }), '');
  assert.equal(extractExplicitVideoCover({ displayUrl: 'https://example.com/d.jpg' }), '');
  assert.equal(extractVideoCover({ thumbnail: 'https://example.com/t.jpg' }), 'https://example.com/t.jpg');
  // A cover field holding a video file is refused rather than passed through.
  assert.equal(extractExplicitVideoCover({ videoMeta: { coverUrl: FB_VIDEO_MP4 } }), '');
});

test('the reddit and twitter scraper shapes still win over a generic cover guess', () => {
  // Regression guard for the ordering change: these platforms state their
  // poster in `image` / extended_entities, and that must keep beating any
  // thumbnail-shaped fallback.
  const reddit = normalizeSocialPost({
    platform: 'reddit',
    title: 'Nail transformation',
    url: 'https://reddit.com/r/Nails/comments/vid1/x',
    author: 'someone',
    image: 'https://external-preview.redd.it/vidthumb.jpg?auto=webp',
    videoUrl: 'https://v.redd.it/xyz9876/DASH_720.mp4',
    is_video: true,
    thumbnail: 'https://b.thumbs.redditmedia.com/tiny140.jpg',
    id: 'vid1',
  }, { platform: 'reddit' });
  assert.equal(reddit.image, 'https://external-preview.redd.it/vidthumb.jpg?auto=webp');
  assert.equal(reddit.mediaType, 'video');

  const twitter = normalizeSocialPost({
    id: '5',
    text: 'tweet with video',
    url: 'https://x.com/a/status/5',
    extended_entities: {
      media: [{
        type: 'video',
        media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/5/pu/img/thumb.jpg',
        video_info: {
          variants: [{ bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/5/pu/vid/720x1280/high.mp4' }],
        },
      }],
    },
  }, { platform: 'twitter' });
  assert.equal(twitter.image, 'https://pbs.twimg.com/ext_tw_video_thumb/5/pu/img/thumb.jpg');
  assert.equal(twitter.mediaType, 'video');
});
