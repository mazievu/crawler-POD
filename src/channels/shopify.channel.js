const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'shopify',
  displayName: 'Shopify',
  description: 'Shopify store products via the public products.json endpoint',
  queryType: 'url',
  icon: '🏪',
  color: '#96bf48',

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
      actorId: 'automation-lab/shopify-scraper',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'product_listing'
};
