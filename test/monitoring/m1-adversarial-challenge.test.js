/**
 * Milestone 1 Empirical Adversarial Challenge Test Suite
 *
 * Implements rigorous stress testing and adversarial edge-case verification
 * for Milestone 1 schema and database operations against SSOT specifications:
 * - docs/DISCOVERY_MONITORING_PLAN_REVISED.md §3.1, §4, §9
 * - .agents/orchestrator_1/PROJECT.md (Features F1-F5)
 *
 * Challenge Scenarios:
 * 1. Stress test idempotent schema initialization (10 consecutive executions on empty & populated DB)
 * 2. Attempt inserting into monitoring_limiter with various statement forms (verify no "id" column error)
 * 3. Attempt inserting invalid entities (invalid entity_type, tracking_status, confidence) and verify CHECK constraints
 * 4. Challenge pending_identity isolation (ensure pending items are never picked up by active due queries)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fromDriver } = require('../../src/database/pg-client');
const { createMonitoringOps } = require('../../src/database/monitoring');

const PG_SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'pg-schema.sql');
const PG_SCHEMA_SQL = fs.readFileSync(PG_SCHEMA_PATH, 'utf8');

/**
 * Creates an isolated PGlite test database instance with pg-client wrapper.
 */
async function createFreshDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const driver = new PGlite();
  return fromDriver(driver);
}

/**
 * Helper to seed a product_current row so foreign key constraints in monitoring_items are satisfied.
 */
async function seedProductCurrent(db, itemUid, overrides = {}) {
  await db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (item_uid) DO NOTHING
  `).run(
    itemUid,
    overrides.platform || 'etsy',
    overrides.query || 'test-query',
    overrides.title || 'Test Product Title',
    overrides.url || `https://www.etsy.com/listing/${itemUid}`,
    overrides.status || 'active',
    overrides.first_seen_at || '2026-09-01 00:00:00',
    overrides.last_seen_at || '2026-09-01 00:00:00'
  );
}

// ============================================================================
// CHALLENGE 1: Stress Test Idempotent Schema Initialization
// ============================================================================
test('Challenge 1.1: Re-execute pg-schema.sql 10 times consecutively on fresh database', async () => {
  const db = await createFreshDb();

  for (let i = 1; i <= 10; i++) {
    await assert.doesNotReject(async () => {
      await db.exec(PG_SCHEMA_SQL);
    }, `Schema execution iteration ${i} must not throw`);
  }

  // Verify all 5 monitoring tables exist and are functional
  const tables = ['monitoring_entities', 'monitoring_items', 'monitoring_jobs', 'monitoring_entity_observations', 'monitoring_limiter'];
  for (const table of tables) {
    const res = await db.prepare(`SELECT count(*) AS c FROM "${table}"`).get();
    assert.ok(res !== null && res.c !== undefined, `Table ${table} should be queryable after 10 schema runs`);
  }

  // Verify limiter singleton seed row is present
  const limiterRow = await db.prepare('SELECT * FROM monitoring_limiter WHERE key = ?').get('global_monitoring_capture');
  assert.ok(limiterRow, 'monitoring_limiter singleton row should exist');
  assert.equal(limiterRow.key, 'global_monitoring_capture');
});

test('Challenge 1.2: Re-execute pg-schema.sql 10 times consecutively on pre-populated database without data corruption', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  // Populate data across tables
  await seedProductCurrent(db, 'etsy:item-populated-1');
  const ops = createMonitoringOps(db);

  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'artisan-shop-preserve',
    displayName: 'Preserved Shop',
  });

  const item = await ops.registerItemForMonitoring({
    itemUid: 'etsy:item-populated-1',
    entityId: entity.id,
  });

  // Mutate limiter with an active lease to test DO NOTHING preservation
  const leaseToken = 'worker-lease-token-xyz';
  const leasedUntil = new Date(Date.now() + 60000).toISOString();
  await db.prepare(`
    UPDATE monitoring_limiter
    SET owner_token = ?, leased_until = ?::timestamptz
    WHERE key = 'global_monitoring_capture'
  `).run(leaseToken, leasedUntil);

  // Execute schema 10 more times
  for (let i = 1; i <= 10; i++) {
    await db.exec(PG_SCHEMA_SQL);
  }

  // Verify entity row was NOT wiped or corrupted
  const verifiedEntity = await ops.getEntity(entity.id);
  assert.ok(verifiedEntity);
  assert.equal(verifiedEntity.external_id, 'artisan-shop-preserve');
  assert.equal(verifiedEntity.display_name, 'Preserved Shop');

  // Verify item row was NOT wiped
  const verifiedItem = await ops.getItem('etsy:item-populated-1');
  assert.ok(verifiedItem);
  assert.equal(verifiedItem.entity_id, entity.id);
  assert.equal(verifiedItem.eligibility, 'ready');

  // Verify limiter active lease was NOT overwritten by the seed query
  const verifiedLimiter = await db.prepare('SELECT * FROM monitoring_limiter WHERE key = ?').get('global_monitoring_capture');
  assert.equal(verifiedLimiter.owner_token, leaseToken, 'Seed query must NOT overwrite active owner_token');
});

// ============================================================================
// CHALLENGE 2: monitoring_limiter Insertion Variants & No "id" Column Error
// ============================================================================
test('Challenge 2.1: Positional INSERT into monitoring_limiter does not append RETURNING id', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  // Standard positional insert
  const stmt = db.prepare(`
    INSERT INTO monitoring_limiter (key, owner_token, leased_until, next_allowed_at)
    VALUES (?, ?, ?, now())
    ON CONFLICT (key) DO NOTHING
  `);

  await assert.doesNotReject(async () => {
    const res = await stmt.run('test_slot_1', 'token-1', null);
    assert.equal(res.lastInsertRowid, undefined, 'lastInsertRowid should be undefined for tables without id');
  });

  const row = await db.prepare('SELECT * FROM monitoring_limiter WHERE key = ?').get('test_slot_1');
  assert.ok(row);
  assert.equal(row.owner_token, 'token-1');
});

test('Challenge 2.2: Named parameters INSERT into monitoring_limiter', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  const stmt = db.prepare(`
    INSERT INTO monitoring_limiter (key, owner_token, leased_until, next_allowed_at)
    VALUES (@key, @ownerToken, @leasedUntil, now())
    ON CONFLICT (key) DO NOTHING
  `);

  await assert.doesNotReject(async () => {
    await stmt.run({
      key: 'test_slot_named',
      ownerToken: 'token-named',
      leasedUntil: null,
    });
  });

  const row = await db.prepare('SELECT * FROM monitoring_limiter WHERE key = ?').get('test_slot_named');
  assert.ok(row);
  assert.equal(row.owner_token, 'token-named');
});

test('Challenge 2.3: Quoted table name "monitoring_limiter" INSERT', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  const stmt = db.prepare(`
    INSERT INTO "monitoring_limiter" (key, next_allowed_at)
    VALUES (?, now())
    ON CONFLICT (key) DO NOTHING
  `);

  await assert.doesNotReject(async () => {
    await stmt.run('test_slot_quoted');
  });

  const row = await db.prepare('SELECT * FROM monitoring_limiter WHERE key = ?').get('test_slot_quoted');
  assert.ok(row);
});

test('Challenge 2.4: Multi-line formatted INSERT into monitoring_limiter', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  const stmt = db.prepare(`
    INSERT INTO
      monitoring_limiter (
        key,
        owner_token,
        next_allowed_at
      )
    VALUES (
      ?,
      ?,
      now()
    )
    ON CONFLICT (key) DO UPDATE
      SET owner_token = EXCLUDED.owner_token
  `);

  await assert.doesNotReject(async () => {
    await stmt.run('test_slot_multiline', 'token-multiline');
  });

  const row = await db.prepare('SELECT * FROM monitoring_limiter WHERE key = ?').get('test_slot_multiline');
  assert.ok(row);
  assert.equal(row.owner_token, 'token-multiline');
});

test('Challenge 2.5: Explicit RETURNING clauses on monitoring_limiter', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  // RETURNING key
  const stmtKey = db.prepare(`
    INSERT INTO monitoring_limiter (key, next_allowed_at)
    VALUES ('slot_returning_key', now())
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `);
  const resKey = await stmtKey.get();
  assert.ok(resKey);
  assert.equal(resKey.key, 'slot_returning_key');

  // RETURNING *
  const stmtAll = db.prepare(`
    INSERT INTO monitoring_limiter (key, next_allowed_at)
    VALUES ('slot_returning_all', now())
    ON CONFLICT (key) DO NOTHING
    RETURNING *
  `);
  const resAll = await stmtAll.get();
  assert.ok(resAll);
  assert.equal(resAll.key, 'slot_returning_all');
});

test('Challenge 2.6: SQLite dialect translation INSERT OR IGNORE INTO monitoring_limiter', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO monitoring_limiter (key, next_allowed_at)
    VALUES ('slot_sqlite_dialect', now())
  `);

  await assert.doesNotReject(async () => {
    await stmt.run();
  });

  const row = await db.prepare('SELECT * FROM monitoring_limiter WHERE key = ?').get('slot_sqlite_dialect');
  assert.ok(row);
});

// ============================================================================
// CHALLENGE 3: Schema Constraints & Validation Adversarial Testing
// ============================================================================
test('Challenge 3.1: Reject invalid entity_type via CHECK constraint', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  const invalidTypes = ['product', 'listing', 'seller', 'user', 'SHOP', 'author_v2', ''];

  for (const type of invalidTypes) {
    await assert.rejects(async () => {
      await db.prepare(`
        INSERT INTO monitoring_entities (
          platform, entity_type, external_id, identity_source, session_id
        ) VALUES ('etsy', ?, ?, 'test', 'sess-1')
      `).run(type, `ext-${type || 'empty'}`);
    }, /check constraint/i, `entity_type '${type}' should be rejected by CHECK constraint`);
  }
});

test('Challenge 3.2: Reject invalid tracking_status via CHECK constraint', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  const invalidStatuses = ['pending', 'running', 'failed', 'deleted', 'ACTIVE', 'dropped', ''];

  for (const status of invalidStatuses) {
    await assert.rejects(async () => {
      await db.prepare(`
        INSERT INTO monitoring_entities (
          platform, entity_type, external_id, identity_source, session_id, tracking_status
        ) VALUES ('etsy', 'shop', ?, 'test', 'sess-1', ?)
      `).run(`ext-${status || 'empty'}`, status);
    }, /check constraint/i, `tracking_status '${status}' should be rejected by CHECK constraint`);
  }
});

test('Challenge 3.3: Reject invalid identity_confidence (<0.0 or >1.0) and accept boundaries [0.0, 1.0]', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  const invalidConfidences = [-0.0001, -1.0, 1.0001, 2.0, 100.0];

  for (const conf of invalidConfidences) {
    await assert.rejects(async () => {
      await db.prepare(`
        INSERT INTO monitoring_entities (
          platform, entity_type, external_id, identity_source, session_id, identity_confidence
        ) VALUES ('etsy', 'shop', ?, 'test', 'sess-1', ?)
      `).run(`ext-conf-${conf}`, conf);
    }, /check constraint/i, `confidence ${conf} should be rejected`);
  }

  // Valid boundaries
  const validConfidences = [0.0, 0.5, 1.0];
  for (const conf of validConfidences) {
    await assert.doesNotReject(async () => {
      await db.prepare(`
        INSERT INTO monitoring_entities (
          platform, entity_type, external_id, identity_source, session_id, identity_confidence
        ) VALUES ('etsy', 'shop', ?, 'test', 'sess-1', ?)
      `).run(`ext-valid-conf-${conf}`, conf);
    }, `confidence ${conf} should be accepted`);
  }
});

test('Challenge 3.4: Enforce composite identity uniqueness (platform, entity_type, external_id)', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);

  await db.prepare(`
    INSERT INTO monitoring_entities (
      platform, entity_type, external_id, identity_source, session_id
    ) VALUES ('etsy', 'shop', 'unique-shop-1', 'test', 'sess-1')
  `).run();

  // Duplicate insert must fail with unique constraint violation
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_entities (
        platform, entity_type, external_id, identity_source, session_id
      ) VALUES ('etsy', 'shop', 'unique-shop-1', 'test', 'sess-2')
    `).run();
  }, /unique constraint/i);

  // Different platform with same external_id must succeed
  await assert.doesNotReject(async () => {
    await db.prepare(`
      INSERT INTO monitoring_entities (
        platform, entity_type, external_id, identity_source, session_id
      ) VALUES ('tiktok', 'shop', 'unique-shop-1', 'test', 'sess-3')
    `).run();
  });

  // Different entity_type with same external_id must succeed
  await assert.doesNotReject(async () => {
    await db.prepare(`
      INSERT INTO monitoring_entities (
        platform, entity_type, external_id, identity_source, session_id
      ) VALUES ('etsy', 'author', 'unique-shop-1', 'test', 'sess-4')
    `).run();
  });
});

test('Challenge 3.5: Enforce monitoring_items and monitoring_jobs CHECK constraints', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);
  await seedProductCurrent(db, 'etsy:item-chk-1');

  // monitoring_items: invalid eligibility
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_items (item_uid, eligibility)
      VALUES ('etsy:item-chk-1', 'invalid_eligibility')
    `).run();
  }, /check constraint/i);

  // monitoring_items: invalid item_status
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_items (item_uid, item_status)
      VALUES ('etsy:item-chk-1', 'invalid_status')
    `).run();
  }, /check constraint/i);

  // monitoring_items: negative consecutive_failures
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_items (item_uid, consecutive_failures)
      VALUES ('etsy:item-chk-1', -1)
    `).run();
  }, /check constraint/i);

  // monitoring_jobs: polymorphic target check constraint (chk_monitoring_jobs_target)
  // shop_probe with entity_id NULL must fail
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_jobs (kind, entity_id, item_id, session_id, scheduled_for)
      VALUES ('shop_probe', NULL, NULL, 'sess-1', now())
    `).run();
  }, /check constraint/i);

  // item_refresh with item_id NULL must fail
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_jobs (kind, entity_id, item_id, session_id, scheduled_for)
      VALUES ('item_refresh', 1, NULL, 'sess-1', now())
    `).run();
  }, /check constraint/i);

  // monitoring_entity_observations: invalid quality
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_entity_observations (
        entity_id, session_id, observation_id, observed_at, metric_name, source, quality
      ) VALUES (1, 'sess-1', 'obs-chk-1', now(), 'sales', 'test', 'invalid_quality')
    `).run();
  }, /check constraint/i);
});

// ============================================================================
// CHALLENGE 4: Pending Identity Isolation & Decoupling Challenge
// ============================================================================
test('Challenge 4.1: findDueItems strictly isolates pending_identity, unsupported, paused, and expired items', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);
  const ops = createMonitoringOps(db);

  const pastDate = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago (due)
  const futureDate = new Date(Date.now() + 3600000).toISOString(); // 1 hour future (not due)

  // 1. Create entities with various tracking statuses
  const activeEntity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'active-shop-due',
    displayName: 'Active Shop',
  });

  const pausedEntity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'paused-shop-due',
    displayName: 'Paused Shop',
  });
  await ops.updateEntityStatus(pausedEntity.id, 'paused');

  const stoppedEntity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'stopped-shop-due',
    displayName: 'Stopped Shop',
  });
  await ops.updateEntityStatus(stoppedEntity.id, 'stopped');

  const expiredAuthor = await ops.createOrGetEntity({
    platform: 'tiktok',
    entityType: 'author',
    externalId: 'expired-author-due',
    displayName: 'Expired Author',
    expiresAt: pastDate, // already expired
  });

  // 2. Seed products in product_current
  for (let i = 1; i <= 10; i++) {
    await seedProductCurrent(db, `etsy:item-iso-${i}`);
  }

  // Item 1: Pending identity (no entity, eligibility = pending_identity)
  await ops.handlePendingIdentity('etsy:item-iso-1');

  // Item 2: Adversarial pending identity with past due date manually inserted
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES ('etsy:item-iso-2', NULL, 'pending_identity', 'active', ?::timestamptz)
  `).run(pastDate);

  // Item 3: Adversarial item pointing to active entity BUT eligibility = pending_identity
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES ('etsy:item-iso-3', ?, 'pending_identity', 'active', ?::timestamptz)
  `).run(activeEntity.id, pastDate);

  // Item 4: Unsupported item
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES ('etsy:item-iso-4', ?, 'unsupported', 'active', ?::timestamptz)
  `).run(activeEntity.id, pastDate);

  // Item 5: Ready item belonging to PAUSED entity
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES ('etsy:item-iso-5', ?, 'ready', 'active', ?::timestamptz)
  `).run(pausedEntity.id, pastDate);

  // Item 6: Ready item belonging to STOPPED entity
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES ('etsy:item-iso-6', ?, 'ready', 'active', ?::timestamptz)
  `).run(stoppedEntity.id, pastDate);

  // Item 7: Ready item belonging to EXPIRED author
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES ('etsy:item-iso-7', ?, 'ready', 'active', ?::timestamptz)
  `).run(expiredAuthor.id, pastDate);

  // Item 8: Ready item belonging to active entity BUT item_status = paused
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES ('etsy:item-iso-8', ?, 'ready', 'paused', ?::timestamptz)
  `).run(activeEntity.id, pastDate);

  // Item 9: Ready item belonging to active entity BUT next_due_at in future
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES ('etsy:item-iso-9', ?, 'ready', 'active', ?::timestamptz)
  `).run(activeEntity.id, futureDate);

  // Item 10: LEGITIMATE active, ready item with past due date belonging to active entity
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES ('etsy:item-iso-10', ?, 'ready', 'active', ?::timestamptz)
  `).run(activeEntity.id, pastDate);

  // Execute findDueItems
  const dueItems = await ops.findDueItems(100);

  // Verify: Exactly 1 item must be returned (Item 10)
  assert.equal(dueItems.length, 1, 'Only the legitimate ready active item must be returned');
  assert.equal(dueItems[0].item_uid, 'etsy:item-iso-10');

  // Explicitly assert that none of the non-due/pending items were returned
  const returnedUids = new Set(dueItems.map(i => i.item_uid));
  assert.ok(!returnedUids.has('etsy:item-iso-1'), 'Item 1 (pending) must not be returned');
  assert.ok(!returnedUids.has('etsy:item-iso-2'), 'Item 2 (pending with past due) must not be returned');
  assert.ok(!returnedUids.has('etsy:item-iso-3'), 'Item 3 (pending with entity) must not be returned');
  assert.ok(!returnedUids.has('etsy:item-iso-4'), 'Item 4 (unsupported) must not be returned');
  assert.ok(!returnedUids.has('etsy:item-iso-5'), 'Item 5 (paused entity) must not be returned');
  assert.ok(!returnedUids.has('etsy:item-iso-6'), 'Item 6 (stopped entity) must not be returned');
  assert.ok(!returnedUids.has('etsy:item-iso-7'), 'Item 7 (expired author) must not be returned');
  assert.ok(!returnedUids.has('etsy:item-iso-8'), 'Item 8 (item paused) must not be returned');
  assert.ok(!returnedUids.has('etsy:item-iso-9'), 'Item 9 (future due) must not be returned');
});

test('Challenge 4.2: Pending identity resolution lifecycle promotes item to ready and schedule due', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);
  const ops = createMonitoringOps(db);

  await seedProductCurrent(db, 'etsy:item-lifecycle-1');

  // Step 1: Ingest as pending identity
  const pending = await ops.handlePendingIdentity('etsy:item-lifecycle-1');
  assert.equal(pending.eligibility, 'pending_identity');
  assert.equal(pending.entity_id, null);
  assert.equal(pending.next_due_at, null);

  // Confirm not due
  let due = await ops.findDueItems(100);
  assert.equal(due.length, 0);

  // Step 2: Create entity
  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'lifecycle-shop-1',
  });

  // Step 3: Resolve pending identity
  const resolved = await ops.resolvePendingIdentity('etsy:item-lifecycle-1', entity.id);
  assert.ok(resolved);
  assert.equal(resolved.entity_id, entity.id);
  assert.equal(resolved.eligibility, 'ready');
  assert.ok(resolved.next_due_at !== null, 'next_due_at should be initialized upon resolution');

  // Item is now due (default next_due_at = now())
  due = await ops.findDueItems(100);
  assert.equal(due.length, 1);
  assert.equal(due[0].item_uid, 'etsy:item-lifecycle-1');
});

test('Challenge 4.3: Decoupling verification: product_current.status is NEVER modified by monitoring operations', async () => {
  const db = await createFreshDb();
  await db.exec(PG_SCHEMA_SQL);
  const ops = createMonitoringOps(db);

  // Seed product with Discovery status 'dropped'
  await seedProductCurrent(db, 'etsy:item-decoupled-1', { status: 'dropped' });

  // 1. handlePendingIdentity
  await ops.handlePendingIdentity('etsy:item-decoupled-1');
  let pc = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get('etsy:item-decoupled-1');
  assert.equal(pc.status, 'dropped', 'status must remain dropped after handlePendingIdentity');

  // 2. createOrGetEntity & registerItemForMonitoring
  const entity = await ops.createOrGetEntity({
    platform: 'etsy',
    entityType: 'shop',
    externalId: 'decoupled-shop-1',
  });
  await ops.registerItemForMonitoring({
    itemUid: 'etsy:item-decoupled-1',
    entityId: entity.id,
  });
  pc = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get('etsy:item-decoupled-1');
  assert.equal(pc.status, 'dropped', 'status must remain dropped after registerItemForMonitoring');

  // 3. updateEntityStatus to stopped
  await ops.updateEntityStatus(entity.id, 'stopped', 'shop_sales_unchanged_30d');
  pc = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get('etsy:item-decoupled-1');
  assert.equal(pc.status, 'dropped', 'status must remain dropped after updateEntityStatus');

  // 4. resolvePendingIdentity
  await ops.resolvePendingIdentity('etsy:item-decoupled-1', entity.id);
  pc = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get('etsy:item-decoupled-1');
  assert.equal(pc.status, 'dropped', 'status must remain dropped after resolvePendingIdentity');
});
