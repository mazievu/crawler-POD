const { assertSupportedMarketplace } = require('./validation');

function parseMarketplaceHtml({ platform, url, html }) {
  assertSupportedMarketplace(platform);
  if (typeof html !== 'string' || !html.trim()) throw new Error('HTML capture is required');

  const product = findProductJsonLd(html) || {};
  const offer = Array.isArray(product.offers) ? product.offers[0] : (product.offers || {});
  const pricing = findPricePair(product, html);
  const rating = product.aggregateRating || {};
  const image = Array.isArray(product.image) ? product.image[0] : product.image;

  // UI-BUG-07: Amazon product pages do not reliably emit schema.org Product
  // JSON-LD or product:price/rating meta tags, so every generic fallback
  // above resolves to nothing — and the last-resort `findFirstTag(html,'h1')`
  // title fallback then grabs Amazon's accessibility-only skip-navigation
  // <h1> (e.g. "Amazon.com"), never the real product title (which lives in
  // <span id="productTitle">, not an <h1> at all). Give Amazon its own
  // targeted fallback tier, consulted only to fill gaps the generic
  // extraction above left empty — not a replacement for it.
  const amazonFallback = platform === 'amazon' ? extractAmazonFallback(html) : {};

  return {
    platform,
    title: cleanText(product.name || findMeta(html, 'og:title') || amazonFallback.title || findFirstTag(html, 'h1')),
    url,
    listingId: product.sku || product.mpn || listingIdFromUrl(platform, url),
    image: imageUrl(image) || findMeta(html, 'og:image') || amazonFallback.image || '',
    price: pricing.price || amazonFallback.price || 0,
    currency: pricing.currency || amazonFallback.currency || '',
    rating: decimal(rating.ratingValue || findItemprop(html, 'ratingValue')) || amazonFallback.rating || 0,
    reviewCount: number(rating.reviewCount || rating.ratingCount || findItemprop(html, 'reviewCount')) || amazonFallback.reviewCount || 0,
    availability: normalizeAvailability(offer.availability || findMeta(html, 'product:availability')),
    brand: cleanText(typeof product.brand === 'object' ? product.brand?.name : product.brand),
  };
}

// UI-BUG-07 closure: Amazon-specific extraction tier, using the real DOM
// anchors Amazon product pages actually use (#productTitle, .a-offscreen
// price, the "X out of 5 stars" rating text, #acrCustomerReviewText,
// #landingImage) instead of the generic schema.org/meta-tag assumptions the
// rest of this file relies on for other marketplaces.
function extractAmazonFallback(html) {
  const titleMatch = /<span[^>]+id\s*=\s*["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
  const priceMatch = /<span[^>]+class\s*=\s*["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
  const ratingMatch = /([\d.]+)\s+out of\s+5\s+stars/i.exec(html);
  const reviewMatch = /id\s*=\s*["'](?:acrCustomerReviewText|acrCustomerReviewCount)["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);

  const priceText = priceMatch ? cleanText(priceMatch[1]) : '';
  const currencyMatch = priceText.match(/^[^\d]+/);

  return {
    title: titleMatch ? cleanText(titleMatch[1]) : '',
    price: priceText ? decimal(priceText) : 0,
    currency: currencyMatch ? cleanText(currencyMatch[0]) : '',
    rating: ratingMatch ? decimal(ratingMatch[1]) : 0,
    reviewCount: reviewMatch ? number(reviewMatch[1]) : 0,
    image: extractAmazonLandingImage(html),
  };
}

// BUG-AMZ-01: find the #landingImage element itself first (attribute-order
// independent), then read its image source with a fixed priority —
// data-old-hires (highest resolution, when present) > data-a-dynamic-image
// (a JSON map of {url: [width,height]}, pick the largest) > src (last
// resort, often a low-res placeholder). Real Amazon product pages commonly
// carry ONLY data-a-dynamic-image, which the previous version of this
// function never checked at all.
function extractAmazonLandingImage(html) {
  const tagMatch = /<img\b[^>]*\bid\s*=\s*["']landingImage["'][^>]*>/i.exec(html);
  if (!tagMatch) return '';
  const tag = tagMatch[0];

  const attr = (name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
    return m ? decodeEntities(m[1]) : '';
  };

  const oldHires = attr('data-old-hires');
  if (oldHires) return oldHires;

  const dynamicImageRaw = attr('data-a-dynamic-image');
  if (dynamicImageRaw) {
    const largest = largestImageFromDynamicImageJson(dynamicImageRaw);
    if (largest) return largest;
  }

  return attr('src');
}

// data-a-dynamic-image is a JSON object: {"<url>": [width, height], ...}.
// Malformed/unparseable JSON must fall through (return '') rather than
// throw — a single bad product page must never crash the whole parser.
function largestImageFromDynamicImageJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';

  let bestUrl = '';
  let bestArea = -1;
  for (const [url, dims] of Object.entries(parsed)) {
    if (typeof url !== 'string' || !url) continue;
    const width = Array.isArray(dims) ? Number(dims[0]) : 0;
    const height = Array.isArray(dims) ? Number(dims[1]) : 0;
    const area = (Number.isFinite(width) ? width : 0) * (Number.isFinite(height) ? height : 0);
    if (area > bestArea) {
      bestArea = area;
      bestUrl = url;
    }
  }
  return bestUrl;
}

function findPricePair(product, html) {
  const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
  const structured = offers.find((offer) => offer && offer.price != null && cleanText(offer.priceCurrency));
  if (structured) {
    return { price: decimal(structured.price), currency: cleanText(structured.priceCurrency).toUpperCase() };
  }
  const metaPrice = findMeta(html, 'product:price:amount');
  const metaCurrency = cleanText(findMeta(html, 'product:price:currency')).toUpperCase();
  if (metaPrice && metaCurrency) return { price: decimal(metaPrice), currency: metaCurrency };
  return { price: 0, currency: '' };
}

function analyzeMarketplaceHtml({ platform, url, html }) {
  const metrics = parseMarketplaceHtml({ platform, url, html });
  const pageTitle = cleanText(findFirstTag(html, 'title'));
  const canonicalUrl = findCanonicalUrl(html) || url;
  const challengeText = /captcha|verify you are human|unusual traffic|robot check|automated access|pardon our interruption/i.test(html);
  // A title by itself is not enough: challenge pages often have a generic title.
  const hasProductEvidence = Boolean(metrics.title || metrics.price || metrics.image);
  const blocked = challengeText && !hasProductEvidence;

  return {
    metrics,
    capture: {
      status: blocked ? 'blocked' : 'ok',
      reason: blocked ? 'possible_bot_challenge' : null,
      pageTitle,
      canonicalUrl,
      parserVersion: 'marketplace-html-v1',
    },
  };
}

function findProductJsonLd(html) {
  const scripts = html.matchAll(/<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const product = findProduct(JSON.parse(match[2].trim()));
      if (product) return product;
    } catch {
      // Ignore malformed third-party structured data and continue to the next block.
    }
  }
  return null;
}

function findProduct(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const product = findProduct(item);
      if (product) return product;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.some((type) => String(type).toLowerCase() === 'product')) return value;
  return findProduct(value['@graph']);
}

function findMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\b(?=[^>]*(?:property|name)\\s*=\\s*["']${escaped}["'])[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b(?=[^>]*content\\s*=\\s*["']([^"']*)["'])[^>]*(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(html);
    if (found) return decodeEntities(found[1]);
  }
  return '';
}

function findItemprop(html, itemprop) {
  const escaped = itemprop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<[^>]*itemprop\\s*=\\s*["']${escaped}["'][^>]*(?:content|value)\\s*=\\s*["']([^"']*)["'][^>]*>`, 'i').exec(html);
  return match ? decodeEntities(match[1]) : '';
}

function findFirstTag(html, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
  return match ? cleanText(match[1].replace(/<[^>]+>/g, ' ')) : '';
}

function findCanonicalUrl(html) {
  const match = /<link\b(?=[^>]*rel\s*=\s*["']canonical["'])[^>]*href\s*=\s*["']([^"']*)["'][^>]*>/i.exec(html);
  return match ? decodeEntities(match[1]) : '';
}

function listingIdFromUrl(platform, url) {
  const patterns = {
    amazon: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i,
    ebay: /\/itm\/(?:[^/?#]+\/)?(\d{9,15})/i,
    etsy: /\/listing\/(\d+)/i,
  };
  return patterns[platform].exec(url)?.[1] || '';
}

function imageUrl(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.url || value.contentUrl || '';
  return '';
}

function cleanText(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(value) {
  return String(value || '').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function decimal(value) {
  const match = String(value || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function number(value) {
  const match = String(value || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return 0;
  return Math.round(Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1));
}

function normalizeAvailability(value) {
  const normalized = String(value || '').toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('instock') || normalized.includes('in_stock')) return 'in_stock';
  if (normalized.includes('outofstock') || normalized.includes('out_of_stock')) return 'out_of_stock';
  if (normalized.includes('preorder') || normalized.includes('pre_order')) return 'pre_order';
  return cleanText(normalized).replace(/\s+/g, '_');
}

module.exports = { parseMarketplaceHtml, analyzeMarketplaceHtml };
