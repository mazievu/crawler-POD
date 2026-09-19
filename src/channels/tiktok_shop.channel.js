const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'tiktok_shop',
  displayName: 'TikTok Shop',
  description: 'TikTok Shop products (requires Apify paid plan)',
  queryType: 'keyword',
  icon: '🛒',
  color: '#ff4d8a',
  domain: 'tiktok.com',

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
     * PRIORITY SWAPPED 2026-09-15. pratikdani is now primary.
     *
     * unseenuser was primary on the strength of its schema, which declares
     * maxResults with a maximum of 5000 - the note here used to read "a Top-20
     * job is a single call". Measured, that is false: the actor returns exactly
     * 5 dataset items and ignores maxResults entirely. Runs #746, #747, #748 and
     * #785 each asked for 20-30 and stored 5. A control run on 2026-09-15 asked
     * for maxResults=12 on "phone case" - a keyword with thousands of listings -
     * and the run SUCCEEDED with an itemCount of 5. The input Apify received was
     * verified from the run's own INPUT record, so the cap is the actor's, not
     * ours. It also has no page/offset field, so it cannot be paged around: N
     * repeat calls would return the same 5 products.
     *
     * pratikdani's upstream has recovered - the empty result sets seen on
     * 2026-09-07 are gone. Re-verified 2026-09-15: limit=10 on "phone case"
     * returned 10 items, its cover_url answered HTTP 200 (the HTTP 500 that
     * demoted it is fixed), and it carries the fields unseenuser never had:
     * product_rating 4.4, review_count 4.36K, total_sale_30d_cnt 10.48K,
     * total_sale_gmv_amt 88.17K. Its limit maximum is 10, and ACTOR_PAGE_LIMITS
     * already registers that, so apify.backend.js pages it to reach any maxItems.
     * It still reports no product URL; product-listing.js builds one from
     * product_id, which is why that is not a blocker.
     *
     * unseenuser stays enabled as the fallback: it is the one that kept working
     * when pratikdani went dark, and 5 products beat zero.
     */
    {
      name: 'apify',
      kind: BACKEND_KIND.APIFY,
      priority: 30,
      enabled: true,
      actorId: 'unseenuser/TikTok-Shop-Scraper',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    },
    {
      name: 'apify-pratikdani',
      kind: BACKEND_KIND.APIFY,
      priority: 20,
      enabled: true,
      actorId: 'pratikdani/tiktok-shop-search-scraper',
      requiresEnv: ['APIFY_TOKEN'],
      actorEntitlement: "unverified",
      availabilityMode: 'token_plus_actor_entitlement'
    }
  ],

  normalizer: 'product_listing'
};
