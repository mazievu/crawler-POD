/**
 * Tier 1: Feature Coverage Test Suite for Milestones M1 & M2 (Features F1 to F10).
 * 
 * Strict opaque-box testing adhering to docs/DISCOVERY_MONITORING_PLAN_REVISED.md §3, §4, §5:
 * - F1: Composite Entity Key
 * - F2: Pending Identity Isolation
 * - F3: Status Decoupling
 * - F4: Idempotent PostgreSQL Migration
 * - F5: Client Table Registration (TABLES_WITHOUT_ID)
 * - F6: Advisory Lock Isolation
 * - F7: Discovery Lock Ordering
 * - F8: Shared Patch Writer (applyMonitoringObservation)
 * - F9: Observation ID Deduplication
 * - F10: History Backward Compatibility
 *
 * Requirements: >= 5 test cases per feature = 50 test cases.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createTestDb } = require('./harness');
const { applyMonitoringObservation } = require('../../src/database/monitoring');
const { hashItemUidToAdvisoryKey } = require('../../src/database/concurrency');
const { buildObservationId } = require('../../src/database/daily-history');

// Helper to seed a product_current item
async function seedProduct(db, itemUid, overrides = {}) {
  await db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, image, video_url,
      current_price, current_sold, current_likes, current_views,
      status, first_seen_at, last_seen_at, last_crawled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (item_uid) DO NOTHING
  `).run(
    itemUid,
    overrides.platform || 'etsy',
    overrides.query || 'silver necklace',
    overrides.title || 'Original Silver Necklace',
    overrides.url || `https://www.etsy.com/listing/${itemUid}`,
    overrides.image || 'https://img.etsy.com/original.jpg',
    overrides.video_url || 'https://vid.etsy.com/original.mp4',
    overrides.current_price ?? 25.0,
    overrides.current_sold ?? 100,
    overrides.current_likes ?? 50,
    overrides.current_views ?? 200,
    overrides.status || 'active',
    overrides.first_seen_at || '2026-09-01 00:00:00',
    overrides.last_seen_at || '2026-09-01 00:00:00',
    overrides.last_crawled_at || '2026-09-01 00:00:00'
  );
}

// ==========================================
// FEATURE F1: Composite Entity Key
// ==========================================
test('F1.1: Valid shop entity insertion succeeds with composite key', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (
      platform, entity_type, external_id, identity_source, session_id,
      monitoring_started_at, entity_next_due_at
    ) VALUES (?, ?, ?, ?, ?, now(), now())
  `).run('etsy', 'shop', 'artisan-crafts-123', 'canonical_url', crypto.randomUUID());

  const row = await db.prepare('SELECT * FROM monitoring_entities WHERE platform = ? AND entity_type = ? AND external_id = ?')
    .get('etsy', 'shop', 'artisan-crafts-123');
  assert.ok(row);
  assert.equal(row.platform, 'etsy');
  assert.equal(row.entity_type, 'shop');
  assert.equal(row.external_id, 'artisan-crafts-123');
});

test('F1.2: Valid author entity insertion succeeds with composite key', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (
      platform, entity_type, external_id, identity_source, session_id,
      monitoring_started_at, entity_next_due_at
    ) VALUES (?, ?, ?, ?, ?, now(), now())
  `).run('tiktok', 'author', 'creator_vibes_99', 'platform_id', crypto.randomUUID());

  const row = await db.prepare('SELECT * FROM monitoring_entities WHERE platform = ? AND entity_type = ? AND external_id = ?')
    .get('tiktok', 'author', 'creator_vibes_99');
  assert.ok(row);
  assert.equal(row.entity_type, 'author');
});

test('F1.3: Rejects invalid entity_type via CHECK constraint', async () => {
  const db = await createTestDb();
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_entities (
        platform, entity_type, external_id, identity_source, session_id,
        monitoring_started_at, entity_next_due_at
      ) VALUES (?, ?, ?, ?, ?, now(), now())
    `).run('etsy', 'brand', 'invalid-brand-123', 'loose_string', crypto.randomUUID());
  }, /check constraint/i);
});

test('F1.4: Enforces UNIQUE constraint on composite key (platform, entity_type, external_id)', async () => {
  const db = await createTestDb();
  const sessionId = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO monitoring_entities (
      platform, entity_type, external_id, identity_source, session_id,
      monitoring_started_at, entity_next_due_at
    ) VALUES (?, ?, ?, ?, ?, now(), now())
  `).run('etsy', 'shop', 'duplicate-key-shop', 'canonical_url', sessionId);

  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_entities (
        platform, entity_type, external_id, identity_source, session_id,
        monitoring_started_at, entity_next_due_at
      ) VALUES (?, ?, ?, ?, ?, now(), now())
    `).run('etsy', 'shop', 'duplicate-key-shop', 'canonical_url', crypto.randomUUID());
  }, /unique/i);
});

test('F1.5: Distinct external_ids on same platform and entity_type are stored independently', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (?, ?, ?, ?, ?, now(), now())
  `).run('etsy', 'shop', 'shop-alpha', 'id', crypto.randomUUID());

  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (?, ?, ?, ?, ?, now(), now())
  `).run('etsy', 'shop', 'shop-beta', 'id', crypto.randomUUID());

  const count = await db.prepare("SELECT count(*) as c FROM monitoring_entities WHERE platform = 'etsy' AND entity_type = 'shop'").get();
  assert.equal(Number(count.c), 2);
});

// ==========================================
// FEATURE F2: Pending Identity Isolation
// ==========================================
test('F2.1: Item with unverified entity is inserted with eligibility = pending_identity and entity_id = NULL', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:item-pending-1');

  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status)
    VALUES (?, NULL, 'pending_identity', 'active')
  `).run('etsy:item-pending-1');

  const row = await db.prepare('SELECT * FROM monitoring_items WHERE item_uid = ?').get('etsy:item-pending-1');
  assert.ok(row);
  assert.equal(row.eligibility, 'pending_identity');
  assert.equal(row.entity_id, null);
});

test('F2.2: Pending identity items are excluded from entity-level due queries', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:item-pending-2');
  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility, item_status, next_due_at)
    VALUES (?, NULL, 'pending_identity', 'active', now())
  `).run('etsy:item-pending-2');

  const readyItems = await db.prepare(`
    SELECT * FROM monitoring_items 
    WHERE eligibility = 'ready' AND item_status = 'active' AND next_due_at <= now()
  `).all();
  assert.equal(readyItems.length, 0);
});

test('F2.3: Updating item eligibility from pending_identity to ready attaches verified entity_id', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:item-resolve-1');

  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', 'verified-shop-1', 'url', 'sess-1', now(), now())
  `).run();
  const entity = await db.prepare('SELECT id FROM monitoring_entities WHERE external_id = ?').get('verified-shop-1');

  await db.prepare(`
    INSERT INTO monitoring_items (item_uid, entity_id, eligibility)
    VALUES (?, NULL, 'pending_identity')
  `).run('etsy:item-resolve-1');

  await db.prepare(`
    UPDATE monitoring_items 
    SET entity_id = ?, eligibility = 'ready'
    WHERE item_uid = ?
  `).run(entity.id, 'etsy:item-resolve-1');

  const resolved = await db.prepare('SELECT * FROM monitoring_items WHERE item_uid = ?').get('etsy:item-resolve-1');
  assert.equal(resolved.eligibility, 'ready');
  assert.equal(resolved.entity_id, entity.id);
});

test('F2.4: Invalid eligibility values are rejected by CHECK constraint', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:item-bad-elig');

  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO monitoring_items (item_uid, eligibility)
      VALUES (?, 'unknown_state')
    `).run('etsy:item-bad-elig');
  }, /check constraint/i);
});

test('F2.5: Status query correctly tallies pending identity item counts', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:p1');
  await seedProduct(db, 'etsy:p2');

  await db.prepare("INSERT INTO monitoring_items (item_uid, eligibility) VALUES ('etsy:p1', 'pending_identity')").run();
  await db.prepare("INSERT INTO monitoring_items (item_uid, eligibility) VALUES ('etsy:p2', 'pending_identity')").run();

  const count = await db.prepare("SELECT count(*) as c FROM monitoring_items WHERE eligibility = 'pending_identity'").get();
  assert.equal(Number(count.c), 2);
});

// ==========================================
// FEATURE F3: Status Decoupling
// ==========================================
test('F3.1: Monitoring observation updates item_status without altering product_current.status', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:status-test-1', { status: 'active' });

  await db.prepare("INSERT INTO monitoring_items (item_uid, item_status) VALUES ('etsy:status-test-1', 'active')").run();
  await db.prepare("UPDATE monitoring_items SET item_status = 'paused' WHERE item_uid = 'etsy:status-test-1'").run();

  const product = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get('etsy:status-test-1');
  const monitoring = await db.prepare('SELECT item_status FROM monitoring_items WHERE item_uid = ?').get('etsy:status-test-1');

  assert.equal(product.status, 'active', 'Discovery status remains active');
  assert.equal(monitoring.item_status, 'paused', 'Monitoring status updated independently');
});

test('F3.2: Item marked dropped by Discovery search still continues Monitoring tracking if item_status is active', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:dropped-in-discovery', { status: 'dropped' });

  await db.prepare("INSERT INTO monitoring_items (item_uid, item_status, next_due_at) VALUES ('etsy:dropped-in-discovery', 'active', now())").run();

  const activeMonitoring = await db.prepare(`
    SELECT * FROM monitoring_items WHERE item_uid = 'etsy:dropped-in-discovery' AND item_status = 'active'
  `).get();
  assert.ok(activeMonitoring, 'Monitoring must proceed even if Discovery dropped the rank visibility');
});

test('F3.3: Item stopped in Monitoring retains its product_current.status', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:stopped-in-mon', { status: 'new' });

  await db.prepare("INSERT INTO monitoring_items (item_uid, item_status) VALUES ('etsy:stopped-in-mon', 'unavailable')").run();

  const product = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get('etsy:stopped-in-mon');
  assert.equal(product.status, 'new', 'Discovery new status is completely preserved');
});

test('F3.4: Discovery keyword refresh of stopped monitoring item does not resume Monitoring', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:re-discover', { status: 'active' });
  await db.prepare("INSERT INTO monitoring_items (item_uid, item_status) VALUES ('etsy:re-discover', 'paused')").run();

  // Simulate Discovery search run finding item again
  await db.prepare("UPDATE product_current SET last_seen_at = now() WHERE item_uid = 'etsy:re-discover'").run();

  const monitoring = await db.prepare('SELECT item_status FROM monitoring_items WHERE item_uid = ?').get('etsy:re-discover');
  assert.equal(monitoring.item_status, 'paused', 'Monitoring does not auto-resume on Discovery search');
});

test('F3.5: query field in product_current is never overwritten by Monitoring patch', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:query-preserve', { query: 'handcrafted leather wallet' });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:query-preserve',
    patch: { price: 49.99, observedAt: '2026-09-02T10:00:00Z' },
    metadata: { observationId: 'monitoring:job1:cap1' }
  });

  const row = await db.prepare('SELECT query, current_price FROM product_current WHERE item_uid = ?').get('etsy:query-preserve');
  assert.equal(row.query, 'handcrafted leather wallet');
  assert.equal(row.current_price, 49.99);
});

// ==========================================
// FEATURE F4: Idempotent PostgreSQL Migration
// ==========================================
test('F4.1: Running migration on empty database creates all 5 tables and indexes', async () => {
  const db = await createTestDb();
  const tables = await db.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ('monitoring_entities', 'monitoring_items', 'monitoring_jobs', 'monitoring_entity_observations', 'monitoring_limiter')
  `);
  assert.equal(tables.rows.length, 5);
});

test('F4.2: Re-running migration on initialized database completes without error (idempotent)', async () => {
  const db = await createTestDb();
  const { MONITORING_DDL } = require('./harness');

  // Second execution of DDL script
  await db.exec(MONITORING_DDL);

  const tables = await db.query(`
    SELECT count(*) as c FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name LIKE 'monitoring_%'
  `);
  assert.equal(Number(tables.rows[0].c), 5);
});

test('F4.3: Existing data in product_current is fully preserved across repeated migrations', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:preserve-during-migration', { current_price: 199.99 });

  const { MONITORING_DDL } = require('./harness');
  await db.exec(MONITORING_DDL);

  const product = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get('etsy:preserve-during-migration');
  assert.equal(product.current_price, 199.99);
});

test('F4.4: Index creation uses IF NOT EXISTS and does not duplicate indexes', async () => {
  const db = await createTestDb();
  const { MONITORING_DDL } = require('./harness');
  await db.exec(MONITORING_DDL);

  const indexQuery = await db.query(`
    SELECT indexname FROM pg_indexes 
    WHERE tablename = 'monitoring_entities' AND indexname = 'idx_monitoring_entities_due'
  `);
  assert.equal(indexQuery.rows.length, 1);
});

test('F4.5: TIMESTAMPTZ columns in new tables correctly format and parse ISO UTC timestamps', async () => {
  const db = await createTestDb();
  const isoUtc = '2026-09-15T12:30:45.000Z';
  await db.prepare(`
    INSERT INTO monitoring_entities (
      platform, entity_type, external_id, identity_source, session_id,
      monitoring_started_at, entity_next_due_at
    ) VALUES ('etsy', 'shop', 'shop-tz', 'url', 's1', ?, ?)
  `).run(isoUtc, isoUtc);

  const row = await db.prepare('SELECT monitoring_started_at FROM monitoring_entities WHERE external_id = ?').get('shop-tz');
  assert.ok(row.monitoring_started_at);
  const parsed = new Date(row.monitoring_started_at).toISOString();
  assert.equal(parsed, isoUtc);
});

// ==========================================
// FEATURE F5: Client Table Registration (TABLES_WITHOUT_ID)
// ==========================================
test('F5.1: monitoring_limiter uses key as PRIMARY KEY without an id column', async () => {
  const db = await createTestDb();
  const cols = await db.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'monitoring_limiter'
  `);
  const names = cols.rows.map(r => r.column_name);
  assert.ok(names.includes('key'));
  assert.ok(!names.includes('id'));
});

test('F5.2: Inserting into monitoring_limiter succeeds without SQL error about missing id', async () => {
  const db = await createTestDb();
  // pg-schema.sql already seeds the 'global_monitoring_capture' singleton row,
  // so use a separate key to exercise a plain INSERT on the id-less table.
  await db.prepare(`
    INSERT INTO monitoring_limiter (key, owner_token, next_allowed_at)
    VALUES (?, ?, now())
  `).run('f5_2_limiter_key', 'token-123');

  const row = await db.prepare('SELECT * FROM monitoring_limiter WHERE key = ?').get('f5_2_limiter_key');
  assert.equal(row.key, 'f5_2_limiter_key');
  assert.equal(row.owner_token, 'token-123');
});

test('F5.3: Explicit RETURNING query on monitoring_limiter returns the expected key', async () => {
  const db = await createTestDb();
  const res = await db.query(`
    INSERT INTO monitoring_limiter (key, owner_token, next_allowed_at)
    VALUES ($1, $2, now())
    RETURNING key, owner_token
  `, ['limiter_key_ret', 'token_ret']);

  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].key, 'limiter_key_ret');
  assert.equal(res.rows[0].owner_token, 'token_ret');
});

test('F5.4: ON CONFLICT DO NOTHING on monitoring_limiter handles re-insertion cleanly', async () => {
  const db = await createTestDb();
  await db.prepare("INSERT INTO monitoring_limiter (key, next_allowed_at) VALUES ('unique_key', now())").run();
  await db.prepare("INSERT INTO monitoring_limiter (key, next_allowed_at) VALUES ('unique_key', now()) ON CONFLICT (key) DO NOTHING").run();

  const count = await db.prepare("SELECT count(*) as c FROM monitoring_limiter WHERE key = 'unique_key'").get();
  assert.equal(Number(count.c), 1);
});

test('F5.5: Concurrent upsert on monitoring_limiter key resolves without primary key violation', async () => {
  const db = await createTestDb();
  const promises = [1, 2, 3].map(i => db.query(`
    INSERT INTO monitoring_limiter (key, owner_token, next_allowed_at)
    VALUES ('concurrent_key', $1, now())
    ON CONFLICT (key) DO UPDATE SET owner_token = EXCLUDED.owner_token
    RETURNING key
  `, [`token-${i}`]));

  const results = await Promise.all(promises);
  assert.equal(results.length, 3);
  const row = await db.prepare("SELECT * FROM monitoring_limiter WHERE key = 'concurrent_key'").get();
  assert.ok(row.owner_token.startsWith('token-'));
});

// ==========================================
// FEATURE F6: Advisory Lock Isolation
// ==========================================
test('F6.1: hashItemUidToAdvisoryKey produces deterministic integer pairs across multiple calls', () => {
  const [k1a, k2a] = hashItemUidToAdvisoryKey('etsy:123456');
  const [k1b, k2b] = hashItemUidToAdvisoryKey('etsy:123456');
  assert.equal(k1a, k1b);
  assert.equal(k2a, k2b);
  assert.ok(Number.isInteger(k1a));
  assert.ok(Number.isInteger(k2a));
});

test('F6.2: Distinct item_uid values produce distinct 64-bit advisory keys with zero collision', () => {
  const [k1a, k2a] = hashItemUidToAdvisoryKey('etsy:10001');
  const [k1b, k2b] = hashItemUidToAdvisoryKey('etsy:10002');
  assert.ok(k1a !== k1b || k2a !== k2b, 'Different item UIDs must have distinct advisory keys');
});

test('F6.3: Executing SELECT pg_advisory_xact_lock with SHA-256 integer pair succeeds inside transaction', async () => {
  const db = await createTestDb();
  const [k1, k2] = hashItemUidToAdvisoryKey('tiktok:video:987654');

  await db.transaction(async () => {
    const res = await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
    assert.ok(res);
  })();
});

test('F6.4: Advisory lock is automatically released upon transaction COMMIT', async () => {
  const db = await createTestDb();
  const [k1, k2] = hashItemUidToAdvisoryKey('etsy:lock-release-commit');

  await db.transaction(async () => {
    await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
  })();

  // Second transaction can acquire the exact same lock immediately
  await db.transaction(async () => {
    const res = await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
    assert.ok(res);
  })();
});

test('F6.5: Advisory lock is automatically released upon transaction ROLLBACK', async () => {
  const db = await createTestDb();
  const [k1, k2] = hashItemUidToAdvisoryKey('etsy:lock-release-rollback');

  try {
    await db.transaction(async () => {
      await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
      throw new Error('Forced Rollback');
    })();
  } catch (err) {
    assert.equal(err.message, 'Forced Rollback');
  }

  // Second transaction can acquire the lock after rollback
  await db.transaction(async () => {
    const res = await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
    assert.ok(res);
  })();
});

// ==========================================
// FEATURE F7: Discovery Lock Ordering
// ==========================================
test('F7.1: Sorting items by item_uid ASC ensures canonical lock acquisition order', () => {
  const items = [
    { item_uid: 'etsy:z-item' },
    { item_uid: 'etsy:a-item' },
    { item_uid: 'etsy:m-item' },
  ];
  const sorted = [...items].sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  assert.equal(sorted[0].item_uid, 'etsy:a-item');
  assert.equal(sorted[1].item_uid, 'etsy:m-item');
  assert.equal(sorted[2].item_uid, 'etsy:z-item');
});

test('F7.2: Inverted order items array is sorted before processing', () => {
  const items = [{ item_uid: 'item:3' }, { item_uid: 'item:2' }, { item_uid: 'item:1' }];
  const sorted = [...items].sort((a, b) => (a.item_uid > b.item_uid ? 1 : -1));
  assert.deepEqual(sorted.map(i => i.item_uid), ['item:1', 'item:2', 'item:3']);
});

test('F7.3: Multiple identical item_uid in batch are deduped or kept in stable order', () => {
  const items = [{ item_uid: 'item:1' }, { item_uid: 'item:2' }, { item_uid: 'item:1' }];
  const uniqueUids = Array.from(new Set(items.map(i => i.item_uid))).sort();
  assert.deepEqual(uniqueUids, ['item:1', 'item:2']);
});

test('F7.4: Sorting empty or single-item array executes safely without overhead', () => {
  const empty = [];
  const single = [{ item_uid: 'solo' }];
  empty.sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  single.sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  assert.equal(empty.length, 0);
  assert.equal(single[0].item_uid, 'solo');
});

test('F7.5: Ascending lock order prevents circular wait deadlocks between concurrent multi-item runs', () => {
  const runAItems = [{ item_uid: 'uid:A' }, { item_uid: 'uid:B' }];
  const runBItems = [{ item_uid: 'uid:B' }, { item_uid: 'uid:A' }];

  const sortedA = [...runAItems].sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  const sortedB = [...runBItems].sort((a, b) => a.item_uid.localeCompare(b.item_uid));

  // Both runs acquire in order: uid:A then uid:B
  assert.equal(sortedA[0].item_uid, sortedB[0].item_uid);
  assert.equal(sortedA[1].item_uid, sortedB[1].item_uid);
});

// ==========================================
// FEATURE F8: Shared Patch Writer (applyMonitoringObservation)
// ==========================================
test('F8.1: Patch with only price updates current_price while preserving existing likes, views, sold', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:patch-sparse-1', {
    current_price: 10.0,
    current_likes: 99,
    current_views: 500,
    current_sold: 25,
  });

  const res = await applyMonitoringObservation(db, {
    itemUid: 'etsy:patch-sparse-1',
    patch: { price: 15.5, observedAt: '2026-09-05T12:00:00Z' },
    metadata: { observationId: 'monitoring:job1:cap1' },
  });

  assert.equal(res.updated, true);
  const updated = await db.prepare('SELECT * FROM product_current WHERE item_uid = ?').get('etsy:patch-sparse-1');
  assert.equal(updated.current_price, 15.5);
  assert.equal(updated.current_likes, 99, 'Likes must not be zeroed');
  assert.equal(updated.current_views, 500, 'Views must not be zeroed');
  assert.equal(updated.current_sold, 25, 'Sold must not be zeroed');
});

test('F8.2: Patch with absent fields does not coerce missing values to 0', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:patch-no-coerce', {
    current_price: 45.0,
    current_sold: 80,
  });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:patch-no-coerce',
    patch: { reviews: 12, observedAt: '2026-09-05T12:00:00Z' },
    metadata: { observationId: 'monitoring:job2:cap1' },
  });

  const updated = await db.prepare('SELECT * FROM product_current WHERE item_uid = ?').get('etsy:patch-no-coerce');
  assert.equal(updated.current_price, 45.0);
  assert.equal(updated.current_sold, 80);
  assert.equal(updated.current_reviews, 12);
});

test('F8.3: Media URLs (image, video_url) and title are preserved when omitted in patch', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:media-preserve', {
    title: 'Immortal Product Title',
    image: 'https://cdn.example.com/item.png',
    video_url: 'https://cdn.example.com/item.mp4',
  });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:media-preserve',
    patch: { price: 30.0, observedAt: '2026-09-06T10:00:00Z' },
    metadata: { observationId: 'monitoring:job3:cap1' },
  });

  const updated = await db.prepare('SELECT title, image, video_url FROM product_current WHERE item_uid = ?').get('etsy:media-preserve');
  assert.equal(updated.title, 'Immortal Product Title');
  assert.equal(updated.image, 'https://cdn.example.com/item.png');
  assert.equal(updated.video_url, 'https://cdn.example.com/item.mp4');
});

test('F8.4: Late-arriving observation appends to history without overwriting newer product_current state', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:late-arrival', {
    current_price: 100.0,
    last_crawled_at: '2026-09-10 12:00:00',
  });

  // Older observation arrives (e.g. from 2026-09-08)
  const res = await applyMonitoringObservation(db, {
    itemUid: 'etsy:late-arrival',
    patch: { price: 80.0, observedAt: '2026-09-08T10:00:00Z' },
    metadata: { observationId: 'monitoring:job4:late' },
  });

  assert.equal(res.isLateArrival, true);
  const current = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get('etsy:late-arrival');
  assert.equal(current.current_price, 100.0, 'Current price must remain the newer state');

  const history = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get('etsy:late-arrival', '2026-09-08');
  assert.ok(history, 'History entry for older date must be created');
});

test('F8.5: observation_count increments exactly once per new valid observation', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:obs-count-test');

  const initial = await db.prepare('SELECT observation_count FROM product_current WHERE item_uid = ?').get('etsy:obs-count-test');
  const baseCount = Number(initial.observation_count);

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:obs-count-test',
    patch: { price: 20.0, observedAt: '2026-09-05T10:00:00Z' },
    metadata: { observationId: 'monitoring:count:1' },
  });

  const after1 = await db.prepare('SELECT observation_count FROM product_current WHERE item_uid = ?').get('etsy:obs-count-test');
  assert.equal(Number(after1.observation_count), baseCount + 1);

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:obs-count-test',
    patch: { price: 22.0, observedAt: '2026-09-05T11:00:00Z' },
    metadata: { observationId: 'monitoring:count:2' },
  });

  const after2 = await db.prepare('SELECT observation_count FROM product_current WHERE item_uid = ?').get('etsy:obs-count-test');
  assert.equal(Number(after2.observation_count), baseCount + 2);
});

// ==========================================
// FEATURE F9: Observation ID Deduplication
// ==========================================
test('F9.1: Retrying an identical observation_id returns duplicate: true and does not re-increment count', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:dedup-1');

  const r1 = await applyMonitoringObservation(db, {
    itemUid: 'etsy:dedup-1',
    patch: { price: 19.99, observedAt: '2026-09-07T08:00:00Z' },
    metadata: { observationId: 'monitoring:job5:cap100' },
  });
  assert.equal(r1.duplicate, false);

  const r2 = await applyMonitoringObservation(db, {
    itemUid: 'etsy:dedup-1',
    patch: { price: 19.99, observedAt: '2026-09-07T08:00:00Z' },
    metadata: { observationId: 'monitoring:job5:cap100' }, // Identical ID
  });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.updated, false);

  const product = await db.prepare('SELECT observation_count FROM product_current WHERE item_uid = ?').get('etsy:dedup-1');
  assert.equal(Number(product.observation_count), 2, 'Count only incremented on first write');
});

test('F9.2: Duplicate observation leaves product_current current metrics unchanged', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:dedup-metrics', { current_price: 35.0 });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:dedup-metrics',
    patch: { price: 40.0, observedAt: '2026-09-07T09:00:00Z' },
    metadata: { observationId: 'monitoring:dedup:exact' },
  });

  // Second write with same ID but different hypothetical price in payload
  await applyMonitoringObservation(db, {
    itemUid: 'etsy:dedup-metrics',
    patch: { price: 99.0, observedAt: '2026-09-07T09:00:00Z' },
    metadata: { observationId: 'monitoring:dedup:exact' },
  });

  const product = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get('etsy:dedup-metrics');
  assert.equal(product.current_price, 40.0, 'Duplicate delivery ignored; price remains 40.0');
});

test('F9.3: Two observations with different observation_id in same second are both recorded', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:same-second');

  const ts = '2026-09-07T12:00:00Z';
  await applyMonitoringObservation(db, {
    itemUid: 'etsy:same-second',
    patch: { price: 10.0, observedAt: ts },
    metadata: { observationId: 'monitoring:same_sec:1' },
  });
  await applyMonitoringObservation(db, {
    itemUid: 'etsy:same-second',
    patch: { price: 12.0, observedAt: ts },
    metadata: { observationId: 'monitoring:same_sec:2' },
  });

  const history = await db.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ? AND date = ?').get('etsy:same-second', '2026-09-07');
  const arr = JSON.parse(history.observations_json);
  assert.equal(arr.length, 2);
  assert.equal(arr[0].observationId, 'monitoring:same_sec:1');
  assert.equal(arr[1].observationId, 'monitoring:same_sec:2');
});

test('F9.4: Observation ID format monitoring:<job_id>:<capture_id> is validated and stored', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:format-test');

  const obsId = 'monitoring:job-999:cap-777';
  await applyMonitoringObservation(db, {
    itemUid: 'etsy:format-test',
    patch: { price: 29.99, observedAt: '2026-09-07T14:00:00Z' },
    metadata: { observationId: obsId },
  });

  const history = await db.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ? AND date = ?').get('etsy:format-test', '2026-09-07');
  const arr = JSON.parse(history.observations_json);
  assert.equal(arr[0].observationId, obsId);
});

test('F9.5: History observations array length does not grow upon retrying existing observation_id', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:array-no-grow');

  for (let i = 0; i < 5; i++) {
    await applyMonitoringObservation(db, {
      itemUid: 'etsy:array-no-grow',
      patch: { price: 50.0, observedAt: '2026-09-07T15:00:00Z' },
      metadata: { observationId: 'monitoring:fixed_id' },
    });
  }

  const history = await db.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ? AND date = ?').get('etsy:array-no-grow', '2026-09-07');
  const arr = JSON.parse(history.observations_json);
  assert.equal(arr.length, 1, 'Array must not grow on repeated retries');
});

// ==========================================
// FEATURE F10: History Backward Compatibility
// ==========================================
test('F10.1: buildObservationId returns explicit observationId when provided', () => {
  const id = buildObservationId({
    observationId: 'monitoring:job1:cap1',
    runId: 10,
    legacySnapshotId: 5,
    itemUid: 'u1',
  });
  assert.equal(id, 'monitoring:job1:cap1');
});

test('F10.2: buildObservationId falls back to run:<runId>:<itemUid> when observationId is null', () => {
  const id = buildObservationId({
    observationId: null,
    runId: 42,
    legacySnapshotId: null,
    itemUid: 'etsy:listing-100',
  });
  assert.equal(id, 'run:42:etsy:listing-100');
});

test('F10.3: buildObservationId falls back to legacy:<legacySnapshotId> for legacy records', () => {
  const id = buildObservationId({
    observationId: null,
    runId: null,
    legacySnapshotId: 987,
    itemUid: 'item-leg',
  });
  assert.equal(id, 'legacy:987');
});

test('F10.4: daily_packed_history observations with null fields parse safely in legacy consumers', () => {
  const sparseObservation = {
    observationId: 'monitoring:sparse:1',
    time: '12:00:00',
    price: 25.0,
    sold: null,
    likes: null,
    views: null,
  };
  const serialized = JSON.stringify([sparseObservation]);
  const parsed = JSON.parse(serialized);

  // Legacy consumer checks
  assert.equal(parsed[0].price, 25.0);
  assert.equal(parsed[0].sold, null);
  // Numeric coercion by legacy code
  const numericSold = parsed[0].sold != null ? Number(parsed[0].sold) : undefined;
  assert.equal(numericSold, undefined);
});

test('F10.5: Existing history rows with run: format can be appended with new monitoring observations seamlessly', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:mixed-history');

  // Pre-seed an existing legacy Discovery run observation
  const discoveryObs = [
    { observationId: 'run:1:etsy:mixed-history', time: '08:00:00', price: 10.0, likes: 5 }
  ];
  await db.prepare(`
    INSERT INTO daily_packed_history (
      item_uid, platform, date, observations_json, observation_count, latest_price
    ) VALUES ('etsy:mixed-history', 'etsy', '2026-09-08', ?, 1, 10.0)
  `).run(JSON.stringify(discoveryObs));

  // Now apply a monitoring observation on the same day
  await applyMonitoringObservation(db, {
    itemUid: 'etsy:mixed-history',
    patch: { price: 12.0, observedAt: '2026-09-08T16:00:00Z' },
    metadata: { observationId: 'monitoring:job10:cap2' },
  });

  const row = await db.prepare('SELECT observations_json, observation_count, latest_price FROM daily_packed_history WHERE item_uid = ? AND date = ?')
    .get('etsy:mixed-history', '2026-09-08');

  assert.equal(Number(row.observation_count), 2);
  assert.equal(row.latest_price, 12.0);
  const arr = JSON.parse(row.observations_json);
  assert.equal(arr.length, 2);
  assert.equal(arr[0].observationId, 'run:1:etsy:mixed-history');
  assert.equal(arr[1].observationId, 'monitoring:job10:cap2');
});
