/**
 * Resolve a usable media image from the heterogeneous payloads returned by
 * Apify actors and the local scrapers.  Each platform uses different field
 * names, and many place the image inside an attachment/media object.
 */

const IMAGE_VALUE_KEYS = new Set([
  'image', 'imageurl', 'image_url', 'imageurls', 'image_urls', 'images',
  'thumbnail', 'thumbnailurl', 'thumbnail_url', 'thumbnails', 'picture',
  'photo', 'photos', 'cover', 'coverimage', 'cover_image', 'coverurl', 'cover_url',
  'displayimage', 'display_image', 'displayurl', 'display_url', 'mainimage', 'main_image',
  'primaryimage', 'primary_image', 'productimage', 'product_image',
  'productimages', 'product_images', 'adimage', 'ad_image', 'advideocover',
  'ad_video_cover', 'videothumbnail', 'video_thumbnail', 'videometa', 'video_meta',
  'media', 'mediaurl', 'media_url', 'attachments', 'attachment', 'gallery', 'preview',
  'original', 'originals', 'large', 'full', 'snapshot', 'originalimageurl', 'resizedimageurl',
  'pageprofilepictureurl', 'profile_image', 'profile_image_url', 'profilepicture',
  'uri', 'image_uri', 'profile_picture_url', 'profilepictureurl',
  'avatar', 'avatar_url', 'authormeta', 'author_meta', 'album_preview', 'image_file_uri', 'imagefileuri',
  // Facebook's GraphQL post payloads nest the photo under `photo_image: {uri}`.
  // sanitizeForStorage() already treats this key as image data (isImageField()
  // matches /photo/), but extractImage() walks this explicit Set instead, so the
  // subtree was skipped and a post whose only image sat there resolved to "".
  // Adding the key only lets the walk descend further; it can never change a
  // payload that already resolves.
  'photo_image', 'photoimage',
  'gallery_images', 'galleryimages', 'media_assets', 'mediaassets'
]);

const MEDIA_URL_KEYS = new Set([
  'url', 'src', 'source', 'contenturl', 'content_url', 'originalimageurl',
  'resizedimageurl', 'pageprofilepictureurl', 'uri', 'image_uri', 'profile_picture_url',
  'profilepictureurl', 'avatar', 'avatar_url', 'image_file_uri', 'imagefileuri',
  'mediaurl', 'media_url', 'coverurl', 'cover_url', 'displayurl', 'display_url',
  'profilepicture', 'originalavatarurl', 'original_url', 'originalurl'
]);

const INVALID_IMAGE_VALUES = new Set([
  'self', 'default', 'nsfw', 'spoiler', 'image', 'video', 'none', 'null',
  'undefined', 'about:blank'
]);

function cleanImageUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim().replace(/&amp;/g, '&');
  if (!url || url.length < 10 || INVALID_IMAGE_VALUES.has(url.toLowerCase())) return '';

  // SVG Data URI for generated post capture cards
  if (/^data:image\/svg\+xml/i.test(url)) {
    return url;
  }

  // Exclude webpage URLs that are HTML pages, not direct image assets
  if (/facebook\.com\/(groups|posts|people|pages|watch|reel|events|ads\/library|[a-zA-Z0-9._-]+$)/i.test(url) && !/fbcdn\.net/i.test(url)) {
    return '';
  }

  // Exclude subreddit icons and community avatars
  if (/communityIcon|community_icon/i.test(url)) {
    return '';
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function extractTwitterImage(raw) {
  if (!raw) return '';
  
  // 1. If raw is an HTML string or has html property with article[aria-labelledby]
  const htmlContent = typeof raw === 'string' ? raw : (raw.html || raw.articleHtml || raw.raw_html || raw.bodyHtml || '');
  if (htmlContent && typeof htmlContent === 'string') {
    const articleMatch = htmlContent.match(/<article[^>]*aria-labelledby[^>]*>([\s\S]*?)<\/article>/i);
    const scope = articleMatch ? articleMatch[1] : htmlContent;
    
    // Look for media images inside the article (pbs.twimg.com/media/ or tweetPhoto)
    const imgMatches = [...scope.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
    for (const m of imgMatches) {
      const src = m[1];
      // Skip profile avatars, emojis, and SVG icons
      if (/pbs\.twimg\.com\/media\//i.test(src) || (/(?:twimg\.com|x\.com)\/media/i.test(src) && !/profile_images|emoji|icon/i.test(src))) {
        const cleaned = cleanImageUrl(src);
        if (cleaned) return cleaned;
      }
    }
  }

  // 2. Direct Twitter payload media objects (from Apify actors xquik/x-tweet-scraper or tweet-scraper)
  if (Array.isArray(raw.mediaUrls) && raw.mediaUrls.length > 0) {
    for (const url of raw.mediaUrls) {
      if (typeof url === 'string' && /pbs\.twimg\.com\/media\//i.test(url)) {
        const cleaned = cleanImageUrl(url);
        if (cleaned) return cleaned;
      }
    }
  }

  if (Array.isArray(raw.photos) && raw.photos.length > 0) {
    for (const p of raw.photos) {
      const url = p?.url || p?.media_url_https || p?.media_url || (typeof p === 'string' ? p : '');
      if (url && !/profile_images/i.test(url)) {
        const cleaned = cleanImageUrl(url);
        if (cleaned) return cleaned;
      }
    }
  }

  if (Array.isArray(raw.entities?.media) && raw.entities.media.length > 0) {
    for (const m of raw.entities.media) {
      const url = m?.media_url_https || m?.media_url;
      if (url && !/profile_images/i.test(url)) {
        const cleaned = cleanImageUrl(url);
        if (cleaned) return cleaned;
      }
    }
  }

  if (Array.isArray(raw.extended_entities?.media) && raw.extended_entities.media.length > 0) {
    for (const m of raw.extended_entities.media) {
      const url = m?.media_url_https || m?.media_url;
      if (url && !/profile_images/i.test(url)) {
        const cleaned = cleanImageUrl(url);
        if (cleaned) return cleaned;
      }
    }
  }

  return '';
}

/**
 * The playable video of an X/Twitter post.
 *
 * extractTwitterImage() above already commits to the `extended_entities.media[]`
 * / `entities.media[]` shape for this platform, and the video lives in the SAME
 * media object as the poster image it already reads — under
 * `video_info.variants[]`. Nothing read it, so an X video post was stored with
 * its poster image and video_url='' and rendered as a still.
 *
 * Only `video.twimg.com` mp4/m3u8 URLs are accepted, so this can never return a
 * URL belonging to another platform even though the social-post normalizer is
 * shared. The highest-bitrate mp4 variant wins; variants without a bitrate
 * (the HLS playlist) are used only when no mp4 exists.
 */
function extractTwitterVideo(raw) {
  if (!raw || typeof raw !== 'object') return '';

  const mediaLists = [
    raw.extended_entities?.media,
    raw.entities?.media,
    raw.videos,
    raw.media,
  ];

  let best = '';
  let bestBitrate = -1;
  for (const list of mediaLists) {
    if (!Array.isArray(list)) continue;
    for (const media of list) {
      const variants = media?.video_info?.variants;
      if (!Array.isArray(variants)) continue;
      for (const variant of variants) {
        const url = cleanImageUrl(variant?.url);
        if (!url || !/^https:\/\/video\.twimg\.com\//i.test(url)) continue;
        const bitrate = Number.isFinite(variant?.bitrate) ? variant.bitrate : 0;
        if (bitrate > bestBitrate) {
          bestBitrate = bitrate;
          best = url;
        }
      }
    }
  }
  if (best) return best;

  // Some actors flatten the same field to a list of plain URL strings.
  for (const key of ['videoUrls', 'video_urls', 'mediaUrls']) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const url = cleanImageUrl(entry);
      if (url && /^https:\/\/video\.twimg\.com\//i.test(url)) return url;
    }
  }

  return '';
}

function extractImage(value, seen = new Set(), depth = 0, mediaContext = false) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return mediaContext ? cleanImageUrl(value) : '';
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const image = extractImage(item, seen, depth + 1, mediaContext);
      if (image) return image;
    }
    return '';
  }

  // 0. Twitter / X article[aria-labelledby] & media payload check
  const twitterImg = extractTwitterImage(value);
  if (twitterImg) return twitterImg;

  // 1. Direct post image object / uri (e.g. Facebook post image.uri)
  if (value.image && typeof value.image === 'object' && value.image.uri) {
    const img = cleanImageUrl(value.image.uri);
    if (img) return img;
  }

  // 2. Direct album preview (e.g. Facebook album_preview[0].image_file_uri)
  if (Array.isArray(value.album_preview) && value.album_preview.length > 0) {
    for (const alb of value.album_preview) {
      const img = cleanImageUrl(alb.image_file_uri || alb.url || alb.uri);
      if (img) return img;
    }
  }

  // 3. Walk named media keys
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    const isImageValue = IMAGE_VALUE_KEYS.has(normalizedKey);
    const isMediaUrl = mediaContext && MEDIA_URL_KEYS.has(normalizedKey);
    if (!isImageValue && !isMediaUrl) continue;
    const image = extractImage(child, seen, depth + 1, isImageValue || isMediaUrl);
    if (image) return image;
  }

  // 4. Fallback to author profile picture if it is a post without post media
  if (value.author && typeof value.author === 'object' && value.author.profile_picture_url) {
    const avatar = cleanImageUrl(value.author.profile_picture_url);
    if (avatar) return avatar;
  }

  return '';
}

function hasImage(item) {
  return Boolean(extractImage(item));
}

function isImageField(key) {
  return /(image|thumbnail|picture|photo|cover|gallery|media)/i.test(String(key || ''));
}

function isImageUrlField(key) {
  return /^(url|src|source|contenturl|content_url|uri|image_file_uri|originalimageurl|resizedimageurl|profile_picture_url)$/i.test(String(key || ''));
}

function sanitizeForStorage(value, imageContext = false) {
  if (typeof value === 'string') return imageContext ? cleanImageUrl(value) : value;
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeForStorage(entry, imageContext));
  const sanitized = {};
  for (const [key, child] of Object.entries(value)) {
    // A `media` object often includes caption/type fields. Mark only its
    // image URL members (or an explicit image-named field) as image data.
    const childIsImage = isImageField(key) || (imageContext && isImageUrlField(key));
    sanitized[key] = sanitizeForStorage(child, childIsImage);
  }
  return sanitized;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text, maxCharsPerLine = 48, maxLines = 4) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    if (!word) continue;
    if ((currentLine ? currentLine + ' ' + word : word).length <= maxCharsPerLine) {
      currentLine = currentLine ? currentLine + ' ' + word : word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (currentLine && lines.length < maxLines) lines.push(currentLine);
  if (lines.length === maxLines && words.length > 0 && !lines[maxLines - 1].endsWith('...')) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, maxCharsPerLine - 3) + '...';
  }
  return lines;
}

/**
 * True when a URL points at a video FILE rather than a picture.
 *
 * An image field must never hold one. Facebook post payloads are why this
 * exists: apify facebook-posts items describe a reel as
 * `attachments: [{ type: "video", url: "https://video-iad6-1.xx.fbcdn.net/....mp4" }]`
 * and carry no picture anywhere (verified exhaustively on dataset
 * est9wYPdtqkvHl4sf, 2026-09-18 — the only other URLs in the whole item are the
 * permalink, the author's avatar and the author's profile link). The generic
 * walk reads `attachments` then `url`, so the mp4 itself was being stored as
 * the post's `image` and rendered into an <img>.
 *
 * This is a predicate only. cleanImageUrl() deliberately still accepts these
 * URLs, because extractTwitterVideo() validates video variants through it.
 */
function isVideoFileUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  const withoutQuery = value.split('?')[0].split('#')[0];
  return /\.(mp4|m3u8|mpd|mov|webm|avi|mkv)$/i.test(withoutQuery);
}

/**
 * The cover frame a payload explicitly names for ITS OWN video.
 *
 * Separate from extractVideoCover() below, which also accepts generic
 * `thumbnail` / `displayUrl` / first-attachment fields. Only unambiguous
 * "this is the poster of this video" keys live here, so this list can be
 * consulted BEFORE the generic extractImage() walk without overriding a
 * payload that already states its post image outright.
 *
 * tiktok_videos (clockworks/tiktok-scraper): `videoMeta.coverUrl`, confirmed on
 * run 949 / dataset 2VvOrR0hbk1BfqcFJ (2026-09-18). `originalCoverUrl` sits
 * beside it in the same object and is the un-resized original.
 */
function extractExplicitVideoCover(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const vm = raw.videoMeta || raw.video_meta || {};
  const vid = (raw.video && typeof raw.video === 'object') ? raw.video : {};
  const candidates = [
    vm.coverUrl, vm.cover_url, vm.originalCoverUrl, vm.original_cover_url,
    vm.dynamicCover, vm.dynamic_cover, vm.originCover, vm.origin_cover, vm.cover,
    vid.coverUrl, vid.cover, vid.originCover, vid.dynamicCover, vid.poster,
    raw.videoPreviewImageUrl, raw.video_preview_image_url,
    raw.videoThumbnail, raw.video_thumbnail,
    raw.coverUrl, raw.cover_url, raw.originCover, raw.dynamicCover,
    raw.poster, raw.posterUrl, raw.poster_url,
  ];
  for (const c of candidates) {
    const cleaned = cleanImageUrl(c);
    if (cleaned && !isVideoFileUrl(cleaned)) return cleaned;
  }
  return '';
}

/**
 * Extract cover/poster/thumbnail URL for a video item.
 */
function extractVideoCover(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const candidates = [
    raw.videoMeta?.coverUrl,
    raw.videoMeta?.originalCoverUrl,
    raw.videoMeta?.dynamicCover,
    raw.videoMeta?.originCover,
    raw.videoPreviewImageUrl,
    raw.video_preview_image_url,
    raw.coverUrl,
    raw.cover_url,
    raw.cover,
    raw.originCover,
    raw.dynamicCover,
    raw.poster,
    raw.posterUrl,
    raw.poster_url,
    raw.thumbnail,
    raw.thumbnailUrl,
    raw.thumbnail_url,
    raw.video?.cover,
    raw.video?.originCover,
    raw.video?.dynamicCover,
    raw.preview?.images?.[0]?.source?.url,
    raw.preview?.images?.[0]?.resolutions?.slice(-1)[0]?.url,
    Array.isArray(raw.attachments) ? (raw.attachments[0]?.thumbnail || raw.attachments[0]?.picture || (raw.attachments[0]?.type !== 'video' ? raw.attachments[0]?.url : '')) : '',
    raw.displayUrl,
  ];
  for (const c of candidates) {
    const cleaned = cleanImageUrl(c);
    // `attachments[0].url` above is only skipped when the attachment says
    // type==="video"; an actor that labels it differently would otherwise hand
    // back the mp4 as a poster.
    if (cleaned && !isVideoFileUrl(cleaned)) return cleaned;
  }
  return '';
}

/**
 * Generate a visual capture card for a text-only post without image.
 * Returns an SVG Data URI that renders directly in <img> tags.
 */
function generateTextPostCapture({ platform = 'reddit', title = '', body = '', author = '', likes = 0, comments = 0, subreddit = '' } = {}) {
  const brandColors = {
    reddit: { bg1: '#1a1a1b', bg2: '#2b140e', accent: '#ff4500', name: 'Reddit', badge: subreddit ? `r/${subreddit}` : 'r/reddit' },
    twitter: { bg1: '#000000', bg2: '#15202b', accent: '#1d9bf0', name: 'X (Twitter)', badge: author ? `@${author}` : 'Post' },
    facebook_posts: { bg1: '#0c1b33', bg2: '#13284d', accent: '#1877f2', name: 'Facebook', badge: 'Facebook Post' },
    facebook_ads: { bg1: '#0c1b33', bg2: '#13284d', accent: '#1877f2', name: 'Facebook Ad', badge: 'Sponsored' },
    tiktok_videos: { bg1: '#010101', bg2: '#161823', accent: '#fe2c55', name: 'TikTok', badge: 'Post' },
    pinterest: { bg1: '#1f1315', bg2: '#301317', accent: '#e60023', name: 'Pinterest', badge: 'Pin' },
  };

  const brand = brandColors[platform] || { bg1: '#18181b', bg2: '#27272a', accent: '#6366f1', name: platform || 'Social', badge: platform || 'Post' };
  const authorDisplay = author || brand.badge;
  const initial = (authorDisplay.replace(/^[@ru]\//i, '')[0] || 'P').toUpperCase();

  const displayTitle = title || body || 'Text Post';
  const displayBody = (body && body !== title) ? body : '';
  const bodyLines = wrapText(displayBody || displayTitle, 46, 4);

  const linesSvg = bodyLines.map((l, i) =>
    `<text x="40" y="${170 + i * 26}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif" font-size="15" fill="#e5e7eb" font-weight="400">${escapeXml(l)}</text>`
  ).join('\n    ');

  const likesText = likes > 0 ? `❤️ ${likes.toLocaleString()}` : '';
  const commentsText = comments > 0 ? `💬 ${comments.toLocaleString()}` : '';
  const metricsText = [likesText, commentsText].filter(Boolean).join('   ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 360" width="600" height="360">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${brand.bg1}"/>
      <stop offset="100%" stop-color="${brand.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="600" height="360" rx="16" fill="url(#bg)"/>
  <rect width="600" height="360" rx="16" fill="none" stroke="#ffffff" stroke-opacity="0.1" stroke-width="1.5"/>
  <circle cx="50" cy="50" r="100" fill="${brand.accent}" opacity="0.12"/>
  <text x="520" y="140" font-family="Georgia, serif" font-size="120" fill="#ffffff" opacity="0.04" text-anchor="middle">“</text>
  <circle cx="60" cy="58" r="22" fill="${brand.accent}" opacity="0.9"/>
  <text x="60" y="65" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeXml(initial)}</text>
  <text x="96" y="54" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="16" font-weight="700" fill="#ffffff">${escapeXml(authorDisplay.slice(0, 28))}</text>
  <text x="96" y="72" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="12" font-weight="500" fill="${brand.accent}">${escapeXml(brand.badge.slice(0, 32))}</text>
  <rect x="460" y="42" width="105" height="26" rx="13" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.15"/>
  <text x="512" y="59" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="11" font-weight="600" fill="#e5e7eb" text-anchor="middle">${escapeXml(brand.name.toUpperCase())}</text>
  <line x1="40" y1="100" x2="560" y2="100" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1"/>
  <text x="40" y="132" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="18" font-weight="700" fill="#f9fafb">${escapeXml(displayTitle.slice(0, 52) + (displayTitle.length > 52 ? '...' : ''))}</text>
  ${linesSvg}
  <line x1="40" y1="305" x2="560" y2="305" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1"/>
  <text x="40" y="333" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="13" font-weight="600" fill="#9ca3af">${escapeXml(metricsText || '📄 Text Post Preview')}</text>
  <text x="560" y="333" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="11" font-weight="500" fill="#6b7280" text-anchor="end">📸 Post Capture</text>
</svg>`;

  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/**
 * Generate a visual poster for a video that has no remote thumbnail URL.
 */
function generateVideoCoverCapture({ platform = 'video', title = '', author = '' } = {}) {
  const brandColors = {
    tiktok_videos: { bg1: '#010101', bg2: '#161823', accent: '#fe2c55', name: 'TikTok' },
    reddit: { bg1: '#1a1a1b', bg2: '#2b140e', accent: '#ff4500', name: 'Reddit Video' },
    twitter: { bg1: '#000000', bg2: '#15202b', accent: '#1d9bf0', name: 'X Video' },
    facebook_posts: { bg1: '#0c1b33', bg2: '#13284d', accent: '#1877f2', name: 'Facebook Video' },
  };
  const brand = brandColors[platform] || { bg1: '#0f172a', bg2: '#1e293b', accent: '#3b82f6', name: 'Video' };
  const displayTitle = title || 'Video Content';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 360" width="600" height="360">
  <defs>
    <linearGradient id="vbg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${brand.bg1}"/>
      <stop offset="100%" stop-color="${brand.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="600" height="360" rx="16" fill="url(#vbg)"/>
  <rect width="600" height="360" rx="16" fill="none" stroke="#ffffff" stroke-opacity="0.15" stroke-width="1.5"/>
  <circle cx="300" cy="160" r="46" fill="${brand.accent}" opacity="0.9"/>
  <polygon points="292,142 316,160 292,178" fill="#ffffff"/>
  <rect x="250" y="222" width="100" height="24" rx="12" fill="#000000" fill-opacity="0.6"/>
  <text x="300" y="238" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">▶ VIDEO</text>
  <text x="300" y="290" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="16" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeXml(displayTitle.slice(0, 50))}</text>
  <text x="300" y="315" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="13" font-weight="500" fill="#9ca3af" text-anchor="middle">${escapeXml(author ? `by ${author}` : brand.name)}</text>
</svg>`;

  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

module.exports = {
  cleanImageUrl,
  extractImage,
  extractTwitterImage,
  extractTwitterVideo,
  extractVideoCover,
  extractExplicitVideoCover,
  isVideoFileUrl,
  generateTextPostCapture,
  generateVideoCoverCapture,
  hasImage,
  sanitizeForStorage,
};
