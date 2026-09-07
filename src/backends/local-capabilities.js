/**
 * Per-channel local execution capability declarations (Live-Readiness Round #1).
 *
 * Replaces the growing hard-coded exception `channel.name !== 'reddit'` with a
 * declared table, built from actually reading each src/scrapers/*.js file:
 *
 * - shopify.js: fetches public products.json directly. No SearXNG, no browser.
 * - reddit.js: fetches public reddit.com/search.json directly; falls back to
 *   launchStealth() (browser) only if the direct path fails.
 * - pinterest.js: uses the official API when PINTEREST_TOKEN is set, otherwise
 *   ALWAYS uses launchStealth() (browser) — never touches SearXNG.
 * - ebay.js: Tier 1 is SearXNG-based discovery; Tier 2 is a real Playwright
 *   (launchStealth) fallback.
 * - etsy.js: Tier 1 is CloakBrowser — a real local browser searching Etsy
 *   directly (never touches SearXNG on its healthy path); Tier 2 (SearXNG)
 *   is a supplement only if Tier 1 is short/fails; Tier 3 is an external
 *   Everbee HOST API call.
 * - google_shopping.js: delegates entirely to SearXNG-based discovery; no
 *   fallback of any kind exists today.
 *
 * `hasDirectMethodWithoutSearXNG: true` means the channel never needs SearXNG
 * on its healthy path — SearXNG is irrelevant to it, not merely "optional".
 * `mayUseBrowserFallback: true` means the channel can genuinely execute via a
 * local browser (launchStealth) if its non-browser path is unavailable — the
 * Scheduler MUST reserve a BROWSER-class envelope + pool slot for it whenever
 * that fallback might be used (see execution-planner.js).
 */

const LOCAL_CHANNEL_CAPABILITIES = {
  shopify: {
    hasDirectMethodWithoutSearXNG: true,
    mayUseBrowserFallback: false,
    supportsSharding: false,
    partitionStrategy: null
  },
  reddit: {
    hasDirectMethodWithoutSearXNG: true,
    mayUseBrowserFallback: true,
    supportsSharding: false,
    partitionStrategy: null
  },
  pinterest: {
    hasDirectMethodWithoutSearXNG: true, // never touches SearXNG at all
    mayUseBrowserFallback: true,          // scrapePublic() always launches a browser without a token
    supportsSharding: false,
    partitionStrategy: null
  },
  ebay: {
    // CloakBrowser Collect round: Tier 1 is now a real local browser
    // (CloakBrowser) searching eBay Sold directly — independent of SearXNG.
    hasDirectMethodWithoutSearXNG: true,
    mayUseBrowserFallback: true,
    supportsSharding: false,
    partitionStrategy: null
  },
  etsy: {
    // CloakBrowser Collect round: Tier 1 is now a real local browser
    // (CloakBrowser) searching Etsy directly — genuinely independent of
    // SearXNG's health. Leaving this false (the pre-CloakBrowser value)
    // makes local-scraper.backend.js's probe() report Etsy unhealthy
    // whenever SearXNG is down, routing the channel to the paid Apify
    // backend instead — confirmed live during this round's verification.
    hasDirectMethodWithoutSearXNG: true,
    mayUseBrowserFallback: true, // CloakBrowser genuinely launches a real browser context — budget it as BROWSER-class
    supportsSharding: false,
    partitionStrategy: null
  },
  google_shopping: {
    hasDirectMethodWithoutSearXNG: false,
    mayUseBrowserFallback: false, // no real fallback implemented yet — correctly reports DEPENDENCY_DOWN when SearXNG is down
    supportsSharding: false,
    partitionStrategy: null
  }
};

function getLocalCapability(channelName) {
  return LOCAL_CHANNEL_CAPABILITIES[channelName] || null;
}

module.exports = { LOCAL_CHANNEL_CAPABILITIES, getLocalCapability };
