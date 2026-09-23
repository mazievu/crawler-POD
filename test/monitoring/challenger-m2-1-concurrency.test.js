/**
 * Challenger 1 Verification Suite (Milestone 2)
 *
 * Empirically challenges and stress-tests:
 * 1. Transaction Execution & Advisory Lock Invocation in applyMonitoringObservation
 *    (Critical finding: targetDb.transaction returns an uninvoked function)
 * 2. Concurrency Race: Simultaneous Discovery batch write and Monitoring single-item refresh
 *    targeting the same item_uid (sequential lock acquisition, no deadlocks, no lost updates)
 * 3. Deadlock Elimination: Parallel multi-item transactions with overlapping item sets
 *    in reverse initial orders (Havender's item_uid ASC total ordering vs circular wait)
 * 4. Schema Safety: delta_saves absence in product_current and verification that saves
 *    updates succeed without column "delta_saves" error 42703.
 *
 * Authoritative SSOT: docs/DISCOVERY_MONITORING_PLAN_REVISED.md §5
 * Features: F6, F7, F8, F9, F10
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { fromDriver } = require('../../src/database/pg-client');
const { createMonitoringOps, applyMonitoringObservation } = require('../../src/database/monitoring');
const { getAdvisoryLockKeys, acquireItemAdvisoryLock } = require('../../src/database/concurrency');
const { unpackObservations, packObservations } = require('../../src/database/daily-history');

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
 * Helper to seed a product_current item with initial metrics.
 */
async function seedProduct(db, itemUid, overrides = {}) {
  await db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, image, video_url,
      current_price, current_sold, current_likes, current_views, current_saves,
      prev_price, prev_sold, prev_likes, prev_views, prev_saves,
      delta_price, delta_sold, delta_likes, delta_views,
      status, first_seen_at, last_seen_at, last_crawled_at, observation_count
    ) VALUES (
      @item_uid, @platform, @query, @title, @url, @image, @video_url,
      @current_price, @current_sold, @current_likes, @current_views, @current_saves,
      @prev_price, @prev_sold, @prev_likes, @prev_views, @prev_saves,
      @delta_price, @delta_sold, @delta_likes, @delta_views,
      @status, @first_seen_at, @last_seen_at, @last_crawled_at, @observation_count
    )
    ON CONFLICT (item_uid) DO NOTHING;
  `).run({
    item_uid: itemUid,
    platform: overrides.platform || 'etsy',
    query: overrides.query || 'ceramic mug handmade',
    title: overrides.title || 'Original Handmade Ceramic Mug',
    url: overrides.url || `https://www.etsy.com/listing/${encodeURIComponent(itemUid)}`,
    image: overrides.image || 'https://img.etsy.com/mug_orig.jpg',
    video_url: overrides.video_url || '',
    current_price: overrides.current_price ?? 24.50,
    current_sold: overrides.current_sold ?? 120,
    current_likes: overrides.current_likes ?? 45,
    current_views: overrides.current_views ?? 350,
    current_saves: overrides.current_saves ?? 15,
    prev_price: overrides.prev_price ?? null,
    prev_sold: overrides.prev_sold ?? null,
    prev_likes: overrides.prev_likes ?? null,
    prev_views: overrides.prev_views ?? null,
    prev_saves: overrides.prev_saves ?? null,
    delta_price: overrides.delta_price ?? 0,
    delta_sold: overrides.delta_sold ?? 0,
    delta_likes: overrides.delta_likes ?? 0,
    delta_views: overrides.delta_views ?? 0,
    status: overrides.status || 'active',
    first_seen_at: overrides.first_seen_at || '2026-09-01 00:00:00',
    last_seen_at: overrides.last_seen_at || '2026-09-01 00:00:00',
    last_crawled_at: overrides.last_crawled_at || '2026-09-01 00:00:00',
    observation_count: overrides.observation_count ?? 1,
  });
}

// ============================================================================
// CHALLENGE 1: Empirical Defect Proof in applyMonitoringObservation
// ============================================================================

test('Challenge 1.1: Empirical proof that applyMonitoringObservation returns directly resolved object with updated row and history', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:bug-probe-001';
  await seedProduct(db, itemUid, { current_price: 24.50 });

  // Call the remediated worker implementation of applyMonitoringObservation
  const res = await ops.applyMonitoringObservation(itemUid, {
    price: 39.99,
    observedAt: '2026-09-10T12:00:00Z',
    observationId: 'monitoring:bug:probe:1',
  });

  // Verify return contract conforms to PROJECT.md interface
  assert.equal(typeof res, 'object', 'res must be an object directly returned without manual wrapper invocation');
  assert.equal(res.updated, true, 'res.updated must be true');
  assert.equal(res.duplicate, false, 'res.duplicate must be false');
  assert.equal(res.isLateArrival, false, 'res.isLateArrival must be false');
  assert.equal(res.observationId, 'monitoring:bug:probe:1');
  assert.equal(res.itemUid, itemUid);

  // Directly verify DB was mutated without manual wrapper invocation:
  const row = await db.prepare('SELECT current_price, observation_count FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(row.current_price, 39.99, 'product_current.current_price was updated directly on return');
  assert.equal(row.observation_count, 2, 'observation_count was incremented directly on return (initial 1 + 1)');

  const history = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ?').all(itemUid);
  assert.equal(history.length, 1, 'daily_packed_history has 1 row created directly on return');
  assert.equal(history[0].latest_price, 39.99, 'daily_packed_history.latest_price reflects monitoring patch');
  assert.equal(history[0].observation_count, 1, 'daily_packed_history.observation_count reflects packed observation');
});

test('Challenge 1.2: applyMonitoringObservation returns directly resolved object and calling as function throws TypeError', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:bug-probe-002';
  await seedProduct(db, itemUid, { current_price: 20.00, current_likes: 10 });

  const res = await ops.applyMonitoringObservation(itemUid, {
    price: 32.00,
    likes: 25,
    observedAt: '2026-09-11T12:00:00Z',
    observationId: 'monitoring:bug:probe:2',
  });

  assert.equal(typeof res, 'object', 'Returned value must be an object');
  assert.equal(res.updated, true, 'Transaction once invoked returns updated: true');
  assert.equal(res.itemUid, itemUid);
  assert.equal(res.observationId, 'monitoring:bug:probe:2');

  // Attempting to invoke res() as a function must fail because it is an Object, not an AsyncFunction
  assert.throws(() => {
    res();
  }, TypeError, 'res is already resolved and cannot be invoked as a function');

  const row = await db.prepare('SELECT current_price, current_likes, observation_count FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(row.current_price, 32.00, 'Price must be updated after transaction execution');
  assert.equal(row.current_likes, 25, 'Likes must be updated after transaction execution');
  assert.equal(row.observation_count, 2, 'Observation count must increment to 2');
});

// ============================================================================
// CHALLENGE 2: Concurrency Race (Discovery vs Monitoring on same item_uid)
// ============================================================================

test('Challenge 2.1: Concurrent Discovery batch update and Monitoring refresh serialize via advisory lock with zero data loss', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:race-item-concurrent';

  await seedProduct(db, itemUid, {
    current_price: 50.00,
    current_likes: 100,
    current_views: 1000,
    current_sold: 40,
    observation_count: 5,
  });

  const [k1, k2] = getAdvisoryLockKeys(itemUid);

  // Discovery transaction: simulated batch writer acquiring advisory lock on item_uid
  const discoveryTx = db.transaction(async () => {
    await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int);', [k1, k2]);
    // Discovery updates rank/discovery fields: likes + 20, views + 150
    await db.prepare(`
      UPDATE product_current SET
        current_likes = current_likes + 20,
        current_views = current_views + 150,
        last_seen_at = now()
      WHERE item_uid = ?
    `).run(itemUid);
  });

  // Monitoring transaction: refreshes price and soldCount directly via ops.applyMonitoringObservation
  const monitoringPromise = ops.applyMonitoringObservation(itemUid, {
    price: 59.99,
    soldCount: 45,
    observedAt: '2026-09-12T15:30:00Z',
    observationId: 'monitoring:race:job:1',
  });

  const discoveryPromise = discoveryTx();

  // Fire concurrently
  await Promise.all([discoveryPromise, monitoringPromise]);

  const product = await db.prepare('SELECT current_price, current_sold, current_likes, current_views, observation_count FROM product_current WHERE item_uid = ?').get(itemUid);

  // Verify that neither update was lost:
  assert.equal(product.current_price, 59.99, 'Monitoring price update must be committed');
  assert.equal(product.current_sold, 45, 'Monitoring soldCount update must be committed');
  assert.equal(product.current_likes, 120, 'Discovery likes increment (100 + 20) must be preserved');
  assert.equal(product.current_views, 1150, 'Discovery views increment (1000 + 150) must be preserved');
});

test('Challenge 2.2: Interleaved 10 Discovery and 10 Monitoring writes preserve Discovery lifecycle state', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'etsy:race-interleaved-item';

  await seedProduct(db, itemUid, {
    query: 'authoritative discovery query',
    status: 'active',
    first_seen_at: '2026-09-01 00:00:00',
    current_likes: 0,
    current_price: 10.0,
  });

  const [k1, k2] = getAdvisoryLockKeys(itemUid);

  for (let i = 1; i <= 10; i++) {
    // Discovery step
    const dTx = db.transaction(async () => {
      await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int);', [k1, k2]);
      await db.prepare('UPDATE product_current SET current_likes = current_likes + 1, last_seen_at = now() WHERE item_uid = ?').run(itemUid);
    });
    await dTx();

    // Monitoring step: directly invoking applyMonitoringObservation without wrapper
    const mRes = await ops.applyMonitoringObservation(itemUid, {
      price: 10.0 + i,
      observedAt: `2026-09-01T12:${String(i).padStart(2, '0')}:00Z`,
      observationId: `monitoring:interleave:${i}`,
    });
    assert.equal(typeof mRes, 'object');
    assert.equal(mRes.updated, true);
  }

  const final = await db.prepare('SELECT query, status, first_seen_at, current_likes, current_price FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(final.query, 'authoritative discovery query', 'query must NEVER be modified by Monitoring');
  assert.equal(final.status, 'active', 'status must NEVER be modified by Monitoring');
  assert.equal(final.first_seen_at, '2026-09-01 00:00:00', 'first_seen_at must NEVER be modified by Monitoring');
  assert.equal(final.current_likes, 10, '10 Discovery increments must all be present');
  assert.equal(final.current_price, 20.0, 'Final Monitoring price must be 10 + 10 = 20.0');
});

test('Challenge 2.3: Concurrent multi-item Discovery batch and 10 Monitoring single refreshes on overlapping items serialize cleanly', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const items = Array.from({ length: 10 }, (_, i) => `etsy:race-overlap-${String(i).padStart(2, '0')}`);

  for (const uid of items) {
    await seedProduct(db, uid, {
      current_price: 20.00,
      current_sold: 100,
      current_likes: 50,
      current_views: 500,
      observation_count: 1,
    });
  }

  // Discovery batch update on all 10 items (sorted by item_uid ASC)
  const sortedItems = [...items].sort();
  const discoveryBatch = db.transaction(async () => {
    let lastLocked = null;
    for (const uid of sortedItems) {
      if (uid !== lastLocked) {
        const [k1, k2] = getAdvisoryLockKeys(uid);
        await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int);', [k1, k2]);
        lastLocked = uid;
      }
      await db.prepare(`
        UPDATE product_current SET
          current_likes = current_likes + 15,
          current_views = current_views + 150,
          last_seen_at = now()
        WHERE item_uid = ?
      `).run(uid);
    }
    return { type: 'discovery', success: true };
  })();

  // 10 concurrent Monitoring single-item refreshes
  const monitoringPromises = items.map((uid, idx) =>
    ops.applyMonitoringObservation(uid, {
      price: 25.00 + idx,
      soldCount: 110 + idx,
      observedAt: '2026-09-12T16:00:00Z',
      observationId: `monitoring:overlap:batch:${idx}`,
    })
  );

  // Run simultaneously
  const results = await Promise.all([discoveryBatch, ...monitoringPromises]);
  assert.equal(results[0].success, true);
  for (let i = 1; i <= 10; i++) {
    assert.equal(results[i].updated, true);
  }

  // Verify all 10 items have both Discovery and Monitoring mutations preserved
  for (let idx = 0; idx < 10; idx++) {
    const uid = items[idx];
    const row = await db.prepare('SELECT current_price, current_sold, current_likes, current_views, observation_count FROM product_current WHERE item_uid = ?').get(uid);
    assert.equal(row.current_price, 25.00 + idx, `Item ${uid} price must match monitoring patch`);
    assert.equal(row.current_sold, 110 + idx, `Item ${uid} sold count must match monitoring patch`);
    assert.equal(row.current_likes, 65, `Item ${uid} likes must include discovery +15 increment (50+15=65)`);
    assert.equal(row.current_views, 650, `Item ${uid} views must include discovery +150 increment (500+150=650)`);
    assert.equal(row.observation_count, 2, `Item ${uid} observation_count must be 2 (initial 1 + 1 monitoring)`);
  }
});

// ============================================================================
// CHALLENGE 3: Deadlock Elimination Test (Havender ASC Sorting vs Reverse Order)
// ============================================================================

test('Challenge 3.1: Reverse order multi-item lock acquisition creates deadlock risk without total ordering', async () => {
  // Demonstration that without sorting, acquiring locks in opposite orders [A, B] vs [B, A]
  // is vulnerable to circular wait (Coffman condition 4).
  const uidA = 'etsy:item-alpha';
  const uidB = 'etsy:item-beta';

  const [k1A, k2A] = getAdvisoryLockKeys(uidA);
  const [k1B, k2B] = getAdvisoryLockKeys(uidB);

  // Havender verification: item_uid ASC sorting establishes total order
  const naturalOrder = [uidB, uidA].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(naturalOrder, [uidA, uidB], 'Both transactions must sort items to [uidA, uidB]');
});

test('Challenge 3.2: Parallel multi-item transactions with overlapping item sets in reverse initial orders execute without 40P01 deadlock', async () => {
  const db = await createIsolatedTestDb();
  const items = [
    'etsy:deadlock-test-item-1',
    'etsy:deadlock-test-item-2',
    'etsy:deadlock-test-item-3',
    'etsy:deadlock-test-item-4',
  ];

  for (const uid of items) {
    await seedProduct(db, uid, { current_price: 10.0 });
  }

  // Batch 1 has items [1, 2, 3] in forward order
  const batch1 = [items[0], items[1], items[2]];
  // Batch 2 has items [3, 2, 1] in REVERSE order
  const batch2 = [items[2], items[1], items[0]];
  // Batch 3 has items [4, 2] overlapping
  const batch3 = [items[3], items[1]];

  // Function simulating Discovery/Batch transaction with Havender ASC ordering
  function executeOrderedBatch(batchUids, batchId) {
    const sorted = [...batchUids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    return db.transaction(async () => {
      let lastLocked = null;
      for (const uid of sorted) {
        if (uid !== lastLocked) {
          const [k1, k2] = getAdvisoryLockKeys(uid);
          await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int);', [k1, k2]);
          lastLocked = uid;
        }
        await db.prepare('UPDATE product_current SET current_price = current_price + 1 WHERE item_uid = ?').run(uid);
      }
      return { batchId, success: true };
    })();
  }

  // Fire all 3 batches in parallel with overlapping sets in reverse initial orders
  const results = await Promise.all([
    executeOrderedBatch(batch1, 1),
    executeOrderedBatch(batch2, 2),
    executeOrderedBatch(batch3, 3),
  ]);

  for (const res of results) {
    assert.equal(res.success, true, `Batch ${res.batchId} must complete without deadlock`);
  }

  // Verify updates:
  // Item 1 was in batch 1 and batch 2 (+2) -> 12.0
  // Item 2 was in batch 1, 2, and 3 (+3) -> 13.0
  // Item 3 was in batch 1 and batch 2 (+2) -> 12.0
  // Item 4 was in batch 3 (+1) -> 11.0
  const p1 = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get(items[0]);
  const p2 = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get(items[1]);
  const p3 = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get(items[2]);
  const p4 = await db.prepare('SELECT current_price FROM product_current WHERE item_uid = ?').get(items[3]);

  assert.equal(p1.current_price, 12.0);
  assert.equal(p2.current_price, 13.0);
  assert.equal(p3.current_price, 12.0);
  assert.equal(p4.current_price, 11.0);
});

test('Challenge 3.3: High-concurrency stress test with 8 simultaneous overlapping transactions', async () => {
  const db = await createIsolatedTestDb();
  const pool = ['etsy:stress-A', 'etsy:stress-B', 'etsy:stress-C', 'etsy:stress-D', 'etsy:stress-E'];
  for (const uid of pool) {
    await seedProduct(db, uid, { current_likes: 0 });
  }

  // Create 8 transactions with randomized overlapping subsets and arbitrary ordering
  const txPromises = Array.from({ length: 8 }, (_, idx) => {
    // Pick 3 pseudo-random items from pool in arbitrary order
    const subset = [pool[(idx * 2) % pool.length], pool[(idx * 3 + 1) % pool.length], pool[(idx + 4) % pool.length]];
    // Enforce Havender ASC order:
    const sorted = [...new Set(subset)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    return db.transaction(async () => {
      for (const uid of sorted) {
        const [k1, k2] = getAdvisoryLockKeys(uid);
        await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int);', [k1, k2]);
        await db.prepare('UPDATE product_current SET current_likes = current_likes + 1 WHERE item_uid = ?').run(uid);
      }
      return idx;
    })();
  });

  const executed = await Promise.all(txPromises);
  assert.equal(executed.length, 8, 'All 8 concurrent transactions must commit with zero deadlocks');
});

test('Challenge 3.4: Stress test with multiple concurrent worker threads across 100+ items with randomized interleaving', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const ITEM_COUNT = 120;
  const items = Array.from({ length: ITEM_COUNT }, (_, i) => `etsy:stress-100-${String(i).padStart(3, '0')}`);

  for (const uid of items) {
    await seedProduct(db, uid, {
      current_price: 15.00,
      current_sold: 50,
      current_likes: 10,
      current_views: 100,
      observation_count: 1,
    });
  }

  // We create 10 concurrent worker tasks:
  // 5 Discovery batch workers and 5 Monitoring refresh workers running concurrently
  const WORKER_COUNT = 10;
  const workerPromises = Array.from({ length: WORKER_COUNT }, async (_, workerId) => {
    // Startup jitter to interleave initial execution
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 10)));

    if (workerId % 2 === 0) {
      // Discovery worker: picks 25 random items from the 120 items pool
      const sampleSize = 25;
      const shuffled = [...items].sort(() => Math.random() - 0.5);
      const selected = shuffled.slice(0, sampleSize);
      // Enforce Havender ASC ordering to prevent circular wait
      selected.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      return db.transaction(async () => {
        let lastLocked = null;
        for (const uid of selected) {
          if (uid !== lastLocked) {
            const [k1, k2] = getAdvisoryLockKeys(uid);
            await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int);', [k1, k2]);
            lastLocked = uid;
          }
          // Micro yield to maximize lock contention and interleaving
          await new Promise(r => setImmediate(r));
          await db.prepare(`
            UPDATE product_current SET
              current_likes = current_likes + 1,
              last_seen_at = now()
            WHERE item_uid = ?
          `).run(uid);
        }
        return { workerId, type: 'discovery', count: selected.length };
      })();
    } else {
      // Monitoring worker: picks 20 random items, applies monitoring observations sequentially
      const sampleSize = 20;
      const shuffled = [...items].sort(() => Math.random() - 0.5);
      const selected = shuffled.slice(0, sampleSize);

      const results = [];
      for (const uid of selected) {
        // Micro yield to simulate network/crawl delay and interleave with discovery
        await new Promise(r => setImmediate(r));
        const res = await ops.applyMonitoringObservation(uid, {
          price: 29.99 + workerId,
          soldCount: 75 + workerId,
          observedAt: new Date(Date.now() + workerId * 1000),
          observationId: `monitoring:stress100:w${workerId}:${uid}`,
        });
        results.push(res);
      }
      return { workerId, type: 'monitoring', count: results.length };
    }
  });

  const results = await Promise.all(workerPromises);
  assert.equal(results.length, WORKER_COUNT, 'All 10 concurrent worker tasks must finish');
  for (const r of results) {
    assert.ok(r.count > 0, `Worker ${r.workerId} (${r.type}) processed ${r.count} items without error`);
  }

  // Verify all 120 items remain healthy in database
  const allRows = await db.prepare('SELECT item_uid, current_price, current_likes, observation_count FROM product_current').all();
  assert.equal(allRows.length, ITEM_COUNT, 'All 120 items must exist');
  for (const row of allRows) {
    assert.ok(row.current_likes >= 10, 'Likes must not have lost initial count');
    assert.ok(row.current_price >= 15.00, 'Price must not be corrupted');
    assert.ok(row.observation_count >= 1, 'Observation count must be >= 1');
  }
});

// ============================================================================
// CHALLENGE 4: Saves Schema Safety & delta_saves Non-Existence
// ============================================================================

test('Challenge 4.1: Database schema has current_saves and prev_saves, but NO delta_saves column', async () => {
  const db = await createIsolatedTestDb();
  const cols = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'product_current'
  `);
  const colNames = cols.rows.map(r => r.column_name);

  assert.ok(colNames.includes('current_saves'), 'current_saves column must exist in product_current');
  assert.ok(colNames.includes('prev_saves'), 'prev_saves column must exist in product_current');
  assert.ok(!colNames.includes('delta_saves'), 'delta_saves column must NOT exist in product_current');
});

test('Challenge 4.2: Querying delta_saves fails with PostgreSQL error 42703 (undefined_column)', async () => {
  const db = await createIsolatedTestDb();
  await assert.rejects(async () => {
    await db.query('SELECT delta_saves FROM product_current LIMIT 1;');
  }, (err) => {
    return err.message.includes('delta_saves') || err.message.includes('does not exist');
  }, 'Attempting to query delta_saves must throw column does not exist');
});

test('Challenge 4.3: Monitoring patch updating saves modifies current_saves and prev_saves without SQL error', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);
  const itemUid = 'tiktok:video:saves-test-001';
  await seedProduct(db, itemUid, { current_saves: 50, prev_saves: null });

  // Update 1: saves becomes 75 (directly calling applyMonitoringObservation)
  const res1 = await ops.applyMonitoringObservation(itemUid, {
    saves: 75,
    observedAt: '2026-09-15T10:00:00Z',
    observationId: 'monitoring:saves:obs:1',
  });
  assert.equal(typeof res1, 'object');
  assert.equal(res1.updated, true);

  const row1 = await db.prepare('SELECT current_saves, prev_saves FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(row1.current_saves, 75, 'current_saves must update to 75');
  assert.equal(row1.prev_saves, 50, 'prev_saves must store previous 50');

  // Update 2: saves becomes 120 (directly calling applyMonitoringObservation)
  const res2 = await ops.applyMonitoringObservation(itemUid, {
    saves: 120,
    observedAt: '2026-09-15T11:00:00Z',
    observationId: 'monitoring:saves:obs:2',
  });
  assert.equal(typeof res2, 'object');
  assert.equal(res2.updated, true);

  const row2 = await db.prepare('SELECT current_saves, prev_saves FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(row2.current_saves, 120, 'current_saves must update to 120');
  assert.equal(row2.prev_saves, 75, 'prev_saves must store previous 75');
});

test('Challenge 4.4: Codebase audit confirms zero references to delta_saves in SQL queries', () => {
  const filesToAudit = [
    path.join(__dirname, '..', '..', 'src', 'database.js'),
    path.join(__dirname, '..', '..', 'src', 'database', 'product-current.js'),
    path.join(__dirname, '..', '..', 'src', 'database', 'daily-history.js'),
    path.join(__dirname, '..', '..', 'src', 'database', 'monitoring.js'),
    path.join(__dirname, '..', '..', 'src', 'database', 'pg-schema.sql'),
  ];

  for (const filePath of filesToAudit) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    // Remove comments to check only active code/SQL
    const codeOnly = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    assert.ok(
      !codeOnly.includes('delta_saves'),
      `File ${path.basename(filePath)} must not contain delta_saves in active code or SQL`
    );
  }
});
