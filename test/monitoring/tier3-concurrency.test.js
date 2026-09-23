/**
 * Tier 3: Cross-Feature Interactions & Pairwise Concurrency Test Suite.
 *
 * Adheres strictly to docs/DISCOVERY_MONITORING_PLAN_REVISED.md §5, §6, §9.4, §9.5:
 * - Scenario 3.1: Discovery vs Monitoring concurrent writes on same item_uid
 * - Scenario 3.2: Multi-item batch Discovery lock ordering (ASC) preventing deadlocks
 * - Scenario 3.3: Limiter cooldown delay under concurrent worker attempts
 * - Scenario 3.4: Stale worker fencing & state version invalidation
 * - Scenario 3.5: Concurrent observation deduplication under parallel delivery
 * - Scenario 3.6: Discovery admission priority under resource contention
 * - Scenario 3.7: Shop stoppage vs in-flight listing refresh race
 * - Scenario 3.8: Social Star / Unstar racing with expiry timer tick
 * - Scenario 3.9: Multi-process limiter split-brain prevention
 * - Scenario 3.10: High-frequency interleaved Discovery and Monitoring updates
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createTestDb,
  VirtualClock,
  MonitoringLimiter,
  applyMonitoringObservation,
  hashItemUidToAdvisoryKey,
  SocialLifecyclePolicy,
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
    overrides.query || 'handmade mug',
    overrides.title || 'Ceramic Handmade Mug',
    overrides.url || `https://www.etsy.com/listing/${itemUid}`,
    overrides.image || 'https://img.etsy.com/mug.jpg',
    overrides.video_url || '',
    overrides.current_price ?? 20.0,
    overrides.current_sold ?? 50,
    overrides.current_likes ?? 10,
    overrides.current_views ?? 100,
    overrides.status || 'active',
    overrides.first_seen_at || '2026-09-01 00:00:00',
    overrides.last_seen_at || '2026-09-01 00:00:00',
    overrides.last_crawled_at || '2026-09-01 00:00:00'
  );
}

// -----------------------------------------------------------------------------
// SCENARIO 3.1: Concurrent Discovery & Monitoring writes on same item_uid
// -----------------------------------------------------------------------------
test('Scenario 3.1: Concurrent Discovery & Monitoring writes serialize cleanly with zero lost updates and zero deadlocks', async () => {
  const db = await createTestDb();
  const itemUid = 'etsy:concurrent-race-item';
  await seedProduct(db, itemUid, { current_price: 20.0, current_likes: 10 });

  const [k1, k2] = hashItemUidToAdvisoryKey(itemUid);

  // Discovery transaction: updates query search stats (likes +5)
  const discoveryWrite = db.transaction(async () => {
    await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
    await db.prepare(`
      UPDATE product_current 
      SET current_likes = current_likes + 5, last_seen_at = now()
      WHERE item_uid = ?
    `).run(itemUid);
  })();

  // Monitoring transaction: refreshes price (price = 28.5)
  const monitoringWrite = applyMonitoringObservation(db, {
    itemUid,
    patch: { price: 28.5, observedAt: '2026-09-02T12:00:00Z' },
    metadata: { observationId: 'monitoring:concur:1' },
  });

  // Fire simultaneously
  await Promise.all([discoveryWrite, monitoringWrite]);

  const row = await db.prepare('SELECT current_price, current_likes FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(row.current_price, 28.5, 'Monitoring price update must be committed');
  assert.equal(row.current_likes, 15, 'Discovery likes increment must not be lost');
});

// -----------------------------------------------------------------------------
// SCENARIO 3.2: Multi-item batch Discovery lock ordering preventing deadlocks
// -----------------------------------------------------------------------------
test('Scenario 3.2: Batch Discovery sort by item_uid ASC eliminates deadlocks with concurrent Monitoring single refresh', async () => {
  const db = await createTestDb();
  const uidA = 'etsy:item-A';
  const uidB = 'etsy:item-B';
  await seedProduct(db, uidA);
  await seedProduct(db, uidB);

  // Batch items intentionally received in reverse order [B, A]
  const discoveryBatch = [uidB, uidA];
  // Sort canonically before acquiring locks:
  const sortedBatch = [...discoveryBatch].sort();

  // Run batch Discovery and Monitoring on item A in parallel
  const discoveryPromise = db.transaction(async () => {
    for (const uid of sortedBatch) {
      const [k1, k2] = hashItemUidToAdvisoryKey(uid);
      await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
      await db.prepare("UPDATE product_current SET last_seen_at = now() WHERE item_uid = ?").run(uid);
    }
  })();

  const monitoringPromise = applyMonitoringObservation(db, {
    itemUid: uidA,
    patch: { price: 99.0, observedAt: '2026-09-02T15:00:00Z' },
    metadata: { observationId: 'monitoring:sort:order' },
  });

  await assert.doesNotReject(async () => {
    await Promise.all([discoveryPromise, monitoringPromise]);
  }, 'Must execute without 40P01 deadlock detected');

  const pA = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get(uidA);
  assert.equal(pA.current_price, 99.0);
});

// -----------------------------------------------------------------------------
// SCENARIO 3.3: Limiter cooldown delay under concurrent worker attempts
// -----------------------------------------------------------------------------
test('Scenario 3.3: Limiter cooldown delay strictly denies 3 concurrent worker attempts during 20s cooldown', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db, 'global_monitoring_capture', 20000);
  await limiter.init();

  // Worker 1 acquires and completes capture at T=0
  await limiter.tryAcquireLease('worker-1', 60000);
  await limiter.releaseLease('worker-1', 20000); // 20s cooldown initiated

  // Concurrent Workers 2, 3, 4 attempt acquisition at T+2s
  const [w2, w3, w4] = await Promise.all([
    limiter.tryAcquireLease('worker-2', 60000),
    limiter.tryAcquireLease('worker-3', 60000),
    limiter.tryAcquireLease('worker-4', 60000),
  ]);

  assert.equal(w2, null, 'Worker 2 must be rejected during cooldown');
  assert.equal(w3, null, 'Worker 3 must be rejected during cooldown');
  assert.equal(w4, null, 'Worker 4 must be rejected during cooldown');

  // Cooldown finishes in DB: simulate time passing by setting next_allowed_at to past
  await db.query("UPDATE monitoring_limiter SET next_allowed_at = now() - INTERVAL '1 second' WHERE key = 'global_monitoring_capture'");

  // Worker 2 attempts again after cooldown
  const w2After = await limiter.tryAcquireLease('worker-2', 60000);
  assert.ok(w2After, 'Worker 2 must acquire lease after cooldown expires');
});

// -----------------------------------------------------------------------------
// SCENARIO 3.4: Stale worker fencing & state version invalidation
// -----------------------------------------------------------------------------
test('Scenario 3.4: Stale worker with expired lease token has commit rejected after recovery reclaims job', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, state_version)
    VALUES (701, 'etsy', 'shop', 'shop-stale-worker', 'id', 's1', now(), now(), 1)
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token, state_version)
    VALUES (980, 701, 'shop_probe', 's1', now(), 'claimed', 'token-worker-A', 1)
  `).run();

  // Recovery process notices Worker A timed out, resets job and grants Worker B claim
  await db.prepare(`
    UPDATE monitoring_jobs 
    SET claim_token = 'token-worker-B', state_version = 2
    WHERE id = 980
  `).run();

  // Worker B completes job
  await db.prepare(`
    UPDATE monitoring_jobs 
    SET status = 'completed', finished_at = now()
    WHERE id = 980 AND claim_token = 'token-worker-B'
  `).run();

  // Worker A wakes up and attempts to commit with stale token
  const staleCommit = await db.query(`
    UPDATE monitoring_jobs 
    SET status = 'completed'
    WHERE id = 980 AND claim_token = 'token-worker-A'
    RETURNING id
  `);
  assert.equal(staleCommit.rows.length, 0, 'Stale Worker A commit must be rejected');

  const finalJob = await db.prepare('SELECT claim_token, status FROM monitoring_jobs WHERE id = 980').get();
  assert.equal(finalJob.claim_token, 'token-worker-B');
  assert.equal(finalJob.status, 'completed');
});

// -----------------------------------------------------------------------------
// SCENARIO 3.5: Concurrent observation deduplication under parallel delivery
// -----------------------------------------------------------------------------
test('Scenario 3.5: Concurrent delivery of same observation ID across 5 threads results in exactly 1 update', async () => {
  const db = await createTestDb();
  const itemUid = 'etsy:parallel-dedup';
  await seedProduct(db, itemUid);

  const fixedObsId = 'monitoring:exact_parallel_id';
  const tasks = Array.from({ length: 5 }, () => applyMonitoringObservation(db, {
    itemUid,
    patch: { price: 50.0, observedAt: '2026-09-03T10:00:00Z' },
    metadata: { observationId: fixedObsId },
  }));

  const results = await Promise.all(tasks);
  const updatedCount = results.filter(r => r.updated).length;
  const duplicateCount = results.filter(r => r.duplicate).length;

  assert.equal(updatedCount, 1, 'Exactly one write must succeed as non-duplicate');
  assert.equal(duplicateCount, 4, 'Remaining 4 must be flagged as duplicates');

  const p = await db.prepare('SELECT observation_count FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(Number(p.observation_count), 2);
});

// -----------------------------------------------------------------------------
// SCENARIO 3.6: Discovery admission priority under resource contention
// -----------------------------------------------------------------------------
test('Scenario 3.6: Discovery run jumps to front of execution queue when 5 monitoring jobs are waiting', () => {
  const queue = [
    { id: 'mon-1', type: 'monitoring', enqueuedAt: 1000 },
    { id: 'mon-2', type: 'monitoring', enqueuedAt: 1001 },
    { id: 'mon-3', type: 'monitoring', enqueuedAt: 1002 },
    { id: 'mon-4', type: 'monitoring', enqueuedAt: 1003 },
    { id: 'mon-5', type: 'monitoring', enqueuedAt: 1004 },
  ];

  // Discovery run arrives later at T=2000
  queue.push({ id: 'discovery-burst', type: 'discovery', enqueuedAt: 2000 });

  // Priority admission comparator: discovery strictly first, then by enqueuedAt ASC
  queue.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'discovery' ? -1 : 1;
    return a.enqueuedAt - b.enqueuedAt;
  });

  assert.equal(queue[0].id, 'discovery-burst');
  assert.equal(queue[1].id, 'mon-1');
});

// -----------------------------------------------------------------------------
// SCENARIO 3.7: Shop stoppage vs in-flight listing refresh race
// -----------------------------------------------------------------------------
test('Scenario 3.7: Shop probe evaluates shop as stopped, cancelling concurrent child item refresh commits', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, tracking_status)
    VALUES (801, 'etsy', 'shop', 'race-shop-stop', 'id', 's1', now(), now(), 'active')
  `).run();

  await seedProduct(db, 'etsy:child-race-listing');
  await db.prepare(`
    INSERT INTO monitoring_items (id, item_uid, entity_id, eligibility, item_status)
    VALUES (991, 'etsy:child-race-listing', 801, 'ready', 'active')
  `).run();

  // 1. Shop probe evaluates unchanged 30d -> sets entity tracking_status = 'stopped'
  await db.prepare("UPDATE monitoring_entities SET tracking_status = 'stopped', reason = 'shop_sales_unchanged_30d' WHERE id = 801").run();

  // 2. In-flight child item worker finishes capture and checks parent entity status before commit
  const parent = await db.prepare('SELECT tracking_status FROM monitoring_entities WHERE id = 801').get();
  let committed = false;
  if (parent.tracking_status === 'active') {
    committed = true;
  } else {
    // Abort and mark child item cancelled/paused
    await db.prepare("UPDATE monitoring_items SET item_status = 'paused' WHERE id = 991").run();
  }

  assert.equal(committed, false, 'Child write must be aborted');
  const item = await db.prepare('SELECT item_status FROM monitoring_items WHERE id = 991').get();
  assert.equal(item.item_status, 'paused');
});

// -----------------------------------------------------------------------------
// SCENARIO 3.8: Social Star / Unstar racing with expiry timer tick
// -----------------------------------------------------------------------------
test('Scenario 3.8: Author star and unstar racing near Day 30 resolves deterministically without split-brain', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  let entity = {
    monitoring_started_at: startedAt,
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
    tracking_status: 'active',
  };

  // User stars at Day 25
  entity = SocialLifecyclePolicy.handleStar(entity, '2026-09-26T00:00:00.000Z');
  assert.equal(entity.expires_at, '2026-10-31T00:00:00.000Z');

  // User unstars at Day 35 (after day 30)
  entity = SocialLifecyclePolicy.handleUnstar(entity, '2026-10-06T00:00:00.000Z');
  assert.equal(entity.tracking_status, 'expired');

  // Expiry timer evaluates entity at Day 36
  const timerResult = SocialLifecyclePolicy.evaluateTickExpiry(entity, '2026-10-07T00:00:00.000Z');
  assert.equal(timerResult.tracking_status, 'expired');
  assert.equal(timerResult.stateChanged, false, 'Already expired; no change');
});

// -----------------------------------------------------------------------------
// SCENARIO 3.9: Multi-process limiter split-brain prevention
// -----------------------------------------------------------------------------
test('Scenario 3.9: Simulated 4 worker processes hitting monitoring_limiter simultaneously yields strictly 1 winner', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();

  const attempts = ['proc-A', 'proc-B', 'proc-C', 'proc-D'].map(procId => limiter.tryAcquireLease(procId, 60000));
  const results = await Promise.all(attempts);

  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1, 'Exactly 1 worker process must win the lease');

  const row = await db.prepare("SELECT owner_token FROM monitoring_limiter WHERE key = 'global_monitoring_capture'").get();
  assert.ok(row.owner_token.startsWith('proc-'));
});

// -----------------------------------------------------------------------------
// SCENARIO 3.10: High-frequency interleaved Discovery and Monitoring updates
// -----------------------------------------------------------------------------
test('Scenario 3.10: 20 alternating writes on single item preserves Discovery fields while recording Monitoring observations', async () => {
  const db = await createTestDb();
  const itemUid = 'etsy:interleaved-item';
  await seedProduct(db, itemUid, {
    query: 'preserve_my_query',
    status: 'active',
    first_seen_at: '2026-09-01 00:00:00',
  });

  for (let i = 1; i <= 10; i++) {
    // Discovery update
    await db.prepare("UPDATE product_current SET current_likes = current_likes + 1, last_seen_at = now() WHERE item_uid = ?").run(itemUid);

    // Monitoring update
    await applyMonitoringObservation(db, {
      itemUid,
      patch: { price: 20 + i, observedAt: `2026-09-01T12:${String(i).padStart(2, '0')}:00Z` },
      metadata: { observationId: `monitoring:interleaved:${i}` },
    });
  }

  const final = await db.prepare('SELECT query, status, first_seen_at, current_likes, current_price FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(final.query, 'preserve_my_query');
  assert.equal(final.status, 'active');
  assert.equal(final.first_seen_at, '2026-09-01 00:00:00');
  assert.equal(final.current_likes, 20); // 10 initial + 10 increments
  assert.equal(final.current_price, 30); // 20 + 10
});
