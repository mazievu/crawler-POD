function parseNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

const { extractImage } = require('../image-utils');

module.exports = function normalizeProductListing(raw, context) {
  const title = raw.title || raw.productTitle || raw.name || raw.text || '';
  const url = raw.url || raw.permalink || raw.productUrl || raw.link || '';
  
  return {
    uid: `${context.platform}:${url || title}`,
    type: 'product_listing',
    platform: context.platform,
    title: String(title).substring(0, 200),
    url: url,
    image: extractImage(raw),
    price: parseNum(raw.price || raw.product_price || 0),
    currency: raw.currency || 'USD',
    shopName: typeof raw.author === 'object' ? raw.author?.name : (raw.author || raw.shopName || ''),
    rating: parseNum(raw.rating || raw.averageRating || 0),
    reviewCount: parseNum(raw.reviewCount || raw.reviews || 0),
    soldCount: parseNum(raw.soldCount || raw.sales || 0),
    firstSeenAt: raw.firstSeenAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    raw: raw
  };
};
