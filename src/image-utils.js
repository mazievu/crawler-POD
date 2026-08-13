/**
 * Resolve a usable media image from the heterogeneous payloads returned by
 * Apify actors and the local scrapers.  Each platform uses different field
 * names, and many place the image inside an attachment/media object.
 */

const IMAGE_VALUE_KEYS = new Set([
  'image', 'imageurl', 'image_url', 'imageurls', 'image_urls', 'images',
  'thumbnail', 'thumbnailurl', 'thumbnail_url', 'thumbnails', 'picture',
  'photo', 'photos', 'cover', 'coverimage', 'cover_image', 'displayimage',
  'display_image', 'displayurl', 'display_url', 'mainimage', 'main_image',
  'primaryimage', 'primary_image', 'productimage', 'product_image',
  'productimages', 'product_images', 'adimage', 'ad_image', 'advideocover',
  'ad_video_cover', 'videothumbnail', 'video_thumbnail', 'media',
  'attachments', 'attachment', 'gallery', 'preview', 'original', 'originals',
  'large', 'full'
]);

const MEDIA_URL_KEYS = new Set(['url', 'src', 'source', 'contenturl', 'content_url']);

const INVALID_IMAGE_VALUES = new Set([
  'self', 'default', 'nsfw', 'spoiler', 'image', 'video', 'none', 'null',
  'undefined', 'about:blank'
]);

function cleanImageUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim().replace(/&amp;/g, '&');
  if (!url || INVALID_IMAGE_VALUES.has(url.toLowerCase())) return '';

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
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

  // Prefer explicitly named media fields before walking the remainder.
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    const isImageValue = IMAGE_VALUE_KEYS.has(normalizedKey);
    const isMediaUrl = mediaContext && MEDIA_URL_KEYS.has(normalizedKey);
    if (!isImageValue && !isMediaUrl) continue;
    const image = extractImage(child, seen, depth + 1, isImageValue || isMediaUrl);
    if (image) return image;
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
  return /^(url|src|source|contenturl|content_url)$/i.test(String(key || ''));
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

module.exports = { cleanImageUrl, extractImage, hasImage, sanitizeForStorage };
