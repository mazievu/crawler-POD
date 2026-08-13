const { assertSupportedMarketplace } = require('./validation');

function parseMarketplaceHtml({ platform, url, html }) {
  assertSupportedMarketplace(platform);
  if (typeof html !== 'string' || !html.trim()) throw new Error('HTML capture is required');

  const product = findProductJsonLd(html) || {};
  const offer = Array.isArray(product.offers) ? product.offers[0] : (product.offers || {});
  const pricing = findPricePair(product, html);
  const rating = product.aggregateRating || {};
  const image = Array.isArray(product.image) ? product.image[0] : product.image;

  return {
    platform,
    title: cleanText(product.name || findMeta(html, 'og:title') || findFirstTag(html, 'h1')),
    url,
    listingId: product.sku || product.mpn || listingIdFromUrl(platform, url),
    image: imageUrl(image) || findMeta(html, 'og:image'),
    price: pricing.price,
    currency: pricing.currency,
    rating: decimal(rating.ratingValue || findItemprop(html, 'ratingValue')),
    reviewCount: number(rating.reviewCount || rating.ratingCount || findItemprop(html, 'reviewCount')),
    availability: normalizeAvailability(offer.availability || findMeta(html, 'product:availability')),
    brand: cleanText(typeof product.brand === 'object' ? product.brand?.name : product.brand),
  };
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
