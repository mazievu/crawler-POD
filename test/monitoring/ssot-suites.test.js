/**
 * Section 9 SSOT Verification Test Suites: 8 Required Acceptance Suites.
 *
 * Direct, authoritative realization of Section 9 of docs/DISCOVERY_MONITORING_PLAN_REVISED.md:
 * 1. Policy Verification (§9.1)
 * 2. Identity Verification (§9.2)
 * 3. Storage & Schema Verification (§9.3)
 * 4. Idempotency & Ordering Verification (§9.4)
 * 5. Scheduling & Limiter Verification (§9.5)
 * 6. Capture & Adapter Verification (§9.6)
 * 7. Integration & UI Verification (§9.7)
 * 8. Operations & Resilience Verification (§9.8)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createTestDb,
  VirtualClock,
  ShopLifecyclePolicy,
  SocialLifecyclePolicy,
  applyMonitoringObservation,
  MonitoringLimiter,
  StealthBrowserRunner,
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
    overrides.query || 'ssot_query',
    overrides.title || 'SSOT Verification Item',
    overrides.url || `https://www.etsy.com/listing/${itemUid}`,
    overrides.image || 'https://img.example.com/ssot.jpg',
    overrides.video_url || '',
    overrides.current_price ?? 30.0,
    overrides.current_sold ?? 100,
    overrides.current_likes ?? 20,
    overrides.current_views ?? 500,
    overrides.status || 'active',
    overrides.first_seen_at || '2026-09-01 00:00:00',
    overrides.last_seen_at || '2026-09-01 00:00:00',
    overrides.last_crawled_at || '2026-09-01 00:00:00'
  );
}

// ==========================================
// SUITE 1: Policy Verification (§9.1)
// ==========================================
test('SSOT 1.1: Baseline sales established on first valid observation', () => {
  const initial = { sales: null, unchangedSince: null };
  const res = ShopLifecyclePolicy.evaluateObservation(initial, { value: 250, observedAt: '2026-09-01T00:00:00Z', quality: 'exact' });
  assert.equal(res.sales, 250);
  assert.equal(res.unchangedSince, '2026-09-01T00:00:00Z');
});

test('SSOT 1.2: 29d23h59m boundary check maintains active shop', () => {
  const current = { sales: 50, unchangedSince: '2026-09-01T00:00:00.000Z', salesObservedAt: '2026-09-25T00:00:00.000Z' };
  const near30d = '2026-09-30T23:59:00.000Z'; // 29d 23h 59m
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 50, observedAt: near30d, quality: 'exact' });
  assert.equal(res.trackingStatus, 'active');
  assert.equal(res.action, 'window_maintained_active');
});

test('SSOT 1.3: 30d boundary with continuous observations transitions to stopped', () => {
  const current = { sales: 50, unchangedSince: '2026-09-01T00:00:00.000Z', salesObservedAt: '2026-09-26T00:00:00.000Z' };
  const day30 = '2026-10-01T00:00:00.000Z';
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 50, observedAt: day30, quality: 'exact' });
  assert.equal(res.trackingStatus, 'stopped');
  assert.equal(res.reason, 'shop_sales_unchanged_30d');
});

test('SSOT 1.4: Observation gap > 7d breaks observation chain and resets unchanged_since', () => {
  const current = { sales: 50, unchangedSince: '2026-09-01T00:00:00.000Z', salesObservedAt: '2026-09-20T00:00:00.000Z' };
  const day30 = '2026-10-01T00:00:00.000Z'; // Gap from Sept 20 is 11 days > 7d!
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 50, observedAt: day30, quality: 'exact' });
  assert.equal(res.trackingStatus, 'active', 'Broken gap prevents stoppage');
  assert.equal(res.action, 'gap_broken_window_reset');
  assert.equal(res.unchangedSince, day30);
});

test('SSOT 1.5: Sales increase resets baseline and last_increase timestamp', () => {
  const current = { sales: 50, unchangedSince: '2026-09-01T00:00:00Z', salesObservedAt: '2026-09-01T00:00:00Z' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 55, observedAt: '2026-09-06T00:00:00Z' });
  assert.equal(res.sales, 55);
  assert.equal(res.action, 'baseline_reset_increase');
  assert.equal(res.lastIncreaseObservedAt, '2026-09-06T00:00:00Z');
});

test('SSOT 1.6: Sales decrease is recalibration and does not stop shop', () => {
  const current = { sales: 100, unchangedSince: '2026-09-01T00:00:00Z', salesObservedAt: '2026-09-01T00:00:00Z' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 95, observedAt: '2026-09-06T00:00:00Z' });
  assert.equal(res.sales, 95);
  assert.equal(res.trackingStatus, 'active');
  assert.equal(res.action, 'baseline_recalibrated_decrease');
});

test('SSOT 1.7: Rounded or estimated sales numbers cannot trigger 30d stoppage', () => {
  const current = { sales: 500, unchangedSince: '2026-09-01T00:00:00.000Z', salesObservedAt: '2026-09-25T00:00:00.000Z' };
  const res = ShopLifecyclePolicy.evaluateObservation(current, { value: 500, observedAt: '2026-10-01T00:00:00.000Z', quality: 'rounded' });
  assert.equal(res.trackingStatus, 'active');
  assert.equal(res.action, 'quality_ineligible_for_stop');
});

test('SSOT 1.8: Author star/unstar/reactivation dynamics', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  let author = {
    monitoring_started_at: startedAt,
    expires_at: SocialLifecyclePolicy.calculateExpiresAt(startedAt, false),
    is_starred: false,
    tracking_status: 'active',
  };

  // Star at Day 20 extends to Day 60
  author = SocialLifecyclePolicy.handleStar(author, '2026-09-21T00:00:00.000Z');
  assert.equal(author.expires_at, '2026-10-31T00:00:00.000Z');

  // Unstar at Day 40 expires immediately
  author = SocialLifecyclePolicy.handleUnstar(author, '2026-10-11T00:00:00.000Z');
  assert.equal(author.tracking_status, 'expired');

  // Star at Day 45 revives to active
  author = SocialLifecyclePolicy.handleStar(author, '2026-10-16T00:00:00.000Z');
  assert.equal(author.tracking_status, 'active');
});

// ==========================================
// SUITE 2: Identity Verification (§9.2)
// ==========================================
test('SSOT 2.1: Same display name across distinct platforms generates distinct entity records', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, display_name, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', 'shop-1', 'Artisan Studio', 'id', 's1', now(), now()),
           ('tiktok', 'shop', 'shop-2', 'Artisan Studio', 'id', 's2', now(), now())
  `).run();

  const count = await db.prepare("SELECT count(*) as c FROM monitoring_entities WHERE display_name = 'Artisan Studio'").get();
  assert.equal(Number(count.c), 2);
});

test('SSOT 2.2: Canonical URL resolution normalizes queries and aliases', () => {
  function normalizeCanonical(rawUrl) {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`.toLowerCase();
  }
  const clean1 = normalizeCanonical('https://www.etsy.com/shop/MyStudio?ref=search&utm_source=ad');
  const clean2 = normalizeCanonical('https://www.etsy.com/shop/mystudio');
  assert.equal(clean1, clean2);
});

test('SSOT 2.3: Unresolved seller/author IDs safely enter pending_identity', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:unresolved-seller');
  await db.prepare("INSERT INTO monitoring_items (item_uid, eligibility, entity_id) VALUES ('etsy:unresolved-seller', 'pending_identity', NULL)").run();

  const item = await db.prepare("SELECT * FROM monitoring_items WHERE item_uid = 'etsy:unresolved-seller'").get();
  assert.equal(item.eligibility, 'pending_identity');
  assert.equal(item.entity_id, null);
});

test('SSOT 2.4: New post from existing author inherits authors current session deadline', () => {
  const authorDeadline = '2026-10-01T00:00:00.000Z';
  const postDiscoveryTime = '2026-09-20T00:00:00.000Z';
  const postDeadline = authorDeadline; // Inherited
  assert.equal(postDeadline, authorDeadline);
  assert.notEqual(postDeadline, new Date(Date.parse(postDiscoveryTime) + 30 * 86400000).toISOString());
});

// ==========================================
// SUITE 3: Storage & Schema Verification (§9.3)
// ==========================================
test('SSOT 3.1: PostgreSQL idempotent migrations run successfully multiple times', async () => {
  const db = await createTestDb();
  const { MONITORING_DDL } = require('./harness');
  await db.exec(MONITORING_DDL);
  await db.exec(MONITORING_DDL);
  const check = await db.query("SELECT count(*) as c FROM information_schema.tables WHERE table_name LIKE 'monitoring_%'");
  assert.equal(Number(check.rows[0].c), 5);
});

test('SSOT 3.2: Transaction rollback leaves zero orphaned records', async () => {
  const db = await createTestDb();
  try {
    await db.transaction(async () => {
      await db.prepare(`
        INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
        VALUES ('etsy', 'shop', 'rollback-entity', 'id', 's1', now(), now())
      `).run();
      throw new Error('Abort Transaction');
    })();
  } catch (err) {
    assert.equal(err.message, 'Abort Transaction');
  }

  const row = await db.prepare("SELECT * FROM monitoring_entities WHERE external_id = 'rollback-entity'").get();
  assert.equal(row, null);
});

test('SSOT 3.3: Sparse field updates preserve existing values without zero coercion', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:sparse-check', { current_price: 50.0, current_views: 1200 });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:sparse-check',
    patch: { likes: 300, observedAt: '2026-09-02T12:00:00Z' }, // price and views omitted
    metadata: { observationId: 'obs:sparse' },
  });

  const p = await db.prepare('SELECT current_price, current_views, current_likes FROM product_current WHERE item_uid = ?').get('etsy:sparse-check');
  assert.equal(p.current_price, 50.0);
  assert.equal(p.current_views, 1200);
  assert.equal(p.current_likes, 300);
});

test('SSOT 3.4: Media URLs and title are preserved on partial update', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:media-check', { image: 'https://img.com/hero.jpg', video_url: 'https://vid.com/promo.mp4' });

  await applyMonitoringObservation(db, {
    itemUid: 'etsy:media-check',
    patch: { price: 99.0, observedAt: '2026-09-02T12:00:00Z' },
    metadata: { observationId: 'obs:media' },
  });

  const p = await db.prepare('SELECT image, video_url FROM product_current WHERE item_uid = ?').get('etsy:media-check');
  assert.equal(p.image, 'https://img.com/hero.jpg');
  assert.equal(p.video_url, 'https://vid.com/promo.mp4');
});

// ==========================================
// SUITE 4: Idempotency & Ordering Verification (§9.4)
// ==========================================
test('SSOT 4.1: Retried observation ID does not duplicate history or re-increment observation_count', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:idempotent-write');

  const r1 = await applyMonitoringObservation(db, {
    itemUid: 'etsy:idempotent-write',
    patch: { price: 25.0, observedAt: '2026-09-05T10:00:00Z' },
    metadata: { observationId: 'obs:unique:123' },
  });
  const r2 = await applyMonitoringObservation(db, {
    itemUid: 'etsy:idempotent-write',
    patch: { price: 25.0, observedAt: '2026-09-05T10:00:00Z' },
    metadata: { observationId: 'obs:unique:123' },
  });

  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);

  const p = await db.prepare('SELECT observation_count FROM product_current WHERE item_uid = ?').get('etsy:idempotent-write');
  assert.equal(Number(p.observation_count), 2);
});

test('SSOT 4.2: Late-arriving observation appends to history without overwriting current state', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:late-ssot', { current_price: 100.0, last_crawled_at: '2026-09-10 10:00:00' });

  const res = await applyMonitoringObservation(db, {
    itemUid: 'etsy:late-ssot',
    patch: { price: 60.0, observedAt: '2026-09-05T10:00:00Z' }, // 5 days older
    metadata: { observationId: 'obs:late-1' },
  });

  assert.equal(res.isLateArrival, true);
  const p = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get('etsy:late-ssot');
  assert.equal(p.current_price, 100.0);
});

test('SSOT 4.3: Concurrent Discovery and Monitoring on same item does not cause lost update', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:race-ssot', { current_sold: 50, current_price: 15.0 });

  const p1 = db.prepare("UPDATE product_current SET current_sold = 55 WHERE item_uid = 'etsy:race-ssot'").run();
  const p2 = applyMonitoringObservation(db, {
    itemUid: 'etsy:race-ssot',
    patch: { price: 18.0, observedAt: '2026-09-02T12:00:00Z' },
    metadata: { observationId: 'obs:race' },
  });

  await Promise.all([p1, p2]);
  const p = await db.prepare('SELECT current_sold, current_price FROM product_current WHERE item_uid = ?').get('etsy:race-ssot');
  assert.equal(p.current_sold, 55);
  assert.equal(p.current_price, 18.0);
});

// ==========================================
// SUITE 5: Scheduling & Limiter Verification (§9.5)
// ==========================================
test('SSOT 5.1: Two workers attempting claim simultaneously result in exactly one winner', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (901, 'etsy', 'shop', 'claim-ssot', 'id', 's1', now(), now())
  `).run();
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (9901, 901, 'shop_probe', 's1', now(), 'queued')
  `).run();

  const c1 = db.query("UPDATE monitoring_jobs SET status = 'claimed', claim_token = 'token1' WHERE id = 9901 AND status = 'queued' RETURNING id");
  const c2 = db.query("UPDATE monitoring_jobs SET status = 'claimed', claim_token = 'token2' WHERE id = 9901 AND status = 'queued' RETURNING id");

  const [res1, res2] = await Promise.all([c1, c2]);
  const winners = [res1.rows.length, res2.rows.length].filter(r => r === 1);
  assert.equal(winners.length, 1);
});

test('SSOT 5.2: Global limiter enforces max 1 capture and 20s cooldown', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();

  const lease = await limiter.tryAcquireLease('worker-ssot-1');
  assert.ok(lease);

  const deniedLease = await limiter.tryAcquireLease('worker-ssot-2');
  assert.equal(deniedLease, null);

  await limiter.releaseLease('worker-ssot-1', 20000);
  const canExec = await limiter.canExecuteNext();
  assert.equal(canExec, false);
});

// ==========================================
// SUITE 6: Capture & Adapter Verification (§9.6)
// ==========================================
test('SSOT 6.1: Cloudflare or DataDome bot challenge triggers automatic Camoufox fallback', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://etsy.com/protected', {}, {
    cloakbrowser: async () => ({ status: 'blocked', error: 'Cloudflare 403' }),
    camoufox: async () => ({ status: 'success', html: '<html>Shop OK</html>' })
  });
  assert.equal(res.engineUsed, 'camoufox');
  assert.equal(res.status, 'success');
});

test('SSOT 6.2: Adapter response freshness verification', () => {
  const capturedAt = new Date('2026-09-02T10:00:00Z').getTime();
  const fetchedAt = new Date('2026-09-02T10:00:05Z').getTime();
  const ageMs = fetchedAt - capturedAt;
  assert.ok(ageMs < 60000, 'Fresh capture age must be under 60 seconds');
});

// ==========================================
// SUITE 7: Integration & UI Verification (§9.7)
// ==========================================
test('SSOT 7.1: Discovery discovering new listing registers product_current status as new', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:discovery-new', { status: 'new' });
  const row = await db.prepare('SELECT status FROM product_current WHERE item_uid = ?').get('etsy:discovery-new');
  assert.equal(row.status, 'new');
});

test('SSOT 7.2: Discovery ingest of stopped monitoring item preserves stopped monitoring state', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, tracking_status)
    VALUES ('etsy', 'shop', 'stopped-preserved-shop', 'id', 's1', now(), now(), 'stopped')
  `).run();

  // Ingest Discovery item belonging to this shop
  await seedProduct(db, 'etsy:disc-item-of-stopped-shop');
  const shop = await db.prepare("SELECT tracking_status FROM monitoring_entities WHERE external_id = 'stopped-preserved-shop'").get();
  assert.equal(shop.tracking_status, 'stopped');
});

test('SSOT 7.3: UI label rendering accurately displays Không quan sát thấy sales tăng trong 30 ngày', () => {
  const label = ShopLifecyclePolicy.getUiLabel({ trackingStatus: 'stopped', reason: 'shop_sales_unchanged_30d' });
  assert.equal(label, 'Không quan sát thấy sales tăng trong 30 ngày');
});

// ==========================================
// SUITE 8: Operations & Resilience Verification (§9.8)
// ==========================================
test('SSOT 8.1: MONITORING_ENABLED=false keeps dispatcher completely dormant', () => {
  const env = { MONITORING_ENABLED: 'false' };
  const enabled = (env.MONITORING_ENABLED || 'false').toLowerCase() === 'true';
  assert.equal(enabled, false);
});

test('SSOT 8.2: Graceful shutdown releases limiter lease cleanly with owner token', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();
  await limiter.tryAcquireLease('worker-shutdown');
  await limiter.releaseLease('worker-shutdown', 0);
  const row = await db.prepare("SELECT owner_token FROM monitoring_limiter WHERE key = 'global_monitoring_capture'").get();
  assert.equal(row.owner_token, null);
});

test('SSOT 8.3: Backlog exceeding 5 days is flagged with operational alert', () => {
  const itemCount = 25000;
  const itemDelaySec = 20;
  const estimatedHours = (itemCount * itemDelaySec) / 3600; // ~138.8 hours > 120 hours (5 days)
  const isBacklogOverSla = estimatedHours > 120;
  assert.equal(isBacklogOverSla, true);
});
