'use strict';

/*
 * Keeps a crawled image viewable after the provider's link dies.
 *
 * WHY
 * pratikdani/tiktok-shop-search-scraper — the TikTok Shop primary — does not
 * return TikTok's own CDN URL. It returns a link to its own proxy on
 * cdn-image.hdnet.workers.dev, and those links EXPIRE: the same URLs answered
 * HTTP 200 on 2026-09-15 and HTTP 403 on 2026-09-18, so 29 of 29 stored TikTok
 * Shop products rendered the "Image Unavailable" placeholder. Storing a URL is
 * not storing an image when the host reserves the right to stop serving it.
 *
 * WHAT THIS DOES
 * For images whose host is known to expire, the bytes are fetched once during
 * the crawl and written under public/media/, and the item's image field is
 * rewritten to that local path. Everything else is left completely alone:
 * Etsy, Pinterest and Amazon serve durable CDN URLs, and re-hosting ~89,000 of
 * those would cost disk for no benefit. The host list is the whole policy —
 * add a host to it only with evidence that its links expire.
 *
 * A download failure is never fatal. The item keeps its original URL and the
 * crawl proceeds; a missing picture is worth far less than a lost run.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Hosts observed to serve time-limited links. Evidence required to add one. */
const EPHEMERAL_IMAGE_HOSTS = new Set([
  // pratikdani's TikTok Shop image proxy — 200 on 2026-09-15, 403 on 2026-09-18.
  'cdn-image.hdnet.workers.dev',
]);

const MEDIA_DIR = path.join(__dirname, '..', 'public', 'media');
/** Served by express.static('public'), so this is what the browser asks for. */
const MEDIA_URL_PREFIX = '/media';
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/** True when this URL's host is known to stop serving the file later. */
function needsLocalCopy(url) {
  if (typeof url !== 'string' || !url) return false;
  // An already-cached image is a local path, not something to re-download.
  if (url.startsWith(MEDIA_URL_PREFIX + '/')) return false;
  try {
    return EPHEMERAL_IMAGE_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Content-addressed by URL: the same picture is fetched once, not once per run. */
function cacheNameFor(url, contentType) {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  const ext = EXT_BY_TYPE[String(contentType || '').split(';')[0].trim().toLowerCase()] || '.jpg';
  return `${hash}${ext}`;
}

/*
 * What the bytes ARE, not what the server says they are.
 *
 * cdn-image.hdnet.workers.dev serves perfectly valid JPEGs under
 * `content-type: binary/octet-stream`. Trusting the header rejected all five
 * TikTok Shop images on run #881 with "not an image" — the picture was there,
 * the label was wrong. Magic bytes settle it; a header cannot.
 */
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  // AVIF/HEIF: an ISO-BMFF box whose brand starts with "avif"/"heic".
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand.startsWith('avif') || brand.startsWith('avis')) return '.avif';
  }
  return null;
}

const { safeFetch, validateOutboundUrl } = require('./security/outbound-guard');

async function downloadOne(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // 1. SSRF Pre-flight validation
    await validateOutboundUrl(url);

    // 2. Fetch using safeFetch enforcing manual redirect re-validation & content-length check
    const res = await safeFetch(url, {
      signal: controller.signal,
      maxSizeBytes: MAX_BYTES,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
        'Accept': 'image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // 3. True streaming byte limit: read chunks incrementally without allocating full memory
    const chunks = [];
    let receivedBytes = 0;

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.length || value.byteLength || 0;
        if (receivedBytes > MAX_BYTES) {
          try { await reader.cancel(); } catch (_) {}
          controller.abort();
          throw new Error(`too large (${receivedBytes} bytes)`);
        }
        chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
      }
    } else if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of res.body) {
        receivedBytes += chunk.length || chunk.byteLength || 0;
        if (receivedBytes > MAX_BYTES) {
          controller.abort();
          throw new Error(`too large (${receivedBytes} bytes)`);
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } else {
      const directBuf = Buffer.from(await res.arrayBuffer());
      if (directBuf.length > MAX_BYTES) throw new Error(`too large (${directBuf.length} bytes)`);
      chunks.push(directBuf);
    }

    const buf = Buffer.concat(chunks);
    if (buf.length === 0) throw new Error('empty body');

    // The bytes decide. A correct content-type is a nice hint and nothing more;
    // this host sends binary/octet-stream for real JPEGs.
    const sniffed = sniffImageExt(buf);
    if (!sniffed) {
      const contentType = res.headers.get('content-type') || 'no content-type';
      throw new Error(`not an image (${contentType}, ${buf.length} bytes)`);
    }

    const name = `${crypto.createHash('sha1').update(url).digest('hex')}${sniffed}`;
    const dest = path.join(MEDIA_DIR, name);
    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
    // Written to a temp file then renamed, so a crash mid-download can never
    // leave a half-image that later looks cached and serves corrupt bytes.
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    return `${MEDIA_URL_PREFIX}/${name}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rewrites `image` on each item whose host expires. Mutates in place and returns
 * a summary the caller can log, so "why does this run have no pictures" is
 * answerable from the run log rather than by guessing.
 */
async function persistEphemeralImages(items, { log = console } = {}) {
  const summary = { considered: 0, cached: 0, reused: 0, failed: 0 };
  if (!Array.isArray(items) || items.length === 0) return summary;

  for (const item of items) {
    const url = item && item.image;
    if (!needsLocalCopy(url)) continue;
    summary.considered += 1;

    try {
      // A previous run may already hold this exact picture. The extension comes
      // from the bytes, so look for the hash under any of them rather than
      // assuming .jpg and re-downloading a PNG every run.
      const hash = crypto.createHash('sha1').update(url).digest('hex');
      const existing = ['.jpg', '.png', '.webp', '.gif', '.avif']
        .map((ext) => path.join(MEDIA_DIR, hash + ext))
        .find((candidate) => fs.existsSync(candidate));
      if (existing) {
        item.image = `${MEDIA_URL_PREFIX}/${path.basename(existing)}`;
        summary.reused += 1;
        continue;
      }
      item.image = await downloadOne(url);
      summary.cached += 1;
    } catch (err) {
      // Keep the original URL: it may still work in the viewer's browser even
      // when it refused this server, and an item with a doubtful picture beats
      // an item dropped from the run.
      summary.failed += 1;
      log.warn(`[media-cache] could not cache ${String(url).slice(0, 80)}: ${err.message}`);
    }
  }

  return summary;
}

module.exports = {
  persistEphemeralImages,
  needsLocalCopy,
  sniffImageExt,
  cacheNameFor,
  EPHEMERAL_IMAGE_HOSTS,
  MEDIA_DIR,
  MEDIA_URL_PREFIX,
};
