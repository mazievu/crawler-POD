/**
 * Apify Client Module
 * Wraps Apify API calls and defines Actor input builders.
 */

const { ApifyClient } = require('apify-client');
const { getPlatform } = require('./platform-config');

const { getApifyTokenPool } = require('./apify-token-pool');

const TOKEN = process.env.APIFY_TOKEN;

// ==================== Client ====================

function getClient(overrideClient = null) {
  if (overrideClient) return overrideClient;
  try {
    const pool = getApifyTokenPool();
    const admission = pool.acquire();
    if (admission.allowed && admission.client) {
      return admission.client;
    }
  } catch {}
  return TOKEN ? new ApifyClient({ token: TOKEN }) : null;
}

const client = TOKEN ? new ApifyClient({ token: TOKEN }) : null;

// ==================== Input Builders ====================

/**
 * Each builder takes { query, maxItems, country } and returns Actor input.
 */
/**
 * Hard per-call result caps published by an actor's own input schema.
 *
 * A platform listed here cannot be asked for more than this many items in one
 * actor call, so collecting more means paging. Only platforms whose schema
 * actually declares a maximum belong here — an entry that is merely assumed
 * would silently halve throughput.
 */
const PRATIKDANI_LIMIT_MAX = 10;

const ACTOR_PAGE_LIMITS = {
  // inputSchema.properties.limit.maximum is 10, read from this actor's live
  // build metadata on 2026-09-07. unseenuser/TikTok-Shop-Scraper is absent on
  // purpose: its maxResults maximum is 5000, so it needs no paging.
  'pratikdani/tiktok-shop-search-scraper': PRATIKDANI_LIMIT_MAX,
};

/**
 * Input builders keyed by ACTOR id, for platforms served by more than one actor
 * whose input schemas differ. Looked up before the per-platform table below, so
 * a platform keeps working when its actors disagree about field names.
 */
const ACTOR_INPUT_BUILDERS = {
  /*
   * clockworks/tiktok-scraper — TikTok VIDEO metrics plus full comment threads.
   *
   * This is the actor that used to be wired to tiktok_shop by mistake: it
   * scrapes videos, not shop listings, which is exactly what tiktok_videos
   * needs. Verified live on 2026-09-11 (run bufWDKmTr1ENybDdK, dataset
   * qjmehgl79BOnT5L5Y, "press on nails", 3 videos, $0.031):
   *
   *   diggCount 67,000 · shareCount 4,929 · collectCount 20,238
   *   commentCount 197 · playCount 1,400,000
   *
   * Comments land in a SEPARATE dataset the item points at via
   * `commentsDatasetUrl`; each row carries text, diggCount, replyCommentTotal,
   * repliesToId, uniqueId and createTimeISO. `commentsPerPost` is what turns
   * that on — without it the actor returns counts but no comment text.
   *
   * The direct-URL form takes precedence: a query that looks like a TikTok URL
   * is a request for THAT video, not a search for its text.
   */
  'clockworks/tiktok-scraper': ({ query, maxItems, options = {} }) => {
    const trimmed = String(query || '').trim();
    const isUrl = /^https?:\/\/(www\.|vm\.|vt\.)?tiktok\.com\//i.test(trimmed);
    const isHashtag = /^#/.test(trimmed);
    const perPost = Number(options.commentsPerPost ?? 20);

    const base = {
      resultsPerPage: maxItems,
      // Comment depth. topLevelCommentsPerPost bounds how many threads and
      // maxRepliesPerComment bounds each thread, so "full comments" stays
      // bounded rather than unbounded on a viral post.
      commentsPerPost: perPost,
      topLevelCommentsPerPost: Number(options.topLevelCommentsPerPost ?? perPost),
      maxRepliesPerComment: Number(options.maxRepliesPerComment ?? 5),
      scrapeRelatedVideos: false,
      shouldDownloadVideos: false,
    };

    if (isUrl) return { ...base, postURLs: [trimmed] };
    if (isHashtag) return { ...base, hashtags: [trimmed.replace(/^#/, '')] };
    return { ...base, searchQueries: [trimmed], searchSection: '/video' };
  },

  /*
   * memo23/facebook-ads-library-scraper-ppe — the only source verified to
   * return the two fields apify/facebook-ads-scraper never carries.
   *
   * Verified live on 2026-09-08 (run w0EQIRi1TDh0aasWQ, dataset
   * CD4GGAOYifWYnBow6, "press on nails", DE, 5 ads, $0.05):
   *
   *   data_reach...eu_transparency.eu_total_reach    = 2,622,368
   *   data_reach...eu_transparency.location_audience = [Austria, Germany]
   *   total_ads_count                                = 75 / 60 / 82 / 10
   *
   * `includeAdReach` is what fetches the ad's DETAIL page, where Meta publishes
   * EU transparency; the search-results endpoint the older actor reads simply
   * does not carry it. `includeTotalActiveAds` adds the advertiser's live ad
   * count, a real number rather than collationCount's nullable one.
   *
   * RESIDENTIAL proxy is not optional: the first attempt on Apify's datacenter
   * pool hit Facebook rate limit 1675004 on every request and never produced an
   * item. With RESIDENTIAL it succeeded on the first try.
   */
  'memo23/facebook-ads-library-scraper-ppe': ({ query, maxItems, country }) => ({
    searchTerms: [query],
    ...(country ? { searchCountries: [country] } : {}),
    adActiveStatus: 'active',
    includeAdReach: true,
    includeTotalActiveAds: true,
    maxItems,
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      ...(country ? { apifyProxyCountry: country } : {}),
    },
  }),

  // unseenuser/TikTok-Shop-Scraper — schema read from its live build metadata
  // on 2026-09-07: required ["mode"], searchKeywords (array), region (string,
  // default "US"), maxResults (integer, maximum 5000).
  'unseenuser/TikTok-Shop-Scraper': ({ query, maxItems, country }) => ({
    mode: 'shop_search',
    searchKeywords: [query],
    region: String(country || 'US').toUpperCase(),
    maxResults: Math.max(1, Number(maxItems) || 20),
  }),
};

const INPUT_BUILDERS = {
  // Facebook Posts/Groups — danek/facebook-search-ppr
  facebook_posts: ({ query, maxItems }) => ({
    query: query,
    max_posts: maxItems,
    maxChargedResults: maxItems,
    search_type: 'posts',
  }),
  facebook_groups: ({ query, maxItems }) => ({
    query: query,
    max_posts: maxItems,
    maxChargedResults: maxItems,
    search_type: 'groups',
  }),

  // Facebook Ads — apify/facebook-ads-scraper (requires search_type=keyword_unordered & startUrls: [{ url }])
  facebook_ads: ({ query, maxItems, country }) => {
    const targetUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country || 'ALL'}&media_type=all&q=${encodeURIComponent(query)}&search_type=keyword_unordered`;
    return {
      startUrls: [{ url: targetUrl }],
      urls: [targetUrl],
      resultsLimit: maxItems,
      maxResults: maxItems,
      maxItems,
      maxChargedResults: maxItems
    };
  },

  // TikTok Ads — silva95gustavo (needs valid startUrls)
  tiktok_ads: ({ query, maxItems }) => ({
    startUrls: [{ url: `https://www.tiktok.com/search?q=${encodeURIComponent(query)}&t=ads` }],
    maxItems,
  }),

  /*
   * TikTok Shop — pratikdani/tiktok-shop-search-scraper.
   *
   * Verified against the live actor on 2026-09-07 (not carried over from any
   * prior report): public, not deprecated, 78,531 runs, and its published input
   * schema is exactly
   *     required: ["country_code"]
   *     country_code (string) · keyword (string) · limit (integer, maximum 10)
   *     · page (integer, minimum 1)
   *
   * `limit` really is capped at 10 by that schema, so a Top-20 job is two calls
   * (page 1 + page 2), not one call for 20. A separate runtime check confirmed
   * consecutive pages return disjoint products: page=1 and page=2 at limit=5
   * shared zero product_ids.
   *
   * The previous configuration pointed at clockworks/tiktok-scraper, which is a
   * TikTok *video* scraper and carries no product, price or sold data at all.
   */
  tiktok_shop: ({ query, maxItems, country, page }) => ({
    country_code: String(country || 'US').toUpperCase(),
    keyword: query,
    limit: Math.min(PRATIKDANI_LIMIT_MAX, Math.max(1, Number(maxItems) || PRATIKDANI_LIMIT_MAX)),
    page: Math.max(1, Number(page) || 1),
  }),

  // Pinterest — automation-lab/pinterest-scraper
  pinterest: ({ query, maxItems }) => ({
    searchQueries: [query],
    maxPins: maxItems,
  }),

  // Etsy — apify/e-commerce-scraping-tool (general e-commerce)
  etsy: ({ query, maxItems }) => ({
    urls: [`https://www.etsy.com/search?q=${encodeURIComponent(query)}`],
    maxItems,
  }),

  // Amazon — automation-lab/amazon-scraper
  amazon: ({ query, maxItems, country }) => {
    // The selected actor accepts at most 1,000 products and 20 search pages
    // per keyword. Amazon normally renders roughly 16-48 products per page.
    const productsPerSearch = Math.min(1000, Math.max(1, Number.parseInt(maxItems, 10) || 100));
    return {
      searchQueries: [query],
      marketplace: country || 'US',
      maxProductsPerSearch: productsPerSearch,
      maxSearchPages: Math.min(20, Math.max(1, Math.ceil(productsPerSearch / 48))),
      sort: 'relevance',
    };
  },

  // Reddit — automation-lab/reddit-scraper
  reddit: ({ query, maxItems }) => ({
    searchQuery: query,
    maxPostsPerSource: maxItems,
    sort: 'new',
  }),

  // Google Shopping — automation-lab/google-shopping-scraper
  google_shopping: ({ query, maxItems }) => ({
    queries: [query],
    maxResults: maxItems,
  }),

  // Shopify — automation-lab/shopify-scraper
  shopify: ({ query, maxItems }) => ({
    storeUrls: [query],
    scrapeProducts: true,
    scrapeReviews: true,
    maxProducts: maxItems,
    maxReviewsPerProduct: 5,
  }),

  // X/Twitter — xquik/x-tweet-scraper
  twitter: ({ query, maxItems }) => ({
    searchTerms: [query],
    maxTweets: maxItems,
    maxChargedResults: maxItems,
    maxItems: maxItems,
    sort: 'Latest',
  }),

  // eBay Sold Listings — caffein.dev/ebay-sold-listings
  ebay: ({ query, maxItems, country: _country }) => ({
    keywords: [query],
    count: maxItems,
    daysToScrape: 30,
    ebaySite: 'ebay.com',
    sortOrder: 'endedRecently',
    itemCondition: 'any',
  }),

  // Instagram — apify/instagram-scraper
  instagram: ({ query, maxItems }) => {
    const cleanTag = String(query || '').replace(/^#+/, '').trim();
    return {
      search: cleanTag,
      searchType: 'hashtag',
      searchLimit: maxItems,
      directUrls: [`https://www.instagram.com/explore/tags/${encodeURIComponent(cleanTag)}/`],
      resultsLimit: maxItems,
      resultsType: 'posts',
    };
  },
};

// ==================== API Functions ====================

/**
 * Start an Apify actor for the given platform.
 * @param {string} actorId - The actor ID to run
 * @param {string} platform - Platform name
 * @param {{ query: string, maxItems: number, country?: string }} input
 * @returns {{ runId: string, datasetId: string }}
 */
async function startActor(actorId, platform, input, apiClient = null) {
  const effectiveClient = getClient(apiClient);
  if (!effectiveClient) {
    throw new Error('Apify client not initialized. Set APIFY_TOKEN in .env');
  }

  if (!actorId) {
    throw new Error(`actorId is missing for platform: ${platform}`);
  }

  const buildInput = ACTOR_INPUT_BUILDERS[actorId] || INPUT_BUILDERS[platform];
  if (!buildInput) {
    throw new Error(`No input builder for: ${platform} (actor ${actorId})`);
  }

  const actorInput = buildInput(input);
  console.log(`[Apify] Starting ${actorId}...`);

  const run = await effectiveClient.actor(actorId).call(actorInput, {
    waitSecs: 0, // Don't wait, we'll poll
  });

  console.log(`[Apify] Run started: ${run.id}`);

  return {
    runId: run.id,
    datasetId: run.defaultDatasetId,
  };
}

/**
 * Get the status of an Apify run.
 * @param {string} runId
 * @returns {string} - 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABORTED'
 */
async function getRunStatus(runId, apiClient = null) {
  const effectiveClient = getClient(apiClient);
  if (!effectiveClient) {
    throw new Error('Apify client not initialized');
  }

  const run = await effectiveClient.run(runId).get();
  return run.status;
}

/**
 * Fetch a dataset in bounded pages. Actors can return thousands of records,
 * while one listItems call is intentionally kept small and predictable.
 * @param {{ listItems: Function }} dataset
 * @param {number} limit
 * @param {{ pageSize?: number }} options
 * @returns {Promise<object[]>}
 */
async function paginateDatasetItems(dataset, limit = 100, { pageSize = 1000 } = {}) {
  const target = Math.max(1, Number.parseInt(limit, 10) || 100);
  const boundedPageSize = Math.max(1, Math.min(1000, Number.parseInt(pageSize, 10) || 1000));
  const collected = [];
  let offset = 0;

  while (collected.length < target) {
    const requestLimit = Math.min(boundedPageSize, target - collected.length);
    const response = await dataset.listItems({ offset, limit: requestLimit, clean: true });
    const page = Array.isArray(response?.items) ? response.items : [];
    collected.push(...page.slice(0, target - collected.length));

    if (page.length < requestLimit) break;
    offset += page.length;
  }

  return collected;
}

/**
 * Fetch items from an Apify dataset.
 * @param {string} datasetId
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function fetchDatasetItems(datasetId, limit = 100, apiClient = null) {
  const effectiveClient = getClient(apiClient);
  if (!effectiveClient) {
    throw new Error('Apify client not initialized');
  }

  return paginateDatasetItems(effectiveClient.dataset(datasetId), limit);
}

// ==================== Exports ====================

module.exports = {
  startActor,
  getRunStatus,
  fetchDatasetItems,
  paginateDatasetItems,
  INPUT_BUILDERS,
  ACTOR_INPUT_BUILDERS,
  ACTOR_PAGE_LIMITS,
};
