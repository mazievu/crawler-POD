const test = require('node:test');
const assert = require('node:assert/strict');
const { ResourceMonitor } = require('../src/scheduler/resource-monitor');
const { WorkerPoolManager } = require('../src/scheduler/worker-pool');
const { ResourceScheduler } = require('../src/scheduler/scheduler');
const { ExecutionPlanner } = require('../src/scheduler/execution-planner');
const { planShards, needsSharding, aggregateShardResults, allShardsTerminal } = require('../src/scheduler/job-sharder');
const { registerExecution, markExecutionSettled } = require('../src/reliability/execution-control');
const { assertSystemInvariants } = require('../src/reliability/system-invariants');

test('ResourceMonitor calculates memory and headroom correctly', () => {
  const monitor = new ResourceMonitor({ reservePercent: 20, criticalPercent: 90 });
  const snapshot = monitor.getSnapshot();

  assert.ok(snapshot.totalMB > 0, 'totalMB should be positive');
  assert.ok(snapshot.freeMB >= 0, 'freeMB should be non-negative');
  assert.ok(snapshot.mandatoryReserveMB > 0, 'mandatoryReserveMB should be computed');
  assert.equal(['GREEN', 'YELLOW', 'RED'].includes(snapshot.state), true, 'state should be valid enum');

  const check = monitor.canAdmit(50);
  assert.equal(typeof check.allowed, 'boolean');
});

test('ResourceMonitor enforces red pressure and headroom thresholds', () => {
  const monitor = new ResourceMonitor({ reservePercent: 20, criticalPercent: 90 });
  const hugeCheck = monitor.canAdmit(9999999);
  assert.equal(hugeCheck.allowed, false);
  assert.equal(hugeCheck.reason, 'INSUFFICIENT_RAM_HEADROOM');
});

test('ResourceMonitor commits reservations so concurrent admits cannot over-commit RAM', () => {
  const monitor = new ResourceMonitor({
    fixedPhysicalSnapshot: {
      timestamp: new Date().toISOString(), state: 'GREEN', totalMB: 16000, usedMB: 8000, freeMB: 8000,
      usedPercent: 50, mandatoryReserveMB: 3000, usableHeadroomMB: 5000, process: { rssMB: 100, heapUsedMB: 50 }
    }
  });

  assert.equal(monitor.canAdmit(2000).allowed, true);
  monitor.reserve('tokenA', 2000);
  assert.equal(monitor.canAdmit(2000).allowed, true);
  monitor.reserve('tokenB', 2000);

  const c = monitor.canAdmit(2000);
  assert.equal(c.allowed, false);
  assert.equal(c.effectiveHeadroomMB, 1000);

  monitor.release('tokenA');
  assert.equal(monitor.canAdmit(2000).allowed, true);
});

test('WorkerPoolManager ownership is keyed by executionToken, not runId — a retried attempt cannot release a sibling attempt (attempt-ownership requirement)', () => {
  const wp = new WorkerPoolManager({ localConcurrency: 1, cdpConcurrency: 1 });

  assert.equal(wp.acquireSlot('LOCAL', 'run50-attemptA'), true);
  assert.equal(wp.acquireLock('cdp:9222', 'run50-attemptA'), true);

  assert.equal(wp.hasSlot('LOCAL'), false);
  assert.equal(wp.acquireLock('cdp:9222', 'run50-attemptB'), false, 'B must not be able to steal the lock while A still holds it');

  wp.releaseAllForToken('run50-attemptA');
  assert.equal(wp.hasSlot('LOCAL'), true);
  assert.equal(wp.acquireLock('cdp:9222', 'run50-attemptB'), true, 'B can now acquire since A released only its own lock');

  assert.equal(wp.acquireSlot('LOCAL', 'run50-attemptB'), true);
  wp.releaseAllForToken('run50-attemptA'); // no-op: A holds nothing anymore
  assert.equal(wp.hasSlot('LOCAL'), false, 'B still holds the slot after a stale release-for-A call');
});

test('ExecutionPlanner produces a request-specific plan from the CURRENT request only, never from history (no resource-profile dependency)', async () => {
  const fakeRouter = { selectBackend: async () => ({ adapter: {}, config: { kind: 'local', name: 'local-scraper' } }) };
  const planner = new ExecutionPlanner({ router: fakeRouter });

  const smallRequest = await planner.plan({ platform: 'etsy', input_options: JSON.stringify({ maxItems: 20 }) });
  const largeRequest = await planner.plan({ platform: 'etsy', input_options: JSON.stringify({ maxItems: 1000, imageEnrichment: true, internalConcurrency: 3 }) });

  assert.equal(smallRequest.confidence, 'STATIC_ENVELOPE');
  assert.equal(largeRequest.confidence, 'STATIC_ENVELOPE');
  assert.ok(largeRequest.estimatedEnvelopeMB > smallRequest.estimatedEnvelopeMB * 2, 'Large/heavy request must get a materially larger envelope than a small one, computed from ITS OWN shape');
  // Etsy has no real partition strategy declared (Live-Readiness Round #4) -> never sharded, regardless of maxItems.
  assert.equal(largeRequest.shardCount, 1, 'Etsy has no declared partition strategy: must NOT be sharded even at maxItems=1000');
  assert.equal(smallRequest.shardCount, 1);

  const fallbackAware = await planner.plan({ platform: 'etsy', input_options: JSON.stringify({ maxItems: 20, browserFallbackPossible: true }) });
  assert.ok(fallbackAware.estimatedEnvelopeMB >= planner.classEnvelopes.BROWSER, 'browserFallbackPossible must budget the worst case up front, not escalate silently later');
});

// §17/§20.N mandatory: SMALL (maxItems<=20, the typical production request)
// must never be budgeted BELOW the configured per-class safety envelope.
test('ExecutionPlanner never reduces the SMALL workload band below the class safety baseline (#17)', async () => {
  const fakeRouter = { selectBackend: async () => ({ adapter: {}, config: { kind: 'local', name: 'local-scraper' } }) };
  const planner = new ExecutionPlanner({ router: fakeRouter });

  const tinyRequest = await planner.plan({ platform: 'etsy', input_options: JSON.stringify({ maxItems: 5 }) });
  const typicalSmallRequest = await planner.plan({ platform: 'etsy', input_options: JSON.stringify({ maxItems: 20 }) });
  const baselineMB = planner.classEnvelopes.LOCAL_HTTP;

  assert.equal(tinyRequest.estimatedEnvelopeMB, baselineMB, 'maxItems=5 must sit at exactly the class baseline, not below it');
  assert.equal(typicalSmallRequest.estimatedEnvelopeMB, baselineMB, 'maxItems=20 (the SMALL band boundary) must sit at exactly the class baseline');

  // MEDIUM/LARGE/VERY_LARGE must scale UP from that same baseline, never down.
  const mediumRequest = await planner.plan({ platform: 'etsy', input_options: JSON.stringify({ maxItems: 100 }) });
  const largeRequest = await planner.plan({ platform: 'etsy', input_options: JSON.stringify({ maxItems: 500 }) });
  assert.ok(mediumRequest.estimatedEnvelopeMB > baselineMB, 'MEDIUM must exceed the SMALL baseline');
  assert.ok(largeRequest.estimatedEnvelopeMB > mediumRequest.estimatedEnvelopeMB, 'LARGE must exceed MEDIUM');
});

// Live-Readiness Round #4 acceptance: sharding only happens when the channel
// declares a REAL partition strategy — never as a default assumption.
test('ExecutionPlanner only shards when the channel declares a real partition strategy (capability-aware sharding)', async () => {
  const fakeRouter = { selectBackend: async () => ({ adapter: {}, config: { kind: 'local', name: 'local-scraper' } }) };
  const planner = new ExecutionPlanner({ router: fakeRouter });

  // A channel with no declared partitionStrategy must never be split, even at very large maxItems.
  const noPartition = await planner.plan({ platform: 'shopify', input_options: JSON.stringify({ maxItems: 1000 }) });
  assert.equal(noPartition.shardCount, 1, 'shopify has no declared partition strategy -> must not be sharded');

  // Toidispy (CDP) explicitly does not consume offset/maxItems as a partition -> never sharded.
  const toidispy = await planner.plan({ platform: 'toidispy', input_options: JSON.stringify({ maxItems: 100 }) });
  assert.equal(toidispy.shardCount, 1, 'Toidispy must execute maxItems=100 as exactly one CDP execution, never 5 fake shards');

  // Simulate a channel that DOES declare a real partition strategy: sharding should now engage.
  planner.channelSupportsSharding = () => true;
  const withPartition = await planner.plan({ platform: 'etsy', input_options: JSON.stringify({ maxItems: 1000, shardSize: 200 }) });
  assert.equal(withPartition.shardCount, 5, 'When a real partition strategy is declared, sharding must engage correctly');
});

test('ExecutionPlanner maps non-channel job kinds (user_journey, marketplace_capture) to a static BROWSER plan without calling the router', async () => {
  const routerThatMustNotBeCalled = { selectBackend: async () => { throw new Error('should not be called for non-channel jobs'); } };
  const planner = new ExecutionPlanner({ router: routerThatMustNotBeCalled });

  const plan = await planner.plan({ platform: 'user-journey', input_options: JSON.stringify({ jobKind: 'user_journey', maxItems: 1 }) });
  assert.equal(plan.executionClass, 'BROWSER');
  assert.equal(plan.pool, 'BROWSER');
});

test('LargeJobSharder splits an oversized request into bounded shards and aggregates their results', () => {
  const plan = { maxItems: 250, shardSize: 100 };
  const shards = planShards({}, plan);
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.map(s => s.maxItems), [100, 100, 50]);
  assert.equal(needsSharding({ shardCount: 3 }), true);
  assert.equal(needsSharding({ shardCount: 1 }), false);

  const children = [
    { status: 'done', items_count: 90, new_count: 10, active_count: 80, dropped_count: 0 },
    { status: 'done', items_count: 95, new_count: 5, active_count: 90, dropped_count: 0 },
    { status: 'failed', items_count: 0, new_count: 0, active_count: 0, dropped_count: 0 }
  ];
  assert.equal(allShardsTerminal(children), true);
  const summary = aggregateShardResults(children);
  assert.equal(summary.itemsCount, 185);
  assert.equal(summary.doneShards, 2);
  assert.equal(summary.failedShards, 1);
});

function makeMockDb() {
  const runs = new Map();
  let nextId = 1;
  return {
    createRun: (payload) => {
      const id = nextId++;
      const run = { id, platform: payload.platform, query: payload.query, status: 'pending', max_items: payload.maxItems, input_options: JSON.stringify(payload.options || {}), parent_run_id: payload.parentRunId || null, created_at: new Date().toISOString(), items_count: 0, new_count: 0, active_count: 0, dropped_count: 0 };
      runs.set(id, run);
      return run;
    },
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => {
      const run = runs.get(id);
      if (!run) return;
      for (const [k, v] of Object.entries(updates)) {
        if (k === 'inputOptions') run.input_options = v;
        else if (k === 'itemsCount') run.items_count = v;
        else if (k === 'newCount') run.new_count = v;
        else if (k === 'activeCount') run.active_count = v;
        else if (k === 'droppedCount') run.dropped_count = v;
        else if (k === 'errorMessage') run.error_message = v;
        else run[k] = v;
      }
    },
    getAllRuns: () => Array.from(runs.values()),
    getRunsByStatus: (status) => Array.from(runs.values()).filter(r => r.status === status),
    getChildRuns: (parentId) => Array.from(runs.values()).filter(r => r.parent_run_id === parentId)
  };
}

test('ResourceScheduler admits jobs within capacity and queues overflow', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = { plan: async (run) => ({ platform: run.platform, backend: 'local', mode: 'default', pool: 'LOCAL', estimatedEnvelopeMB: 50, shardCount: 1, jobKind: 'channel', options: JSON.parse(run.input_options || '{}') }) };

  const executed = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 2, elasticPools: [] },
    planner: fakePlanner,
    executeRun: async (runId) => {
      executed.push(runId);
      await new Promise(resolve => setTimeout(resolve, 50));
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  await scheduler.submitRun({ platform: 'shopify', query: 'shop1.com' });
  await scheduler.submitRun({ platform: 'shopify', query: 'shop2.com' });
  await scheduler.submitRun({ platform: 'shopify', query: 'shop3.com' });
  await scheduler.submitRun({ platform: 'shopify', query: 'shop4.com' });

  await scheduler.tick();
  const status1 = await scheduler.getStatus();
  assert.ok(status1.pools.pools.LOCAL.running <= 2, 'Should not exceed local concurrency 2');

  await new Promise(resolve => setTimeout(resolve, 250));
  await scheduler.tick();
  assert.equal(executed.length >= 2, true, 'At least 2 jobs should have executed');
});

// §1.3/§15.C mandatory scenario: an execution that "settles" at the
// ManagedExecution layer (e.g. a timeout rejection) but whose real work is
// still registered as unsettled in the Execution Control Registry must keep
// holding its worker slot — Attempt B must not be dispatched into it until
// the registry confirms real settlement.
test('ResourceScheduler does not dispatch Attempt B into the same slot until Execution Control confirms A settled (#1.3/§15.C)', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = { plan: async (run) => ({ platform: run.platform, backend: 'local', mode: 'default', pool: 'LOCAL', estimatedEnvelopeMB: 50, shardCount: 1, jobKind: 'channel', options: JSON.parse(run.input_options || '{}') }) };

  let capturedTokenA = null;
  const dispatchedRunIds = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 1, elasticPools: [] }, // only 1 slot — B can only run if A's slot is actually freed
    planner: fakePlanner,
    resourceReleaseGraceMs: 2000,
    executeRun: async (runId, platform, query, options) => {
      dispatchedRunIds.push(runId);
      if (!capturedTokenA) {
        capturedTokenA = options.executionToken;
        // Simulate ManagedExecution: registers with the Execution Control
        // Registry, then "times out" (rejects) WITHOUT the real work having
        // actually settled yet — exactly the gap this round closes.
        registerExecution(capturedTokenA, new AbortController());
        throw new Error('SIMULATED_MANAGED_EXECUTION_TIMEOUT');
      }
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  await scheduler.submitRun({ platform: 'shopify', query: 'A' });
  await scheduler.tick(); // admits + dispatches A into the only LOCAL slot; executeRun rejects almost immediately

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(scheduler.pools.getStatus().pools.LOCAL.running, 1, 'The slot must still show as held — A has not been confirmed settled yet');

  await scheduler.submitRun({ platform: 'shopify', query: 'B' });
  await scheduler.tick();
  assert.equal(dispatchedRunIds.length, 1, 'B must NOT be dispatched while the only LOCAL slot is still (apparently) held by A');

  // Now the real work actually finishes.
  markExecutionSettled(capturedTokenA);
  await new Promise((r) => setTimeout(r, 80)); // let the awaited waitForSettled()+release()+retick complete
  await scheduler.tick();

  assert.equal(dispatchedRunIds.length, 2, 'B must be dispatched now that A has confirmed settlement and the slot was actually released');
});

// §5/§15.E mandatory scenario (Final Architecture Closure Round): if A's real
// work NEVER confirms settlement (waitForSettled keeps timing out), the
// Scheduler must NOT fake-release A's slot/RAM/lock and must NOT dispatch a
// retried Attempt B onto that resource. Only once settlement is confirmed
// (however late) may the resource be released and B admitted.
test('ResourceScheduler does not release or double-allocate a resource when Attempt A never confirms settlement (#5/§15.E)', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = { plan: async (run) => ({ platform: run.platform, backend: 'local', mode: 'default', pool: 'LOCAL', estimatedEnvelopeMB: 50, shardCount: 1, jobKind: 'channel', options: JSON.parse(run.input_options || '{}') }) };

  let capturedTokenA = null;
  const dispatchedRunIds = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 1, elasticPools: [] }, // only 1 slot
    planner: fakePlanner,
    resourceReleaseGraceMs: 30, // short grace so the test runs fast
    executeRun: async (runId, platform, query, options) => {
      dispatchedRunIds.push(runId);
      if (!capturedTokenA) {
        capturedTokenA = options.executionToken;
        registerExecution(capturedTokenA, new AbortController());
        // A "rejects" (e.g. a ManagedExecution timeout) but NEVER calls
        // markExecutionSettled — simulates real work that truly never stops.
        throw new Error('SIMULATED_NEVER_SETTLES');
      }
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  await scheduler.submitRun({ platform: 'shopify', query: 'A' });
  await scheduler.tick(); // admits + dispatches A; executeRun rejects almost immediately

  // Wait well past the grace period — A still never settles.
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(scheduler.pools.getStatus().pools.LOCAL.running, 1, 'A\'s slot must remain held — no fake release when settlement was never confirmed');
  assert.equal(scheduler.cleanupFailedTokens.has(capturedTokenA), true, 'The unsettled token must be recorded as RECOVERY_CLEANUP_FAILED for honest resource accounting');

  await scheduler.submitRun({ platform: 'shopify', query: 'B' });
  await scheduler.tick();
  assert.equal(dispatchedRunIds.length, 1, 'B must NOT be dispatched onto a resource A may still physically hold');

  // A finally, late, confirms real settlement.
  markExecutionSettled(capturedTokenA);
  await new Promise((r) => setTimeout(r, 100)); // let the pending waitForSettled()+release()+retick complete
  await scheduler.tick();

  assert.equal(scheduler.cleanupFailedTokens.has(capturedTokenA), false, 'Once settled, the cleanup-failed record must be cleared');
  assert.equal(dispatchedRunIds.length, 2, 'B may now be dispatched since the resource was honestly released only after confirmed settlement');
});

// §13 mandatory scenario: no-orphan invariant must hold both while a
// cleanup-failed resource is honestly retained AND once it settles/releases.
test('assertSystemInvariants reports no orphans while a resource is held pending settlement, and after release (#13)', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = { plan: async (run) => ({ platform: run.platform, backend: 'local', mode: 'default', pool: 'LOCAL', estimatedEnvelopeMB: 50, shardCount: 1, jobKind: 'channel', options: JSON.parse(run.input_options || '{}') }) };

  let capturedToken = null;
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 1, elasticPools: [] },
    planner: fakePlanner,
    resourceReleaseGraceMs: 30,
    executeRun: async (runId, platform, query, options) => {
      capturedToken = options.executionToken;
      registerExecution(capturedToken, new AbortController());
      throw new Error('SIMULATED_NEVER_SETTLES');
    }
  });

  await scheduler.submitRun({ platform: 'shopify', query: 'A' });
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 100)); // past the grace period: now cleanup-failed

  const whileHeld = assertSystemInvariants(scheduler);
  assert.equal(whileHeld.ok, true, `No orphans expected while honestly retained: ${JSON.stringify(whileHeld.violations)}`);

  markExecutionSettled(capturedToken);
  await new Promise((r) => setTimeout(r, 80)); // let the pending release complete

  const afterRelease = assertSystemInvariants(scheduler);
  assert.equal(afterRelease.ok, true, `No orphans expected after release: ${JSON.stringify(afterRelease.violations)}`);
  assert.equal(scheduler.pools.getStatus().pools.LOCAL.running, 0, 'Slot must actually be free after settlement');
});

// Gap #1 mandatory regression (Final Gap Closure Round): with pool
// concurrency >= 2, a stuck-recovery-style requeue of the SAME runId must
// NOT be admitted into a second free slot while Attempt A (never settled)
// still occupies the first. Proves the admission-time runId gate (Layer 2)
// closes the multi-slot race that concurrency=1 tests could never expose.
test('ResourceScheduler does not admit a same-runId retry into a second free slot while an earlier attempt is unsettled (#1, multi-slot)', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = { plan: async (run) => ({ platform: run.platform, backend: 'local', mode: 'default', pool: 'LOCAL', estimatedEnvelopeMB: 50, shardCount: 1, jobKind: 'channel', options: JSON.parse(run.input_options || '{}') }) };

  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 2 }, // >1 slot — the exact scenario the prior round's test could not expose
    planner: fakePlanner,
    resourceReleaseGraceMs: 10000,
    executeRun: async (runId, platform, query, options) => {
      dispatched.push({ runId, attempt: options.attempt, token: options.executionToken });
      if (options.attempt === 1) {
        registerExecution(options.executionToken, new AbortController());
        return new Promise(() => {}); // never settles — the "A truly stuck" case
      }
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  const run = await scheduler.submitRun({ platform: 'shopify', query: 'gap1-multi-slot' });
  await scheduler.tick(); // dispatches Attempt A into slot #1; A never resolves.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(scheduler.pools.getStatus().pools.LOCAL.running, 1, 'A must be holding exactly one slot');

  // Exactly what StuckDetector.recoverExecution() must NEVER do unconditionally
  // (this simulates the pre-fix behavior directly at the DB layer, bypassing
  // the now-fixed StuckDetector, to prove the Scheduler's OWN admission gate
  // — Layer 2 — is what actually stops B, independent of the caller).
  mockDb.updateRun(run.id, {
    status: 'queued',
    inputOptions: JSON.stringify({ attempt: 2, executionToken: 'forced-token-b' })
  });

  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(dispatched.some((d) => d.attempt === 2), false, 'Attempt B must NOT be dispatched into slot #2 while Attempt A (same runId) is unsettled');
  assert.equal(scheduler.pools.getStatus().pools.LOCAL.running, 1, 'Only A\'s slot may be occupied — no second slot given to the same runId');
});

test('ResourceScheduler releases RAM reservation on completion (no leak) and shards a large request', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = new ExecutionPlanner({ router: { selectBackend: async () => ({ adapter: {}, config: { kind: 'local', name: 'local-scraper' } }) } });
  // This test exercises the scheduler's shard-dispatch/aggregation mechanics,
  // not capability declarations (covered separately) — force sharding on.
  fakePlanner.channelSupportsSharding = () => true;

  const executedShards = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 4 },
    planner: fakePlanner,
    executeRun: async (runId) => { executedShards.push(runId); mockDb.updateRun(runId, { status: 'done', itemsCount: 10 }); }
  });

  const parent = await scheduler.submitRun({ platform: 'shopify', query: 'shop1.com', options: { maxItems: 250, shardSize: 100 } });
  await scheduler.tick(); // shards the parent
  const parentAfterShard = mockDb.getRunById(parent.id);
  assert.equal(parentAfterShard.status, 'sharded');
  const children = mockDb.getChildRuns(parent.id);
  assert.equal(children.length, 3);

  await scheduler.tick(); // admits + dispatches shards
  await new Promise(resolve => setTimeout(resolve, 50));
  await scheduler.tick(); // reconciles

  assert.equal(scheduler.monitor.getReservedTotalMB(), 0, 'Reservation must be released after all shards complete');
  const parentFinal = mockDb.getRunById(parent.id);
  assert.equal(parentFinal.status, 'done');
  assert.equal(parentFinal.items_count, 30, '3 shards x 10 items aggregated onto the parent');
});

// Gap #4 mandatory test (Final Small-Gap Closure Round): Scheduler blocks
// Apify retry admission while the old remote Actor run is still active (RUNNING),
// and allows admission once that actor reaches a terminal status (SUCCEEDED).
test('ResourceScheduler blocks retry while old remote Apify actor is RUNNING and admits once terminal (Gap #4)', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = {
    plan: async (run) => ({
      platform: run.platform,
      backend: 'apify',
      mode: 'default',
      pool: 'LOCAL',
      estimatedEnvelopeMB: 50,
      shardCount: 1,
      jobKind: 'channel',
      options: JSON.parse(run.input_options || '{}')
    })
  };

  let remoteActorStatus = 'RUNNING';
  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 2 },
    planner: fakePlanner,
    getApifyRunStatus: async (_actorRunId) => remoteActorStatus,
    executeRun: async (runId) => {
      dispatched.push(runId);
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  // Create a run that was previously attempted and recorded an Apify externalExecutionId
  const run = mockDb.createRun({
    platform: 'amazon',
    query: 'shoes',
    options: { attempt: 2 }
  });
  mockDb.updateRun(run.id, {
    status: 'pending',
    external_execution_json: JSON.stringify({ executionClass: 'CLOUD_API', externalExecutionId: 'actor-run-123' })
  });

  // Tick while old remote actor is still RUNNING -> B must NOT be admitted
  await scheduler.tick();
  assert.equal(dispatched.length, 0, 'Attempt B must not be dispatched while remote actor-run-123 is RUNNING');

  // Now old remote actor reaches terminal status SUCCEEDED -> tick -> B is admitted
  remoteActorStatus = 'SUCCEEDED';
  await scheduler.tick();
  await new Promise(r => setTimeout(r, 20));

  assert.equal(dispatched.length, 1, 'Attempt B must be admitted once remote actor is terminal');
  assert.equal(dispatched[0], run.id);
});

// ==================== BUG-SCHED-ELASTIC-01 Elastic Burst Tests ====================

test('ResourceScheduler allows LOCAL pool to burst beyond baseline when RAM is sufficient (BUG-SCHED-ELASTIC-01)', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = {
    plan: async (run) => ({
      platform: run.platform,
      backend: 'local',
      mode: 'default',
      pool: 'LOCAL',
      estimatedEnvelopeMB: 100,
      shardCount: 1,
      jobKind: 'channel',
      options: JSON.parse(run.input_options || '{}')
    })
  };

  const monitor = new ResourceMonitor({
    fixedPhysicalSnapshot: {
      timestamp: new Date().toISOString(), state: 'GREEN', totalMB: 32000, usedMB: 8000, freeMB: 24000,
      usedPercent: 25, mandatoryReserveMB: 6400, usableHeadroomMB: 17600, process: { rssMB: 100, heapUsedMB: 50 }
    }
  });

  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    monitor,
    planner: fakePlanner,
    executeRun: async (runId) => {
      dispatched.push(runId);
      // Keep running during the test
      await new Promise(resolve => setTimeout(resolve, 500));
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  // Submit 10 LOCAL runs (baseline is 4)
  for (let i = 1; i <= 10; i++) {
    await scheduler.submitRun({ platform: 'shopify', query: `shop_${i}.com` });
  }

  await scheduler.tick();
  assert.equal(dispatched.length, 10, 'All 10 LOCAL runs must be admitted and dispatched concurrently when RAM is plentiful (>4 baseline)');
  assert.equal(scheduler.pools.getStatus().pools.LOCAL.running, 10);
  assert.equal(scheduler.monitor.getReservedTotalMB(), 1000);
});

test('ResourceScheduler stops admission and queues overflow when RAM headroom is exhausted (BUG-SCHED-ELASTIC-01)', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = {
    plan: async (run) => ({
      platform: run.platform,
      backend: 'local',
      mode: 'default',
      pool: 'LOCAL',
      estimatedEnvelopeMB: 500, // 500MB per run
      shardCount: 1,
      jobKind: 'channel',
      options: JSON.parse(run.input_options || '{}')
    })
  };

  // Usable headroom = 1200MB -> can only fit 2 runs (1000MB), 3rd run (needs 500MB, remaining 200MB) must be blocked
  const monitor = new ResourceMonitor({
    fixedPhysicalSnapshot: {
      timestamp: new Date().toISOString(), state: 'GREEN', totalMB: 10000, usedMB: 5000, freeMB: 5000,
      usedPercent: 50, mandatoryReserveMB: 3800, usableHeadroomMB: 1200, process: { rssMB: 100, heapUsedMB: 50 }
    }
  });

  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    monitor,
    planner: fakePlanner,
    executeRun: async (runId) => {
      dispatched.push(runId);
      await new Promise(resolve => setTimeout(resolve, 500));
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  await scheduler.submitRun({ platform: 'shopify', query: 'shop_1.com' });
  await scheduler.submitRun({ platform: 'shopify', query: 'shop_2.com' });
  await scheduler.submitRun({ platform: 'shopify', query: 'shop_3.com' });
  await scheduler.submitRun({ platform: 'shopify', query: 'shop_4.com' });

  await scheduler.tick();
  assert.equal(dispatched.length, 2, 'Exactly 2 runs should be admitted (1000MB <= 1200MB); 3rd and 4th must be queued due to RAM check');
  assert.equal((await scheduler.queue.countByStatus()).queued, 2);
  assert.equal((await scheduler.queue.countByStatus()).running, 2);
});

test('ResourceScheduler allows BROWSER pool to burst beyond baseline when RAM is sufficient (BUG-SCHED-ELASTIC-01)', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = {
    plan: async (run) => ({
      platform: run.platform,
      backend: 'browser',
      mode: 'default',
      pool: 'BROWSER',
      estimatedEnvelopeMB: 400,
      shardCount: 1,
      jobKind: 'channel',
      options: JSON.parse(run.input_options || '{}')
    })
  };

  const monitor = new ResourceMonitor({
    fixedPhysicalSnapshot: {
      timestamp: new Date().toISOString(), state: 'GREEN', totalMB: 32000, usedMB: 8000, freeMB: 24000,
      usedPercent: 25, mandatoryReserveMB: 6400, usableHeadroomMB: 17600, process: { rssMB: 100, heapUsedMB: 50 }
    }
  });

  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    monitor,
    planner: fakePlanner,
    executeRun: async (runId) => {
      dispatched.push(runId);
      await new Promise(resolve => setTimeout(resolve, 500));
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  // Submit 3 BROWSER runs (baseline is 2)
  await scheduler.submitRun({ platform: 'amazon', query: 'b1' });
  await scheduler.submitRun({ platform: 'amazon', query: 'b2' });
  await scheduler.submitRun({ platform: 'amazon', query: 'b3' });

  await scheduler.tick();
  assert.equal(dispatched.length, 3, 'All 3 BROWSER runs should be admitted and dispatched concurrently (>2 baseline)');
  assert.equal(scheduler.pools.getStatus().pools.BROWSER.running, 3);
});

test('ResourceScheduler strictly enforces CDP=1 capacity even with high RAM (BUG-SCHED-ELASTIC-01)', async () => {
  const mockDb = makeMockDb();
  const fakePlanner = {
    plan: async (run) => ({
      platform: run.platform,
      backend: 'cdp',
      mode: 'default',
      pool: 'CDP',
      estimatedEnvelopeMB: 400,
      shardCount: 1,
      jobKind: 'channel',
      options: JSON.parse(run.input_options || '{}')
    })
  };

  const monitor = new ResourceMonitor({
    fixedPhysicalSnapshot: {
      timestamp: new Date().toISOString(), state: 'GREEN', totalMB: 32000, usedMB: 8000, freeMB: 24000,
      usedPercent: 25, mandatoryReserveMB: 6400, usableHeadroomMB: 17600, process: { rssMB: 100, heapUsedMB: 50 }
    }
  });

  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    monitor,
    planner: fakePlanner,
    executeRun: async (runId) => {
      dispatched.push(runId);
      await new Promise(resolve => setTimeout(resolve, 500));
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  // Submit 2 CDP runs
  await scheduler.submitRun({ platform: 'toidispy', query: 'c1' });
  await scheduler.submitRun({ platform: 'toidispy', query: 'c2' });

  await scheduler.tick();
  assert.equal(dispatched.length, 1, 'Only 1 CDP run may be admitted at a time');
  assert.equal(scheduler.pools.getStatus().pools.CDP.running, 1);
  assert.equal((await scheduler.queue.countByStatus()).queued, 1);
});

