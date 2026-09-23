/**
 * Empirical Challenger 2 Test Suite for Milestone 5:
 * Queue Fencing, Admission Priority & Starvation Challenger.
 *
 * Authoritative SSOT:
 * - docs/DISCOVERY_MONITORING_PLAN_REVISED.md §3.5, §4, §6, §10
 * - .agents/ORIGINAL_REQUEST.md
 * - .agents/orchestrator_1/PROJECT.md (Milestone 5)
 * - .agents/worker_m5/handoff.md
 *
 * Focus & Verification Criteria:
 * 1. Admission Priority: When 100 Discovery runs burst into queue, all Discovery runs preempt Monitoring jobs during admission.
 * 2. Fairness Aging: When a Monitoring job waits `waitTicks >= 50`, it receives a fairness aging boost and is admitted ahead of fresh Discovery runs.
 * 3. Queue Fencing Tokens: A worker with an outdated or expired `claim_token` attempting to commit `completeMonitoringJob` or `failMonitoringJob` must be strictly rejected (0 updated rows).
 * 4. Shop Probe Priority: An eligible shop probe must always be claimed before child item refreshes.
 * 5. Exponential Backoff with Jitter: Verify that retry backoff scales exponentially ($2^N$), is capped at 24h, and includes non-negative jitter.
 * 6. Schema Invariant: Verify that NO query to `monitoring_jobs` references `updated_at`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { fromDriver } = require('../../src/database/pg-client');
const {
  createMonitoringOps,
  claimNextDueMonitoringJob,
  completeMonitoringJob,
  failMonitoringJob,
  recoverExpiredMonitoringJobs,
} = require('../../src/database/monitoring');
const { computeBackoffRetryAt } = require('../../src/monitoring/shop-lifecycle');
const { MonitoringLimiter } = require('../../src/monitoring/limiter');
const { MonitoringDispatcher, parseMonitoringFlag } = require('../../src/monitoring/dispatcher');
const { ResourceScheduler } = require('../../src/scheduler/scheduler');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'pg-schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

/**
 * Creates an isolated PGlite in-memory database with the full production schema.
 */
async function createIsolatedTestDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const driver = new PGlite();
  const db = fromDriver(driver);
  await db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Mock RunQueue for ResourceScheduler to simulate bursts of Discovery runs.
 */
class MockDiscoveryRunQueue {
  constructor(initialRuns = []) {
    this.runs = [...initialRuns];
  }

  enqueue(run) {
    this.runs.push(run);
    return Promise.resolve(run);
  }

  peek(limit = 1) {
    return Promise.resolve(this.runs.slice(0, limit));
  }

  dequeue() {
    return Promise.resolve(this.runs.shift() || null);
  }

  get length() {
    return this.runs.length;
  }
}

/**
 * Mock WorkerPoolManager for ResourceScheduler.
 */
class MockWorkerPoolManager {
  constructor(slots = { BROWSER: 2 }) {
    this.slots = { ...slots };
    this.busy = { BROWSER: 0 };
  }

  hasSlot(poolName) {
    return (this.slots[poolName] || 0) > (this.busy[poolName] || 0);
  }

  acquireSlot(poolName) {
    if (this.hasSlot(poolName)) {
      this.busy[poolName] = (this.busy[poolName] || 0) + 1;
      return true;
    }
    return false;
  }

  releaseSlot(poolName) {
    this.busy[poolName] = Math.max(0, (this.busy[poolName] || 0) - 1);
  }
}

// =============================================================================
// FOCUS 1: ADMISSION PRIORITY (100 Discovery burst preempts Monitoring)
// =============================================================================
test('Focus 1.1: When 100 Discovery runs burst into queue, canAdmitMonitoringCapture strictly preempts Monitoring', async () => {
  const queue = new MockDiscoveryRunQueue(
    Array.from({ length: 100 }, (_, i) => ({ id: `discovery-${i}`, type: 'discovery' }))
  );
  const scheduler = new ResourceScheduler({
    queue,
    pools: new MockWorkerPoolManager({ BROWSER: 5 }),
    monitor: { getSnapshot: () => ({ state: 'GREEN' }) },
  });

  const admission = await scheduler.canAdmitMonitoringCapture(0);
  assert.equal(admission.allowed, false, 'Monitoring must be rejected when Discovery runs are queued');
  assert.equal(admission.reason, 'DISCOVERY_PRIORITY_PREEMPTION');
});

test('Focus 1.2: All 100 Discovery runs drain sequentially, preempting Monitoring on every step', async () => {
  const queue = new MockDiscoveryRunQueue(
    Array.from({ length: 100 }, (_, i) => ({ id: `discovery-${i}`, type: 'discovery' }))
  );
  const scheduler = new ResourceScheduler({
    queue,
    pools: new MockWorkerPoolManager({ BROWSER: 5 }),
    monitor: { getSnapshot: () => ({ state: 'GREEN' }) },
  });

  // Verify preemption from 100 runs down to 1 run
  for (let remaining = 100; remaining >= 1; remaining--) {
    const admission = await scheduler.canAdmitMonitoringCapture(0);
    assert.equal(admission.allowed, false, `Must preempt at ${remaining} runs remaining`);
    assert.equal(admission.reason, 'DISCOVERY_PRIORITY_PREEMPTION');
    await queue.dequeue();
  }

  // Queue now empty (0 runs)
  assert.equal(queue.length, 0);
  const finalAdmission = await scheduler.canAdmitMonitoringCapture(0);
  assert.equal(finalAdmission.allowed, true, 'Monitoring admitted once Discovery queue is empty');
});

test('Focus 1.3: RAM pressure RED and YELLOW preempt Monitoring admission regardless of Discovery queue', async () => {
  const emptyQueue = new MockDiscoveryRunQueue([]);

  const schedulerYellow = new ResourceScheduler({
    queue: emptyQueue,
    pools: new MockWorkerPoolManager({ BROWSER: 5 }),
    monitor: { getSnapshot: () => ({ state: 'YELLOW' }) },
  });
  const admYellow = await schedulerYellow.canAdmitMonitoringCapture(0);
  assert.equal(admYellow.allowed, false);
  assert.equal(admYellow.reason, 'RAM_YELLOW');

  const schedulerRed = new ResourceScheduler({
    queue: emptyQueue,
    pools: new MockWorkerPoolManager({ BROWSER: 5 }),
    monitor: { getSnapshot: () => ({ state: 'RED' }) },
  });
  const admRed = await schedulerRed.canAdmitMonitoringCapture(0);
  assert.equal(admRed.allowed, false);
  assert.equal(admRed.reason, 'RAM_RED');
});

test('Focus 1.4: Saturated BROWSER worker pool rejects Monitoring admission', async () => {
  const emptyQueue = new MockDiscoveryRunQueue([]);
  const pools = new MockWorkerPoolManager({ BROWSER: 1 });
  pools.acquireSlot('BROWSER'); // 1 slot allocated, 0 remaining

  const scheduler = new ResourceScheduler({
    queue: emptyQueue,
    pools,
    monitor: { getSnapshot: () => ({ state: 'GREEN' }) },
  });

  const admission = await scheduler.canAdmitMonitoringCapture(0);
  assert.equal(admission.allowed, false);
  assert.equal(admission.reason, 'BROWSER_POOL_SATURATED');
});

// =============================================================================
// FOCUS 2: FAIRNESS AGING (waitTicks >= 50 grants aging boost)
// =============================================================================
test('Focus 2.1: waitTicks = 49 boundary with 100 Discovery runs queued is still preempted', async () => {
  const queue = new MockDiscoveryRunQueue(
    Array.from({ length: 100 }, (_, i) => ({ id: `discovery-${i}`, type: 'discovery' }))
  );
  const scheduler = new ResourceScheduler({
    queue,
    pools: new MockWorkerPoolManager({ BROWSER: 5 }),
    monitor: { getSnapshot: () => ({ state: 'GREEN' }) },
  });

  const adm49 = await scheduler.canAdmitMonitoringCapture(49);
  assert.equal(adm49.allowed, false, 'waitTicks=49 must be preempted');
  assert.equal(adm49.reason, 'DISCOVERY_PRIORITY_PREEMPTION');
});

test('Focus 2.2: Exact boundary waitTicks = 50 bypasses Discovery preemption and admits Monitoring', async () => {
  const queue = new MockDiscoveryRunQueue(
    Array.from({ length: 100 }, (_, i) => ({ id: `discovery-${i}`, type: 'discovery' }))
  );
  const scheduler = new ResourceScheduler({
    queue,
    pools: new MockWorkerPoolManager({ BROWSER: 5 }),
    monitor: { getSnapshot: () => ({ state: 'GREEN' }) },
  });

  const adm50 = await scheduler.canAdmitMonitoringCapture(50);
  assert.equal(adm50.allowed, true, 'waitTicks=50 must receive fairness boost and be admitted');
});

test('Focus 2.3: Super-aged job (waitTicks = 100) is admitted ahead of bursting Discovery runs', async () => {
  const queue = new MockDiscoveryRunQueue(
    Array.from({ length: 100 }, (_, i) => ({ id: `discovery-${i}`, type: 'discovery' }))
  );
  const scheduler = new ResourceScheduler({
    queue,
    pools: new MockWorkerPoolManager({ BROWSER: 5 }),
    monitor: { getSnapshot: () => ({ state: 'GREEN' }) },
  });

  const adm100 = await scheduler.canAdmitMonitoringCapture(100);
  assert.equal(adm100.allowed, true, 'waitTicks=100 must be admitted');
});

test('Focus 2.4: RAM safety strictly overrides fairness aging even when waitTicks = 100', async () => {
  const queue = new MockDiscoveryRunQueue(
    Array.from({ length: 100 }, (_, i) => ({ id: `discovery-${i}`, type: 'discovery' }))
  );
  const schedulerRed = new ResourceScheduler({
    queue,
    pools: new MockWorkerPoolManager({ BROWSER: 5 }),
    monitor: { getSnapshot: () => ({ state: 'RED' }) },
  });

  const admOverridden = await schedulerRed.canAdmitMonitoringCapture(100);
  assert.equal(admOverridden.allowed, false, 'RAM RED must override aging boost');
  assert.equal(admOverridden.reason, 'RAM_RED');
});

test('Focus 2.5: Dispatcher increments waitTicks on rejection and deletes waitTicks on admission', async () => {
  const db = await createIsolatedTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();

  let queueLength = 1;
  const mockScheduler = {
    canAdmitMonitoringCapture: async (waitTicks) => {
      if (queueLength > 0 && waitTicks < 50) {
        return { allowed: false, reason: 'DISCOVERY_PRIORITY_PREEMPTION' };
      }
      return { allowed: true };
    },
    pools: {
      acquireSlot: () => true,
      releaseSlot: () => {},
    },
  };

  const dispatcher = new MonitoringDispatcher({
    db,
    limiter,
    scheduler: mockScheduler,
    enabled: true,
    tickIntervalMs: 100,
  });

  // Seed entity & job
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (101, 'etsy', 'shop', 'aging-test-shop', 'id', 's1', now(), now())
  `).run();
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (501, 101, 'shop_probe', 's1', now(), 'queued')
  `).run();

  // Tick 1: Rejected because waitTicks = 0
  await dispatcher.tick();
  assert.equal(dispatcher.waitTicksByJobId.get(501), 1, 'waitTicks must increment to 1');

  // Manually fast-forward waitTicks to 49
  dispatcher.waitTicksByJobId.set(501, 49);

  // Tick 2: Rejected at waitTicks = 49 -> becomes 50
  await dispatcher.tick();
  assert.equal(dispatcher.waitTicksByJobId.get(501), 50, 'waitTicks must increment to 50');

  // Tick 3: Admitted at waitTicks = 50 -> waitTicks entry deleted
  await dispatcher.tick();
  assert.equal(dispatcher.waitTicksByJobId.has(501), false, 'waitTicks must be cleared after admission');
});

// =============================================================================
// FOCUS 3: QUEUE FENCING TOKENS (Outdated or expired claim_token strictly rejected)
// =============================================================================
test('Focus 3.1: Stale worker with outdated claim_token attempting completeMonitoringJob is strictly rejected (0 updated rows)', async () => {
  const db = await createIsolatedTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (201, 'etsy', 'shop', 'fencing-shop-1', 'id', 's1', now(), now())
  `).run();
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token)
    VALUES (601, 201, 'shop_probe', 's1', now(), 'claimed', 'active-token-B')
  `).run();

  // Outdated worker A attempts commit with old token
  const result = await completeMonitoringJob(db, {
    jobId: 601,
    claimToken: 'stale-token-A',
    observationId: 'obs-stale',
  });
  assert.equal(result, false, 'completeMonitoringJob must return false for outdated token');

  // Verify database row was NOT modified
  const job = await db.prepare('SELECT status, claim_token, observation_id FROM monitoring_jobs WHERE id = ?').get(601);
  assert.equal(job.status, 'claimed');
  assert.equal(job.claim_token, 'active-token-B');
  assert.equal(job.observation_id, null);
});

test('Focus 3.2: Stale worker with outdated claim_token attempting failMonitoringJob is strictly rejected (0 updated rows)', async () => {
  const db = await createIsolatedTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (202, 'etsy', 'shop', 'fencing-shop-2', 'id', 's1', now(), now())
  `).run();
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token, attempt_count)
    VALUES (602, 202, 'shop_probe', 's1', now(), 'claimed', 'active-token-B', 1)
  `).run();

  // Outdated worker A attempts to report failure
  const result = await failMonitoringJob(db, {
    jobId: 602,
    claimToken: 'stale-token-A',
    error: 'Worker A timed out',
  });
  assert.equal(result, false, 'failMonitoringJob must return false for outdated token');

  // Verify attempt_count and status are untouched
  const job = await db.prepare('SELECT status, claim_token, attempt_count FROM monitoring_jobs WHERE id = ?').get(602);
  assert.equal(job.status, 'claimed');
  assert.equal(job.claim_token, 'active-token-B');
  assert.equal(job.attempt_count, 1);
});

test('Focus 3.3: Expired lease recovered by sweep rejects subsequent completeMonitoringJob attempt', async () => {
  const db = await createIsolatedTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (203, 'etsy', 'shop', 'fencing-shop-3', 'id', 's1', now(), now())
  `).run();

  // Job was claimed with lease expired 10 minutes ago
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token, claimed_until)
    VALUES (603, 203, 'shop_probe', 's1', now() - INTERVAL '30 minutes', 'claimed', 'token-expired-worker', now() - INTERVAL '10 minutes')
  `).run();

  // Recovery sweeps expired claims
  const recovered = await recoverExpiredMonitoringJobs(db);
  assert.equal(recovered.length, 1);
  assert.equal(Number(recovered[0].id), 603);

  // Expired worker attempts to complete job
  const commitRes = await completeMonitoringJob(db, {
    jobId: 603,
    claimToken: 'token-expired-worker',
  });
  assert.equal(commitRes, false, 'Expired worker must be rejected after recovery');

  // Verify job remains in queued state ready for another worker
  const job = await db.prepare('SELECT status, claim_token FROM monitoring_jobs WHERE id = ?').get(603);
  assert.equal(job.status, 'queued');
  assert.equal(job.claim_token, null);
});

test('Focus 3.4: Expired lease recovered by sweep rejects subsequent failMonitoringJob attempt', async () => {
  const db = await createIsolatedTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (204, 'etsy', 'shop', 'fencing-shop-4', 'id', 's1', now(), now())
  `).run();
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token, claimed_until, attempt_count)
    VALUES (604, 204, 'shop_probe', 's1', now() - INTERVAL '1 hour', 'claimed', 'dead-worker-token', now() - INTERVAL '5 minutes', 0)
  `).run();

  await recoverExpiredMonitoringJobs(db);

  const failRes = await failMonitoringJob(db, {
    jobId: 604,
    claimToken: 'dead-worker-token',
    error: 'Dead worker reporting late',
  });
  assert.equal(failRes, false, 'failMonitoringJob must be rejected on recovered job');

  const job = await db.prepare('SELECT status, attempt_count FROM monitoring_jobs WHERE id = ?').get(604);
  assert.equal(job.status, 'queued');
  assert.equal(job.attempt_count, 0);
});

test('Focus 3.5: Valid claim_token successfully completes job and sets status to completed', async () => {
  const db = await createIsolatedTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (205, 'etsy', 'shop', 'fencing-shop-5', 'id', 's1', now(), now())
  `).run();
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token)
    VALUES (605, 205, 'shop_probe', 's1', now(), 'claimed', 'valid-active-token')
  `).run();

  const success = await completeMonitoringJob(db, {
    jobId: 605,
    claimToken: 'valid-active-token',
    observationId: 'obs-success-123',
  });
  assert.equal(success, true, 'Valid token must succeed');

  const job = await db.prepare('SELECT status, observation_id, finished_at FROM monitoring_jobs WHERE id = ?').get(605);
  assert.equal(job.status, 'completed');
  assert.equal(job.observation_id, 'obs-success-123');
  assert.ok(job.finished_at);
});

// =============================================================================
// FOCUS 4: SHOP PROBE PRIORITY (Eligible shop probe claimed before item refreshes)
// =============================================================================
test('Focus 4.1: Eligible shop probe is claimed before child item refreshes', async () => {
  const db = await createIsolatedTestDb();

  // Create entity
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, is_starred)
    VALUES (301, 'etsy', 'shop', 'probe-priority-shop', 'id', 's1', now(), now(), false)
  `).run();

  // Create child item
  await db.prepare(`
    INSERT INTO monitoring_items (id, entity_id, item_uid, eligibility, item_status, next_due_at)
    VALUES (401, 301, 'etsy:item-401', 'ready', 'active', now())
  `).run();

  // Enqueue item refresh FIRST (earlier scheduled_for)
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, item_id, kind, session_id, scheduled_for, status)
    VALUES (701, 401, 'item_refresh', 's1', now() - INTERVAL '10 minutes', 'queued')
  `).run();

  // Enqueue shop probe SECOND (later scheduled_for)
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (702, 301, 'shop_probe', 's1', now() - INTERVAL '5 minutes', 'queued')
  `).run();

  // Claim next job
  const claimed = await claimNextDueMonitoringJob(db, { workerToken: 'worker-probe-test' });
  assert.ok(claimed, 'Must claim a job');
  assert.equal(claimed.kind, 'shop_probe', 'Shop probe MUST be claimed before item_refresh');
  assert.equal(claimed.id, 702);
});

test('Focus 4.2: Unstarred shop probe is claimed before STARRED item refresh (Probe hierarchy strictly dominates Star priority)', async () => {
  const db = await createIsolatedTestDb();

  // Unstarred shop entity
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, is_starred)
    VALUES (302, 'etsy', 'shop', 'unstarred-shop', 'id', 's1', now(), now(), false)
  `).run();

  // Starred author entity with child item
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, is_starred)
    VALUES (303, 'tiktok', 'author', 'starred-creator', 'id', 's1', now(), now(), true)
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_items (id, entity_id, item_uid, eligibility, item_status, next_due_at)
    VALUES (402, 303, 'tiktok:video-402', 'ready', 'active', now())
  `).run();

  // Queued: Starred item refresh vs Unstarred shop probe
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, item_id, kind, session_id, scheduled_for, status)
    VALUES (703, 402, 'item_refresh', 's1', now() - INTERVAL '20 minutes', 'queued')
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (704, 302, 'shop_probe', 's1', now() - INTERVAL '5 minutes', 'queued')
  `).run();

  const claimed = await claimNextDueMonitoringJob(db, { workerToken: 'worker-star-vs-probe' });
  assert.ok(claimed);
  assert.equal(claimed.kind, 'shop_probe', 'Unstarred shop probe MUST take precedence over starred item refresh');
  assert.equal(claimed.id, 704);
});

test('Focus 4.3: Multiple shop probes: Starred shop probe claimed before Unstarred shop probe', async () => {
  const db = await createIsolatedTestDb();

  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, is_starred)
    VALUES (304, 'etsy', 'shop', 'unstarred-probe', 'id', 's1', now(), now(), false)
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, is_starred)
    VALUES (305, 'etsy', 'shop', 'starred-probe', 'id', 's1', now(), now(), true)
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (705, 304, 'shop_probe', 's1', now() - INTERVAL '10 minutes', 'queued')
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (706, 305, 'shop_probe', 's1', now() - INTERVAL '5 minutes', 'queued')
  `).run();

  const claimed = await claimNextDueMonitoringJob(db, { workerToken: 'worker-star-probe' });
  assert.ok(claimed);
  assert.equal(claimed.id, 706, 'Starred shop probe must be claimed before unstarred shop probe');
});

test('Focus 4.4: Inactive or future shop probe does not block eligible item refreshes', async () => {
  const db = await createIsolatedTestDb();

  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, is_starred)
    VALUES (306, 'etsy', 'shop', 'future-shop', 'id', 's1', now(), now(), false)
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_items (id, entity_id, item_uid, eligibility, item_status, next_due_at)
    VALUES (406, 306, 'etsy:item-406', 'ready', 'active', now())
  `).run();

  // Future probe (not due yet)
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (707, 306, 'shop_probe', 's1', now() + INTERVAL '1 hour', 'queued')
  `).run();

  // Currently due item refresh
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, item_id, kind, session_id, scheduled_for, status)
    VALUES (708, 406, 'item_refresh', 's1', now() - INTERVAL '5 minutes', 'queued')
  `).run();

  const claimed = await claimNextDueMonitoringJob(db, { workerToken: 'worker-item-fallback' });
  assert.ok(claimed);
  assert.equal(claimed.kind, 'item_refresh', 'Due item refresh is claimed when shop probe is in future');
  assert.equal(claimed.id, 708);
});

// =============================================================================
// FOCUS 5: EXPONENTIAL BACKOFF WITH JITTER ($2^N, 24h cap, non-negative jitter)
// =============================================================================
test('Focus 5.1: Retry backoff scales exponentially (2^N) with baseMs', () => {
  const baseMs = 1000;
  const now = Date.now();

  for (let attempt = 1; attempt <= 10; attempt++) {
    // zero jitter for pure exponential scaling verification
    const retryDate = computeBackoffRetryAt(attempt, { baseMs, jitterMs: 0 });
    const expectedDelayMs = baseMs * Math.pow(2, attempt);
    const actualDelayMs = retryDate.getTime() - now;
    // Allow slight execution tolerance (< 50ms)
    assert.ok(
      Math.abs(actualDelayMs - expectedDelayMs) < 50,
      `Attempt ${attempt} must scale to ${expectedDelayMs}ms, got ${actualDelayMs}ms`
    );
  }
});

test('Focus 5.2: Retry backoff is strictly capped at 24 hours (86,400,000 ms)', () => {
  const baseMs = 1000;
  const maxMs = 24 * 60 * 60 * 1000; // 86,400,000 ms
  const now = Date.now();

  const largeAttempts = [17, 20, 30, 50, 100];
  for (const attempt of largeAttempts) {
    const retryDate = computeBackoffRetryAt(attempt, { baseMs, maxMs, jitterMs: 0 });
    const delayMs = retryDate.getTime() - now;
    assert.ok(
      Math.abs(delayMs - maxMs) < 50,
      `Attempt ${attempt} delay must be capped at 24h (${maxMs}ms), got ${delayMs}ms`
    );
  }
});

test('Focus 5.3: Jitter is strictly non-negative across 1,000 randomized executions', () => {
  const baseMs = 1000;

  for (let i = 0; i < 1000; i++) {
    const attempt = Math.floor(Math.random() * 10) + 1;
    const start = Date.now();
    const retryDate = computeBackoffRetryAt(attempt, { baseMs });
    const diffMs = retryDate.getTime() - start;
    const minExpected = baseMs * Math.pow(2, attempt);

    assert.ok(diffMs >= minExpected - 5, `Diff ${diffMs} must be >= min expected ${minExpected}`);
  }
});

test('Focus 5.4: Explicit negative jitter option is clamped to zero', () => {
  const baseMs = 1000;
  const now = Date.now();
  const retryDate = computeBackoffRetryAt(1, { baseMs, jitterMs: -9999 });
  const delayMs = retryDate.getTime() - now;
  const expectedDelay = baseMs * 2; // 2000ms

  assert.ok(
    Math.abs(delayMs - expectedDelay) < 50,
    `Negative jitter must be clamped to 0, expected ~${expectedDelay}ms, got ${delayMs}ms`
  );
});

test('Focus 5.5: Database failMonitoringJob integrates exponential retry_at and handles maxRetries boundary', async () => {
  const db = await createIsolatedTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (350, 'etsy', 'shop', 'retry-shop', 'id', 's1', now(), now())
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token, attempt_count)
    VALUES (750, 350, 'shop_probe', 's1', now(), 'claimed', 'worker-retry', 0)
  `).run();

  // Attempt 1 failure: should retry
  const fail1 = await failMonitoringJob(db, {
    jobId: 750,
    claimToken: 'worker-retry',
    error: 'Temporary 503',
    maxRetries: 3,
    baseMs: 1000,
  });
  assert.equal(fail1.retried, true);
  assert.equal(fail1.attemptCount, 1);
  assert.ok(fail1.retryAt instanceof Date);

  const jobAfterFail1 = await db.prepare('SELECT status, attempt_count, retry_at, claim_token FROM monitoring_jobs WHERE id = ?').get(750);
  assert.equal(jobAfterFail1.status, 'queued');
  assert.equal(jobAfterFail1.attempt_count, 1);
  assert.equal(jobAfterFail1.claim_token, null);
  assert.ok(new Date(jobAfterFail1.retry_at).getTime() > Date.now());

  // Fast forward attempt_count to 2
  await db.prepare("UPDATE monitoring_jobs SET attempt_count = 2, status = 'claimed', claim_token = 'worker-retry-2' WHERE id = 750").run();

  // Attempt 3 failure (maxRetries = 3 reached, nextAttempt = 3 not < 3): transitions to 'failed'
  const failTerminal = await failMonitoringJob(db, {
    jobId: 750,
    claimToken: 'worker-retry-2',
    error: 'Permanent failure',
    maxRetries: 3,
  });
  assert.equal(failTerminal.retried, false);
  assert.equal(failTerminal.status, 'failed');
  assert.equal(failTerminal.attemptCount, 3);

  const jobFinal = await db.prepare('SELECT status, attempt_count FROM monitoring_jobs WHERE id = ?').get(750);
  assert.equal(jobFinal.status, 'failed');
  assert.equal(jobFinal.attempt_count, 3);
});

// =============================================================================
// FOCUS 6: SCHEMA INVARIANT (NO query to monitoring_jobs references updated_at)
// =============================================================================
test('Focus 6.1: Physical schema verification - monitoring_jobs contains NO updated_at column', async () => {
  const db = await createIsolatedTestDb();
  const colRes = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'monitoring_jobs'
  `);
  const columnNames = new Set(colRes.rows.map(r => r.column_name));

  assert.equal(
    columnNames.has('updated_at'),
    false,
    'CRITICAL SCHEMA INVARIANT: monitoring_jobs MUST NOT have updated_at column'
  );
  assert.ok(columnNames.has('created_at'), 'monitoring_jobs must have created_at');
  assert.ok(columnNames.has('started_at'), 'monitoring_jobs must have started_at');
  assert.ok(columnNames.has('finished_at'), 'monitoring_jobs must have finished_at');
});

test('Focus 6.2: All lifecycle queries (claim, complete, fail, recover) execute without updated_at errors', async () => {
  const db = await createIsolatedTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (550, 'etsy', 'shop', 'schema-invariant-shop', 'id', 's1', now(), now())
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (850, 550, 'shop_probe', 's1', now(), 'queued')
  `).run();

  // 1. Claim
  const claimed = await claimNextDueMonitoringJob(db, { workerToken: 'inv-worker' });
  assert.ok(claimed);
  assert.equal(claimed.id, 850);

  // 2. Fail (retryable)
  const failed = await failMonitoringJob(db, { jobId: 850, claimToken: 'inv-worker', error: 'Retry me' });
  assert.equal(failed.retried, true);

  // Fast forward retry_at to now for reclaim
  await db.prepare('UPDATE monitoring_jobs SET retry_at = now() WHERE id = 850').run();

  // 3. Re-claim
  const reclaimed = await claimNextDueMonitoringJob(db, { workerToken: 'inv-worker-2' });
  assert.ok(reclaimed);

  // 4. Complete
  const completed = await completeMonitoringJob(db, { jobId: 850, claimToken: 'inv-worker-2', observationId: 'obs-inv' });
  assert.equal(completed, true);

  // 5. Recover sweep
  const recovered = await recoverExpiredMonitoringJobs(db);
  assert.ok(Array.isArray(recovered));
});

test('Focus 6.3: Static codebase scan - verify zero references to updated_at on monitoring_jobs in src/', () => {
  const srcDir = path.join(__dirname, '..', '..', 'src');

  function scanDirectory(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        files.push(...scanDirectory(full));
      } else if (e.isFile() && e.name.endsWith('.js')) {
        files.push(full);
      }
    }
    return files;
  }

  const jsFiles = scanDirectory(srcDir);
  const violations = [];

  for (const file of jsFiles) {
    const rawContent = fs.readFileSync(file, 'utf8');
    // Strip comments to inspect actual executing SQL queries
    const content = rawContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    const regex = /(UPDATE|INSERT\s+INTO|SELECT)[^;]*monitoring_jobs[^;]*updated_at/is;
    if (regex.test(content)) {
      violations.push(file);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Found illicit updated_at query on monitoring_jobs in: ${violations.join(', ')}`
  );
});

// =============================================================================
// FOCUS 7: ADVERSARIAL CONCURRENCY & RACING STRESS HARNESS
// =============================================================================
test('Focus 7.1: 10 parallel workers racing to claim the same queued job -> exactly 1 winner, 9 get null', async () => {
  const db = await createIsolatedTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (990, 'etsy', 'shop', 'race-shop', 'id', 's1', now(), now())
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (9900, 990, 'shop_probe', 's1', now(), 'queued')
  `).run();

  // 10 concurrent workers attempt claim
  const claimPromises = Array.from({ length: 10 }, (_, i) =>
    claimNextDueMonitoringJob(db, { workerToken: `racing-worker-${i}`, leaseDurationMs: 30000 })
  );

  const results = await Promise.all(claimPromises);
  const winners = results.filter(Boolean);
  const losers = results.filter(r => r === null);

  assert.equal(winners.length, 1, 'Exactly 1 worker must win the claimed job');
  assert.equal(losers.length, 9, 'All other 9 workers must receive null');
  assert.equal(winners[0].id, 9900);
});

test('Focus 7.2: 10 parallel workers racing for MonitoringLimiter lease -> exactly 1 winner, 9 get null', async () => {
  const db = await createIsolatedTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();

  const acquirePromises = Array.from({ length: 10 }, (_, i) =>
    limiter.tryAcquireLease(`limiter-racer-${i}`, 30000)
  );

  const results = await Promise.all(acquirePromises);
  const winners = results.filter(Boolean);
  const losers = results.filter(r => r === null);

  assert.equal(winners.length, 1, 'Exactly 1 worker acquires global capture lease');
  assert.equal(losers.length, 9, 'All other 9 workers are denied lease');
});

test('Focus 7.3: MONITORING_ENABLED flag parsing safety (F27) handles all edge cases', () => {
  assert.equal(parseMonitoringFlag(undefined), false);
  assert.equal(parseMonitoringFlag(null), false);
  assert.equal(parseMonitoringFlag(''), false);
  assert.equal(parseMonitoringFlag('false'), false);
  assert.equal(parseMonitoringFlag('FALSE'), false);
  assert.equal(parseMonitoringFlag('0'), false);
  assert.equal(parseMonitoringFlag('random'), false);

  assert.equal(parseMonitoringFlag(true), true);
  assert.equal(parseMonitoringFlag('true'), true);
  assert.equal(parseMonitoringFlag('TRUE'), true);
  assert.equal(parseMonitoringFlag('1'), true);
  assert.equal(parseMonitoringFlag(1), true);
});

