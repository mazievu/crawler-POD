const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'tiktok_videos',
  displayName: 'TikTok Videos',
  description: 'TikTok video posts \u2014 likes, shares, saves, comments, views, and full comment extraction',
  queryType: 'keyword',
  icon: '\uD83C\uDFB5',
  color: '#000000',

  intelligenceTypes: ['social_post', 'trend_signal'],

  availability: {
    status: CHANNEL_STATUS.READY,
    // paid/zeroConfig describe what this channel ACTUALLY needs, and the
    // honest answer is a paid actor: the free path returns a bot-block page
    // (see the backends note below). Declaring it free kept the router on the
    // "don't spend money when a local scraper exists" rule and it picked
    // local-scraper every time — run #1013 chose backend=local and failed
    // EMPTY_RESULT while the Apify backend sat unused at priority 10.
    zeroConfig: false,
    requiresAuth: ['APIFY_TOKEN'],
    requiresLoginSession: false,
    paid: true,
    countrySupport: false,
    lastVerifiedAt: '2026-09-11'
  },

  risk: {
    tosRisk: 'high',
    blockRisk: 'high',
    dataReliability: 'high'
  },

  backends: [
    /*
     * Apify is PRIMARY here, inverting this project's usual local-first rule,
     * because local-first does not actually work for TikTok: a plain GET to
     * tiktok.com returns a 1.4 KB bot-block page with no
     * __UNIVERSAL_DATA_FOR_REHYDRATION__ payload, and the TikWM mirror the
     * local scraper falls back to answers its search endpoint with Cloudflare
     * HTTP 403. Measured 2026-09-11: run #980 failed EMPTY_RESULT and a direct
     * video URL failed REHYDRATION_MISSING.
     *
     * A residential proxy does not rescue it either — the local scraper sets
     * `fetchOpts.agent` and then calls native fetch, which ignores `agent`
     * outright; a deliberately dead proxy was sailed straight past, with the
     * machine's own IP reported back.
     *
     * The actor also returns collectCount ("Lưu") and full comment threads,
     * which the SSR payload does not expose at all.
     */
    {
      name: 'apify',
      kind: BACKEND_KIND.APIFY,
      priority: 10,
      enabled: true,
      actorId: 'clockworks/tiktok-scraper',
      requiresEnv: ['APIFY_TOKEN'],
      // "verified" because the actor was actually executed on this account, not
      // because the config looked plausible: run bufWDKmTr1ENybDdK returned 3
      // videos with full metrics and a comments dataset for $0.031 on
      // 2026-09-11. Left "unverified" the doctor rated this backend `warn`,
      // the router preferred the `ok` local-scraper, and runs #1013/#1046 both
      // went to the local path and failed EMPTY_RESULT.
      actorEntitlement: 'verified',
      availabilityMode: 'token_plus_actor_entitlement'
    },
    {
      name: 'local-scraper',
      kind: BACKEND_KIND.LOCAL,
      priority: 20,
      enabled: false // Disabled: TikTok aggressively blocks direct datacenter IPs and SSR lacks comment text/saves. Primary execution routes through verified Apify actor.
    }
  ],

  normalizer: 'social_post'
};
