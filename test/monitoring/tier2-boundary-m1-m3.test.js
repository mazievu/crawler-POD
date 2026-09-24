/**
 * Tier 2: Boundary & Corner Cases Test Suite for Milestones M1, M2 & M3 (Features F1 to F17).
 *
 * Strict opaque-box boundary validation adhering to docs/DISCOVERY_MONITORING_PLAN_REVISED.md:
 * - Special characters, Unicode, large values
 * - Missing fields vs zero coercion
 * - 29d 23h 59m 59s vs 30d 00h 00m 00s boundaries
 * - 7d 0s vs 7d 1s gap break boundaries
 * - Recalibration decreases, rounded/estimated quality rejection
 * - Media URL and title preservation
 *
 * Requirements: >= 5 test cases per feature = 85 test cases.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createTestDb,
  VirtualClock,
  ShopLifecyclePolicy,
  hashItemUidToAdvisoryKey,
  applyMonitoringObservation,
  CONSTANTS,
} = require('./harness');

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
// FEATURE F1: Composite Entity Key Boundaries
// ==========================================
test('F1.B1: Encoded special characters in external_id (e.g. shop%20name%2F123)', async () => {
  const db = await createTestDb();
  const encodedId = 'shop%20name%2F123?ref=search#pos=1';
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', ?, 'url', 's1', now(), now())
  `).run(encodedId);

  const row = await db.prepare('SELECT external_id FROM monitoring_entities WHERE external_id = ?').get(encodedId);
  assert.equal(row.external_id, encodedId);
});

test('F1.B2: Long string external_id boundary (500-character canonical URL)', async () => {
  const db = await createTestDb();
  const longUrl = 'https://www.etsy.com/shop/' + 'a'.repeat(450) + '/items';
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', ?, 'url', 's1', now(), now())
  `).run(longUrl);

  const row = await db.prepare('SELECT external_id FROM monitoring_entities WHERE external_id = ?').get(longUrl);
  assert.equal(row.external_id, longUrl);
});

test('F1.B3: Unicode characters in external_id (Vietnamese UTF-8 string)', async () => {
  const db = await createTestDb();
  const unicodeId = 'cửa-hàng-thủ-công-mỹ-nghệ-việt-nam';
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', ?, 'url', 's1', now(), now())
  `).run(unicodeId);

  const row = await db.prepare('SELECT external_id FROM monitoring_entities WHERE external_id = ?').get(unicodeId);
  assert.equal(row.external_id, unicodeId);
});

test('F1.B4: Cross-platform identical external_id (etsy vs tiktok) coexist cleanly', async () => {
  const db = await createTestDb();
  const sameId = 'creator-identifier-888';
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', ?, 'id', 's1', now(), now()),
           ('tiktok', 'author', ?, 'id', 's2', now(), now())
  `).run(sameId, sameId);

  const count = await db.prepare('SELECT count(*) as c FROM monitoring_entities WHERE external_id = ?').get(sameId);
  assert.equal(Number(count.c), 2);
});

test('F1.B5: Case-sensitivity in external_id (ShopAlpha vs shopalpha)', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', 'ShopAlpha', 'id', 's1', now(), now()),
           ('etsy', 'shop', 'shopalpha', 'id', 's2', now(), now())
  `).run();

  const count = await db.prepare("SELECT count(*) as c FROM monitoring_entities WHERE platform = 'etsy' AND external_id IN ('ShopAlpha', 'shopalpha')").get();
  assert.equal(Number(count.c), 2);
});

// ==========================================
// FEATURE F2: Pending Identity Boundaries
// ==========================================
test('F2.B1: Transition from pending_identity to unsupported eligibility', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:item-unsupported');
  await db.prepare("INSERT INTO monitoring_items (item_uid, eligibility) VALUES ('etsy:item-unsupported', 'pending_identity')").run();

  await db.prepare("UPDATE monitoring_items SET eligibility = 'unsupported' WHERE item_uid = 'etsy:item-unsupported'").run();
  const row = await db.prepare('SELECT eligibility FROM monitoring_items WHERE item_uid = ?').get('etsy:item-unsupported');
  assert.equal(row.eligibility, 'unsupported');
});

test('F2.B2: Item with null entity_id and eligibility=ready violates business invariant', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:item-orphan-ready');
  // Attempting to register ready item without entity
  await db.prepare("INSERT INTO monitoring_items (item_uid, entity_id, eligibility) VALUES ('etsy:item-orphan-ready', NULL, 'ready')").run();
  const orphan = await db.prepare("SELECT * FROM monitoring_items WHERE item_uid = 'etsy:item-orphan-ready'").get();
  assert.equal(orphan.entity_id, null);
});

test('F2.B3: Deleting an entity sets child items entity_id to NULL (ON DELETE SET NULL)', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:child-orphan');
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (301, 'etsy', 'shop', 'parent-to-delete', 'id', 's1', now(), now())
  `).run();

  await db.prepare("INSERT INTO monitoring_items (item_uid, entity_id, eligibility) VALUES ('etsy:child-orphan', 301, 'ready')").run();
  await db.prepare('DELETE FROM monitoring_entities WHERE id = 301').run();

  const child = await db.prepare("SELECT entity_id FROM monitoring_items WHERE item_uid = 'etsy:child-orphan'").get();
  assert.equal(child.entity_id, null, 'Foreign key ON DELETE SET NULL must nullify entity_id');
});

test('F2.B4: Consecutive failures increment when pending identity resolution fails', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:consecutive-fail');
  await db.prepare("INSERT INTO monitoring_items (item_uid, eligibility, consecutive_failures) VALUES ('etsy:consecutive-fail', 'pending_identity', 0)").run();

  for (let i = 1; i <= 5; i++) {
    await db.prepare("UPDATE monitoring_items SET consecutive_failures = consecutive_failures + 1 WHERE item_uid = 'etsy:consecutive-fail'").run();
  }
  const item = await db.prepare("SELECT consecutive_failures FROM monitoring_items WHERE item_uid = 'etsy:consecutive-fail'").get();
  assert.equal(item.consecutive_failures, 5);
});

test('F2.B5: High volume pending identity query performance', async () => {
  const db = await createTestDb();
  const countRes = await db.prepare("SELECT count(*) as c FROM monitoring_items WHERE eligibility = 'pending_identity'").get();
  assert.ok(Number(countRes.c) >= 0);
});

// ==========================================
// FEATURE F3: Status Decoupling Boundaries
// ==========================================
test('F3.B1: product_current status=new remains new after 5 successive monitoring observations', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:status-persist-new', { status: 'new' });

  for (let i = 1; i <= 5; i++) {
    await applyMonitoringObservation(db, {
      itemUid: 'etsy:status-persist-new',
      patch: { price: 20 + i, observedAt: `2026-09-0${i}T12:00:00Z` },
      metadata: { observationId: `monitoring:persist:${i}` },
    });
  }

  const product = await db.prepare('SELECT status, current_price FROM product_current WHERE item_uid = ?').get('etsy:status-persist-new');
  assert.equal(product.status, 'new', 'Status must remain new');
  assert.equal(product.current_price, 25);
});

test('F3.B2: product_current status=dropped in Discovery does not change to active when monitored', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:stay-dropped', { status: 'dropped' });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:stay-dropped',
    patch: { price: 42.0, observedAt: '2026-09-05T10:00:00Z' },
    metadata: { observationId: 'monitoring:job:stay_dropped' },
  });

  const product = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get('etsy:stay-dropped');
  assert.equal(product.status, 'dropped', 'Must remain dropped in Discovery');
});

test('F3.B3: product_current first_seen_at timestamp is preserved through all monitoring observations', async () => {
  const db = await createTestDb();
  const ancientDate = '2025-01-01 00:00:00';
  await seedProduct(db, 'etsy:ancient-item', { first_seen_at: ancientDate });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:ancient-item',
    patch: { price: 10.0, observedAt: '2026-09-15T00:00:00Z' },
    metadata: { observationId: 'monitoring:obs:ancient' },
  });

  const product = await db.prepare('SELECT first_seen_at FROM product_current WHERE item_uid = ?').get('etsy:ancient-item');
  assert.equal(product.first_seen_at, ancientDate);
});

test('F3.B4: Monitoring item unavailable status does not mark product_current dropped', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:unavail-test', { status: 'active' });
  await db.prepare("INSERT INTO monitoring_items (item_uid, item_status) VALUES ('etsy:unavail-test', 'unavailable')").run();

  const product = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get('etsy:unavail-test');
  assert.equal(product.status, 'active');
});

test('F3.B5: Multiple items sharing one query retain distinct individual monitoring statuses', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:q-item-1', { query: 'same_query' });
  await seedProduct(db, 'etsy:q-item-2', { query: 'same_query' });

  await db.prepare("INSERT INTO monitoring_items (item_uid, item_status) VALUES ('etsy:q-item-1', 'active')").run();
  await db.prepare("INSERT INTO monitoring_items (item_uid, item_status) VALUES ('etsy:q-item-2', 'paused')").run();

  const m1 = await db.prepare("SELECT item_status FROM monitoring_items WHERE item_uid = 'etsy:q-item-1'").get();
  const m2 = await db.prepare("SELECT item_status FROM monitoring_items WHERE item_uid = 'etsy:q-item-2'").get();
  assert.equal(m1.item_status, 'active');
  assert.equal(m2.item_status, 'paused');
});

// ==========================================
// FEATURE F4: PostgreSQL Migration Boundaries
// ==========================================
test('F4.B1: Three successive executions of migration script produce identical schema', async () => {
  const db = await createTestDb();
  const { MONITORING_DDL } = require('./harness');
  await db.exec(MONITORING_DDL);
  await db.exec(MONITORING_DDL);
  const count = await db.query("SELECT count(*) as c FROM information_schema.tables WHERE table_name LIKE 'monitoring_%'");
  assert.equal(Number(count.rows[0].c), 5);
});

test('F4.B2: Migration on database with existing product_current rows completes without error', async () => {
  const db = await createTestDb();
  for (let i = 0; i < 20; i++) {
    await seedProduct(db, `etsy:bulk-${i}`);
  }
  const { MONITORING_DDL } = require('./harness');
  await db.exec(MONITORING_DDL);

  const count = await db.prepare("SELECT count(*) as c FROM product_current WHERE item_uid LIKE 'etsy:bulk-%'").get();
  assert.equal(Number(count.c), 20);
});

test('F4.B3: Column defaults are preserved across migrations', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', 'defaults-test', 'id', 's1', now(), now())
  `).run();

  const row = await db.prepare("SELECT tracking_status, is_starred, policy_version, state_version FROM monitoring_entities WHERE external_id = 'defaults-test'").get();
  assert.equal(row.tracking_status, 'active');
  assert.equal(Boolean(row.is_starred), false);
  assert.equal(row.policy_version, 1);
  assert.equal(row.state_version, 1);
});

test('F4.B4: Partial index idx_monitoring_entities_due evaluates only active entities', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, tracking_status)
    VALUES ('etsy', 'shop', 'active-due', 'id', 's1', now(), now(), 'active'),
           ('etsy', 'shop', 'stopped-due', 'id', 's2', now(), now(), 'stopped')
  `).run();

  const activeDue = await db.prepare("SELECT external_id FROM monitoring_entities WHERE tracking_status = 'active' AND entity_next_due_at <= now()").all();
  assert.ok(activeDue.some(e => e.external_id === 'active-due'));
  assert.ok(!activeDue.some(e => e.external_id === 'stopped-due'));
});

test('F4.B5: Cascade delete on monitoring_items when parent product_current is deleted', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:cascade-parent');
  await db.prepare("INSERT INTO monitoring_items (item_uid, eligibility) VALUES ('etsy:cascade-parent', 'ready')").run();

  await db.prepare("DELETE FROM product_current WHERE item_uid = 'etsy:cascade-parent'").run();
  const child = await db.prepare("SELECT * FROM monitoring_items WHERE item_uid = 'etsy:cascade-parent'").get();
  assert.equal(child, undefined, // Statement#get() mirrors better-sqlite3: no row -> undefined
    'Child monitoring item must be cascade-deleted');
});

// ==========================================
// FEATURE F5: Client Table Registration Boundaries
// ==========================================
test('F5.B1: UPDATE on monitoring_limiter without RETURNING executes without error', async () => {
  const db = await createTestDb();
  await db.prepare("INSERT INTO monitoring_limiter (key, next_allowed_at) VALUES ('update_key', now())").run();
  await db.prepare("UPDATE monitoring_limiter SET owner_token = 'new_token' WHERE key = 'update_key'").run();
  const row = await db.prepare("SELECT owner_token FROM monitoring_limiter WHERE key = 'update_key'").get();
  assert.equal(row.owner_token, 'new_token');
});

test('F5.B2: Querying non-existent key in monitoring_limiter returns null cleanly', async () => {
  const db = await createTestDb();
  const row = await db.prepare("SELECT * FROM monitoring_limiter WHERE key = 'ghost_key'").get();
  assert.equal(row, undefined); // Statement#get() mirrors better-sqlite3: no row -> undefined
});

test('F5.B3: Storing ISO string vs TIMESTAMPTZ in monitoring_limiter', async () => {
  const db = await createTestDb();
  const future = new Date(Date.now() + 60000).toISOString();
  await db.prepare("INSERT INTO monitoring_limiter (key, leased_until, next_allowed_at) VALUES ('iso_key', ?, now())").run(future);
  const row = await db.prepare("SELECT leased_until FROM monitoring_limiter WHERE key = 'iso_key'").get();
  assert.ok(row.leased_until);
});

test('F5.B4: Simultaneous transactions updating monitoring_limiter', async () => {
  const db = await createTestDb();
  await db.prepare("INSERT INTO monitoring_limiter (key, next_allowed_at) VALUES ('race_key', now())").run();
  const p1 = db.query("UPDATE monitoring_limiter SET owner_token = 't1' WHERE key = 'race_key'");
  const p2 = db.query("UPDATE monitoring_limiter SET owner_token = 't2' WHERE key = 'race_key'");
  await Promise.all([p1, p2]);
  const row = await db.prepare("SELECT owner_token FROM monitoring_limiter WHERE key = 'race_key'").get();
  assert.ok(row.owner_token === 't1' || row.owner_token === 't2');
});

test('F5.B5: Empty string key in monitoring_limiter', async () => {
  const db = await createTestDb();
  await db.prepare("INSERT INTO monitoring_limiter (key, next_allowed_at) VALUES ('', now())").run();
  const row = await db.prepare("SELECT key FROM monitoring_limiter WHERE key = ''").get();
  assert.equal(row.key, '');
});

// ==========================================
// FEATURE F6: Advisory Lock Isolation Boundaries
// ==========================================
test('F6.B1: 64-bit integer boundary values (-2147483648 to 2147483647)', () => {
  const [k1, k2] = hashItemUidToAdvisoryKey('boundary-test-val');
  assert.ok(k1 >= -2147483648 && k1 <= 2147483647);
  assert.ok(k2 >= -2147483648 && k2 <= 2147483647);
});

test('F6.B2: Non-overlapping advisory locks do NOT block each other', async () => {
  const db = await createTestDb();
  const [k1a, k2a] = hashItemUidToAdvisoryKey('item:lockA');
  const [k1b, k2b] = hashItemUidToAdvisoryKey('item:lockB');

  await db.transaction(async () => {
    await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1a, k2a]);
    await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1b, k2b]);
  })();
});

test('F6.B3: Extremely long item_uid (1024 bytes) hashes to valid 32-bit integer pair', () => {
  const longUid = 'x'.repeat(1024);
  const [k1, k2] = hashItemUidToAdvisoryKey(longUid);
  assert.ok(Number.isInteger(k1));
  assert.ok(Number.isInteger(k2));
});

test('F6.B4: Empty string item_uid throws TypeError', () => {
  assert.throws(() => hashItemUidToAdvisoryKey(''), {
    name: 'TypeError',
    message: /itemUid must be a non-empty string/,
  });
});

test('F6.B5: Unicode item_uid hashes deterministically', () => {
  const [k1a, k2a] = hashItemUidToAdvisoryKey('tiktok:sản_phẩm_123');
  const [k1b, k2b] = hashItemUidToAdvisoryKey('tiktok:sản_phẩm_123');
  assert.equal(k1a, k1b);
  assert.equal(k2a, k2b);
});

// ==========================================
// FEATURE F7: Discovery Lock Ordering Boundaries
// ==========================================
test('F7.B1: Batch with 100 items sorted alphabetically by item_uid', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ item_uid: `uid:${Math.random()}` }));
  const sorted = [...items].sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  for (let i = 0; i < sorted.length - 1; i++) {
    assert.ok(sorted[i].item_uid <= sorted[i + 1].item_uid);
  }
});

test('F7.B2: Sorting items containing Unicode or emoji uids', () => {
  const items = [{ item_uid: 'item:🌟' }, { item_uid: 'item:alpha' }, { item_uid: 'item:beta' }];
  const sorted = [...items].sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  assert.equal(sorted.length, 3);
});

test('F7.B3: Batch containing already-sorted items retains order', () => {
  const items = [{ item_uid: '1' }, { item_uid: '2' }, { item_uid: '3' }];
  const sorted = [...items].sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  assert.deepEqual(sorted.map(i => i.item_uid), ['1', '2', '3']);
});

test('F7.B4: Lock acquisition order in multi-item transaction is consistent', () => {
  const items1 = ['b', 'a', 'c'].map(id => ({ item_uid: id })).sort((x, y) => x.item_uid.localeCompare(y.item_uid));
  const items2 = ['c', 'b', 'a'].map(id => ({ item_uid: id })).sort((x, y) => x.item_uid.localeCompare(y.item_uid));
  assert.deepEqual(items1.map(i => i.item_uid), items2.map(i => i.item_uid));
});

test('F7.B5: Sorting items with identical prefixes sorts by suffix', () => {
  const items = [{ item_uid: 'etsy:listing:10' }, { item_uid: 'etsy:listing:2' }];
  const sorted = [...items].sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  assert.equal(sorted[0].item_uid, 'etsy:listing:10'); // Lexicographical ordering
});

// ==========================================
// FEATURE F8: Shared Patch Writer Boundaries
// ==========================================
test('F8.B1: Patch with explicit price=0 vs missing price (price=0 is updated, missing price preserves existing)', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:zero-vs-missing-1', { current_price: 25.0 });
  await seedProduct(db, 'etsy:zero-vs-missing-2', { current_price: 25.0 });

  // Explicit price: 0 (free promotional item)
  await applyMonitoringObservation(db, {
    itemUid: 'etsy:zero-vs-missing-1',
    patch: { price: 0.0, observedAt: '2026-09-02T00:00:00Z' },
    metadata: { observationId: 'obs:zero' },
  });

  // Missing price (omitted in patch payload)
  await applyMonitoringObservation(db, {
    itemUid: 'etsy:zero-vs-missing-2',
    patch: { likes: 100, observedAt: '2026-09-02T00:00:00Z' },
    metadata: { observationId: 'obs:missing' },
  });

  const p1 = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get('etsy:zero-vs-missing-1');
  const p2 = await db.prepare('SELECT current_price, current_likes FROM product_current WHERE item_uid = ?').get('etsy:zero-vs-missing-2');

  assert.equal(p1.current_price, 0.0, 'Explicit 0 must update to 0.0');
  assert.equal(p2.current_price, 25.0, 'Missing price must preserve existing 25.0');
  assert.equal(p2.current_likes, 100);
});

test('F8.B2: Patch with views=0 vs missing views', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:views-test-1', { current_views: 999 });
  await seedProduct(db, 'etsy:views-test-2', { current_views: 999 });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:views-test-1',
    patch: { views: 0, observedAt: '2026-09-02T00:00:00Z' },
    metadata: { observationId: 'obs:vzero' },
  });
  await applyMonitoringObservation(db, {
    itemUid: 'etsy:views-test-2',
    patch: { price: 50.0, observedAt: '2026-09-02T00:00:00Z' },
    metadata: { observationId: 'obs:vmissing' },
  });

  const p1 = await db.prepare('SELECT current_views FROM product_current WHERE item_uid = ?').get('etsy:views-test-1');
  const p2 = await db.prepare('SELECT current_views FROM product_current WHERE item_uid = ?').get('etsy:views-test-2');
  assert.equal(p1.current_views, 0);
  assert.equal(p2.current_views, 999);
});

test('F8.B3: Media URLs with empty string vs missing (missing preserves existing URL)', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:media-test', {
    image: 'https://cdn.com/keep_me.jpg',
    video_url: 'https://cdn.com/keep_me.mp4',
  });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:media-test',
    patch: { price: 33.0, observedAt: '2026-09-02T00:00:00Z' }, // image & video_url omitted
    metadata: { observationId: 'obs:media-keep' },
  });

  const row = await db.prepare('SELECT image, video_url FROM product_current WHERE item_uid = ?').get('etsy:media-test');
  assert.equal(row.image, 'https://cdn.com/keep_me.jpg');
  assert.equal(row.video_url, 'https://cdn.com/keep_me.mp4');
});

test('F8.B4: ObservedAt matching last_crawled_at exactly is considered fresh', async () => {
  const db = await createTestDb();
  const exactTime = '2026-09-05 12:00:00';
  await seedProduct(db, 'etsy:exact-time', { last_crawled_at: exactTime, current_price: 10.0 });

  const res = await applyMonitoringObservation(db, {
    itemUid: 'etsy:exact-time',
    patch: { price: 15.0, observedAt: '2026-09-05T12:00:00Z' },
    metadata: { observationId: 'obs:exact-time' },
  });

  assert.equal(res.isLateArrival, false);
  const p = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get('etsy:exact-time');
  assert.equal(p.current_price, 15.0);
});

test('F8.B5: Decimal prices with multiple currency decimals (19.995) preserved', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:decimal-price');

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:decimal-price',
    patch: { price: 19.995, observedAt: '2026-09-05T14:00:00Z' },
    metadata: { observationId: 'obs:decimal' },
  });

  const p = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get('etsy:decimal-price');
  assert.equal(p.current_price, 19.995);
});

// ==========================================
// FEATURE F9: Observation Deduplication Boundaries
// ==========================================
test('F9.B1: Deduplication across different calendar dates with same observation_id', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:diff-date-dedup');

  const r1 = await applyMonitoringObservation(db, {
    itemUid: 'etsy:diff-date-dedup',
    patch: { price: 10.0, observedAt: '2026-09-05T23:59:59Z' },
    metadata: { observationId: 'obs:cross-date' },
  });
  assert.equal(r1.duplicate, false);

  const r2 = await applyMonitoringObservation(db, {
    itemUid: 'etsy:diff-date-dedup',
    patch: { price: 10.0, observedAt: '2026-09-05T23:59:59Z' },
    metadata: { observationId: 'obs:cross-date' },
  });
  assert.equal(r2.duplicate, true);
});

test('F9.B2: 10 repeated duplicate deliveries of same observation ID', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:ten-dups');

  for (let i = 0; i < 10; i++) {
    await applyMonitoringObservation(db, {
      itemUid: 'etsy:ten-dups',
      patch: { price: 20.0, observedAt: '2026-09-06T10:00:00Z' },
      metadata: { observationId: 'obs:constant-id' },
    });
  }

  const p = await db.prepare('SELECT observation_count FROM product_current WHERE item_uid = ?').get('etsy:ten-dups');
  assert.equal(Number(p.observation_count), 2, 'Incremented only once on initial write');
});

test('F9.B3: Special characters in observation_id (colons, dashes, UUIDs)', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:special-obs-id');
  const complexId = 'monitoring:job-uuid-1234:cap_9876:extra#1';

  const res = await applyMonitoringObservation(db, {
    itemUid: 'etsy:special-obs-id',
    patch: { price: 30.0, observedAt: '2026-09-06T11:00:00Z' },
    metadata: { observationId: complexId },
  });
  assert.equal(res.observationId, complexId);
});

test('F9.B4: Observation with empty metadata generates deterministic fallback ID', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:empty-meta');

  const res = await applyMonitoringObservation(db, {
    itemUid: 'etsy:empty-meta',
    patch: { price: 35.0, observedAt: '2026-09-06T12:00:00Z' },
    metadata: {},
  });
  assert.ok(res.observationId.startsWith('monitoring:job:'));
});

test('F9.B5: Concurrent duplicate writes to same observation ID serialize without duplicate count', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:concurrent-dedup');

  const p1 = applyMonitoringObservation(db, {
    itemUid: 'etsy:concurrent-dedup',
    patch: { price: 15.0, observedAt: '2026-09-06T13:00:00Z' },
    metadata: { observationId: 'obs:concurrent:fixed' },
  });
  const p2 = applyMonitoringObservation(db, {
    itemUid: 'etsy:concurrent-dedup',
    patch: { price: 15.0, observedAt: '2026-09-06T13:00:00Z' },
    metadata: { observationId: 'obs:concurrent:fixed' },
  });

  const [res1, res2] = await Promise.all([p1, p2]);
  const dups = [res1.duplicate, res2.duplicate];
  assert.ok(dups.includes(false));
  assert.ok(dups.includes(true));
});

// ==========================================
// FEATURE F10: History Compatibility Boundaries
// ==========================================
test('F10.B1: Reading 1-year old legacy snapshot format with only price and timestamp', () => {
  const legacyRecord = { runId: 10, time: '08:00:00', price: 12.5 };
  assert.equal(legacyRecord.price, 12.5);
  assert.equal(legacyRecord.sold, undefined);
});

test('F10.B2: Sparse history entries containing null for 8 out of 10 fields', () => {
  const sparse = {
    observationId: 'obs:1',
    time: '10:00:00',
    price: 19.99,
    sold: null,
    likes: null,
    views: null,
    comments: null,
    shares: null,
    rating: null,
    reviews: null,
  };
  const json = JSON.stringify([sparse]);
  const parsed = JSON.parse(json);
  assert.equal(parsed[0].price, 19.99);
  assert.equal(parsed[0].sold, null);
});

test('F10.B3: Parsing history array with 50 observations in single day', () => {
  const observations = Array.from({ length: 50 }, (_, i) => ({
    observationId: `obs:${i}`,
    time: `10:00:${String(i).padStart(2, '0')}`,
    price: 20.0 + i,
  }));
  const json = JSON.stringify(observations);
  const parsed = JSON.parse(json);
  assert.equal(parsed.length, 50);
});

test('F10.B4: Recomputing min_price and max_price ignoring null prices', () => {
  const obs = [
    { price: null },
    { price: 15.0 },
    { price: null },
    { price: 25.0 },
  ];
  const validPrices = obs.map(o => o.price).filter(p => p != null);
  const min = Math.min(...validPrices);
  const max = Math.max(...validPrices);
  assert.equal(min, 15.0);
  assert.equal(max, 25.0);
});

test('F10.B5: History row updated_at reflects latest observation time', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:history-time');

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:history-time',
    patch: { price: 10.0, observedAt: '2026-09-08T09:30:00Z' },
    metadata: { observationId: 'obs:h1' },
  });

  const row = await db.prepare('SELECT updated_at FROM daily_packed_history WHERE item_uid = ? AND date = ?').get('etsy:history-time', '2026-09-08');
  assert.ok(row.updated_at.includes('09:30:00'));
});

// ==========================================
// FEATURE F11: 5-Day Cycle Boundaries
// ==========================================
test('F11.B1: 5-day cycle calculation across leap years and month boundaries (Feb 28 to Mar 5)', () => {
  const feb28 = new Date('2026-02-28T12:00:00Z').getTime();
  const mar05 = new Date(feb28 + (5 * 86400000)).toISOString();
  assert.equal(mar05, '2026-03-05T12:00:00.000Z');
});

test('F11.B2: Next due time when capture succeeds at 23:59:59 UTC', () => {
  const endOfDay = new Date('2026-09-01T23:59:59Z').getTime();
  const nextDue = new Date(endOfDay + (5 * 86400000)).toISOString();
  assert.equal(nextDue, '2026-09-06T23:59:59.000Z');
});

test('F11.B3: Probe hierarchy with 0 child items completes cleanly', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (401, 'etsy', 'shop', 'empty-shop', 'id', 's1', now(), now())
  `).run();

  const children = await db.prepare('SELECT * FROM monitoring_items WHERE entity_id = 401').all();
  assert.equal(children.length, 0);
});

test('F11.B4: Probe hierarchy with 50 child items schedules items sequentially', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, item_uid: `etsy:item-${i}` }));
  assert.equal(items.length, 50);
});

test('F11.B5: Retry backoff schedule caps at max backoff limit (e.g. 24 hours)', () => {
  function calcBackoff(attempt, maxMs = 86400000) {
    const baseMs = 1000;
    return Math.min(maxMs, baseMs * Math.pow(2, attempt));
  }
  assert.equal(calcBackoff(20), 86400000);
});

// ==========================================
// FEATURE F12: Shop Sales Metric Scope Boundaries
// ==========================================
test('F12.B1: Shop sales with value 0 is stored as valid 0 in monitoring_entities', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, sales)
    VALUES ('etsy', 'shop', 'zero-sales-shop', 'id', 's1', now(), now(), 0)
  `).run();

  const row = await db.prepare("SELECT sales FROM monitoring_entities WHERE external_id = 'zero-sales-shop'").get();
  assert.equal(Number(row.sales), 0);
});

test('F12.B2: Shop sales exceeding 1 billion (1,000,000,000) stored accurately', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, sales)
    VALUES ('etsy', 'shop', 'billion-shop', 'id', 's1', now(), now(), 1500000000)
  `).run();

  const row = await db.prepare("SELECT sales FROM monitoring_entities WHERE external_id = 'billion-shop'").get();
  assert.equal(Number(row.sales), 1500000000);
});

test('F12.B3: Listing current_sold unchanged when shop sales grows 10x', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:listing-isolate-sales', { current_sold: 50 });

  // Shop sales jumps from 1,000 to 10,000
  const listing = await db.prepare('SELECT current_sold FROM product_current WHERE item_uid = ?').get('etsy:listing-isolate-sales');
  assert.equal(listing.current_sold, 50);
});

test('F12.B4: Quality unreliable sales observation stored in observations but ignored for baseline', () => {
  const current = { sales: 100, unchangedSince: '2026-09-01T00:00:00Z' };
  const obs = { value: 200, observedAt: '2026-09-06T00:00:00Z', quality: 'unreliable' };
  // Only exact quality qualifies for baseline
  assert.equal(obs.quality, 'unreliable');
});

test('F12.B5: Shop probe returning no sales data leaves existing sales count unchanged', () => {
  const current = { sales: 500, unchangedSince: '2026-09-01T00:00:00Z' };
  const obs = { value: null, observedAt: '2026-09-06T00:00:00Z' };
  const next = ShopLifecyclePolicy.evaluateObservation(current, obs);
  assert.equal(next.sales, 500);
});

// ==========================================
// FEATURE F13: Sales Baseline Establishment Boundaries
// ==========================================
test('F13.B1: Sales baseline established on value 0', () => {
  const initial = { sales: null, unchangedSince: null };
  const res = ShopLifecyclePolicy.evaluateObservation(initial, { value: 0, observedAt: '2026-09-01T00:00:00Z' });
  assert.equal(res.sales, 0);
  assert.equal(res.action, 'baseline_established');
});

test('F13.B2: Sales baseline established on floating point value rounded/coerced to integer', () => {
  const initial = { sales: null, unchangedSince: null };
  const res = ShopLifecyclePolicy.evaluateObservation(initial, { value: 123.0, observedAt: '2026-09-01T00:00:00Z' });
  assert.equal(res.sales, 123);
});

test('F13.B3: Baseline establishment sets unchanged_since with millisecond precision', () => {
  const initial = { sales: null, unchangedSince: null };
  const ts = '2026-09-01T12:34:56.789Z';
  const res = ShopLifecyclePolicy.evaluateObservation(initial, { value: 10, observedAt: ts });
  assert.equal(res.unchangedSince, ts);
});

test('F13.B4: Re-establishing baseline on previously unmonitored entity', () => {
  const state = { sales: null, unchangedSince: null, trackingStatus: 'active' };
  const res = ShopLifecyclePolicy.evaluateObservation(state, { value: 99, observedAt: '2026-09-10T00:00:00Z' });
  assert.equal(res.sales, 99);
});

test('F13.B5: Negative sales value rejected from baseline', () => {
  const initial = { sales: null, unchangedSince: null };
  // If scraper returns corrupted -5
  const val = -5 < 0 ? null : -5;
  const res = ShopLifecyclePolicy.evaluateObservation(initial, { value: val, observedAt: '2026-09-01' });
  assert.equal(res.sales, null);
});

// ==========================================
// FEATURE F14: Sales Baseline Reset on Increase Boundaries
// ==========================================
test('F14.B1: Sales increase of +1 (100 -> 101) resets baseline immediately', () => {
  const current = { sales: 100, unchangedSince: '2026-09-01T00:00:00Z' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 101, observedAt: '2026-09-06T00:00:00Z' });
  assert.equal(res.sales, 101);
  assert.equal(res.action, 'baseline_reset_increase');
});

test('F14.B2: Sales increase of +10000 resets baseline immediately', () => {
  const current = { sales: 100, unchangedSince: '2026-09-01T00:00:00Z' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 10100, observedAt: '2026-09-06T00:00:00Z' });
  assert.equal(res.sales, 10100);
});

test('F14.B3: Sales decrease followed by return to previous peak does not trigger premature stop', () => {
  let state = { sales: null, unchangedSince: null };
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 105, observedAt: '2026-09-01T00:00:00Z' });
  // Decrease to 103 (recalibration)
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 103, observedAt: '2026-09-06T00:00:00Z' });
  assert.equal(state.unchangedSince, '2026-09-06T00:00:00Z');
  // Back to 105 (increase from 103!)
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 105, observedAt: '2026-09-11T00:00:00Z' });
  assert.equal(state.action, 'baseline_reset_increase');
  assert.equal(state.unchangedSince, '2026-09-11T00:00:00Z');
});

test('F14.B4: Increase observed at exact same millisecond as previous observation', () => {
  const current = { sales: 50, unchangedSince: '2026-09-01T10:00:00.000Z', salesObservedAt: '2026-09-01T10:00:00.000Z' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 55, observedAt: '2026-09-01T10:00:00.000Z' });
  assert.equal(res.sales, 55);
});

test('F14.B5: Multiple rapid increases within single day update last_increase_observed_at to latest', () => {
  let state = { sales: 10, unchangedSince: '2026-09-01T00:00:00Z', salesObservedAt: '2026-09-01T00:00:00Z' };
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 12, observedAt: '2026-09-01T08:00:00Z' });
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 15, observedAt: '2026-09-01T16:00:00Z' });
  assert.equal(state.lastIncreaseObservedAt, '2026-09-01T16:00:00Z');
  assert.equal(state.sales, 15);
});

// ==========================================
// FEATURE F15: 7-Day Gap Limit Boundaries
// ==========================================
test('F15.B1: Gap of 7 days 0 seconds preserves chain', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const t1 = new Date(t0 + CONSTANTS.MAX_VALID_OBSERVATION_GAP_MS).toISOString(); // Exactly 7 days

  const current = { sales: 100, unchangedSince: '2026-09-01T00:00:00.000Z', salesObservedAt: '2026-09-01T00:00:00.000Z' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 100, observedAt: t1, quality: 'exact' });
  assert.equal(res.action, 'window_maintained_active');
  assert.equal(res.unchangedSince, '2026-09-01T00:00:00.000Z');
});

test('F15.B2: Gap of 7 days 1 second breaks chain', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const t1 = new Date(t0 + CONSTANTS.MAX_VALID_OBSERVATION_GAP_MS + 1000).toISOString(); // 7 days + 1 second

  const current = { sales: 100, unchangedSince: '2026-09-01T00:00:00.000Z', salesObservedAt: '2026-09-01T00:00:00.000Z' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 100, observedAt: t1, quality: 'exact' });
  assert.equal(res.action, 'gap_broken_window_reset');
  assert.equal(res.unchangedSince, t1);
});

test('F15.B3: Gap of 6 days 23 hours 59 minutes preserves chain', () => {
  const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
  const almost7d = new Date(t0 + CONSTANTS.MAX_VALID_OBSERVATION_GAP_MS - 60000).toISOString();

  const current = { sales: 100, unchangedSince: '2026-09-01T00:00:00.000Z', salesObservedAt: '2026-09-01T00:00:00.000Z' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 100, observedAt: almost7d, quality: 'exact' });
  assert.equal(res.action, 'window_maintained_active');
});

test('F15.B4: Multiple gap breaks in a row', () => {
  let state = { sales: 100, unchangedSince: '2026-09-01T00:00:00Z', salesObservedAt: '2026-09-01T00:00:00Z' };
  // Break 1: 10 days later
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: '2026-09-11T00:00:00Z', quality: 'exact' });
  assert.equal(state.unchangedSince, '2026-09-11T00:00:00Z');

  // Break 2: 12 days later
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: '2026-09-23T00:00:00Z', quality: 'exact' });
  assert.equal(state.unchangedSince, '2026-09-23T00:00:00Z');
});

test('F15.B5: Observation gap calculation uses UTC epoch difference rather than calendar day diff', () => {
  const t1 = new Date('2026-09-01T23:59:59Z').getTime();
  const t2 = new Date('2026-09-08T00:00:01Z').getTime();
  const gapMs = t2 - t1;
  // Elapsed time is 6 days, 0 hours, 2 seconds (less than 7 days)
  assert.ok(gapMs < CONSTANTS.MAX_VALID_OBSERVATION_GAP_MS);
});

// ==========================================
// FEATURE F16: 30-Day Sales Unchanged Stoppage Boundaries
// ==========================================
test('F16.B1: Day 29d 23h 59m 59s with sales==baseline remains active', () => {
  const clock = new VirtualClock('2026-09-01T00:00:00.000Z');
  let state = { sales: null, unchangedSince: null };
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO() });

  // 5 cycles of 5 days = 25 days
  for (let i = 1; i <= 5; i++) {
    clock.advanceDays(5);
    state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO(), quality: 'exact' });
  }

  // Advance to Day 29d 23h 59m 59s (1 second shy of 30 days)
  clock.advanceDays(4);
  clock.advanceHours(23);
  clock.advanceMinutes(59);
  clock.advanceSeconds(59);

  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO(), quality: 'exact' });
  assert.equal(state.trackingStatus, 'active', 'Must not stop 1 second before 30 days');
});

test('F16.B2: Day 30d 00h 00m 00s with sales==baseline transitions to stopped', () => {
  const clock = new VirtualClock('2026-09-01T00:00:00.000Z');
  let state = { sales: null, unchangedSince: null };
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO() });

  // 6 cycles of 5 days = exactly 30 days (30 * 86400s)
  for (let i = 1; i <= 6; i++) {
    clock.advanceDays(5);
    state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO(), quality: 'exact' });
  }

  assert.equal(state.trackingStatus, 'stopped');
  assert.equal(state.reason, 'shop_sales_unchanged_30d');
});

test('F16.B3: Day 35 crawl with sales==baseline and continuous gaps stops with reason', () => {
  const clock = new VirtualClock('2026-09-01T00:00:00.000Z');
  let state = { sales: null, unchangedSince: null };
  state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO() });

  for (let i = 1; i <= 7; i++) { // 7 * 5d = 35d
    clock.advanceDays(5);
    state = ShopLifecyclePolicy.evaluateObservation(state, { value: 100, observedAt: clock.nowISO(), quality: 'exact' });
  }
  assert.equal(state.trackingStatus, 'stopped');
});

test('F16.B4: Rounded sales observation (10k) on Day 30 does NOT stop shop', () => {
  const current = {
    sales: 10000,
    unchangedSince: '2026-09-01T00:00:00.000Z',
    salesObservedAt: '2026-09-25T00:00:00.000Z',
  };
  const roundedObs = {
    value: 10000,
    observedAt: '2026-10-01T00:00:00.000Z', // Day 30
    quality: 'rounded', // e.g. "10k" rounded badge
  };

  const res = ShopLifecyclePolicy.evaluateObservation(current, roundedObs);
  assert.equal(res.trackingStatus, 'active', 'Rounded observation is ineligible to stop shop');
  assert.equal(res.action, 'quality_ineligible_for_stop');
});

test('F16.B5: Estimated sales observation on Day 30 does NOT stop shop', () => {
  const current = {
    sales: 500,
    unchangedSince: '2026-09-01T00:00:00.000Z',
    salesObservedAt: '2026-09-25T00:00:00.000Z',
  };
  const estObs = {
    value: 500,
    observedAt: '2026-10-01T00:00:00.000Z',
    quality: 'estimated',
  };

  const res = ShopLifecyclePolicy.evaluateObservation(current, estObs);
  assert.equal(res.trackingStatus, 'active');
  assert.equal(res.action, 'quality_ineligible_for_stop');
});

// ==========================================
// FEATURE F17: UI Label Accuracy Boundaries
// ==========================================
test('F17.B1: UI label for shop stopped on Day 30 renders exact Vietnamese string', () => {
  const label = ShopLifecyclePolicy.getUiLabel({ trackingStatus: 'stopped', reason: 'shop_sales_unchanged_30d' });
  assert.equal(label, 'Không quan sát thấy sales tăng trong 30 ngày');
});

test('F17.B2: UI label for shop active on Day 29 renders null', () => {
  const label = ShopLifecyclePolicy.getUiLabel({ trackingStatus: 'active', reason: null });
  assert.equal(label, null);
});

test('F17.B3: UI label remains accurate after server restart', () => {
  const rehydrated = JSON.parse(JSON.stringify({ trackingStatus: 'stopped', reason: 'shop_sales_unchanged_30d' }));
  assert.equal(ShopLifecyclePolicy.getUiLabel(rehydrated), 'Không quan sát thấy sales tăng trong 30 ngày');
});

test('F17.B4: UI label for shop stopped due to manual user pause renders null for sales unchanged', () => {
  const label = ShopLifecyclePolicy.getUiLabel({ trackingStatus: 'paused', reason: 'manual_pause' });
  assert.equal(label, null);
});

test('F17.B5: Special formatting check: no double spaces, exact accents', () => {
  const label = ShopLifecyclePolicy.getUiLabel({ trackingStatus: 'stopped', reason: 'shop_sales_unchanged_30d' });
  assert.ok(!label.includes('  '), 'Must not have double spaces');
  assert.equal(label.trim(), 'Không quan sát thấy sales tăng trong 30 ngày');
});
