const db = require('../database');
const { CheckpointStore } = require('./checkpoint-store');
const { EtsyJourneyHandler } = require('./etsy-journey');
const { EbayJourneyHandler } = require('./ebay-journey');
const { AmazonJourneyHandler } = require('./amazon-journey');
const { launchStealth } = require('../../anti-bot/stealth-launcher');
const { createCloakBrowserSession } = require('./cloakbrowser-session');
const { createRunFxContext } = require('../currency');
const { InternalTaskPool, computeInternalConcurrency } = require('../scheduler/internal-task-pool');

const PLATFORM_URLS = {
  etsy: 'https://www.etsy.com',
  ebay: 'https://www.ebay.com',
  amazon: 'https://www.amazon.com'
};

const HANDLER_MAP = {
  etsy: EtsyJourneyHandler,
  ebay: EbayJourneyHandler,
  amazon: AmazonJourneyHandler
};

async function runUserJourney({
  platform = 'etsy',
  keyword = 'press on nails',
  zipCode = '90210',
  maxProducts = 10,
  filters = {},
  proxy = null,
  storageState = null,
  runId = null,
  executionToken = null,
  // §6: propagated from ManagedExecution -> server executor -> here, so a
  // timeout can actually stop THIS execution's browser work instead of just
  // marking the Run failed while Playwright keeps running unattended.
  signal = null,
  // §7/§8: called immediately before any business-data write (checkpoint
  // persistence) — a stale execution whose lease was revoked mid-journey must
  // not be able to write product_current/daily_packed_history.
  assertOwner = () => {},
  // Testability seam only (same pattern as html-capture.js's browserFactory) —
  // production always uses the real launchStealth/createCloakBrowserSession; tests inject a fake one so
  // the §6 abort-cleanup contract can be verified without a real browser.
  launchStealthFn = launchStealth,
  launchCloakBrowserFn = null
} = {}) {
  const normPlatform = String(platform || 'etsy').toLowerCase();
  const HandlerClass = HANDLER_MAP[normPlatform];
  if (!HandlerClass) throw new Error(`Unsupported platform for User Journey: ${platform}`);

  const sessionId = `journey_${normPlatform}_${Date.now()}`;
  const store = new CheckpointStore({ platform: normPlatform, keyword, sessionId });
  const fxContext = createRunFxContext();

  console.log(`=======================================================`);
  console.log(`[UserJourneyRunner] STARTING JOURNEY SESSION: ${sessionId}`);
  console.log(`Platform: ${normPlatform} | Keyword: '${keyword}' | ZIP: ${zipCode}`);
  console.log(`=======================================================`);

  // §5: Create a Run record ONLY if the caller didn't already hand us one.
  // The production Scheduler path (server.js's user_journey executor) always
  // passes its own Scheduler-owned runId — this runner must reuse it, never
  // create a second nested Run. Only standalone CLI usage (no runId supplied)
  // creates its own Run here.
  let activeRunId = runId;
  let isInternalRun = false;
  if (!activeRunId) {
    const runObj = db.createRun({ platform: normPlatform, query: keyword, maxItems: maxProducts });
    activeRunId = runObj.id;
    isInternalRun = true;
    db.updateRun(activeRunId, { status: 'running', activeBackend: 'user-journey-bot' });
  }

  let stealthSession = null;
  let onAbort = null;
  try {
    if (signal?.aborted) throw new Error('MANAGED_EXECUTION_TIMEOUT: aborted before browser launch');

    // J1: Initialize Browser Session
    // Production Etsy runs use CloakBrowser persistent context.
    // If a custom launchStealthFn / launchCloakBrowserFn was injected (e.g. in tests), respect the injection.
    if (launchCloakBrowserFn) {
      stealthSession = await launchCloakBrowserFn({ platform: normPlatform, proxy, executionToken, signal });
    } else if (['etsy', 'ebay'].includes(normPlatform) && launchStealthFn === launchStealth) {
      stealthSession = await createCloakBrowserSession({
        platform: normPlatform,
        proxy,
        executionToken,
        signal
      });
    } else {
      stealthSession = await launchStealthFn({ proxyUrl: proxy, headless: true });
    }
    const { page } = stealthSession;

    // §6: this execution OWNS the browser/page/context it just launched (it
    // never attaches to a shared CDP session) — on abort, close exactly that,
    // never anything belonging to another execution.
    if (signal) {
      onAbort = () => { stealthSession?.close?.().catch(() => {}); };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const handler = new HandlerClass(page, store);

    // J1: Navigate to homepage
    const startUrl = PLATFORM_URLS[normPlatform] || `https://www.${normPlatform}.com`;
    console.log(`[UserJourneyRunner] J1: Navigating to ${startUrl}...`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    // Check CAPTCHA / Bot Security Challenge
    const htmlStart = await page.content();
    const hasCaptchaIframe = typeof page.locator === 'function'
      ? (await page.locator('iframe[title*="DataDome"], iframe[src*="captcha"]').count().catch(() => 0) > 0)
      : false;
    const hasSearchBox = typeof page.locator === 'function'
      ? (await page.locator('input[id*="search-query"], input[name="q"], input[id="gh-ac"], #twotabsearchtextbox').first().isVisible().catch(() => false))
      : false;
    let isBlocked = hasCaptchaIframe || (/captcha|verify you are human|pardon our interruption|unusual traffic|datadome captcha/i.test(htmlStart) && !hasSearchBox);
    
    if (isBlocked) {
      console.warn(`[UserJourneyRunner] Direct homepage hit blocked on ${normPlatform}. Activating resilient discovery fallback...`);
      store.saveHtmlCheckpoint('CAPTCHA_DETECTED', htmlStart);

      // Multi-tier Fallback Engine
      const { scrape: etsyScrape } = require('../scrapers/etsy');
      // etsy.js's scrape() returns {items, source, isLive}, not a bare array —
      // this branch had been silently treating the whole object as the items
      // list (fallbackItems.length was always undefined, so this loop never
      // actually ran), collecting 0 products from every CAPTCHA fallback.
      const fallbackResult = await etsyScrape(keyword, { maxItems: maxProducts });
      const fallbackItems = Array.isArray(fallbackResult) ? fallbackResult : (fallbackResult?.items || []);

      if (!fallbackItems || fallbackItems.length === 0) {
        throw new Error('EMPTY_RESULT: No products found for keyword');
      }

      store.saveHtmlCheckpoint('search_results_fallback', JSON.stringify(fallbackItems, null, 2));
      
      // FIX: The fallback scraper returns fully-structured data (price, currency,
      // image, author, etc.). Build product records directly — no browser needed,
      // pure compute + optional FX API call, safe for high concurrency.
      const { normalizeCurrencyCode } = require('../currency');
      const fallbackPool = new InternalTaskPool({
        concurrency: Math.min(8, fallbackItems.length), // no browser, high concurrency safe
        signal,
        onTaskError: (idx, err) => {
          console.warn(`[UserJourneyRunner] Fallback product #${idx + 1} error:`, err.message);
        }
      });

      await fallbackPool.run(fallbackItems, async (item) => {
        assertOwner('PRE_CHECKPOINT_PERSIST');

        const rawPrice = typeof item.price === 'number' ? item.price : parseFloat(item.price) || 0;
        const rawCurrency = item.currency || 'USD';
        const normCurrency = normalizeCurrencyCode(rawCurrency);

        // FX conversion for non-USD scraped prices
        let converted = {
          price: rawPrice,
          currency: normCurrency || 'USD',
          source_price: rawPrice,
          source_currency: normCurrency || 'USD',
          fx_rate: 1.0,
          fx_at: new Date().toISOString()
        };
        if (normCurrency && normCurrency !== 'USD' && rawPrice > 0) {
          try {
            const res = fxContext.convertToUsd(rawPrice, rawCurrency);
            if (res && typeof res.then === 'function') {
              converted = await res;
            } else {
              converted = res;
            }
          } catch (fxErr) {
            converted.fx_error = fxErr.message;
          }
        }

        const productRecord = {
          platform: normPlatform,
          title: item.title || keyword,
          url: item.url || startUrl,
          image: item.image || '',
          author: item.author || 'Seller',
          price: converted.price,
          currency: converted.currency,
          source_price: converted.source_price,
          source_currency: converted.source_currency,
          fx_rate: converted.fx_rate,
          fx_at: converted.fx_at,
          ...(converted.fx_error ? { fx_error: converted.fx_error } : {}),
          rating: typeof item.rating === 'number' ? item.rating : parseFloat(item.rating) || 0,
          reviews: parseInt(item.reviews || item.reviewCount || 0, 10) || 0,
          soldCount: parseInt(item.soldCount || item.sold_count || 0, 10) || 0,
          likes: parseInt(item.likes || 0, 10) || 0,
          comments: parseInt(item.comments || 0, 10) || 0,
          shares: parseInt(item.shares || 0, 10) || 0,
          views: parseInt(item.views || 0, 10) || 0,
          status: 'new'
        };
        store.savedProducts.push(productRecord);
      });

      // UI-BUG-10: one batched write with the FULL accumulated list, not one
      // overwrite per item — see checkpoint-store.js's processAndSaveProductDetail.
      if (store.savedProducts.length > 0) {
        assertOwner('PRE_CHECKPOINT_PERSIST'); // §7/§8: immediately before the business write
        db.insertSnapshots(activeRunId, normPlatform, keyword, store.savedProducts);
      }

      const summary = store.saveSummary('COMPLETED');
      if (isInternalRun) {
        db.updateRun(activeRunId, {
          status: 'done',
          items_count: summary.productsCollectedCount,
          new_count: summary.productsCollectedCount,
          active_count: summary.productsCollectedCount
        });
      }

      console.log(`[UserJourneyRunner] RESILIENT JOURNEY SESSION COMPLETE! Collected ${summary.productsCollectedCount} products via fallback.`);
      return summary;
    }

    store.saveHtmlCheckpoint('J1_homepage_loaded', htmlStart);

    // J2: Setup Location / ZIP
    await handler.setupLocation(zipCode);

    // J3: Perform Search
    await handler.performSearch(keyword);

    // J4: Apply Filters
    await handler.applyFilters(filters);

    // J5: Extract Listing Product URLs
    const productUrls = await handler.extractListingUrls(maxProducts);

    // J6-J7: Open Detail Pages, Interact Variations & Capture HTML
    // Each product opens its own page (handler.interactProductDetail uses
    // context.newPage()), so they are independent and safe to parallelize.
    //
    // AD3 fix: concurrency used to be computed from a raw os.freemem()/
    // os.totalmem() snapshot — a view of RAM completely disconnected from the
    // Scheduler's own global ResourceMonitor, so two concurrent User Journey
    // Runs would each see the SAME stale "free RAM" number and could each
    // independently decide to open several more pages, oversubscribing real
    // memory with neither Run aware of the other's consumption.
    //
    // Now uses the SAME global singleton the Scheduler itself uses for
    // admission (getScheduler().monitor) — the identical pattern already
    // verified for Google Shopping's image enrichment. runBaseCostMB is 0
    // here, NOT this Run's browser envelope: the Scheduler already called
    // monitor.reserve(executionToken, plan.estimatedEnvelopeMB) for THIS
    // Run's own base browser cost before dispatching to this function (see
    // scheduler.js tick()/dispatchRun ordering) — that reservation is
    // already subtracted into effectiveHeadroomMB below. Passing a non-zero
    // runBaseCostMB here would subtract the same base cost a second time.
    const { getScheduler } = require('../scheduler/scheduler');
    const monitor = getScheduler().monitor;
    const { effectiveHeadroomMB } = monitor.getSnapshot();
    const { concurrency: internalConcurrency, taskCostMB } = computeInternalConcurrency({
      executionClass: 'BROWSER',
      runBaseCostMB: 0, // this Run's own base browser cost is already reserved
      // globally under `executionToken` by the Scheduler — do not subtract twice.
      effectiveHeadroomMB
    });
    console.log(`[UserJourneyRunner] J6-J7: Processing ${productUrls.length} products with concurrency=${internalConcurrency} (global RAM headroom: ${effectiveHeadroomMB}MB)`);

    const taskPool = new InternalTaskPool({
      concurrency: internalConcurrency,
      signal,
      onTaskError: (idx, err) => {
        console.warn(`[UserJourneyRunner] Error on product #${idx + 1} (${productUrls[idx]}):`, err.message);
      }
    });

    // Reservation key is scoped to THIS execution attempt (executionToken),
    // distinct from the Scheduler's own base-envelope key for the same
    // token — `:journey-internal` suffix makes it a separate Map entry so it
    // is purely ADDITIVE to the global reserved total, never overwrites the
    // Run's base reservation. Released in finally regardless of
    // success/task-error/abort/throw — never double-released (this function
    // only ever calls monitor.release() here, exactly once per call).
    const internalReservationKey = `${executionToken || 'journey-standalone-' + activeRunId}:journey-internal`;
    monitor.reserve(internalReservationKey, internalConcurrency * taskCostMB);
    try {
      await taskPool.run(productUrls, async (url, i) => {
        assertOwner('PRE_CHECKPOINT_PERSIST');
        const detailHtml = await handler.interactProductDetail(url, i);
        if (detailHtml) {
          await store.processAndSaveProductDetail(url, detailHtml, fxContext);
        }
      });
    } finally {
      monitor.release(internalReservationKey);
    }

    // UI-BUG-10: one batched write with the FULL accumulated list, not one
    // overwrite per item — see checkpoint-store.js's processAndSaveProductDetail.
    if (store.savedProducts.length > 0) {
      assertOwner('PRE_CHECKPOINT_PERSIST'); // §7/§8: immediately before the business write
      db.insertSnapshots(activeRunId, normPlatform, keyword, store.savedProducts);
    }

    const summary = store.saveSummary('COMPLETED');
    if (isInternalRun) {
      db.updateRun(activeRunId, {
        status: 'done',
        items_count: summary.productsCollectedCount,
        new_count: summary.productsCollectedCount,
        active_count: summary.productsCollectedCount
      });
    }

    console.log(`[UserJourneyRunner] JOURNEY SESSION COMPLETE! Collected ${summary.productsCollectedCount} products.`);
    return summary;

  } catch (err) {
    // A revoked lease is not a normal journey failure to record as a summary
    // and swallow — it must propagate so ManagedExecution's own handling
    // (which never touches the Run once it knows it's no longer the owner)
    // takes over, and so this stale attempt makes no further writes at all.
    if (/STALE_EXECUTION/.test(err.message || '')) throw err;

    console.error(`[UserJourneyRunner] JOURNEY SESSION FAILED:`, err.message);
    const summary = store.saveSummary('FAILED');
    summary.errorMessage = err.message;
    if (isInternalRun) {
      db.updateRun(activeRunId, { status: 'failed', errorMessage: err.message });
    }
    return summary;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    if (stealthSession && typeof stealthSession.close === 'function') {
      await stealthSession.close().catch(() => {});
    }
  }
}

module.exports = { runUserJourney };
