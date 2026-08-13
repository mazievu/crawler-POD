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
  return items.map(item => normalizer(item, context));
}

module.exports = { normalizeItems };
