const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'twitter',
  displayName: 'X / Twitter',
  description: 'Twitter/X tweets (requires Apify paid plan)',
  queryType: 'keyword',
  icon: '🐦',
  color: '#1da1f2',

  intelligenceTypes: ["social_post"],

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
      actorId: 'xquik/x-tweet-scraper',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'social_post'
};
