const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { RetryPolicy } = require('../src/reliability/retry-policy');
const { HeartbeatTracker, STAGES, getOrCreateTracker, removeTracker, getActiveHeartbeats } = require('../src/reliability/heartbeat');
const { StuckDetector } = require('../src/reliability/stuck-detector');
const { recoverOrphanedRuns } = require('../src/reliability/restart-recovery');
const { issueExecutionToken, isCurrentOwner } = require('../src/reliability/execution-lease');
const { runManaged } = require('../src/reliability/managed-execution');
const { registerExecution, abortExecution, waitForSettled } = require('../src/reliability/execution-control');
const realDb = require('../src/database');

// Live-Readiness Round #10 acceptance: Attempt A and Attempt B for the SAME
// runId must coexist as fully distinct heartbeat trackers (keyed by
// executionToken, not runId). A finishing/removing itself must never touch B.
test('Heartbeat ownership is executionToken-based: Attempt A cannot remove or overwrite Attempt B for the same runId (#10)', () => {
  const mockDb = { updateRun: () => {} };
  const runId = 777;
  const tokenA = 'run777-attemptA';
  const tokenB = 'run777-attemptB';

  const trackerA = getOrCreateTracker(runId, mockDb, { executionToken: tokenA, attempt: 1, executionClass: 'LOCAL_HTTP' });
  const trackerB = getOrCreateTracker(runId, mockDb, { executionToken: tokenB, attempt: 2, executionClass: 'LOCAL_HTTP' });

  assert.notEqual(trackerA, trackerB, 'Attempt A and Attempt B must be distinct tracker instances despite sharing runId');

  trackerB.progress(50, { note: 'B is making progress' });
  const activeBefore = getActiveHeartbeats();
  assert.ok(activeBefore.some(hb => hb.executionToken === tokenA && hb.runId === runId));
  assert.ok(activeBefore.some(hb => hb.executionToken === tokenB && hb.itemsCollected === 50));

  // A (stale) finishes late and removes itself.
  removeTracker(tokenA);

  const activeAfter = getActiveHeartbeats();
  assert.equal(activeAfter.some(hb => hb.executionToken === tokenA), false, 'A\'s tracker must be gone');
  const bAfter = activeAfter.find(hb => hb.executionToken === tokenB);
  assert.ok(bAfter, 'B\'s tracker must be untouched by A\'s removal');
  assert.equal(bAfter.itemsCollected, 50, 'B\'s progress must be unaffected by A\'s cleanup');

  removeTracker(tokenB); // cleanup
});

// P0-8 acceptance: a stuck attempt (A) that wakes up AFTER recovery has already
// issued a new attempt (B) must not be allowed to write results as if it still
// owned the run.
test('Execution lease prevents a stale (revoked) attempt from overwriting a newer attempt (P0-8)', () => {
  const runs = new Map();
  runs.set(1, { id: 1, status: 'running', input_options: JSON.stringify({ attempt: 1, executionToken: 'token-A' }) });
  const mockDb = {
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => {
      const r = runs.get(id);
      if (updates.status !== undefined) r.status = updates.status;
      if (updates.inputOptions !== undefined) r.input_options = updates.inputOptions;
    }
  };

  // Attempt A is confirmed as the current owner while it is still the only attempt.
  assert.equal(isCurrentOwner(mockDb, 1, 'token-A'), true);

  // Recovery revokes A and issues token B for attempt 2.
  const tokenB = issueExecutionToken(1, 2);
  mockDb.updateRun(1, { status: 'queued', inputOptions: JSON.stringify({ attempt: 2, executionToken: tokenB }) });

  // A wakes up late and checks ownership before writing its stale result: must be false now.
  assert.equal(isCurrentOwner(mockDb, 1, 'token-A'), false, 'Stale attempt A must no longer be recognized as the owner');
  // B is the current owner and may write.
  assert.equal(isCurrentOwner(mockDb, 1, tokenB), true, 'Attempt B must be the current owner');
});

test('RetryPolicy accurately classifies retryable and fatal errors', () => {
  const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 1000 });

  assert.equal(policy.isRetryable(new Error('ETIMEDOUT: Connection timed out')), true);
  assert.equal(policy.isRetryable(new Error('HTTP 429 Too Many Requests')), true);
  assert.equal(policy.isRetryable(new Error('socket hang up')), true);
  assert.equal(policy.isRetryable(new Error('Browser disconnected unexpectedly')), true);

  assert.equal(policy.isRetryable(new Error('INVALID_INPUT: keyword is required')), false);
  assert.equal(policy.isRetryable(new Error('AUTH_REQUIRED: API token missing')), false);
  assert.equal(policy.isRetryable(new Error('UNKNOWN_PLATFORM: unsupported')), false);

  assert.equal(policy.shouldRetry(1, new Error('ETIMEDOUT')), true);
  assert.equal(policy.shouldRetry(3, new Error('ETIMEDOUT')), false); // exhausted
});

test('HeartbeatTracker records progress and transitions stages cleanly', () => {
  const mockDb = { updateRun: () => {} };
  const tracker = new HeartbeatTracker(999, mockDb);

  assert.equal(tracker.stage, STAGES.INIT);
  tracker.setStage(STAGES.SCRAPING);
  assert.equal(tracker.stage, STAGES.SCRAPING);

  tracker.progress(25);
  const snap = tracker.getSnapshot();
  assert.equal(snap.runId, 999);
  assert.equal(snap.itemsCollected, 25);
  assert.equal(snap.stage, STAGES.SCRAPING);
});

// Final Stabilization Round #7 mandatory test: a workFn that ignores
// AbortSignal must still cause runManaged() to reject around timeoutMs, not
// after the workFn's own (much longer) sleep.
test('ManagedExecution enforces a real wall-clock timeout even when workFn ignores AbortSignal (#7)', async () => {
  const runs = new Map();
  runs.set(42, { id: 42, status: 'running', input_options: JSON.stringify({ attempt: 1, executionToken: 'tok-42' }) });
  const mockDb = {
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => { const r = runs.get(id); if (r) Object.assign(r, updates); }
  };

  const ignoresAbort = () => new Promise((resolve) => setTimeout(() => resolve('too-late'), 500));

  const start = Date.now();
  await assert.rejects(
    () => runManaged(42, { database: mockDb, executionToken: 'tok-42', attempt: 1, timeoutMs: 50 }, ignoresAbort),
    /MANAGED_EXECUTION_TIMEOUT/
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 400, `Expected rejection near 50ms, took ${elapsed}ms (workFn's 500ms sleep must not have been awaited)`);
});

// Final Stabilization Round #10 mandatory test: a stale attempt A must not be
// able to overwrite attempt B's heartbeat DB row after B becomes the owner.
test('HeartbeatTracker.persist() refuses to write once its executionToken is no longer the current owner (#10)', () => {
  const runs = new Map();
  runs.set(55, { id: 55, status: 'running', input_options: JSON.stringify({ attempt: 2, executionToken: 'tok-B' }) });
  const writes = [];
  const mockDb = {
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => { writes.push(updates); const r = runs.get(id); if (r && updates.healthSnapshot) r.health_snapshot = updates.healthSnapshot; }
  };

  // Attempt A holds a stale token — the DB row already shows B as current owner.
  const trackerA = new HeartbeatTracker(55, mockDb, { executionToken: 'tok-A', attempt: 1 });
  writes.length = 0; // clear the constructor-triggered writes, if any
  trackerA.progress(10, { note: 'stale A trying to write' });

  assert.equal(writes.length, 0, 'Stale attempt A must not persist any heartbeat write once B owns the run');

  trackerA.stop();
});

// Final Implementation Closure §2 mandatory regression: a heartbeat/progress
// update (still status='running') must never stamp completed_at — only an
// actual terminal transition (done/failed/stuck/...) may.
test('db.updateRun() only stamps completed_at on a terminal status transition, never on a running heartbeat (#2)', () => {
  const created = realDb.createRun({ platform: 'shopify', query: 'db-completed-at-test-' + Date.now(), maxItems: 5 });
  try {
    realDb.updateRun(created.id, { status: 'running', healthSnapshot: JSON.stringify({ stage: 'SCRAPING' }) });
    let row = realDb.getRunById(created.id);
    assert.equal(row.status, 'running');
    assert.equal(row.completed_at, null, 'A running Run must not have completed_at set by a heartbeat update');

    // Simulate several more heartbeat beats — still must not set completed_at.
    realDb.updateRun(created.id, { healthSnapshot: JSON.stringify({ stage: 'SCRAPING', itemsCollected: 3 }) });
    realDb.updateRun(created.id, { healthSnapshot: JSON.stringify({ stage: 'SCRAPING', itemsCollected: 7 }) });
    row = realDb.getRunById(created.id);
    assert.equal(row.completed_at, null, 'Repeated heartbeat updates must still leave completed_at null');

    // Now a real terminal transition must stamp it.
    realDb.updateRun(created.id, { status: 'done', itemsCount: 7 });
    row = realDb.getRunById(created.id);
    assert.equal(row.status, 'done');
    assert.ok(row.completed_at, 'A terminal transition (done) must stamp completed_at');
  } finally {
    realDb.deleteRun(created.id);
  }
});

// §20.A: heartbeat beats frequently in memory, but only flushes to DB after
// the configured flush interval — not on every beat/progress call.
test('HeartbeatTracker beats in memory frequently but only flushes DB after the configured flush interval (#1 memory vs #2 DB throttle)', async () => {
  const writes = [];
  const mockDb = { updateRun: (id, updates) => writes.push(updates) };
  const tracker = new HeartbeatTracker(1001, mockDb, { heartbeatIntervalMs: 5, dbFlushIntervalMs: 40 });

  // setStage() (constructor doesn't call it) forces nothing yet; first beat()
  // (via maybeFlush, lastDbFlushAt starts at 0) should flush immediately.
  tracker.beat();
  assert.equal(writes.length, 1, 'First beat must flush (lastDbFlushAt starts at 0)');

  // Rapid subsequent beats/progress well within the flush interval must NOT write again.
  tracker.beat();
  tracker.progress(1);
  tracker.progress(2);
  tracker.beat();
  assert.equal(writes.length, 1, 'Beats/progress within the flush interval must not write to DB again');

  // Wait past the flush interval, then one more beat must flush.
  await new Promise((r) => setTimeout(r, 45));
  tracker.beat();
  assert.equal(writes.length, 2, 'A beat after the flush interval has elapsed must flush');

  tracker.stop();
});

// §20.B: a dead heartbeat (no beat at all, simulated via a very short liveness
// threshold) must be recovered as EXECUTION_LOST, independent of progress age.
test('StuckDetector recovers a dead heartbeat as EXECUTION_LOST even if progress looked recent (#1 state 2)', async () => {
  const runs = new Map();
  runs.set(2001, { id: 2001, status: 'running', input_options: JSON.stringify({ attempt: 1, executionToken: 'tok-dead' }) });
  const mockDb = {
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => { const r = runs.get(id); if (r) Object.assign(r, { status: updates.status ?? r.status, input_options: updates.inputOptions ?? r.input_options, error_message: updates.errorMessage ?? r.error_message }); }
  };

  const tracker = getOrCreateTracker(2001, mockDb, { executionToken: 'tok-dead', attempt: 1, executionClass: 'LOCAL_HTTP', heartbeatIntervalMs: 100000 });
  tracker.progress(5); // progress is "recent" — only heartbeat has gone stale
  // Force the tracker's lastHeartbeatAt into the past without a real beat (simulates a dead process).
  tracker.lastHeartbeatAt = Date.now() - 10000;

  const detector = new StuckDetector({ database: mockDb, heartbeatDeadAfterMs: 500 });
  const found = await detector.checkStuckRuns();

  assert.equal(found.length, 1);
  assert.equal(found[0].runId, 2001);
  const run = runs.get(2001);
  assert.ok(run.status === 'queued' || run.status === 'stuck');
  assert.match(run.error_message, /EXECUTION_LOST/);

  removeTracker('tok-dead');
});

// §20.C: a fresh heartbeat with stale progress must be recovered as
// EXECUTION_STALLED, not silently considered healthy.
test('StuckDetector recovers a fresh-heartbeat/stale-progress execution as EXECUTION_STALLED (#1 state 3)', async () => {
  const runs = new Map();
  runs.set(2002, { id: 2002, status: 'running', input_options: JSON.stringify({ attempt: 1, executionToken: 'tok-stalled' }) });
  const mockDb = {
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => { const r = runs.get(id); if (r) Object.assign(r, { status: updates.status ?? r.status, input_options: updates.inputOptions ?? r.input_options, error_message: updates.errorMessage ?? r.error_message }); }
  };

  const tracker = getOrCreateTracker(2002, mockDb, { executionToken: 'tok-stalled', attempt: 1, executionClass: 'LOCAL_HTTP', heartbeatIntervalMs: 100000 });
  tracker.beat(); // heartbeat is fresh
  tracker.lastProgressAt = Date.now() - 999999; // progress is very stale

  const detector = new StuckDetector({ database: mockDb, heartbeatDeadAfterMs: 999999999, timeoutsByClass: { LOCAL_HTTP: 100 } });
  const found = await detector.checkStuckRuns();

  assert.equal(found.length, 1);
  assert.equal(found[0].runId, 2002);
  const run = runs.get(2002);
  assert.match(run.error_message, /EXECUTION_STALLED/);

  removeTracker('tok-stalled');
});

// §5/§20.G: production path (runId supplied) must reuse the outer Run, never
// create a nested one.
test('User Journey reuses the outer runId — production path creates no nested Run (#5/§20.G)', async () => {
  const { runUserJourney } = require('../src/journey/user-journey-runner');
  const outerRun = realDb.createRun({ platform: 'etsy', query: 'nested-run-test-' + Date.now(), maxItems: 3 });
  const countBefore = realDb.getAllRuns(5000).length;

  const summary = await runUserJourney({
    platform: 'etsy',
    keyword: 'nested-run-test',
    runId: outerRun.id,
    launchStealthFn: async () => { throw new Error('BROWSER_LAUNCH_FAILED_FOR_TEST'); }
  });

  assert.equal(summary.status, 'FAILED');
  const countAfter = realDb.getAllRuns(5000).length;
  assert.equal(countAfter, countBefore, 'No nested Run should have been created since an outer runId was supplied');

  realDb.deleteRun(outerRun.id);
});

// §6 mandatory scenario: ManagedExecution timeout must stop User Journey and
// close the browser resources IT owns, not leave them running unattended.
test('ManagedExecution timeout stops User Journey and closes the browser it owns (#6 mandatory scenario)', async () => {
  const runs = new Map();
  runs.set(3001, { id: 3001, status: 'running', input_options: JSON.stringify({ attempt: 1, executionToken: 'tok-uj' }) });
  const mockDb = {
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => { const r = runs.get(id); if (r) Object.assign(r, updates); }
  };

  let closeCalled = false;
  // Simulates real browser work that would otherwise take far longer than the timeout.
  const fakePage = { goto: () => new Promise(() => {}) };
  const fakeSession = { page: fakePage, close: async () => { closeCalled = true; } };
  const { runUserJourney } = require('../src/journey/user-journey-runner');

  const start = Date.now();
  await assert.rejects(
    () => runManaged(
      3001,
      { database: mockDb, executionToken: 'tok-uj', attempt: 1, timeoutMs: 50, onTimeout: (ctrl) => ctrl.abort() },
      ({ signal, assertOwner }) => runUserJourney({ platform: 'etsy', keyword: 'timeout-test', runId: 3001, signal, assertOwner, launchStealthFn: async () => fakeSession })
    ),
    /MANAGED_EXECUTION_TIMEOUT/
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 400, `Expected rejection near 50ms, took ${elapsed}ms (the hung page.goto() must not have been awaited)`);

  await new Promise((r) => setTimeout(r, 20)); // let the async abort listener's close() run
  assert.equal(closeCalled, true, 'Timeout must close the browser owned by this User Journey execution');
});

// §8/§20.I: a stale execution (lease already revoked) must not be able to
// persist checkpoint/business data, even mid-journey.
test('a stale User Journey execution cannot write checkpoint data after losing ownership (#8/§20.I)', async () => {
  const etsyScraperModule = require('../src/scrapers/etsy');
  const originalScrape = etsyScraperModule.scrape;
  const originalInsertSnapshots = realDb.insertSnapshots;
  const writeCalls = [];

  etsyScraperModule.scrape = async () => ({ items: [{ url: 'https://www.etsy.com/listing/1', title: 'Fake Item', price: 9.99, author: 'seller' }] });
  realDb.insertSnapshots = (...args) => { writeCalls.push(args); return originalInsertSnapshots.apply(realDb, args); };

  try {
    const { runUserJourney } = require('../src/journey/user-journey-runner');
    const outerRun = realDb.createRun({ platform: 'etsy', query: 'stale-journey-test-' + Date.now(), maxItems: 3 });

    const fakePage = {
      goto: async () => {},
      waitForTimeout: async () => {},
      content: async () => '<html>please verify you are human (captcha)</html>' // forces the CAPTCHA fallback branch
    };
    const fakeSession = { page: fakePage, close: async () => {} };
    const staleAssertOwner = () => { throw new Error('STALE_EXECUTION: token was superseded before "PRE_CHECKPOINT_PERSIST"'); };

    await assert.rejects(
      () => runUserJourney({
        platform: 'etsy', keyword: 'stale-journey-test', maxProducts: 3,
        runId: outerRun.id,
        assertOwner: staleAssertOwner,
        launchStealthFn: async () => fakeSession
      }),
      /STALE_EXECUTION/
    );

    assert.equal(writeCalls.length, 0, 'A stale execution must make zero business-data writes');
    realDb.deleteRun(outerRun.id);
  } finally {
    etsyScraperModule.scrape = originalScrape;
    realDb.insertSnapshots = originalInsertSnapshots;
  }
});

// Gap #1 closure Layer 1 (Final Gap Closure Round): if the aborted execution
// does NOT confirm settlement within the grace period, StuckDetector must NOT
// queue a retry (which would let the Scheduler admit a new attempt into a
// different free slot while the old one is still physically unresolved) — it
// must record an honest RECOVERY_CLEANUP_FAILED terminal state instead.
test('StuckDetector withholds retry and records RECOVERY_CLEANUP_FAILED when the old attempt never confirms settlement (#1 Layer 1)', async () => {
  const runs = new Map();
  runs.set(3010, { id: 3010, status: 'running', input_options: JSON.stringify({ attempt: 1, executionToken: 'tok-never-settles' }) });
  const mockDb = {
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => { const r = runs.get(id); if (r) Object.assign(r, { status: updates.status ?? r.status, input_options: updates.inputOptions ?? r.input_options, error_message: updates.errorMessage ?? r.error_message }); }
  };

  // Register the execution but NEVER call markExecutionSettled — simulates
  // real work that does not confirm it has stopped within the grace period.
  registerExecution('tok-never-settles', new AbortController());

  const tracker = getOrCreateTracker(3010, mockDb, { executionToken: 'tok-never-settles', attempt: 1, executionClass: 'LOCAL_HTTP', heartbeatIntervalMs: 100000 });
  tracker.lastHeartbeatAt = Date.now() - 10000; // stale heartbeat -> EXECUTION_LOST path

  const detector = new StuckDetector({ database: mockDb, heartbeatDeadAfterMs: 500, cleanupGraceMs: 20 });
  await detector.checkStuckRuns();

  const run = runs.get(3010);
  assert.equal(run.status, 'stuck', 'Run must NOT be re-queued while the old attempt is unconfirmed as settled');
  assert.match(run.error_message, /RECOVERY_CLEANUP_FAILED/);
  assert.notEqual(run.input_options, undefined);
  const options = JSON.parse(run.input_options);
  assert.equal(options.attempt, 1, 'No new attempt/token may be issued while the old one is unsettled');

  removeTracker('tok-never-settles');
});

// Gap #1 mandatory regression (Final Small-Gap Closure Round): the moment
// StuckDetector begins recovering a stuck attempt, its token must ALREADY be
// rejected by isCurrentOwner() — even before abort/settlement completes, and
// even in the RECOVERY_CLEANUP_FAILED (never-settled) branch, which
// previously never touched the run's stored executionToken at all. Proves
// the full stack: a stale attempt that "wakes up" afterward and tries to run
// through the real runs.service.executeRun() path gets discarded — no
// product/history persist, no marking the Run done.
test('A stuck attempt loses write ownership immediately; if it later wakes, executeRun() discards it with no persist (#1 stale ownership)', async () => {
  const { executeRun, router } = require('../src/runs.service');
  const originalRun = router.run;

  const outerRun = realDb.createRun({ platform: 'etsy', query: 'gap1-stale-owner-' + Date.now(), maxItems: 3 });
  const tokenA = 'tok-stale-owner-' + Date.now();
  realDb.updateRun(outerRun.id, { status: 'running', inputOptions: JSON.stringify({ attempt: 1, executionToken: tokenA }) });

  registerExecution(tokenA, new AbortController()); // never settled — simulates A ignoring abort and remaining alive
  const tracker = getOrCreateTracker(outerRun.id, realDb, { executionToken: tokenA, attempt: 1, executionClass: 'LOCAL_HTTP', heartbeatIntervalMs: 100000 });
  tracker.lastHeartbeatAt = Date.now() - 10000; // stale heartbeat -> EXECUTION_LOST path

  const insertSnapshotsCalls = [];
  const originalInsertSnapshots = realDb.insertSnapshots;
  realDb.insertSnapshots = (...args) => { insertSnapshotsCalls.push(args); return originalInsertSnapshots.apply(realDb, args); };

  try {
    const detector = new StuckDetector({ database: realDb, heartbeatDeadAfterMs: 500, cleanupGraceMs: 20 });
    await detector.checkStuckRuns();

    const afterRecovery = realDb.getRunById(outerRun.id);
    assert.equal(afterRecovery.status, 'stuck');
    assert.match(afterRecovery.error_message, /RECOVERY_CLEANUP_FAILED/);
    assert.equal(isCurrentOwner(realDb, outerRun.id, tokenA), false, 'A\'s token must already be rejected — recovery revokes ownership BEFORE/regardless of settlement outcome, not only on successful retry-requeue');

    // A "wakes up" (ignored the abort) and tries to run through the real
    // production path with its now-stale token.
    router.run = async () => ({
      activeBackend: 'local-scraper', backendKind: 'local', backendStatus: 'ok', backendVersion: '1.0.0',
      backendRunId: null, datasetId: null, healthSnapshot: {}, items: [{ title: 'x', url: 'https://example.com/1', image: 'https://example.com/1.jpg' }],
      raw: { rawStatus: 'SUCCEEDED' }
    });

    const result = await executeRun(outerRun.id, 'etsy', 'gap1-stale-owner', { executionToken: tokenA, attempt: 1 });

    assert.equal(result.success, false);
    assert.equal(result.discarded, true);
    assert.equal(result.reason, 'STALE_EXECUTION');
    assert.equal(insertSnapshotsCalls.length, 0, 'stale A must make zero product/history persist writes');

    const afterWakeup = realDb.getRunById(outerRun.id);
    assert.notEqual(afterWakeup.status, 'done', 'stale A must never be able to mark the Run done');
  } finally {
    router.run = originalRun;
    realDb.insertSnapshots = originalInsertSnapshots;
    removeTracker(tokenA);
    realDb.deleteRun(outerRun.id);
  }
});

// Gap #2 mandatory regression (Final Gap Closure Round): the channel-based
// execution path (runs.service.executeRun) previously never registered with
// the ExecutionControlRegistry, so abortExecution() was a silent no-op for
// it. Proves: the SAME AbortSignal threaded into router.run() is what the
// downstream (real) backend work observes, and the registry correctly
// reports settlement once that work actually rejects.
test('Channel execution registers with ExecutionControlRegistry and downstream work observes abortExecution() via the threaded signal (#2)', async () => {
  const { executeRun, router } = require('../src/runs.service');
  const originalRun = router.run;
  let observedAborted = false;
  let capturedSignal = null;
  router.run = (_platform, _query, options) => {
    capturedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        observedAborted = true;
        reject(new Error('ABORTED: execution cancelled'));
      }, { once: true });
    });
  };

  const outerRun = realDb.createRun({ platform: 'etsy', query: 'gap2-abort-test-' + Date.now(), maxItems: 3 });
  const executionToken = 'tok-gap2-' + Date.now();

  try {
    const execPromise = executeRun(outerRun.id, 'etsy', 'gap2-abort-test', { executionToken, attempt: 1 });
    await new Promise((r) => setTimeout(r, 20)); // let executeRun reach router.run()

    assert.ok(capturedSignal, 'a real AbortSignal must have been threaded into router.run()');
    assert.equal(capturedSignal.aborted, false);

    await abortExecution(executionToken, 'TEST_ABORT');
    assert.equal(observedAborted, true, 'the downstream execution must observe the abort via the threaded signal, not a no-op');

    await assert.rejects(execPromise, /ABORTED/);

    const settled = await waitForSettled(executionToken, 500);
    assert.equal(settled, true, 'the registry must report real settlement once the downstream work actually rejects');
  } finally {
    router.run = originalRun;
    realDb.deleteRun(outerRun.id);
  }
});

test('RestartRecovery re-queues retryable orphaned runs upon boot', async () => {
  const runs = [
    { id: 1, platform: 'shopify', status: 'running', input_options: JSON.stringify({ attempt: 1 }) },
    { id: 2, platform: 'etsy', status: 'running', input_options: JSON.stringify({ attempt: 3 }) }, // exhausted
    { id: 3, platform: 'reddit', status: 'done' }
  ];

  const mockDb = {
    getAllRuns: () => runs,
    updateRun: (id, updates) => {
      const r = runs.find(x => x.id === id);
      if (r) Object.assign(r, updates);
    }
  };

  const res = await recoverOrphanedRuns(mockDb, new RetryPolicy({ maxAttempts: 3 }));
  assert.equal(res.totalOrphaned, 2);
  assert.equal(res.recoveredCount, 1);
  assert.equal(res.failedCount, 1);

  assert.equal(runs[0].status, 'queued');
  assert.equal(runs[1].status, 'failed');
  assert.equal(runs[2].status, 'done');
});

// Gap #4 mandatory regression (Final Gap Closure Round): a Run whose backend
// reported an external execution (CDP child PID / Apify actor run) that is
// STILL ALIVE must not be blindly re-queued (which would dispatch a second,
// duplicate execution of the same work) — it must become RECOVERY_FAILED.
test('RestartRecovery refuses to requeue a Run whose external CDP process is still alive (#4.G)', async () => {
  const runs = [
    { id: 10, platform: 'toidispy', status: 'running', input_options: JSON.stringify({ attempt: 1 }), external_execution_json: JSON.stringify({ executionClass: 'CDP', externalExecutionId: '99999' }) }
  ];
  const mockDb = {
    getRunsByStatus: (status) => runs.filter((r) => r.status === status),
    updateRun: (id, updates) => {
      const r = runs.find((x) => x.id === id);
      if (!r) return;
      if (updates.status !== undefined) r.status = updates.status;
      if (updates.errorMessage !== undefined) r.error_message = updates.errorMessage;
      if (updates.inputOptions !== undefined) r.input_options = updates.inputOptions;
    }
  };

  const res = await recoverOrphanedRuns(mockDb, new RetryPolicy({ maxAttempts: 3 }), {
    isPidAlive: () => true // simulates the Toidispy child process still running
  });

  assert.equal(res.recoveryFailedCount, 1);
  assert.equal(res.recoveredCount, 0, 'must NOT dispatch a duplicate execution while the old CDP process is confirmed alive');
  assert.equal(runs[0].status, 'stuck');
  assert.match(runs[0].error_message, /RECOVERY_FAILED/);
});

// Gap #4 mandatory regression: once the external process is confirmed
// stopped, normal DB-level recovery (requeue) proceeds as before.
test('RestartRecovery safely requeues once the external CDP process is confirmed stopped (#4.G)', async () => {
  const runs = [
    { id: 11, platform: 'toidispy', status: 'running', input_options: JSON.stringify({ attempt: 1 }), external_execution_json: JSON.stringify({ executionClass: 'CDP', externalExecutionId: '88888' }) }
  ];
  const mockDb = {
    getRunsByStatus: (status) => runs.filter((r) => r.status === status),
    updateRun: (id, updates) => {
      const r = runs.find((x) => x.id === id);
      if (!r) return;
      if (updates.status !== undefined) r.status = updates.status;
      if (updates.errorMessage !== undefined) r.error_message = updates.errorMessage;
      if (updates.inputOptions !== undefined) r.input_options = updates.inputOptions;
    }
  };

  const res = await recoverOrphanedRuns(mockDb, new RetryPolicy({ maxAttempts: 3 }), {
    isPidAlive: () => false // the process has genuinely exited
  });

  assert.equal(res.recoveryFailedCount, 0);
  assert.equal(res.recoveredCount, 1, 'safe to requeue once the external process is confirmed stopped');
  assert.equal(runs[0].status, 'queued');
});

// Gap #4 mandatory regression: an Apify actor run whose remote status cannot
// be determined must be treated conservatively (RECOVERY_FAILED), never as
// "safe to relaunch a duplicate Actor".
test('RestartRecovery refuses to requeue when the Apify remote run status is unknown/unconfirmed (#4.H)', async () => {
  const runs = [
    { id: 12, platform: 'amazon', status: 'running', input_options: JSON.stringify({ attempt: 1 }), external_execution_json: JSON.stringify({ executionClass: 'CLOUD_API', externalExecutionId: 'apify-run-xyz' }) }
  ];
  const mockDb = {
    getRunsByStatus: (status) => runs.filter((r) => r.status === status),
    updateRun: (id, updates) => {
      const r = runs.find((x) => x.id === id);
      if (!r) return;
      if (updates.status !== undefined) r.status = updates.status;
      if (updates.errorMessage !== undefined) r.error_message = updates.errorMessage;
      if (updates.inputOptions !== undefined) r.input_options = updates.inputOptions;
    }
  };

  const res = await recoverOrphanedRuns(mockDb, new RetryPolicy({ maxAttempts: 3 }), {
    getApifyRunStatus: async () => { throw new Error('Apify API unreachable'); }
  });

  assert.equal(res.recoveryFailedCount, 1);
  assert.equal(res.recoveredCount, 0, 'must not launch a duplicate Actor run when the previous run\'s status could not be confirmed');
  assert.equal(runs[0].status, 'stuck');
});

// Gap #4 mandatory regression: once Apify itself reports the run as terminal,
// requeue proceeds normally.
test('RestartRecovery safely requeues once the Apify remote run reports a terminal status (#4.H)', async () => {
  const runs = [
    { id: 13, platform: 'amazon', status: 'running', input_options: JSON.stringify({ attempt: 1 }), external_execution_json: JSON.stringify({ executionClass: 'CLOUD_API', externalExecutionId: 'apify-run-abc' }) }
  ];
  const mockDb = {
    getRunsByStatus: (status) => runs.filter((r) => r.status === status),
    updateRun: (id, updates) => {
      const r = runs.find((x) => x.id === id);
      if (!r) return;
      if (updates.status !== undefined) r.status = updates.status;
      if (updates.errorMessage !== undefined) r.error_message = updates.errorMessage;
      if (updates.inputOptions !== undefined) r.input_options = updates.inputOptions;
    }
  };

  const res = await recoverOrphanedRuns(mockDb, new RetryPolicy({ maxAttempts: 3 }), {
    getApifyRunStatus: async () => 'SUCCEEDED'
  });

  assert.equal(res.recoveryFailedCount, 0);
  assert.equal(res.recoveredCount, 1);
  assert.equal(runs[0].status, 'queued');
});

// Gap #2 mandatory test (Final Small-Gap Closure Round): waitForSettled()
// with an execution that never settles must reliably resolve false after
// timeoutMs without test cancellation or timer unref leakage.
test('waitForSettled() on an unsettled execution reliably resolves false without test cancellation (Gap #2)', async () => {
  const token = 'tok-unsettled-test-' + Date.now();
  registerExecution(token, new AbortController()); // registered, never marked settled

  const start = Date.now();
  const settled = await waitForSettled(token, 60);
  const elapsed = Date.now() - start;

  assert.equal(settled, false, 'must resolve false when execution does not settle within timeout');
  assert.ok(elapsed >= 50, `elapsed (${elapsed}ms) should be at least around the 60ms timeout`);
});

// Patch 1 mandatory test: Etsy execution abort does NOT fall back to Everbee or historical cache
test('Etsy execution abort observes AbortSignal and does NOT fall back to Everbee or DB cache (Patch #1)', async () => {
  const { scrape } = require('../src/scrapers/etsy');
  const searchDiscovery = require('../src/scrapers/search-discovery');
  const everbeeClient = require('../src/marketplaces/everbee-host-client');

  const originalDiscover = searchDiscovery.discoverMarketplaceItems;
  const originalEverbee = everbeeClient.discoverMarketplaceListingsViaEverbeeHost;

  let everbeeCalled = false;
  const ac = new AbortController();

  // SearXNG discovery waits or rejects upon signal abort
  searchDiscovery.discoverMarketplaceItems = (_platform, _query, options) => {
    return new Promise((_resolve, reject) => {
      if (options.signal?.aborted) {
        return reject(new Error('ABORTED: operation cancelled'));
      }
      options.signal?.addEventListener('abort', () => {
        reject(new Error('ABORTED: operation cancelled'));
      });
    });
  };

  everbeeClient.discoverMarketplaceListingsViaEverbeeHost = async () => {
    everbeeCalled = true;
    return { items: [{ url: 'https://www.etsy.com/listing/123', title: 'Everbee Item' }] };
  };

  try {
    const scrapePromise = scrape('abort-test-query', { signal: ac.signal, maxItems: 5 });
    setTimeout(() => ac.abort(), 10);

    await assert.rejects(
      scrapePromise,
      (err) => {
        assert.ok(err.name === 'AbortError' || err.code === 'ABORTED' || /ABORT/i.test(err.message));
        return true;
      },
      'Etsy scrape must reject directly with abort error when aborted'
    );

    assert.equal(everbeeCalled, false, 'Etsy scraper must NOT call Everbee fallback when aborted');
  } finally {
    searchDiscovery.discoverMarketplaceItems = originalDiscover;
    everbeeClient.discoverMarketplaceListingsViaEverbeeHost = originalEverbee;
  }
});

// Patch 1 mandatory test: Everbee client fetch observes threaded AbortSignal
test('Everbee client discovery and capture observe threaded AbortSignal (Patch #1)', async () => {
  const { discoverMarketplaceListingsViaEverbeeHost, captureViaEverbeeHost } = require('../src/marketplaces/everbee-host-client');
  const ac = new AbortController();
  ac.abort();

  let discoverySignalObserved = false;
  const mockFetch = async (_url, options) => {
    if (options.signal?.aborted) {
      discoverySignalObserved = true;
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return { ok: true, json: async () => ({ items: [] }) };
  };

  await assert.rejects(
    discoverMarketplaceListingsViaEverbeeHost({
      platform: 'etsy',
      keyword: 'test',
      signal: ac.signal,
      executorUrl: 'http://localhost:9999',
      fetchImpl: mockFetch
    }),
    (err) => err.name === 'AbortError'
  );
  assert.equal(discoverySignalObserved, true, 'discoverMarketplaceListingsViaEverbeeHost must pass signal to fetch');

  let captureSignalObserved = false;
  const mockCaptureFetch = async (_url, options) => {
    if (options.signal?.aborted) {
      captureSignalObserved = true;
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return { ok: true, json: async () => ({ html: '<html></html>' }) };
  };

  await assert.rejects(
    captureViaEverbeeHost({
      platform: 'etsy',
      url: 'https://www.etsy.com/listing/12345/test',
      signal: ac.signal,
      executorUrl: 'http://localhost:9999',
      fetchImpl: mockCaptureFetch
    }),
    (err) => err.name === 'AbortError'
  );
  assert.equal(captureSignalObserved, true, 'captureViaEverbeeHost must pass signal to fetch');
});
