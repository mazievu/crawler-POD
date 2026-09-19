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

const {
  extractImage,
  cleanImageUrl,
  extractTwitterVideo,
  extractVideoCover,
  extractExplicitVideoCover,
  isVideoFileUrl,
  generateTextPostCapture,
  generateVideoCoverCapture
} = require('../image-utils');

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

/*
 * Keys whose subtree describes the PERSON who posted, never the post's media.
 * Removed from the payload before the generic image walk runs for a video, so
 * an avatar can never be served as a video's cover frame.
 * `authorMeta` is TikTok's (clockworks), `author` Facebook posts' and X's,
 * `user` the older Twitter shape, `owner`/`pinner` Instagram's and Pinterest's.
 */
const AUTHOR_SUBTREE_KEYS = new Set([
  'authorMeta', 'author_meta', 'author', 'user', 'owner', 'pinner', 'profile', 'channel',
]);

function withoutAuthorSubtrees(raw) {
  const copy = {};
  for (const [key, value] of Object.entries(raw)) {
    if (AUTHOR_SUBTREE_KEYS.has(key)) continue;
    copy[key] = value;
  }
  return copy;
}

/*
 * Does this item carry a video at all?
 *
 * Every signal here was read off a real payload rather than guessed:
 *   videoMeta            clockworks/tiktok-scraper  (dataset 2VvOrR0hbk1BfqcFJ)
 *   attachments[].type   apify facebook-posts       (dataset est9wYPdtqkvHl4sf)
 *   is_video             reddit scraper             (dataset g53s9RBM6uK3Qe8QH)
 *   isVideo              pinterest scraper          (dataset zrgo7ZUG2DwRemVQv)
 *   videoUrl / type      reddit + instagram scraper shapes
 */
function isVideoPayload(raw, mediaItems) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.videoMeta && typeof raw.videoMeta === 'object') return true;
  if (cleanMediaUrl(raw.videoUrl)) return true;
  if (String(raw.type || '').toLowerCase() === 'video') return true;
  if (String(raw.kind || '').toLowerCase() === 'video') return true;
  if (raw.is_video === true || raw.isVideo === true) return true;
  return Array.isArray(mediaItems) && mediaItems.some((m) => m && m.videoUrl);
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
  } else if (Array.isArray(raw.attachments) && raw.attachments.length > 0) {
    for (const att of raw.attachments) {
      const isVid = att.type === 'video';
      const attImg = !isVid ? cleanImageUrl(att.url || att.displayUrl) : '';
      const attVid = isVid ? cleanMediaUrl(att.url || att.videoUrl) : '';
      if (attImg || attVid) {
        mediaItems.push({
          type: isVid ? 'video' : 'image',
          imageUrl: attImg,
          videoUrl: attVid,
        });
      }
    }
  } else if (Array.isArray(raw.gallery_images) && raw.gallery_images.length > 0) {
    for (const g of raw.gallery_images) {
      const imgUrl = cleanImageUrl(g?.url || g?.original_url || g);
      if (imgUrl && !mediaItems.some((m) => m.imageUrl === imgUrl)) {
        mediaItems.push({ type: 'image', imageUrl: imgUrl, videoUrl: '' });
      }
    }
  } else if (Array.isArray(raw.media_assets) && raw.media_assets.length > 0) {
    for (const m of raw.media_assets) {
      const isVid = String(m?.type || '').toLowerCase() === 'video';
      const imgUrl = !isVid ? cleanImageUrl(m?.original_url || m?.url) : '';
      const vidUrl = isVid ? cleanMediaUrl(m?.original_url || m?.url) : '';
      if (imgUrl || vidUrl) {
        mediaItems.push({
          type: isVid ? 'video' : 'image',
          imageUrl: imgUrl,
          videoUrl: vidUrl
        });
      }
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
    // Reddit old.reddit HTML table post preview
    if (mediaItems.length === 0 && raw.html && typeof raw.html === 'string' && /<img[^>]+src=/i.test(raw.html)) {
      const imgMatch = raw.html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (imgMatch && imgMatch[1]) {
        const htmlImg = cleanImageUrl(imgMatch[1]);
        if (htmlImg) {
          mediaItems.push({ type: 'image', imageUrl: htmlImg, videoUrl: '' });
        }
      }
    }
  }

  const hasVideo = isVideoPayload(raw, mediaItems);

  // Cover image: the post's own displayUrl when it has one, else the first
  // child carrying an image.
  let image = cleanImageUrl(raw.displayUrl) || mediaItems.find((m) => m.imageUrl)?.imageUrl || '';

  /*
   * A VIDEO's poster is resolved from the field the payload names for it BEFORE
   * the generic extractImage() walk gets a turn.
   *
   * Why the order matters — tiktok_videos, run 949 / dataset 2VvOrR0hbk1BfqcFJ
   * (2026-09-18). clockworks/tiktok-scraper emits its top-level keys in this
   * order: ... isAd, authorMeta, musicMeta, webVideoUrl, videoMeta ...
   * `authormeta` and `avatar` are both in IMAGE_VALUE_KEYS, so the generic walk
   * — which iterates insertion order — descended into authorMeta and returned
   * `authorMeta.avatar` before it ever reached `videoMeta.coverUrl`. Every
   * TikTok row in that run was stored wearing its creator's profile picture:
   *   stored image = https://p16-common-sign.tiktokcdn-us.com/tos-alisg-avt-0068/...
   *   real cover   = https://p19-common-sign.tiktokcdn-us.com/tos-alisg-p-0037/...
   * (`avt` = avatar). extractVideoCover() already knew the right field; nothing
   * ever called it, because the avatar made `image` truthy first.
   *
   * extractExplicitVideoCover() holds only keys that unambiguously mean "poster
   * of this video", so running it early cannot override a payload that states
   * its post image outright (the reddit/twitter scraper shapes, which put the
   * poster in `image` / extended_entities, still resolve through the walk).
   */
  if (!image && hasVideo) {
    image = extractExplicitVideoCover(raw);
  }

  if (!image) {
    // For a video, the walk runs with the author subtree removed: an avatar is
    // a picture of the poster, not of the post, and standing one in for a
    // missing cover is exactly the defect above. A video with no cover
    // anywhere must report none and let the caller generate a poster.
    const generic = extractImage(hasVideo ? withoutAuthorSubtrees(raw) : raw);
    image = isVideoFileUrl(generic) ? '' : generic;
  }
  if (!image) {
    image = extractVideoCover(raw);
  }
  // Last resort only: X/Twitter keeps its playable video inside the same
  // extended_entities.media[] object image extraction already reads, under
  // video_info.variants[]. extractTwitterVideo() accepts nothing but a
  // video.twimg.com URL, so a non-Twitter payload reaching this shared function
  // can never pick one up, and a payload that already resolved a videoUrl above
  // never reaches it.
  const videoUrl = cleanMediaUrl(raw.videoUrl) || mediaItems.find((m) => m.videoUrl)?.videoUrl
    || extractTwitterVideo(raw) || '';

  let mediaType = MEDIA_TYPE_BY_RAW_TYPE[String(raw.type || '').toLowerCase()] || '';
  if (!mediaType) {
    if (mediaItems.length > 1) mediaType = 'carousel';
    // `hasVideo` joins `videoUrl` here because a TikTok item proves it is a
    // video through videoMeta (duration 8s, format mp4) while carrying no
    // playable URL at all — the actor runs with shouldDownloadVideos:false and
    // returns mediaUrls: []. Judged on videoUrl alone, every TikTok video was
    // stored as mediaType "image".
    else if (videoUrl || hasVideo) mediaType = 'video';
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
  const title = raw.title || raw.text || raw.full_text || raw.message || raw.message_rich || raw.caption || raw.description || raw.postText || '';
  
  let author = '';
  // clockworks/tiktok-scraper nests the creator under authorMeta and leaves
  // `author` unset, so every TikTok row was persisted with an empty author.
  // `name` is the @handle, which is the stable identity; nickName is the
  // display name and is free text.
  if (typeof raw.authorMeta === 'object' && raw.authorMeta) {
    author = raw.authorMeta.name || raw.authorMeta.nickName || raw.authorMeta.uniqueId || '';
  } else if (typeof raw.author === 'object' && raw.author) {
    author = raw.author.name || raw.author.username || raw.author.userName || raw.author.uniqueId || raw.author.screen_name || raw.author.nickName || '';
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
  let image = media.image;
  const likes = parseNum(raw.likes || raw.likeCount || raw.likesCount || raw.reactionsCount || raw.favorite_count || raw.favoriteCount || raw.favorites || raw.upvotes || raw.upVotes || raw.ups || raw.score || raw.reactions_count || raw.reactionCounts || raw.totalReactionCount || (typeof raw.reactions === 'number' ? raw.reactions : (raw.reactions?.like || 0)) || raw.diggCount || 0);
  const comments = parseNum(raw.comments || raw.commentCount || raw.commentsCount || raw.replyCount || raw.reply_count || raw.replies || raw.conversation_count || raw.num_comments || raw.numComments || raw.comments_count || raw.numberOfComments || 0);

  const isVideo = media.mediaType === 'video' || !!media.videoUrl || String(raw.type || '').toLowerCase() === 'video' || !!raw.videoMeta || String(raw.kind || '').toLowerCase() === 'video';

  if (isVideo) {
    if (!image) {
      image = extractVideoCover(raw);
    }
    if (!image) {
      image = generateVideoCoverCapture({
        platform: context.platform,
        title: String(title).substring(0, 100),
        author: String(author).substring(0, 50)
      });
    }
    if (media.mediaItems.length === 1 && !media.mediaItems[0].imageUrl && image) {
      media.mediaItems[0].imageUrl = image;
    }
  } else if (!image) {
    // If text-only post without image, generate a visual post capture card
    image = generateTextPostCapture({
      platform: context.platform,
      title: String(title).substring(0, 100),
      body: raw.body || raw.content || raw.full_text || raw.text || raw.message_rich || raw.message || raw.caption || raw.selfText || raw.postText || '',
      author: String(author).substring(0, 50),
      likes,
      comments,
      subreddit: raw.subreddit || (context.platform === 'reddit' ? (raw.subreddit_name_prefixed || '') : '')
    });
  }

  return {
    uid: `${context.platform}:${raw.id || raw.id_str || raw.post_id || raw.postId || url || title}`,
    type: 'social_post',
    platform: context.platform,
    author: String(author).substring(0, 100),
    title: String(title).substring(0, 200),
    body: raw.body || raw.content || raw.full_text || raw.text || raw.message_rich || raw.message || raw.caption || raw.selfText || raw.postText || '',
    url: url,
    image,
    captureImage: image,
    videoUrl: media.videoUrl,
    mediaType: media.mediaType || (isVideo ? 'video' : (image ? 'image' : '')),
    mediaCount: media.mediaCount || (image ? 1 : 0),
    mediaItems: media.mediaItems,
    likes,
    comments,
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
