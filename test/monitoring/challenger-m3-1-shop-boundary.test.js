/**
 * Challenger 1 Verification Suite (Milestone 3):
 * Baseline Dynamics, Boundary Conditions & Stoppage Rules
 *
 * Exhaustive adversarial stress test covering:
 * 1. 30-Day Boundary:
 *    - 29d 23h 59m 59s strictly active
 *    - 29d 23h 59m 59s 999ms strictly active
 *    - Exactly 30d 00h 00m 00s (and 000ms) transitions to stopped
 *    - Passive time passage NEVER stops a shop without fresh valid observation
 * 2. 7-Day Gap Boundary:
 *    - Exactly 7 days (604,800,000 ms) gap preserves chain continuity
 *    - 7 days + 1 ms (604,800,001 ms) strictly breaks chain continuity
 *    - Gap break restarts 30-day accumulation clock from current observation
 * 3. Value Edge Cases & Quality Rejection:
 *    - Baseline established on sales = 0
 *    - Sales decrease (recalibration) resets window anchor, does NOT stop shop
 *    - Quality rejection: 'rounded' (e.g. "10k") and 'estimated' reject stoppage at Day 30
 *    - Errors/blocks (HTTP 429, CAPTCHA) at Day 30 do NOT stop shop
 * 4. UI Label Accuracy (F17)
 * 5. Database Integration & Metric Scope Invariant (F12)
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
  computeBackoffRetryAt,
  isGapBroken,
  calculateElapsedWindow,
  evaluateAndApplyShopProbe,
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

// =============================================================================
// CHALLENGE 1: 30-DAY BOUNDARY PRECISION
// =============================================================================

test('CHALLENGE 1.1: 29d 23h 59m 59s with unchanged sales strictly remains active', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const initial = { sales: null, unchangedSince: null };
  const obs0 = { value: 100, observedAt: new Date(t0).toISOString(), quality: 'exact' };
  const s0 = ShopLifecyclePolicy.evaluateObservation(initial, obs0);
  assert.equal(s0.action, 'baseline_established');
  assert.equal(s0.trackingStatus, 'active');

  // Intermediate cycles at day 5, 10, 15, 20, 25
  let curr = s0;
  for (let day = 5; day <= 25; day += 5) {
    const t = t0 + (day * 86400000);
    curr = ShopLifecyclePolicy.evaluateObservation(curr, {
      value: 100,
      observedAt: new Date(t).toISOString(),
      quality: 'exact',
    });
    assert.equal(curr.trackingStatus, 'active');
  }

  // Exact boundary: 29 days 23 hours 59 minutes 59 seconds (1 second shy of 30 days)
  const t29d_end = t0 + (29 * 86400000) + (23 * 3600000) + (59 * 60000) + 59000;
  const res = ShopLifecyclePolicy.evaluateObservation(curr, {
    value: 100,
    observedAt: new Date(t29d_end).toISOString(),
    quality: 'exact',
  });

  assert.equal(res.trackingStatus, 'active', 'Shop MUST remain active at 29d 23h 59m 59s');
  assert.equal(res.action, 'window_maintained_active');
  assert.equal(res.reason, null);
  assert.equal(res.stateChanged, false);
});

test('CHALLENGE 1.2: 29d 23h 59m 59s 999ms with unchanged sales strictly remains active', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const s0 = {
    sales: 200,
    unchangedSince: new Date(t0).toISOString(),
    salesObservedAt: new Date(t0 + (25 * 86400000)).toISOString(),
    trackingStatus: 'active',
  };

  // 1 millisecond before 30 full days (2,591,999,999 ms elapsed)
  const tSubMs = t0 + CONSTANTS.SHOP_STOPPAGE_THRESHOLD_MS - 1;
  const res = ShopLifecyclePolicy.evaluateObservation(s0, {
    value: 200,
    observedAt: new Date(tSubMs).toISOString(),
    quality: 'exact',
  });

  assert.equal(res.trackingStatus, 'active', 'Must not stop 1ms before 30-day threshold');
  assert.equal(res.action, 'window_maintained_active');
});

test('CHALLENGE 1.3: Exactly 30d 00h 00m 00s (and 000ms) transitions to stopped', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const s0 = {
    sales: 500,
    unchangedSince: new Date(t0).toISOString(),
    salesObservedAt: new Date(t0 + (25 * 86400000)).toISOString(),
    trackingStatus: 'active',
  };

  // Exactly 30 days = 2,592,000,000 ms elapsed
  const t30d = t0 + CONSTANTS.SHOP_STOPPAGE_THRESHOLD_MS;
  const res = ShopLifecyclePolicy.evaluateObservation(s0, {
    value: 500,
    observedAt: new Date(t30d).toISOString(),
    quality: 'exact',
  });

  assert.equal(res.trackingStatus, 'stopped', 'Must transition to stopped at exactly 30d 00h 00m 00s');
  assert.equal(res.reason, 'shop_sales_unchanged_30d');
  assert.equal(res.action, 'shop_stopped_30d_unchanged');
  assert.equal(res.stateChanged, true);
});

test('CHALLENGE 1.4: Passive time passage / clock tick alone NEVER changes state to stopped without fresh observation', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const state = {
    sales: 50,
    unchangedSince: new Date(t0).toISOString(),
    salesObservedAt: new Date(t0).toISOString(),
    trackingStatus: 'active',
    reason: null,
  };

  // 60 days pass in the physical world
  const simulatedClockNow = t0 + (60 * 86400000);

  // Without dispatching evaluateObservation, the state object remains active
  assert.equal(state.trackingStatus, 'active');
  assert.equal(state.reason, null);

  // Stoppage occurs ONLY when fresh observation payload is evaluated
  const freshObsAtDay60 = {
    value: 50,
    observedAt: new Date(simulatedClockNow).toISOString(),
    quality: 'exact',
  };

  // But notice! Gap from t0 is 60 days > 7 days, so evaluating at Day 60 without intermediate observations breaks gap!
  const resDay60 = ShopLifecyclePolicy.evaluateObservation(state, freshObsAtDay60);
  assert.equal(resDay60.action, 'gap_broken_window_reset', 'Because no intermediate observations arrived, gap broke and shop stayed active!');
  assert.equal(resDay60.trackingStatus, 'active');
});

// =============================================================================
// CHALLENGE 2: 7-DAY GAP BOUNDARY PRECISION
// =============================================================================

test('CHALLENGE 2.1: Exactly 7 days (604,800,000 ms) gap preserves chain continuity', () => {
  const t0 = new Date('2026-09-01T12:00:00.000Z').getTime();
  const state = {
    sales: 100,
    unchangedSince: new Date(t0).toISOString(),
    salesObservedAt: new Date(t0).toISOString(),
    trackingStatus: 'active',
  };

  // Exactly 7 days = 604,800,000 ms
  const tExact7d = t0 + CONSTANTS.MAX_VALID_OBSERVATION_GAP_MS;
  const res = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 100,
    observedAt: new Date(tExact7d).toISOString(),
    quality: 'exact',
  });

  assert.equal(res.action, 'window_maintained_active', 'Exact 7-day gap must preserve chain continuity');
  assert.equal(res.unchangedSince, new Date(t0).toISOString(), 'unchangedSince anchor must not be altered');
  assert.equal(isGapBroken(new Date(t0).toISOString(), new Date(tExact7d).toISOString()), false);
});

test('CHALLENGE 2.2: Gap of 7 days + 1 ms (604,800,001 ms) breaks chain continuity', () => {
  const t0 = new Date('2026-09-01T12:00:00.000Z').getTime();
  const state = {
    sales: 100,
    unchangedSince: new Date(t0).toISOString(),
    salesObservedAt: new Date(t0).toISOString(),
    trackingStatus: 'active',
  };

  // 7 days + 1 millisecond = 604,800,001 ms
  const t7dPlus1ms = t0 + CONSTANTS.MAX_VALID_OBSERVATION_GAP_MS + 1;
  const obsTimeStr = new Date(t7dPlus1ms).toISOString();
  const res = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 100,
    observedAt: obsTimeStr,
    quality: 'exact',
  });

  assert.equal(res.action, 'gap_broken_window_reset', 'Gap of 7d + 1ms must break chain continuity');
  assert.equal(res.unchangedSince, obsTimeStr, 'unchangedSince MUST reset to current observation timestamp');
  assert.equal(res.stateChanged, true);
  assert.equal(res.trackingStatus, 'active');
  assert.equal(isGapBroken(new Date(t0).toISOString(), obsTimeStr), true);
});

test('CHALLENGE 2.3: Broken gap restarts 30-day accumulation clock from new observation', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  let state = { sales: null, unchangedSince: null };
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 75, observedAt: new Date(t0).toISOString() });

  // Advance 9 days without observation -> breaks gap
  const tDay9 = t0 + (9 * 86400000);
  state = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 75,
    observedAt: new Date(tDay9).toISOString(),
    quality: 'exact',
  });
  assert.equal(state.action, 'gap_broken_window_reset');
  assert.equal(state.unchangedSince, new Date(tDay9).toISOString());

  // Advance 25 days with normal 5-day cycle from Day 9 reset (now at Day 34 from t0)
  for (let d = 5; d <= 25; d += 5) {
    const t = tDay9 + (d * 86400000);
    state = ShopLifecyclePolicy.evaluateObservation(state, {
      value: 75,
      observedAt: new Date(t).toISOString(),
      quality: 'exact',
    });
    assert.equal(state.trackingStatus, 'active', `Must be active at Day 9 + ${d} (only ${d} days elapsed from reset)`);
  }

  // Reach 30 days from Day 9 reset (Day 9 + 30 days = Day 39 from t0)
  const tDay39 = tDay9 + (30 * 86400000);
  state = ShopLifecyclePolicy.evaluateObservation(state, {
    value: 75,
    observedAt: new Date(tDay39).toISOString(),
    quality: 'exact',
  });
  assert.equal(state.trackingStatus, 'stopped', 'Must stop once 30 continuous days elapse from reset anchor');
  assert.equal(state.reason, 'shop_sales_unchanged_30d');
});

// =============================================================================
// CHALLENGE 3: VALUE EDGE CASES & QUALITY REJECTION
// =============================================================================

test('CHALLENGE 3.1: Baseline established on sales = 0 and handles zero counts cleanly', () => {
  const initial = { sales: null, unchangedSince: null };
  const obs = { value: 0, observedAt: '2026-09-01T00:00:00.000Z', quality: 'exact' };

  const res = ShopLifecyclePolicy.evaluateObservation(initial, obs);
  assert.equal(res.action, 'baseline_established');
  assert.equal(res.sales, 0, 'Sales 0 must be preserved as number 0, not coerced to null or false');
  assert.equal(res.trackingStatus, 'active');

  // Next observation at Day 5 with sales = 0 maintains window
  const obsDay5 = { value: 0, observedAt: '2026-09-06T00:00:00.000Z', quality: 'exact' };
  const resDay5 = ShopLifecyclePolicy.evaluateObservation(res, obsDay5);
  assert.equal(resDay5.action, 'window_maintained_active');
  assert.equal(resDay5.sales, 0);
  assert.equal(resDay5.unchangedSince, '2026-09-01T00:00:00.000Z');
});

test('CHALLENGE 3.2: Sales decrease (recalibration) resets window anchor and does NOT stop shop', () => {
  const current = {
    sales: 150,
    unchangedSince: '2026-09-01T00:00:00.000Z',
    salesObservedAt: '2026-09-01T00:00:00.000Z',
    lastIncreaseObservedAt: '2026-09-01T00:00:00.000Z',
  };

  // Scraper sees sales decrease from 150 to 142 (Etsy order cancellation audit)
  const decreaseObs = { value: 142, observedAt: '2026-09-06T00:00:00.000Z', quality: 'recalibrated' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, decreaseObs);

  assert.equal(res.action, 'baseline_recalibrated_decrease');
  assert.equal(res.sales, 142);
  assert.equal(res.trackingStatus, 'active', 'Shop MUST remain active on sales decrease');
  assert.equal(res.unchangedSince, '2026-09-06T00:00:00.000Z', 'Window anchor MUST reset to date of recalibration');
  assert.equal(res.lastIncreaseObservedAt, '2026-09-01T00:00:00.000Z', 'last_increase_observed_at must NOT update to now');
});

test('CHALLENGE 3.3: Quality rejection: rounded badges ("10k") at Day 30 reject stoppage', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const current = {
    sales: 10000,
    unchangedSince: new Date(t0).toISOString(),
    salesObservedAt: new Date(t0 + (25 * 86400000)).toISOString(),
    trackingStatus: 'active',
  };

  // Day 30 observation with rounded badge (e.g. Etsy "10k" rounded counter)
  const t30d = t0 + (30 * 86400000);
  const roundedObs = {
    value: 10000,
    observedAt: new Date(t30d).toISOString(),
    quality: 'rounded',
  };

  const res = ShopLifecyclePolicy.evaluateObservation(current, roundedObs);
  assert.equal(res.action, 'quality_ineligible_for_stop');
  assert.equal(res.trackingStatus, 'active', 'Rounded quality must NEVER stop a shop');
  assert.equal(res.reason, null);
});

test('CHALLENGE 3.4: Quality rejection: estimated counts at Day 30 reject stoppage', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const current = {
    sales: 500,
    unchangedSince: new Date(t0).toISOString(),
    salesObservedAt: new Date(t0 + (25 * 86400000)).toISOString(),
    trackingStatus: 'active',
  };

  const t30d = t0 + (30 * 86400000);
  const estObs = {
    value: 500,
    observedAt: new Date(t30d).toISOString(),
    quality: 'estimated',
  };

  const res = ShopLifecyclePolicy.evaluateObservation(current, estObs);
  assert.equal(res.action, 'quality_ineligible_for_stop');
  assert.equal(res.trackingStatus, 'active', 'Estimated count must NEVER stop a shop');
  assert.equal(res.reason, null);
});

test('CHALLENGE 3.5: HTTP 429 or CAPTCHA at Day 30 does NOT stop shop', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const current = {
    sales: 300,
    unchangedSince: new Date(t0).toISOString(),
    salesObservedAt: new Date(t0 + (25 * 86400000)).toISOString(),
    trackingStatus: 'active',
    reason: null,
  };

  const t30d = t0 + (30 * 86400000);
  const rateLimitObs = {
    value: 300,
    observedAt: new Date(t30d).toISOString(),
    error: 'HTTP 429 Too Many Requests',
  };

  const res429 = ShopLifecyclePolicy.evaluateObservation(current, rateLimitObs);
  assert.equal(res429.action, 'error_ignored');
  assert.equal(res429.trackingStatus, 'active', 'HTTP 429 at Day 30 must not stop shop');
  assert.equal(res429.reason, null);

  const captchaObs = {
    value: 300,
    observedAt: new Date(t30d).toISOString(),
    error: 'Cloudflare CAPTCHA Challenge Triggered',
  };

  const resCaptcha = ShopLifecyclePolicy.evaluateObservation(current, captchaObs);
  assert.equal(resCaptcha.action, 'error_ignored');
  assert.equal(resCaptcha.trackingStatus, 'active', 'CAPTCHA at Day 30 must not stop shop');
});

// =============================================================================
// CHALLENGE 4: UI LABEL ACCURACY INVARIANTS (F17)
// =============================================================================

test('CHALLENGE 4.1: UI label renders exact Vietnamese string for stopped shop and null for others', () => {
  const stoppedState = {
    trackingStatus: 'stopped',
    reason: 'shop_sales_unchanged_30d',
  };
  const activeState = {
    trackingStatus: 'active',
    reason: null,
  };
  const pausedState = {
    trackingStatus: 'paused',
    reason: 'manual_pause',
  };

  assert.equal(ShopLifecyclePolicy.getUiLabel(stoppedState), 'Không quan sát thấy sales tăng trong 30 ngày');
  assert.equal(ShopLifecyclePolicy.getUiLabel(activeState), null);
  assert.equal(ShopLifecyclePolicy.getUiLabel(pausedState), null);

  // Invariant: does not say "30 ngày không ra đơn"
  assert.notEqual(ShopLifecyclePolicy.getUiLabel(stoppedState), '30 ngày không ra đơn');
  assert.notEqual(ShopLifecyclePolicy.getUiLabel(stoppedState), 'Không ra đơn');
});

// =============================================================================
// CHALLENGE 5: DATABASE INTEGRATION & METRIC SCOPE INVARIANT (F12)
// =============================================================================

test('CHALLENGE 5.1: applyShopObservation maintains strict metric scope isolation', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // Seed shop entity
  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'test-boundary-shop',
    identitySource: 'url',
    canonicalUrl: 'https://www.etsy.com/shop/test-boundary-shop',
  });

  // Seed listing in product_current
  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, current_sold, current_price, first_seen_at, last_seen_at)
    VALUES ('etsy:item-isolated-scope', 'etsy', 'handmade pottery', 'Pottery Mug', 'https://etsy.com/listing/123', 42, 29.99, now(), now())
  `).run();

  await ops.registerItemForMonitoring({
    itemUid: 'etsy:item-isolated-scope',
    entityId: entity.id,
    eligibility: 'ready',
    itemStatus: 'active',
  });

  // Execute shop probe with total shop sales = 85,000
  const probeRes = await ops.applyShopObservation(entity.id, {
    value: 85000,
    observedAt: '2026-09-01T10:00:00.000Z',
    quality: 'exact',
  });

  assert.equal(probeRes.action, 'baseline_established');
  assert.equal(probeRes.sales, 85000);

  // Check monitoring_entities
  const entRow = await ops.getEntity(entity.id);
  assert.equal(Number(entRow.sales), 85000);

  // Check product_current listing: current_sold MUST remain 42! Never 85,000!
  const product = await db.prepare('SELECT current_sold, current_price, status FROM product_current WHERE item_uid = ?').get('etsy:item-isolated-scope');
  assert.equal(product.current_sold, 42, 'Shop sales must NEVER pollute listing current_sold');
  assert.equal(product.status, 'active', 'Monitoring probe must NEVER mutate product_current.status');
});

test('CHALLENGE 5.2: applyShopObservation cascades stoppage to child items upon Day 30 stop', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'cascade-stop-shop',
    identitySource: 'id',
  });

  // Add 3 child items
  for (let i = 1; i <= 3; i++) {
    const uid = `etsy:child-item-${i}`;
    await db.prepare(`
      INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at)
      VALUES (?, 'etsy', 'q', 'title', 'url', now(), now())
    `).run(uid);

    await ops.registerItemForMonitoring({
      itemUid: uid,
      entityId: entity.id,
      eligibility: 'ready',
      itemStatus: 'active',
    });
  }

  // Day 0: Baseline
  await ops.applyShopObservation(entity.id, {
    value: 1000,
    observedAt: '2026-09-01T00:00:00.000Z',
    quality: 'exact',
  });

  // Day 30: Fresh observation matching baseline triggers stoppage
  const day30Res = await ops.applyShopObservation(entity.id, {
    value: 1000,
    observedAt: '2026-10-01T00:00:00.000Z',
    quality: 'exact',
  });

  assert.equal(day30Res.trackingStatus, 'stopped');
  assert.equal(day30Res.reason, 'shop_sales_unchanged_30d');

  // Verify child items are cascaded to paused
  const items = await ops.getChildItemsForEntity(entity.id);
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.equal(item.item_status, 'paused', 'Child item must be paused when parent shop stops');
  }
});
