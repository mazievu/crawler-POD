const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'facebook_ads',
  displayName: 'Facebook Ads',
  description: 'Meta Ad Library ads',
  queryType: 'keyword',
  icon: '📢',
  color: '#4599ff',

  intelligenceTypes: ["ad_creative"],

  availability: {
    status: CHANNEL_STATUS.READY,
    zeroConfig: true,
    requiresAuth: [],
    requiresLoginSession: false,
    paid: false,
    countrySupport: true,
    lastVerifiedAt: '2026-06-24'
  },

  risk: {
    tosRisk: 'medium',
    blockRisk: 'medium',
    dataReliability: 'medium'
  },

  backends: [
    /*
     * Primary since 2026-09-08. apify/facebook-ads-scraper reads the Ad Library
     * SEARCH RESULTS endpoint, which carries no reach and no country list for
     * commercial ads — verified null/[] on 15/15 ads across US, GB and DE.
     * This actor fetches each ad's DETAIL page, where Meta publishes EU
     * transparency, and returns eu_total_reach, location_audience and
     * total_ads_count. The old one stays as fallback: cheaper, and still
     * correct for everything except those three fields.
     */
    {
      name: 'apify-reach',
      kind: BACKEND_KIND.APIFY,
      priority: 10,
      enabled: true,
      actorId: 'memo23/facebook-ads-library-scraper-ppe',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: 'unverified',
      availabilityMode: 'token_plus_actor_entitlement'
    },
    {
      name: 'apify',
      kind: BACKEND_KIND.APIFY,
      priority: 20,
      enabled: true,
      actorId: 'apify/facebook-ads-scraper',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'ad_creative'
};
