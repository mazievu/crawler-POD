/**
 * eBay Scraper
 *
 * CloakBrowser-primary, multi-tier REAL fallback:
 *   1. CloakBrowser — a real browser searching eBay's Sold/Completed items directly,
 *      paginating until maxItems unique listings are found or source runs out. PRIMARY.
 *   2. SearXNG — SUPPLEMENT ONLY. Only called if Tier 1 is still short of
 *      maxItems (or failed outright); only ADDS listings for IDs Tier 1
 *      doesn't already have. Never overwrites a Tier-1 listing.
 *   3. Database historical snapshot matching — supplement/last resort.
 */

const { discoverEbayListingsViaCloakBrowser } = require('./ebay-cloakbrowser');

class EbayAllSourcesFailedError extends Error {
  constructor(query) {
    super(`EBAY_ALL_SOURCES_FAILED: no real data available for "${query}" (CloakBrowser, SearXNG, and historical cache all unavailable/empty)`);
    this.name = 'EbayAllSourcesFailedError';
    this.code = 'EBAY_ALL_SOURCES_FAILED';
  }
}

const ITEM_ID_PATTERN = /ebay\.[a-z.]+\/itm\/(\d+)|itm\/(\d+)/i;

function itemIdOf(item) {
  if (item.itemId) return String(item.itemId);
  if (item.listingId) return String(item.listingId);
  const match = String(item.url || '').match(ITEM_ID_PATTERN);
  return match ? (match[1] || match[2]) : null;
}

/**
 * Merge `newItems` into `merged` (Map keyed by itemId), WITHOUT
 * overwriting anything already present — a later/lower-priority tier may
 * only ADD listings for IDs the higher-priority tier didn't already find.
 * @returns number of items actually added
 */
function mergeSupplement(merged, newItems) {
  let added = 0;
  for (const item of newItems) {
    const id = itemIdOf(item);
    if (!id || merged.has(id)) continue;
    merged.set(id, item);
    added++;
  }
  return added;
}

async function scrape(query, options = {}) {
  const maxItems = Number(options.maxItems || options.limit || 30);
  const merged = new Map(); // itemId -> item

  const debug = {
    cloakBrowserDiscovered: 0,
    cloakBrowserPagesVisited: 0,
    cloakBrowserBlocked: false,
    searxngCalled: false,
    searxngSupplemented: 0,
    cacheSupplemented: 0,
  };

  // Tier 1: CloakBrowser — PRIMARY. Real browser against eBay Sold listings.
  try {
    const result = await discoverEbayListingsViaCloakBrowser({
      query,
      maxItems,
      signal: options.signal,
      proxy: options.proxyUrl || null,
      sessionKey: options.executionToken || null,
    });
    debug.cloakBrowserPagesVisited = result.pagesVisited;
    debug.cloakBrowserBlocked = result.blocked;
    mergeSupplement(merged, result.items);
    debug.cloakBrowserDiscovered = merged.size;
  } catch (err) {
    if (options.signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORTED' || /ABORT/i.test(err?.message || '')) {
      throw err;
    }
    console.warn('[eBay Scraper] CloakBrowser discovery failed:', err.message);
  }

  // Tier 2: SearXNG — SUPPLEMENT ONLY. Only called if Tier 1 is short of maxItems.
  if (merged.size < maxItems) {
    if (options.signal?.aborted) throw new Error('ABORTED: execution cancelled');
    try {
      debug.searxngCalled = true;
      const { discoverMarketplaceItems } = require('./search-discovery');
      const result = await discoverMarketplaceItems('ebay', query, { ...options, limit: maxItems });
      if (result && Array.isArray(result.items)) {
        debug.searxngSupplemented = mergeSupplement(merged, result.items);
      }
    } catch (err) {
      if (options.signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORTED' || /ABORT/i.test(err?.message || '')) {
        throw err;
      }
      console.warn('[eBay Scraper] SearXNG supplement failed:', err.message);
    }
  }

  // Tier 3: Database historical snapshots — supplement / last resort.
  if (merged.size < maxItems) {
    if (options.signal?.aborted) throw new Error('ABORTED: execution cancelled');
    try {
      // Reads through the shared Postgres connection rather than opening its
      // own handle on ./data/collector.db — that SQLite file is archive-only
      // after the Postgres cutover and must not be touched at runtime.
      const database = require('../database');
      const existingSnapshots = await database.getSnapshotsMatchingQuery('ebay', query, maxItems - merged.size);

      if (existingSnapshots.length > 0) {
        const cacheItems = existingSnapshots.map(s => ({
          title: s.title,
          url: s.url,
          price: s.price,
          priceText: `$${s.price}`,
          image: s.image,
          author: s.author,
          seller: s.author,
          rating: s.rating,
          reviews: s.reviews,
          soldCount: s.sold_count,
          _fromCache: true,
        }));
        debug.cacheSupplemented = mergeSupplement(merged, cacheItems);
      }
    } catch (err) {
      if (options.signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORTED' || /ABORT/i.test(err?.message || '')) {
        throw err;
      }
      console.warn('[eBay Scraper] DB fallback search failed:', err.message);
    }
  }

  if (merged.size === 0) {
    throw new EbayAllSourcesFailedError(query);
  }

  const isLive = !(debug.cacheSupplemented > 0 && debug.cloakBrowserDiscovered === 0 && debug.searxngSupplemented === 0);

  const rawItems = Array.from(merged.values());
  await enrichEbayImagesWithTaskPool(rawItems, options, debug);

  const items = rawItems.map((item) => ({
    platform: 'ebay',
    title: item.title,
    url: item.url,
    price: item.price || 0,
    priceText: item.priceText || `$${item.price || 0}`,
    currency: item.currency || 'USD',
    image: item.image || '',
    description: item.description || '',
    author: item.author || item.seller || 'eBay Seller',
    seller: item.seller || item.author || 'eBay Seller',
    listingId: itemIdOf(item) || '',
    itemId: itemIdOf(item) || '',
    rating: item.rating || 0,
    reviews: item.reviews || 0,
    soldCount: item.soldCount || 0,
    views: item.views || 0,
    likes: item.likes || 0,
    comments: item.comments || 0,
    shares: item.shares || 0,
    listingStatus: 'sold_or_completed',
    status: 'new',
    source: item.source || 'mixed',
    isLive
  }));

  return { items, source: 'mixed', isLive, _debug: debug };
}

/**
 * Product-level image enrichment using InternalTaskPool + computeInternalConcurrency.
 */
async function enrichEbayImagesWithTaskPool(items, options, debug) {
  const needsImage = items.filter((it) => !it.image);
  if (needsImage.length === 0) {
    debug.productTasksCreated = 0;
    debug.peakConcurrentTasks = 0;
    debug.internalConcurrencySource = 'n/a (no items needed image enrichment)';
    debug.ramReservedMB = 0;
    return;
  }

  const { getScheduler } = require('../scheduler/scheduler');
  const { InternalTaskPool, computeInternalConcurrency } = require('../scheduler/internal-task-pool');
  const { imageFromProductPage } = require('./search-discovery');

  let monitor = null;
  try {
    monitor = getScheduler()?.monitor;
  } catch (_) {}

  const reservationKey = `${options.executionToken || 'ebay-standalone'}:image-enrich:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;

  let concurrency = 2;
  let taskCostMB = 8;
  if (monitor) {
    const { effectiveHeadroomMB } = monitor.getSnapshot();
    const computed = computeInternalConcurrency({
      executionClass: 'LOCAL_HTTP',
      runBaseCostMB: 0,
      effectiveHeadroomMB,
    });
    concurrency = computed.concurrency;
    taskCostMB = computed.taskCostMB;
    monitor.reserve(reservationKey, concurrency * taskCostMB);
  }

  debug.productTasksCreated = needsImage.length;
  debug.peakConcurrentTasks = Math.min(concurrency, needsImage.length);
  debug.internalConcurrencySource = 'InternalTaskPool + computeInternalConcurrency (RAM-aware)';
  debug.ramReservedMB = concurrency * taskCostMB;
  debug.productTasksFailed = 0;

  try {
    const pool = new InternalTaskPool({ concurrency, signal: options.signal });
    const results = await pool.run(needsImage, async (item) => {
      item.image = await imageFromProductPage(item.url);
      return item;
    });
    debug.productTasksFailed = results.filter((r) => r.status === 'rejected').length;
  } finally {
    if (monitor) {
      monitor.release(reservationKey);
    }
    debug.ramReleased = true;
  }
}

module.exports = { scrape, EbayAllSourcesFailedError };
