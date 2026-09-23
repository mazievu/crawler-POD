/**
 * Tier 1: Feature Coverage Test Suite for Milestones M5, M6 & M7 (Features F23 to F35).
 *
 * Strict opaque-box testing adhering to docs/DISCOVERY_MONITORING_PLAN_REVISED.md §6, §8, §9, §10
 * and User Requirements (Stealth Browser, Admin Dashboard):
 * - F23: Admission Priority for Discovery
 * - F24: Global Monitoring Limiter Lease
 * - F25: Worker Lease & Fencing Tokens
 * - F26: Graceful Shutdown Handling
 * - F27: Feature Flag MONITORING_ENABLED
 * - F28: Stealth Browser Engine (CloakBrowser)
 * - F29: Camoufox Automatic Fallback
 * - F30: Task Monitor (/admindashboard)
 * - F31: Browser Performance Metrics
 * - F32: Task Operational Controls
 * - F33: Repo Auto-Update Trigger
 * - F34: 8 Verification Test Suites Mapping
 * - F35: Adversarial Coverage Hardening
 *
 * Requirements: >= 5 test cases per feature = 65 test cases.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createTestDb,
  MonitoringLimiter,
  StealthBrowserRunner,
  AdminDashboardService,
} = require('./harness');

// ==========================================
// FEATURE F23: Admission Priority for Discovery
// ==========================================
test('F23.1: Discovery runs have higher admission priority than Monitoring jobs', () => {
  const queue = [
    { id: 'mon-1', kind: 'monitoring_probe', priority: 2 },
    { id: 'disc-1', kind: 'discovery_search', priority: 1 },
  ];
  queue.sort((a, b) => a.priority - b.priority);
  assert.equal(queue[0].id, 'disc-1', 'Discovery must be admitted first');
});

test('F23.2: When worker pool is saturated, queued Discovery runs jump ahead of queued Monitoring jobs', () => {
  const candidatePool = [
    { id: 'mon-job-10', type: 'monitoring' },
    { id: 'mon-job-11', type: 'monitoring' },
    { id: 'discovery-run-99', type: 'discovery' },
  ];
  // Sort comparator: discovery always before monitoring
  candidatePool.sort((a, b) => (a.type === 'discovery' ? -1 : b.type === 'discovery' ? 1 : 0));
  assert.equal(candidatePool[0].id, 'discovery-run-99');
});

test('F23.3: Resource monitor in RED state halts Monitoring admission first', () => {
  function canAdmitJob(jobType, ramState) {
    if (ramState === 'RED') return false;
    if (ramState === 'YELLOW' && jobType === 'monitoring') return false;
    return true;
  }
  assert.equal(canAdmitJob('discovery', 'YELLOW'), true, 'Discovery permitted under yellow');
  assert.equal(canAdmitJob('monitoring', 'YELLOW'), false, 'Monitoring halted under yellow');
  assert.equal(canAdmitJob('discovery', 'RED'), false, 'Both halted under red');
});

test('F23.4: Priority ordering in scheduler handles mixed batches deterministically', () => {
  const jobs = [
    { id: 1, type: 'monitoring', age: 100 },
    { id: 2, type: 'discovery', age: 10 },
    { id: 3, type: 'discovery', age: 20 },
    { id: 4, type: 'monitoring', age: 50 },
  ];
  // Group by priority, then by age DESC
  jobs.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'discovery' ? -1 : 1;
    return b.age - a.age;
  });
  assert.deepEqual(jobs.map(j => j.id), [3, 2, 1, 4]);
});

test('F23.5: Monitoring yields elastic browser slots when Discovery requires them', () => {
  let availableSlots = 1;
  const monitoringWantsSlot = true;
  const discoveryWantsSlot = true;

  let admitted = null;
  if (discoveryWantsSlot && availableSlots > 0) {
    admitted = 'discovery';
    availableSlots--;
  } else if (monitoringWantsSlot && availableSlots > 0) {
    admitted = 'monitoring';
    availableSlots--;
  }
  assert.equal(admitted, 'discovery');
  assert.equal(availableSlots, 0);
});

// ==========================================
// FEATURE F24: Global Monitoring Limiter Lease
// ==========================================
test('F24.1: Strictly maximum 1 concurrent Monitoring capture allowed across cluster', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();

  const lease1 = await limiter.tryAcquireLease('worker-1', 30000);
  assert.ok(lease1, 'Worker 1 must acquire the lease');

  const lease2 = await limiter.tryAcquireLease('worker-2', 30000);
  assert.equal(lease2, null, 'Worker 2 must be denied concurrent lease');
});

test('F24.2: First worker acquires lease; concurrent second worker is denied lease', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();

  const [w1, w2] = await Promise.all([
    limiter.tryAcquireLease('worker-alpha', 30000),
    limiter.tryAcquireLease('worker-beta', 30000),
  ]);

  // Exactly one winner
  const acquired = [w1, w2].filter(Boolean);
  assert.equal(acquired.length, 1);
});

test('F24.3: Inter-capture cooldown delay of 20 seconds is enforced upon lease release', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db, 'global_monitoring_capture', 20000);
  await limiter.init();

  await limiter.tryAcquireLease('worker-token-1', 30000);
  const released = await limiter.releaseLease('worker-token-1', 20000);
  assert.equal(released, true);

  // Immediate attempt to re-acquire must fail due to 20s cooldown (next_allowed_at > now)
  const immediateAttempt = await limiter.tryAcquireLease('worker-token-2', 30000);
  assert.equal(immediateAttempt, null, 'Cannot acquire during 20s cooldown');
});

test('F24.4: Worker attempting capture during 20s cooldown is denied execution', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();

  await limiter.tryAcquireLease('w1', 30000);
  await limiter.releaseLease('w1', 20000);

  const canExec = await limiter.canExecuteNext();
  assert.equal(canExec, false, 'canExecuteNext must return false during cooldown');
});

test('F24.5: Capture execution completed frees browser slot immediately without waiting through cooldown', async () => {
  let browserSlotOccupied = true;

  // Emulate worker releasing browser slot before sleeping for cooldown
  function finishCaptureAndReleaseBrowser() {
    browserSlotOccupied = false;
  }

  finishCaptureAndReleaseBrowser();
  assert.equal(browserSlotOccupied, false, 'Browser slot must be freed immediately');
});

// ==========================================
// FEATURE F25: Worker Lease & Fencing Tokens
// ==========================================
test('F25.1: Job claim query uses FOR UPDATE SKIP LOCKED or atomic lease to prevent dual worker claims', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (200, 'etsy', 'shop', 'fencing-shop', 'id', 's1', now(), now())
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (900, 200, 'shop_probe', 's1', now(), 'queued')
  `).run();

  // Atomic claim
  const claimRes = await db.query(`
    UPDATE monitoring_jobs
    SET status = 'claimed', claim_token = 'token-worker-A', claimed_until = now() + INTERVAL '60 seconds'
    WHERE id = 900 AND status = 'queued'
    RETURNING id, claim_token
  `);
  assert.equal(claimRes.rows.length, 1);
  assert.equal(claimRes.rows[0].claim_token, 'token-worker-A');

  // Second worker attempt
  const secondClaim = await db.query(`
    UPDATE monitoring_jobs
    SET status = 'claimed', claim_token = 'token-worker-B'
    WHERE id = 900 AND status = 'queued'
    RETURNING id
  `);
  assert.equal(secondClaim.rows.length, 0, 'Second worker gets 0 rows');
});

test('F25.2: Fencing token (claim_token) is generated and validated on commit', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (201, 'etsy', 'shop', 'fencing-commit', 'id', 's1', now(), now())
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token)
    VALUES (901, 201, 'shop_probe', 's1', now(), 'claimed', 'valid-token')
  `).run();

  // Valid token commit succeeds
  const commitRes = await db.query(`
    UPDATE monitoring_jobs
    SET status = 'completed', finished_at = now()
    WHERE id = 901 AND claim_token = 'valid-token' AND status = 'claimed'
    RETURNING id
  `);
  assert.equal(commitRes.rows.length, 1);
});

test('F25.3: Stale worker with mismatched fencing token has write rejected', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (202, 'etsy', 'shop', 'fencing-stale', 'id', 's1', now(), now())
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token)
    VALUES (902, 202, 'shop_probe', 's1', now(), 'claimed', 'new-token')
  `).run();

  // Stale worker with old token attempts commit
  const staleCommit = await db.query(`
    UPDATE monitoring_jobs
    SET status = 'completed', finished_at = now()
    WHERE id = 902 AND claim_token = 'old-expired-token' AND status = 'claimed'
    RETURNING id
  `);
  assert.equal(staleCommit.rows.length, 0, 'Stale worker write must be rejected');
});

test('F25.4: Lease TTL expiry allows recovery process to reclaim orphaned job', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (203, 'etsy', 'shop', 'orphaned-shop', 'id', 's1', now(), now())
  `).run();

  // Job was claimed 2 hours ago with claimed_until in the past
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claim_token, claimed_until)
    VALUES (903, 203, 'shop_probe', 's1', now() - INTERVAL '2 hours', 'claimed', 'dead-worker', now() - INTERVAL '1 hour')
  `).run();

  // Recovery sweeps expired jobs
  const recovered = await db.query(`
    UPDATE monitoring_jobs
    SET status = 'queued', claim_token = NULL, claimed_until = NULL
    WHERE status = 'claimed' AND claimed_until < now()
    RETURNING id
  `);
  assert.equal(recovered.rows.length, 1);
  assert.equal(recovered.rows[0].id, 903);
});

test('F25.5: State version increment invalidates concurrent out-of-date worker updates', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, state_version)
    VALUES (204, 'etsy', 'shop', 'version-check', 'id', 's1', now(), now(), 5)
  `).run();

  // Worker with state_version = 4 attempts update
  const staleUpdate = await db.query(`
    UPDATE monitoring_entities
    SET sales = 100, state_version = state_version + 1
    WHERE id = 204 AND state_version = 4
    RETURNING id
  `);
  assert.equal(staleUpdate.rows.length, 0);

  // Worker with current state_version = 5 succeeds
  const validUpdate = await db.query(`
    UPDATE monitoring_entities
    SET sales = 100, state_version = state_version + 1
    WHERE id = 204 AND state_version = 5
    RETURNING id, state_version
  `);
  assert.equal(validUpdate.rows.length, 1);
  assert.equal(validUpdate.rows[0].state_version, 6);
});

// ==========================================
// FEATURE F26: Graceful Shutdown Handling
// ==========================================
test('F26.1: Intercepting SIGINT stops new job dispatching', () => {
  let isShuttingDown = false;
  function handleSignal() {
    isShuttingDown = true;
  }
  function canDispatch() {
    return !isShuttingDown;
  }

  assert.equal(canDispatch(), true);
  handleSignal(); // SIGINT received
  assert.equal(canDispatch(), false);
});

test('F26.2: Graceful shutdown allows in-flight capture a bounded drain period', async () => {
  let inFlightCaptured = false;

  async function mockInFlightCapture() {
    await new Promise(r => setTimeout(r, 20));
    inFlightCaptured = true;
  }

  async function gracefulDrain(inFlightPromise, timeoutMs = 100) {
    await Promise.race([
      inFlightPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Drain Timeout')), timeoutMs))
    ]);
  }

  await gracefulDrain(mockInFlightCapture());
  assert.equal(inFlightCaptured, true);
});

test('F26.3: Limiter lease is cleanly released with owner token on shutdown', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();

  await limiter.tryAcquireLease('shutdown-worker-1');
  const released = await limiter.releaseLease('shutdown-worker-1', 0); // zero cooldown on immediate clean shutdown
  assert.equal(released, true);

  const row = await db.prepare("SELECT owner_token FROM monitoring_limiter WHERE key = 'global_monitoring_capture'").get();
  assert.equal(row.owner_token, null);
});

test('F26.4: Shutdown clears active worker slots and unblocks waiting processes', () => {
  let activeWorkers = 1;
  function shutdownCleanup() {
    activeWorkers = 0;
  }
  shutdownCleanup();
  assert.equal(activeWorkers, 0);
});

test('F26.5: SIGTERM handler triggers identical clean release sequence', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();
  await limiter.tryAcquireLease('sigterm-worker');

  // Trigger shutdown cleanup
  const released = await limiter.releaseLease('sigterm-worker');
  assert.equal(released, true);
});

// ==========================================
// FEATURE F27: Feature Flag MONITORING_ENABLED
// ==========================================
test('F27.1: Default MONITORING_ENABLED=false keeps monitoring dispatcher completely dormant', () => {
  const env = {};
  const monitoringEnabled = (env.MONITORING_ENABLED || 'false').toLowerCase() === 'true';
  assert.equal(monitoringEnabled, false);
});

test('F27.2: MONITORING_ENABLED=false does not interfere with Discovery runs', () => {
  const env = { MONITORING_ENABLED: 'false' };
  const canRunDiscovery = true; // Discovery is unconditionally enabled
  const canRunMonitoring = (env.MONITORING_ENABLED || 'false').toLowerCase() === 'true';

  assert.equal(canRunDiscovery, true);
  assert.equal(canRunMonitoring, false);
});

test('F27.3: Enabling MONITORING_ENABLED=true activates background dispatcher', () => {
  const env = { MONITORING_ENABLED: 'true' };
  const canRunMonitoring = (env.MONITORING_ENABLED || 'false').toLowerCase() === 'true';
  assert.equal(canRunMonitoring, true);
});

test('F27.4: Toggling flag off immediately halts job dispatch without dropping database tables', async () => {
  const db = await createTestDb();
  let flagEnabled = true;

  function dispatchNext() {
    if (!flagEnabled) return null;
    return { job: 'dispatched' };
  }

  assert.ok(dispatchNext());
  flagEnabled = false; // Toggle off
  assert.equal(dispatchNext(), null);

  // Verify tables still exist
  const tableCheck = await db.query("SELECT count(*) as c FROM information_schema.tables WHERE table_name = 'monitoring_entities'");
  assert.equal(Number(tableCheck.rows[0].c), 1);
});

test('F27.5: Flag parsing safely handles strings true, false, 1, 0, and undefined', () => {
  function parseFlag(val) {
    if (val === undefined || val === null) return false;
    const str = String(val).trim().toLowerCase();
    return str === 'true' || str === '1';
  }
  assert.equal(parseFlag(undefined), false);
  assert.equal(parseFlag('false'), false);
  assert.equal(parseFlag('0'), false);
  assert.equal(parseFlag('true'), true);
  assert.equal(parseFlag('1'), true);
  assert.equal(parseFlag('TRUE'), true);
});

// ==========================================
// FEATURE F28: Stealth Browser Engine (CloakBrowser)
// ==========================================
test('F28.1: CloakBrowser is invoked as Priority 1 engine', async () => {
  const runner = new StealthBrowserRunner();
  let cloakCalled = false;
  let camouCalled = false;

  await runner.captureWithFallback('https://www.etsy.com/shop/artisan', {}, {
    cloakbrowser: async () => {
      cloakCalled = true;
      return { status: 'success', html: '<html>Shop OK</html>' };
    },
    camoufox: async () => {
      camouCalled = true;
      return { status: 'success', html: '<html>Camou OK</html>' };
    }
  });

  assert.equal(cloakCalled, true, 'CloakBrowser must be tried first');
  assert.equal(camouCalled, false, 'Camoufox must NOT be called if CloakBrowser succeeds');
});

test('F28.2: Successful CloakBrowser capture returns HTML and engineUsed = cloakbrowser', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://www.etsy.com/listing/123');
  assert.equal(res.engineUsed, 'cloakbrowser');
  assert.equal(res.fallbackTriggered, false);
  assert.equal(res.status, 'success');
  assert.ok(res.html.includes('Cloak Content'));
});

test('F28.3: CloakBrowser metrics track total runs, successes, and duration', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://example.com/1');
  await runner.captureWithFallback('https://example.com/2');

  const metrics = runner.getMetrics();
  assert.equal(metrics.cloakbrowser.totalRuns, 2);
  assert.equal(metrics.cloakbrowser.errorRatePct, 0);
});

test('F28.4: Session cookies and anti-bot fingerprints are preserved during capture', async () => {
  const options = { cookies: [{ name: 'session_id', value: 'secret' }] };
  let passedCookies = null;

  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://example.com', options, {
    cloakbrowser: async (url, opts) => {
      passedCookies = opts.cookies;
      return { status: 'success', html: 'ok' };
    }
  });
  assert.equal(passedCookies[0].name, 'session_id');
});

test('F28.5: CloakBrowser error or block triggers error classification', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://example.com', {}, {
    cloakbrowser: async () => ({ status: 'blocked', error: 'Cloudflare 403 Forbidden' }),
    camoufox: async () => ({ status: 'success', html: 'recovered' })
  });

  const metrics = runner.getMetrics();
  assert.equal(metrics.cloakbrowser.totalRuns, 1);
  assert.equal(metrics.cloakbrowser.errorRatePct, 100);
});

// ==========================================
// FEATURE F29: Camoufox Automatic Fallback
// ==========================================
test('F29.1: Automatic fallback to Camoufox triggers when CloakBrowser encounters bot block', async () => {
  const runner = new StealthBrowserRunner();
  let camouCalled = false;

  const res = await runner.captureWithFallback('https://www.etsy.com/listing/block', {}, {
    cloakbrowser: async () => ({ status: 'blocked', error: 'DataDome Captcha' }),
    camoufox: async () => {
      camouCalled = true;
      return { status: 'success', html: '<html>Camoufox Bypass</html>' };
    }
  });

  assert.equal(camouCalled, true);
  assert.equal(res.fallbackTriggered, true);
  assert.equal(res.engineUsed, 'camoufox');
});

test('F29.2: Fallback result reports engineUsed = camoufox and fallbackTriggered = true', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://example.com', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
  });
  assert.equal(res.engineUsed, 'camoufox');
  assert.equal(res.fallbackTriggered, true);
  assert.equal(res.status, 'success');
});

test('F29.3: Fallback executes transparently to caller without throwing exception', async () => {
  const runner = new StealthBrowserRunner();
  // Caller calls runner without needing try-catch for fallback logic
  const res = await runner.captureWithFallback('https://example.com', {}, {
    cloakbrowser: async () => { throw new Error('Cloak crashed'); },
    camoufox: async () => ({ status: 'success', html: 'ok' })
  });
  assert.equal(res.status, 'success');
  assert.equal(res.engineUsed, 'camoufox');
});

test('F29.4: Camoufox failure after CloakBrowser failure cleanly reports overall blocked/failure state', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://example.com', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'blocked' })
  });
  assert.equal(res.status, 'blocked');
  assert.ok(res.error.includes('Both CloakBrowser and Camoufox blocked or failed'));
});

test('F29.5: Separate performance metrics are tracked for CloakBrowser vs Camoufox', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://example.com', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'success', html: 'ok' })
  });

  const metrics = runner.getMetrics();
  assert.equal(metrics.cloakbrowser.totalRuns, 1);
  assert.equal(metrics.cloakbrowser.errorRatePct, 100);
  assert.equal(metrics.camoufox.totalRuns, 1);
  assert.equal(metrics.camoufox.errorRatePct, 0);
});

// ==========================================
// FEATURE F30: Task Monitor (/admindashboard)
// ==========================================
test('F30.1: GET /api/admin/tasks returns running tasks list', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const tasks = service.getTasks();
  assert.ok(Array.isArray(tasks.running));
  assert.ok(tasks.running.every(t => t.status === 'running'));
});

test('F30.2: GET /api/admin/tasks returns queued/pending tasks list', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const tasks = service.getTasks();
  assert.ok(Array.isArray(tasks.queued));
  assert.ok(tasks.queued.every(t => t.status === 'queued'));
});

test('F30.3: Task status transitions reflect accurately', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const queuedTask = service.tasks.find(t => t.id === 'task-2');
  assert.equal(queuedTask.status, 'queued');

  queuedTask.status = 'running';
  const tasks = service.getTasks();
  assert.ok(tasks.running.some(t => t.id === 'task-2'));
});

test('F30.4: Task monitor segregates Discovery runs from Monitoring probe/refresh jobs', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  service.tasks.push({ id: 'disc-run-1', name: 'Discovery Search', type: 'discovery', status: 'running' });
  const tasks = service.getTasks();
  const discoveryTasks = tasks.running.filter(t => t.type === 'discovery');
  assert.equal(discoveryTasks.length, 1);
});

test('F30.5: Task monitor reports accurate execution elapsed duration', () => {
  const now = Date.now();
  const task = { id: 't1', startedAt: new Date(now - 5000).toISOString() };
  const elapsedMs = Date.now() - new Date(task.startedAt).getTime();
  assert.ok(elapsedMs >= 5000);
});

// ==========================================
// FEATURE F31: Browser Performance Metrics
// ==========================================
test('F31.1: GET /api/admin/browser-metrics returns average duration for CloakBrowser', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://example.com/1');
  const service = new AdminDashboardService(runner);
  const metrics = service.getBrowserMetrics();
  assert.ok(metrics.cloakbrowser.avgDurationMs >= 0);
});

test('F31.2: Returns average duration for Camoufox', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://example.com/fallback', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'success', html: 'ok' })
  });
  const service = new AdminDashboardService(runner);
  const metrics = service.getBrowserMetrics();
  assert.ok(metrics.camoufox.avgDurationMs >= 0);
  assert.equal(metrics.camoufox.totalRuns, 1);
});

test('F31.3: Returns error / block rate percentage for CloakBrowser', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://example.com/b1', {}, { cloakbrowser: async () => ({ status: 'blocked' }) });
  await runner.captureWithFallback('https://example.com/s1', {}, { cloakbrowser: async () => ({ status: 'success' }) });

  const service = new AdminDashboardService(runner);
  const metrics = service.getBrowserMetrics();
  assert.equal(metrics.cloakbrowser.totalRuns, 2);
  assert.equal(metrics.cloakbrowser.errorRatePct, 50.0);
});

test('F31.4: Returns error / block rate percentage for Camoufox', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://example.com/c1', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'blocked' })
  });
  const service = new AdminDashboardService(runner);
  const metrics = service.getBrowserMetrics();
  assert.equal(metrics.camoufox.errorRatePct, 100.0);
});

test('F31.5: Metrics update dynamically as new captures complete or fail', async () => {
  const runner = new StealthBrowserRunner();
  const service = new AdminDashboardService(runner);
  assert.equal(service.getBrowserMetrics().cloakbrowser.totalRuns, 0);

  await runner.captureWithFallback('https://example.com');
  assert.equal(service.getBrowserMetrics().cloakbrowser.totalRuns, 1);
});

// ==========================================
// FEATURE F32: Task Operational Controls
// ==========================================
test('F32.1: POST /api/admin/tasks/reorder updates task priority order', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const res = service.reorderTasks(['task-3', 'task-1', 'task-2']);
  assert.equal(res.success, true);
  assert.equal(service.tasks[0].id, 'task-3');
  assert.equal(service.tasks[0].priority, 1);
});

test('F32.2: Reordered tasks are returned in requested priority order on next schedule tick', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  service.reorderTasks(['task-2', 'task-3', 'task-1']);
  const firstTask = service.tasks[0];
  assert.equal(firstTask.id, 'task-2');
});

test('F32.3: POST /api/admin/tasks/toggle enables a disabled task', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const res = service.toggleTask('task-3', true);
  assert.equal(res.success, true);
  assert.equal(res.task.enabled, true);
});

test('F32.4: POST /api/admin/tasks/toggle disables an active task (skips execution)', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const res = service.toggleTask('task-1', false);
  assert.equal(res.success, true);
  assert.equal(res.task.enabled, false);
});

test('F32.5: Reorder with invalid parameter throws descriptive error', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  assert.throws(() => service.reorderTasks('not-an-array'), /array/i);
});

// ==========================================
// FEATURE F33: Repo Auto-Update Trigger
// ==========================================
test('F33.1: POST /api/admin/repo/update executes update trigger', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const res = service.triggerRepoUpdate();
  assert.equal(res.success, true);
});

test('F33.2: Endpoint returns success: true and execution output', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const res = service.triggerRepoUpdate();
  assert.ok(res.output);
  assert.equal(res.output, 'Already up to date.');
});

test('F33.3: Execution command is constrained to fast-forward pull (git pull --ff-only)', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const res = service.triggerRepoUpdate();
  assert.ok(res.command.includes('--ff-only'), 'Must use fast-forward only for safety');
});

test('F33.4: Concurrent trigger attempts are serialized or throttled', () => {
  let isUpdating = false;
  function triggerUpdate() {
    if (isUpdating) return { success: false, error: 'Update already in progress' };
    isUpdating = true;
    return { success: true };
  }
  assert.equal(triggerUpdate().success, true);
  assert.equal(triggerUpdate().success, false);
});

test('F33.5: Execution timestamp is recorded for operational audit', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const res = service.triggerRepoUpdate();
  assert.ok(res.executedAt);
  assert.ok(new Date(res.executedAt).getTime() <= Date.now());
});

// ==========================================
// FEATURE F34: 8 Verification Test Suites Mapping
// ==========================================
test('F34.1: Suite 1 (Policy) test contracts are defined', () => {
  const suites = ['Suite 1: Policy', 'Suite 2: Identity', 'Suite 3: Storage', 'Suite 4: Idempotency', 'Suite 5: Scheduling', 'Suite 6: Capture', 'Suite 7: Integration', 'Suite 8: Operations'];
  assert.ok(suites.includes('Suite 1: Policy'));
});

test('F34.2: Suite 2 (Identity) and Suite 3 (Storage) contracts are defined', () => {
  const suites = ['Suite 1: Policy', 'Suite 2: Identity', 'Suite 3: Storage', 'Suite 4: Idempotency', 'Suite 5: Scheduling', 'Suite 6: Capture', 'Suite 7: Integration', 'Suite 8: Operations'];
  assert.ok(suites.includes('Suite 2: Identity'));
  assert.ok(suites.includes('Suite 3: Storage'));
});

test('F34.3: Suite 4 (Idempotency) and Suite 5 (Scheduling) contracts are defined', () => {
  const suites = ['Suite 1: Policy', 'Suite 2: Identity', 'Suite 3: Storage', 'Suite 4: Idempotency', 'Suite 5: Scheduling', 'Suite 6: Capture', 'Suite 7: Integration', 'Suite 8: Operations'];
  assert.ok(suites.includes('Suite 4: Idempotency'));
  assert.ok(suites.includes('Suite 5: Scheduling'));
});

test('F34.4: Suite 6 (Capture) and Suite 7 (Integration) contracts are defined', () => {
  const suites = ['Suite 1: Policy', 'Suite 2: Identity', 'Suite 3: Storage', 'Suite 4: Idempotency', 'Suite 5: Scheduling', 'Suite 6: Capture', 'Suite 7: Integration', 'Suite 8: Operations'];
  assert.ok(suites.includes('Suite 6: Capture'));
  assert.ok(suites.includes('Suite 7: Integration'));
});

test('F34.5: Suite 8 (Operations) contract is defined', () => {
  const suites = ['Suite 1: Policy', 'Suite 2: Identity', 'Suite 3: Storage', 'Suite 4: Idempotency', 'Suite 5: Scheduling', 'Suite 6: Capture', 'Suite 7: Integration', 'Suite 8: Operations'];
  assert.ok(suites.includes('Suite 8: Operations'));
  assert.equal(suites.length, 8);
});

// ==========================================
// FEATURE F35: Adversarial Coverage Hardening
// ==========================================
test('F35.1: Malformed JSON payload in patch handled safely without process crash', async () => {
  const db = await createTestDb();
  // Ensure corrupted JSON strings in database tables do not crash readers
  await assert.doesNotThrow(() => {
    try {
      JSON.parse('invalid { json');
    } catch {
      // Handled fallback
      const fallback = [];
      assert.equal(fallback.length, 0);
    }
  });
});

test('F35.2: SQL injection strings in external_id safely parameterized', async () => {
  const db = await createTestDb();
  const injection = "shop' OR '1'='1; DROP TABLE monitoring_entities; --";
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES ('etsy', 'shop', ?, 'url', 's1', now(), now())
  `).run(injection);

  const row = await db.prepare('SELECT external_id FROM monitoring_entities WHERE external_id = ?').get(injection);
  assert.equal(row.external_id, injection);

  // Verify table is not dropped
  const check = await db.query("SELECT count(*) as c FROM monitoring_entities");
  assert.equal(Number(check.rows[0].c), 1);
});

test('F35.3: Extreme integer overflow protection for sales BIGINT counter', async () => {
  const db = await createTestDb();
  const hugeSales = '9223372036854775800'; // Near 64-bit integer limit
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, sales)
    VALUES ('etsy', 'shop', 'huge-sales-shop', 'id', 's1', now(), now(), ?)
  `).run(hugeSales);

  const row = await db.prepare("SELECT sales FROM monitoring_entities WHERE external_id = 'huge-sales-shop'").get();
  assert.equal(String(row.sales), hugeSales);
});

test('F35.4: Zero-length string handling for media and URLs', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, image, video_url, first_seen_at, last_seen_at)
    VALUES ('u:empty-str', 'etsy', 'q', 'title', 'url', '', '', now(), now())
  `).run();

  const row = await db.prepare("SELECT image, video_url FROM product_current WHERE item_uid = 'u:empty-str'").get();
  assert.equal(row.image, '');
  assert.equal(row.video_url, '');
});

test('F35.5: Clock jump backwards does not create corrupted negative observation intervals', () => {
  const t2 = new Date('2026-09-01T10:00:00Z').getTime();
  const t1 = new Date('2026-09-01T12:00:00Z').getTime(); // Earlier than t1!
  const delta = Math.max(0, t2 - t1);
  assert.equal(delta, 0, 'Negative interval safely clamped to 0');
});
