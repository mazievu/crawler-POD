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
  'avatar', 'avatar_url', 'authormeta', 'author_meta', 'album_preview', 'image_file_uri', 'imagefileuri'
]);

const MEDIA_URL_KEYS = new Set([
  'url', 'src', 'source', 'contenturl', 'content_url', 'originalimageurl',
  'resizedimageurl', 'pageprofilepictureurl', 'uri', 'image_uri', 'profile_picture_url',
  'profilepictureurl', 'avatar', 'avatar_url', 'image_file_uri', 'imagefileuri',
  'mediaurl', 'media_url', 'coverurl', 'cover_url', 'displayurl', 'display_url',
  'profilepicture', 'originalavatarurl'
]);

const INVALID_IMAGE_VALUES = new Set([
  'self', 'default', 'nsfw', 'spoiler', 'image', 'video', 'none', 'null',
  'undefined', 'about:blank'
]);

function cleanImageUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim().replace(/&amp;/g, '&');
  if (!url || url.length < 10 || INVALID_IMAGE_VALUES.has(url.toLowerCase())) return '';

  // Exclude webpage URLs that are HTML pages, not direct image assets
  if (/facebook\.com\/(groups|posts|people|pages|watch|reel|events|ads\/library|[a-zA-Z0-9._-]+$)/i.test(url) && !/fbcdn\.net/i.test(url)) {
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

module.exports = {
  cleanImageUrl,
  extractImage,
  extractTwitterImage,
  hasImage,
  sanitizeForStorage,
};
