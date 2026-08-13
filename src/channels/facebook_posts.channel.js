const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'facebook_posts',
  displayName: 'Facebook Posts',
  description: 'Facebook post search (requires Apify paid plan)',
  queryType: 'keyword',
  icon: '📘',
  color: '#4599ff',

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
      actorId: 'danek/facebook-search-ppr',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'social_post'
};
