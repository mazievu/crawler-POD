const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'facebook_posts',
  displayName: 'Facebook Posts',
  description: 'Facebook post search (requires Apify paid plan)',
  queryType: 'keyword',
  icon: '📘',
  color: '#4599ff',
  domain: 'facebook.com',

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
      actorId: 'scraper_one/facebook-posts-search',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "verified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'social_post'
};
