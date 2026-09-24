/**
 * Challenger 1 Iteration 2 Verification Suite (Milestone 3):
 * Baseline Dynamics, Simulation 1 Stoppage & Numeric Timestamp Parsing
 *
 * Empirical challenges covering:
 * 1. Numeric epoch timestamps in ShopLifecyclePolicy.evaluateObservation:
 *    - Millisecond epoch (e.g. 1725148800000)
 *    - Dynamic Date.now()
 *    - Pure numeric string ("1725148800000")
 *    - Sequential multi-cycle evaluation with mixed date formats
 *    - Error handling for invalid numeric types (NaN, Infinity)
 * 2. Simulation 1 verification:
 *    - Day 27 active
 *    - Day 32 active (5-day cycle)
 *    - Day 35.99 active (29.99 days elapsed from reset)
 *    - Day 36.05 stopped (30.05 days elapsed >= 30 days)
 *    - UI label matches exact SSOT requirement
 * 3. F16.2 active window continuity:
 *    - 5-day cycle probes (Days 5, 10, 15, 20, 25)
 *    - Day 29d 23h 59m probe maintains active window without gap_broken_window_reset
 * 4. Database job cancellation query:
 *    - Verifies absence of 'updated_at' in monitoring_jobs update
 *    - Verifies cancellation of queued item_refresh jobs via @entity_id binding
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  ShopLifecyclePolicy,
  CONSTANTS,
  computeNextDue,
  computeNextDueAt,
  isGapBroken,
  calculateElapsedWindow,
} = require('../../src/monitoring/shop-lifecycle');

const { fromDriver } = require('../../src/database/pg-client');
const { createMonitoringOps } = require('../../src/database/monitoring');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'pg-schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

async function createIsolatedTestDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const driver = new PGlite();
  const db = fromDriver(driver);
  await db.exec(SCHEMA_SQL);
  return db;
}

/**
 * SSOT §3.2 only counts an unchanged window toward the 30-day stop when
 * consecutive observations are at most MAX_VALID_OBSERVATION_GAP (7d) apart;
 * a bare Day 0 -> Day 30 pair is a broken chain and resets the window. Fill in
 * the normal 5-day probe cadence (Day 5..25) so the Day 30 probe really stops.
 */
async function applyIntermediateObservations(ops, entityId, value) {
  for (let day = 5; day <= 25; day += 5) {
    const observedAt = new Date(Date.UTC(2026, 8, 1 + day)).toISOString();
    await ops.applyShopObservation(entityId, { value, observedAt, quality: 'exact' });
  }
}

// =============================================================================
// CHALLENGE 1: NUMERIC EPOCH TIMESTAMP PARSING
// =============================================================================

test('CHALLENGE 1.1: Raw numeric epoch millisecond timestamps are accepted without error_ignored', () => {
  const epochT0 = 1725148800000; // 2024-09-01T00:00:00.000Z
  const initial = { sales: null, unchangedSince: null };

  const s0 = ShopLifecyclePolicy.evaluateObservation(initial, {
    value: 1500,
    observedAt: epochT0,
    quality: 'exact',
  });

  assert.notEqual(s0.action, 'error_ignored', 'Raw numeric epoch timestamp must not trigger error_ignored');
  assert.equal(s0.action, 'baseline_established');
  assert.equal(s0.sales, 1500);
  assert.equal(s0.trackingStatus, 'active');
  assert.equal(s0.unchangedSince, '2024-09-01T00:00:00.000Z');
  assert.equal(s0.salesObservedAt, '2024-09-01T00:00:00.000Z');
});

test('CHALLENGE 1.2: Date.now() timestamp is accepted without error_ignored', () => {
  const nowMs = Date.now();
  const initial = { sales: null, unchangedSince: null };

  const s0 = ShopLifecyclePolicy.evaluateObservation(initial, {
    value: 200,
    observedAt: nowMs,
    quality: 'exact',
  });

  assert.notEqual(s0.action, 'error_ignored', 'Date.now() must not trigger error_ignored');
  assert.equal(s0.action, 'baseline_established');
  assert.equal(s0.sales, 200);
  assert.equal(s0.trackingStatus, 'active');
  assert.equal(s0.unchangedSince, new Date(nowMs).toISOString());
});

test('CHALLENGE 1.3: String numeric epoch timestamps ("1725148800000") are accepted without error_ignored', () => {
  const epochStr = '1725148800000';
  const initial = { sales: null, unchangedSince: null };

  const s0 = ShopLifecyclePolicy.evaluateObservation(initial, {
    value: 888,
    observedAt: epochStr,
    quality: 'exact',
  });

  assert.notEqual(s0.action, 'error_ignored');
  assert.equal(s0.action, 'baseline_established');
  assert.equal(s0.sales, 888);
  assert.equal(s0.unchangedSince, '2024-09-01T00:00:00.000Z');
});

test('CHALLENGE 1.4: Multi-cycle evaluation with mixed timestamp representations succeeds seamlessly', () => {
  let state = { sales: null, unchangedSince: null };
  const baseEpoch = 1725148800000; // 2024-09-01T00:00:00.000Z

  // Step 1: Raw numeric epoch
  state = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 100,
    observedAt: baseEpoch,
    quality: 'exact',
  });
  assert.equal(state.action, 'baseline_established');

  // Step 2: ISO string at +5 days
  state = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 100,
    observedAt: new Date(baseEpoch + (5 * 86400000)).toISOString(),
    quality: 'exact',
  });
  assert.equal(state.action, 'window_maintained_active');

  // Step 3: Date object at +10 days
  state = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 100,
    observedAt: new Date(baseEpoch + (10 * 86400000)),
    quality: 'exact',
  });
  assert.equal(state.action, 'window_maintained_active');

  // Step 4: String numeric at +15 days
  state = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 100,
    observedAt: String(baseEpoch + (15 * 86400000)),
    quality: 'exact',
  });
  assert.equal(state.action, 'window_maintained_active');
  assert.equal(state.unchangedSince, '2024-09-01T00:00:00.000Z');
});

test('CHALLENGE 1.5: Invalid numeric values (NaN, Infinity) correctly trigger error_ignored', () => {
  const current = { sales: 100, unchangedSince: '2024-09-01T00:00:00.000Z' };

  const resNaN = ShopLifecyclePolicy.evaluateObservation(current, {
    value: 100,
    observedAt: NaN,
  });
  assert.equal(resNaN.action, 'error_ignored');
  assert.equal(resNaN.stateChanged, false);

  const resInf = ShopLifecyclePolicy.evaluateObservation(current, {
    value: 100,
    observedAt: Infinity,
  });
  assert.equal(resInf.action, 'error_ignored');
  assert.equal(resInf.stateChanged, false);
});

// =============================================================================
// CHALLENGE 2: SIMULATION 1 STEP-BY-STEP VERIFICATION
// =============================================================================

test('CHALLENGE 2.1: Simulation 1 preserves active through Day 27, 32, 35.99 and stops at Day 36.05', () => {
  let shopState = {
    trackingStatus: 'active',
    sales: null,
    unchangedSince: null,
    salesObservedAt: null,
    lastIncreaseObservedAt: null,
  };

  // Day 0: Baseline 1,000 (2026-09-01T00:00:00Z)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1000,
    observedAt: '2026-09-01T00:00:00.000Z',
    quality: 'exact',
  });
  assert.equal(shopState.action, 'baseline_established');
  assert.equal(shopState.sales, 1000);

  // Day 5: Sales increase to 1,020 -> reset baseline (2026-09-06T00:00:00Z)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: '2026-09-06T00:00:00.000Z',
    quality: 'exact',
  });
  assert.equal(shopState.action, 'baseline_reset_increase');
  assert.equal(shopState.sales, 1020);
  assert.equal(shopState.unchangedSince, '2026-09-06T00:00:00.000Z');

  // Day 10: Unchanged (2026-09-11T00:00:00Z)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: '2026-09-11T00:00:00.000Z',
    quality: 'exact',
  });
  assert.equal(shopState.action, 'window_maintained_active');

  // Day 15: Unchanged (2026-09-16T00:00:00Z)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: '2026-09-16T00:00:00.000Z',
    quality: 'exact',
  });
  assert.equal(shopState.action, 'window_maintained_active');

  // Day 20: 429 Rate limit error (2026-09-21T00:00:00Z) -> ignored
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    error: 'HTTP 429 Too Many Requests',
    observedAt: '2026-09-21T00:00:00.000Z',
  });
  assert.equal(shopState.action, 'error_ignored');
  assert.equal(shopState.trackingStatus, 'active');

  // Day 22: Retry succeeds at 1,020 (2026-09-23T00:00:00Z, gap from Day 15 is 7d)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: '2026-09-23T00:00:00.000Z',
    quality: 'exact',
  });
  assert.equal(shopState.action, 'window_maintained_active');

  // Day 27: Sales unchanged at 1,020 (2026-09-28T00:00:00Z)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: '2026-09-28T00:00:00.000Z',
    quality: 'exact',
  });
  assert.equal(shopState.trackingStatus, 'active', 'Must be active at Day 27');
  assert.equal(shopState.action, 'window_maintained_active');

  // Day 32: Scheduled 5-day cycle probe, sales unchanged at 1,020 (2026-10-03T00:00:00Z)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: '2026-10-03T00:00:00.000Z',
    quality: 'exact',
  });
  assert.equal(shopState.trackingStatus, 'active', 'Must be active at Day 32');
  assert.equal(shopState.action, 'window_maintained_active');
  assert.equal(shopState.unchangedSince, '2026-09-06T00:00:00.000Z');

  // Day 35.99: 29 days, 23 hours, 50 mins from reset (2026-10-05T23:50:00Z)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: '2026-10-05T23:50:00.000Z',
    quality: 'exact',
  });
  assert.equal(shopState.trackingStatus, 'active', 'Must remain active at Day 35.99 (before 30 full days)');
  assert.equal(shopState.action, 'window_maintained_active');

  // Day 36.05: 30 days, 1 hour, 50 mins from reset (2026-10-06T01:50:00Z)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: '2026-10-06T01:50:00.000Z',
    quality: 'exact',
  });
  assert.equal(shopState.trackingStatus, 'stopped', 'Shop must stop at Day 36.05 (threshold >= 30 days reached)');
  assert.equal(shopState.reason, 'shop_sales_unchanged_30d');
  assert.equal(shopState.action, 'shop_stopped_30d_unchanged');

  // UI Label
  assert.equal(ShopLifecyclePolicy.getUiLabel(shopState), 'Không quan sát thấy sales tăng trong 30 ngày');
});

// =============================================================================
// CHALLENGE 3: F16.2 ACTIVE WINDOW CONTINUITY
// =============================================================================

test('CHALLENGE 3.1: F16.2 maintains active window across 5-day probes without tripping gap_broken_window_reset', () => {
  let state = { sales: null, unchangedSince: null };
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();

  // Day 0: Baseline 500
  state = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 500,
    observedAt: new Date(t0).toISOString(),
    quality: 'exact',
  });
  assert.equal(state.action, 'baseline_established');

  // 5 cycles of 5 days (Days 5, 10, 15, 20, 25)
  for (let i = 1; i <= 5; i++) {
    const tCycle = t0 + (i * 5 * 86400000);
    state = ShopLifecyclePolicy.evaluateObservation(state, {
      value: 500,
      observedAt: new Date(tCycle).toISOString(),
      quality: 'exact',
    });
    assert.equal(state.trackingStatus, 'active');
    assert.equal(state.action, 'window_maintained_active');
    assert.notEqual(state.action, 'gap_broken_window_reset', `Cycle ${i} must never trip gap_broken_window_reset`);
  }

  // Advance to Day 29d 23h 59m:
  // Gap from Day 25 is 4d 23h 59m (431,940,000 ms < 604,800,000 ms)
  const t29dEnd = t0 + (29 * 86400000) + (23 * 3600000) + (59 * 60000);
  state = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 500,
    observedAt: new Date(t29dEnd).toISOString(),
    quality: 'exact',
  });

  assert.equal(state.trackingStatus, 'active', 'Shop must remain active at 29d 23h 59m');
  assert.equal(state.action, 'window_maintained_active');
  assert.notEqual(state.action, 'gap_broken_window_reset', 'Must not trip gap_broken_window_reset');
  assert.equal(state.unchangedSince, '2026-09-01T00:00:00.000Z', 'Anchor unchangedSince must remain at Day 0');
});

// =============================================================================
// CHALLENGE 4: DATABASE MONITORING_JOBS CANCELLATION QUERY
// =============================================================================

test('CHALLENGE 4.1: Database cascade stoppage query cancels queued item_refresh jobs without column error', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'test-job-cancel-shop',
    identitySource: 'id',
  });

  // Create an item for this entity
  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at)
    VALUES ('etsy:cancel-item-1', 'etsy', 'pottery', 'Handmade Mug', 'https://etsy.com/1', now(), now());
  `).run();

  const item = await ops.registerItemForMonitoring({
    itemUid: 'etsy:cancel-item-1',
    entityId: entity.id,
    eligibility: 'ready',
    itemStatus: 'active',
  });

  // Seed two queued item_refresh jobs:
  // Job 1: with entity_id set
  await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for, status)
    VALUES (?, ?, 'item_refresh', 'sess-cancel-1', now(), 'queued');
  `).run(entity.id, item.id);

  // Job 2: with entity_id NULL (allowed by chk_monitoring_jobs_target constraint)
  await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for, status)
    VALUES (NULL, ?, 'item_refresh', 'sess-cancel-2', now(), 'queued');
  `).run(item.id);

  // Baseline observation on Day 0
  await ops.applyShopObservation(entity.id, {
    value: 100,
    observedAt: '2026-09-01T00:00:00.000Z',
    quality: 'exact',
  });
  await applyIntermediateObservations(ops, entity.id, 100);

  // Day 30 observation triggers stoppage cascade
  const resStop = await ops.applyShopObservation(entity.id, {
    value: 100,
    observedAt: '2026-10-01T00:00:00.000Z',
    quality: 'exact',
  });

  assert.equal(resStop.trackingStatus, 'stopped');

  // Verify both jobs were cancelled without PostgreSQL error
  const jobs = await db.prepare('SELECT id, status FROM monitoring_jobs WHERE kind = \'item_refresh\'').all();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].status, 'cancelled');
  assert.equal(jobs[1].status, 'cancelled');
});
