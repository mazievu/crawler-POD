/**
 * V2 data-model tests (daily packed history, product_current, weekly summary).
 *
 * §16 CONTRACT CHANGE — PostgreSQL cutover:
 *   OLD CONTRACT: these ops modules were built on a synchronous better-sqlite3
 *                 handle (`new Database(':memory:')` + initSchemaV2), so every
 *                 call returned a value directly.
 *   NEW CONTRACT: the ops modules run on PostgreSQL through src/database/pg-client,
 *                 so every operation is asynchronous and must be awaited.
 *   WHY THE OLD TEST IS STALE: it drove the modules with a SQLite handle, a
 *                 backend the application no longer uses at runtime.
 *
 * Every assertion below is unchanged — the behaviours under test (identity-based
 * idempotency, one row per item/day, windowed 3h/24h deltas, sum/count weekly
 * averaging, divide-by-zero guard, rebuild-from-history) are exactly the same.
 * Only the backend and the awaiting differ.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fromDriver } = require('../src/database/pg-client');
const { createProductCurrentOps } = require('../src/database/product-current');
const { createDailyHistoryOps } = require('../src/database/daily-history');
const { createWeeklySummaryOps, recomputeWeeklySummaryFromHistory } = require('../src/database/weekly-summary');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'database', 'pg-schema.sql'), 'utf8');

/** A fresh, isolated in-memory PostgreSQL for one test. */
async function freshDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = fromDriver(new PGlite());
  await db.exec(SCHEMA);
  return db;
}

// §4.2/§16.H mandatory: appendObservation() must be idempotent by identity —
// calling it twice for the SAME real observation (retried write, re-run
// migration) must not duplicate the entry or inflate observation_count.
test('Daily Packed History appendObservation is idempotent by observationId (#4.2/#16.H)', async () => {
  const db = await freshDb();
  const ops = createDailyHistoryOps(db);
  const item = { item_uid: 'test:idempotent-item', platform: 'test', price: 5, likes: 1, views: 2 };
  const ts = new Date('2026-08-25T10:00:00Z');

  const r1 = await ops.appendObservation(item, ts, { runId: 100 });
  assert.equal(r1.duplicate, false);
  const r2 = await ops.appendObservation(item, ts, { runId: 100 }); // identical identity — must replace, not duplicate
  assert.equal(r2.duplicate, true);
  const r3 = await ops.appendObservation(item, ts, { runId: 100 }); // run it a third time for good measure
  assert.equal(r3.duplicate, true);

  const row = await ops.findRow('test:idempotent-item', '2026-08-25');
  const observations = JSON.parse(row.observations_json);
  assert.equal(observations.length, 1, 'Repeated identical writes must never grow the array');
  assert.equal(row.observation_count, 1, 'observation_count must be derived from the final array length, not blindly incremented');

  // A genuinely DIFFERENT observation (different runId) for the same item+day must append normally.
  await ops.appendObservation(item, ts, { runId: 101 });
  const rowAfter = await ops.findRow('test:idempotent-item', '2026-08-25');
  assert.equal(JSON.parse(rowAfter.observations_json).length, 2, 'A real second observation must still be appended');
  assert.equal(rowAfter.observation_count, 2);
});

// §4.1 mandatory: migration/backfill identity (legacy:<snapshot_id>) makes
// re-running the same legacy-row migration idempotent too.
test('Daily Packed History appendObservation is idempotent for legacy migration identity (#4.1)', async () => {
  const db = await freshDb();
  const ops = createDailyHistoryOps(db);
  const item = { item_uid: 'test:legacy-migrated-item', platform: 'test', price: 5, likes: 1, views: 2 };
  const ts = new Date('2026-08-25T10:00:00Z');

  await ops.appendObservation(item, ts, { legacySnapshotId: 555 });
  await ops.appendObservation(item, ts, { legacySnapshotId: 555 }); // re-running the migration for the same legacy row

  const row = await ops.findRow('test:legacy-migrated-item', '2026-08-25');
  assert.equal(JSON.parse(row.observations_json).length, 1, 'Re-migrating the same legacy snapshot must not duplicate its observation');
  assert.equal(row.observation_count, 1);
});

test('Product Current guarantees 1 row per item_uid and tracks deltas', async () => {
  const db = await freshDb();
  const dailyOps = createDailyHistoryOps(db);
  const ops = createProductCurrentOps(db, dailyOps);

  const item1 = {
    item_uid: 'shopify:sku_123',
    platform: 'shopify',
    title: 'POD Mug',
    price: 15.0,
    likes: 100,
    views: 1000,
    sold_count: 20,
    rating: 4.5
  };

  const r1 = await ops.upsertItem(item1, 1);
  assert.equal(r1.isNew, true);

  const row1 = await ops.findByUid('shopify:sku_123');
  assert.equal(row1.current_price, 15.0);
  assert.equal(row1.current_likes, 100);
  assert.equal(row1.observation_count, 1);
  // No historical reference exists yet -> 3h/24h deltas must be NULL, not 0.
  assert.equal(row1.delta_3h_likes, null);
  assert.equal(row1.delta_24h_views, null);

  const item2 = {
    item_uid: 'shopify:sku_123',
    platform: 'shopify',
    title: 'POD Mug',
    price: 18.0,
    likes: 150,
    views: 1800,
    sold_count: 35,
    rating: 4.8
  };

  const r2 = await ops.upsertItem(item2, 2);
  assert.equal(r2.isNew, false);

  const row2 = await ops.findByUid('shopify:sku_123');
  assert.equal(row2.current_price, 18.0);
  assert.equal(row2.prev_price, 15.0);
  assert.equal(row2.delta_price, 3.0);
  assert.equal(row2.delta_likes, 50);
  assert.equal(row2.delta_sold, 15);
  assert.equal(row2.delta_views, 800);
  assert.equal(row2.observation_count, 2);
  assert.equal(row2.status, 'active');
  assert.ok(row2.rank_score > 0);

  const count = await db.prepare('SELECT COUNT(*) as cnt FROM product_current').get();
  assert.equal(Number(count.cnt), 1);
});

// P0-4 acceptance, exact scenario from the spec:
// 09:00 views=100, 12:00 views=150, 15:00 views=220 (today) -> delta_3h @15:00 = 70
// 15:00 views=50 (yesterday) -> delta_24h @15:00(today) = 170
test('Product Current computes real windowed 3h/24h deltas from Daily History, not previous-crawl deltas (P0-4)', async () => {
  const db = await freshDb();
  const dailyOps = createDailyHistoryOps(db);
  const ops = createProductCurrentOps(db, dailyOps);
  const uid = 'reddit:trend_1';

  // Yesterday 15:00 baseline for the 24h window.
  await ops.upsertItem({ item_uid: uid, platform: 'reddit', views: 50, likes: 5 }, 1, new Date('2026-08-23T15:00:00Z'));
  await dailyOps.appendObservation({ item_uid: uid, platform: 'reddit', views: 50, likes: 5 }, new Date('2026-08-23T15:00:00Z'));

  // Today 09:00, 12:00 observations.
  await ops.upsertItem({ item_uid: uid, platform: 'reddit', views: 100, likes: 10 }, 2, new Date('2026-08-24T09:00:00Z'));
  await dailyOps.appendObservation({ item_uid: uid, platform: 'reddit', views: 100, likes: 10 }, new Date('2026-08-24T09:00:00Z'));

  await ops.upsertItem({ item_uid: uid, platform: 'reddit', views: 150, likes: 15 }, 3, new Date('2026-08-24T12:00:00Z'));
  await dailyOps.appendObservation({ item_uid: uid, platform: 'reddit', views: 150, likes: 15 }, new Date('2026-08-24T12:00:00Z'));

  // Today 15:00: this crawl's upsertItem must see 12:00 (3h ago) and yesterday 15:00 (24h ago)
  // in Daily History, since appendObservation for THIS point hasn't run yet.
  const result = await ops.upsertItem({ item_uid: uid, platform: 'reddit', views: 220, likes: 22 }, 4, new Date('2026-08-24T15:00:00Z'));

  assert.equal(result.deltas.delta_24h_views, 170, '220 - 50 (yesterday 15:00)');
  const row = await ops.findByUid(uid);
  assert.equal(row.delta_3h_views, 70, '220 - 150 (today 12:00, exactly 3h prior)');
  assert.equal(row.delta_24h_views, 170);

  // Sanity: this must differ from the naive previous-crawl delta (220-150=70 vs true 24h=170).
  assert.notEqual(row.delta_24h_views, row.delta_views);
});

test('Product Current returns null (not 0) for windowed deltas when no observation exists in tolerance window (P0-4)', async () => {
  const db = await freshDb();
  const dailyOps = createDailyHistoryOps(db);
  const ops = createProductCurrentOps(db, dailyOps);
  const uid = 'twitter:sparse_1';

  await ops.upsertItem({ item_uid: uid, platform: 'twitter', views: 10, likes: 1 }, 1, new Date('2026-08-24T09:00:00Z'));
  await dailyOps.appendObservation({ item_uid: uid, platform: 'twitter', views: 10, likes: 1 }, new Date('2026-08-24T09:00:00Z'));

  // Next crawl only 20 minutes later - no observation exists near the 3h or 24h mark.
  const result = await ops.upsertItem({ item_uid: uid, platform: 'twitter', views: 12, likes: 2 }, 2, new Date('2026-08-24T09:20:00Z'));
  assert.equal(result.deltas.delta_3h_views, null);
  assert.equal(result.deltas.delta_24h_views, null);
});

test('Daily Packed History aggregates intra-day observations into 1 daily row', async () => {
  const db = await freshDb();
  const dailyOps = createDailyHistoryOps(db);

  const baseItem = {
    item_uid: 'etsy:item_999',
    platform: 'etsy',
    price: 25.0,
    likes: 10,
    views: 100,
    sold_count: 2
  };

  const d1 = new Date('2026-08-24T08:00:00Z');
  const d2 = new Date('2026-08-24T12:00:00Z');
  const d3 = new Date('2026-08-24T18:00:00Z');

  await dailyOps.appendObservation({ ...baseItem, likes: 10, views: 100 }, d1);
  await dailyOps.appendObservation({ ...baseItem, likes: 25, views: 250 }, d2);
  await dailyOps.appendObservation({ ...baseItem, likes: 60, views: 600, price: 29.0 }, d3);

  const history = await dailyOps.getHistory('etsy:item_999');
  assert.equal(history.length, 1, 'Should only have 1 row for the day');
  assert.equal(history[0].observation_count, 3);
  assert.equal(history[0].observations.length, 3);
  assert.equal(history[0].latest_likes, 60);
  assert.equal(history[0].latest_price, 29.0);
});

test('Weekly Summary uses sum/count average and last-minus-first deltas, not running-average math (P0-5)', async () => {
  const db = await freshDb();
  const weeklyOps = createWeeklySummaryOps(db);
  const uid = 'tiktok:trend_777';
  const monday = new Date('2026-08-24T10:00:00Z'); // fixed week

  await weeklyOps.updateWeekly({ item_uid: uid, platform: 'tiktok', price: 10, likes: 100, views: 1000, sold_count: 5 }, monday);
  await weeklyOps.updateWeekly({ item_uid: uid, platform: 'tiktok', price: 20, likes: 150, views: 1500, sold_count: 8 }, monday);
  await weeklyOps.updateWeekly({ item_uid: uid, platform: 'tiktok', price: 30, likes: 300, views: 3000, sold_count: 20 }, monday);

  const rollups = await weeklyOps.getWeekly(uid);
  assert.equal(rollups.length, 1);
  const week = rollups[0];

  assert.equal(week.sample_count, 3);
  // avg = (10+20+30)/3 = 20, NOT the old running-average (( (10+20)/2 +30)/2 = 22.5).
  assert.equal(week.avg_price, 20);
  assert.equal(week.first_views, 1000);
  assert.equal(week.last_views, 3000);
  assert.equal(week.delta_views, 2000, 'last(3000) - first(1000), not "new - existing max"');
  assert.equal(week.delta_sold, 15, 'last(20) - first(5)');
  assert.equal(week.growth_rate, 200, '(3000-1000)/1000*100');
});

test('Weekly Summary growth_rate avoids divide-by-zero when first_views is 0', async () => {
  const db = await freshDb();
  const weeklyOps = createWeeklySummaryOps(db);
  const uid = 'facebook:zero_base';
  const t = new Date('2026-08-24T10:00:00Z');

  await weeklyOps.updateWeekly({ item_uid: uid, platform: 'facebook', price: 5, likes: 0, views: 0, sold_count: 0 }, t);
  await weeklyOps.updateWeekly({ item_uid: uid, platform: 'facebook', price: 5, likes: 10, views: 50, sold_count: 1 }, t);

  const week = (await weeklyOps.getWeekly(uid))[0];
  assert.equal(week.growth_rate, 0, 'No baseline (first_views=0) -> defined as 0, not Infinity/NaN');
});

test('recomputeWeeklySummaryFromHistory rebuilds weekly_summary from Daily History without touching it', async () => {
  const db = await freshDb();
  const dailyOps = createDailyHistoryOps(db);
  const uid = 'shopify:rebuild_1';

  await dailyOps.appendObservation({ item_uid: uid, platform: 'shopify', price: 10, likes: 5, views: 100, sold_count: 1 }, new Date('2026-08-24T08:00:00Z'));
  await dailyOps.appendObservation({ item_uid: uid, platform: 'shopify', price: 12, likes: 20, views: 400, sold_count: 4 }, new Date('2026-08-24T20:00:00Z'));

  const before = await dailyOps.getHistory(uid);
  assert.equal(before[0].observations.length, 2);

  const result = await recomputeWeeklySummaryFromHistory(db);
  assert.ok(result.weeksRebuilt >= 1);

  const after = await dailyOps.getHistory(uid);
  assert.equal(after[0].observations.length, 2, 'Daily History must be untouched by weekly recompute');

  const weeklyOps = createWeeklySummaryOps(db);
  const week = (await weeklyOps.getWeekly(uid))[0];
  assert.equal(week.delta_views, 300);
});
