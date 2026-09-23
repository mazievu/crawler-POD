/**
 * Challenger 2 Verification Suite (Milestone 2)
 *
 * Empirically challenges deduplication, late arrivals, field presence, and status preservation:
 * 1. Deduplication: Replay exact same observation ID 5 times -> observation_count increments only once,
 *    no duplicate rows in history, and subsequent calls return duplicate: true.
 * 2. Late Arrivals: Out-of-order observation with timestamp 2 days ago -> product_current latest metrics
 *    are NOT rolled back, while the observation is recorded in daily_packed_history for that date.
 * 3. Field Presence: Sparse observations with only likes or only price -> other metrics are NOT zeroed or nullified.
 * 4. Status Decoupling: product_current.status remains untouched when monitoring observations arrive for dropped and active items.
 * 5. Architectural Invariants: Dual API signatures, saves schema safety (no delta_saves), checkV2Parity contract.
 *
 * Authoritative SSOT: docs/DISCOVERY_MONITORING_PLAN_REVISED.md §5
 * Features: F6, F7, F8, F9, F10
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { fromDriver } = require('../../src/database/pg-client');
const { createMonitoringOps, applyMonitoringObservation } = require('../../src/database/monitoring');
const { getAdvisoryLockKeys, acquireItemAdvisoryLock } = require('../../src/database/concurrency');
const { unpackObservations, packObservations, buildObservationId } = require('../../src/database/daily-history');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'pg-schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

/**
 * Creates an isolated PGlite database populated with the official pg-schema.sql.
 */
async function createIsolatedTestDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const driver = new PGlite();
  const db = fromDriver(driver);
  await db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Helper to seed a product_current item with realistic initial metrics.
 */
async function seedProduct(db, itemUid, overrides = {}) {
  await db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, image, video_url,
      current_price, current_sold, current_likes, current_views,
      current_comments, current_shares, current_saves, current_rating, current_reviews,
      status, first_seen_at, last_seen_at, last_crawled_at, observation_count
    ) VALUES (
      @item_uid, @platform, @query, @title, @url, @image, @video_url,
      @current_price, @current_sold, @current_likes, @current_views,
      @current_comments, @current_shares, @current_saves, @current_rating, @current_reviews,
      @status, @first_seen_at, @last_seen_at, @last_crawled_at, @observation_count
    )
    ON CONFLICT (item_uid) DO NOTHING;
  `).run({
    item_uid: itemUid,
    platform: overrides.platform || 'etsy',
    query: overrides.query || 'handmade ceramic mug',
    title: overrides.title || 'Handcrafted Artisan Ceramic Mug',
    url: overrides.url || `https://www.etsy.com/listing/${encodeURIComponent(itemUid)}`,
    image: overrides.image || 'https://img.etsy.com/listing-mug-primary.jpg',
    video_url: overrides.video_url || 'https://vid.etsy.com/listing-mug-showcase.mp4',
    current_price: overrides.current_price ?? 28.50,
    current_sold: overrides.current_sold ?? 120,
    current_likes: overrides.current_likes ?? 65,
    current_views: overrides.current_views ?? 850,
    current_comments: overrides.current_comments ?? 14,
    current_shares: overrides.current_shares ?? 9,
    current_saves: overrides.current_saves ?? 32,
    current_rating: overrides.current_rating ?? 4.85,
    current_reviews: overrides.current_reviews ?? 28,
    status: overrides.status || 'active',
    first_seen_at: overrides.first_seen_at || '2026-09-01 08:00:00',
    last_seen_at: overrides.last_seen_at || '2026-09-15 12:00:00',
    last_crawled_at: overrides.last_crawled_at || '2026-09-15 12:00:00',
    observation_count: overrides.observation_count ?? 1,
  });
}

// ============================================================================
// OBJECTIVE 1: Deduplication (Replay Exact Same Observation ID 5 Times)
// ============================================================================

test('Objective 1.1: Replaying exact same observation ID 5 times increments observation_count only once and marks replays duplicate', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:dedup-replay-001';
  await seedProduct(db, itemUid, { observation_count: 3 });

  const fixedObsId = 'monitoring:job-dedup:cap-fixed-999';
  const obsTimestamp = '2026-09-16T10:00:00Z';

  const results = [];
  for (let i = 0; i < 5; i++) {
    const res = await ops.applyMonitoringObservation(itemUid, {
      price: 35.00,
      likes: 80,
      observationId: fixedObsId,
      observedAt: obsTimestamp,
    });
    results.push(res);
  }

  // Verify return contracts
  assert.equal(results[0].updated, true, 'First attempt must report updated: true');
  assert.equal(results[0].duplicate, false, 'First attempt must report duplicate: false');
  assert.equal(results[0].observationId, fixedObsId);

  for (let i = 1; i < 5; i++) {
    assert.equal(results[i].updated, false, `Replay attempt #${i + 1} must report updated: false`);
    assert.equal(results[i].duplicate, true, `Replay attempt #${i + 1} must report duplicate: true`);
    assert.equal(results[i].observationId, fixedObsId);
  }

  // Verify product_current observation_count incremented strictly once (from 3 to 4)
  const product = await db.prepare('SELECT observation_count, current_price, current_likes FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(product.observation_count), 4, 'observation_count must increment exactly once');
  assert.equal(Number(product.current_price), 35.00);
  assert.equal(Number(product.current_likes), 80);

  // Verify daily_packed_history contains exactly 1 row for this date
  const historyRows = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').all(itemUid, '2026-09-16');
  assert.equal(historyRows.length, 1, 'Exactly one history row must exist for date');

  // Verify observations_json contains exactly 1 observation entry
  const observations = unpackObservations(historyRows[0].observations_json);
  assert.equal(observations.length, 1, 'observations_json array must contain exactly 1 entry (no duplicates)');
  assert.equal(observations[0].observationId, fixedObsId);
  assert.equal(Number(historyRows[0].observation_count), 1);
});

test('Objective 1.2: Replay of duplicate observation with conflicting payload does NOT overwrite current metrics', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:dedup-payload-tamper';
  await seedProduct(db, itemUid, { current_price: 20.00, current_likes: 50 });

  const stableObsId = 'monitoring:job-tamper:cap-001';
  const obsTimestamp = '2026-09-16T11:00:00Z';

  // 1. Initial valid write
  const r1 = await ops.applyMonitoringObservation(itemUid, {
    price: 25.00,
    likes: 60,
    observationId: stableObsId,
    observedAt: obsTimestamp,
  });
  assert.equal(r1.duplicate, false);

  // 2. Adversarial replay with completely different values using the SAME observation ID
  const r2 = await ops.applyMonitoringObservation(itemUid, {
    price: 999.99,
    likes: 0,
    observationId: stableObsId,
    observedAt: obsTimestamp,
  });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.updated, false);

  // Verify metrics are untouched by duplicate payload
  const current = await db.prepare('SELECT current_price, current_likes FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(current.current_price), 25.00, 'Price must retain the original valid observation value');
  assert.equal(Number(current.current_likes), 60, 'Likes must retain the original valid observation value');
});

test('Objective 1.3: Cross-date replay defense (delayed re-delivery on subsequent day is deduplicated)', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:cross-date-dedup';
  await seedProduct(db, itemUid);

  const sharedObsId = 'monitoring:cross-day:cap-777';

  // Day 1
  const r1 = await ops.applyMonitoringObservation(itemUid, {
    price: 30.00,
    observationId: sharedObsId,
    observedAt: '2026-09-16T12:00:00Z',
  });
  assert.equal(r1.duplicate, false);

  // Day 2 replay with same observation ID
  const r2 = await ops.applyMonitoringObservation(itemUid, {
    price: 30.00,
    observationId: sharedObsId,
    observedAt: '2026-09-17T12:00:00Z',
  });
  assert.equal(r2.duplicate, true, 'Cross-date delivery with identical observation ID must be caught as duplicate');
  assert.equal(r2.updated, false);

  // Day 2 row must NOT have been created
  const day2Row = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-17');
  assert.equal(day2Row, null, 'No history row should be created for duplicate cross-date replay');
});

test('Objective 1.4: Special characters, UUIDs, and complex colons in observationId are handled safely', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:special-obs-id';
  await seedProduct(db, itemUid);

  const specialObsId = 'monitoring:job-alpha-123:cap_#456:val="true":unicode_🎉';
  const r1 = await ops.applyMonitoringObservation(itemUid, {
    price: 19.99,
    observationId: specialObsId,
    observedAt: '2026-09-16T14:00:00Z',
  });
  assert.equal(r1.duplicate, false);

  const r2 = await ops.applyMonitoringObservation(itemUid, {
    price: 19.99,
    observationId: specialObsId,
    observedAt: '2026-09-16T14:00:00Z',
  });
  assert.equal(r2.duplicate, true);

  const history = await db.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-16');
  const arr = unpackObservations(history.observations_json);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].observationId, specialObsId);
});

test('Objective 1.5: Concurrent delivery of identical observation ID is safely serialized by advisory lock', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:concurrent-dedup-race';
  await seedProduct(db, itemUid, { observation_count: 5 });

  const concurrentObsId = 'monitoring:race:obs-101';
  const obsTimestamp = '2026-09-16T15:00:00Z';

  // Dispatch 5 parallel calls
  const promises = Array.from({ length: 5 }, () =>
    ops.applyMonitoringObservation(itemUid, {
      price: 45.00,
      likes: 90,
      observationId: concurrentObsId,
      observedAt: obsTimestamp,
    })
  );

  const results = await Promise.all(promises);

  const nonDuplicates = results.filter(r => r.duplicate === false);
  const duplicates = results.filter(r => r.duplicate === true);

  assert.equal(nonDuplicates.length, 1, 'Exactly one concurrent attempt must succeed as non-duplicate');
  assert.equal(duplicates.length, 4, 'Remaining four concurrent attempts must be recognized as duplicate');

  const product = await db.prepare('SELECT observation_count FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(product.observation_count), 6, 'observation_count must increment strictly once under concurrency');
});

// ============================================================================
// OBJECTIVE 2: Late Arrivals (Out-of-Order Observation 2 Days Ago)
// ============================================================================

test('Objective 2.1: Out-of-order observation 2 days ago does NOT roll back product_current while recording in history', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:late-arrival-001';

  // Seed product with latest crawled date: 2026-09-18 12:00:00 UTC, current_price: 100.0, current_likes: 250
  await seedProduct(db, itemUid, {
    current_price: 100.00,
    current_likes: 250,
    current_sold: 500,
    last_crawled_at: '2026-09-18 12:00:00',
    observation_count: 10,
  });

  // Out-of-order observation arrives: 2 days prior (2026-09-16T10:00:00Z) with older price: 65.00 and likes: 180
  const lateObsId = 'monitoring:job-late:cap-2days-ago';
  const lateTimestamp = '2026-09-16T10:00:00Z';

  const res = await ops.applyMonitoringObservation(itemUid, {
    price: 65.00,
    likes: 180,
    sold: 400,
    observationId: lateObsId,
    observedAt: lateTimestamp,
  });

  // Verification 1: Return contract flags late arrival
  assert.equal(res.updated, false, 'product_current must NOT be updated for late arrival');
  assert.equal(res.isLateArrival, true, 'isLateArrival must be true');
  assert.equal(res.duplicate, false, 'Late arrival is not a duplicate');

  // Verification 2: product_current metrics are NOT rolled back
  const product = await db.prepare('SELECT current_price, current_likes, current_sold, last_crawled_at, observation_count FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(product.current_price), 100.00, 'Current price must NOT be rolled back to 65.00');
  assert.equal(Number(product.current_likes), 250, 'Current likes must NOT be rolled back to 180');
  assert.equal(Number(product.current_sold), 500, 'Current sold must NOT be rolled back to 400');
  assert.equal(product.last_crawled_at, '2026-09-18 12:00:00', 'last_crawled_at must remain newest timestamp');
  assert.equal(Number(product.observation_count), 10, 'product_current observation_count must NOT increment on late arrival');

  // Verification 3: Observation is recorded in daily_packed_history for the 2-days-ago date
  const historyRow = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-16');
  assert.ok(historyRow, 'History row for 2026-09-16 must be created');
  assert.equal(Number(historyRow.observation_count), 1);

  const observations = unpackObservations(historyRow.observations_json);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observationId, lateObsId);
  assert.equal(observations[0].price, 65.00);
  assert.equal(observations[0].likes, 180);
});

test('Objective 2.2: Late arrival for an existing history date appends observation without corrupting daily aggregates', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:late-arrival-existing-date';

  await seedProduct(db, itemUid, {
    current_price: 150.00,
    last_crawled_at: '2026-09-20 18:00:00',
  });

  // Pre-seed an existing observation on 2026-09-18 at 08:00:00
  const existingObs = [{
    observationId: 'monitoring:earlier:001',
    runId: null,
    time: '08:00:00',
    price: 120.00,
    likes: 50,
    views: 100,
    comments: 5,
    shares: 2,
    sold: 10,
    rating: 5.0,
    reviews: 2,
    returnPosition: null,
    sold30d: null,
    gmv: null,
    source: 'monitoring',
    quality: 'exact',
  }];

  await db.prepare(`
    INSERT INTO daily_packed_history (
      item_uid, platform, date, observations_json, observation_count,
      min_price, max_price, latest_price, created_at, updated_at
    ) VALUES (
      ?, 'etsy', '2026-09-18', ?, 1, 120.00, 120.00, 120.00, '2026-09-18 08:00:00', '2026-09-18 08:00:00'
    )
  `).run(itemUid, packObservations(existingObs));

  // Send second observation for 2026-09-18 at 14:00:00 (still older than current last_crawled_at 2026-09-20)
  const res = await ops.applyMonitoringObservation(itemUid, {
    price: 125.00,
    likes: 55,
    observationId: 'monitoring:late:002',
    observedAt: '2026-09-18T14:00:00Z',
  });

  assert.equal(res.isLateArrival, true);
  assert.equal(res.updated, false);

  // Verify daily history for 2026-09-18 now contains 2 observations
  const historyRow = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-18');
  assert.equal(Number(historyRow.observation_count), 2);

  const obsArr = unpackObservations(historyRow.observations_json);
  assert.equal(obsArr.length, 2);
  assert.equal(obsArr[0].observationId, 'monitoring:earlier:001');
  assert.equal(obsArr[1].observationId, 'monitoring:late:002');
  assert.equal(Number(historyRow.min_price), 120.00);
  assert.equal(Number(historyRow.max_price), 125.00);

  // Verify product_current untouched
  const current = await db.prepare('SELECT current_price, last_crawled_at FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(current.current_price), 150.00);
  assert.equal(current.last_crawled_at, '2026-09-20 18:00:00');
});

test('Objective 2.3: Multiple out-of-order observations in reverse chronological sequence are all preserved', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:reverse-sequence-test';

  // Seed newest baseline on 2026-09-25
  await seedProduct(db, itemUid, {
    current_price: 200.00,
    last_crawled_at: '2026-09-25 12:00:00',
  });

  // 1. Arrive with Day 23
  const r23 = await ops.applyMonitoringObservation(itemUid, {
    price: 190.00,
    observationId: 'obs:day-23',
    observedAt: '2026-09-23T10:00:00Z',
  });
  assert.equal(r23.isLateArrival, true);

  // 2. Arrive with Day 21
  const r21 = await ops.applyMonitoringObservation(itemUid, {
    price: 180.00,
    observationId: 'obs:day-21',
    observedAt: '2026-09-21T10:00:00Z',
  });
  assert.equal(r21.isLateArrival, true);

  // 3. Arrive with Day 19
  const r19 = await ops.applyMonitoringObservation(itemUid, {
    price: 170.00,
    observationId: 'obs:day-19',
    observedAt: '2026-09-19T10:00:00Z',
  });
  assert.equal(r19.isLateArrival, true);

  // Verify all 3 historical dates exist in daily_packed_history
  const historyDates = await db.prepare('SELECT date, latest_price FROM daily_packed_history WHERE item_uid = ? ORDER BY date ASC').all(itemUid);
  assert.equal(historyDates.length, 3);
  assert.equal(historyDates[0].date, '2026-09-19');
  assert.equal(Number(historyDates[0].latest_price), 170.00);
  assert.equal(historyDates[1].date, '2026-09-21');
  assert.equal(Number(historyDates[1].latest_price), 180.00);
  assert.equal(historyDates[2].date, '2026-09-23');
  assert.equal(Number(historyDates[2].latest_price), 190.00);

  // Verify current remains 200.00 on Day 25
  const current = await db.prepare('SELECT current_price, last_crawled_at FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(current.current_price), 200.00);
  assert.equal(current.last_crawled_at, '2026-09-25 12:00:00');
});

test('Objective 2.4: Observation with newer timestamp updates product_current and does not trigger late arrival', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:fresh-observation';

  await seedProduct(db, itemUid, {
    current_price: 50.00,
    last_crawled_at: '2026-09-20 12:00:00',
  });

  // Fresh observation arriving at 2026-09-20 15:00:00 (3 hours newer)
  const res = await ops.applyMonitoringObservation(itemUid, {
    price: 55.00,
    observationId: 'obs:fresh:001',
    observedAt: '2026-09-20T15:00:00Z',
  });

  assert.equal(res.isLateArrival, false);
  assert.equal(res.updated, true);

  const updated = await db.prepare('SELECT current_price, last_crawled_at FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(updated.current_price), 55.00);
  assert.equal(updated.last_crawled_at, '2026-09-20 15:00:00');
});

// ============================================================================
// OBJECTIVE 3: Field Presence & Sparse Observations (Zero Non-Coercion)
// ============================================================================

test('Objective 3.1: Sparse observation with ONLY likes updates likes while preserving price, views, sold, etc.', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:sparse-likes-only';

  await seedProduct(db, itemUid, {
    current_price: 49.99,
    current_sold: 210,
    current_likes: 70,
    current_views: 1500,
    current_comments: 42,
    current_shares: 18,
    current_saves: 85,
    current_rating: 4.90,
    current_reviews: 55,
  });

  // Observation containing ONLY likes
  await ops.applyMonitoringObservation(itemUid, {
    likes: 95,
    observationId: 'obs:likes-only:01',
    observedAt: '2026-09-21T10:00:00Z',
  });

  const product = await db.prepare('SELECT * FROM product_current WHERE item_uid = ?').get(itemUid);

  // Target metric updated with correct delta and prev
  assert.equal(Number(product.current_likes), 95, 'current_likes must be updated');
  assert.equal(Number(product.prev_likes), 70, 'prev_likes must record previous value');
  assert.equal(Number(product.delta_likes), 25, 'delta_likes must be 95 - 70 = 25');

  // Crucial check: All unmeasured metrics MUST NOT be zeroed or nullified!
  assert.equal(Number(product.current_price), 49.99, 'current_price must NOT be zeroed');
  assert.equal(Number(product.current_sold), 210, 'current_sold must NOT be zeroed');
  assert.equal(Number(product.current_views), 1500, 'current_views must NOT be zeroed');
  assert.equal(Number(product.current_comments), 42, 'current_comments must NOT be zeroed');
  assert.equal(Number(product.current_shares), 18, 'current_shares must NOT be zeroed');
  assert.equal(Number(product.current_saves), 85, 'current_saves must NOT be zeroed');
  assert.equal(Number(product.current_rating), 4.90, 'current_rating must NOT be zeroed');
  assert.equal(Number(product.current_reviews), 55, 'current_reviews must NOT be zeroed');
});

test('Objective 3.2: Sparse observation with ONLY price updates price while preserving likes, views, sold, etc.', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:sparse-price-only';

  await seedProduct(db, itemUid, {
    current_price: 32.00,
    current_sold: 140,
    current_likes: 88,
    current_views: 920,
  });

  // Observation containing ONLY price
  await ops.applyMonitoringObservation(itemUid, {
    price: 38.50,
    observationId: 'obs:price-only:01',
    observedAt: '2026-09-21T11:00:00Z',
  });

  const product = await db.prepare('SELECT * FROM product_current WHERE item_uid = ?').get(itemUid);

  // Price updated
  assert.equal(Number(product.current_price), 38.50);
  assert.equal(Number(product.prev_price), 32.00);
  assert.equal(Number(product.delta_price), 6.50);

  // Crucial check: Other metrics intact
  assert.equal(Number(product.current_likes), 88, 'current_likes must remain untouched');
  assert.equal(Number(product.current_sold), 140, 'current_sold must remain untouched');
  assert.equal(Number(product.current_views), 920, 'current_views must remain untouched');
});

test('Objective 3.3: Media URLs (image, video_url), canonical url, and title are preserved when omitted in patch', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:media-preservation-test';

  const originalTitle = 'Preserved Artisan Necklace';
  const originalUrl = 'https://www.etsy.com/listing/necklace-999';
  const originalImage = 'https://img.etsy.com/necklace-primary.jpg';
  const originalVideo = 'https://vid.etsy.com/necklace-teaser.mp4';

  await seedProduct(db, itemUid, {
    title: originalTitle,
    url: originalUrl,
    image: originalImage,
    video_url: originalVideo,
  });

  // Patch with price only (media omitted)
  await ops.applyMonitoringObservation(itemUid, {
    price: 50.00,
    observationId: 'obs:media-omit:01',
    observedAt: '2026-09-21T12:00:00Z',
  });

  const updated = await db.prepare('SELECT title, url, image, video_url FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(updated.title, originalTitle, 'title must be preserved');
  assert.equal(updated.url, originalUrl, 'url must be preserved');
  assert.equal(updated.image, originalImage, 'image must be preserved');
  assert.equal(updated.video_url, originalVideo, 'video_url must be preserved');
});

test('Objective 3.4: Explicit 0 is respected as legitimate metric value, while null and empty string do NOT overwrite', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:zero-vs-null-test';

  await seedProduct(db, itemUid, {
    current_likes: 25,
    current_sold: 50,
    current_views: 300,
  });

  // 1. Explicit 0 for likes (e.g. video had likes reset by moderation): should update to 0
  // 2. null for sold and empty string for views: should NOT overwrite existing values
  await ops.applyMonitoringObservation(itemUid, {
    likes: 0,
    sold: null,
    views: '',
    observationId: 'obs:zero-null:01',
    observedAt: '2026-09-21T13:00:00Z',
  });

  const product = await db.prepare('SELECT current_likes, current_sold, current_views FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(product.current_likes), 0, 'Explicit 0 must be accepted and written');
  assert.equal(Number(product.current_sold), 50, 'null must NOT overwrite existing current_sold');
  assert.equal(Number(product.current_views), 300, 'Empty string must NOT overwrite existing current_views');
});

test('Objective 3.5: Saves metric updates current_saves and prev_saves without referencing non-existent delta_saves', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'tiktok:saves-column-safety';

  await seedProduct(db, itemUid, {
    platform: 'tiktok',
    current_saves: 40,
  });

  // Send update with saves
  const res = await ops.applyMonitoringObservation(itemUid, {
    saves: 65,
    observationId: 'obs:saves:01',
    observedAt: '2026-09-21T14:00:00Z',
  });

  assert.equal(res.updated, true);
  const product = await db.prepare('SELECT current_saves, prev_saves FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(product.current_saves), 65);
  assert.equal(Number(product.prev_saves), 40);
});

test('Objective 3.6: Sparse observation in daily_packed_history populates all 11 REQUIRED_OBSERVATION_FIELDS with nulls', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:sparse-history-parity';

  await seedProduct(db, itemUid);

  // Send sparse observation with only price
  await ops.applyMonitoringObservation(itemUid, {
    price: 44.00,
    observationId: 'obs:sparse-parity:01',
    observedAt: '2026-09-21T15:00:00Z',
  });

  const history = await db.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-21');
  const obs = unpackObservations(history.observations_json)[0];

  // All 11 required keys from checkV2Parity must be present
  const requiredKeys = ['observationId', 'runId', 'time', 'price', 'views', 'likes', 'comments', 'shares', 'sold', 'rating', 'reviews'];
  for (const k of requiredKeys) {
    assert.ok(k in obs, `Key "${k}" must exist in packed observation entry for checkV2Parity compatibility`);
  }
  assert.equal(obs.price, 44.00);
  assert.equal(obs.likes, null, 'Unmeasured metric in sparse observation must be null');
  assert.equal(obs.views, null);
  assert.equal(obs.sold, null);
  assert.equal(obs.runId, null, 'Monitoring observation must have runId: null');
});

// ============================================================================
// OBJECTIVE 4: Status Decoupling (Dropped & Active Items Status Untouched)
// ============================================================================

test('Objective 4.1: Monitoring observation for an item with status = "dropped" preserves status = "dropped"', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:dropped-item-monitoring';

  // Seed item marked 'dropped' by Discovery
  await seedProduct(db, itemUid, {
    status: 'dropped',
    current_price: 20.00,
    query: 'artisan pottery vase',
    first_seen_at: '2026-08-15 00:00:00',
  });

  // Apply monitoring observation
  const res = await ops.applyMonitoringObservation(itemUid, {
    price: 24.00,
    observationId: 'obs:dropped:01',
    observedAt: '2026-09-22T08:00:00Z',
  });
  assert.equal(res.updated, true);

  const product = await db.prepare('SELECT status, query, first_seen_at, current_price FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(product.status, 'dropped', 'product_current.status MUST remain "dropped"');
  assert.equal(product.query, 'artisan pottery vase', 'query MUST remain untouched');
  assert.equal(product.first_seen_at, '2026-08-15 00:00:00', 'first_seen_at MUST remain untouched');
  assert.equal(Number(product.current_price), 24.00, 'current_price must be updated');
});

test('Objective 4.2: Monitoring observation for an item with status = "active" preserves status = "active"', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:active-item-monitoring';

  await seedProduct(db, itemUid, {
    status: 'active',
    current_price: 50.00,
  });

  await ops.applyMonitoringObservation(itemUid, {
    price: 52.00,
    observationId: 'obs:active:01',
    observedAt: '2026-09-22T09:00:00Z',
  });

  const product = await db.prepare('SELECT status, current_price FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(product.status, 'active', 'product_current.status MUST remain "active"');
  assert.equal(Number(product.current_price), 52.00);
});

test('Objective 4.3: Monitoring observation for an item with status = "new" preserves status = "new"', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:new-item-monitoring';

  await seedProduct(db, itemUid, {
    status: 'new',
    current_price: 15.00,
  });

  await ops.applyMonitoringObservation(itemUid, {
    price: 18.00,
    observationId: 'obs:new:01',
    observedAt: '2026-09-22T09:30:00Z',
  });

  const product = await db.prepare('SELECT status, current_price FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(product.status, 'new', 'product_current.status MUST remain "new"');
  assert.equal(Number(product.current_price), 18.00);
});

test('Objective 4.4: Successive monitoring observations on dropped item never bleed Discovery status', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:dropped-successive';

  await seedProduct(db, itemUid, { status: 'dropped' });

  for (let i = 1; i <= 5; i++) {
    await ops.applyMonitoringObservation(itemUid, {
      price: 20.00 + i,
      observationId: `obs:dropped:seq-${i}`,
      observedAt: `2026-09-22T1${i}:00:00Z`,
    });

    const product = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
    assert.equal(product.status, 'dropped', `Status must stay 'dropped' after iteration ${i}`);
  }
});

// ============================================================================
// OBJECTIVE 5: Dual API Signatures & Advisory Lock Invariants
// ============================================================================

test('Objective 5.1: Signature applyMonitoringObservation(itemUid, payload, options) works as expected', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:sig-1-test';
  await seedProduct(db, itemUid);

  const res = await ops.applyMonitoringObservation(itemUid, { price: 29.99 }, {
    observationId: 'sig1:obs:01',
    observedAt: '2026-09-22T10:00:00Z',
  });

  assert.equal(res.updated, true);
  assert.equal(res.observationId, 'sig1:obs:01');
  const row = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(row.current_price), 29.99);
});

test('Objective 5.2: Signature applyMonitoringObservation(db, { itemUid, patch, metadata }) works as expected', async () => {
  const db = await createIsolatedTestDb();
  const itemUid = 'etsy:sig-2-test';
  await seedProduct(db, itemUid);

  const res = await applyMonitoringObservation(db, {
    itemUid,
    patch: { price: 33.50, observedAt: '2026-09-22T10:30:00Z' },
    metadata: { observationId: 'sig2:obs:01' },
  });

  assert.equal(res.updated, true);
  assert.equal(res.observationId, 'sig2:obs:01');
  const row = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(row.current_price), 33.50);
});

test('Objective 5.3: Advisory lock key generation is deterministic and strictly 32-bit signed integers', () => {
  const uids = [
    'etsy:https://www.etsy.com/listing/123456789',
    'tiktok:https://www.tiktok.com/@user/video/987654321',
    'amazon:B08N5WRWNW',
    'shopee:item-999-shop-888',
    'unicode-uid:item/đẹp-lắm/🎉',
  ];

  for (const uid of uids) {
    const [k1, k2] = getAdvisoryLockKeys(uid);
    assert.equal(typeof k1, 'number');
    assert.equal(typeof k2, 'number');
    assert.ok(Number.isInteger(k1));
    assert.ok(Number.isInteger(k2));
    assert.ok(k1 >= -2147483648 && k1 <= 2147483647, `k1 must be 32-bit signed int: ${k1}`);
    assert.ok(k2 >= -2147483648 && k2 <= 2147483647, `k2 must be 32-bit signed int: ${k2}`);

    // Deterministic repeat check
    const [repeatK1, repeatK2] = getAdvisoryLockKeys(uid);
    assert.equal(k1, repeatK1);
    assert.equal(k2, repeatK2);
  }
});
