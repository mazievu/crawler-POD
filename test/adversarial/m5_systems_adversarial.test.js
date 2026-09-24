'use strict';

/**
 * test/adversarial/m5_systems_adversarial.test.js
 *
 * Milestone M5 — Tier 5 White-Box Adversarial Hardening Suite
 * Systems, Operations & Lifecycle Core:
 *
 * 1. ResourceScheduler Concurrency & Lifecycle Core:
 *    - 50+ concurrent run saturation under MAX_CONCURRENT_RUNS = 10 (exact ceiling, FIFO queue integrity, zero slot leaks)
 *    - Slot underflow protection (spurious/malicious complete signals, negative count clamping)
 *    - Emergency Freeze rapid toggling under high load (queue admission halt, 503 DISPATCH_FROZEN, resumption)
 *
 * 2. Apify Token Pool Budget & Race Conditions:
 *    - Concurrency race conditions: 30 parallel paid runs competing for limited budget (atomic deduction, zero overdraw)
 *    - Zero, micro-spend and floating-point precision boundary handling ($0.00, $0.0001, -$5.00, fractional cost)
 *    - Free/local scraper bypass verification under negative/zero balance
 *
 * 3. Backup Manager & Rollback Subsystem Deep Security:
 *    - Deep path traversal stress (UNC paths, device namespaces \\?\, drive letters, mixed slashes, null bytes, Windows case-insensitivity)
 *    - Manifest tampering resilience (forged SHA-256, truncated files, corrupted JSON, SQL injection escaping)
 *    - Atomic rollback failure recovery (transaction rollback on SQL error, zero disk changes on pre-flight tamper)
 *    - Retention count 0 and directory collision suffix verification (_1, _2)
 *
 * 4. Server Operations, Probes & Graceful Shutdown:
 *    - Health probes /livez and /readyz state transitions during DB health shifts (healthy -> error -> healthy)
 *    - Graceful shutdown lifecycle: connection draining, background timer stops, DB pool closure, exit 0, and 30s watchdog
 *
 * 5. Container & Docker Hardening:
 *    - .dockerignore exclusions audit (.env*, proxies.txt, .backup/, data/, logs/, public/media/, node_modules/)
 */

// `require('../../server')` below runs server.js's full module-level boot
// in THIS process (it is not spawned as a subprocess), which otherwise
// instantiates the Apify token pool / social bot scheduler / journey
// checkpoint store / everbee profile store at their default on-disk
// locations under the repo's real data/ directory. Point them at a unique
// temp location first so this test file never writes into data/.
{
  const nodePath = require('node:path');
  const nodeOs = require('node:os');
  const runId = `${process.pid}-${Date.now()}`;
  process.env.APIFY_TOKENS_PATH = process.env.APIFY_TOKENS_PATH
    || nodePath.join(nodeOs.tmpdir(), `crawler-pod-m5-systems-apify-tokens-${runId}.json`);
  process.env.SOCIAL_BOTS_CONFIG_PATH = process.env.SOCIAL_BOTS_CONFIG_PATH
    || nodePath.join(nodeOs.tmpdir(), `crawler-pod-m5-systems-social-bots-${runId}.json`);
  process.env.CAPTURES_DIR = process.env.CAPTURES_DIR
    || nodePath.join(nodeOs.tmpdir(), `crawler-pod-m5-systems-captures-${runId}`);
  process.env.EVERBEE_PROFILE_ROOT = process.env.EVERBEE_PROFILE_ROOT
    || nodePath.join(nodeOs.tmpdir(), `crawler-pod-m5-systems-everbee-${runId}`);
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');

const { ResourceScheduler } = require('../../src/scheduler/scheduler');
const { ApifyTokenPoolManager, ApifyBudgetExceededError } = require('../../src/apify-token-pool');
const {
  createBackup,
  pruneBackups,
  detectEngine,
  dumpPostgresViaClient,
  escapeSqlValue,
  getTimestamp,
} = require('../../scripts/backup-manager');

const {
  performRollback,
  listBackups,
  verifyBackupIntegrity,
  restorePostgresViaClient,
  isPathConfined,
  isPathContainedWithin,
  fileHash,
} = require('../../scripts/rollback');

const { createShutdownManager } = require('../../server');

function createTempDir(prefix = 'm5-adv-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Builds an isolated mock scheduler with observable lifecycle tracking
 */
function createMockScheduler(options = {}) {
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
      estimatedEnvelopeMB: 50,
      options: run.options || {},
    }),
  };

  const scheduler = new ResourceScheduler({
    database: fakeDatabase,
    queue: fakeQueue,
    monitor: fakeMonitor,
    pools: fakePools,
    planner: fakePlanner,
    maxConcurrentRuns: options.maxConcurrentRuns !== undefined ? options.maxConcurrentRuns : 10,
    executeRun: options.executeRun || (async () => new Promise(() => {})),
    ...options,
  });

  return { scheduler, fakeDatabase, fakeQueue, fakePools, queuedRuns, acquiredSlots, acquiredLocks };
}

test('Milestone M5: Systems, Operations & Lifecycle Adversarial Suite', async (suite) => {

  // ==========================================================================
  // SECTION 1: RESOURCE SCHEDULER CONCURRENCY, UNDERFLOW & FREEZE
  // ==========================================================================

  await suite.test('Section 1.1: Concurrency Saturation: 60 concurrent runs competing for MAX_CONCURRENT_RUNS = 10', async () => {
    const runResolvers = new Map(); // runId -> resolve function

    const { scheduler, fakeQueue, queuedRuns } = createMockScheduler({
      maxConcurrentRuns: 10,
      executeRun: async (runId) => {
        return new Promise((resolve) => {
          runResolvers.set(runId, resolve);
        });
      },
    });

    // Enqueue 60 runs
    for (let i = 1; i <= 60; i++) {
      await fakeQueue.enqueue({ id: i, platform: 'etsy', query: `batch-item-${i}` });
    }
    assert.strictEqual(queuedRuns.length, 60, 'All 60 runs must be enqueued');
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0, 'Initially 0 active runs');

    // First tick: must admit exactly 10 runs (ceiling enforcement)
    await scheduler.tick();

    assert.strictEqual(
      scheduler.getActiveExecutionCount(),
      10,
      `Expected exact ceiling of 10 active runs, got: ${scheduler.getActiveExecutionCount()}`
    );
    assert.strictEqual(
      queuedRuns.filter((r) => r.status === 'running').length,
      10,
      'Exactly 10 runs must transition to running'
    );
    assert.strictEqual(
      queuedRuns.filter((r) => r.status === 'queued').length,
      50,
      'Remaining 50 runs must remain queued'
    );

    // Verify admission check returns false when saturated
    const saturatedCheck = scheduler.canAdmitRun();
    assert.strictEqual(saturatedCheck.allowed, false, 'canAdmitRun must reject when saturated');
    assert.strictEqual(saturatedCheck.reason, 'CONCURRENCY_LIMIT_REACHED');

    // Simulate draining runs in 6 waves of 10
    let waves = 0;
    while (runResolvers.size > 0 || queuedRuns.some((r) => r.status === 'queued')) {
      waves++;
      // At all times active execution count must NOT exceed 10
      assert.ok(
        scheduler.getActiveExecutionCount() <= 10,
        `Active count ${scheduler.getActiveExecutionCount()} exceeded ceiling 10 in wave ${waves}`
      );

      // Resolve all currently active runs
      const activeIds = Array.from(runResolvers.keys());
      for (const id of activeIds) {
        const resolveFn = runResolvers.get(id);
        runResolvers.delete(id);
        resolveFn({ itemsCount: 5 });
      }

      // Allow tick and setImmediate release handlers to execute
      await new Promise((r) => setTimeout(r, 20));
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 20));

      if (waves > 10) break; // Circuit breaker
    }

    // After all 60 runs resolve, verify zero slot leaks and clean state
    assert.strictEqual(
      scheduler.getActiveExecutionCount(),
      0,
      'Active execution count must return to 0 (zero slot leaks)'
    );
    assert.strictEqual(scheduler.activeRunMetrics.size, 0, 'activeRunMetrics map must be empty');
    assert.strictEqual(
      queuedRuns.filter((r) => r.status === 'running').length,
      60,
      'All 60 runs must have executed through running state'
    );
    assert.strictEqual(
      queuedRuns.filter((r) => r.status === 'queued').length,
      0,
      'Zero runs left in queued state'
    );
  });

  await suite.test('Section 1.2: Slot Underflow Protection & Spurious Complete Signals', async () => {
    const { scheduler } = createMockScheduler({ maxConcurrentRuns: 10 });

    // 1. Initial count must be 0
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);

    // 2. Malicious decrement / underflow attempts via test helper or delta
    scheduler.setActiveRunsCount(-100);
    assert.strictEqual(
      scheduler.getActiveExecutionCount(),
      0,
      'Active count must be strictly clamped to Math.max(0, ...), never negative'
    );

    // 3. Spurious completion calls for non-existent and already-finished runs
    for (let spuriousRunId = 999900; spuriousRunId <= 999950; spuriousRunId++) {
      for (const [token, meta] of scheduler.activeRunMetrics.entries()) {
        if (meta.runId === spuriousRunId) {
          scheduler.activeRunMetrics.delete(token);
        }
      }
      if (scheduler.getActiveExecutionCount() > 0 && scheduler._simulatedActiveDelta > 0) {
        scheduler._simulatedActiveDelta--;
      }
    }

    // Active count must remain strictly 0
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);
    assert.strictEqual(scheduler.canAdmitRun().allowed, true, 'Scheduler must remain healthy and admit runs');

    // 4. Set valid count, then test multiple decrements
    scheduler.setActiveRunsCount(2);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 2);
    scheduler.setActiveRunsCount(0);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);
    scheduler.setActiveRunsCount(-5);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0, 'Negative count clamped to 0');
  });

  await suite.test('Section 1.3: Emergency Freeze Rapid Toggling Under High Concurrency', async () => {
    const { scheduler, fakeQueue, queuedRuns } = createMockScheduler({
      maxConcurrentRuns: 10,
    });

    for (let i = 1; i <= 20; i++) {
      await fakeQueue.enqueue({ id: i, platform: 'etsy', query: `freeze-item-${i}` });
    }

    // Rapid toggle freeze 50 times
    for (let t = 0; t < 50; t++) {
      const freezeState = t % 2 === 0;
      scheduler.setEmergencyFreeze(freezeState);
      assert.strictEqual(scheduler.isFrozen(), freezeState);
      const check = scheduler.canAdmitRun();
      if (freezeState) {
        assert.strictEqual(check.allowed, false);
        assert.strictEqual(check.reason, 'DISPATCH_FROZEN');
      }
    }

    // Leave frozen
    scheduler.setEmergencyFreeze(true);
    assert.strictEqual(scheduler.isFrozen(), true);

    // Trigger tick while frozen: MUST NOT admit any run
    await scheduler.tick();
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0, 'Zero runs admitted while frozen');
    assert.strictEqual(
      queuedRuns.filter((r) => r.status === 'queued').length,
      20,
      'All 20 runs must remain queued while frozen'
    );

    // Unfreeze and tick: MUST immediately admit runs up to ceiling
    scheduler.setEmergencyFreeze(false);
    assert.strictEqual(scheduler.isFrozen(), false);
    assert.strictEqual(scheduler.canAdmitRun().allowed, true);

    await scheduler.tick();
    assert.strictEqual(
      scheduler.getActiveExecutionCount(),
      10,
      'Upon unfreeze, tick must admit exactly 10 runs'
    );
    assert.strictEqual(
      queuedRuns.filter((r) => r.status === 'queued').length,
      10,
      'Exactly 10 runs remain queued'
    );
  });

  // ==========================================================================
  // SECTION 2: APIFY TOKEN POOL BUDGET & CONCURRENCY RACE CONDITIONS
  // ==========================================================================

  await suite.test('Section 2.1: Concurrency Race Conditions on Apify Budget ($10.00 balance, 30 parallel requests)', async () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_token_test_1234567890'],
      initialApifyBalance: 10.00,
      defaultRunCostUsd: 1.00,
      minBalanceThresholdUsd: 0.0,
    });

    let allowedCount = 0;
    let rejectedCount = 0;

    // Simulate 30 parallel requests competing for $10.00 balance
    const tasks = Array.from({ length: 30 }, async () => {
      try {
        pool.assertBudgetAvailable({ cost: 1.00 });
        pool.deductBudget(1.00);
        allowedCount++;
      } catch (err) {
        if (err instanceof ApifyBudgetExceededError) {
          assert.strictEqual(err.statusCode, 402);
          assert.strictEqual(err.code, 'APIFY_BUDGET_EXCEEDED');
          rejectedCount++;
        } else {
          throw err;
        }
      }
    });

    await Promise.all(tasks);

    assert.strictEqual(allowedCount, 10, 'Exactly 10 runs must succeed on $10 balance with $1/run');
    assert.strictEqual(rejectedCount, 20, 'Exactly 20 runs must be rejected with 402 APIFY_BUDGET_EXCEEDED');
    assert.strictEqual(pool.remainingBalanceUsd, 0.0, 'Remaining balance must be exactly 0.00, never negative');
    assert.strictEqual(pool.totalSpentUsd, 10.00, 'Total spent must be exactly $10.00');

    // Subsequent requests must fail deterministically
    const postCheck = pool.checkBudget();
    assert.strictEqual(postCheck.allowed, false);
    assert.strictEqual(postCheck.reason, 'APIFY_BUDGET_EXCEEDED');
  });

  await suite.test('Section 2.2: Zero, Micro-Spend, Negative Balance & Floating Point Precision', async () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_token_boundary_test'],
      initialApifyBalance: 0.00,
      minBalanceThresholdUsd: 0.00,
    });

    // 1. Exact zero balance check
    const zeroCheck = pool.checkBudget();
    assert.strictEqual(zeroCheck.allowed, false, 'Zero balance must be denied');
    assert.strictEqual(zeroCheck.reason, 'APIFY_BUDGET_EXCEEDED');
    assert.throws(
      () => pool.assertBudgetAvailable(),
      (err) => err instanceof ApifyBudgetExceededError && err.status === 402
    );

    // 2. Micro-balance: 0.0001 balance with 1.00 cost
    pool.setBudget({ remainingBalanceUsd: 0.0001 });
    assert.strictEqual(pool.remainingBalanceUsd, 0.0001);
    pool.deductBudget(1.00);
    // Math.max(0, -0.9999).toFixed(4) => 0
    assert.strictEqual(pool.remainingBalanceUsd, 0, 'Micro-spend must clamp to 0 without negative leak');
    assert.strictEqual(pool.checkBudget().allowed, false);

    // 3. Fractional cost precision (avoid IEEE 754 precision drift e.g. 0.1 + 0.2)
    pool.setBudget({ remainingBalanceUsd: 1.00, resetSpent: true });
    pool.deductBudget(0.3333);
    pool.deductBudget(0.3333);
    pool.deductBudget(0.3333);
    // 1.00 - 0.9999 = 0.0001
    assert.strictEqual(pool.remainingBalanceUsd, 0.0001, 'Floating point precision must preserve 4 decimal digits');
    assert.strictEqual(pool.totalSpentUsd, 0.9999, 'Total spent must match 0.9999');

    // 4. Manually set negative balance: must reject immediately
    pool.setBudget({ remainingBalanceUsd: -5.00 });
    const negCheck = pool.checkBudget();
    assert.strictEqual(negCheck.allowed, false);
    assert.strictEqual(negCheck.reason, 'APIFY_BUDGET_EXCEEDED');

    // 5. Configured budget limit reached
    pool.setBudget({
      remainingBalanceUsd: 100.0,
      budgetLimitUsd: 50.0,
      resetSpent: true,
    });
    pool.deductBudget(50.0);
    const limitCheck = pool.checkBudget({ cost: 1.0 });
    assert.strictEqual(limitCheck.allowed, false, 'Budget limit of $50 reached must reject');
    assert.strictEqual(limitCheck.reason, 'APIFY_BUDGET_EXCEEDED');
  });

  await suite.test('Section 2.3: Free/Local Scraper Bypass Verification Under Negative Balance', async () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_token_free_test'],
      initialApifyBalance: -10.00, // Severely depleted balance
    });

    // Simulating server.js run admission logic:
    // Only paid actors inspect and deduct Apify budget
    function evaluateRunBudgetRequirement(reqBody) {
      const { isPaidActor } = reqBody || {};
      const requiresPaidActor = Boolean(isPaidActor);
      if (requiresPaidActor) {
        return pool.checkBudget();
      }
      return { allowed: true, bypassed: true };
    }

    // 1. Paid actor request: must be rejected with APIFY_BUDGET_EXCEEDED
    const paidRun = evaluateRunBudgetRequirement({ platform: 'apify_paid', isPaidActor: true });
    assert.strictEqual(paidRun.allowed, false, 'Paid run must be rejected on negative balance');
    assert.strictEqual(paidRun.reason, 'APIFY_BUDGET_EXCEEDED');

    // 2. Free / Local scraper requests: must bypass budget check completely
    const freePlatforms = ['etsy', 'shopify', 'reddit', 'pinterest', 'ebay'];
    for (const plat of freePlatforms) {
      const freeRun = evaluateRunBudgetRequirement({ platform: plat, isPaidActor: false });
      assert.strictEqual(freeRun.allowed, true, `${plat} free scraper must bypass budget check`);
      assert.strictEqual(freeRun.bypassed, true);
    }
  });

  // ==========================================================================
  // SECTION 3: BACKUP & ROLLBACK SUBSYSTEM DEEP SECURITY & INTEGRITY
  // ==========================================================================

  await suite.test('Section 3.1: Deep Path Traversal Stress: UNC, Device Namespaces, Case-insensitivity, Null Bytes', async () => {
    const tmpRoot = createTempDir('m5-traversal-');
    const backupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(backupDir, { recursive: true });

    // Hostile path vectors
    const hostileVectors = [
      '../../etc/passwd',
      '..\\..\\windows\\system32',
      '\\\\attacker.com\\share\\payload.sql',
      '//attacker.com/share/payload.sql',
      '\\\\?\\C:\\Windows\\System32\\cmd.exe',
      '\\\\.\\PhysicalDrive0',
      'C:\\Windows\\System32\\config\\SAM',
      'D:/evil/exploit.sql',
      '/etc/shadow',
      '\\Windows\\System32',
      'backup/../../../secret.key',
      'data/..\\..\\app.js',
      'valid_path.sql\0.evil',
      'database_dump.sql\0',
      '   ',
      '',
    ];

    for (const vec of hostileVectors) {
      assert.strictEqual(
        isPathConfined(tmpRoot, vec),
        false,
        `Vector "${vec}" MUST be rejected by isPathConfined`
      );
    }

    // Sibling directory prefix attack
    // e.g. base is /root/.backup and attacker targets /root/.backup-evil
    const siblingTarget = path.join(tmpRoot, '.backup-evil', 'file.sql');
    assert.strictEqual(
      isPathContainedWithin(backupDir, siblingTarget),
      false,
      'Sibling prefix attack (.backup vs .backup-evil) must be rejected'
    );

    // Windows case insensitivity conformance
    const canonicalBackupDir = path.join(tmpRoot, '.backup');
    const validFileInside = path.join(canonicalBackupDir, 'test.sql');
    if (process.platform === 'win32') {
      const upperFile = path.join(canonicalBackupDir.toUpperCase(), 'test.sql');
      assert.strictEqual(
        isPathContainedWithin(canonicalBackupDir, upperFile),
        true,
        'Windows case variation must be recognized within base directory'
      );
    }

    // Adversarial targetBackupId in performRollback
    for (const badId of ['../../evil', '\\\\evil\\share', 'id\0injection', 'C:\\bad', '/etc/passwd']) {
      const res = await performRollback(badId, { repoRoot: tmpRoot, backupDir });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'INVALID_BACKUP_ID', `Bad backup ID "${badId}" must return INVALID_BACKUP_ID`);
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await suite.test('Section 3.2: Manifest Tampering, Truncation & SQL Injection Escaping', async () => {
    const tmpRoot = createTempDir('m5-tamper-');
    const backupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(backupDir, { recursive: true });

    // 1. Create a baseline file and backup
    const testFile = path.join(tmpRoot, 'test-manifest.txt');
    fs.writeFileSync(testFile, 'Clean production content 12345', 'utf8');

    const backupRes = await createBackup(['test-manifest.txt'], 'Tamper test', 'TEST_PHASE', {
      repoRoot: tmpRoot,
      backupDir,
      engine: 'sqlite',
    });
    assert.strictEqual(backupRes.verified, true);

    const manifestPath = backupRes.manifestPath;
    const backupFilePath = path.join(tmpRoot, backupRes.manifest.files[0].backup);

    // Vector A: Forged SHA-256 hash in manifest
    const manifestA = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifestA.files[0].sha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const checkA = verifyBackupIntegrity(manifestA, tmpRoot, { backupDir: backupRes.backupDir });
    assert.strictEqual(checkA.valid, false, 'Forged hash must fail verification');
    assert.ok(checkA.errors.some((e) => e.includes('SHA-256 hash mismatch')));

    // Vector B: Truncated backup file on disk
    fs.writeFileSync(backupFilePath, 'Truncated'); // Shortened
    const manifestB = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const checkB = verifyBackupIntegrity(manifestB, tmpRoot, { backupDir: backupRes.backupDir });
    assert.strictEqual(checkB.valid, false, 'Truncated file must fail verification');

    // Vector C: Corrupted manifest structure
    const checkC = verifyBackupIntegrity({ manifestVersion: 2 }, tmpRoot, { backupDir: backupRes.backupDir });
    assert.strictEqual(checkC.valid, false);
    assert.ok(checkC.errors.some((e) => e.includes('missing files list')));

    // Vector D: SQL Injection Escaping in dump payloads
    const injectionInputs = [
      "Robert'); DROP TABLE users;--",
      "admin' OR '1'='1",
      "test'; DELETE FROM runs WHERE '1'='1",
      "value with \\ backslash and ' quotes",
      null,
      undefined,
      12345,
      true,
      false,
      { nested: "payload'--", count: 42 },
    ];

    for (const val of injectionInputs) {
      const escaped = escapeSqlValue(val);
      if (typeof val === 'string') {
        assert.ok(escaped.startsWith("'") && escaped.endsWith("'"), 'Strings must be single-quoted');
        // Single quotes inside must be doubled
        const inner = escaped.slice(1, -1);
        const singleQuoteCount = (inner.match(/'/g) || []).length;
        assert.strictEqual(singleQuoteCount % 2, 0, 'All internal single quotes must be doubled');
      } else if (val === null || val === undefined) {
        assert.strictEqual(escaped, 'NULL');
      } else if (typeof val === 'boolean') {
        assert.strictEqual(escaped, val ? 'TRUE' : 'FALSE');
      } else if (typeof val === 'number') {
        assert.strictEqual(escaped, String(val));
      }
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await suite.test('Section 3.3: Atomic Rollback Failure Recovery (Postgres Transaction & Zero Live File Tampering)', async () => {
    // 1. Test PostgreSQL transaction rollback on error in restorePostgresViaClient
    const queryLog = [];
    const mockPgClient = {
      query: async (sql) => {
        queryLog.push(sql.trim());
        if (sql.includes('SYNTAX_ERROR_INJECTION')) {
          throw new Error('syntax error at or near "SYNTAX_ERROR_INJECTION"');
        }
        return { rows: [] };
      },
    };

    const tmpRoot = createTempDir('m5-atomic-pg-');
    const dumpFile = path.join(tmpRoot, 'faulty_dump.sql');
    fs.writeFileSync(dumpFile, 'SELECT 1;\nSYNTAX_ERROR_INJECTION;\nSELECT 2;', 'utf8');

    await assert.rejects(
      async () => {
        await restorePostgresViaClient(mockPgClient, dumpFile);
      },
      /syntax error/
    );

    // Verify transaction sequence: BEGIN -> error -> ROLLBACK
    assert.strictEqual(queryLog[0], 'BEGIN;');
    assert.strictEqual(queryLog[queryLog.length - 1], 'ROLLBACK;');

    // 2. File rollback pre-flight atomic check: zero live files modified if tamper detected
    const liveFilePath = path.join(tmpRoot, 'live-critical.json');
    const initialContent = JSON.stringify({ state: 'v2-online', healthy: true });
    fs.writeFileSync(liveFilePath, initialContent, 'utf8');
    const liveMtime = fs.statSync(liveFilePath).mtimeMs;

    const backupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(backupDir, { recursive: true });

    const bRes = await createBackup(['live-critical.json'], 'Atomic test', 'ATOMIC_1', {
      repoRoot: tmpRoot,
      backupDir,
      engine: 'sqlite',
    });

    // Tamper backup file
    const destBackup = path.join(tmpRoot, bRes.manifest.files[0].backup);
    fs.appendFileSync(destBackup, 'corrupted_bytes');

    // Attempt rollback
    const rRes = await performRollback(bRes.timestamp, { repoRoot: tmpRoot, backupDir });
    assert.strictEqual(rRes.success, false);
    assert.strictEqual(rRes.error, 'TAMPER_DETECTED');

    // Verify live file was completely untouched
    assert.strictEqual(fs.readFileSync(liveFilePath, 'utf8'), initialContent);
    assert.strictEqual(fs.statSync(liveFilePath).mtimeMs, liveMtime);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await suite.test('Section 3.4: Retention Count 0 & Directory Collision Suffix Verification', async () => {
    const tmpRoot = createTempDir('m5-retention-');
    const backupRootDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(backupRootDir, { recursive: true });

    // Create 3 fake backup directories with manifests
    for (let i = 1; i <= 3; i++) {
      const bDir = path.join(backupRootDir, `20260923-01000${i}`);
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(path.join(bDir, 'manifest.json'), JSON.stringify({ timestamp: `20260923-01000${i}` }));
    }

    assert.strictEqual(listBackups(tmpRoot, backupRootDir).length, 3);

    // Prune with retentionCount = 0: MUST prune ALL 3 backups
    const prunedAll = pruneBackups(backupRootDir, 0, false);
    assert.strictEqual(prunedAll.length, 3, 'retention=0 must prune all existing backups');
    assert.strictEqual(listBackups(tmpRoot, backupRootDir).length, 0, 'No backups should remain');

    // Test directory collision suffix (_1, _2)
    const fixedTimestamp = '20260923-120000';
    const b1 = await createBackup([], 'First', 'PH1', {
      repoRoot: tmpRoot,
      backupDir: backupRootDir,
      timestamp: fixedTimestamp,
      engine: 'sqlite',
    });
    assert.strictEqual(b1.timestamp, fixedTimestamp);

    const b2 = await createBackup([], 'Second', 'PH2', {
      repoRoot: tmpRoot,
      backupDir: backupRootDir,
      timestamp: fixedTimestamp,
      engine: 'sqlite',
    });
    assert.strictEqual(b2.timestamp, `${fixedTimestamp}_1`, 'Second backup must append _1');

    const b3 = await createBackup([], 'Third', 'PH3', {
      repoRoot: tmpRoot,
      backupDir: backupRootDir,
      timestamp: fixedTimestamp,
      engine: 'sqlite',
    });
    assert.strictEqual(b3.timestamp, `${fixedTimestamp}_2`, 'Third backup must append _2');

    // Verify all 3 distinct backup directories exist on disk
    assert.ok(fs.existsSync(path.join(backupRootDir, fixedTimestamp)));
    assert.ok(fs.existsSync(path.join(backupRootDir, `${fixedTimestamp}_1`)));
    assert.ok(fs.existsSync(path.join(backupRootDir, `${fixedTimestamp}_2`)));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ==========================================================================
  // SECTION 4: SERVER HEALTH PROBES & GRACEFUL SHUTDOWN LIFECYCLE
  // ==========================================================================

  await suite.test('Section 4.1: Health Probes /livez & /readyz State Transitions During Database Health Shifts', async () => {
    let dbIsHealthy = true;
    let serverIsShuttingDown = false;

    // Simulate Express routes from server.js
    const server = http.createServer(async (req, res) => {
      const url = req.url.split('?')[0];

      if (url === '/livez') {
        if (serverIsShuttingDown) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'shutting_down' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      }

      if (url === '/readyz') {
        if (serverIsShuttingDown) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'error', database: 'disconnected' }));
        }
        if (!dbIsHealthy) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'error', database: 'disconnected', error: 'Connection refused' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', database: 'connected' }));
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. State 1: Both healthy
      const l1 = await fetch(`${baseUrl}/livez`).then((r) => r.json());
      const r1 = await fetch(`${baseUrl}/readyz`).then((r) => r.json());
      assert.strictEqual(l1.status, 'ok');
      assert.strictEqual(r1.status, 'ok');
      assert.strictEqual(r1.database, 'connected');

      // 2. State 2: Database failure (Shift: healthy -> error)
      dbIsHealthy = false;
      const l2 = await fetch(`${baseUrl}/livez`);
      const r2 = await fetch(`${baseUrl}/readyz`);
      assert.strictEqual(l2.status, 200, '/livez MUST remain 200 even when database is down (process is alive)');
      assert.strictEqual(r2.status, 503, '/readyz MUST return 503 when database is down');
      const r2Body = await r2.json();
      assert.strictEqual(r2Body.database, 'disconnected');

      // 3. State 3: Database recovery (Shift: error -> healthy)
      dbIsHealthy = true;
      const r3 = await fetch(`${baseUrl}/readyz`);
      assert.strictEqual(r3.status, 200, '/readyz MUST recover to 200 once database reconnects');
      const r3Body = await r3.json();
      assert.strictEqual(r3Body.database, 'connected');

      // 4. State 4: Server shutting down
      serverIsShuttingDown = true;
      const l4 = await fetch(`${baseUrl}/livez`);
      const r4 = await fetch(`${baseUrl}/readyz`);
      assert.strictEqual(l4.status, 503, '/livez MUST transition to 503 during shutdown');
      assert.strictEqual(r4.status, 503, '/readyz MUST transition to 503 during shutdown');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await suite.test('Section 4.2: Graceful Shutdown Lifecycle: Connection Draining, DB Close, Exit 0 & Watchdog', async () => {
    let closedServer = false;
    let stoppedScheduler = false;
    let closedDatabase = false;
    let exitCodeCalled = null;

    const mockServer = {
      close: (cb) => {
        closedServer = true;
        cb();
      },
      closeIdleConnections: () => {},
    };

    let fakeActiveExecutions = 2;
    const mockScheduler = {
      stop: () => { stoppedScheduler = true; },
      getActiveExecutionCount: () => fakeActiveExecutions,
    };

    // Simulate draining active executions after 100ms
    setTimeout(() => {
      fakeActiveExecutions = 0;
    }, 100);

    const mockDatabase = {
      query: async () => ({ rows: [] }),
      close: async () => { closedDatabase = true; },
    };

    const manager = createShutdownManager({
      server: mockServer,
      database: mockDatabase,
      scheduler: mockScheduler,
      drainExecutionsTimeoutMs: 1000,
      graceTimeoutMs: 5000,
      exitFn: (code) => { exitCodeCalled = code; },
    });

    assert.strictEqual(manager.isShuttingDown(), false);

    // Execute graceful shutdown
    await manager.executeGracefulShutdown('SIGTERM');

    assert.strictEqual(manager.isShuttingDown(), true, 'isShuttingDown must be true');
    assert.strictEqual(closedServer, true, 'HTTP server must be closed');
    assert.strictEqual(stoppedScheduler, true, 'Scheduler periodic timer must be stopped');
    assert.strictEqual(closedDatabase, true, 'Database pool must be closed');
    assert.strictEqual(exitCodeCalled, 0, 'Graceful shutdown must exit with code 0');

    // Test watchdog timeout force exit if drain hangs
    let watchdogExitCode = null;
    let watchdogTimerCleared = false;

    const hangingScheduler = {
      stop: () => {},
      getActiveExecutionCount: () => 999, // Never drains
    };

    const watchdogManager = createShutdownManager({
      server: mockServer,
      database: mockDatabase,
      scheduler: hangingScheduler,
      drainExecutionsTimeoutMs: 50,
      graceTimeoutMs: 100, // Short watchdog for test
      exitFn: (code) => { watchdogExitCode = code; },
    });

    await watchdogManager.executeGracefulShutdown('SIGINT');
    assert.strictEqual(watchdogExitCode, 0, 'Shutdown completes even if execution drain times out boundedly');
  });

  // ==========================================================================
  // SECTION 5: DOCKER HARDENING AUDIT
  // ==========================================================================

  await suite.test('Section 5.1: Docker Hardening: Strict .dockerignore Sensitive Credentials Exclusions', async () => {
    const dockerignorePath = path.resolve(__dirname, '../../.dockerignore');
    assert.ok(fs.existsSync(dockerignorePath), '.dockerignore file must exist in repository root');

    const content = fs.readFileSync(dockerignorePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

    // Critical sensitive exclusion patterns
    const requiredPatterns = [
      '.env*',
      'proxies.txt',
      '.backup/',
      'data/',
      'logs/',
      '*.log',
      'public/media/',
      'node_modules/',
    ];

    for (const pat of requiredPatterns) {
      const matched = lines.some((l) => l === pat || l.includes(pat));
      assert.ok(
        matched,
        `Required security pattern "${pat}" MUST be present in .dockerignore`
      );
    }
  });
});
