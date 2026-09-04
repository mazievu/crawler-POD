/**
 * Free product discovery fallback. It returns indexed merchant listings with
 * price and product images when the paid Google Shopping actor is unavailable.
 *
 * Google Shopping RAM-control round: image enrichment used to run through
 * search-discovery.js's shared enrichImages() (hardcoded concurrency=4, not
 * RAM-aware). This platform now does its own enrichment pass here, through
 * the existing InternalTaskPool + computeInternalConcurrency mechanism
 * (same pattern already used for Etsy Collect), with RAM reserved globally
 * against the real Scheduler's ResourceMonitor before tasks run and released
 * in `finally` regardless of success/error/abort. discoverMarketplaceItems()
 * itself, and its provider priority (local/SearXNG primary, Apify fallback),
 * are untouched — only WHO runs the image-fetch loop changed.
 */
const { discoverMarketplaceItems, imageFromProductPage } = require('./search-discovery');
const { InternalTaskPool, computeInternalConcurrency } = require('../scheduler/internal-task-pool');

async function scrape(query, options = {}) {
  const result = await discoverMarketplaceItems('google_shopping', query, { ...options, skipImageEnrichment: true });
  await enrichGoogleShoppingImagesWithTaskPool(result.items, options);
  return result;
}

async function enrichGoogleShoppingImagesWithTaskPool(items, options) {
  const needsImage = items.filter((it) => !it.image);
  if (needsImage.length === 0) return;

  const { getScheduler } = require('../scheduler/scheduler');
  const monitor = getScheduler().monitor;
  // Distinct key from the Run's own base-envelope reservation (Scheduler
  // reserves that under executionToken) — this is purely additive to the
  // global reserved total, never clobbers it.
  const reservationKey = `${options.executionToken || 'google-shopping-standalone'}:image-enrich:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;

  const { effectiveHeadroomMB } = monitor.getSnapshot();
  const { concurrency, taskCostMB } = computeInternalConcurrency({
    executionClass: 'LOCAL_HTTP',
    runBaseCostMB: 0, // the Run's base envelope is already reserved (and already
    // subtracted into effectiveHeadroomMB) by the Scheduler — do not subtract twice.
    effectiveHeadroomMB,
  });

  monitor.reserve(reservationKey, concurrency * taskCostMB);
  try {
    const pool = new InternalTaskPool({ concurrency, signal: options.signal });
    await pool.run(needsImage, async (item) => {
      item.image = await imageFromProductPage(item.url);
      return item;
    });
  } finally {
    monitor.release(reservationKey);
  }
}

// enrichGoogleShoppingImagesWithTaskPool exported for direct verification
// (RAM reserve/release + InternalTaskPool wiring) without depending on live
// SearXNG/network — same testability pattern already used elsewhere in this
// file's module (imageFromSearchResult/isMerchantResult exported likewise).
module.exports = { scrape, enrichGoogleShoppingImagesWithTaskPool };
