const fs = require('fs');
const path = require('path');

const platforms = [
  { name: 'facebook_posts', displayName: 'Facebook Posts', description: 'Facebook post search (requires Apify paid plan)', queryType: 'keyword', icon: '📘', color: '#4599ff', paid: true, actorId: 'danek/facebook-search-ppr', intelligenceTypes: ['social_post'], normalizer: 'social_post' },
  { name: 'facebook_ads', displayName: 'Facebook Ads', description: 'Meta Ad Library ads', queryType: 'keyword', icon: '📢', color: '#4599ff', countrySupport: true, actorId: 'apify/facebook-ads-scraper', intelligenceTypes: ['ad_creative'], normalizer: 'ad_creative' },
  { name: 'pinterest', displayName: 'Pinterest', description: 'Pinterest pins and boards', queryType: 'keyword', icon: '📌', color: '#ff6b6b', actorId: 'automation-lab/pinterest-scraper', intelligenceTypes: ['social_post'], normalizer: 'social_post' },
  { name: 'amazon', displayName: 'Amazon', description: 'Amazon products, prices, reviews', queryType: 'keyword', icon: '📦', color: '#ff9900', countrySupport: true, actorId: 'automation-lab/amazon-scraper', intelligenceTypes: ['product_listing'], normalizer: 'product_listing' },
  { name: 'reddit', displayName: 'Reddit', description: 'Reddit posts and discussions', queryType: 'keyword', icon: '🔴', color: '#ff6b3d', actorId: 'automation-lab/reddit-scraper', intelligenceTypes: ['social_post', 'trend_signal'], normalizer: 'social_post' },
  { name: 'google_shopping', displayName: 'Google Shopping', description: 'Google Shopping product listings', queryType: 'keyword', icon: '🛍️', color: '#6ba3f7', countrySupport: true, actorId: 'automation-lab/google-shopping-scraper', intelligenceTypes: ['product_listing'], normalizer: 'product_listing' },
  { name: 'shopify', displayName: 'Shopify', description: 'Shopify store products', queryType: 'url', icon: '🏪', color: '#96bf48', actorId: 'automation-lab/shopify-scraper', intelligenceTypes: ['product_listing'], normalizer: 'product_listing' },
  { name: 'tiktok_shop', displayName: 'TikTok Shop', description: 'TikTok Shop products (requires Apify paid plan)', queryType: 'keyword', icon: '🛒', color: '#ff4d8a', paid: true, actorId: 'clockworks/tiktok-scraper', intelligenceTypes: ['product_listing'], normalizer: 'product_listing' },
  { name: 'etsy', displayName: 'Etsy', description: 'Etsy products (requires Apify paid plan)', queryType: 'keyword', icon: '🧡', color: '#f1641e', paid: true, actorId: 'epctex/etsy-scraper', intelligenceTypes: ['product_listing'], normalizer: 'product_listing' },
  { name: 'twitter', displayName: 'X / Twitter', description: 'Twitter/X tweets (requires Apify paid plan)', queryType: 'keyword', icon: '🐦', color: '#1da1f2', paid: true, actorId: 'xquik/x-tweet-scraper', intelligenceTypes: ['social_post'], normalizer: 'social_post' },
  { name: 'ebay', displayName: 'eBay Sold', description: 'eBay sold listings (actor under maintenance)', queryType: 'keyword', icon: '🏷️', color: '#e53238', disabled: true, actorId: 'caffein.dev/ebay-sold-listings', intelligenceTypes: ['product_listing'], normalizer: 'product_listing' },
  { name: 'instagram', displayName: 'Instagram', description: 'Instagram hashtags, profiles, places by keyword (requires paid plan)', queryType: 'keyword', icon: '📸', color: '#e4405f', paid: true, actorId: 'apify/instagram-search-scraper', intelligenceTypes: ['social_post'], normalizer: 'social_post' },
  { name: 'toidispy', displayName: 'Toidispy', description: 'Facebook Ads Library via CDP (free, requires login)', queryType: 'keyword', icon: '🔍', color: '#00d4aa', actorId: 'cdp', intelligenceTypes: ['ad_creative'], normalizer: 'ad_creative', backendKind: 'cdp', backendName: 'cdp' }
];

platforms.forEach(p => {
  const content = `const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: '${p.name}',
  displayName: '${p.displayName}',
  description: '${p.description}',
  queryType: '${p.queryType}',
  icon: '${p.icon}',
  color: '${p.color}',

  intelligenceTypes: ${JSON.stringify(p.intelligenceTypes)},

  availability: {
    status: ${p.disabled ? 'CHANNEL_STATUS.DISABLED' : 'CHANNEL_STATUS.READY'},
    zeroConfig: ${!p.paid},
    requiresAuth: [],
    requiresLoginSession: ${p.name === 'toidispy'},
    paid: ${!!p.paid},
    countrySupport: ${!!p.countrySupport},
    lastVerifiedAt: '2026-06-24'
  },

  risk: {
    tosRisk: 'medium',
    blockRisk: 'medium',
    dataReliability: 'medium'
  },

  backends: [
    ${p.name === 'reddit' ? `{
      name: 'local-scraper',
      kind: BACKEND_KIND.LOCAL,
      priority: 10,
      enabled: true
    },` : ''}
    ${p.backendName ? `{
      name: '${p.backendName}',
      kind: BACKEND_KIND.${p.backendKind.toUpperCase()},
      priority: 20,
      enabled: true
    }` : `{
      name: 'apify',
      kind: BACKEND_KIND.APIFY,
      priority: 20,
      enabled: true,
      actorId: '${p.actorId}',
      requiresEnv: ['APIFY_TOKEN']
    }`}
  ],

  normalizer: '${p.normalizer}'
};
`;
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'channels', `${p.name}.channel.js`), content);
});
console.log('Channels generated.');
