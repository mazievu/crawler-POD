const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'tiktok_shop',
  displayName: 'TikTok Shop',
  description: 'TikTok Shop products (requires Apify paid plan)',
  queryType: 'keyword',
  icon: '🛒',
  color: '#ff4d8a',

  intelligenceTypes: ["product_listing"],

  availability: {
    status: CHANNEL_STATUS.READY,
    zeroConfig: false,
    requiresAuth: [],
    requiresLoginSession: false,
    paid: true,
    countrySupport: false,
    lastVerifiedAt: '2026-06-24'
  },

  risk: {
    tosRisk: 'medium',
    blockRisk: 'medium',
    dataReliability: 'medium'
  },

  backends: [
    
    {
      name: 'apify',
      kind: BACKEND_KIND.APIFY,
      priority: 20,
      enabled: true,
      actorId: 'clockworks/tiktok-scraper',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'product_listing'
};
