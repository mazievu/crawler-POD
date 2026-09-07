function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const match = String(v ?? '').replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
  if (!match) return 0;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return (parseFloat(match[1]) * multiplier) || 0;
}

const { extractImage } = require('../image-utils');

module.exports = function normalizeProductListing(raw, context = { platform: 'product_listing' }) {
  const title = raw.title || raw.productTitle || raw.product_name || raw.name || raw.text || raw.desc || '';
  const url = raw.url || raw.productUrl || raw.product_url || raw.link || raw.webVideoUrl || raw.permalink || (raw.asin ? `https://www.amazon.com/dp/${raw.asin}` : '') || '';
  
  let shopName = '';
  if (typeof raw.author === 'object' && raw.author) {
    shopName = raw.author.name || raw.author.nickName || raw.author.username || '';
  } else {
    shopName = raw.shopName || raw.shop_name || raw.sellerName || raw.seller_name || raw.storeName || raw.store_name || raw.vendor || raw.merchant || raw.store || raw.brand || raw.seller || raw.author || '';
  }

  const rating = parseNum(raw.rating || raw.averageRating || raw.average_rating || raw.stars || raw.productRating || raw.score || raw.review_score || 0);
  const reviews = parseNum(raw.reviewCount || raw.review_count || raw.reviews || raw.reviewsCount || raw.ratingCount || raw.ratingsCount || raw.total_reviews || 0);
  const sold = parseNum(raw.soldCount || raw.sold_count || raw.sold || raw.sales || raw.orders || raw.orderCount || raw.total_sold || raw.item_sold || raw.volume || 0);
  const price = parseNum(raw.price || raw.product_price || raw.priceNumeric || raw.currentPrice || raw.salePrice || raw.minPrice || raw.formatPrice || 0);
  const likes = parseNum(raw.likes || raw.likeCount || raw.like_count || raw.diggCount || raw.favorites || reviews || 0);

  return {
    uid: `${context.platform}:${raw.itemId || raw.listingId || raw.productId || raw.product_id || raw.asin || raw.id || url || title}`,
    type: 'product_listing',
    platform: context.platform,
    title: String(title).substring(0, 200),
    url: url,
    image: extractImage(raw),
    price: price,
    currency: raw.currency || raw.currencyCode || 'USD',
    shopName: shopName,
    rating: rating,
    reviewCount: reviews,
    soldCount: sold,
    likes: likes,
    views: parseNum(raw.views || raw.viewCount || raw.playCount || 0),
    comments: parseNum(raw.comments || raw.commentCount || 0),
    shares: parseNum(raw.shares || raw.shareCount || 0),
    firstSeenAt: raw.firstSeenAt || raw.createTimeISO || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    raw: raw
  };
};
