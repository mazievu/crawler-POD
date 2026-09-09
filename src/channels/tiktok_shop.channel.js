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
    
    /*
     * Two product actors, both verified live on 2026-09-07. The previous
     * configuration used clockworks/tiktok-scraper, which is a TikTok VIDEO
     * scraper — it returns posts, so price/sold/rating/shop were never
     * obtainable from it at all.
     *
     * unseenuser is primary because it is the one returning data, and because
     * it gives a real product URL and a real TikTok CDN image where pratikdani
     * gives neither (pratikdani has no URL field, and its cover_url is a
     * provider-hosted proxy that was answering HTTP 500 during testing). Its
     * maxResults cap is 5000, so a Top-20 job is a single call.
     *
     * pratikdani stays configured as the fallback because it reports fields
     * unseenuser does not — review_count, total_sale_30d_cnt and
     * total_sale_gmv_amt — and should be promoted back to primary once its
     * upstream recovers. As of 2026-09-07 11:47-12:05 UTC it returned an empty
     * result set for every keyword tried (runs zNerAZPY1d1Lgn56s,
     * pPIS9K6mxnIKRkjhp and one more), while the same actor and the same input
     * had returned products at 07:29-07:30 the same day.
     */
    {
      name: 'apify',
      kind: BACKEND_KIND.APIFY,
      priority: 20,
      enabled: true,
      actorId: 'unseenuser/TikTok-Shop-Scraper',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    },
    {
      name: 'apify-pratikdani',
      kind: BACKEND_KIND.APIFY,
      priority: 30,
      enabled: true,
      actorId: 'pratikdani/tiktok-shop-search-scraper',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'product_listing'
};
