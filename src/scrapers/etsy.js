/**
 * Etsy Scraper
 *
 * CloakBrowser-primary, multi-tier REAL fallback:
 *   1. CloakBrowser — a real browser searching Etsy's own site directly,
 *      paginating for real until maxItems unique listings are found or the
 *      source runs out. PRIMARY.
 *   2. SearXNG — SUPPLEMENT ONLY. Only called if Tier 1 is still short of
 *      maxItems (or failed outright); only ADDS listings for IDs Tier 1
 *      doesn't already have. Never overwrites a Tier-1 listing.
 *   3. Everbee Host discovery (remote CloakBrowser executor) — supplement,
 *      only if still short after Tier 1+2.
 *   4. Database historical snapshot matching — supplement/last resort,
 *      explicitly marked as cached (isLive downgrades only if it ends up
 *      being the ONLY contributor).
 *
 * Live-Readiness Round #5: no fabricated/random data on total failure — if
 * every tier ends up with zero listings, this throws a typed error.
 */

const { discoverEtsyListingsViaCloakBrowser } = require('./etsy-cloakbrowser');

class EtsyAllSourcesFailedError extends Error {
  constructor(query) {
    super(`ETSY_ALL_SOURCES_FAILED: no real data available for "${query}" (CloakBrowser, SearXNG, Everbee host, and historical cache all unavailable/empty)`);
    this.name = 'EtsyAllSourcesFailedError';
    this.code = 'ETSY_ALL_SOURCES_FAILED';
  }
}

const LISTING_ID_PATTERN = /etsy\.com\/listing\/(\d+)/i;

function listingIdOf(item) {
  if (item.listingId) return String(item.listingId);
  const match = LISTING_ID_PATTERN.exec(String(item.url || ''));
  return match ? match[1] : null;
}

/**
 * Merge `newItems` into `merged` (Map keyed by listingId), WITHOUT
 * overwriting anything already present — a later/lower-priority tier may
 * only ADD listings for IDs the higher-priority tier didn't already find,
 * never replace or degrade an existing entry's data.
 * @returns number of items actually added
 */
function mergeSupplement(merged, newItems) {
  let added = 0;
  for (const item of newItems) {
    const id = listingIdOf(item);
    if (!id || merged.has(id)) continue;
    merged.set(id, item);
    added++;
  }
  return added;
}

async function scrape(query, options = {}) {
  const maxItems = Number(options.maxItems || options.limit || 30);
  const merged = new Map(); // listingId -> item, Tier-1 (CloakBrowser) entries never overwritten

  const debug = {
    cloakBrowserDiscovered: 0,
    cloakBrowserPagesVisited: 0,
    cloakBrowserBlocked: false,
    searxngCalled: false,
    searxngSupplemented: 0,
    everbeeHostSupplemented: 0,
    cacheSupplemented: 0,
  };

  // Tier 1: CloakBrowser — PRIMARY. Real browser, real pagination against
  // Etsy's own search results, until maxItems unique listings or the
  // source runs out.
  try {
    const result = await discoverEtsyListingsViaCloakBrowser({
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
    if (options.signal?.aborted) {
      const abortErr = new Error('ABORTED: execution cancelled');
      abortErr.name = 'AbortError';
      abortErr.code = 'ABORTED';
      throw abortErr;
    }
    if (err?.name === 'AbortError' || err?.code === 'ABORTED' || /ABORT/i.test(err?.message || '')) {
      throw err;
    }
    console.warn('[Etsy Scraper] CloakBrowser discovery failed:', err.message);
  }

  // Tier 2: SearXNG — SUPPLEMENT ONLY. Only called when Tier 1 is still
  // short of maxItems (including the case where it found nothing at all).
  // Requesting `limit: maxItems` (not the remaining gap) lets SearXNG's own
  // dedupe-by-id logic run against the full target; mergeSupplement() below
  // is what actually enforces "only add what's missing."
  if (merged.size < maxItems) {
    if (options.signal?.aborted) throw new Error('ABORTED: execution cancelled');
    try {
      debug.searxngCalled = true;
      const { discoverMarketplaceItems } = require('./search-discovery');
      const result = await discoverMarketplaceItems('etsy', query, { ...options, limit: maxItems });
      if (result && Array.isArray(result.items)) {
        debug.searxngSupplemented = mergeSupplement(merged, result.items);
      }
    } catch (err) {
      if (options.signal?.aborted) {
        const abortErr = new Error('ABORTED: execution cancelled');
        abortErr.name = 'AbortError';
        abortErr.code = 'ABORTED';
        throw abortErr;
      }
      if (err?.name === 'AbortError' || err?.code === 'ABORTED' || /ABORT/i.test(err?.message || '')) {
        throw err;
      }
      console.warn('[Etsy Scraper] SearXNG supplement failed:', err.message);
    }
  }

  // Tier 3: Everbee Host discovery (remote CloakBrowser executor) — supplement.
  if (merged.size < maxItems) {
    if (options.signal?.aborted) throw new Error('ABORTED: execution cancelled');
    try {
      const { discoverMarketplaceListingsViaEverbeeHost } = require('../marketplaces/everbee-host-client');
      const everbeeResult = await discoverMarketplaceListingsViaEverbeeHost({
        platform: 'etsy',
        keyword: query,
        limit: maxItems - merged.size,
        signal: options.signal
      });
      if (everbeeResult && Array.isArray(everbeeResult.items)) {
        debug.everbeeHostSupplemented = mergeSupplement(merged, everbeeResult.items);
      }
    } catch (err) {
      if (options.signal?.aborted) {
        const abortErr = new Error('ABORTED: execution cancelled');
        abortErr.name = 'AbortError';
        abortErr.code = 'ABORTED';
        throw abortErr;
      }
      if (err?.name === 'AbortError' || err?.code === 'ABORTED' || /ABORT/i.test(err?.message || '')) {
        throw err;
      }
      console.warn('[Etsy Scraper] Everbee host discovery unavailable:', err.message);
    }
  }

  // Tier 4: Database matching snapshots — REAL past data, supplement/last
  // resort, explicitly tracked as cache-sourced.
  if (merged.size < maxItems) {
    if (options.signal?.aborted) throw new Error('ABORTED: execution cancelled');
    try {
      // Reads through the shared Postgres connection rather than opening its
      // own handle on ./data/collector.db — that SQLite file is archive-only
      // after the Postgres cutover and must not be touched at runtime.
      const database = require('../database');
      const existingSnapshots = await database.getSnapshotsMatchingQuery('etsy', query, maxItems - merged.size);

      if (existingSnapshots.length > 0) {
        const cacheItems = existingSnapshots.map(s => ({
          title: s.title,
          url: s.url,
          price: s.price,
          priceText: `$${s.price}`,
          image: s.image,
          author: s.author,
          rating: s.rating,
          reviews: s.reviews,
          soldCount: s.sold_count,
          _fromCache: true,
        }));
        debug.cacheSupplemented = mergeSupplement(merged, cacheItems);
      }
    } catch (err) {
      if (options.signal?.aborted) {
        const abortErr = new Error('ABORTED: execution cancelled');
        abortErr.name = 'AbortError';
        abortErr.code = 'ABORTED';
        throw abortErr;
      }
      if (err?.name === 'AbortError' || err?.code === 'ABORTED' || /ABORT/i.test(err?.message || '')) {
        throw err;
      }
      console.warn('[Etsy Scraper] DB fallback search failed:', err.message);
    }
  }

  if (merged.size === 0) {
    throw new EtsyAllSourcesFailedError(query);
  }

  // isLive: false only if the cache tier was the SOLE contributor (matches
  // the pre-existing semantic — never present a fresh crawl as cached, and
  // never present a purely-cached result as live).
  const isLive = !(debug.cacheSupplemented > 0 && debug.cloakBrowserDiscovered === 0 && debug.searxngSupplemented === 0 && debug.everbeeHostSupplemented === 0);

  const rawItems = Array.from(merged.values());
  await enrichEtsyImagesWithTaskPool(rawItems, options, debug);

  const items = rawItems.map((item) => ({
    platform: 'etsy',
    title: item.title,
    url: item.url,
    price: item.price || 0,
    priceText: item.priceText || `$${item.price || 0}`,
    currency: item.currency || 'USD',
    image: item.image || '',
    description: item.description || '',
    author: item.author || item.shopName || 'Etsy Seller',
    listingId: listingIdOf(item) || '',
    rating: item.rating || 0,
    reviews: item.reviews || 0,
    soldCount: item.soldCount || 0,
    views: item.views || 0,
    likes: item.likes || 0,
    comments: item.comments || 0,
    shares: item.shares || 0,
    status: 'new',
    source: item.source || 'mixed',
    isLive
  }));

  return { items, source: 'mixed', isLive, _debug: debug };
}

/**
 * Product-level image enrichment, run as independent tasks through the
 * SAME RAM-aware pool mechanism the rest of the system already uses
 * (InternalTaskPool + computeInternalConcurrency) instead of a hand-rolled
 * fixed-4 worker loop. Reuses imageFromProductPage() from
 * search-discovery.js (same fetch+og:image extraction logic, not
 * duplicated) — only the orchestration around it changes.
 *
 * RAM accounting is global: reserved against the SAME ResourceMonitor
 * instance the Scheduler uses for Run admission (via getScheduler().monitor),
 * under a key distinct from the Run's own base-envelope reservation (keyed
 * by executionToken by the Scheduler) so this addition never clobbers it —
 * it is purely additive to the global reserved total, and always released
 * in a finally, including on abort/failure.
 */
async function enrichEtsyImagesWithTaskPool(items, options, debug) {
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

  const monitor = getScheduler().monitor;
  const reservationKey = `${options.executionToken || 'etsy-standalone'}:image-enrich:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;

  const { effectiveHeadroomMB } = monitor.getSnapshot();
  const { concurrency, taskCostMB } = computeInternalConcurrency({
    executionClass: 'LOCAL_HTTP',
    runBaseCostMB: 0, // the Run's own base envelope is already reserved (and
    // already subtracted into effectiveHeadroomMB) by the Scheduler under
    // executionToken — this call is purely for the ADDITIONAL internal-task
    // RAM, so it must not subtract the base cost a second time.
    effectiveHeadroomMB,
  });

  debug.productTasksCreated = needsImage.length;
  debug.peakConcurrentTasks = Math.min(concurrency, needsImage.length);
  debug.internalConcurrencySource = 'InternalTaskPool + computeInternalConcurrency (RAM-aware)';
  debug.ramReservedMB = concurrency * taskCostMB;
  debug.productTasksFailed = 0;

  monitor.reserve(reservationKey, concurrency * taskCostMB);
  try {
    const pool = new InternalTaskPool({ concurrency, signal: options.signal });
    const results = await pool.run(needsImage, async (item) => {
      item.image = await imageFromProductPage(item.url);
      return item;
    });
    debug.productTasksFailed = results.filter((r) => r.status === 'rejected').length;
  } finally {
    monitor.release(reservationKey);
    debug.ramReleased = true;
  }
}

module.exports = { scrape, EtsyAllSourcesFailedError };
