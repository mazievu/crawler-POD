/**
 * Amazon User Journey — targeted fix regression tests (BUG-AMZ-01, BUG-AMZ-02).
 *
 * Test A: real saved Amazon checkpoints from Run #1966 (no new crawl).
 * Test B: attribute-order independence + data-a-dynamic-image handling.
 * Test C: ASIN canonical identity across differently-shaped URLs.
 * Test D: no history/product_current split when the same ASIN is scraped
 *         from two different raw URLs across two separate runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const db = require('../src/database');
const { parseMarketplaceHtml } = require('../src/marketplaces/html-parser');
const { CheckpointStore } = require('../src/journey/checkpoint-store');

const CHECKPOINT_DIR = path.join(__dirname, '..', 'data', 'captures', 'journey_amazon_1787797844022');

// ============================================================
// Test A — real saved Amazon checkpoints (Run #1966), no new crawl.
// ============================================================
// The checkpoints live under data/, which .gitignore excludes, so a clean
// checkout — CI included — simply does not have them. Failing there reported a
// missing fixture as a broken parser and turned the whole suite red. It is
// SKIPPED with a reason instead of silently passing, so the TAP output says the
// coverage was not exercised rather than pretending it was.
const CHECKPOINT_FILES = [1, 2, 3].map((n) => path.join(CHECKPOINT_DIR, `product_${n}_detail.html`));
const MISSING_CHECKPOINTS = CHECKPOINT_FILES.filter((file) => !fs.existsSync(file));

test('Test A: real Amazon checkpoints (product_1..3_detail.html) yield title/price/rating/reviews/image all present', {
  skip: MISSING_CHECKPOINTS.length > 0
    ? `Run #1966 checkpoints not present (${MISSING_CHECKPOINTS.length}/3 missing under data/captures/, which is gitignored). Run the Amazon journey locally to regenerate them.`
    : false,
}, () => {
  for (const n of [1, 2, 3]) {
    const file = path.join(CHECKPOINT_DIR, `product_${n}_detail.html`);
    const html = fs.readFileSync(file, 'utf8');
    const result = parseMarketplaceHtml({ platform: 'amazon', url: 'https://www.amazon.com/dp/TESTASIN0' + n, html });

    assert.ok(result.title && result.title.length > 0, `product_${n}: title must be non-empty`);
    assert.ok(result.price > 0, `product_${n}: price must be > 0, got ${result.price}`);
    assert.ok(result.rating > 0, `product_${n}: rating must be > 0, got ${result.rating}`);
    assert.ok(result.reviewCount > 0, `product_${n}: reviews must be > 0, got ${result.reviewCount}`);
    assert.notEqual(result.image, '', `product_${n}: image must not be empty (BUG-AMZ-01)`);
    assert.match(result.image, /^https:\/\/m\.media-amazon\.com\//, `product_${n}: image must be a real m.media-amazon.com URL, got "${result.image}"`);
  }
});

// ============================================================
// Test B — attribute-order independence + data-a-dynamic-image handling.
// ============================================================
test('Test B: landingImage extraction works regardless of attribute order, and handles data-a-dynamic-image', () => {
  // data-old-hires present but NOT last in the tag, and src also present —
  // data-old-hires must still win regardless of position/priority-by-order.
  const htmlOldHiresFirst = `<html><body>
    <span id="productTitle">Product B1</span>
    <img data-old-hires="https://m.media-amazon.com/images/I/HIRES.jpg" id="landingImage" src="https://m.media-amazon.com/images/I/THUMB.jpg" />
  </body></html>`;
  const resultA = parseMarketplaceHtml({ platform: 'amazon', url: 'https://www.amazon.com/dp/B0TESTAAAA', html: htmlOldHiresFirst });
  assert.equal(resultA.image, 'https://m.media-amazon.com/images/I/HIRES.jpg');

  // Only data-a-dynamic-image present (no data-old-hires) — must pick the
  // LARGEST resolution URL from the JSON map, id appearing before the attribute.
  const htmlDynamicImage = `<html><body>
    <span id="productTitle">Product B2</span>
    <img id="landingImage" data-a-dynamic-image="{&quot;https://m.media-amazon.com/images/I/SMALL.jpg&quot;:[300,300],&quot;https://m.media-amazon.com/images/I/BIG.jpg&quot;:[679,679]}" src="https://m.media-amazon.com/images/I/THUMB.jpg" />
  </body></html>`;
  const resultB = parseMarketplaceHtml({ platform: 'amazon', url: 'https://www.amazon.com/dp/B0TESTBBBB', html: htmlDynamicImage });
  assert.equal(resultB.image, 'https://m.media-amazon.com/images/I/BIG.jpg', 'must pick the largest-resolution URL, not just any key');

  // Malformed data-a-dynamic-image JSON must not crash the parser — must
  // fall through to src instead.
  const htmlMalformed = `<html><body>
    <span id="productTitle">Product B3</span>
    <img id="landingImage" data-a-dynamic-image="{not valid json" src="https://m.media-amazon.com/images/I/FALLBACK.jpg" />
  </body></html>`;
  assert.doesNotThrow(() => parseMarketplaceHtml({ platform: 'amazon', url: 'https://www.amazon.com/dp/B0TESTCCCC', html: htmlMalformed }));
  const resultC = parseMarketplaceHtml({ platform: 'amazon', url: 'https://www.amazon.com/dp/B0TESTCCCC', html: htmlMalformed });
  assert.equal(resultC.image, 'https://m.media-amazon.com/images/I/FALLBACK.jpg', 'malformed JSON must fall through to src, not crash or return empty');
});

// ============================================================
// Test C — ASIN canonical identity across differently-shaped URLs.
// ============================================================
test('Test C: three differently-shaped URLs for the same ASIN produce the same canonical product_uid', () => {
  const asin = 'B0FNWTNXM3';
  const urls = [
    `https://www.amazon.com/dp/${asin}`,
    `https://www.amazon.com/LPOODDNU-Pink-Press-Nails-Almond/dp/${asin}/ref=sr_1_5`,
    `https://www.amazon.com/gp/product/${asin}?tag=trackingtag-20&linkCode=xyz`
  ];
  const html = `<html><body><span id="productTitle">LPOODDNU Press on Nails</span><span class="a-price"><span class="a-offscreen">$6.99</span></span></body></html>`;

  const store = new CheckpointStore({ platform: 'amazon', keyword: 'test-c-' + Date.now() });
  const records = urls.map((u) => store.processAndSaveProductDetail(u, html));

  for (const r of records) assert.ok(r, 'each call must successfully produce a productRecord');
  const canonicalUrls = new Set(records.map((r) => r.url));
  assert.equal(canonicalUrls.size, 1, `all 3 raw URLs must canonicalize to the SAME url, got: ${JSON.stringify([...canonicalUrls])}`);
  assert.equal([...canonicalUrls][0], `https://www.amazon.com/dp/${asin}`, 'canonical form must be the project\'s existing amazon:<url> scheme, i.e. the clean /dp/<ASIN> URL');
});

// ============================================================
// Test D — same ASIN scraped via two different raw URLs across two
// separate runs must NOT split into two product_current rows or two
// separate history identities.
// ============================================================
test('Test D: same ASIN via different raw URLs does not split product_current or history', async () => {
  // Real ASINs are always exactly 10 alphanumeric chars — listingIdFromUrl's
  // regex (correctly) only captures 10, so a longer fake ASIN in a test
  // fixture gets silently truncated. Keep this exactly 10 chars.
  const asin = 'B0' + Date.now().toString(36).slice(-8).toUpperCase();
  const htmlV1 = `<html><body><span id="productTitle">Canonical Identity Test Product</span><span class="a-price"><span class="a-offscreen">$9.99</span></span></body></html>`;
  const htmlV2 = `<html><body><span id="productTitle">Canonical Identity Test Product</span><span class="a-price"><span class="a-offscreen">$11.99</span></span></body></html>`;

  const store1 = new CheckpointStore({ platform: 'amazon', keyword: 'test-d-run1' });
  const recordV1 = store1.processAndSaveProductDetail(`https://www.amazon.com/dp/${asin}`, htmlV1);

  const store2 = new CheckpointStore({ platform: 'amazon', keyword: 'test-d-run2' });
  const recordV2 = store2.processAndSaveProductDetail(`https://www.amazon.com/some-different-slug/dp/${asin}/ref=sr_1_9`, htmlV2);

  assert.equal(recordV1.url, recordV2.url, 'both raw URLs must canonicalize to the same url before persistence');

  const query = 'test-d-' + Date.now();
  const run1 = await db.createRun({ platform: 'amazon', query, maxItems: 1 });
  await db.insertSnapshots(run1.id, 'amazon', query, [recordV1]);
  const run2 = await db.createRun({ platform: 'amazon', query, maxItems: 1 });
  await db.insertSnapshots(run2.id, 'amazon', query, [recordV2]);

  try {
    const itemUid = `amazon:https://www.amazon.com/dp/${asin}`;
    // getProductCurrentByUid() is the precise single-row lookup — filtering
    // getProductCurrent({platform:'amazon'}) would be wrong here since that
    // list is capped (default LIMIT 100, ranked), and this synthetic test
    // item's rank_score has no reason to land in the top 100 alongside real
    // production data already in this DB.
    const current = await db.getProductCurrentByUid(itemUid);
    assert.ok(current, 'product_current must have exactly ONE row for this ASIN, not one per raw URL variant (it must exist at all)');
    assert.equal(current.current_price, 11.99, 'the single row must reflect the latest observation (proves run2 updated the SAME row, not a new one)');

    // Directly prove the raw-slug'd URL from run2 did NOT create its own,
    // separate product_current row (the pre-fix split-identity failure mode).
    const rawUrlItemUid = `amazon:https://www.amazon.com/some-different-slug/dp/${asin}/ref=sr_1_9`;
    assert.equal(await db.getProductCurrentByUid(rawUrlItemUid), undefined, 'the raw, non-canonical URL must NOT have its own product_current row');

    const history = await db.getProductHistoryWithMetadata(itemUid);
    assert.equal(history.length, 2, 'history must show 2 observations (one per run), both under the SAME item_uid');
    assert.deepEqual(history.map((h) => h.price).sort((a, b) => a - b), [9.99, 11.99]);
  } finally {
    await db.deleteRun(run1.id);
    await db.deleteRun(run2.id);
  }
});
