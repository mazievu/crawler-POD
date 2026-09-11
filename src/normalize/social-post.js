function parseNum(v) {
  // Instagram sends likesCount / commentsCount as -1 when the author has hidden
  // the count (run #423, post Dc-pYjViJw2). That is a sentinel, not a
  // measurement: engagement counts cannot be negative. Storing -1 would put an
  // impossible number in the DB and render "-1 likes" in the UI, so it collapses
  // to 0 here — and metric-conditions.readMetric() independently refuses to
  // treat any negative as a value, so a hidden count can never satisfy a
  // threshold either.
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  const match = String(v ?? '').replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
  if (!match) return 0;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(match[1]) * multiplier) || 0;
}

function parseDate(v) {
  if (!v) return new Date().toISOString();
  if (typeof v === 'number') {
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const { extractImage, cleanImageUrl } = require('../image-utils');

/**
 * Media extraction, written from the raw output of two real
 * apify/instagram-scraper hashtag runs (EV0HWljXkPyiep62F "pressonnails" and
 * g5ufjsIKQtpdqTNEn "nailtutorial", 5 items each, 2026-09-07).
 *
 * Field contract observed in that output:
 *   type          "Image" | "Sidecar" at top level; "Video" | "Image" inside
 *                 childPosts[]
 *   displayUrl    image CDN URL — present on every item and every child
 *   images[]      string[] of image CDN URLs, non-empty only for "Sidecar"
 *   childPosts[]  child media objects carrying their own type / displayUrl /
 *                 videoUrl / videoDuration
 *   videoUrl      direct video CDN URL — present on every child of type "Video"
 *
 * NOT observed across those 10 items, so deliberately mapped to nothing:
 * videoViewCount and videoPlayCount. A top-level videoUrl was likewise never
 * seen — the actor logged route SERVICE_HASHTAG_REGULAR_POSTS and "Hashtag
 * scraper is limited to one page for free users", which returns feed posts, so
 * video arrives as carousel children. It is still READ below because parent and
 * child share one object shape in this actor's output; when the field is absent
 * the result is an empty string, never a substitute.
 *
 * Other platforms have none of these keys and fall through to the pre-existing
 * extractImage() path unchanged.
 */
const MEDIA_TYPE_BY_RAW_TYPE = { image: 'image', sidecar: 'carousel', video: 'video' };

function cleanMediaUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim().replace(/&amp;/g, '&');
  if (url.length < 10) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function mediaNode(node) {
  if (!node || typeof node !== 'object') return null;
  const imageUrl = cleanImageUrl(node.displayUrl);
  const videoUrl = cleanMediaUrl(node.videoUrl);
  if (!imageUrl && !videoUrl) return null;
  return {
    type: MEDIA_TYPE_BY_RAW_TYPE[String(node.type || '').toLowerCase()] || (videoUrl ? 'video' : 'image'),
    imageUrl,
    videoUrl,
  };
}

function extractMedia(raw) {
  const children = Array.isArray(raw.childPosts) ? raw.childPosts : [];
  const mediaItems = [];

  // A carousel's own displayUrl is its cover and repeats children[0] — the
  // children are the actual media, so they are what gets listed.
  if (children.length > 0) {
    for (const child of children) {
      const node = mediaNode(child);
      if (node) mediaItems.push(node);
    }
  } else {
    const node = mediaNode(raw);
    if (node) mediaItems.push(node);
    // A "Sidecar" that arrives without childPosts still carries images[].
    if (Array.isArray(raw.images)) {
      for (const entry of raw.images) {
        const imageUrl = cleanImageUrl(entry);
        if (imageUrl && !mediaItems.some((m) => m.imageUrl === imageUrl)) {
          mediaItems.push({ type: 'image', imageUrl, videoUrl: '' });
        }
      }
    }
  }

  // Cover image: the post's own displayUrl when it has one, else the first
  // child carrying an image. Never an avatar — a post with no media of its own
  // reports none, which is a fact about the post rather than a gap to paper over.
  const image = cleanImageUrl(raw.displayUrl) || mediaItems.find((m) => m.imageUrl)?.imageUrl || extractImage(raw);
  const videoUrl = cleanMediaUrl(raw.videoUrl) || mediaItems.find((m) => m.videoUrl)?.videoUrl || '';

  let mediaType = MEDIA_TYPE_BY_RAW_TYPE[String(raw.type || '').toLowerCase()] || '';
  if (!mediaType) {
    if (mediaItems.length > 1) mediaType = 'carousel';
    else if (videoUrl) mediaType = 'video';
    else if (image) mediaType = 'image';
  }

  return { image, videoUrl, mediaType, mediaCount: mediaItems.length, mediaItems };
}

module.exports = function normalizeSocialPost(raw, context = { platform: 'social_post' }) {
  /*
   * The x.com fallback is Twitter-only. It used to fire for ANY platform whose
   * raw item happened to carry an `id`, and TikTok items do: every video from
   * clockworks/tiktok-scraper was stored under
   * `https://x.com/i/web/status/<tiktok id>` — a Twitter URL that does not
   * exist, used as the item's identity. Guarding it on the platform keeps the
   * fallback where it belongs; `webVideoUrl` is TikTok's own canonical link.
   */
  const isTwitter = context.platform === 'twitter';
  const twitterFallback = isTwitter
    ? (raw.id_str ? `https://x.com/i/web/status/${raw.id_str}` : (raw.id ? `https://x.com/i/web/status/${raw.id}` : ''))
    : '';
  const url = raw.url || raw.permalink || raw.link || raw.webVideoUrl || raw.twitterUrl || twitterFallback || '';
  const title = raw.title || raw.text || raw.full_text || raw.message || raw.message_rich || raw.caption || raw.description || '';
  
  let author = '';
  // clockworks/tiktok-scraper nests the creator under authorMeta and leaves
  // `author` unset, so every TikTok row was persisted with an empty author.
  // `name` is the @handle, which is the stable identity; nickName is the
  // display name and is free text.
  if (typeof raw.authorMeta === 'object' && raw.authorMeta) {
    author = raw.authorMeta.name || raw.authorMeta.nickName || raw.authorMeta.uniqueId || '';
  } else if (typeof raw.author === 'object' && raw.author) {
    author = raw.author.name || raw.author.username || raw.author.userName || raw.author.screen_name || raw.author.nickName || '';
  } else if (typeof raw.user === 'object' && raw.user) {
    author = raw.user.name || raw.user.screen_name || raw.user.username || '';
  } else {
    // ownerUsername/ownerFullName are what apify/instagram-scraper actually
    // returns (present on all 10 items of runs EV0HWljXkPyiep62F and
    // g5ufjsIKQtpdqTNEn); their absence from this list is why every Instagram
    // row was persisted with an empty author. The handle is preferred over the
    // display name because it is the stable identity and the part the post URL
    // resolves to — ownerFullName is free text and was seen carrying
    // decorative unicode.
    author = raw.author || raw.username || raw.userName || raw.screen_name || raw.pinnerUsername
      || raw.authorName || raw.ownerUsername || raw.ownerFullName || '';
  }

  // Bug found live (user report: "why can't I get images?"): the branches
  // below used to fall back to each PLATFORM's generic site favicon
  // (redditstatic.com, twimg.com icon, instagram favicon) whenever no real
  // post image was found — disguising "this post genuinely has no image"
  // (common for text-only Reddit posts) as if a real image had been
  // fetched. A favicon is not a post image; per this project's own
  // image-quality-gate rule (never a logo/favicon/placeholder), it must
  // never be assigned here.
  //
  // The author-avatar fallback that used to sit here is gone for the same
  // reason: an avatar is a picture of the poster, not the post's media, so
  // serving it as `image` made a post with no media indistinguishable from one
  // with media. extractMedia() resolves the real media, or reports none.
  const media = extractMedia(raw);
  const image = media.image;

  return {
    uid: `${context.platform}:${raw.id || raw.id_str || raw.post_id || url || title}`,
    type: 'social_post',
    platform: context.platform,
    author: String(author).substring(0, 100),
    title: String(title).substring(0, 200),
    body: raw.body || raw.content || raw.full_text || raw.text || raw.message_rich || raw.message || raw.caption || raw.selfText || '',
    url: url,
    image,
    videoUrl: media.videoUrl,
    mediaType: media.mediaType,
    mediaCount: media.mediaCount,
    mediaItems: media.mediaItems,
    likes: parseNum(raw.likes || raw.likeCount || raw.likesCount || raw.favorite_count || raw.favoriteCount || raw.favorites || raw.upvotes || raw.score || raw.reactions_count || raw.reactionCounts || raw.totalReactionCount || raw.reactions || raw.diggCount || 0),
    comments: parseNum(raw.comments || raw.commentCount || raw.commentsCount || raw.replyCount || raw.reply_count || raw.replies || raw.conversation_count || raw.num_comments || raw.numComments || raw.comments_count || 0),
    shares: parseNum(raw.shares || raw.shareCount || raw.sharesCount || raw.retweetCount || raw.retweet_count || raw.retweets || raw.repostCount || raw.reshare_count || raw.repin_count || raw.repinCount || raw.saves || 0),
    views: parseNum(raw.views || raw.viewCount || raw.viewsCount || raw.impressions || raw.impression_count || raw.view_count || raw.playCount || raw.video_view_count || 0),
    // Saves ("Lưu") is its own signal, not a share: TikTok reports collectCount
    // separately from shareCount, and folding one into the other would report a
    // number for shares that nobody measured. Verified on clockworks/tiktok-
    // scraper run bufWDKmTr1ENybDdK — one video returned 67,000 diggs, 4,929
    // shares and 20,238 collects: three different quantities.
    saves: parseNum(raw.saves || raw.collectCount || raw.collect_count || raw.bookmarkCount || 0),
    // Full comment text, on its way to the post_comments table. The normalizer
    // does not shape it — persistence does — but it has to survive this hop,
    // because the field list here is all that reaches the database.
    fullComments: Array.isArray(raw.fullComments) ? raw.fullComments
      : (Array.isArray(raw.comments_list) ? raw.comments_list : null),
    publishedAt: parseDate(raw.publishedAt || raw.createdAt || raw.created_at || raw.createTimeISO || raw.timestamp),
    raw: raw
  };
};
