const productListing = require('./product-listing');
const adCreative = require('./ad-creative');
const socialPost = require('./social-post');
const trendSignal = require('./trend-signal');

const normalizers = {
  product_listing: productListing,
  ad_creative: adCreative,
  social_post: socialPost,
  trend_signal: trendSignal
};

function normalizeItems(normalizerName, items, context) {
  const normalizer = normalizers[normalizerName];
  if (!normalizer) {
    console.warn(`No normalizer found for ${normalizerName}, returning raw items`);
    return items;
  }
  // `index` is the position the provider returned the item in. It is the only
  // ordering signal available for TikTok Shop, whose actor emits no rank field
  // — see returnPosition in product-listing.js for why that is not called rank.
  return items.map((item, index) => normalizer(item, { ...context, index }));
}

module.exports = { normalizeItems };
