const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'ebay',
  displayName: 'eBay Sold',
  description: 'eBay sold listings via public discovery; Apify is an optional fallback',
  queryType: 'keyword',
  icon: '🏷️',
  color: '#e53238',

  intelligenceTypes: ["product_listing"],

  availability: {
    status: CHANNEL_STATUS.READY,
    zeroConfig: true,
    requiresAuth: [],
    requiresLoginSession: false,
    paid: false,
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
      name: 'local-scraper',
      kind: BACKEND_KIND.LOCAL,
      priority: 10,
      enabled: true
    },
    {
      name: 'apify',
      kind: BACKEND_KIND.APIFY,
      priority: 20,
      enabled: true,
      actorId: 'caffein.dev/ebay-sold-listings',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'product_listing'
};
