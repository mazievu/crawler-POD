/**
 * Apify Client Module
 * Wraps Apify API calls and defines Actor input builders.
 */

const { ApifyClient } = require('apify-client');
const { getPlatform } = require('./platform-config');

const TOKEN = process.env.APIFY_TOKEN;

// ==================== Client ====================

const client = TOKEN ? new ApifyClient({ token: TOKEN }) : null;

// ==================== Input Builders ====================

/**
 * Each builder takes { query, maxItems, country } and returns Actor input.
 */
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

  // Facebook Ads — curious_coder (needs `urls`)
  facebook_ads: ({ query, maxItems, country }) => ({
    urls: [`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country || 'ALL'}&q=${encodeURIComponent(query)}`],
    maxResults: maxItems,
    maxItems: maxItems,
  }),

  // TikTok Ads — silva95gustavo (needs valid startUrls)
  tiktok_ads: ({ query, maxItems }) => ({
    startUrls: [{ url: `https://www.tiktok.com/search?q=${encodeURIComponent(query)}&t=ads` }],
    maxItems,
  }),

  // TikTok Shop — clockworks/tiktok-scraper
  tiktok_shop: ({ query, maxItems }) => ({
    searchTerms: [query],
    maxItems,
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

  // Instagram Search — apify/instagram-search-scraper (keyword search)
  instagram: ({ query, maxItems }) => ({
    // The actor expects a singular `search` string and `hashtag` (not
    // `hashtags`) as the search type.
    search: query,
    searchType: 'hashtag',
    searchLimit: maxItems,
  }),
};

// ==================== API Functions ====================

/**
 * Start an Apify actor for the given platform.
 * @param {string} actorId - The actor ID to run
 * @param {string} platform - Platform name
 * @param {{ query: string, maxItems: number, country?: string }} input
 * @returns {{ runId: string, datasetId: string }}
 */
async function startActor(actorId, platform, input, apiClient = client) {
  if (!apiClient) {
    throw new Error('Apify client not initialized. Set APIFY_TOKEN in .env');
  }

  if (!actorId) {
    throw new Error(`actorId is missing for platform: ${platform}`);
  }

  const buildInput = INPUT_BUILDERS[platform];
  if (!buildInput) {
    throw new Error(`No input builder for: ${platform}`);
  }

  const actorInput = buildInput(input);
  console.log(`[Apify] Starting ${actorId}...`);

  const run = await apiClient.actor(actorId).call(actorInput, {
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
async function getRunStatus(runId, apiClient = client) {
  if (!apiClient) {
    throw new Error('Apify client not initialized');
  }

  const run = await apiClient.run(runId).get();
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
async function fetchDatasetItems(datasetId, limit = 100, apiClient = client) {
  if (!apiClient) {
    throw new Error('Apify client not initialized');
  }

  return paginateDatasetItems(apiClient.dataset(datasetId), limit);
}

// ==================== Exports ====================

module.exports = {
  startActor,
  getRunStatus,
  fetchDatasetItems,
  paginateDatasetItems,
  INPUT_BUILDERS,
};
