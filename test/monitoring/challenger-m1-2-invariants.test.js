/**
 * Challenger 2 Verification Suite (Milestone 1)
 * 
 * Verifies Status Decoupling, Entity Re-encounter Idempotency, and Polymorphic Jobs Unique Constraints:
 * 1. Status Decoupling: product_current.status = 'dropped' preserved during monitoring registration and updates.
 * 2. Status Decoupling: product_current.status = 'active' preserved when monitoring entity is stopped or expired.
 * 3. Entity Re-encounter: createOrGetEntity on stopped/expired entities preserves tracking_status (never resets to active).
 * 4. Polymorphic Jobs Unique Constraints: partial unique indexes uq_monitoring_jobs_probe & uq_monitoring_jobs_refresh
 *    block duplicates for same session/target while allowing valid polymorphic combinations.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { fromDriver } = require('../../src/database/pg-client');
const { createMonitoringOps } = require('../../src/database/monitoring');

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
 * Helper to seed a product_current row with exact Discovery status.
 */
async function seedDiscoveryProduct(db, itemUid, overrides = {}) {
  const platform = overrides.platform || 'etsy';
  const query = overrides.query || 'handmade ceramic mug';
  const title = overrides.title || 'Handcrafted Ceramic Mug';
  const url = overrides.url || `https://www.etsy.com/listing/${encodeURIComponent(itemUid)}`;
  const status = overrides.status || 'active';

  await db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, status,
      current_price, current_sold
    ) VALUES (
      @item_uid, @platform, @query, @title, @url, @status,
      @current_price, @current_sold
    )
    ON CONFLICT (item_uid) DO NOTHING;
  `).run({
    item_uid: itemUid,
    platform,
    query,
    title,
    url,
    status,
    current_price: overrides.current_price ?? 32.50,
    current_sold: overrides.current_sold ?? 145,
  });
}

// ============================================================================
// OBJECTIVE 1: Status Decoupling (product_current.status = 'dropped')
// ============================================================================

test('Objective 1.1: Registering a dropped item in monitoring_items keeps product_current.status = "dropped"', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // 1. Create item in product_current with status = 'dropped'
  const itemUid = 'etsy:listing-dropped-001';
  await seedDiscoveryProduct(db, itemUid, { status: 'dropped' });

  // Verify initial state
  const before = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(before.status, 'dropped', 'Initial product_current status must be dropped');

  // 2. Create an entity and register item in monitoring_items
  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'pottery-studio-1',
    displayName: 'Pottery Studio',
  });

  const registered = await ops.registerItemForMonitoring({
    itemUid,
    entityId: entity.id,
    itemStatus: 'active',
  });

  assert.equal(registered.item_uid, itemUid);
  assert.equal(registered.eligibility, 'ready');
  assert.equal(registered.item_status, 'active');

  // 3. Verify product_current.status remains 'dropped'
  const afterRegister = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(afterRegister.status, 'dropped', 'product_current.status MUST remain dropped after monitoring registration');
});

test('Objective 1.2: Updating monitoring item status and fields preserves product_current.status = "dropped"', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const itemUid = 'etsy:listing-dropped-002';
  await seedDiscoveryProduct(db, itemUid, { status: 'dropped' });

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'pottery-studio-2',
  });

  await ops.registerItemForMonitoring({ itemUid, entityId: entity.id });

  // Update item to paused
  await db.prepare("UPDATE monitoring_items SET item_status = 'paused', consecutive_failures = 3 WHERE item_uid = ?").run(itemUid);

  const check1 = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(check1.status, 'dropped', 'product_current.status must remain dropped when monitoring item is paused');

  // Update item to unavailable
  await db.prepare("UPDATE monitoring_items SET item_status = 'unavailable', last_attempt_at = now() WHERE item_uid = ?").run(itemUid);

  const check2 = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(check2.status, 'dropped', 'product_current.status must remain dropped when monitoring item is unavailable');
});

test('Objective 1.3: Pending identity lifecycle for dropped product preserves product_current.status = "dropped"', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const itemUid = 'etsy:listing-dropped-003';
  await seedDiscoveryProduct(db, itemUid, { status: 'dropped' });

  // Register initially as pending identity
  const pending = await ops.handlePendingIdentity(itemUid);
  assert.equal(pending.eligibility, 'pending_identity');
  assert.equal(pending.entity_id, null);

  const pcAfterPending = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(pcAfterPending.status, 'dropped', 'product_current.status must remain dropped after pending identity handling');

  // Later resolve to a newly discovered entity
  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'pottery-studio-3',
  });

  const resolved = await ops.resolvePendingIdentity(itemUid, entity.id);
  assert.equal(resolved.eligibility, 'ready');
  assert.equal(resolved.entity_id, entity.id);

  const pcAfterResolve = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(pcAfterResolve.status, 'dropped', 'product_current.status must remain dropped after resolving pending identity');
});

// ============================================================================
// OBJECTIVE 2: Status Decoupling (product_current.status = 'active' vs entity stopped)
// ============================================================================

test('Objective 2.1: Marking monitoring entity as stopped preserves product_current.status = "active"', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // 1. Create product in product_current with status = 'active'
  const itemUid = 'etsy:listing-active-001';
  await seedDiscoveryProduct(db, itemUid, { status: 'active' });

  // 2. Create monitoring entity and link item
  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'artisan-candle-shop',
    displayName: 'Artisan Candles',
  });

  await ops.registerItemForMonitoring({ itemUid, entityId: entity.id });

  // 3. Mark monitoring entity as stopped (e.g. 30-day unchanged sales rule)
  const updatedEntity = await ops.updateEntityStatus(entity.id, 'stopped', 'shop_sales_unchanged_30d');
  assert.equal(updatedEntity.tracking_status, 'stopped');
  assert.equal(updatedEntity.reason, 'shop_sales_unchanged_30d');

  // 4. Verify product_current.status remains 'active'
  const product = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(product.status, 'active', 'Discovery product_current.status MUST remain active when monitoring entity is stopped');
});

test('Objective 2.2: Marking monitoring entity as expired preserves product_current.status = "active"', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const itemUid = 'tiktok:video-active-002';
  await seedDiscoveryProduct(db, itemUid, { platform: 'tiktok', status: 'active' });

  const author = await ops.createOrGetEntity({
    platform: 'tiktok',
    entityType: 'author',
    externalId: 'viral_creator_42',
  });

  await ops.registerItemForMonitoring({ itemUid, entityId: author.id });

  // Mark author entity as expired (author session 30d/60d deadline reached)
  const updatedAuthor = await ops.updateEntityStatus(author.id, 'expired', 'author_session_deadline_reached');
  assert.equal(updatedAuthor.tracking_status, 'expired');

  // Verify product_current.status remains 'active'
  const product = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(product.status, 'active', 'product_current.status MUST remain active when author entity expires');
});

test('Objective 2.3: Entity lifecycle transitions (active -> paused -> stopped) never mutate product_current.status', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const itemUid = 'etsy:listing-lifecycle-003';
  await seedDiscoveryProduct(db, itemUid, { status: 'active' });

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'multi-transition-shop',
  });
  await ops.registerItemForMonitoring({ itemUid, entityId: entity.id });

  // Transition: paused
  await ops.updateEntityStatus(entity.id, 'paused', 'operator_manual_pause');
  let pc = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(pc.status, 'active', 'Product must remain active when entity paused');

  // Transition: stopped
  await ops.updateEntityStatus(entity.id, 'stopped', 'shop_sales_unchanged_30d');
  pc = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(pc.status, 'active', 'Product must remain active when entity stopped');

  // Transition: expired
  await ops.updateEntityStatus(entity.id, 'expired', 'policy_session_closed');
  pc = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(pc.status, 'active', 'Product must remain active when entity expired');
});

// ============================================================================
// OBJECTIVE 3: Entity Re-Encounter (createOrGetEntity Idempotency)
// ============================================================================

test('Objective 3.1: createOrGetEntity on stopped entity does NOT reset status back to active', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // 1. Create entity
  const initial = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'reencounter-shop-1',
    displayName: 'Initial Shop Name',
  });
  assert.equal(initial.tracking_status, 'active');
  const originalSessionId = initial.session_id;

  // 2. Mark entity as stopped
  const stopped = await ops.updateEntityStatus(initial.id, 'stopped', 'shop_sales_unchanged_30d');
  assert.equal(stopped.tracking_status, 'stopped');

  // 3. Re-encounter: Discovery or scraper calls createOrGetEntity again for this stopped shop
  const reEncountered = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'reencounter-shop-1',
    displayName: 'New Shop Name Candidate',
  });

  // 4. Invariants check:
  // - tracking_status must NOT revert to 'active'
  assert.equal(reEncountered.tracking_status, 'stopped', 'Re-encountered entity MUST NOT reset status to active');
  assert.equal(reEncountered.id, initial.id, 'Must return the same surrogate primary key');
  assert.equal(reEncountered.session_id, originalSessionId, 'Must preserve original session_id');

  // Verify direct database query matches
  const inDb = await ops.getEntity(initial.id);
  assert.equal(inDb.tracking_status, 'stopped', 'Database row tracking_status must strictly remain stopped');
});

test('Objective 3.2: createOrGetEntity on expired entity does NOT reset status back to active', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // 1. Create author entity
  const initialAuthor = await ops.createOrGetEntity({
    platform: 'tiktok',
    entityType: 'author',
    externalId: 'reencounter-author-1',
    monitoringStartedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-31T00:00:00.000Z',
  });
  assert.equal(initialAuthor.tracking_status, 'active');

  // 2. Mark entity as expired
  await ops.updateEntityStatus(initialAuthor.id, 'expired', 'author_session_deadline_reached');
  const expiredEntity = await ops.getEntity(initialAuthor.id);
  assert.equal(expiredEntity.tracking_status, 'expired');

  // 3. Re-encounter: Scraper or discovery encounters author again
  const reEncountered = await ops.createOrGetEntity({
    platform: 'tiktok',
    entityType: 'author',
    externalId: 'reencounter-author-1',
  });

  // 4. Verify tracking_status remains 'expired'
  assert.equal(reEncountered.tracking_status, 'expired', 'Re-encountered author MUST NOT reset status to active');

  const inDb = await ops.getEntity(initialAuthor.id);
  assert.equal(inDb.tracking_status, 'expired');
});

test('Objective 3.3: createOrGetEntity on paused entity does NOT reset status back to active', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const initial = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'reencounter-paused-1',
  });

  await ops.updateEntityStatus(initial.id, 'paused', 'operator_hold');

  const reEncountered = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'reencounter-paused-1',
  });

  assert.equal(reEncountered.tracking_status, 'paused', 'Paused entity MUST retain paused status upon re-encounter');
});

test('Objective 3.4: createOrGetEntity metadata backfill preserves existing non-null fields and preserves state', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // Create entity with null canonical_url but defined display_name
  const initial = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'meta-shop-1',
    displayName: 'Preserved Shop Name',
    canonicalUrl: null,
  });

  await ops.updateEntityStatus(initial.id, 'stopped', 'shop_sales_unchanged_30d');

  // Re-encounter provides canonical_url and a different display_name
  const reEncountered = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'meta-shop-1',
    displayName: 'Should Not Overwrite Existing Display Name',
    canonicalUrl: 'https://www.etsy.com/shop/meta-shop-1',
  });

  // Invariants:
  // - tracking_status remains stopped
  assert.equal(reEncountered.tracking_status, 'stopped');
  // - existing display_name is preserved by COALESCE
  assert.equal(reEncountered.display_name, 'Preserved Shop Name');
  // - canonical_url is backfilled from null
  assert.equal(reEncountered.canonical_url, 'https://www.etsy.com/shop/meta-shop-1');
});

// ============================================================================
// OBJECTIVE 4: Polymorphic Jobs Unique Constraints
// ============================================================================

test('Objective 4.1: uq_monitoring_jobs_probe blocks duplicate shop_probe jobs for same entity, session, and scheduled_for', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'probe-target-shop-1',
  });

  const sessionId = 'session-probe-test-101';
  const scheduledFor = '2026-09-22T10:00:00.000Z';

  // 1. Insert first probe job
  const job1 = await db.prepare(`
    INSERT INTO monitoring_jobs (
      entity_id, item_id, kind, session_id, scheduled_for, status
    ) VALUES (
      @entity_id, NULL, 'shop_probe', @session_id, @scheduled_for, 'queued'
    ) RETURNING id;
  `).get({
    entity_id: entity.id,
    session_id: sessionId,
    scheduled_for: scheduledFor,
  });
  assert.ok(job1.id > 0);

  // 2. Attempt duplicate probe job for the exact same entity, session, and scheduled_for
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_jobs (
        entity_id, item_id, kind, session_id, scheduled_for, status
      ) VALUES (
        @entity_id, NULL, 'shop_probe', @session_id, @scheduled_for, 'queued'
      ) RETURNING id;
    `).run({
      entity_id: entity.id,
      session_id: sessionId,
      scheduled_for: scheduledFor,
    });
  }, (err) => {
    // Must fail due to unique constraint / partial unique index violation
    assert.match(err.message, /unique/i);
    return true;
  }, 'Duplicate shop_probe job MUST be rejected by uq_monitoring_jobs_probe index');
});

test('Objective 4.2: uq_monitoring_jobs_refresh blocks duplicate item_refresh jobs for same item, session, and scheduled_for', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const itemUid = 'etsy:refresh-target-item-001';
  await seedDiscoveryProduct(db, itemUid);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'refresh-owner-shop-1',
  });

  const item = await ops.registerItemForMonitoring({ itemUid, entityId: entity.id });

  const sessionId = 'session-refresh-test-202';
  const scheduledFor = '2026-09-22T14:00:00.000Z';

  // 1. Insert first refresh job
  const job1 = await db.prepare(`
    INSERT INTO monitoring_jobs (
      entity_id, item_id, kind, session_id, scheduled_for, status
    ) VALUES (
      @entity_id, @item_id, 'item_refresh', @session_id, @scheduled_for, 'queued'
    ) RETURNING id;
  `).get({
    entity_id: entity.id,
    item_id: item.id,
    session_id: sessionId,
    scheduled_for: scheduledFor,
  });
  assert.ok(job1.id > 0);

  // 2. Attempt duplicate refresh job with identical item, session, and scheduled_for
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_jobs (
        entity_id, item_id, kind, session_id, scheduled_for, status
      ) VALUES (
        @entity_id, @item_id, 'item_refresh', @session_id, @scheduled_for, 'queued'
      ) RETURNING id;
    `).run({
      entity_id: entity.id,
      item_id: item.id,
      session_id: sessionId,
      scheduled_for: scheduledFor,
    });
  }, (err) => {
    assert.match(err.message, /unique/i);
    return true;
  }, 'Duplicate item_refresh job MUST be rejected by uq_monitoring_jobs_refresh index');
});

test('Objective 4.3: Valid polymorphic coexistence: shop_probe and item_refresh coexist at same session and scheduled_for', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const itemUid = 'etsy:coexist-item-001';
  await seedDiscoveryProduct(db, itemUid);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'coexist-shop-1',
  });

  const item = await ops.registerItemForMonitoring({ itemUid, entityId: entity.id });

  const sessionId = 'session-coexist-303';
  const scheduledFor = '2026-09-22T16:00:00.000Z';

  // 1. Insert shop_probe for entity
  const probeJob = await db.prepare(`
    INSERT INTO monitoring_jobs (
      entity_id, item_id, kind, session_id, scheduled_for, status
    ) VALUES (
      @entity_id, NULL, 'shop_probe', @session_id, @scheduled_for, 'queued'
    ) RETURNING id, kind;
  `).get({
    entity_id: entity.id,
    session_id: sessionId,
    scheduled_for: scheduledFor,
  });
  assert.equal(probeJob.kind, 'shop_probe');

  // 2. Insert item_refresh for item of that same entity at the exact same session and timestamp
  const refreshJob = await db.prepare(`
    INSERT INTO monitoring_jobs (
      entity_id, item_id, kind, session_id, scheduled_for, status
    ) VALUES (
      @entity_id, @item_id, 'item_refresh', @session_id, @scheduled_for, 'queued'
    ) RETURNING id, kind;
  `).get({
    entity_id: entity.id,
    item_id: item.id,
    session_id: sessionId,
    scheduled_for: scheduledFor,
  });
  assert.equal(refreshJob.kind, 'item_refresh');

  // Both jobs must coexist in the queue
  const jobs = await db.prepare('SELECT id, kind FROM monitoring_jobs WHERE session_id = ? ORDER BY id ASC').all(sessionId);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].kind, 'shop_probe');
  assert.equal(jobs[1].kind, 'item_refresh');
});

test('Objective 4.4: Valid polymorphic combinations: multiple items under same entity at same scheduled_for', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const itemUid1 = 'etsy:multi-item-001';
  const itemUid2 = 'etsy:multi-item-002';
  await seedDiscoveryProduct(db, itemUid1);
  await seedDiscoveryProduct(db, itemUid2);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'multi-item-shop',
  });

  const item1 = await ops.registerItemForMonitoring({ itemUid: itemUid1, entityId: entity.id });
  const item2 = await ops.registerItemForMonitoring({ itemUid: itemUid2, entityId: entity.id });

  const sessionId = 'session-multi-item-404';
  const scheduledFor = '2026-09-22T18:00:00.000Z';

  // Both items scheduled at the same time for refresh
  const j1 = await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for)
    VALUES (?, ?, 'item_refresh', ?, ?) RETURNING id;
  `).get(entity.id, item1.id, sessionId, scheduledFor);

  const j2 = await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for)
    VALUES (?, ?, 'item_refresh', ?, ?) RETURNING id;
  `).get(entity.id, item2.id, sessionId, scheduledFor);

  assert.ok(j1.id > 0);
  assert.ok(j2.id > 0);
  assert.notEqual(j1.id, j2.id);
});

test('Objective 4.5: Valid polymorphic combinations: multiple distinct entities probed at same scheduled_for', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const e1 = await ops.createOrGetEntity({ platform: 'etsy', entityType: 'shop', externalId: 'distinct-shop-alpha' });
  const e2 = await ops.createOrGetEntity({ platform: 'etsy', entityType: 'shop', externalId: 'distinct-shop-beta' });

  const sessionId = 'session-multi-probe-505';
  const scheduledFor = '2026-09-22T20:00:00.000Z';

  const j1 = await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for)
    VALUES (?, NULL, 'shop_probe', ?, ?) RETURNING id;
  `).get(e1.id, sessionId, scheduledFor);

  const j2 = await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for)
    VALUES (?, NULL, 'shop_probe', ?, ?) RETURNING id;
  `).get(e2.id, sessionId, scheduledFor);

  assert.ok(j1.id > 0);
  assert.ok(j2.id > 0);
  assert.notEqual(j1.id, j2.id);
});

test('Objective 4.6: Valid polymorphic combinations: same entity scheduled across successive 5-day cycle intervals', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({ platform: 'etsy', entityType: 'shop', externalId: 'cycle-shop-1' });
  const sessionId = 'session-cycle-606';

  const cycle1 = '2026-09-22T00:00:00.000Z';
  const cycle2 = '2026-09-27T00:00:00.000Z'; // +5 days

  const j1 = await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for)
    VALUES (?, NULL, 'shop_probe', ?, ?) RETURNING id;
  `).get(entity.id, sessionId, cycle1);

  const j2 = await db.prepare(`
    INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for)
    VALUES (?, NULL, 'shop_probe', ?, ?) RETURNING id;
  `).get(entity.id, sessionId, cycle2);

  assert.ok(j1.id > 0);
  assert.ok(j2.id > 0);
});

test('Objective 4.7: Target check constraints chk_monitoring_jobs_target reject invalid target configurations', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const itemUid = 'etsy:invalid-target-001';
  await seedDiscoveryProduct(db, itemUid);
  const entity = await ops.createOrGetEntity({ platform: 'etsy', entityType: 'shop', externalId: 'chk-shop-1' });
  const item = await ops.registerItemForMonitoring({ itemUid, entityId: entity.id });

  // 1. shop_probe with item_id non-null must fail CHECK constraint
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for)
      VALUES (?, ?, 'shop_probe', 'sess-chk', now())
    `).run(entity.id, item.id);
  }, /check constraint/i, 'shop_probe with non-null item_id must be rejected');

  // 2. shop_probe with entity_id null must fail CHECK constraint
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for)
      VALUES (NULL, NULL, 'shop_probe', 'sess-chk', now())
    `).run();
  }, /check constraint/i, 'shop_probe with null entity_id must be rejected');

  // 3. item_refresh with item_id null must fail CHECK constraint
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_jobs (entity_id, item_id, kind, session_id, scheduled_for)
      VALUES (?, NULL, 'item_refresh', 'sess-chk', now())
    `).run(entity.id);
  }, /check constraint/i, 'item_refresh with null item_id must be rejected');
});
