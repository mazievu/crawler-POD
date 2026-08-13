const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'reddit',
  displayName: 'Reddit',
  description: 'Reddit posts and discussions',
  queryType: 'keyword',
  icon: '🔴',
  color: '#ff6b3d',

  intelligenceTypes: ["social_post","trend_signal"],

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
      actorId: 'automation-lab/reddit-scraper',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'social_post'
};
