function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const match = String(v ?? '').replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
  if (!match) return 0;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return (parseFloat(match[1]) * multiplier) || 0;
}

/**
 * Counts must be whole numbers. Expanding a provider's abbreviation in binary
 * floating point does not always land on one: TikTok Shop's "8.19K" evaluates
 * to 8189.999999999999, which would be stored in an INTEGER column and shown as
 * a nonsense figure. Prices and ratings deliberately do NOT go through this —
 * $8.53 and 4.6 are meant to keep their decimals.
 */
function parseCount(v) {
  const n = parseNum(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const { extractImage } = require('../image-utils');

module.exports = function normalizeProductListing(raw, context = { platform: 'product_listing' }) {
  const title = raw.title || raw.productTitle || raw.product_name || raw.name || raw.text || raw.desc || '';
  /*
   * TikTok Shop (pratikdani/tiktok-shop-search-scraper) returns NO product URL
   * field — verified across 10 real products on 2026-09-07. What it does return
   * is product_id plus product_name_slug, which are exactly the two parts of a
   * TikTok Shop product permalink, so the link is CONSTRUCTED from them rather
   * than invented: nothing is emitted when product_id is missing.
   */
  const tiktokShopUrl = raw.product_id
    ? `https://www.tiktok.com/view/product/${raw.product_id}`
    : '';
  const url = raw.url || raw.productUrl || raw.product_url || raw.link || raw.webVideoUrl || raw.permalink || (raw.asin ? `https://www.amazon.com/dp/${raw.asin}` : '') || tiktokShopUrl || '';
  
  let shopName = '';
  if (typeof raw.author === 'object' && raw.author) {
    shopName = raw.author.name || raw.author.nickName || raw.author.username || '';
  } else if (typeof raw.seller === 'object' && raw.seller) {
    // TikTok Shop nests the shop: seller { seller_id, seller_name, cover_url,
    // total_sale_cnt, total_sale_gmv_amt }. The generic branch below would have
    // stringified this object into "[object Object]".
    shopName = raw.seller.seller_name || raw.seller.name || '';
  } else {
    shopName = raw.shopName || raw.shop_name || raw.sellerName || raw.seller_name || raw.storeName || raw.store_name || raw.vendor || raw.merchant || raw.store || raw.brand || raw.seller || raw.author || '';
  }

  const rating = parseNum(raw.rating || raw.averageRating || raw.average_rating || raw.stars || raw.productRating || raw.product_rating || raw.score || raw.review_score || 0);
  const reviews = parseCount(raw.reviewCount || raw.review_count || raw.reviews || raw.reviewsCount || raw.ratingCount || raw.ratingsCount || raw.total_reviews || 0);
  const sold = parseCount(raw.soldCount || raw.sold_count || raw.sold || raw.sales || raw.orders || raw.orderCount || raw.total_sold || raw.item_sold || raw.total_sale_cnt || raw.volume || 0);
  // TikTok Shop reports a range (min_price/max_price) plus avg_price, and masks
  // real_price/original_price with "*". avg_price is the single number that
  // represents the listing; min_price is the fallback when it is absent.
  const price = parseNum(raw.price || raw.product_price || raw.priceNumeric || raw.currentPrice || raw.salePrice || raw.avg_price || raw.min_price || raw.minPrice || raw.formatPrice || 0);
  const likes = parseCount(raw.likes || raw.likeCount || raw.like_count || raw.diggCount || raw.favorites || reviews || 0);

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
    views: parseCount(raw.views || raw.viewCount || raw.playCount || 0),
    comments: parseCount(raw.comments || raw.commentCount || 0),
    shares: parseCount(raw.shares || raw.shareCount || 0),
    firstSeenAt: raw.firstSeenAt || raw.createTimeISO || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),

    /*
     * Task 5.4 — RETURN_POSITION, deliberately not called "rank".
     *
     * The actor returns no rank/position field of any kind, and its own
     * description says it "scrapes TikTok Shop search results" — it never
     * claims the order is a ranking or a best-seller chart. A runtime check
     * agrees: the sold counts came back 160.23K, 201.38K, 25.13K, 47.04K,
     * 45.21K, i.e. NOT sorted by sales. So the only defensible statement is
     * "this is the position the provider returned it in", which is what this
     * field says. Renaming it to `rank` would assert ordering semantics the
     * provider has not confirmed.
     */
    returnPosition: Number.isInteger(context.index) ? context.index + 1 : null,

    // TikTok Shop extras, all straight from the raw payload. Absent on other
    // platforms, where they stay null rather than 0 — "not reported" is not
    // the same claim as "zero".
    sold30d: raw.total_sale_30d_cnt !== undefined ? parseCount(raw.total_sale_30d_cnt) : null,
    sold7d: raw.total_sale_7d_cnt !== undefined ? parseCount(raw.total_sale_7d_cnt) : null,
    gmv: raw.total_sale_gmv_amt !== undefined ? Math.round(parseNum(raw.total_sale_gmv_amt) * 100) / 100 : null,
    gmv30d: raw.total_sale_gmv_30d_amt !== undefined ? Math.round(parseNum(raw.total_sale_gmv_30d_amt) * 100) / 100 : null,
    // The two TikTok Shop actors disagree on shape: pratikdani nests
    // seller{seller_id} and region{id}, unseenuser sends a flat shopId and a
    // plain "US" string for region. Both are read rather than one being
    // rewritten to look like the other.
    shopUrl: raw.seller?.seller_id
      ? `https://www.tiktok.com/shop/s/${raw.seller.seller_id}`
      : (raw.shopId ? `https://www.tiktok.com/shop/s/${raw.shopId}` : ''),
    country: (typeof raw.region === 'string' ? raw.region.toUpperCase() : (raw.region?.id || raw.region?.key?.toUpperCase())) || raw.country || '',
    category: raw.category || '',
    raw: raw
  };
};
