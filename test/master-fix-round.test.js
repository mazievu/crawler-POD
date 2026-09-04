/**
 * Master Fix Round — regression tests for the 12 confirmed bugs fixed in
 * this round. One test per bug (grouped where a bug has multiple facets),
 * each exercising the REAL production function that was changed — no new
 * test framework, following the same patterns already used in
 * reliability.test.js / scheduler.test.js / db-cutover.test.js.
 *
 * Not covered here (documented, not silently skipped):
 *   - UI-BUG-03 (Cancel Run -> abortExecution): the fix lives inside
 *     server.js's Express route handler. This repo has no HTTP test harness
 *     for server.js routes (adding one would be new test infrastructure,
 *     out of scope for a "no new framework" round) — verified by code
 *     review instead: DELETE /api/runs/:id now calls the same
 *     abortExecution(token, reason) mechanism already covered by
 *     reliability.test.js's StuckDetector/ExecutionControl tests.
 *   - UI-BUG-09 (Jobs History renders error_message) and UI-BUG-05 (cookie
 *     hint text) are pure public/app.js DOM rendering changes; this repo has
 *     no DOM/jsdom test harness. Verified by code review.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/database');

// ============================================================
// UI-BUG-01: Product Detail history must carry title/platform/url/image,
// not "Untitled"/undefined/missing — daily_packed_history observations only
// ever had metric fields; database.js's getProductHistoryWithMetadata()
// now denormalizes product_current's static fields onto every point.
// ============================================================
test('getProductHistoryWithMetadata() returns real title/platform/url/image, not Untitled/undefined (UI-BUG-01)', () => {
  // A unique URL per run avoids colliding with product_current rows left
  // over from earlier test runs against this same persistent DB file — the
  // new/active status itself is a different, already-tested system; this
  // test is only about the title/platform/url/image/author metadata mapping.
  const uniqueUrl = `https://example.com/ui-bug-01-${Date.now()}`;
  const run = db.createRun({ platform: 'shopify', query: 'ui-bug-01-test-' + Date.now(), maxItems: 5 });
  db.insertSnapshots(run.id, 'shopify', run.query, [{
    title: 'Real Product Title', url: uniqueUrl, image: 'https://example.com/p1.jpg',
    author: 'ExampleShop', price: 19.99, rating: 4.5, reviews: 10, soldCount: 3,
    likes: 0, comments: 0, shares: 0, views: 0, status: 'new'
  }]);
  try {
    const afterRun = db.getRunById(run.id);
    const [firstItem] = JSON.parse(afterRun.result_items_json);
    const history = db.getProductHistoryWithMetadata(firstItem.item_uid);
    assert.ok(history.length >= 1, 'must have at least one observation point');
    const point = history[history.length - 1];
    assert.equal(point.title, 'Real Product Title', 'title must not fall back to Untitled');
    assert.equal(point.platform, 'shopify', 'platform must not be undefined');
    assert.equal(point.url, uniqueUrl, 'url must be present');
    assert.equal(point.image, 'https://example.com/p1.jpg');
    assert.equal(point.author, 'ExampleShop');
  } finally {
    db.deleteRun(run.id);
  }
});

// ============================================================
// UI-BUG-02: Shopify (and any multi-backend channel) must report 'ok' when
// its actual active backend (local-scraper, zero-config) is healthy, even if
// a lower-priority paid fallback (Apify) is unverified/misconfigured.
// ============================================================
test('Shopify channel reports ok when local-scraper is the healthy active backend, regardless of Apify fallback state (UI-BUG-02)', async () => {
  const { runDoctor } = require('../src/doctor');
  const report = await runDoctor({ platform: 'shopify' });
  const shopify = report.channels.shopify;
  assert.ok(shopify, 'shopify channel must be present in the doctor report');
  assert.equal(shopify.activeBackend, 'local-scraper', 'local-scraper must be the active backend');
  assert.equal(shopify.status, 'ok', 'channel status must be ok when the active backend is healthy, not dragged down by an unverified paid fallback');
});

// ============================================================
// UI-BUG-04: naive "YYYY-MM-DD HH:MM:SS" UTC timestamps must be converted
// to an explicit, labeled Vietnam-local time for CSV export, not written
// verbatim (which reads ~7h off to anyone opening the file).
// ============================================================
test('formatVietnamTime() converts naive UTC timestamps to explicit Vietnam-local time (UI-BUG-04)', () => {
  // 2026-08-27 03:58:39 UTC + 7h = 2026-08-27 10:58:39 Vietnam-local.
  const formatted = db.formatVietnamTime('2026-08-27 03:58:39');
  assert.match(formatted, /\(Vietnam\)$/, 'output must be explicitly labeled, not ambiguous');
  assert.match(formatted, /10:58:39/, 'must shift by the UTC+7 offset, not echo the raw UTC wall-clock value');
  assert.notEqual(formatted, '2026-08-27 03:58:39', 'must not pass the raw ambiguous string through unchanged');
});

// ============================================================
// UI-BUG-06: interactive marketplace login must not reuse a single shared
// 'public' Chromium profile dir across attempts (ProcessSingleton lock).
// ============================================================
test('resolveEverbeeProfileDir() gives distinct sessionKeys distinct profile dirs (UI-BUG-06)', () => {
  const { resolveEverbeeProfileDir } = require('../src/marketplaces/everbee-executor');
  const dirA = resolveEverbeeProfileDir({ platform: 'etsy', sessionKey: 'abc123' });
  const dirB = resolveEverbeeProfileDir({ platform: 'etsy', sessionKey: 'xyz789' });
  const dirPublic = resolveEverbeeProfileDir({ platform: 'etsy' });
  assert.notEqual(dirA, dirB, 'two different session keys must resolve to two different profile dirs');
  assert.notEqual(dirA, dirPublic, 'a session-keyed dir must not collide with the old shared public dir');
  assert.match(dirA, /session-abc123$/);
});

test('openInteractiveLogin() passes a unique sessionKey to the browser factory on every call (UI-BUG-06)', async () => {
  const { openInteractiveLogin } = require('../src/marketplaces/session-login');
  const capturedOptions = [];
  const fakeBrowserFactory = async (options) => {
    capturedOptions.push(options);
    return {
      context: {
        newPage: async () => ({ goto: async () => {} }),
        storageState: async () => ({ cookies: [] })
      },
      close: async () => {}
    };
  };
  const loginA = await openInteractiveLogin({ platform: 'etsy', browserFactory: fakeBrowserFactory });
  const loginB = await openInteractiveLogin({ platform: 'etsy', browserFactory: fakeBrowserFactory });
  await loginA.cancel();
  await loginB.cancel();

  assert.equal(capturedOptions.length, 2);
  assert.ok(capturedOptions[0].sessionKey, 'first attempt must carry a sessionKey');
  assert.ok(capturedOptions[1].sessionKey, 'second attempt must carry a sessionKey');
  assert.notEqual(capturedOptions[0].sessionKey, capturedOptions[1].sessionKey,
    'two overlapping login attempts must not share the same profile dir (the old shared "public" dir caused a ProcessSingleton lock collision)');
});

// ============================================================
// UI-BUG-07: Amazon HTML parser must extract the real product title/price/
// rating/reviews/image, not Amazon's accessibility-only skip-navigation <h1>.
// ============================================================
test('parseMarketplaceHtml() extracts real Amazon title/price/rating/reviews/image, not the accessibility h1 (UI-BUG-07)', () => {
  const { parseMarketplaceHtml } = require('../src/marketplaces/html-parser');
  const html = `<!DOCTYPE html><html><body>
    <h1 class="a11y-hidden" style="position:absolute;left:-9999px">Amazon.com</h1>
    <span id="productTitle" class="a-size-large">  Real Amazon Product Title  </span>
    <span class="a-price"><span class="a-offscreen">$29.99</span></span>
    <span data-hook="rating-out-of-text">4.5 out of 5 stars</span>
    <span id="acrCustomerReviewText">1,234 ratings</span>
    <img id="landingImage" data-old-hires="https://example.com/real-image.jpg" src="https://example.com/thumb.jpg" />
  </body></html>`;

  const result = parseMarketplaceHtml({ platform: 'amazon', url: 'https://www.amazon.com/dp/B000000001', html });

  assert.equal(result.title, 'Real Amazon Product Title', 'must use #productTitle, not the accessibility-only h1');
  assert.notEqual(result.title, 'Amazon.com', 'must NOT pick up the skip-navigation h1 text');
  assert.equal(result.price, 29.99);
  assert.equal(result.rating, 4.5);
  assert.equal(result.reviewCount, 1234);
  assert.equal(result.image, 'https://example.com/real-image.jpg');
});

// ============================================================
// BUG-08: Instagram Actor input must strip the leading '#' from hashtag
// queries — the actor's `hashtag` search type expects the bare tag.
// ============================================================
test('Instagram Actor input strips leading # from hashtag queries (BUG-08)', () => {
  const { INPUT_BUILDERS } = require('../src/apify-client');
  const input = INPUT_BUILDERS.instagram({ query: '#podfashion', maxItems: 30 });
  assert.equal(input.search, 'podfashion', 'must strip the leading # before sending to the actor');
  assert.equal(input.searchType, 'hashtag');

  const alreadyBare = INPUT_BUILDERS.instagram({ query: 'nopound', maxItems: 30 });
  assert.equal(alreadyBare.search, 'nopound', 'a query without # must pass through unchanged');
});

// ============================================================
// UI-BUG-10: User Journey must accumulate ALL collected products into
// runs.result_items_json, not overwrite it down to just the last one.
// ============================================================
test('User Journey accumulates ALL products into result_items_json, not just the last one (UI-BUG-10)', async () => {
  const etsyScraperModule = require('../src/scrapers/etsy');
  const originalScrape = etsyScraperModule.scrape;
  const originalInsertSnapshots = db.insertSnapshots;
  const insertSnapshotsCalls = [];

  etsyScraperModule.scrape = async () => ({
    items: [
      { url: 'https://www.etsy.com/listing/1', title: 'Item One', price: 9.99, author: 'seller1' },
      { url: 'https://www.etsy.com/listing/2', title: 'Item Two', price: 19.99, author: 'seller2' },
      { url: 'https://www.etsy.com/listing/3', title: 'Item Three', price: 29.99, author: 'seller3' }
    ],
    source: 'test', isLive: false
  });
  db.insertSnapshots = (...args) => { insertSnapshotsCalls.push(args); return originalInsertSnapshots.apply(db, args); };

  const { runUserJourney } = require('../src/journey/user-journey-runner');
  const outerRun = db.createRun({ platform: 'etsy', query: 'ui-bug-10-test-' + Date.now(), maxItems: 3 });

  try {
    const fakePage = {
      goto: async () => {},
      waitForTimeout: async () => {},
      content: async () => '<html>please verify you are human (captcha)</html>' // forces the CAPTCHA fallback branch
    };
    const fakeSession = { page: fakePage, close: async () => {} };

    const summary = await runUserJourney({
      platform: 'etsy', keyword: 'ui-bug-10-test', maxProducts: 3,
      runId: outerRun.id,
      launchStealthFn: async () => fakeSession
    });

    assert.equal(summary.productsCollectedCount, 3, 'all 3 fallback items must be counted as collected');
    assert.equal(insertSnapshotsCalls.length, 1, 'exactly ONE batched insertSnapshots call, not one per item (the root cause of the overwrite bug)');
    assert.equal(insertSnapshotsCalls[0][3].length, 3, 'the single insertSnapshots call must carry the FULL batch of 3 items');

    const afterRun = db.getRunById(outerRun.id);
    const resultItems = JSON.parse(afterRun.result_items_json || '[]');
    assert.equal(resultItems.length, 3, 'result_items_json must contain ALL 3 products, not just the last one');
    const titles = resultItems.map((i) => i.title).sort();
    assert.deepEqual(titles, ['Item One', 'Item Three', 'Item Two']);
  } finally {
    etsyScraperModule.scrape = originalScrape;
    db.insertSnapshots = originalInsertSnapshots;
    db.deleteRun(outerRun.id);
  }
});

// ============================================================
// BUG-11: Amazon listing extraction must dedupe by ASIN (canonical product
// identity), not by raw URL string — the same product commonly appears
// multiple times with different SEO slug text ahead of the same /dp/<ASIN>.
// ============================================================
test('AmazonJourneyHandler.extractListingUrls() dedupes by ASIN, not raw URL (BUG-11)', async () => {
  const { AmazonJourneyHandler } = require('../src/journey/amazon-journey');
  const fakePage = {
    evaluate: async () => {},
    waitForTimeout: async () => {},
    $$eval: async (_selector, fn) => fn([
      { href: 'https://www.amazon.com/Product-Name-A/dp/B000000001/ref=sr_1_1' },
      { href: 'https://www.amazon.com/Different-Slug-Same-Product/dp/B000000001/ref=sr_1_2' }, // same ASIN, different slug
      { href: 'https://www.amazon.com/Product-B/dp/B000000002/ref=sr_1_3' }
    ])
  };
  const handler = new AmazonJourneyHandler(fakePage, {});
  const urls = await handler.extractListingUrls(10);
  assert.equal(urls.length, 2, 'must dedupe to 2 unique ASINs, not 3 unique raw URLs');
});

// ============================================================
// BUG-12: enabled Social Bots must target the 3-hour (180min) cadence.
// ============================================================
test('all enabled Social Bots default to 180-minute (3h) cadence (BUG-12)', () => {
  const { DEFAULT_BOT_CONFIGS } = require('../src/social-bots/bot-config');
  for (const [key, bot] of Object.entries(DEFAULT_BOT_CONFIGS)) {
    if (!bot.enabled) continue;
    assert.equal(bot.intervalMinutes, 180, `enabled bot '${key}' must target 180-minute cadence, got ${bot.intervalMinutes}`);
  }
});
