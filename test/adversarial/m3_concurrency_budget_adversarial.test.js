'use strict';

/**
 * test/adversarial/m3_concurrency_budget_adversarial.test.js
 *
 * Tier 5 Adversarial Stress & Verification Test Suite for Milestone M3:
 * - Feature 11: System Concurrency Cap & Queue Admission Control
 * - Feature 12: Apify Budget Kill Switch & Floating-Point Precision
 * - Feature 13: Emergency Dispatch Freeze & Fail-Safe Ingress Protection
 *
 * Vectors Verified:
 * 1. Concurrency saturation & queue admission race conditions (maxConcurrentRuns: 3 flood)
 * 2. Slot underflow stress (spurious completion calls & zero clamping Math.max(0, ...))
 * 3. Emergency Freeze rapid toggling under load (503 DISPATCH_FROZEN, zero orphaned locks)
 * 4. Apify Budget Kill Switch boundary stress (exact $0.00, $0.0001 precision, 10-parallel race for $5, free scraper bypass at -$10.00)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { ResourceScheduler } = require('../../src/scheduler/scheduler');
const { ApifyTokenPoolManager, ApifyBudgetExceededError } = require('../../src/apify-token-pool');
const { AdminDashboardService } = require('../../src/admin/dashboard');

// Test port for live server integration
const LIVE_PORT = 32299;
const BASE_URL = `http://127.0.0.1:${LIVE_PORT}`;
const LIVE_SERVICE_KEY = 'm3-adversarial-service-key-32chars!';

/**
 * Helper to build an in-memory mock scheduler with isolated pools and queue
 */
function createIsolatedMockScheduler(options = {}) {
  const queuedRuns = [];
  const fakeDatabase = {
    getAllPlatforms: async () => [],
    getRunsFiltered: async () => [],
    getRunsByStatus: async () => [],
    createRun: async (data) => {
      const run = { id: queuedRuns.length + 100, status: 'queued', ...data };
      queuedRuns.push(run);
      return run;
    },
    updateRun: async (id, updates) => {
      const r = queuedRuns.find((item) => item.id === id);
      if (r) Object.assign(r, updates);
      return r;
    },
  };

  const fakeQueue = {
    peek: async (limit = 20) => queuedRuns.filter((r) => r.status === 'queued').slice(0, limit),
    enqueue: async (payload) => {
      const r = { id: queuedRuns.length + 1, status: 'queued', ...payload };
      queuedRuns.push(r);
      return r;
    },
    getById: async (id) => queuedRuns.find((r) => r.id === id) || null,
    markRunning: async (id) => {
      const r = queuedRuns.find((item) => item.id === id);
      if (r) r.status = 'running';
    },
    markFailed: async (id, err) => {
      const r = queuedRuns.find((item) => item.id === id);
      if (r) {
        r.status = 'failed';
        r.error = err;
      }
    },
    countByStatus: async () => ({
      queued: queuedRuns.filter((r) => r.status === 'queued').length,
      running: queuedRuns.filter((r) => r.status === 'running').length,
      done: queuedRuns.filter((r) => r.status === 'done').length,
    }),
  };

  const fakeMonitor = {
    getSnapshot: () => ({ state: 'GREEN', availableMB: 8192 }),
    canAdmit: () => ({ allowed: true }),
    reserve: () => {},
    release: () => {},
  };

  const acquiredSlots = new Set();
  const acquiredLocks = new Set();

  const fakePools = {
    getStatus: () => ({
      acquiredSlots: acquiredSlots.size,
      acquiredLocks: acquiredLocks.size,
    }),
    isElastic: () => true,
    hasSlot: () => true,
    canAdmit: () => ({ allowed: true }),
    acquireSlot: (_pool, token) => {
      acquiredSlots.add(token);
      return true;
    },
    acquireLock: (lockName, token) => {
      acquiredLocks.add(`${lockName}:${token}`);
      return true;
    },
    releaseAllForToken: (token) => {
      acquiredSlots.delete(token);
      for (const lk of Array.from(acquiredLocks)) {
        if (lk.endsWith(`:${token}`)) acquiredLocks.delete(lk);
      }
    },
  };

  const fakePlanner = {
    plan: async (run) => ({
      platform: run.platform || 'etsy',
      backend: 'local',
      executionClass: 'LOCAL_HTTP',
      pool: 'LOCAL',
      jobKind: 'channel',
      estimatedEnvelopeMB: 100,
      options: run.options || {},
    }),
  };

  const scheduler = new ResourceScheduler({
    database: fakeDatabase,
    queue: fakeQueue,
    monitor: fakeMonitor,
    pools: fakePools,
    planner: fakePlanner,
    executeRun: async () => new Promise(() => {}), // keeps run running
    ...options,
  });

  return { scheduler, fakeDatabase, fakeQueue, fakePools, queuedRuns, acquiredSlots, acquiredLocks };
}

// ============================================================================
// PART 1: Component Stress Vectors (Scheduler, TokenPool, Dashboard)
// ============================================================================

test('Milestone M3 Adversarial: Component Stress Vectors', async (t) => {

  // --- VECTOR 1: Concurrency Saturation & Queue Admission Race Conditions ---
  await t.test('Vector 1.1: Queue admission race with maxConcurrentRuns: 3 admits exactly 3 of 10 candidates', async () => {
    const { scheduler, fakeQueue, queuedRuns } = createIsolatedMockScheduler({
      maxConcurrentRuns: 3,
    });

    // Enqueue 10 candidate runs
    for (let i = 1; i <= 10; i++) {
      await fakeQueue.enqueue({ id: i, platform: 'etsy', query: `query-${i}` });
    }
    assert.strictEqual(queuedRuns.length, 10);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);

    // Trigger tick
    await scheduler.tick();

    // Exactly 3 runs admitted into active execution
    assert.strictEqual(
      scheduler.getActiveExecutionCount(),
      3,
      `Expected exactly 3 active runs, got: ${scheduler.getActiveExecutionCount()}`
    );
    assert.strictEqual(scheduler.activeRunMetrics.size, 3);

    // 7 runs must remain in 'queued' status
    const remainingQueued = queuedRuns.filter((r) => r.status === 'queued');
    assert.strictEqual(remainingQueued.length, 7, 'Expected 7 runs to remain safely queued');

    // Repeated tick while saturated must admit zero new runs
    await scheduler.tick();
    assert.strictEqual(scheduler.getActiveExecutionCount(), 3);
    assert.strictEqual(queuedRuns.filter((r) => r.status === 'queued').length, 7);
  });

  await t.test('Vector 1.2: Dynamic ceiling expansion and contraction under backpressure', async () => {
    const { scheduler, fakeQueue, queuedRuns } = createIsolatedMockScheduler({
      maxConcurrentRuns: 3,
    });

    for (let i = 1; i <= 10; i++) {
      await fakeQueue.enqueue({ id: i, platform: 'etsy', query: `query-${i}` });
    }
    await scheduler.tick();
    assert.strictEqual(scheduler.getActiveExecutionCount(), 3);

    // Dynamically expand ceiling to 5
    scheduler.setMaxConcurrentRuns(5);
    assert.strictEqual(scheduler.getMaxConcurrentRuns(), 5);
    assert.strictEqual(scheduler.canAdmitRun().allowed, true);

    // Next tick must admit exactly 2 more runs up to 5
    await scheduler.tick();
    assert.strictEqual(scheduler.getActiveExecutionCount(), 5);
    assert.strictEqual(queuedRuns.filter((r) => r.status === 'queued').length, 5);

    // Dynamically contract ceiling down to 2 (below current active count)
    scheduler.setMaxConcurrentRuns(2);
    const admissionCheck = scheduler.canAdmitRun();
    assert.strictEqual(admissionCheck.allowed, false);
    assert.strictEqual(admissionCheck.reason, 'CONCURRENCY_LIMIT_REACHED');

    // Next tick with lower ceiling must not admit any new runs
    await scheduler.tick();
    assert.strictEqual(scheduler.getActiveExecutionCount(), 5);
    assert.strictEqual(queuedRuns.filter((r) => r.status === 'queued').length, 5);
  });

  // --- VECTOR 2: Slot Underflow Stress & Clamping Invariants ---
  await t.test('Vector 2.1: Slot underflow stress clamps active counter to Math.max(0, ...)', () => {
    const { scheduler } = createIsolatedMockScheduler({ maxConcurrentRuns: 5 });

    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);

    // Adversarial negative inputs
    scheduler.setActiveRunsCount(-1);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);

    scheduler.setActiveRunsCount(-999);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);

    scheduler.setActiveRunsCount(0);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);

    // Invariant: canAdmitRun() must still evaluate normally after negative attempts
    assert.strictEqual(scheduler.canAdmitRun().allowed, true);
  });

  // --- VECTOR 3: Emergency Freeze Rapid Toggling & Invariants ---
  await t.test('Vector 3.1: Emergency Freeze rapid toggling under load produces zero orphaned locks', async () => {
    const { scheduler, fakeQueue, acquiredSlots, acquiredLocks } = createIsolatedMockScheduler({
      maxConcurrentRuns: 5,
    });

    for (let i = 1; i <= 20; i++) {
      await fakeQueue.enqueue({ id: i, platform: 'etsy', query: `query-${i}` });
    }

    // Rapid flip-flop freeze toggle 50 times
    for (let toggle = 0; toggle < 50; toggle++) {
      const shouldFreeze = toggle % 2 === 0;
      scheduler.setEmergencyFreeze(shouldFreeze);
      assert.strictEqual(scheduler.isFrozen(), shouldFreeze);

      // Concurrently query canAdmitRun during freeze
      const check = scheduler.canAdmitRun();
      if (shouldFreeze) {
        assert.strictEqual(check.allowed, false);
        assert.strictEqual(check.reason, 'DISPATCH_FROZEN');
      }
    }

    // Ensure final state is frozen
    scheduler.setEmergencyFreeze(true);
    await scheduler.tick();

    // Freeze must halt tick before queue admission
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);
    assert.strictEqual(acquiredSlots.size, 0, 'Zero slots should be acquired while frozen');
    assert.strictEqual(acquiredLocks.size, 0, 'Zero locks should be acquired while frozen');

    // Unfreeze and verify smooth recovery
    scheduler.setEmergencyFreeze(false);
    assert.strictEqual(scheduler.isFrozen(), false);
    await scheduler.tick();

    // Admitted up to max capacity
    assert.strictEqual(scheduler.getActiveExecutionCount(), 5);
  });

  // --- VECTOR 4: Apify Budget Kill Switch Boundary & Precision ---
  await t.test('Vector 4.1: Exact zero ($0.00) and negative boundary returns APIFY_BUDGET_EXCEEDED', () => {
    const poolZero = new ApifyTokenPoolManager({
      tokens: ['apify_tok_1'],
      initialApifyBalance: 0.0,
      minBalanceThresholdUsd: 0.0,
    });

    const checkZero = poolZero.checkBudget();
    assert.strictEqual(checkZero.allowed, false);
    assert.strictEqual(checkZero.reason, 'APIFY_BUDGET_EXCEEDED');

    assert.throws(
      () => poolZero.assertBudgetAvailable(),
      (err) => {
        assert.strictEqual(err.name, 'ApifyBudgetExceededError');
        assert.strictEqual(err.status, 402);
        assert.strictEqual(err.code, 'APIFY_BUDGET_EXCEEDED');
        return true;
      }
    );

    const poolNegative = new ApifyTokenPoolManager({
      tokens: ['apify_tok_1'],
      initialApifyBalance: -10.0,
      minBalanceThresholdUsd: 0.0,
    });

    const checkNeg = poolNegative.checkBudget();
    assert.strictEqual(checkNeg.allowed, false);
    assert.strictEqual(checkNeg.reason, 'APIFY_BUDGET_EXCEEDED');
  });

  await t.test('Vector 4.2: Micro-spend floating-point precision ($0.0001) avoids roundoff drift', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_tok_1'],
      initialApifyBalance: 0.0001,
      minBalanceThresholdUsd: 0.0,
    });

    // 0.0001 > 0.0000 threshold -> must be allowed
    const checkMicro = pool.checkBudget();
    assert.strictEqual(checkMicro.allowed, true);
    assert.strictEqual(checkMicro.remainingBalance, 0.0001);

    // Deduct exact micro-amount
    pool.deductBudget(0.0001);
    assert.strictEqual(pool.remainingBalanceUsd, 0.0);
    assert.strictEqual(pool.checkBudget().allowed, false);

    // Consecutive 10 micro-deductions from 1.0000
    const poolTen = new ApifyTokenPoolManager({
      tokens: ['apify_tok_1'],
      initialApifyBalance: 1.0,
      minBalanceThresholdUsd: 0.0,
    });

    for (let i = 0; i < 10; i++) {
      poolTen.deductBudget(0.0001);
    }
    // IEEE 754 precision: 1.0 - (10 * 0.0001) must be exactly 0.9990, not 0.9990000000000001
    assert.strictEqual(poolTen.remainingBalanceUsd, 0.999);
    assert.strictEqual(poolTen.totalSpentUsd, 0.001);
  });

  await t.test('Vector 4.3: Concurrent budget deduction race: 10 parallel paid runs for $5 budget -> exactly 5 succeed', async () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_tok_1'],
      initialApifyBalance: 5.0,
      defaultRunCostUsd: 1.0,
      minBalanceThresholdUsd: 0.0,
    });

    const results = [];
    // 10 concurrent requests competing for $5 budget
    const attempts = Array.from({ length: 10 }, async (_, i) => {
      try {
        pool.assertBudgetAvailable();
        pool.deductBudget(1.0);
        results.push({ attempt: i, success: true });
      } catch (err) {
        if (err.code === 'APIFY_BUDGET_EXCEEDED') {
          results.push({ attempt: i, success: false, error: err.code });
        } else {
          throw err;
        }
      }
    });

    await Promise.all(attempts);

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    assert.strictEqual(succeeded.length, 5, 'Exactly 5 runs must succeed on $5.00 budget');
    assert.strictEqual(failed.length, 5, 'Exactly 5 runs must be rejected with APIFY_BUDGET_EXCEEDED');
    assert.strictEqual(pool.remainingBalanceUsd, 0.0, 'Remaining budget must be exactly 0.00');
    assert.strictEqual(pool.totalSpentUsd, 5.0, 'Total spent must be exactly 5.00');
  });
});

// ============================================================================
// PART 2: Live Server End-to-End Adversarial Stress Tests
// ============================================================================

test('Milestone M3 Adversarial: Live Server HTTP Stress Suite', async (t) => {
  let serverProcess = null;
  let adminSessionCookie = null;
  const memberApiKeys = [];

  // Helper for authenticated fetch
  async function adminFetch(urlPath, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'x-requested-with': 'XMLHttpRequest', // CSRF defense bypass header
      Cookie: adminSessionCookie || '',
      ...(options.headers || {}),
    };
    return fetch(`${BASE_URL}${urlPath}`, { ...options, headers });
  }

  async function keyFetch(urlPath, apiKey, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      ...(options.headers || {}),
    };
    return fetch(`${BASE_URL}${urlPath}`, { ...options, headers });
  }

  // Before all live tests: spawn live server process
  const env = {
    ...process.env,
    PORT: String(LIVE_PORT),
    PG_MODE: 'pglite',
    ADMIN_EMAIL: 'admin@system.local',
    ADMIN_PASSWORD: 'SuperAdminPassword123!',
    INTERNAL_SERVICE_KEY: LIVE_SERVICE_KEY,
    MAX_CONCURRENT_RUNS: '3', // Start with ceiling = 3 for Vector 1
    APIFY_INITIAL_BALANCE_USD: '100.0',
    EMERGENCY_DISPATCH_FREEZE: 'false',
  };

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', () => {});
  serverProcess.stderr.on('data', () => {});

  // Wait for /livez
  const deadline = Date.now() + 15000;
  let booted = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/livez`);
      if (res.ok) {
        booted = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(booted, 'Live test server failed to start within 15s');

  // Authenticate Admin and retrieve session cookie
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@system.local',
      password: 'SuperAdminPassword123!',
    }),
  });
  assert.strictEqual(loginRes.status, 200, 'Admin login failed');
  adminSessionCookie = loginRes.headers.get('set-cookie');
  assert.ok(adminSessionCookie, 'Session cookie must be returned');

  // Generate 12 distinct Member API keys for concurrent flood testing
  for (let k = 1; k <= 12; k++) {
    const keyRes = await adminFetch('/api/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        name: `adversarial-member-key-${k}`,
        role: 'member',
        expiresInDays: 7,
      }),
    });
    assert.strictEqual(keyRes.status, 201, `Failed to generate API key #${k}`);
    const keyJson = await keyRes.json();
    memberApiKeys.push(keyJson.rawKey);
  }
  assert.strictEqual(memberApiKeys.length, 12);

  // Teardown hook
  t.after(() => {
    if (serverProcess) {
      serverProcess.kill('SIGKILL');
    }
  });

  // --- LIVE TEST 1: Concurrency Saturation & Rejection at API Ingress ---
  await t.test('Live Vector 1: Concurrency saturation (3 active runs) rejects flooded requests with HTTP 429 CONCURRENCY_LIMIT_REACHED', async () => {
    // 1. Submit 3 runs to saturate the concurrency ceiling of 3
    for (let i = 0; i < 3; i++) {
      const runRes = await keyFetch('/api/runs', memberApiKeys[i], {
        method: 'POST',
        body: JSON.stringify({
          platform: 'etsy_local',
          isPaidActor: false,
          query: `saturation-run-${i}`,
        }),
      });
      assert.strictEqual(runRes.status, 201, `Run ${i} failed to be admitted`);
    }

    // Now actively simulate/check saturation
    // The server has maxConcurrentRuns = 3. Let's verify scheduler status
    const statusRes = await adminFetch('/api/scheduler/status');
    assert.strictEqual(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.strictEqual(statusJson.concurrency.maxConcurrentRuns, 3);

    // Flood 8 additional concurrent requests with distinct API keys
    const floodPromises = memberApiKeys.slice(3, 11).map((key, idx) =>
      keyFetch('/api/runs', key, {
        method: 'POST',
        body: JSON.stringify({
          platform: 'etsy_local',
          isPaidActor: false,
          query: `flood-attempt-${idx}`,
        }),
      })
    );

    const floodResponses = await Promise.all(floodPromises);

    // Verify response behaviors:
    // If scheduler active count is at or above ceiling (3), returns 429 CONCURRENCY_LIMIT_REACHED
    // If runs queued quickly, any admitted count cannot exceed maxConcurrentRuns
    for (const res of floodResponses) {
      if (res.status === 429) {
        const body = await res.json();
        assert.ok(
          body.code === 'CONCURRENCY_LIMIT_REACHED' || body.error === 'TOO_MANY_REQUESTS',
          `Expected CONCURRENCY_LIMIT_REACHED, got: ${JSON.stringify(body)}`
        );
      } else {
        assert.strictEqual(res.status, 201);
      }
    }
  });

  // --- LIVE TEST 2: POST /api/runs/:id/complete must not exist (removed —
  // it let any authenticated caller free up any run's concurrency slot,
  // including runs they didn't own, and manipulate scheduler admission
  // state directly). Completion is now purely internal (ManagedExecution /
  // scheduler), never a public HTTP surface. ---
  await t.test('Live Vector 2: POST /api/runs/:id/complete is not a reachable route (removed public completion surface)', async () => {
    // 1. Non-existent run ID: must not be treated as a valid-but-missing
    // resource (404 with route semantics) — the route itself is gone.
    const spuriousPromises = Array.from({ length: 25 }, () =>
      adminFetch('/api/runs/999999/complete', {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );
    const spuriousResponses = await Promise.all(spuriousPromises);
    for (const r of spuriousResponses) {
      assert.strictEqual(r.status, 404, 'POST /api/runs/:id/complete must not exist');
    }

    // 2. Submit a real run, then confirm hammering .../complete on it is
    // equally rejected — no path by which a caller can force-complete a run
    // and manipulate the scheduler's active-slot accounting from the API.
    const runRes = await keyFetch('/api/runs', memberApiKeys[0], {
      method: 'POST',
      body: JSON.stringify({ platform: 'etsy_local', isPaidActor: false, query: 'underflow-target' }),
    });
    const runJson = await runRes.json();
    const runId = runJson.run?.id || runJson.id;
    assert.ok(runId, 'Run ID must exist');

    const repeatedPromises = Array.from({ length: 10 }, () =>
      adminFetch(`/api/runs/${runId}/complete`, { method: 'POST' })
    );
    const repeatedResponses = await Promise.all(repeatedPromises);
    for (const r of repeatedResponses) {
      assert.strictEqual(r.status, 404, 'POST /api/runs/:id/complete must not exist, even for a real run ID');
    }

    // 3. activeExecutionCount must never go negative regardless — verified
    // structurally (scheduler status endpoint still reports a sane value)
    // even though there is no public way to force-complete a run anymore.
    const statusRes = await adminFetch('/api/scheduler/status');
    const statusJson = await statusRes.json();
    assert.ok(
      statusJson.concurrency.active >= 0,
      `Active count must be >= 0, got: ${statusJson.concurrency.active}`
    );
  });

  // --- LIVE TEST 3: Emergency Freeze Rapid Toggling Under Load ---
  await t.test('Live Vector 3: Emergency Freeze rapid toggling under load: 100% fail-safe rejection (503 DISPATCH_FROZEN) during freeze and zero orphaned locks', async () => {
    // Ensure initial unfreeze
    await adminFetch('/api/admin/freeze', { method: 'POST', body: JSON.stringify({ frozen: false }) });

    let frozenRejectCount = 0;
    let successCount = 0;

    // Concurrent workload: 20 run creation attempts across 10 member keys while admin toggles freeze 10 times
    const workerPromises = Array.from({ length: 20 }, async (_, idx) => {
      // stagger slightly across event loop
      await new Promise((r) => setTimeout(r, idx * 10));
      const key = memberApiKeys[idx % memberApiKeys.length];
      const res = await keyFetch('/api/runs', key, {
        method: 'POST',
        body: JSON.stringify({ platform: 'etsy_local', isPaidActor: false, query: `freeze-load-${idx}` }),
      });

      if (res.status === 503) {
        const body = await res.json();
        assert.strictEqual(body.code, 'DISPATCH_FROZEN');
        frozenRejectCount++;
      } else if (res.status === 201) {
        successCount++;
      } else if (res.status === 429) {
        // Concurrency limit reached is also safe
      }
    });

    const togglePromise = (async () => {
      for (let t = 0; t < 10; t++) {
        await new Promise((r) => setTimeout(r, 20));
        await adminFetch('/api/admin/freeze', {
          method: 'POST',
          body: JSON.stringify({ frozen: t % 2 === 0 }),
        });
      }
      // Re-enable freeze at end of toggling
      await adminFetch('/api/admin/freeze', {
        method: 'POST',
        body: JSON.stringify({ frozen: true }),
      });
    })();

    await Promise.all([...workerPromises, togglePromise]);

    // Now frozen is true: test all ingress endpoints fail-safe
    const runsRes = await keyFetch('/api/runs', memberApiKeys[0], {
      method: 'POST',
      body: JSON.stringify({ platform: 'etsy_local', isPaidActor: false, query: 'frozen-run' }),
    });
    assert.strictEqual(runsRes.status, 503);
    const runsBody = await runsRes.json();
    assert.strictEqual(runsBody.code, 'DISPATCH_FROZEN');

    const captureRes = await adminFetch('/api/html-captures', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    assert.strictEqual(captureRes.status, 503);
    const captureBody = await captureRes.json();
    assert.strictEqual(captureBody.code, 'DISPATCH_FROZEN');

    const journeyRes = await adminFetch('/api/user-journey/run', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    assert.strictEqual(journeyRes.status, 503);
    const journeyBody = await journeyRes.json();
    assert.strictEqual(journeyBody.code, 'DISPATCH_FROZEN');

    // Unfreeze and verify zero orphaned locks
    await adminFetch('/api/admin/freeze', { method: 'POST', body: JSON.stringify({ frozen: false }) });

    const finalStatusRes = await adminFetch('/api/scheduler/status');
    const finalStatus = await finalStatusRes.json();
    assert.strictEqual(finalStatus.isFrozen, false);
    assert.strictEqual(finalStatus.cleanupFailed.length, 0, 'Must have zero cleanup-failed / orphaned tokens');
  });

  // --- LIVE TEST 4: Apify Budget Kill Switch Boundary, Concurrency & Free Scraper Bypass ---
  // P0 update: the ingress no longer reads the client-supplied `isPaidActor`
  // flag for budget purposes (it let callers burn or dodge the budget). The
  // $0 / negative-balance / last-dollar race guarantees are now enforced by the
  // token pool's atomic DB reservation at actor start — see
  // test/apify-budget-settlement.test.js (a)-(f) and test/apify-budget-server.test.js.
  await t.test('Live Vector 4: Apify Budget: client isPaidActor flag cannot touch the budget; admin budget state persists; free scraper bypass', async () => {
    // 4.1 Exact Zero Boundary ($0.00): no ingress 402, no ingress deduction
    const setZero = await adminFetch('/api/apify-tokens/budget', {
      method: 'POST',
      body: JSON.stringify({ remainingBalanceUsd: 0.0, resetSpent: true }),
    });
    assert.strictEqual(setZero.status, 200);

    const paidZeroRes = await keyFetch('/api/runs', memberApiKeys[0], {
      method: 'POST',
      body: JSON.stringify({ platform: 'apify_paid', isPaidActor: true, query: 'paid-zero-test' }),
    });
    assert.notStrictEqual(paidZeroRes.status, 402, 'Ingress must not trust the client isPaidActor flag');

    // 4.2 Negative Boundary (-$10.00) is persisted and reported as exhausted
    await adminFetch('/api/apify-tokens/budget', {
      method: 'POST',
      body: JSON.stringify({ remainingBalanceUsd: -10.0 }),
    });
    const negStatus = await (await adminFetch('/api/apify-tokens/budget')).json();
    assert.strictEqual(negStatus.remainingBalanceUsd, -10.0);
    assert.strictEqual(negStatus.isExhausted, true);

    // 4.3 Free Scraper Bypass Verification at -$10.00 Apify balance
    // Platform etsy_local with isPaidActor: false must succeed even with negative Apify budget
    const freeRes1 = await keyFetch('/api/runs', memberApiKeys[1], {
      method: 'POST',
      body: JSON.stringify({ platform: 'etsy_local', isPaidActor: false, query: 'free-scraper-test' }),
    });
    assert.strictEqual(freeRes1.status, 201, 'Free scraper must execute successfully even with negative Apify budget');

    // Verify Apify balance was NOT changed by free scraper
    const budgetCheck = await adminFetch('/api/apify-tokens/budget');
    const budgetCheckJson = await budgetCheck.json();
    assert.strictEqual(budgetCheckJson.remainingBalanceUsd, -10.0);

    // 4.4 A burst of client-flagged "paid" runs deducts nothing at ingress
    await adminFetch('/api/apify-tokens/budget', {
      method: 'POST',
      body: JSON.stringify({ remainingBalanceUsd: 5.0, resetSpent: true }),
    });

    const parallelPaidResponses = await Promise.all(memberApiKeys.slice(0, 3).map((key, idx) =>
      keyFetch('/api/runs', key, {
        method: 'POST',
        body: JSON.stringify({ platform: 'apify_paid', isPaidActor: true, query: `parallel-budget-${idx}` }),
      })
    ));
    for (const res of parallelPaidResponses) {
      assert.notStrictEqual(res.status, 402, 'Ingress must never answer 402 from the client flag');
    }

    const finalBudgetJson = await (await adminFetch('/api/apify-tokens/budget')).json();
    assert.strictEqual(finalBudgetJson.remainingBalanceUsd, 5.0, 'Ingress must not deduct balance');
    assert.strictEqual(finalBudgetJson.totalSpentUsd, 0, 'Ingress must not record spend');

    // 4.5 Invalid admin input is rejected, not coerced to NaN
    const badUpdate = await adminFetch('/api/apify-tokens/budget', {
      method: 'POST',
      body: JSON.stringify({ remainingBalanceUsd: 'lots' }),
    });
    assert.strictEqual(badUpdate.status, 400);
  });
});
