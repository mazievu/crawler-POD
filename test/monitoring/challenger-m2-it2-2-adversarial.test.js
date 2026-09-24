/**
 * Challenger 2 Verification Suite - Milestone 2 Iteration 2
 *
 * Adversarial challenge of data integrity, observation deduplication, and late arrivals in src/database/monitoring.js:
 * 1. Replay Attack & Duplicate Ingestion:
 *    - 10x repeated replay with conflicting payloads
 *    - Strict contract: { updated: false, duplicate: true, isLateArrival: false }
 *    - Zero increment to observation_count, zero modification to product_current
 *    - Exactly 1 packed entry in daily_packed_history
 * 2. Cross-Date Deduplication & Substring False Positive Resistance:
 *    - Midnight clock boundary shifts (23:59:55 -> 00:00:05)
 *    - Multi-day historical deduplication
 *    - Prefix, suffix, and interior substring clash resistance:
 *      (e.g. 'monitoring:job-1:cap-1' vs 'monitoring:job-1:cap-10', 'monitoring:job-1:cap', 'job-1:cap-1')
 * 3. Late Arrival Ingestion:
 *    - Out-of-order observation with observedAt < last_crawled_at
 *    - Appends to daily_packed_history with full 11-key metadata and runId: null
 *    - Must NOT update product_current metrics or timestamps
 *    - Contract: { updated: false, duplicate: false, isLateArrival: true }
 * 4. Field Presence Preservation:
 *    - Granular partial updates (reviews-only, comments-only, likes-only)
 *    - Zero non-coercion (explicit 0 preserved; null, undefined, empty string ignored)
 *    - Complete preservation of author, canonical url, image, video_url, shop_url
 *    - Absolute status immutability ('dropped', 'new', 'active' decoupled from monitoring)
 * 5. Defensive Invariant Verification:
 *    - null metadata / options across all dual-API signatures
 *    - Return type verified as resolved Object (not uninvoked Function)
 *
 * Authoritative SSOT: docs/DISCOVERY_MONITORING_PLAN_REVISED.md §5
 * Project Roadmap: .agents/orchestrator_1/PROJECT.md (Features F6, F7, F8, F9, F10)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { fromDriver } = require('../../src/database/pg-client');
const { createMonitoringOps, applyMonitoringObservation } = require('../../src/database/monitoring');
const { unpackObservations, packObservations } = require('../../src/database/daily-history');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'pg-schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

/**
 * Creates an isolated in-memory PGlite database populated with the official pg-schema.sql.
 */
async function createIsolatedTestDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const driver = new PGlite();
  const db = fromDriver(driver);
  await db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Helper to seed a product_current item with initial metrics.
 */
async function seedProduct(db, itemUid, overrides = {}) {
  await db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, image, video_url, author, shop_url,
      current_price, current_sold, current_likes, current_views,
      current_comments, current_shares, current_saves, current_rating, current_reviews,
      prev_price, prev_sold, prev_likes, prev_views,
      prev_comments, prev_shares, prev_saves, prev_rating, prev_reviews,
      delta_price, delta_sold, delta_likes, delta_views,
      delta_comments, delta_shares, delta_rating, delta_reviews,
      return_position, sold_30d, gmv,
      status, first_seen_at, last_seen_at, last_crawled_at, observation_count
    ) VALUES (
      @item_uid, @platform, @query, @title, @url, @image, @video_url, @author, @shop_url,
      @current_price, @current_sold, @current_likes, @current_views,
      @current_comments, @current_shares, @current_saves, @current_rating, @current_reviews,
      @prev_price, @prev_sold, @prev_likes, @prev_views,
      @prev_comments, @prev_shares, @prev_saves, @prev_rating, @prev_reviews,
      @delta_price, @delta_sold, @delta_likes, @delta_views,
      @delta_comments, @delta_shares, @delta_rating, @delta_reviews,
      @return_position, @sold_30d, @gmv,
      @status, @first_seen_at, @last_seen_at, @last_crawled_at, @observation_count
    )
    ON CONFLICT (item_uid) DO NOTHING;
  `).run({
    item_uid: itemUid,
    platform: overrides.platform || 'etsy',
    query: overrides.query || 'handmade ceramics',
    title: overrides.title || 'Artisan Ceramic Vessel',
    url: overrides.url || `https://www.etsy.com/listing/${encodeURIComponent(itemUid)}`,
    image: overrides.image || 'https://img.etsy.com/listing-vessel.jpg',
    video_url: overrides.video_url || 'https://vid.etsy.com/vessel-spin.mp4',
    author: overrides.author || 'ArtisanPotteryCo',
    shop_url: overrides.shop_url || 'https://www.etsy.com/shop/ArtisanPotteryCo',
    current_price: overrides.current_price ?? 45.00,
    current_sold: overrides.current_sold ?? 150,
    current_likes: overrides.current_likes ?? 80,
    current_views: overrides.current_views ?? 1200,
    current_comments: overrides.current_comments ?? 25,
    current_shares: overrides.current_shares ?? 15,
    current_saves: overrides.current_saves ?? 40,
    current_rating: overrides.current_rating ?? 4.92,
    current_reviews: overrides.current_reviews ?? 30,
    prev_price: overrides.prev_price ?? null,
    prev_sold: overrides.prev_sold ?? null,
    prev_likes: overrides.prev_likes ?? null,
    prev_views: overrides.prev_views ?? null,
    prev_comments: overrides.prev_comments ?? null,
    prev_shares: overrides.prev_shares ?? null,
    prev_saves: overrides.prev_saves ?? null,
    prev_rating: overrides.prev_rating ?? null,
    prev_reviews: overrides.prev_reviews ?? null,
    delta_price: overrides.delta_price ?? 0,
    delta_sold: overrides.delta_sold ?? 0,
    delta_likes: overrides.delta_likes ?? 0,
    delta_views: overrides.delta_views ?? 0,
    delta_comments: overrides.delta_comments ?? 0,
    delta_shares: overrides.delta_shares ?? 0,
    delta_rating: overrides.delta_rating ?? 0,
    delta_reviews: overrides.delta_reviews ?? 0,
    return_position: overrides.return_position ?? 12,
    sold_30d: overrides.sold_30d ?? 85,
    gmv: overrides.gmv ?? 3825.0,
    status: overrides.status || 'active',
    first_seen_at: overrides.first_seen_at || '2026-09-01 10:00:00',
    last_seen_at: overrides.last_seen_at || '2026-09-18 12:00:00',
    last_crawled_at: overrides.last_crawled_at || '2026-09-18 12:00:00',
    observation_count: overrides.observation_count ?? 5,
  });
}

// ============================================================================
// SUITE 1: REPLAY ATTACK & DUPLICATE INGESTION
// ============================================================================

test('Challenge 1.1: 10x Replay Attack with hostile payload modifications is strictly rejected', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:replay-attack-10x';
  await seedProduct(db, itemUid, { observation_count: 5, current_price: 45.00 });

  const stableObsId = 'monitoring:job-replay-001:cap-999';
  const obsTime = '2026-09-22T10:00:00Z';

  // 1. First initial legitimate write
  const r1 = await ops.applyMonitoringObservation(itemUid, {
    price: 50.00,
    likes: 85,
    sold: 155,
    observationId: stableObsId,
    observedAt: obsTime,
  });

  assert.equal(r1.updated, true, 'First attempt must succeed with updated: true');
  assert.equal(r1.duplicate, false, 'First attempt must not be duplicate');
  assert.equal(r1.isLateArrival, false, 'First attempt must not be late arrival');
  assert.equal(r1.observationId, stableObsId);
  assert.equal(r1.itemUid, itemUid);

  // 2. Perform 9 hostile replay attacks with conflicting payloads
  for (let i = 2; i <= 10; i++) {
    const replayRes = await ops.applyMonitoringObservation(itemUid, {
      price: 9999.99 + i, // Attempted price inflation
      likes: 0,           // Attempted zero coercion
      sold: 1,            // Attempted decrement
      status: 'dropped',  // Attempted status tampering
      title: 'Hacked Title',
      observationId: stableObsId,
      observedAt: obsTime,
    });

    assert.equal(replayRes.updated, false, `Replay #${i} must have updated: false`);
    assert.equal(replayRes.duplicate, true, `Replay #${i} must have duplicate: true`);
    assert.equal(replayRes.isLateArrival, false, `Replay #${i} must have isLateArrival: false`);
    assert.equal(replayRes.observationId, stableObsId);
    assert.equal(replayRes.itemUid, itemUid);
  }

  // 3. Verify product_current observation_count was incremented strictly ONCE (from 5 to 6)
  const current = await db.prepare(`
    SELECT current_price, current_likes, current_sold, title, status, observation_count
    FROM product_current WHERE item_uid = ?
  `).get(itemUid);

  assert.equal(Number(current.observation_count), 6, 'observation_count must increment strictly once');
  assert.equal(Number(current.current_price), 50.00, 'current_price must retain initial write, not tampered replay');
  assert.equal(Number(current.current_likes), 85, 'current_likes must retain initial write');
  assert.equal(Number(current.current_sold), 155, 'current_sold must retain initial write');
  assert.equal(current.title, 'Artisan Ceramic Vessel', 'title must retain pre-existing value');
  assert.equal(current.status, 'active', 'status must remain active');

  // 4. Verify daily_packed_history contains exactly 1 observation entry
  const historyRow = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-22');
  assert.ok(historyRow, 'History row must exist');
  assert.equal(Number(historyRow.observation_count), 1, 'History observation_count must be exactly 1');

  const packedObs = unpackObservations(historyRow.observations_json);
  assert.equal(packedObs.length, 1, 'observations_json array must contain exactly 1 entry without duplicate bloating');
  assert.equal(packedObs[0].observationId, stableObsId);
  assert.equal(packedObs[0].price, 50.00);
});

// ============================================================================
// SUITE 2: CROSS-DATE DEDUPLICATION & SUBSTRING FALSE POSITIVE RESISTANCE
// ============================================================================

test('Challenge 2.1: Midnight clock boundary shift (23:59:55 -> 00:00:05) cross-date replay is detected', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:midnight-shift-item';
  await seedProduct(db, itemUid, { observation_count: 2 });

  const boundaryObsId = 'monitoring:job-midnight:cap-001';

  // Day 1 at 23:59:55
  const r1 = await ops.applyMonitoringObservation(itemUid, {
    price: 48.00,
    observationId: boundaryObsId,
    observedAt: '2026-09-21T23:59:55Z',
  });
  assert.equal(r1.updated, true);
  assert.equal(r1.duplicate, false);

  // Day 2 at 00:00:05: Same observation re-delivered across midnight
  const r2 = await ops.applyMonitoringObservation(itemUid, {
    price: 48.00,
    observationId: boundaryObsId,
    observedAt: '2026-09-22T00:00:05Z',
  });

  assert.equal(r2.updated, false, 'Cross-midnight re-delivery must have updated: false');
  assert.equal(r2.duplicate, true, 'Cross-midnight re-delivery must be recognized as duplicate');
  assert.equal(r2.isLateArrival, false);
  assert.equal(r2.observationId, boundaryObsId);

  // Day 2 row must NOT be created in daily_packed_history
  const day2Row = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-22');
  assert.equal(day2Row, undefined, // Statement#get() mirrors better-sqlite3: no row -> undefined
    'No history row must be created on Day 2 for duplicate replay');

  // observation_count remains incremented only by Day 1 (from 2 to 3)
  const current = await db.prepare('SELECT observation_count FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(current.observation_count), 3);
});

test('Challenge 2.2: Cross-date deduplication is strictly immune to substring false positives', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:substring-isolation-test';
  await seedProduct(db, itemUid, { observation_count: 1, current_price: 30.00 });

  // Baseline on Day 1 (2026-09-20)
  const baseObsId = 'monitoring:job-100:cap-1';
  const rBase = await ops.applyMonitoringObservation(itemUid, {
    price: 32.00,
    observationId: baseObsId,
    observedAt: '2026-09-20T12:00:00Z',
  });
  assert.equal(rBase.updated, true);
  assert.equal(rBase.duplicate, false);

  // Test Case A: Suffix extension on Day 2 ('monitoring:job-100:cap-10' contains 'cap-1' as prefix substring)
  const rSuffix = await ops.applyMonitoringObservation(itemUid, {
    price: 34.00,
    observationId: 'monitoring:job-100:cap-10',
    observedAt: '2026-09-21T12:00:00Z',
  });
  assert.equal(rSuffix.duplicate, false, 'Suffix extension must NOT be falsely identified as duplicate');
  assert.equal(rSuffix.updated, true, 'Suffix extension must legitimately update product_current');

  // Test Case B: Prefix substring on Day 3 ('monitoring:job-100:cap' is prefix of Day 1's ID)
  const rPrefix = await ops.applyMonitoringObservation(itemUid, {
    price: 36.00,
    observationId: 'monitoring:job-100:cap',
    observedAt: '2026-09-22T12:00:00Z',
  });
  assert.equal(rPrefix.duplicate, false, 'Prefix substring must NOT be falsely identified as duplicate');
  assert.equal(rPrefix.updated, true, 'Prefix substring must legitimately update product_current');

  // Test Case C: Substring without platform namespace ('job-100:cap-1' without 'monitoring:')
  const rInternal = await ops.applyMonitoringObservation(itemUid, {
    price: 38.00,
    observationId: 'job-100:cap-1',
    observedAt: '2026-09-23T12:00:00Z',
  });
  assert.equal(rInternal.duplicate, false, 'Internal substring without prefix must NOT be flagged duplicate');
  assert.equal(rInternal.updated, true);

  // Test Case D: Exact duplicate of Day 1's baseObsId arriving on Day 4 MUST be detected as duplicate!
  const rRealDup = await ops.applyMonitoringObservation(itemUid, {
    price: 40.00,
    observationId: baseObsId,
    observedAt: '2026-09-24T12:00:00Z',
  });
  assert.equal(rRealDup.duplicate, true, 'Exact duplicate of Day 1 observation across dates MUST be detected');
  assert.equal(rRealDup.updated, false);

  // Verify product_current has price 38.00 (from Test C) and NOT 40.00 (from duplicate Test D)
  const current = await db.prepare('SELECT current_price, observation_count FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(current.current_price), 38.00);
  assert.equal(Number(current.observation_count), 5); // initial 1 + rBase + rSuffix + rPrefix + rInternal
});

test('Challenge 2.3: Cross-date deduplication across multiple historical date rows', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:multi-historical-dates';
  await seedProduct(db, itemUid, { observation_count: 1 });

  // Record observations across 3 consecutive days
  const ids = [
    'monitoring:hist:day-18',
    'monitoring:hist:day-19',
    'monitoring:hist:day-20',
  ];

  await ops.applyMonitoringObservation(itemUid, { price: 21.00, observationId: ids[0], observedAt: '2026-09-18T10:00:00Z' });
  await ops.applyMonitoringObservation(itemUid, { price: 22.00, observationId: ids[1], observedAt: '2026-09-19T10:00:00Z' });
  await ops.applyMonitoringObservation(itemUid, { price: 23.00, observationId: ids[2], observedAt: '2026-09-20T10:00:00Z' });

  // Replaying Day 18 on Day 22
  const rReplay18 = await ops.applyMonitoringObservation(itemUid, {
    price: 99.00,
    observationId: ids[0],
    observedAt: '2026-09-22T10:00:00Z',
  });
  assert.equal(rReplay18.duplicate, true, 'Day 18 ID replayed on Day 22 must be detected as duplicate');
  assert.equal(rReplay18.updated, false);

  // Replaying Day 19 on Day 22
  const rReplay19 = await ops.applyMonitoringObservation(itemUid, {
    price: 99.00,
    observationId: ids[1],
    observedAt: '2026-09-22T11:00:00Z',
  });
  assert.equal(rReplay19.duplicate, true, 'Day 19 ID replayed on Day 22 must be detected as duplicate');
  assert.equal(rReplay19.updated, false);

  // Product current remains at 23.00
  const current = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(current.current_price), 23.00);
});

// ============================================================================
// SUITE 3: LATE ARRIVAL INGESTION & 11-KEY METADATA PARITY
// ============================================================================

test('Challenge 3.1: Late arrival appends to history with full 11-key metadata (runId: null) and shields product_current', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:late-arrival-metadata-test';

  // Seed product with latest crawled date: 2026-09-22 18:00:00 UTC, price: 150.00
  await seedProduct(db, itemUid, {
    current_price: 150.00,
    current_likes: 300,
    current_sold: 450,
    last_crawled_at: '2026-09-22 18:00:00',
    observation_count: 8,
  });

  // Out-of-order observation from 3 days ago (2026-09-19 09:00:00 UTC)
  const lateObsId = 'monitoring:job-late:cap-sept19';
  const lateRes = await ops.applyMonitoringObservation(itemUid, {
    price: 110.00,
    likes: 180,
    sold: 380,
    views: 2200,
    comments: 45,
    shares: 12,
    rating: 4.85,
    reviews: 28,
    observationId: lateObsId,
    observedAt: '2026-09-19T09:00:00Z',
  });

  // 1. Verify return contract
  assert.equal(lateRes.updated, false, 'Late arrival MUST report updated: false');
  assert.equal(lateRes.duplicate, false, 'Late arrival is NOT a duplicate');
  assert.equal(lateRes.isLateArrival, true, 'Late arrival MUST report isLateArrival: true');
  assert.equal(lateRes.observationId, lateObsId);
  assert.equal(lateRes.itemUid, itemUid);

  // 2. Verify product_current is completely shielded from overwrite
  const current = await db.prepare(`
    SELECT current_price, current_likes, current_sold, last_crawled_at, observation_count
    FROM product_current WHERE item_uid = ?
  `).get(itemUid);

  assert.equal(Number(current.current_price), 150.00, 'Latest price must NOT be overwritten by late arrival');
  assert.equal(Number(current.current_likes), 300, 'Latest likes must NOT be overwritten');
  assert.equal(Number(current.current_sold), 450, 'Latest sold must NOT be overwritten');
  assert.equal(current.last_crawled_at, '2026-09-22 18:00:00', 'last_crawled_at must remain newest timestamp');
  assert.equal(Number(current.observation_count), 8, 'observation_count must NOT increment on late arrival');

  // 3. Verify daily_packed_history for the historical date
  const histRow = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-19');
  assert.ok(histRow, 'History row for 2026-09-19 must be created');

  const obsList = unpackObservations(histRow.observations_json);
  assert.equal(obsList.length, 1);
  const entry = obsList[0];

  // 4. Verify all 11 required keys from checkV2Parity contract are present
  const requiredKeys = [
    'observationId', 'runId', 'time', 'price', 'views',
    'likes', 'comments', 'shares', 'sold', 'rating', 'reviews'
  ];
  for (const key of requiredKeys) {
    assert.ok(key in entry, `Key "${key}" must exist in packed observation entry`);
  }

  // 5. Verify runId is strictly null (preserving checkV2Parity contract for monitoring)
  assert.equal(entry.runId, null, 'Monitoring observation must have runId: null');
  assert.equal(entry.observationId, lateObsId);
  assert.equal(entry.time, '09:00:00');
  assert.equal(entry.price, 110.00);
  assert.equal(entry.likes, 180);
  assert.equal(entry.sold, 380);
  assert.equal(entry.views, 2200);
  assert.equal(entry.comments, 45);
  assert.equal(entry.shares, 12);
  assert.equal(entry.rating, 4.85);
  assert.equal(entry.reviews, 28);
});

test('Challenge 3.2: Intra-day late arrival preserves latest_price and daily aggregates in daily_packed_history', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:intraday-late-arrival';

  await seedProduct(db, itemUid, {
    current_price: 200.00,
    last_crawled_at: '2026-09-22 16:00:00',
  });

  // Observation 1: Recorded at 16:00 today
  const r1 = await ops.applyMonitoringObservation(itemUid, {
    price: 200.00,
    likes: 100,
    observationId: 'obs:today:1600',
    observedAt: '2026-09-22T16:00:00Z',
  });
  assert.equal(r1.updated, true);
  assert.equal(r1.isLateArrival, false);

  // Observation 2: Arrives later but captured at 11:00 earlier today (intra-day late arrival)
  const r2 = await ops.applyMonitoringObservation(itemUid, {
    price: 180.00,
    likes: 90,
    observationId: 'obs:today:1100-late',
    observedAt: '2026-09-22T11:00:00Z',
  });
  assert.equal(r2.updated, false, 'Intra-day older observation must report updated: false');
  assert.equal(r2.isLateArrival, true, 'Intra-day older observation must report isLateArrival: true');

  // Verify daily history aggregates for today
  const hist = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-22');
  assert.equal(Number(hist.observation_count), 2);
  assert.equal(Number(hist.min_price), 180.00, 'min_price must reflect the lowest price seen');
  assert.equal(Number(hist.max_price), 200.00, 'max_price must reflect the highest price seen');
  assert.equal(Number(hist.latest_price), 200.00, 'latest_price must remain the true latest price from 16:00, not 11:00');
  assert.equal(Number(hist.latest_likes), 100, 'latest_likes must remain from 16:00');

  // Product current remains 200.00
  const current = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(current.current_price), 200.00);
});

// ============================================================================
// SUITE 4: FIELD PRESENCE PRESERVATION & STATUS IMMUTABILITY
// ============================================================================

test('Challenge 4.1: Partial update of individual metrics preserves all unmeasured fields without zero-coercion', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:field-presence-matrix';

  // Seed baseline with rich initial metrics
  await seedProduct(db, itemUid, {
    current_price: 75.00,
    current_sold: 320,
    current_likes: 140,
    current_views: 2800,
    current_comments: 38,
    current_shares: 22,
    current_saves: 95,
    current_rating: 4.88,
    current_reviews: 44,
    return_position: 8,
    sold_30d: 110,
    gmv: 8250.0,
    author: 'MasterCraftsman',
    title: 'Signature Ceramic Mug',
    url: 'https://www.etsy.com/listing/sig-mug',
    image: 'https://img.etsy.com/sig-mug.jpg',
    video_url: 'https://vid.etsy.com/sig-mug.mp4',
    shop_url: 'https://www.etsy.com/shop/MasterCraftsman',
    status: 'active',
  });

  // Step 1: Partial patch with ONLY reviews
  await ops.applyMonitoringObservation(itemUid, {
    reviews: 50,
    observationId: 'obs:patch:reviews',
    observedAt: '2026-09-22T12:00:00Z',
  });

  let prod = await db.prepare('SELECT * FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(prod.current_reviews), 50, 'current_reviews must be updated to 50');
  assert.equal(Number(prod.prev_reviews), 44, 'prev_reviews must record previous 44');
  assert.equal(Number(prod.delta_reviews), 6, 'delta_reviews must be 50 - 44 = 6');

  // Verify all other metrics are NOT zeroed or nullified
  assert.equal(Number(prod.current_price), 75.00);
  assert.equal(Number(prod.current_sold), 320);
  assert.equal(Number(prod.current_likes), 140);
  assert.equal(Number(prod.current_views), 2800);
  assert.equal(Number(prod.current_comments), 38);
  assert.equal(Number(prod.current_shares), 22);
  assert.equal(Number(prod.current_saves), 95);
  assert.equal(Number(prod.current_rating), 4.88);
  assert.equal(Number(prod.return_position), 8);
  assert.equal(Number(prod.sold_30d), 110);
  assert.equal(Number(prod.gmv), 8250.0);

  // Verify author, media, and urls are untouched
  assert.equal(prod.author, 'MasterCraftsman');
  assert.equal(prod.title, 'Signature Ceramic Mug');
  assert.equal(prod.url, 'https://www.etsy.com/listing/sig-mug');
  assert.equal(prod.image, 'https://img.etsy.com/sig-mug.jpg');
  assert.equal(prod.video_url, 'https://vid.etsy.com/sig-mug.mp4');
  assert.equal(prod.shop_url, 'https://www.etsy.com/shop/MasterCraftsman');

  // Step 2: Partial patch with explicit 0 for likes (e.g. video post reset)
  await ops.applyMonitoringObservation(itemUid, {
    likes: 0,
    observationId: 'obs:patch:likes-zero',
    observedAt: '2026-09-22T13:00:00Z',
  });

  prod = await db.prepare('SELECT current_likes, prev_likes, delta_likes FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(prod.current_likes), 0, 'Explicit 0 must be accepted and written');
  assert.equal(Number(prod.prev_likes), 140, 'prev_likes must record previous 140');
  assert.equal(Number(prod.delta_likes), -140, 'delta_likes must be 0 - 140 = -140');

  // Step 3: Partial patch with missing/null values (null price, empty string title, undefined sold)
  await ops.applyMonitoringObservation(itemUid, {
    price: null,
    title: '',
    sold: undefined,
    comments: 48,
    observationId: 'obs:patch:null-guards',
    observedAt: '2026-09-22T14:00:00Z',
  });

  prod = await db.prepare('SELECT current_price, title, current_sold, current_comments FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(prod.current_price), 75.00, 'null price must NOT overwrite existing price');
  assert.equal(prod.title, 'Signature Ceramic Mug', 'Empty string title must NOT overwrite existing title');
  assert.equal(Number(prod.current_sold), 320, 'undefined sold must NOT overwrite existing sold');
  assert.equal(Number(prod.current_comments), 48, 'Valid comments must update');
});

test('Challenge 4.2: Status decoupling across dropped, active, and new items', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // Test dropped item
  const droppedUid = 'etsy:dropped-decoupled';
  await seedProduct(db, droppedUid, { status: 'dropped', query: 'vintage teapot', first_seen_at: '2026-07-01 00:00:00' });

  await ops.applyMonitoringObservation(droppedUid, {
    price: 60.00,
    observationId: 'obs:drop:01',
    observedAt: '2026-09-22T15:00:00Z',
  });

  const droppedItem = await db.prepare('SELECT status, query, first_seen_at FROM product_current WHERE item_uid = ?').get(droppedUid);
  assert.equal(droppedItem.status, 'dropped', 'Status MUST stay dropped');
  assert.equal(droppedItem.query, 'vintage teapot', 'Query MUST remain untouched');
  assert.equal(droppedItem.first_seen_at, '2026-07-01 00:00:00', 'first_seen_at MUST remain untouched');

  // Test new item
  const newUid = 'etsy:new-decoupled';
  await seedProduct(db, newUid, { status: 'new' });

  await ops.applyMonitoringObservation(newUid, {
    price: 35.00,
    observationId: 'obs:new:01',
    observedAt: '2026-09-22T15:30:00Z',
  });

  const newItem = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(newUid);
  assert.equal(newItem.status, 'new', 'Status MUST stay new');
});

// ============================================================================
// SUITE 5: DEFENSIVE GUARDS & SIGNATURE COMPLIANCE
// ============================================================================

test('Challenge 5.1: applyMonitoringObservation with metadata: null does not throw TypeError', async () => {
  const db = await createIsolatedTestDb();
  const itemUid = 'etsy:null-metadata-guard';
  await seedProduct(db, itemUid);

  // Call signature 1: applyMonitoringObservation(db, { itemUid, patch, metadata: null })
  const res1 = await applyMonitoringObservation(db, {
    itemUid,
    patch: { price: 42.00, observedAt: '2026-09-22T16:00:00Z' },
    metadata: null,
  });

  assert.equal(typeof res1, 'object', 'Result must be an object');
  assert.equal(res1.updated, true);

  // Call signature 2: applyMonitoringObservation(itemUid, payload, null)
  const ops = createMonitoringOps(db);
  const res2 = await ops.applyMonitoringObservation(itemUid, {
    price: 43.00,
    metadata: null,
    observedAt: '2026-09-22T16:30:00Z',
  }, null);

  assert.equal(typeof res2, 'object', 'Result must be an object');
  assert.equal(res2.updated, true);
});

test('Challenge 5.2: applyMonitoringObservation returns directly resolved Object, not an uninvoked Function', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:function-resolution-test';
  await seedProduct(db, itemUid);

  const res = await ops.applyMonitoringObservation(itemUid, {
    price: 55.00,
    observationId: 'obs:res-check:01',
    observedAt: '2026-09-22T17:00:00Z',
  });

  // Critical check for transaction runner invocation
  assert.notEqual(typeof res, 'function', 'applyMonitoringObservation MUST NOT return an uninvoked function!');
  assert.equal(typeof res, 'object', 'applyMonitoringObservation MUST return a resolved object');
  assert.notEqual(res, null, 'Return object must not be null');
  assert.equal(typeof res.updated, 'boolean', 'res.updated must be a boolean');
  assert.equal(typeof res.duplicate, 'boolean', 'res.duplicate must be a boolean');
  assert.equal(typeof res.isLateArrival, 'boolean', 'res.isLateArrival must be a boolean');
  assert.equal(typeof res.observationId, 'string', 'res.observationId must be a string');
  assert.equal(typeof res.itemUid, 'string', 'res.itemUid must be a string');
});
