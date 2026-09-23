/**
 * Challenger 2 Verification Suite (Milestone 3 Iteration 2):
 * Probe Hierarchy, Job Cancellation, Schema Invariants & Metric Isolation
 *
 * Authoritative SSOT:
 * - docs/DISCOVERY_MONITORING_PLAN_REVISED.md §3.2 & §4
 * - .agents/ORIGINAL_REQUEST.md
 *
 * Empirical Challenges:
 * 1. Job Cancellation Query & Schema Invariants:
 *    - Child item refresh jobs where entity_id matches shop -> CANCELLED
 *    - Child item refresh jobs where entity_id IS NULL but item_id belongs to shop's child item -> CANCELLED
 *    - Non-queued jobs (claimed, running) -> UNTOUCHED
 *    - Jobs of other shops -> UNTOUCHED
 *    - Shop probe jobs -> UNTOUCHED
 *    - Zero failure from column "updated_at" on monitoring_jobs (monitoring_jobs lacks updated_at)
 * 2. Child Items Cascade:
 *    - Active child items transition to 'paused' with updated_at refreshed
 *    - Non-active child items (unavailable) preserve their status
 *    - Items of other shops remain active
 * 3. Product Current Status Immutability:
 *    - product_current.status is strictly untouched across all listing statuses ('active', 'new', 'dropped')
 * 4. Metric Isolation:
 *    - monitoring_entities.sales stores shop aggregate sales (e.g. 150,000)
 *    - product_current.current_sold strictly isolated, never polluted by shop sales
 * 5. Numeric Timestamp Hardening:
 *    - Numeric epoch ms and numeric strings parsed cleanly without 'Z' corruption or error_ignored
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { fromDriver } = require('../../src/database/pg-client');
const { createMonitoringOps } = require('../../src/database/monitoring');
const { ShopLifecyclePolicy, CONSTANTS } = require('../../src/monitoring/shop-lifecycle');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'pg-schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

/**
 * Helper to create an isolated PGlite in-memory database with the full schema.
 */
async function createIsolatedTestDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const driver = new PGlite();
  const db = fromDriver(driver);
  await db.exec(SCHEMA_SQL);
  return db;
}

// =============================================================================
// CHALLENGE 1: JOB CANCELLATION QUERY & UPDATED_AT COLUMN INVARIANTS
// =============================================================================

test('CHALLENGE 1.1: applyShopObservation cancels queued item_refresh jobs matching shop entity_id', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // 1. Create shop entity
  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-test-1-1',
    identitySource: 'id',
  });

  // 2. Insert listing and register monitoring item
  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at, status)
    VALUES ('etsy:listing-1-1', 'etsy', 'q', 'Listing 1', 'https://etsy.com/1', now(), now(), 'active');
  `).run();

  const item = await ops.registerItemForMonitoring({
    itemUid: 'etsy:listing-1-1',
    entityId: entity.id,
    eligibility: 'ready',
    itemStatus: 'active',
  });

  // 3. Queue item_refresh job WITH entity_id set
  await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for, status)
    VALUES (?, ?, 'item_refresh', 'sess-1', now(), 'queued');
  `).run(entity.id, item.id);

  // 4. Day 0 baseline
  await ops.applyShopObservation(entity.id, {
    value: 500,
    observedAt: '2026-09-01T00:00:00.000Z',
    quality: 'exact',
  });

  // 5. Day 30 stoppage trigger
  const res = await ops.applyShopObservation(entity.id, {
    value: 500,
    observedAt: '2026-10-01T00:00:00.000Z',
    quality: 'exact',
  });

  assert.equal(res.trackingStatus, 'stopped');
  assert.equal(res.reason, 'shop_sales_unchanged_30d');

  // 6. Verify job status is 'cancelled'
  const job = await db.prepare('SELECT status FROM monitoring_jobs WHERE entity_id = ? AND item_id = ?').get(entity.id, item.id);
  assert.ok(job, 'Job should exist');
  assert.equal(job.status, 'cancelled', 'Queued item_refresh job with entity_id MUST be cancelled when shop stops');
});

test('CHALLENGE 1.2: applyShopObservation cancels queued item_refresh jobs where entity_id IS NULL but item_id belongs to shop', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-test-1-2',
    identitySource: 'id',
  });

  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at, status)
    VALUES ('etsy:listing-1-2', 'etsy', 'q', 'Listing 2', 'https://etsy.com/2', now(), now(), 'active');
  `).run();

  const item = await ops.registerItemForMonitoring({
    itemUid: 'etsy:listing-1-2',
    entityId: entity.id,
    eligibility: 'ready',
    itemStatus: 'active',
  });

  // CRITICAL TEST: Queue item_refresh job where entity_id IS NULL!
  // Per chk_monitoring_jobs_target constraint: (kind = 'item_refresh' AND item_id IS NOT NULL) allows entity_id IS NULL!
  await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for, status)
    VALUES (NULL, ?, 'item_refresh', 'sess-1-2', now(), 'queued');
  `).run(item.id);

  // Baseline Day 0
  await ops.applyShopObservation(entity.id, {
    value: 1200,
    observedAt: '2026-09-01T00:00:00.000Z',
    quality: 'exact',
  });

  // Day 30 Stoppage
  await ops.applyShopObservation(entity.id, {
    value: 1200,
    observedAt: '2026-10-01T00:00:00.000Z',
    quality: 'exact',
  });

  // Verify job with entity_id IS NULL is ALSO cancelled!
  const job = await db.prepare('SELECT id, entity_id, item_id, status FROM monitoring_jobs WHERE item_id = ?').get(item.id);
  assert.ok(job);
  assert.equal(job.entity_id, null);
  assert.equal(job.status, 'cancelled', 'Queued item_refresh job with NULL entity_id MUST be cancelled via child item linkage');
});

test('CHALLENGE 1.3: Schema invariant - monitoring_jobs has NO updated_at column and query does not throw', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // Inspect table schema for monitoring_jobs
  const columns = await db.prepare(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'monitoring_jobs' AND table_schema = current_schema();
  `).all();
  const columnNames = new Set(columns.map(c => c.column_name));

  assert.equal(columnNames.has('updated_at'), false, 'monitoring_jobs schema MUST NOT have updated_at column');
  assert.equal(columnNames.has('created_at'), true, 'monitoring_jobs schema has created_at');
  assert.equal(columnNames.has('started_at'), true, 'monitoring_jobs schema has started_at');
  assert.equal(columnNames.has('finished_at'), true, 'monitoring_jobs schema has finished_at');

  // Verify that applyShopObservation completes without throwing column error
  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-test-1-3',
    identitySource: 'id',
  });

  await ops.applyShopObservation(entity.id, {
    value: 800,
    observedAt: '2026-09-01T00:00:00.000Z',
    quality: 'exact',
  });

  await assert.doesNotReject(async () => {
    await ops.applyShopObservation(entity.id, {
      value: 800,
      observedAt: '2026-10-01T00:00:00.000Z',
      quality: 'exact',
    });
  }, 'applyShopObservation MUST NOT fail with updated_at column error on stoppage');
});

test('CHALLENGE 1.4: Job status selectivity - already claimed or running jobs are NOT cancelled', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-test-1-4',
    identitySource: 'id',
  });

  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at, status)
    VALUES
      ('etsy:item-claimed', 'etsy', 'q', 'Claimed', 'https://etsy.com/c', now(), now(), 'active'),
      ('etsy:item-running', 'etsy', 'q', 'Running', 'https://etsy.com/r', now(), now(), 'active');
  `).run();

  const item1 = await ops.registerItemForMonitoring({ itemUid: 'etsy:item-claimed', entityId: entity.id });
  const item2 = await ops.registerItemForMonitoring({ itemUid: 'etsy:item-running', entityId: entity.id });

  // Insert jobs in 'claimed' and 'running' state
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, item_id, kind, session_id, scheduled_for, status, claim_token)
    VALUES
      (1001, ?, ?, 'item_refresh', 'sess-1', now(), 'claimed', 'token-1'),
      (1002, ?, ?, 'item_refresh', 'sess-2', now(), 'running', 'token-2');
  `).run(entity.id, item1.id, entity.id, item2.id);

  // Baseline and Stoppage
  await ops.applyShopObservation(entity.id, { value: 300, observedAt: '2026-09-01T00:00:00Z', quality: 'exact' });
  await ops.applyShopObservation(entity.id, { value: 300, observedAt: '2026-10-01T00:00:00Z', quality: 'exact' });

  // Verify claimed and running jobs are intact
  const j1 = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 1001').get();
  const j2 = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 1002').get();

  assert.equal(j1.status, 'claimed', 'In-flight claimed job must NOT be mutated to cancelled');
  assert.equal(j2.status, 'running', 'In-flight running job must NOT be mutated to cancelled');
});

test('CHALLENGE 1.5: Job kind selectivity - shop_probe jobs are NOT cancelled by item_refresh cancellation', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-test-1-5',
    identitySource: 'id',
  });

  // Future scheduled shop_probe job
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, item_id, kind, session_id, scheduled_for, status)
    VALUES (2001, ?, NULL, 'shop_probe', 'sess-probe-future', now() + interval '5 days', 'queued');
  `).run(entity.id);

  await ops.applyShopObservation(entity.id, { value: 300, observedAt: '2026-09-01T00:00:00Z', quality: 'exact' });
  await ops.applyShopObservation(entity.id, { value: 300, observedAt: '2026-10-01T00:00:00Z', quality: 'exact' });

  const probeJob = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 2001').get();
  assert.equal(probeJob.status, 'queued', 'Shop probe job must NOT be cancelled by item_refresh cancellation clause');
});

test('CHALLENGE 1.6: Shop boundary isolation - jobs of other shops are strictly untouched', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // Shop A (stopping) and Shop B (active)
  const shopA = await ops.createOrGetEntity({ platform: 'etsy', entityType: 'shop', externalId: 'shop-A', identitySource: 'id' });
  const shopB = await ops.createOrGetEntity({ platform: 'etsy', entityType: 'shop', externalId: 'shop-B', identitySource: 'id' });

  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at, status)
    VALUES
      ('etsy:item-A', 'etsy', 'q', 'Title A', 'https://etsy.com/A', now(), now(), 'active'),
      ('etsy:item-B', 'etsy', 'q', 'Title B', 'https://etsy.com/B', now(), now(), 'active');
  `).run();

  const itemA = await ops.registerItemForMonitoring({ itemUid: 'etsy:item-A', entityId: shopA.id });
  const itemB = await ops.registerItemForMonitoring({ itemUid: 'etsy:item-B', entityId: shopB.id });

  // Jobs for both shops
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, item_id, kind, session_id, scheduled_for, status)
    VALUES
      (3001, ?, ?, 'item_refresh', 'sess-A', now(), 'queued'),
      (3002, ?, ?, 'item_refresh', 'sess-B', now(), 'queued');
  `).run(shopA.id, itemA.id, shopB.id, itemB.id);

  // Shop A stops
  await ops.applyShopObservation(shopA.id, { value: 100, observedAt: '2026-09-01T00:00:00Z', quality: 'exact' });
  await ops.applyShopObservation(shopA.id, { value: 100, observedAt: '2026-10-01T00:00:00Z', quality: 'exact' });

  const jobA = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 3001').get();
  const jobB = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 3002').get();

  assert.equal(jobA.status, 'cancelled', 'Shop A job must be cancelled');
  assert.equal(jobB.status, 'queued', 'Shop B job must strictly remain queued');
});

// =============================================================================
// CHALLENGE 2: PROBE HIERARCHY & CHILD ITEM CASCADE
// =============================================================================

test('CHALLENGE 2.1: Child monitoring_items are cascaded to paused and updated_at refreshed', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-cascade-items',
    identitySource: 'id',
  });

  for (let i = 1; i <= 3; i++) {
    const uid = `etsy:cascade-listing-${i}`;
    await db.prepare(`
      INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at, status)
      VALUES (?, 'etsy', 'q', 'Title', 'https://etsy.com', now(), now(), 'active');
    `).run(uid);

    await ops.registerItemForMonitoring({
      itemUid: uid,
      entityId: entity.id,
      eligibility: 'ready',
      itemStatus: 'active',
    });
  }

  // Day 0 & Day 30 Stoppage
  await ops.applyShopObservation(entity.id, { value: 50, observedAt: '2026-09-01T00:00:00Z', quality: 'exact' });
  await ops.applyShopObservation(entity.id, { value: 50, observedAt: '2026-10-01T00:00:00Z', quality: 'exact' });

  const childItems = await ops.getChildItemsForEntity(entity.id, { itemStatus: 'all' });
  assert.equal(childItems.length, 3);
  for (const it of childItems) {
    assert.equal(it.item_status, 'paused', 'Active child item must transition to paused upon shop stoppage');
    assert.ok(it.updated_at, 'updated_at timestamp must be present');
  }
});

test('CHALLENGE 2.2: Non-active child items (unavailable) preserve their status upon shop stoppage', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-non-active-items',
    identitySource: 'id',
  });

  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, first_seen_at, last_seen_at, status)
    VALUES ('etsy:listing-unavail', 'etsy', 'q', 'Unavail', 'https://etsy.com', now(), now(), 'active');
  `).run();

  await ops.registerItemForMonitoring({
    itemUid: 'etsy:listing-unavail',
    entityId: entity.id,
    eligibility: 'ready',
    itemStatus: 'unavailable',
  });

  await ops.applyShopObservation(entity.id, { value: 50, observedAt: '2026-09-01T00:00:00Z', quality: 'exact' });
  await ops.applyShopObservation(entity.id, { value: 50, observedAt: '2026-10-01T00:00:00Z', quality: 'exact' });

  const item = await ops.getItem('etsy:listing-unavail');
  assert.equal(item.item_status, 'unavailable', 'Unavailable item must preserve its status and not be overwritten');
});

// =============================================================================
// CHALLENGE 3: PRODUCT_CURRENT STATUS IMMUTABILITY INVARIANT
// =============================================================================

test('CHALLENGE 3.1: product_current.status is strictly untouched across all listing statuses', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-immutability',
    identitySource: 'id',
  });

  // Seed items with distinct product_current statuses: 'active', 'new', 'dropped'
  const statuses = [
    { uid: 'etsy:item-stat-active', status: 'active' },
    { uid: 'etsy:item-stat-new', status: 'new' },
    { uid: 'etsy:item-stat-dropped', status: 'dropped' },
  ];

  for (const s of statuses) {
    await db.prepare(`
      INSERT INTO product_current (item_uid, platform, query, title, url, status, first_seen_at, last_seen_at)
      VALUES (?, 'etsy', 'q', 'Title', 'https://etsy.com', ?, now(), now());
    `).run(s.uid, s.status);

    await ops.registerItemForMonitoring({
      itemUid: s.uid,
      entityId: entity.id,
      eligibility: 'ready',
      itemStatus: 'active',
    });
  }

  // Baseline & Stoppage
  await ops.applyShopObservation(entity.id, { value: 200, observedAt: '2026-09-01T00:00:00Z', quality: 'exact' });
  await ops.applyShopObservation(entity.id, { value: 200, observedAt: '2026-10-01T00:00:00Z', quality: 'exact' });

  // Verify that each product_current row retains EXACTLY its original status!
  for (const s of statuses) {
    const row = await db.prepare('SELECT status, query, first_seen_at FROM product_current WHERE item_uid = ?').get(s.uid);
    assert.equal(row.status, s.status, `product_current.status for ${s.uid} MUST remain '${s.status}', never modified by shop stoppage`);
  }
});

// =============================================================================
// CHALLENGE 4: SHOP SALES VS LISTING CURRENT_SOLD ISOLATION INVARIANT
// =============================================================================

test('CHALLENGE 4.1: monitoring_entities.sales is isolated from listing current_sold and delta_sold', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-sales-isolation',
    identitySource: 'id',
  });

  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, current_sold, delta_sold, first_seen_at, last_seen_at, status)
    VALUES ('etsy:listing-isolation', 'etsy', 'q', 'Pottery', 'https://etsy.com/pottery', 75, 5, now(), now(), 'active');
  `).run();

  await ops.registerItemForMonitoring({
    itemUid: 'etsy:listing-isolation',
    entityId: entity.id,
    eligibility: 'ready',
    itemStatus: 'active',
  });

  // Shop has massive aggregate sales: 1,500,000
  await ops.applyShopObservation(entity.id, {
    value: 1500000,
    observedAt: '2026-09-01T00:00:00.000Z',
    quality: 'exact',
  });

  // Check shop entity
  const ent = await ops.getEntity(entity.id);
  assert.equal(Number(ent.sales), 1500000, 'monitoring_entities.sales must reflect shop total');

  // Check product_current listing: current_sold and delta_sold MUST NOT change!
  const product = await db.prepare('SELECT current_sold, delta_sold, status FROM product_current WHERE item_uid = ?').get('etsy:listing-isolation');
  assert.equal(product.current_sold, 75, 'listing current_sold must NEVER receive shop total sales');
  assert.equal(product.delta_sold, 5, 'listing delta_sold must NEVER receive shop total sales');
  assert.equal(product.status, 'active');

  // Check monitoring_entity_observations
  const obs = await db.prepare('SELECT metric_name, metric_value FROM monitoring_entity_observations WHERE entity_id = ?').get(entity.id);
  assert.equal(obs.metric_name, 'shop_sales');
  assert.equal(Number(obs.metric_value), 1500000);
});

// =============================================================================
// CHALLENGE 5: NUMERIC TIMESTAMP HARDENING & DATE PARSING
// =============================================================================

test('CHALLENGE 5.1: ShopLifecyclePolicy parses numeric epoch ms without error_ignored or string corruption', () => {
  const t0 = 1725148800000; // 2026-09-01T00:00:00.000Z
  const initial = { sales: null, unchangedSince: null };

  // Pass numeric epoch directly as observedAt
  const res = ShopLifecyclePolicy.evaluateObservation(initial, {
    value: 100,
    observedAt: t0,
    quality: 'exact',
  });

  assert.notEqual(res.action, 'error_ignored', 'Numeric epoch ms must NOT be discarded with error_ignored');
  assert.equal(res.action, 'baseline_established');
  assert.equal(res.unchangedSince, '2026-09-01T00:00:00.000Z');
  assert.equal(res.salesObservedAt, '2026-09-01T00:00:00.000Z');
});

test('CHALLENGE 5.2: ShopLifecyclePolicy handles stringified epoch cleanly without NaN or Z suffixing', () => {
  const t0Str = '1725148800000';
  const initial = { sales: null, unchangedSince: null };

  const res = ShopLifecyclePolicy.evaluateObservation(initial, {
    value: 100,
    observedAt: t0Str,
    quality: 'exact',
  });

  assert.notEqual(res.action, 'error_ignored');
  assert.equal(res.action, 'baseline_established');
  assert.equal(res.unchangedSince, '2026-09-01T00:00:00.000Z');
});

test('CHALLENGE 5.3: applyShopObservation with numeric epoch timestamp in options updates entity cleanly', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'shop-epoch-test',
    identitySource: 'id',
  });

  const t0 = 1725148800000; // 2026-09-01T00:00:00.000Z
  const res = await ops.applyShopObservation(entity.id, {
    value: 400,
    observedAt: t0,
    quality: 'exact',
  });

  assert.equal(res.action, 'baseline_established');
  assert.equal(res.unchangedSince, '2026-09-01T00:00:00.000Z');

  const entRow = await ops.getEntity(entity.id);
  assert.ok(entRow.sales_observed_at, 'sales_observed_at must be populated');
  assert.equal(new Date(entRow.sales_observed_at).toISOString(), '2026-09-01T00:00:00.000Z');
});
