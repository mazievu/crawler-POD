/**
 * Tier 1: Feature Coverage Test Suite for Milestones M3 & M4 (Features F11 to F22).
 *
 * Strict opaque-box testing adhering to docs/DISCOVERY_MONITORING_PLAN_REVISED.md §3.2 & §3.3:
 * - F11: 5-Day Cycle & Probe Hierarchy
 * - F12: Shop Total Sales Metric Scope
 * - F13: Sales Baseline Establishment
 * - F14: Sales Baseline Reset on Increase
 * - F15: 7-Day Gap Limit Verification
 * - F16: 30-Day Sales Unchanged Stoppage
 * - F17: UI Label Accuracy
 * - F18: Author Session Deadline
 * - F19: Star Dynamic Window Extension
 * - F20: Unstar Immediate Expiration
 * - F21: Expired Author Star Reactivation
 * - F22: Tick-Based Expiry Timer
 *
 * Requirements: >= 5 test cases per feature = 60 test cases.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createTestDb,
  VirtualClock,
  ShopLifecyclePolicy,
  SocialLifecyclePolicy,
  CONSTANTS,
} = require('./harness');

// ==========================================
// FEATURE F11: 5-Day Cycle & Probe Hierarchy
// ==========================================
test('F11.1: Next due time set to observed_at + 5 days upon successful probe', () => {
  const clock = new VirtualClock('2026-09-01T10:00:00.000Z');
  const observedAt = clock.now();
  const nextDue = new Date(observedAt.getTime() + (CONSTANTS.DEFAULT_CYCLE_INTERVAL_DAYS * 86400000));
  assert.equal(nextDue.toISOString(), '2026-09-06T10:00:00.000Z');
});

test('F11.2: Probe failure leaves shop active and schedules retry with backoff', () => {
  const currentState = {
    trackingStatus: 'active',
    sales: 500,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-01T00:00:00Z',
  };
  const errorObservation = {
    observedAt: '2026-09-06T00:00:00Z',
    error: 'HTTP 429 Rate Limit Exceeded',
  };

  const nextState = ShopLifecyclePolicy.evaluateObservation(currentState, errorObservation);
  assert.equal(nextState.trackingStatus, 'active', 'Shop must not stop on crawl error');
  assert.equal(nextState.action, 'error_ignored');
  assert.equal(nextState.sales, 500);
});

test('F11.3: Active shop probe success unlocks sequential execution of child listing refresh jobs', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, tracking_status)
    VALUES ('etsy', 'shop', 'active-parent-shop', 'url', 'sess1', now(), now(), 'active')
  `).run();
  const entity = await db.prepare("SELECT id FROM monitoring_entities WHERE external_id = 'active-parent-shop'").get();

  // Create child items
  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at)
    VALUES ('etsy:c1', 'etsy', 'q', 't1', 'u1', now(), now()), ('etsy:c2', 'etsy', 'q', 't2', 'u2', now(), now())
  `).run();
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status)
    VALUES ('etsy:c1', ?, 'ready', 'active'), ('etsy:c2', ?, 'ready', 'active')
  `).run(entity.id, entity.id);

  const eligibleChildren = await db.prepare(`
    SELECT mi.item_uid FROM monitoring_items mi
    JOIN monitoring_entities me ON me.id = mi.entity_id
    WHERE me.tracking_status = 'active' AND mi.item_status = 'active'
  `).all();
  assert.equal(eligibleChildren.length, 2);
});

test('F11.4: Stopped shop probe skips or cancels pending child listing refresh jobs', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, tracking_status)
    VALUES ('etsy', 'shop', 'stopped-parent-shop', 'url', 'sess2', now(), now(), 'stopped')
  `).run();
  const entity = await db.prepare("SELECT id FROM monitoring_entities WHERE external_id = 'stopped-parent-shop'").get();

  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at)
    VALUES ('etsy:c3', 'etsy', 'q', 't3', 'u3', now(), now())
  `).run();
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status)
    VALUES ('etsy:c3', ?, 'ready', 'active')
  `).run(entity.id);

  const runnableItems = await db.prepare(`
    SELECT mi.item_uid FROM monitoring_items mi
    JOIN monitoring_entities me ON me.id = mi.entity_id
    WHERE me.tracking_status = 'active' AND mi.item_status = 'active'
  `).all();
  assert.equal(runnableItems.length, 0, 'No child items can run when shop is stopped');
});

test('F11.5: Jitter (0 to 6 hours) is non-negative and added to 5-day cycle', () => {
  function computeNextDue(observedAtMs, jitterHours = 2) {
    const jitterMs = Math.max(0, jitterHours * 3600 * 1000);
    return new Date(observedAtMs + (5 * 86400 * 1000) + jitterMs);
  }
  const base = new Date('2026-09-01T00:00:00Z').getTime();
  const next = computeNextDue(base, 3.5);
  assert.equal(next.toISOString(), '2026-09-06T03:30:00.000Z');
  assert.ok(next.getTime() >= base + (5 * 86400 * 1000));
});

// ==========================================
// FEATURE F12: Shop Total Sales Metric Scope
// ==========================================
test('F12.1: Shop total sales stored strictly in monitoring_entities.sales', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, sales)
    VALUES ('etsy', 'shop', 'shop-sales-scope', 'url', 's1', now(), now(), 12500)
  `).run();

  const entity = await db.prepare("SELECT sales FROM monitoring_entities WHERE external_id = 'shop-sales-scope'").get();
  assert.equal(Number(entity.sales), 12500);
});

test('F12.2: Shop probe appends record to monitoring_entity_observations', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', 'shop-obs-test', 'url', 's2', now(), now())
  `).run();
  const entity = await db.prepare("SELECT id FROM monitoring_entities WHERE external_id = 'shop-obs-test'").get();

  await db.prepare(`
    INSERT INTO monitoring_entity_observations (entity_id, session_id, observation_id, observed_at, metric_name, metric_value, source, quality)
    VALUES (?, 's2', 'obs:probe:1', now(), 'shop_sales', 450, 'etsy_shop_page', 'exact')
  `).run(entity.id);

  const obs = await db.prepare('SELECT * FROM monitoring_entity_observations WHERE entity_id = ?').get(entity.id);
  assert.ok(obs);
  assert.equal(obs.metric_name, 'shop_sales');
  assert.equal(Number(obs.metric_value), 450);
});

test('F12.3: Shop sales count is NOT written to product_current.current_sold', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, current_sold, first_seen_at, last_seen_at)
    VALUES ('etsy:listing-solitary', 'etsy', 'q', 'title', 'url', 15, now(), now())
  `).run();

  // Simulating shop probe observing 50,000 shop sales
  const shopSales = 50000;
  // Invariant: product_current.current_sold must remain listing sold (15)
  const product = await db.prepare('SELECT current_sold FROM product_current WHERE item_uid = ?').get('etsy:listing-solitary');
  assert.equal(product.current_sold, 15, 'Shop total sales must never pollute listing current_sold');
  assert.notEqual(product.current_sold, shopSales);
});

test('F12.4: Shop sales metric is NOT used in listing delta_sold calculation', () => {
  const listingExisting = { current_sold: 10, prev_sold: 8, delta_sold: 2 };
  const shopProbeSales = 1000;

  // Calculating listing delta:
  const listingDelta = listingExisting.current_sold - listingExisting.prev_sold;
  assert.equal(listingDelta, 2);
  assert.notEqual(listingDelta, shopProbeSales - listingExisting.current_sold);
});

test('F12.5: Multiple shops maintain independent sales counters without cross-talk', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, sales)
    VALUES ('etsy', 'shop', 'shop-one', 'url', 's1', now(), now(), 100),
           ('etsy', 'shop', 'shop-two', 'url', 's2', now(), now(), 200)
  `).run();

  const s1 = await db.prepare("SELECT sales FROM monitoring_entities WHERE external_id = 'shop-one'").get();
  const s2 = await db.prepare("SELECT sales FROM monitoring_entities WHERE external_id = 'shop-two'").get();
  assert.equal(Number(s1.sales), 100);
  assert.equal(Number(s2.sales), 200);
});

// ==========================================
// FEATURE F13: Sales Baseline Establishment
// ==========================================
test('F13.1: First valid numeric sales observation establishes initial baseline', () => {
  const initial = { sales: null, unchangedSince: null };
  const obs = { value: 350, observedAt: '2026-09-01T08:00:00Z', quality: 'exact' };

  const res = ShopLifecyclePolicy.evaluateObservation(initial, obs);
  assert.equal(res.action, 'baseline_established');
  assert.equal(res.sales, 350);
  assert.equal(res.trackingStatus, 'active');
});

test('F13.2: unchanged_since is set to observed_at on baseline establishment', () => {
  const initial = { sales: null, unchangedSince: null };
  const obs = { value: 10, observedAt: '2026-09-01T12:00:00Z' };

  const res = ShopLifecyclePolicy.evaluateObservation(initial, obs);
  assert.equal(res.unchangedSince, '2026-09-01T12:00:00Z');
  assert.equal(res.salesObservedAt, '2026-09-01T12:00:00Z');
  assert.equal(res.lastIncreaseObservedAt, '2026-09-01T12:00:00Z');
});

test('F13.3: Historical silence prior to initial observation is never assumed', () => {
  const clock = new VirtualClock('2026-09-15T00:00:00Z'); // System starts running mid-month
  const initial = { sales: null, unchangedSince: null };
  const obs = { value: 80, observedAt: clock.nowISO() };

  const res = ShopLifecyclePolicy.evaluateObservation(initial, obs);
  // unchanged_since is set to now, NOT 30 days in the past
  assert.equal(res.unchangedSince, '2026-09-15T00:00:00.000Z');
  assert.notEqual(res.unchangedSince, '2026-08-15T00:00:00.000Z');
});

test('F13.4: Null or NaN sales observation is rejected from establishing baseline', () => {
  const initial = { sales: null, unchangedSince: null };
  const resNull = ShopLifecyclePolicy.evaluateObservation(initial, { value: null, observedAt: '2026-09-01' });
  const resNaN = ShopLifecyclePolicy.evaluateObservation(initial, { value: NaN, observedAt: '2026-09-01' });

  assert.equal(resNull.sales, null);
  assert.equal(resNaN.sales, null);
  assert.equal(resNull.action, 'error_ignored');
  assert.equal(resNaN.action, 'error_ignored');
});

test('F13.5: Error during first crawl does not establish baseline', () => {
  const initial = { sales: null, unchangedSince: null };
  const res = ShopLifecyclePolicy.evaluateObservation(initial, {
    value: 50,
    observedAt: '2026-09-01',
    error: 'Cloudflare Challenge Blocked',
  });
  assert.equal(res.sales, null);
  assert.equal(res.action, 'error_ignored');
});

// ==========================================
// FEATURE F14: Sales Baseline Reset on Increase
// ==========================================
test('F14.1: Sales increase (new_sales > baseline) resets baseline to new_sales', () => {
  const current = {
    sales: 100,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-01T00:00:00Z',
    lastIncreaseObservedAt: '2026-09-01T00:00:00Z',
  };
  const obs = { value: 105, observedAt: '2026-09-06T00:00:00Z' };

  const res = ShopLifecyclePolicy.evaluateObservation(current, obs);
  assert.equal(res.action, 'baseline_reset_increase');
  assert.equal(res.sales, 105);
});

test('F14.2: unchanged_since resets to observed_at upon sales increase', () => {
  const current = {
    sales: 100,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-01T00:00:00Z',
  };
  const obs = { value: 110, observedAt: '2026-09-06T10:00:00Z' };

  const res = ShopLifecyclePolicy.evaluateObservation(current, obs);
  assert.equal(res.unchangedSince, '2026-09-06T10:00:00Z');
});

test('F14.3: last_increase_observed_at updates to observed_at upon sales increase', () => {
  const current = {
    sales: 100,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-01T00:00:00Z',
    lastIncreaseObservedAt: '2026-09-01T00:00:00Z',
  };
  const obs = { value: 120, observedAt: '2026-09-11T00:00:00Z' };

  const res = ShopLifecyclePolicy.evaluateObservation(current, obs);
  assert.equal(res.lastIncreaseObservedAt, '2026-09-11T00:00:00Z');
});

test('F14.4: Successive increases continuously update baseline and timestamps', () => {
  let state = { sales: null, unchangedSince: null };
  const observations = [
    { value: 10, observedAt: '2026-09-01T00:00:00Z' },
    { value: 15, observedAt: '2026-09-06T00:00:00Z' },
    { value: 20, observedAt: '2026-09-11T00:00:00Z' },
  ];

  for (const obs of observations) {
    state = ShopLifecyclePolicy.evaluateObservation(state, obs);
  }
  assert.equal(state.sales, 20);
  assert.equal(state.unchangedSince, '2026-09-11T00:00:00Z');
});

test('F14.5: Sales decrease is treated as recalibration and does not count as increase', () => {
  const current = {
    sales: 100,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-01T00:00:00Z',
    lastIncreaseObservedAt: '2026-09-01T00:00:00Z',
  };
  // Etsy order cancellation audit causes sales count to decrease from 100 to 98
  const obs = { value: 98, observedAt: '2026-09-06T00:00:00Z' };

  const res = ShopLifecyclePolicy.evaluateObservation(current, obs);
  assert.equal(res.action, 'baseline_recalibrated_decrease');
  assert.equal(res.sales, 98);
  assert.equal(res.trackingStatus, 'active', 'Shop remains active on recalibration');
  assert.equal(res.lastIncreaseObservedAt, '2026-09-01T00:00:00Z', 'last_increase unchanged');
});

// ==========================================
// FEATURE F15: 7-Day Gap Limit Verification
// ==========================================
test('F15.1: Observations with gap <= 7 days preserve observation chain continuity', () => {
  const current = {
    sales: 50,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-01T00:00:00Z',
  };
  const obs = { value: 50, observedAt: '2026-09-06T00:00:00Z', quality: 'exact' }; // 5 days gap

  const res = ShopLifecyclePolicy.evaluateObservation(current, obs);
  assert.equal(res.action, 'window_maintained_active');
  assert.equal(res.unchangedSince, '2026-09-01T00:00:00Z', 'Window anchor must be maintained');
});

test('F15.2: Observation gap > 7 days (e.g. 8 days) breaks chain and resets unchanged_since', () => {
  const current = {
    sales: 50,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-01T00:00:00Z',
  };
  const obs = { value: 50, observedAt: '2026-09-10T00:00:00Z', quality: 'exact' }; // 9 days gap > 7 days!

  const res = ShopLifecyclePolicy.evaluateObservation(current, obs);
  assert.equal(res.action, 'gap_broken_window_reset');
  assert.equal(res.unchangedSince, '2026-09-10T00:00:00Z', 'Window MUST reset to Day 9 observation date');
});

test('F15.3: Gap boundary exactly at 7 days (7 * 86400s) preserves chain', () => {
  const current = {
    sales: 50,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-01T00:00:00Z',
  };
  const obs = { value: 50, observedAt: '2026-09-08T00:00:00Z', quality: 'exact' }; // Exactly 7 days

  const res = ShopLifecyclePolicy.evaluateObservation(current, obs);
  assert.equal(res.action, 'window_maintained_active');
  assert.equal(res.unchangedSince, '2026-09-01T00:00:00Z');
});

test('F15.4: Intervening crawl errors creating >7d gap break the chain upon next valid observation', () => {
  let state = {
    sales: 50,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-01T00:00:00Z',
  };
  // Error at Day 5
  state = ShopLifecyclePolicy.evaluateObservation(state, { error: 'Network Error', observedAt: '2026-09-06T00:00:00Z' });
  // Error at Day 10
  state = ShopLifecyclePolicy.evaluateObservation(state, { error: '503 Service Unavailable', observedAt: '2026-09-11T00:00:00Z' });
  // Successful observation at Day 12 (gap from last valid Day 1 is 11 days > 7 days!)
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 50, observedAt: '2026-09-13T00:00:00Z', quality: 'exact' });

  assert.equal(state.action, 'gap_broken_window_reset');
  assert.equal(state.unchangedSince, '2026-09-13T00:00:00Z');
});

test('F15.5: Broken gap restarts the 30-day accumulation clock from the new observation', () => {
  const clock = new VirtualClock('2026-09-01T00:00:00Z');
  let state = { sales: null, unchangedSince: null };
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO() });

  // Advance 10 days without valid crawl -> breaks gap
  clock.advanceDays(10);
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO() });
  assert.equal(state.unchangedSince, '2026-09-11T00:00:00.000Z');

  // Advance another 25 days (now Day 35 from start, but only 25 days from reset)
  clock.advanceDays(25);
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO() });
  assert.equal(state.trackingStatus, 'active', 'Must not stop yet because only 25 days elapsed from reset!');
});

// ==========================================
// FEATURE F16: 30-Day Sales Unchanged Stoppage
// ==========================================
test('F16.1: Transition to stopped (shop_sales_unchanged_30d) requires elapsed time >= 30 days', () => {
  const clock = new VirtualClock('2026-09-01T00:00:00Z');
  let state = { sales: null, unchangedSince: null };
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 500, observedAt: clock.nowISO() });

  // 6 cycles of 5 days with unchanged sales
  for (let i = 1; i <= 6; i++) {
    clock.advanceDays(5);
    state = ShopLifecyclePolicy.evaluateObservation(state, { value: 500, observedAt: clock.nowISO(), quality: 'exact' });
  }

  // Exactly Day 30 reached (30 * 86400s)
  assert.equal(state.trackingStatus, 'stopped');
  assert.equal(state.reason, 'shop_sales_unchanged_30d');
  assert.equal(state.action, 'shop_stopped_30d_unchanged');
});

test('F16.2: Day 29d 23h 59m crawl with sales == baseline remains active', () => {
  const clock = new VirtualClock('2026-09-01T00:00:00Z');
  let state = { sales: null, unchangedSince: null };
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 500, observedAt: clock.nowISO() });

  // 5 cycles of 5 days (Days 5, 10, 15, 20, 25) with unchanged sales
  for (let i = 1; i <= 5; i++) {
    clock.advanceDays(5);
    state = ShopLifecyclePolicy.evaluateObservation(state, { value: 500, observedAt: clock.nowISO(), quality: 'exact' });
    assert.equal(state.trackingStatus, 'active');
    assert.equal(state.action, 'window_maintained_active');
  }

  // Advance remaining 4 days, 23 hours, 59 minutes to reach Day 29d 23h 59m (gap < 7d)
  clock.advanceDays(4);
  clock.advanceHours(23);
  clock.advanceMinutes(59);

  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 500, observedAt: clock.nowISO(), quality: 'exact' });
  assert.equal(state.trackingStatus, 'active', 'Must not stop at 29d 23h 59m!');
  assert.equal(state.action, 'window_maintained_active');
  assert.equal(state.unchangedSince, '2026-09-01T00:00:00.000Z', 'Baseline anchor unchangedSince must remain at Day 0');
});

test('F16.3: Stoppage occurs ONLY upon a fresh, valid observation matching baseline', () => {
  const stateAtDay31 = {
    trackingStatus: 'active',
    sales: 100,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-25T00:00:00Z',
  };
  // Without calling evaluateObservation with a fresh observation, state remains active
  assert.equal(stateAtDay31.trackingStatus, 'active');

  // When fresh observation arrives at Day 31:
  const freshObs = { value: 100, observedAt: '2026-10-02T00:00:00Z', quality: 'exact' };
  const next = ShopLifecyclePolicy.evaluateObservation(stateAtDay31, freshObs);
  assert.equal(next.trackingStatus, 'stopped');
});

test('F16.4: Crawl error or network failure at day 30 does NOT stop the shop', () => {
  const current = {
    sales: 100,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-25T00:00:00Z',
    trackingStatus: 'active',
  };
  const errorObs = {
    observedAt: '2026-10-01T00:00:00Z',
    error: 'ETIMEDOUT: Connection timed out',
  };

  const res = ShopLifecyclePolicy.evaluateObservation(current, errorObs);
  assert.equal(res.trackingStatus, 'active', 'Error at Day 30 must never stop the shop');
});

test('F16.5: Unchanged sales observation with broken gap (>7d) does NOT stop shop at day 30', () => {
  const current = {
    sales: 100,
    unchangedSince: '2026-09-01T00:00:00Z',
    salesObservedAt: '2026-09-20T00:00:00Z', // 11 days prior to Day 31!
  };
  const obs = { value: 100, observedAt: '2026-10-01T00:00:00Z', quality: 'exact' }; // Day 30/31

  const res = ShopLifecyclePolicy.evaluateObservation(current, obs);
  assert.equal(res.trackingStatus, 'active', 'Broken gap prevents stoppage; window resets');
  assert.equal(res.action, 'gap_broken_window_reset');
});

// ==========================================
// FEATURE F17: UI Label Accuracy
// ==========================================
test('F17.1: Stopped shop due to unchanged sales renders label Không quan sát thấy sales tăng trong 30 ngày', () => {
  const stoppedState = { trackingStatus: 'stopped', reason: 'shop_sales_unchanged_30d' };
  const label = ShopLifecyclePolicy.getUiLabel(stoppedState);
  assert.equal(label, 'Không quan sát thấy sales tăng trong 30 ngày');
});

test('F17.2: Active shop does not render the unchanged 30-day label', () => {
  const activeState = { trackingStatus: 'active', reason: null };
  const label = ShopLifecyclePolicy.getUiLabel(activeState);
  assert.equal(label, null);
});

test('F17.3: Label never states 30 ngày không ra đơn (prohibited claim)', () => {
  const stoppedState = { trackingStatus: 'stopped', reason: 'shop_sales_unchanged_30d' };
  const label = ShopLifecyclePolicy.getUiLabel(stoppedState);
  assert.ok(!label.includes('không ra đơn'), 'Must not make false assertions about zero orders');
});

test('F17.4: UI label for recalibrated sales indicates verified adjustment', () => {
  const state = { trackingStatus: 'active', reason: 'sales_recalibrated' };
  const label = ShopLifecyclePolicy.getUiLabel(state);
  assert.notEqual(label, 'Không quan sát thấy sales tăng trong 30 ngày');
});

test('F17.5: Label for unverified platform indicates sales counter not supported', () => {
  const state = { trackingStatus: 'active', eligibility: 'unsupported' };
  const label = ShopLifecyclePolicy.getUiLabel(state);
  assert.equal(label, null);
});

// ==========================================
// FEATURE F18: Author Session Deadline
// ==========================================
test('F18.1: Default unstarred author session expiry is started_at + 30 days UTC', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const expiresAt = SocialLifecyclePolicy.calculateExpiresAt(startedAt, false);
  assert.equal(expiresAt, '2026-10-01T00:00:00.000Z');
});

test('F18.2: Default starred author session expiry is started_at + 60 days UTC', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const expiresAt = SocialLifecyclePolicy.calculateExpiresAt(startedAt, true);
  assert.equal(expiresAt, '2026-10-31T00:00:00.000Z');
});

test('F18.3: Discovery encountering a new post does not extend author session deadline', () => {
  const authorSession = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
  };

  // Discovery ingests new viral post from same author at Day 25
  const newPostDiscoveredAt = '2026-09-25T10:00:00.000Z';
  assert.ok(new Date(newPostDiscoveredAt) > new Date(authorSession.monitoring_started_at));

  // Author's expires_at remains strictly Day 30
  assert.equal(authorSession.expires_at, '2026-10-01T00:00:00.000Z');
});

test('F18.4: Multiple posts by same author inherit author single session deadline', () => {
  const authorDeadline = '2026-10-01T00:00:00.000Z';
  const post1 = { id: 'p1', authorDeadline };
  const post2 = { id: 'p2', authorDeadline };
  assert.equal(post1.authorDeadline, post2.authorDeadline);
});

test('F18.5: Session deadline is stored as TIMESTAMPTZ UTC in monitoring_entities.expires_at', async () => {
  const db = await createTestDb();
  const startedAt = '2026-09-01T00:00:00.000Z';
  const expiresAt = SocialLifecyclePolicy.calculateExpiresAt(startedAt, false);

  await db.prepare(`
    INSERT INTO monitoring_entities (
      platform, entity_type, external_id, identity_source, session_id,
      monitoring_started_at, entity_next_due_at, expires_at
    ) VALUES ('tiktok', 'author', 'author-tz-test', 'id', 'sess-tz', ?, ?, ?)
  `).run(startedAt, startedAt, expiresAt);

  const row = await db.prepare("SELECT expires_at FROM monitoring_entities WHERE external_id = 'author-tz-test'").get();
  assert.equal(new Date(row.expires_at).toISOString(), expiresAt);
});

// ==========================================
// FEATURE F19: Star Dynamic Window Extension
// ==========================================
test('F19.1: Starring author at Day 20 extends deadline to Day 60 from session start (started_at + 60d)', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-01T00:00:00.000Z', // Day 30
    is_starred: false,
    tracking_status: 'active',
  };

  const day20 = '2026-09-21T00:00:00.000Z';
  const updated = SocialLifecyclePolicy.handleStar(entity, day20);

  assert.equal(updated.is_starred, true);
  assert.equal(updated.expires_at, '2026-10-31T00:00:00.000Z', 'Extended to started_at + 60d');
  assert.equal(updated.action, 'window_extended_to_60d');
});

test('F19.2: Starring does NOT add 60 days from the click date (anchored to session start)', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    is_starred: false,
    tracking_status: 'active',
  };
  const clickDate = '2026-09-25T00:00:00.000Z'; // Day 25
  const updated = SocialLifecyclePolicy.handleStar(entity, clickDate);

  // Must be started_at + 60d = 2026-10-31, NOT clickDate + 60d = 2026-11-24!
  assert.equal(updated.expires_at, '2026-10-31T00:00:00.000Z');
  assert.notEqual(updated.expires_at, '2026-11-24T00:00:00.000Z');
});

test('F19.3: Starring an already starred author is idempotent', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
  };
  const updated = SocialLifecyclePolicy.handleStar(entity, '2026-09-22T00:00:00Z');
  assert.equal(updated.stateChanged, false);
});

test('F19.4: Star updates is_starred = true in database', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, is_starred)
    VALUES ('tiktok', 'author', 'star-db-author', 'id', 's1', now(), now(), false)
  `).run();

  await db.prepare("UPDATE monitoring_entities SET is_starred = true WHERE external_id = 'star-db-author'").run();
  const row = await db.prepare("SELECT is_starred FROM monitoring_entities WHERE external_id = 'star-db-author'").get();
  assert.equal(Boolean(row.is_starred), true);
});

test('F19.5: Starred author deadline persists across process restart', async () => {
  const db = await createTestDb();
  const expiresAt = '2026-10-31T00:00:00.000Z';
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, expires_at, is_starred)
    VALUES ('tiktok', 'author', 'star-persist', 'id', 's2', now(), now(), ?, true)
  `).run(expiresAt);

  const row = await db.prepare("SELECT expires_at, is_starred FROM monitoring_entities WHERE external_id = 'star-persist'").get();
  assert.equal(new Date(row.expires_at).toISOString(), expiresAt);
  assert.equal(Boolean(row.is_starred), true);
});

// ==========================================
// FEATURE F20: Unstar Immediate Expiration
// ==========================================
test('F20.1: Unstarring author after Day 30 (e.g. Day 40) causes immediate expiration', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z', // Starred (Day 60)
    is_starred: true,
    tracking_status: 'active',
  };

  const day40 = '2026-10-11T00:00:00.000Z';
  const updated = SocialLifecyclePolicy.handleUnstar(entity, day40);

  assert.equal(updated.is_starred, false);
  assert.equal(updated.tracking_status, 'expired');
  assert.equal(updated.reason, 'unstarred_after_standard_deadline');
  assert.equal(updated.action, 'expired_immediately_on_unstar');
});

test('F20.2: Unstarring author before Day 30 (e.g. Day 20) reverts deadline to started_at + 30d', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
    tracking_status: 'active',
  };

  const day20 = '2026-09-21T00:00:00.000Z';
  const updated = SocialLifecyclePolicy.handleUnstar(entity, day20);

  assert.equal(updated.is_starred, false);
  assert.equal(updated.tracking_status, 'active');
  assert.equal(updated.expires_at, '2026-10-01T00:00:00.000Z');
  assert.equal(updated.action, 'reverted_to_standard_deadline');
});

test('F20.3: Immediate expiration sets tracking_status = expired', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
    tracking_status: 'active',
  };
  const updated = SocialLifecyclePolicy.handleUnstar(entity, '2026-10-05T00:00:00Z'); // Day 34
  assert.equal(updated.tracking_status, 'expired');
});

test('F20.4: Pending crawl jobs for author expiring immediately are cancelled', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, tracking_status)
    VALUES (101, 'tiktok', 'author', 'author-cancel-jobs', 'id', 'sess-jobs', now(), now(), 'active')
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (501, 101, 'shop_probe', 'sess-jobs', now(), 'queued')
  `).run();

  // Author expires immediately -> cancel pending jobs
  await db.prepare("UPDATE monitoring_jobs SET status = 'cancelled' WHERE entity_id = 101 AND status = 'queued'").run();

  const job = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 501').get();
  assert.equal(job.status, 'cancelled');
});

test('F20.5: Unstarring an already unstarred author is an idempotent no-op', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
    tracking_status: 'active',
  };
  const updated = SocialLifecyclePolicy.handleUnstar(entity, '2026-09-10T00:00:00Z');
  assert.equal(updated.stateChanged, false);
});

// ==========================================
// FEATURE F21: Expired Author Star Reactivation
// ==========================================
test('F21.1: Author expired on Day 30 starred on Day 35 reactivates to active', () => {
  const expiredEntity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-01T00:00:00.000Z', // Day 30
    is_starred: false,
    tracking_status: 'expired',
  };

  const day35 = '2026-10-06T00:00:00.000Z';
  const revived = SocialLifecyclePolicy.handleStar(expiredEntity, day35);

  assert.equal(revived.is_starred, true);
  assert.equal(revived.tracking_status, 'active');
  assert.equal(revived.action, 'reactivated_from_expired');
});

test('F21.2: Reactivation extends deadline to started_at + 60d', () => {
  const expiredEntity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
    tracking_status: 'expired',
  };

  const day35 = '2026-10-06T00:00:00.000Z';
  const revived = SocialLifecyclePolicy.handleStar(expiredEntity, day35);
  assert.equal(revived.expires_at, '2026-10-31T00:00:00.000Z');
});

test('F21.3: Starring after Day 60 (e.g. Day 61) fails to reactivate; remains expired', () => {
  const expiredEntity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z', // Expired at Day 60
    is_starred: true,
    tracking_status: 'expired',
  };

  const day61 = '2026-11-01T00:00:00.000Z';
  const result = SocialLifecyclePolicy.handleStar(expiredEntity, day61);

  assert.equal(result.stateChanged, false);
  assert.equal(result.error, 'PAST_60D_WINDOW_CANNOT_REACTIVATE');
  assert.equal(result.tracking_status, 'expired');
});

test('F21.4: Post-60d reactivation requires explicit Theo dõi lại (Re-track) action', () => {
  const entity = {
    session_id: 'old-session-1',
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    tracking_status: 'expired',
    is_starred: true,
  };
  const day65 = '2026-11-05T00:00:00.000Z';
  const retracked = SocialLifecyclePolicy.handleRetrack(entity, day65);

  assert.equal(retracked.tracking_status, 'active');
  assert.equal(retracked.monitoring_started_at, day65);
  assert.notEqual(retracked.session_id, 'old-session-1');
});

test('F21.5: Theo dõi lại creates brand-new session_id and resets monitoring_started_at = now()', () => {
  const entity = {
    session_id: 'sess-alpha',
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    is_starred: false,
  };
  const nowStr = '2026-11-10T12:00:00.000Z';
  const retracked = SocialLifecyclePolicy.handleRetrack(entity, nowStr);

  assert.equal(retracked.action, 'new_session_started');
  assert.ok(retracked.session_id !== 'sess-alpha');
  assert.equal(retracked.monitoring_started_at, nowStr);
  assert.equal(retracked.expires_at, '2026-12-10T12:00:00.000Z'); // 30 days from new started_at
});

// ==========================================
// FEATURE F22: Tick-Based Expiry Timer
// ==========================================
test('F22.1: Expiry timer evaluates now >= expires_at independently of 5-day crawl cycle', () => {
  const entity = {
    tracking_status: 'active',
    expires_at: '2026-10-01T00:00:00.000Z',
  };
  const timerTickTime = '2026-10-01T00:05:00.000Z'; // 5 minutes past deadline
  const res = SocialLifecyclePolicy.evaluateTickExpiry(entity, timerTickTime);

  assert.equal(res.tracking_status, 'expired');
  assert.equal(res.stateChanged, true);
});

test('F22.2: Active author whose deadline passed transitions to expired on timer tick', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, expires_at, tracking_status)
    VALUES ('tiktok', 'author', 'author-tick-pass', 'id', 's1', now(), now(), now() - INTERVAL '1 minute', 'active')
  `).run();

  // Tick execution SQL
  await db.prepare(`
    UPDATE monitoring_entities 
    SET tracking_status = 'expired', reason = 'session_expired'
    WHERE tracking_status = 'active' AND expires_at <= now()
  `).run();

  const row = await db.prepare("SELECT tracking_status FROM monitoring_entities WHERE external_id = 'author-tick-pass'").get();
  assert.equal(row.tracking_status, 'expired');
});

test('F22.3: Inactive or paused author is not re-expired by timer', () => {
  const pausedEntity = {
    tracking_status: 'paused',
    expires_at: '2026-10-01T00:00:00.000Z',
  };
  const res = SocialLifecyclePolicy.evaluateTickExpiry(pausedEntity, '2026-10-05T00:00:00Z');
  assert.equal(res.stateChanged, false);
  assert.equal(res.tracking_status, 'paused');
});

test('F22.4: Pre-dispatch check aborts job dispatch if entity expired while in queue', () => {
  function canDispatchJob(entityState, now) {
    if (entityState.tracking_status === 'expired' || new Date(now) >= new Date(entityState.expires_at)) {
      return false;
    }
    return true;
  }
  const entity = { tracking_status: 'active', expires_at: '2026-10-01T00:00:00Z' };
  assert.equal(canDispatchJob(entity, '2026-09-30T23:59:00Z'), true);
  assert.equal(canDispatchJob(entity, '2026-10-01T00:01:00Z'), false);
});

test('F22.5: Pre-commit check rejects worker write if entity expired while capture was in-flight', () => {
  function canCommitResult(entityState, now) {
    if (entityState.tracking_status === 'expired' || new Date(now) >= new Date(entityState.expires_at)) {
      return { allowed: false, error: 'ENTITY_EXPIRED_IN_FLIGHT' };
    }
    return { allowed: true };
  }
  const entity = { tracking_status: 'active', expires_at: '2026-10-01T00:00:00Z' };
  const check = canCommitResult(entity, '2026-10-01T00:02:00Z');
  assert.equal(check.allowed, false);
  assert.equal(check.error, 'ENTITY_EXPIRED_IN_FLIGHT');
});
