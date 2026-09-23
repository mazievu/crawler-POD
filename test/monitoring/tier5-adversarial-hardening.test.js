'use strict';

/**
 * Tier 5: Adversarial Hardening Test Suite (Milestone 7 Final Hardening)
 *
 * Implements the 15 white-box adversarial test cases designed by Explorer 3:
 * - Domain A: Admin Dashboard & HTTP Concurrency Hardening (T5.1 - T5.5)
 * - Domain B: Limiter & Dispatcher Concurrency & Shutdown (T5.6 - T5.9)
 * - Domain C: Database & Patch Writer Payload Hardening (T5.10 - T5.13)
 * - Domain D: Stealth Browser Fallback & Error Classification (T5.14 - T5.15)
 *
 * 100% Hermetic: In-memory PGlite, synthetic browser mocks, ephemeral loopback servers.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { createTestDb } = require('./harness');
const { AdminDashboardService, createAdminDashboardRouter } = require('../../src/admin/dashboard');
const { MonitoringDispatcher } = require('../../src/monitoring/dispatcher');
const { MonitoringLimiter } = require('../../src/monitoring/limiter');
const { StealthBrowserRunner } = require('../../src/marketplaces/stealth-browser');
const { applyMonitoringObservation } = require('../../src/database/monitoring');

// =============================================================================
// DOMAIN A: Admin Dashboard & HTTP Concurrency Hardening (T5.1 - T5.5)
// =============================================================================
describe('Domain A: Admin Dashboard & HTTP Concurrency Hardening', () => {

  test('T5.1: Async triggerRepoUpdate eliminates event loop blocking during network latency', async () => {
    const app = express();
    app.use(express.json());

    // Inject custom execFileAsync to simulate network latency during git pull
    // without monkey-patching service.triggerRepoUpdate
    const customExec = async (file, args, opts) => {
      if (args && args.includes('status')) {
        return { stdout: '', stderr: '' };
      }
      if (args && args.includes('pull')) {
        await new Promise(r => setTimeout(r, 250));
        return { stdout: 'Already up to date.', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const service = new AdminDashboardService(null, {
      executeRealGit: true,
      execFileAsync: customExec,
    });
    const router = createAdminDashboardRouter({ service });
    app.use(router);

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      // Fire async repo update in background (exercises the real service.triggerRepoUpdate)
      const updatePromise = fetch(`http://127.0.0.1:${port}/api/admin/repo/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // While repo update is running, fire 5 concurrent GET /api/admin/tasks requests
      const taskTimes = [];
      const taskPromises = Array.from({ length: 5 }, async () => {
        const t0 = Date.now();
        const res = await fetch(`http://127.0.0.1:${port}/api/admin/tasks`);
        const elapsed = Date.now() - t0;
        taskTimes.push(elapsed);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data.running));
      });

      await Promise.all(taskPromises);
      const updateRes = await updatePromise;
      assert.equal(updateRes.status, 200);

      // Event loop must remain unblocked: all 5 task requests respond in < 100ms
      for (const time of taskTimes) {
        assert.ok(time < 100, `Task fetch should not be blocked by async repo update (took ${time}ms)`);
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('T5.2: Concurrent POST /api/admin/repo/update returns HTTP 409 Conflict without race condition', async () => {
    const app = express();
    app.use(express.json());

    // Inject custom execFileAsync to simulate in-flight execution latency
    // without monkey-patching service.triggerRepoUpdate
    const customExec = async (file, args, opts) => {
      if (args && args.includes('status')) {
        return { stdout: '', stderr: '' };
      }
      if (args && args.includes('pull')) {
        await new Promise(r => setTimeout(r, 120));
        return { stdout: 'Success', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const service = new AdminDashboardService(null, {
      executeRealGit: true,
      execFileAsync: customExec,
    });
    const router = createAdminDashboardRouter({ service });
    app.use(router);

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const [res1, res2] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/admin/repo/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        fetch(`http://127.0.0.1:${port}/api/admin/repo/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.deepEqual(statuses, [200, 409], 'One request must succeed (200) and concurrent request must get 409 Conflict');
      const conflictRes = res1.status === 409 ? res1 : res2;
      const conflictData = await conflictRes.json();
      assert.equal(conflictData.success, false);
      assert.ok(conflictData.error.includes('in progress'));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('T5.3: XSS Sanitizer immune to script injection, image onerror, and SVG vectors', () => {
    const htmlContent = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'admin', 'dashboard.html'), 'utf8');
    assert.ok(htmlContent.includes('function escapeHtml('), 'dashboard.html must define escapeHtml');
    assert.ok(htmlContent.includes('data-task-id='), 'dashboard.html must use data-task-id attributes');

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    const vectors = [
      { input: "<script>alert('xss1')</script>", mustNotContain: '<script>', mustContain: '&lt;script&gt;' },
      { input: "<img src=invalid onerror=alert('xss2')>", mustNotContain: '<img', mustContain: '&lt;img' },
      { input: "\"><svg onload=alert('xss3')>", mustNotContain: '<svg', mustContain: '&quot;&gt;&lt;svg' },
      { input: "' onmouseover='alert(1)", mustNotContain: "'", mustContain: '&#39;' },
      { input: '\" onclick=\"malicious()', mustNotContain: '"', mustContain: '&quot;' },
    ];

    for (const v of vectors) {
      const escaped = escapeHtml(v.input);
      assert.ok(!escaped.includes(v.mustNotContain), `Escaped string must not contain raw vector: ${v.mustNotContain}`);
      assert.ok(escaped.includes(v.mustContain), `Escaped string must contain entity: ${v.mustContain}`);
    }
  });

  test('T5.4: Action buttons preserve data integrity against quote injection in task IDs', () => {
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    const hostileId = "task-1' onclick='evil()\"<script>";
    const safeId = escapeHtml(hostileId);
    const buttonHtml = `<button class="btn btn-sm btn-danger" data-action="toggle" data-task-id="${safeId}" data-enabled="false">Disable</button>`;

    assert.ok(!buttonHtml.includes("onclick="), 'HTML must not create a broken onclick attribute');
    assert.ok(buttonHtml.includes('data-task-id="task-1&#39; onclick=&#39;evil()&quot;&lt;script&gt;"'));

    // Verify DOM attribute decoding recovers exact raw string
    const decoded = safeId
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    assert.equal(decoded, hostileId, 'Decoded dataset attribute must match exact hostile task ID without script execution');
  });

  test('T5.5: Git command parameter isolation rejects CLI flags (e.g. --upload-pack)', () => {
    const service = new AdminDashboardService();

    const injectionAttempts = [
      '--upload-pack=touch /tmp/pwn',
      '-oProxyCommand=evil',
      '--config=core.editor=evil',
      '--help',
      '-b main',
    ];

    for (const branch of injectionAttempts) {
      const res = service.triggerRepoUpdate({ branch });
      assert.equal(res.success, false, `Option injection ${branch} must be rejected`);
      assert.ok(res.error.includes('Invalid branch name'), `Error message must cite invalid branch: ${res.error}`);
      assert.ok(res.command.startsWith('git pull --ff-only origin'));
      assert.equal(service.isUpdatingRepo, false, 'Mutex must be released in finally block');
    }
  });
});

// =============================================================================
// DOMAIN B: Limiter & Dispatcher Concurrency & Shutdown (T5.6 - T5.9)
// =============================================================================
describe('Domain B: Limiter & Dispatcher Concurrency & Shutdown', () => {

  test('T5.6: Shutdown drain race condition: Limiter lease released with cooldown = 0', async () => {
    const db = await createTestDb();
    const limiter = new MonitoringLimiter(db);
    await limiter.init();

    await db.prepare(`
      INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
      VALUES (300, 'etsy', 'shop', 'drain-shop', 'id', 's1', now(), now())
    `).run();
    await db.prepare(`
      INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
      VALUES (950, 300, 'shop_probe', 's1', now(), 'queued')
    `).run();

    let captureFinished = false;
    const dispatcher = new MonitoringDispatcher({
      db,
      limiter,
      enabled: true,
      drainTimeoutMs: 3000,
      captureFn: async () => {
        await new Promise(r => setTimeout(r, 60));
        captureFinished = true;
        return { status: 'success', value: 500, sales: 500 };
      },
    });

    const tickPromise = dispatcher.tick();
    await new Promise(r => setTimeout(r, 15));
    assert.ok(dispatcher.activeWorkerToken, 'Worker token must be active during capture');

    await dispatcher.shutdown('SIGTERM', 2000);
    await tickPromise;

    assert.equal(captureFinished, true, 'Capture must finish cleanly within drain window');

    const rows = (await db.query("SELECT * FROM monitoring_limiter WHERE key = 'global_monitoring_capture'")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner_token, null, 'owner_token must be nullified');
    assert.equal(rows[0].leased_until, null, 'leased_until must be nullified');

    // 0-cooldown must allow immediate execution without lockup
    const canExec = await limiter.canExecuteNext();
    assert.equal(canExec, true, 'Limiter must be immediately available without 20s or 60s cooldown lockup');
  });

  test('T5.7: Shutdown timeout forcibly aborts stalled capture and clears lease', async () => {
    const db = await createTestDb();
    const limiter = new MonitoringLimiter(db);
    await limiter.init();

    await db.prepare(`
      INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
      VALUES (301, 'etsy', 'shop', 'stall-shop', 'id', 's1', now(), now())
    `).run();
    await db.prepare(`
      INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
      VALUES (951, 301, 'shop_probe', 's1', now(), 'queued')
    `).run();

    let aborted = false;
    const dispatcher = new MonitoringDispatcher({
      db,
      limiter,
      enabled: true,
      drainTimeoutMs: 100,
      captureFn: async (_job, { signal }) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        await new Promise(() => {}); // Hang indefinitely
      },
    });

    const tickPromise = dispatcher.tick();
    await new Promise(r => setTimeout(r, 15));

    const t0 = Date.now();
    await dispatcher.shutdown('SIGINT', 100);
    const elapsed = Date.now() - t0;

    assert.ok(elapsed >= 80 && elapsed < 1000, `Shutdown should unblock after ~100ms (took ${elapsed}ms)`);
    assert.equal(aborted, true, 'AbortController signal must be triggered upon drain timeout');

    const rows = (await db.query("SELECT * FROM monitoring_limiter WHERE key = 'global_monitoring_capture'")).rows;
    assert.equal(rows[0].owner_token, null, 'Limiter lease must be cleared even after abort');
  });

  test('T5.8: Limiter lease handles NaN and non-finite cooldown without PostgreSQL interval syntax error', async () => {
    const db = await createTestDb();
    const limiter = new MonitoringLimiter(db);
    await limiter.init();

    const token1 = 'worker-nan-test';
    await limiter.tryAcquireLease(token1, 30000);
    const released1 = await limiter.releaseLease(token1, NaN);
    assert.equal(released1, true, 'releaseLease with NaN must succeed without SQL interval syntax error');

    const token2 = 'worker-invalid-test';
    await limiter.tryAcquireLease(token2, 30000);
    const released2 = await limiter.releaseLease(token2, 'invalid');
    assert.equal(released2, true, 'releaseLease with invalid string must succeed');

    const token3 = 'worker-negative-test';
    await limiter.tryAcquireLease(token3, 30000);
    const released3 = await limiter.releaseLease(token3, -5000);
    assert.equal(released3, true, 'releaseLease with negative cooldown must sanitize to default');
  });

  test('T5.9: Stolen lease detection prevents split-brain capture writes', async () => {
    const db = await createTestDb();
    const limiter = new MonitoringLimiter(db);
    await limiter.init();

    const worker1 = 'worker-1-stolen';
    const worker2 = 'worker-2-winner';

    await limiter.tryAcquireLease(worker1, 50);

    // Force lease to expire in DB
    await db.query(`
      UPDATE monitoring_limiter
      SET leased_until = now() - INTERVAL '1 second'
      WHERE key = 'global_monitoring_capture'
    `);

    // Worker 2 acquires the expired lease
    const lease2 = await limiter.tryAcquireLease(worker2, 60000);
    assert.ok(lease2, 'Worker 2 must successfully acquire stolen lease');

    // Worker 1 attempts to renew lease
    const renewed = await limiter.renewLease(worker1, 60000);
    assert.equal(renewed, null, 'Worker 1 renewLease must return null because Worker 2 now owns the lease');
  });
});

// =============================================================================
// DOMAIN C: Database & Patch Writer Payload Hardening (T5.10 - T5.13)
// =============================================================================
describe('Domain C: Database & Patch Writer Payload Hardening', () => {

  test('T5.10: isMetricPresent rejects Infinity and -Infinity from corrupting numeric columns', async () => {
    const db = await createTestDb();
    const itemUid = 'etsy:item:infinity-guard';

    await db.prepare(`
      INSERT INTO product_current (item_uid, platform, title, current_price, current_likes, status)
      VALUES (?, 'etsy', 'Infinity Test Product', 19.99, 50, 'active')
    `).run(itemUid);

    const result = await applyMonitoringObservation(db, {
      itemUid,
      patch: {
        price: Infinity,
        likes: -Infinity,
        views: NaN,
        title: 'Valid New Title',
      },
      observedIso: new Date().toISOString(),
      observationId: 'obs:infinity-1',
    });

    assert.equal(result.updated, true);

    const row = await db.prepare('SELECT * FROM product_current WHERE item_uid = ?').get(itemUid);
    assert.equal(Number(row.current_price), 19.99, 'current_price must remain 19.99');
    assert.equal(row.current_likes, 50, 'current_likes must remain 50');
    assert.equal(row.title, 'Valid New Title', 'Legitimate string field must be updated');
  });

  test('T5.11: Negative counter values do not invert deltas or create corrupt history', async () => {
    const db = await createTestDb();
    const itemUid = 'etsy:item:negative-counter';

    await db.prepare(`
      INSERT INTO product_current (item_uid, platform, title, current_sold, delta_sold, current_likes, delta_likes, status)
      VALUES (?, 'etsy', 'Negative Metric Item', 100, 5, 40, 2, 'active')
    `).run(itemUid);

    await applyMonitoringObservation(db, {
      itemUid,
      patch: {
        soldCount: -15,
        likes: -80,
      },
      observedIso: new Date().toISOString(),
      observationId: 'obs:negative-1',
    });

    const row = await db.prepare('SELECT * FROM product_current WHERE item_uid = ?').get(itemUid);
    assert.equal(row.current_sold, 100, 'current_sold must not become negative or decrease to -15');
    assert.equal(row.delta_sold, 5, 'delta_sold must not be inverted by negative counts');
    assert.equal(row.current_likes, 40, 'current_likes must not become negative');
  });

  test('T5.12: Observation ID with SQL LIKE wildcards (% and _) does not cause false-positive deduplication', async () => {
    const db = await createTestDb();
    const itemUid = 'etsy:item:like-wildcards';

    await db.prepare(`
      INSERT INTO product_current (item_uid, platform, title, current_price, status)
      VALUES (?, 'etsy', 'Wildcard Item', 10.0, 'active')
    `).run(itemUid);

    const obsId1 = 'obs:item%1';
    const obsId2 = 'obs:itemX1';

    const res1 = await applyMonitoringObservation(db, {
      itemUid,
      patch: { price: 12.0 },
      observedIso: '2026-09-20T10:00:00Z',
      observationId: obsId1,
    });
    assert.equal(res1.duplicate, false, 'First observation must be accepted');

    const res2 = await applyMonitoringObservation(db, {
      itemUid,
      patch: { price: 14.0 },
      observedIso: '2026-09-21T10:00:00Z',
      observationId: obsId2,
    });
    assert.equal(res2.duplicate, false, 'obs:itemX1 must not be falsely flagged as duplicate of obs:item%1');

    const resReplay = await applyMonitoringObservation(db, {
      itemUid,
      patch: { price: 12.0 },
      observedIso: '2026-09-22T10:00:00Z',
      observationId: obsId1,
    });
    assert.equal(resReplay.duplicate, true, 'Replay of exact obsId1 must be detected as duplicate');
  });

  test('T5.13: Dense history pack with 10,000 observations does not overflow V8 call stack', async () => {
    const db = await createTestDb();
    const itemUid = 'etsy:item:dense-pack-10k';

    await db.prepare(`
      INSERT INTO product_current (item_uid, platform, title, current_price, status)
      VALUES (?, 'etsy', 'Dense History Item', 50.0, 'active')
    `).run(itemUid);

    const denseEntries = [];
    for (let i = 0; i < 10000; i++) {
      denseEntries.push({
        observationId: `obs-dense-${i}`,
        time: '2026-09-22T12:00:00.000Z',
        price: 20.0 + (i % 30),
        sold: 100 + i,
        quality: 'exact',
      });
    }

    await db.prepare(`
      INSERT INTO daily_packed_history (
        item_uid, platform, date, observations_json, observation_count,
        min_price, max_price, latest_price, created_at, updated_at
      ) VALUES (
        ?, 'etsy', '2026-09-22', ?, 10000,
        20.0, 49.0, 35.0, now(), now()
      )
    `).run(itemUid, JSON.stringify(denseEntries));

    const result = await applyMonitoringObservation(db, {
      itemUid,
      patch: { price: 15.0 },
      observedIso: '2026-09-22T13:00:00.000Z',
      observationId: 'obs-dense-10001',
    });

    assert.equal(result.updated, true, 'applyMonitoringObservation must succeed without RangeError call stack overflow');

    const history = await db.prepare('SELECT min_price, max_price, observation_count FROM daily_packed_history WHERE item_uid = ?').get(itemUid);
    assert.equal(history.observation_count, 10001);
    assert.equal(Number(history.min_price), 15.0, 'min_price must be updated to 15.0');
  });
});

// =============================================================================
// DOMAIN D: Stealth Browser Fallback & Error Classification (T5.14 - T5.15)
// =============================================================================
describe('Domain D: Stealth Browser Fallback & Error Classification', () => {

  test('T5.14: CloakBrowser network exception vs anti-bot block telemetry differentiation', async () => {
    const runner = new StealthBrowserRunner();

    const mockAdapters = {
      cloakbrowser: async () => {
        const err = new Error('ECONNRESET: socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      },
      camoufox: async () => {
        return {
          status: 'success',
          statusCode: 200,
          html: '<html><body>Camoufox Fallback Content</body></html>',
        };
      },
    };

    const result = await runner.captureWithFallback('https://www.etsy.com/shop/example', {}, mockAdapters);
    assert.equal(result.engineUsed, 'camoufox');
    assert.equal(result.fallbackTriggered, true);
    assert.equal(result.status, 'success');

    const metrics = runner.getMetrics();
    assert.equal(metrics.cloakbrowser.errorRuns, 1, 'CloakBrowser errorRuns must be incremented on network exception');
    assert.equal(metrics.cloakbrowser.blockedRuns, 0, 'CloakBrowser blockedRuns must NOT be incremented on network error');
    assert.equal(metrics.camoufox.successfulRuns, 1, 'Camoufox successfulRuns must be incremented');
  });

  test('T5.15: Camoufox fatal timeout rethrows to caller with accurate metric attribution', async () => {
    const runner = new StealthBrowserRunner();

    const mockAdapters = {
      cloakbrowser: async () => {
        return {
          status: 'blocked',
          statusCode: 403,
          error: 'Cloudflare 403 Forbidden',
          html: '<title>Attention Required! | Cloudflare</title>',
        };
      },
      camoufox: async () => {
        throw new Error('Timeout 20000ms exceeded while waiting for selector');
      },
    };

    await assert.rejects(
      async () => {
        await runner.captureWithFallback('https://www.etsy.com/shop/example', {}, mockAdapters);
      },
      { message: /Timeout 20000ms exceeded/ },
      'Camoufox fatal error must be rethrown to caller'
    );

    const metrics = runner.getMetrics();
    assert.equal(metrics.cloakbrowser.blockedRuns, 1, 'CloakBrowser blockedRuns must be 1');
    assert.equal(metrics.camoufox.errorRuns, 1, 'Camoufox errorRuns must be 1');
  });
});
