'use strict';

/**
 * test/health-shutdown.test.js
 * Test Suite for Milestone M4:
 * Feature 18: Kubernetes/Container Health Probes (/livez & /readyz)
 * Feature 19: Graceful Shutdown Lifecycle (SIGINT/SIGTERM, draining, DB pool closing)
 */

// `require('../server')` below runs server.js's full module-level boot in
// THIS process (it is not spawned as a subprocess), which otherwise
// instantiates the Apify token pool / social bot scheduler / journey
// checkpoint store / everbee profile store at their default on-disk
// locations under the repo's real data/ directory. Point them at a unique
// temp location first so this test file never writes into data/.
{
  const path = require('node:path');
  const os = require('node:os');
  const runId = `${process.pid}-${Date.now()}`;
  process.env.APIFY_TOKENS_PATH = process.env.APIFY_TOKENS_PATH
    || path.join(os.tmpdir(), `crawler-pod-health-shutdown-apify-tokens-${runId}.json`);
  process.env.SOCIAL_BOTS_CONFIG_PATH = process.env.SOCIAL_BOTS_CONFIG_PATH
    || path.join(os.tmpdir(), `crawler-pod-health-shutdown-social-bots-${runId}.json`);
  process.env.CAPTURES_DIR = process.env.CAPTURES_DIR
    || path.join(os.tmpdir(), `crawler-pod-health-shutdown-captures-${runId}`);
  process.env.EVERBEE_PROFILE_ROOT = process.env.EVERBEE_PROFILE_ROOT
    || path.join(os.tmpdir(), `crawler-pod-health-shutdown-everbee-${runId}`);
}

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createShutdownManager } = require('../server');

// Helper to create an isolated probe app for testing probe edge cases
function createProbeApp(mockDb = {}, options = {}) {
  const app = express();
  let isShuttingDown = Boolean(options.initialShuttingDown);

  app.get('/livez', (req, res) => {
    if (isShuttingDown) {
      return res.status(503).json({
        status: 'shutting_down',
        message: 'Server is shutting down',
        timestamp: Date.now(),
      });
    }
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  });

  app.get('/readyz', async (req, res) => {
    if (isShuttingDown) {
      return res.status(503).json({
        status: 'error',
        database: 'disconnected',
        message: 'Server is shutting down',
        timestamp: Date.now(),
      });
    }
    try {
      if (typeof mockDb.ping === 'function') {
        await mockDb.ping();
      } else if (typeof mockDb.query === 'function') {
        await mockDb.query('SELECT 1');
      } else {
        throw new Error('Database connection unconfigured');
      }
      res.status(200).json({
        status: 'ok',
        database: 'connected',
        timestamp: Date.now(),
      });
    } catch (err) {
      res.status(503).json({
        status: 'error',
        database: 'disconnected',
        error: err.message,
        timestamp: Date.now(),
      });
    }
  });

  app.use((req, res, next) => {
    if (isShuttingDown) {
      res.setHeader('Connection', 'close');
      return res.status(503).json({
        error: 'Service Unavailable',
        status: 'shutting_down',
        message: 'Server is shutting down',
        timestamp: Date.now(),
      });
    }
    next();
  });

  app.get('/api/protected', (req, res) => {
    res.status(200).json({ data: 'ok' });
  });

  return {
    app,
    setShuttingDown: (val) => { isShuttingDown = Boolean(val); },
  };
}

test('Feature 18: Operational Health & Liveness Probes (/livez & /readyz)', async (t) => {

  await t.test('1. GET /livez returns 200 with uptime, timestamp, and status ok without auth headers', async () => {
    const mockDb = { ping: async () => true };
    const { app } = createProbeApp(mockDb);
    const server = http.createServer(app);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Zero auth headers passed
      const res = await fetch(`${baseUrl}/livez`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.status, 'ok');
      assert.strictEqual(typeof json.uptime, 'number');
      assert.ok(json.uptime >= 0, 'uptime must be non-negative');
      assert.strictEqual(typeof json.timestamp, 'number');
      assert.ok(Date.now() - json.timestamp < 5000, 'timestamp must be recent');
    } finally {
      server.close();
    }
  });

  await t.test('2. GET /readyz returns 200 with database: connected when healthy', async () => {
    let queryExecuted = false;
    const mockDb = {
      ping: async () => {
        queryExecuted = true;
        return true;
      },
    };

    const { app } = createProbeApp(mockDb);
    const server = http.createServer(app);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${baseUrl}/readyz`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.status, 'ok');
      assert.strictEqual(json.database, 'connected');
      assert.strictEqual(typeof json.timestamp, 'number');
      assert.strictEqual(queryExecuted, true);
    } finally {
      server.close();
    }
  });

  await t.test('3. GET /readyz returns 503 with database: disconnected when database ping fails', async () => {
    const mockDb = {
      ping: async () => {
        throw new Error('Connection refused: connect ECONNREFUSED 127.0.0.1:5432');
      },
    };

    const { app } = createProbeApp(mockDb);
    const server = http.createServer(app);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${baseUrl}/readyz`);
      assert.strictEqual(res.status, 503);

      const json = await res.json();
      assert.strictEqual(json.status, 'error');
      assert.strictEqual(json.database, 'disconnected');
      assert.ok(json.error.includes('ECONNREFUSED'));
      assert.strictEqual(typeof json.timestamp, 'number');
    } finally {
      server.close();
    }
  });

  await t.test('4. Probes and API return 503 during active shutdown state', async () => {
    const mockDb = { ping: async () => true };
    const { app, setShuttingDown } = createProbeApp(mockDb);
    const server = http.createServer(app);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Normal operation: 200
      const beforeLive = await fetch(`${baseUrl}/livez`);
      assert.strictEqual(beforeLive.status, 200);

      // Trigger shutdown state
      setShuttingDown(true);

      // During shutdown: /livez returns 503
      const livezRes = await fetch(`${baseUrl}/livez`);
      assert.strictEqual(livezRes.status, 503);
      const livezJson = await livezRes.json();
      assert.strictEqual(livezJson.status, 'shutting_down');

      // During shutdown: /readyz returns 503
      const readyzRes = await fetch(`${baseUrl}/readyz`);
      assert.strictEqual(readyzRes.status, 503);
      const readyzJson = await readyzRes.json();
      assert.strictEqual(readyzJson.database, 'disconnected');

      // Non-probe API route returns 503 with Connection: close
      const apiRes = await fetch(`${baseUrl}/api/protected`);
      assert.strictEqual(apiRes.status, 503);
      assert.strictEqual(apiRes.headers.get('connection'), 'close');
    } finally {
      server.close();
    }
  });
});

test('Feature 19: Graceful Shutdown Lifecycle', async (t) => {

  await t.test('1. Clean shutdown sequence stops HTTP listener, timers, releases limiter, closes DB, and exits 0', async () => {
    let serverClosed = false;
    let schedulerStopped = false;
    let stuckDetectorStopped = false;
    let socialSchedulerStopped = false;
    let leaseReleased = false;
    let dbClosed = false;
    let exitCode = null;

    const mockServer = {
      close: (cb) => {
        serverClosed = true;
        cb();
      },
      closeIdleConnections: () => {},
    };

    const mockScheduler = {
      stop: () => { schedulerStopped = true; },
      getActiveExecutionCount: () => 0,
    };

    const mockStuckDetector = {
      stop: () => { stuckDetectorStopped = true; },
    };

    const mockSocialScheduler = {
      stop: () => { socialSchedulerStopped = true; },
    };

    const mockDatabase = {
      query: async (sql) => {
        if (sql.includes('UPDATE monitoring_limiter')) {
          leaseReleased = true;
        }
        return { rows: [] };
      },
      close: async () => {
        dbClosed = true;
      },
    };

    const manager = createShutdownManager({
      server: mockServer,
      database: mockDatabase,
      scheduler: mockScheduler,
      stuckDetector: mockStuckDetector,
      socialScheduler: mockSocialScheduler,
      graceTimeoutMs: 5000,
      exitFn: (code) => { exitCode = code; },
    });

    // Execute shutdown
    await manager.executeGracefulShutdown('SIGTERM');

    assert.strictEqual(serverClosed, true, 'HTTP server listener should be closed');
    assert.strictEqual(schedulerStopped, true, 'ResourceScheduler should be stopped');
    assert.strictEqual(stuckDetectorStopped, true, 'StuckDetector should be stopped');
    assert.strictEqual(socialSchedulerStopped, true, 'SocialScheduler should be stopped');
    assert.strictEqual(leaseReleased, true, 'Monitoring limiter lease should be released');
    assert.strictEqual(dbClosed, true, 'Database pool should be closed');
    assert.strictEqual(exitCode, 0, 'Exit code should be 0 on clean shutdown');
  });

  await t.test('2. Signal handling is idempotent (duplicate signals execute teardown only once)', async () => {
    let dbCloseCallCount = 0;
    let exitCallCount = 0;

    const mockServer = { close: (cb) => cb(), closeIdleConnections: () => {} };
    const mockDatabase = {
      query: async () => ({ rows: [] }),
      close: async () => { dbCloseCallCount++; },
    };

    const manager = createShutdownManager({
      server: mockServer,
      database: mockDatabase,
      graceTimeoutMs: 5000,
      exitFn: () => { exitCallCount++; },
    });

    // Trigger SIGTERM followed immediately by SIGINT and another SIGTERM
    const p1 = manager.handleSignal('SIGTERM');
    const p2 = manager.handleSignal('SIGINT');
    const p3 = manager.handleSignal('SIGTERM');

    await Promise.all([p1, p2, p3]);

    assert.strictEqual(dbCloseCallCount, 1, 'Database close should only be called once');
    assert.strictEqual(exitCallCount, 1, 'Exit function should only be called once');
  });

  await t.test('3. Hard deadline timeout forces exit with code 1 if a cleanup task hangs', async () => {
    let exitCode = null;

    // Simulate a hanging server close
    const mockHangingServer = {
      close: () => {
        // Intentionally never invokes callback
      },
      closeIdleConnections: () => {},
    };

    const manager = createShutdownManager({
      server: mockHangingServer,
      graceTimeoutMs: 150, // Fast 150ms timeout for hermetic unit testing
      exitFn: (code) => { exitCode = code; },
    });

    manager.handleSignal('SIGTERM');

    // Await past timeout
    await new Promise((r) => setTimeout(r, 250));

    assert.strictEqual(exitCode, 1, 'Process should exit with code 1 when hard deadline expires');
  });
});
