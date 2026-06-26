/**
 * Free-first capability registry inspired by Agent-Reach's channel model.
 *
 * Each platform has an ordered backend list. The first live backend wins; paid
 * APIs stay visible as fallbacks instead of becoming the default route.
 */

const { isReady: searxngReady } = require('../scripts/start-searxng');
const { isReady: cdpReady } = require('../scripts/start-cdp');

const STATUS_ORDER = ['ok', 'fallback'];

const PAID_CREDENTIALS = {
  'scrape-do': ['SCRAPE_DO_TOKEN', 'SCRAPEDO_TOKEN'],
  scrapingdog: ['SCRAPINGDOG_API_KEY'],
  'apify-amazon': ['APIFY_TOKEN'],
  'serper-shopping': ['SERPER_API_KEY'],
  'serpapi-shopping': ['SERPAPI_API_KEY'],
  'apify-google-shopping': ['APIFY_TOKEN'],
  'apify-facebook-posts': ['APIFY_TOKEN'],
  'apify-facebook-ads': ['APIFY_TOKEN'],
  'apify-pinterest': ['APIFY_TOKEN'],
  getxapi: ['GETXAPI_KEY'],
  'apify-twitter': ['APIFY_TOKEN'],
  'apify-instagram': ['APIFY_TOKEN'],
  'scrapfly-instagram': ['SCRAPFLY_API_KEY'],
  'apify-tiktok': ['APIFY_TOKEN'],
  'sociavault-tiktok': ['SOCIAVAULT_API_KEY'],
  'apify-etsy': ['APIFY_TOKEN'],
  'apify-ebay': ['APIFY_TOKEN'],
  'apify-reddit': ['APIFY_TOKEN'],
  'apify-shopify': ['APIFY_TOKEN'],
};

const CAPABILITIES = [
  {
    name: 'web',
    displayName: 'Any public web page',
    tier: 0,
    backends: [
      {
        id: 'jina-reader',
        label: 'Jina Reader',
        kind: 'free',
        check: 'always',
        note: 'Reads public pages as clean Markdown via https://r.jina.ai/http://...',
      },
    ],
  },
  {
    name: 'search',
    displayName: 'Search discovery',
    tier: 0,
    backends: [
      { id: 'searxng', label: 'Local SearXNG', kind: 'free_local', check: 'searxng' },
    ],
  },
  {
    name: 'toidispy',
    displayName: 'Toidispy / Facebook Ads Library',
    tier: 1,
    backends: [
      { id: 'cdp', label: 'Local Chrome CDP session', kind: 'free_login', check: 'cdp' },
    ],
  },
  {
    name: 'amazon',
    displayName: 'Amazon',
    tier: 0,
    backends: [
      { id: 'searxng-amazon', label: 'SearXNG product URL discovery', kind: 'free_local', check: 'searxng' },
      { id: 'scrape-do', label: 'Scrape.do Amazon', kind: 'paid_api', check: 'paid' },
      { id: 'scrapingdog', label: 'Scrapingdog Amazon', kind: 'paid_api', check: 'paid' },
      { id: 'apify-amazon', label: 'Apify Amazon actor', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'google_shopping',
    displayName: 'Google Shopping',
    tier: 2,
    backends: [
      { id: 'searxng-google-shopping', label: 'SearXNG indexed product discovery', kind: 'experimental_free', check: 'searxng_unverified' },
      { id: 'serper-shopping', label: 'Serper.dev Google Shopping', kind: 'paid_api', check: 'paid' },
      { id: 'serpapi-shopping', label: 'SerpAPI Google Shopping', kind: 'paid_api', check: 'paid' },
      { id: 'apify-google-shopping', label: 'Apify Google Shopping actor', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'facebook_posts',
    displayName: 'Facebook Posts',
    tier: 0,
    backends: [
      { id: 'searxng-facebook', label: 'SearXNG indexed public posts', kind: 'free_local', check: 'searxng' },
      { id: 'apify-facebook-posts', label: 'Apify Facebook posts actor', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'facebook_ads',
    displayName: 'Facebook Ads',
    tier: 2,
    backends: [
      { id: 'apify-facebook-ads', label: 'Apify Facebook Ads actor', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'pinterest',
    displayName: 'Pinterest',
    tier: 0,
    backends: [
      { id: 'pinterest-public-search', label: 'Public Pinterest search via browser', kind: 'free_browser', check: 'manual' },
      { id: 'apify-pinterest', label: 'Apify Pinterest actor', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'twitter',
    displayName: 'X / Twitter',
    tier: 0,
    backends: [
      { id: 'searxng-twitter', label: 'SearXNG indexed tweets', kind: 'free_local', check: 'searxng' },
      { id: 'getxapi', label: 'GetXAPI', kind: 'paid_api', check: 'paid' },
      { id: 'apify-twitter', label: 'Apify tweet scraper', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'instagram',
    displayName: 'Instagram',
    tier: 0,
    backends: [
      { id: 'searxng-instagram', label: 'SearXNG indexed posts/reels', kind: 'free_local', check: 'searxng' },
      { id: 'apify-instagram', label: 'Apify Instagram scraper', kind: 'paid_api', check: 'paid' },
      { id: 'scrapfly-instagram', label: 'ScrapFly Instagram', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'tiktok_shop',
    displayName: 'TikTok Shop',
    tier: 0,
    backends: [
      { id: 'searxng-tiktok', label: 'SearXNG indexed videos/photos', kind: 'free_local', check: 'searxng' },
      { id: 'apify-tiktok', label: 'Apify TikTok scraper', kind: 'paid_api', check: 'paid' },
      { id: 'sociavault-tiktok', label: 'SociaVault TikTok', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'etsy',
    displayName: 'Etsy',
    tier: 0,
    backends: [
      { id: 'searxng-etsy', label: 'SearXNG listing discovery', kind: 'free_local', check: 'searxng' },
      { id: 'apify-etsy', label: 'Apify Etsy scraper', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'ebay',
    displayName: 'eBay',
    tier: 0,
    backends: [
      { id: 'searxng-ebay', label: 'SearXNG item discovery', kind: 'free_local', check: 'searxng' },
      { id: 'apify-ebay', label: 'Apify eBay actor', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'reddit',
    displayName: 'Reddit',
    tier: 1,
    backends: [
      { id: 'playwright-public-search', label: 'Public Reddit search via Playwright', kind: 'free_browser', check: 'manual' },
      { id: 'apify-reddit', label: 'Apify Reddit scraper', kind: 'paid_api', check: 'paid' },
    ],
  },
  {
    name: 'shopify',
    displayName: 'Shopify',
    tier: 0,
    backends: [
      { id: 'products-json', label: 'Shopify products.json', kind: 'free_public', check: 'manual' },
      { id: 'apify-shopify', label: 'Apify Shopify actor', kind: 'paid_api', check: 'paid' },
    ],
  },
];

function getCapability(name) {
  return CAPABILITIES.find(capability => capability.name === name) || null;
}

function hasCredential(backend, checks = {}) {
  const required = PAID_CREDENTIALS[backend.id] || [];
  if (!required.length) return false;

  const source = Object.prototype.hasOwnProperty.call(checks, 'credentials')
    ? checks.credentials || {}
    : process.env;

  return required.some(key => Boolean(source[key]));
}

function backendStatus(backend, checks = {}) {
  if (backend.check === 'always') {
    return { status: 'ok', message: 'available' };
  }
  if (backend.check === 'manual') {
    return { status: 'warn', message: 'available route, not probed by doctor' };
  }
  if (backend.check === 'paid') {
    if (hasCredential(backend, checks)) {
      return { status: 'fallback', message: 'paid fallback configured' };
    }
    return { status: 'off', message: 'paid fallback candidate; credential not configured' };
  }
  if (backend.check === 'searxng_unverified') {
    return {
      status: 'warn',
      message: checks.searxng ? 'search service ready but live data not verified' : 'search service not ready',
    };
  }
  const ok = Boolean(checks[backend.check]);
  return {
    status: ok ? 'ok' : 'warn',
    message: ok ? 'ready' : 'not ready',
  };
}

function selectActiveBackend(backends, checks = {}) {
  const probed = backends.map(backend => ({
    ...backend,
    ...backendStatus(backend, checks),
  }));

  for (const status of STATUS_ORDER) {
    const active = probed.find(backend => backend.status === status);
    if (active) return { active, backends: probed };
  }

  return { active: null, backends: probed };
}

async function collectRuntimeChecks() {
  const [searxng, cdp] = await Promise.all([
    searxngReady(),
    cdpReady(),
  ]);
  return { searxng, cdp };
}

async function checkAllCapabilities(checks = null) {
  const runtimeChecks = checks || await collectRuntimeChecks();
  return CAPABILITIES.map(capability => {
    const result = selectActiveBackend(capability.backends, runtimeChecks);
    return {
      name: capability.name,
      displayName: capability.displayName,
      tier: capability.tier,
      status: result.active?.status || 'off',
      activeBackend: result.active || null,
      backends: result.backends,
    };
  });
}

module.exports = {
  CAPABILITIES,
  getCapability,
  hasCredential,
  selectActiveBackend,
  checkAllCapabilities,
  collectRuntimeChecks,
};
