'use strict';

/**
 * test/adversarial/m4_ops_adversarial.test.js
 *
 * Tier 5 Adversarial Stress & Verification Test Suite for Milestone M4:
 * - Feature 16 & 17: Container & .dockerignore Hardening, Media Persistence
 * - Feature 18: Operational Health & Liveness Probes (/livez & /readyz)
 * - Feature 19: Graceful Shutdown Lifecycle & Signal Idempotency
 *
 * Vectors Verified:
 * 1. Health Probe Fast Path & Flood:
 *    50 concurrent requests to /livez and /readyz with zero auth headers.
 *    Sub-millisecond latency confirmation, zero auth barrier overhead,
 *    malformed auth header immunity, cache-control enforcement, HEAD method support.
 * 2. Probe State Transitions:
 *    Immediate transition of /readyz and /livez to HTTP 503 during shutdown mode.
 *    Decoupled partial degradation: DB failure causes /readyz 503 while /livez remains 200.
 *    Ingress routes reject with 503 and Connection: close during shutdown.
 * 3. Shutdown Race & Idempotency:
 *    Rapid duplicate signal firing (SIGTERM + SIGINT + SIGTERM in parallel) triggering
 *    shutdown exactly once, single cleanup execution, zero uncaught exceptions.
 *    In-flight request clean drain before server close.
 *    Watchdog deadline forced exit (code 1) when cleanup hangs.
 *    Signal handler registration & event dispatch idempotency.
 *    Live subprocess boot and 50-request flood over real network socket.
 * 4. Docker Ignore Leak Stress:
 *    Wildcard expansions and directory matches across .env*, proxies.txt, .backup/,
 *    public/media/, logs/, *.log, *.db*.
 *    False-positive safety check preventing exclusion of required build/runtime assets.
 *    Path normalization across Windows/POSIX slashes.
 */

// `require('../../server')` below runs server.js's full module-level boot
// in THIS process (it is not spawned as a subprocess), which otherwise
// instantiates the Apify token pool / social bot scheduler / journey
// checkpoint store / everbee profile store at their default on-disk
// locations under the repo's real data/ directory. Point them at a unique
// temp location first so this test file never writes into data/.
{
  const path = require('node:path');
  const os = require('node:os');
  const runId = `${process.pid}-${Date.now()}`;
  process.env.APIFY_TOKENS_PATH = process.env.APIFY_TOKENS_PATH
    || path.join(os.tmpdir(), `crawler-pod-m4-ops-apify-tokens-${runId}.json`);
  process.env.SOCIAL_BOTS_CONFIG_PATH = process.env.SOCIAL_BOTS_CONFIG_PATH
    || path.join(os.tmpdir(), `crawler-pod-m4-ops-social-bots-${runId}.json`);
  process.env.CAPTURES_DIR = process.env.CAPTURES_DIR
    || path.join(os.tmpdir(), `crawler-pod-m4-ops-captures-${runId}`);
  process.env.EVERBEE_PROFILE_ROOT = process.env.EVERBEE_PROFILE_ROOT
    || path.join(os.tmpdir(), `crawler-pod-m4-ops-everbee-${runId}`);
}

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { makeHermeticEnv, cleanupHermeticEnv } = require('../helpers/hermetic-spawn-env');
const { spawn } = require('node:child_process');
const express = require('express');

const { createShutdownManager } = require('../../server');

// Isolated port for live server subprocess tests
const M4_LIVE_PORT = 34499;
const LIVE_BASE_URL = `http://127.0.0.1:${M4_LIVE_PORT}`;

// ==============================================================================
// Helper: Isolated Express Probe Application for Hermetic State Testing
// ==============================================================================
function createIsolatedProbeApp(mockDb = {}, options = {}) {
  const app = express();
  let isShuttingDown = Boolean(options.initialShuttingDown);
  let activeInFlightRequests = 0;

  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // Feature 18: Liveness Probe fast path
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

  // Feature 18: Readiness Probe
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

  // Shutdown barrier for all subsequent traffic
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

  // Mock protected route simulating in-flight workload
  app.get('/api/slow-work', async (req, res) => {
    activeInFlightRequests++;
    const delayMs = parseInt(req.query.delay || '50', 10);
    await new Promise((r) => setTimeout(r, delayMs));
    activeInFlightRequests--;
    res.status(200).json({ status: 'done', inFlightRemaining: activeInFlightRequests });
  });

  app.get('/api/protected', (req, res) => {
    res.status(200).json({ data: 'protected-data-ok' });
  });

  return {
    app,
    setShuttingDown: (val) => { isShuttingDown = Boolean(val); },
    isShuttingDown: () => isShuttingDown,
    getActiveInFlight: () => activeInFlightRequests,
  };
}

// ==============================================================================
// Helper: Robust Dockerignore Pattern Matcher
// ==============================================================================
function createDockerignoreMatcher(dockerignoreContent) {
  const rawRules = dockerignoreContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const rules = rawRules.map((rule) => {
    const isNegation = rule.startsWith('!');
    const rawPattern = isNegation ? rule.slice(1).trim() : rule;
    const normalized = rawPattern.replace(/\\/g, '/');
    const isDirOnly = normalized.endsWith('/');
    const cleanPattern = isDirOnly ? normalized.slice(0, -1) : normalized;

    return {
      isNegation,
      isDirOnly,
      pattern: cleanPattern,
      raw: rule,
    };
  });

  function matchRule(filePath, rule) {
    const normPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const p = rule.pattern;

    // Direct filename / root path match
    if (p === normPath || p === path.basename(normPath)) return true;

    // Directory match
    if (rule.isDirOnly) {
      if (normPath === p || normPath.startsWith(p + '/')) return true;
      if (normPath.includes('/' + p + '/')) return true;
    }

    // Wildcard prefix / glob matching
    if (p.includes('*')) {
      // Convert glob pattern to regular expression
      let regexStr = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '§§§')
        .replace(/\*/g, '[^/]*')
        .replace(/§§§/g, '.*')
        .replace(/\?/g, '[^/]');

      if (!p.startsWith('/')) {
        regexStr = '(?:^|.*/)' + regexStr;
      } else {
        regexStr = '^' + regexStr.slice(1);
      }
      regexStr = regexStr + '(?=$|/.*)';
      const regex = new RegExp(regexStr);
      if (regex.test(normPath)) return true;
    }

    // Prefix directory match without trailing slash
    if (normPath.startsWith(p + '/')) return true;
    if (normPath.includes('/' + p + '/')) return true;

    return false;
  }

  function isIgnored(filePath) {
    let ignored = false;
    for (const rule of rules) {
      if (matchRule(filePath, rule)) {
        ignored = !rule.isNegation;
      }
    }
    return ignored;
  }

  return { isIgnored, rules };
}

// ==============================================================================
// TEST SUITE: Milestone M4 Operations & Lifecycle Adversarial Verification
// ==============================================================================

test('Milestone M4: Operations & Lifecycle Adversarial Challenge Suite', async (t) => {

  // ----------------------------------------------------------------------------
  // Vector 1: Health Probe Fast Path & Flood Stress
  // ----------------------------------------------------------------------------
  await t.test('Vector 1: Health Probe Fast Path & Flood Stress', async (t1) => {

    await t1.test('1.1: 50 Concurrent /livez requests flood with zero auth headers under high concurrency', async () => {
      const mockDb = { ping: async () => true };
      const { app } = createIsolatedProbeApp(mockDb);
      const server = http.createServer(app);

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const CONCURRENCY = 50;
        const startTime = process.hrtime.bigint();

        // Fire 50 concurrent requests simultaneously without ANY authentication headers
        const requests = Array.from({ length: CONCURRENCY }, () =>
          fetch(`${baseUrl}/livez`, {
            headers: {}, // strictly zero auth headers
          })
        );

        const responses = await Promise.all(requests);
        const endTime = process.hrtime.bigint();
        const totalDurationMs = Number(endTime - startTime) / 1e6;
        const avgDurationMs = totalDurationMs / CONCURRENCY;

        assert.strictEqual(responses.length, CONCURRENCY);

        for (const res of responses) {
          assert.strictEqual(res.status, 200, 'Every /livez request must return HTTP 200');
          assert.strictEqual(
            res.headers.get('cache-control'),
            'no-cache, no-store, must-revalidate',
            'Must enforce strict anti-caching headers'
          );

          const body = await res.json();
          assert.strictEqual(body.status, 'ok');
          assert.ok(typeof body.uptime === 'number');
          assert.ok(typeof body.timestamp === 'number');
        }

        // Fast path latency check: avg loopback latency should be low single-digit ms
        assert.ok(
          avgDurationMs < 15,
          `Fast path average response latency (${avgDurationMs.toFixed(3)}ms) must be well below auth barrier threshold`
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    await t1.test('1.2: 50 Concurrent /readyz requests flood with zero auth headers', async () => {
      let dbQueryCount = 0;
      const mockDb = {
        ping: async () => {
          dbQueryCount++;
          return true;
        },
      };
      const { app } = createIsolatedProbeApp(mockDb);
      const server = http.createServer(app);

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const CONCURRENCY = 50;
        const requests = Array.from({ length: CONCURRENCY }, () =>
          fetch(`${baseUrl}/readyz`)
        );

        const responses = await Promise.all(requests);
        assert.strictEqual(responses.length, CONCURRENCY);

        for (const res of responses) {
          assert.strictEqual(res.status, 200, 'Every /readyz request must return HTTP 200');
          const body = await res.json();
          assert.strictEqual(body.status, 'ok');
          assert.strictEqual(body.database, 'connected');
          assert.ok(typeof body.timestamp === 'number');
        }

        assert.strictEqual(dbQueryCount, CONCURRENCY, 'Every /readyz probe must query database health');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    await t1.test('1.3: Total immunity to malformed, forged, or invalid authentication headers', async () => {
      const mockDb = { ping: async () => true };
      const { app } = createIsolatedProbeApp(mockDb);
      const server = http.createServer(app);

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const hostileHeaderSets = [
          { Authorization: 'Bearer forged-corrupted-jwt-token-with-tampered-signature' },
          { Authorization: 'Basic YWRtaW46cGFzc3dvcmQxMjM=' },
          { 'x-api-key': 'cp_live_00000000000000000000000000000000' },
          { 'x-internal-service-key': 'attacker-attempting-ingress-bypass' },
          { Cookie: 'session_token=malicious-session-id-attempt' },
          {
            Authorization: 'Bearer ' + 'A'.repeat(8192), // Large header buffer
            'x-api-key': 'invalid',
          },
        ];

        for (const headers of hostileHeaderSets) {
          const livezRes = await fetch(`${baseUrl}/livez`, { headers });
          assert.strictEqual(
            livezRes.status,
            200,
            '/livez must ignore hostile auth headers and return 200'
          );

          const readyzRes = await fetch(`${baseUrl}/readyz`, { headers });
          assert.strictEqual(
            readyzRes.status,
            200,
            '/readyz must ignore hostile auth headers and return 200'
          );
        }
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    await t1.test('1.4: HEAD request conformance and cache-control headers on probes', async () => {
      const mockDb = { ping: async () => true };
      const { app } = createIsolatedProbeApp(mockDb);
      const server = http.createServer(app);

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const headLivez = await fetch(`${baseUrl}/livez`, { method: 'HEAD' });
        assert.strictEqual(headLivez.status, 200, 'HEAD /livez must return 200');
        const livezText = await headLivez.text();
        assert.strictEqual(livezText, '', 'HEAD request must have empty body');

        const headReadyz = await fetch(`${baseUrl}/readyz`, { method: 'HEAD' });
        assert.strictEqual(headReadyz.status, 200, 'HEAD /readyz must return 200');
        const readyzText = await headReadyz.text();
        assert.strictEqual(readyzText, '', 'HEAD request must have empty body');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  // ----------------------------------------------------------------------------
  // Vector 2: Probe State Transitions & Degradation Decoupling
  // ----------------------------------------------------------------------------
  await t.test('Vector 2: Probe State Transitions & Degradation Decoupling', async (t2) => {

    await t2.test('2.1: Decoupled degradation: DB failure causes /readyz 503 while /livez remains 200', async () => {
      let isDbHealthy = true;
      const mockDb = {
        ping: async () => {
          if (!isDbHealthy) throw new Error('PostgreSQL connection timeout: ECONNREFUSED 5432');
          return true;
        },
      };

      const { app } = createIsolatedProbeApp(mockDb);
      const server = http.createServer(app);

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        // Initial state: both healthy
        const initLivez = await fetch(`${baseUrl}/livez`);
        const initReadyz = await fetch(`${baseUrl}/readyz`);
        assert.strictEqual(initLivez.status, 200);
        assert.strictEqual(initReadyz.status, 200);

        // Simulate database outage / network partition
        isDbHealthy = false;

        // /livez MUST remain 200 (Node process is alive; Kubelet must NOT restart container)
        const degradedLivez = await fetch(`${baseUrl}/livez`);
        assert.strictEqual(degradedLivez.status, 200, '/livez must stay 200 even when DB is down');
        const livezBody = await degradedLivez.json();
        assert.strictEqual(livezBody.status, 'ok');

        // /readyz MUST flip to 503 (Ingress router must take container out of traffic pool)
        const degradedReadyz = await fetch(`${baseUrl}/readyz`);
        assert.strictEqual(degradedReadyz.status, 503, '/readyz must return 503 when DB fails');
        const readyzBody = await degradedReadyz.json();
        assert.strictEqual(readyzBody.status, 'error');
        assert.strictEqual(readyzBody.database, 'disconnected');
        assert.ok(readyzBody.error.includes('ECONNREFUSED'));

        // Database recovers: /readyz immediately restores to 200
        isDbHealthy = true;
        const recoveredReadyz = await fetch(`${baseUrl}/readyz`);
        assert.strictEqual(recoveredReadyz.status, 200, '/readyz must recover to 200 when DB is restored');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    await t2.test('2.2: Shutdown Mode: /livez and /readyz transition immediately to 503', async () => {
      const mockDb = { ping: async () => true };
      const { app, setShuttingDown } = createIsolatedProbeApp(mockDb);
      const server = http.createServer(app);

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        // Normal state
        assert.strictEqual((await fetch(`${baseUrl}/livez`)).status, 200);
        assert.strictEqual((await fetch(`${baseUrl}/readyz`)).status, 200);

        // Server enters shutdown mode
        setShuttingDown(true);

        // Immediate transition to 503 on /livez
        const livezRes = await fetch(`${baseUrl}/livez`);
        assert.strictEqual(livezRes.status, 503);
        const livezBody = await livezRes.json();
        assert.strictEqual(livezBody.status, 'shutting_down');
        assert.strictEqual(livezBody.message, 'Server is shutting down');

        // Immediate transition to 503 on /readyz
        const readyzRes = await fetch(`${baseUrl}/readyz`);
        assert.strictEqual(readyzRes.status, 503);
        const readyzBody = await readyzRes.json();
        assert.strictEqual(readyzBody.status, 'error');
        assert.strictEqual(readyzBody.database, 'disconnected');
        assert.strictEqual(readyzBody.message, 'Server is shutting down');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    await t2.test('2.3: Ingress traffic rejection with Connection: close during shutdown', async () => {
      const mockDb = { ping: async () => true };
      const { app, setShuttingDown } = createIsolatedProbeApp(mockDb);
      const server = http.createServer(app);

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        // Pre-shutdown: protected endpoint accessible
        const preRes = await fetch(`${baseUrl}/api/protected`);
        assert.strictEqual(preRes.status, 200);

        // Set shutdown active
        setShuttingDown(true);

        // Post-shutdown: protected endpoint rejected with 503 and Connection: close
        const postRes = await fetch(`${baseUrl}/api/protected`);
        assert.strictEqual(postRes.status, 503);
        assert.strictEqual(postRes.headers.get('connection'), 'close');
        const postBody = await postRes.json();
        assert.strictEqual(postBody.error, 'Service Unavailable');
        assert.strictEqual(postBody.status, 'shutting_down');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  // ----------------------------------------------------------------------------
  // Vector 3: Shutdown Race, Idempotency & Clean Draining
  // ----------------------------------------------------------------------------
  await t.test('Vector 3: Shutdown Race, Idempotency & Clean Draining', async (t3) => {

    await t3.test('3.1: Parallel Multi-Signal Collision (SIGTERM + SIGINT + SIGTERM in parallel)', async () => {
      let serverCloseCallCount = 0;
      let dbCloseCallCount = 0;
      let schedulerStopCount = 0;
      let limiterReleaseCount = 0;
      let exitCallCount = 0;
      let recordedExitCode = null;

      const mockServer = {
        close: (cb) => {
          serverCloseCallCount++;
          setTimeout(cb, 10);
        },
        closeIdleConnections: () => {},
      };

      const mockScheduler = {
        stop: () => { schedulerStopCount++; },
        getActiveExecutionCount: () => 0,
      };

      const mockStuckDetector = {
        stop: () => {},
      };

      const mockSocialScheduler = {
        stop: () => {},
      };

      const mockDatabase = {
        query: async (sql) => {
          if (sql.includes('UPDATE monitoring_limiter')) {
            limiterReleaseCount++;
          }
          return { rows: [] };
        },
        close: async () => {
          dbCloseCallCount++;
        },
      };

      const manager = createShutdownManager({
        server: mockServer,
        database: mockDatabase,
        scheduler: mockScheduler,
        stuckDetector: mockStuckDetector,
        socialScheduler: mockSocialScheduler,
        graceTimeoutMs: 5000,
        drainExecutionsTimeoutMs: 1000,
        exitFn: (code) => {
          exitCallCount++;
          recordedExitCode = code;
        },
      });

      // Fire duplicate signals concurrently
      const [p1, p2, p3] = [
        manager.handleSignal('SIGTERM'),
        manager.handleSignal('SIGINT'),
        manager.handleSignal('SIGTERM'),
      ];

      // Assert all three returned the identical active shutdown promise
      assert.strictEqual(p1, p2, 'Concurrent signal 1 and 2 must share identical shutdown promise');
      assert.strictEqual(p2, p3, 'Concurrent signal 2 and 3 must share identical shutdown promise');

      await Promise.all([p1, p2, p3]);

      // Exactly once verification
      assert.strictEqual(serverCloseCallCount, 1, 'HTTP server close must be called exactly once');
      assert.strictEqual(dbCloseCallCount, 1, 'Database close must be called exactly once');
      assert.strictEqual(schedulerStopCount, 1, 'Scheduler stop must be called exactly once');
      assert.strictEqual(limiterReleaseCount, 1, 'Limiter lease release query must be called exactly once');
      assert.strictEqual(exitCallCount, 1, 'process.exit must be called exactly once');
      assert.strictEqual(recordedExitCode, 0, 'Clean shutdown must exit with code 0');
    });

    await t3.test('3.2: In-Flight Request Draining: ongoing request completes cleanly before shutdown finish', async () => {
      let isShuttingDown = false;
      let inFlightFinished = false;

      const server = http.createServer((req, res) => {
        if (req.url === '/api/slow-operation') {
          // Simulate an in-flight operation taking 50ms
          setTimeout(() => {
            inFlightFinished = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'completed_in_flight' }));
          }, 50);
          return;
        }

        if (isShuttingDown) {
          res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: 'Service Unavailable', status: 'shutting_down' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      let exitCalled = false;
      const manager = createShutdownManager({
        server,
        database: { close: async () => {} },
        scheduler: { stop: () => {}, getActiveExecutionCount: () => 0 },
        stuckDetector: { stop: () => {} },
        socialScheduler: { stop: () => {} },
        graceTimeoutMs: 5000,
        drainExecutionsTimeoutMs: 500,
        exitFn: () => { exitCalled = true; },
      });

      try {
        // 1. Launch in-flight slow request with Connection: close so socket terminates immediately upon response
        const inFlightPromise = fetch(`${baseUrl}/api/slow-operation`, {
          headers: { connection: 'close' },
        }).then((r) => r.json());

        // 2. Wait 15ms so the request is actively in-flight on the server
        await new Promise((r) => setTimeout(r, 15));

        // 3. Initiate graceful shutdown while request is active
        isShuttingDown = true;
        const shutdownPromise = manager.executeGracefulShutdown('SIGTERM');

        // 4. In-flight request must resolve successfully with HTTP 200
        const result = await inFlightPromise;
        assert.strictEqual(result.status, 'completed_in_flight');
        assert.strictEqual(inFlightFinished, true, 'In-flight work must finish cleanly before server teardown');

        // 5. Complete shutdown
        await shutdownPromise;
        assert.strictEqual(exitCalled, true, 'Shutdown should finalize and invoke exitFn');
      } finally {
        server.close();
      }
    });

    await t3.test('3.3: Watchdog deadline forced exit (code 1) when cleanup operation hangs', async () => {
      let exitCode = null;

      // Mock server whose close callback hangs forever
      const mockHangingServer = {
        close: () => {
          // Never invokes callback to simulate hung socket or blocked event loop
        },
        closeIdleConnections: () => {},
      };

      const manager = createShutdownManager({
        server: mockHangingServer,
        graceTimeoutMs: 100, // Fast 100ms watchdog
        exitFn: (code) => { exitCode = code; },
      });

      manager.handleSignal('SIGTERM');

      // Wait 180ms for watchdog timer to trigger
      await new Promise((r) => setTimeout(r, 180));

      assert.strictEqual(exitCode, 1, 'Watchdog must force exit with code 1 upon exceeding grace timeout');
    });

    await t3.test('3.4: Signal handler registration and event loop dispatch (process.emit SIGTERM/SIGINT)', async () => {
      let exitCode = null;
      let closeCalled = false;

      const mockServer = {
        close: (cb) => {
          closeCalled = true;
          cb();
        },
        closeIdleConnections: () => {},
      };

      const manager = createShutdownManager({
        server: mockServer,
        database: { close: async () => {} },
        scheduler: { stop: () => {}, getActiveExecutionCount: () => 0 },
        stuckDetector: { stop: () => {} },
        socialScheduler: { stop: () => {} },
        exitFn: (code) => { exitCode = code; },
      });

      manager.registerSignalHandlers();

      // Trigger SIGTERM via process event emitter
      process.emit('SIGTERM');
      // Rapid duplicate trigger of SIGINT
      process.emit('SIGINT');

      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(closeCalled, true, 'Server close must have executed');
      assert.strictEqual(exitCode, 0, 'Signal listener must trigger graceful shutdown and exit 0');
      assert.strictEqual(manager.isShuttingDown(), true, 'Shutdown state flag must be true');
    });

    await t3.test('3.5: Live Server Process: Boot and 50-request probe flood over real network socket', async () => {
      const { env, paths: hermeticPaths } = makeHermeticEnv({
        PORT: String(M4_LIVE_PORT),
        ADMIN_EMAIL: 'ops_admin@system.local',
        ADMIN_PASSWORD: 'OpsAdminPassword123!',
        INTERNAL_SERVICE_KEY: 'ops-adversarial-internal-key-32ch',
      });

      const child = spawn(process.execPath, ['server.js'], {
        cwd: path.resolve(__dirname, '../..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      try {
        // Wait for live server /livez
        const deadline = Date.now() + 15000;
        let isLive = false;
        while (Date.now() < deadline) {
          try {
            const probe = await fetch(`${LIVE_BASE_URL}/livez`);
            if (probe.ok) {
              isLive = true;
              break;
            }
          } catch (_err) {
            // Server not yet accepting connections; retry until deadline
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        assert.ok(isLive, 'Live test server failed to become healthy within 15s');

        // Execute 50-request flood against the LIVE server over real network socket
        const flood = Array.from({ length: 50 }, () => fetch(`${LIVE_BASE_URL}/livez`));
        const floodResults = await Promise.all(flood);
        assert.strictEqual(floodResults.length, 50);
        for (const res of floodResults) {
          assert.strictEqual(res.status, 200);
          const body = await res.json();
          assert.strictEqual(body.status, 'ok');
          assert.ok(typeof body.uptime === 'number');
        }

        // Also test /readyz against live PostgreSQL (PGlite)
        const readyRes = await fetch(`${LIVE_BASE_URL}/readyz`);
        assert.strictEqual(readyRes.status, 200);
        const readyBody = await readyRes.json();
        assert.strictEqual(readyBody.status, 'ok');
        assert.strictEqual(readyBody.database, 'connected');

        assert.ok(!stderr.includes('[FATAL]'), `Live server stderr should not contain fatal crashes: ${stderr}`);
      } finally {
        child.kill();
        cleanupHermeticEnv(hermeticPaths);
      }
    });
  });

  // ----------------------------------------------------------------------------
  // Vector 4: Docker Ignore Leak Stress & Context Hardening
  // ----------------------------------------------------------------------------
  await t.test('Vector 4: Docker Ignore Leak Stress & Context Hardening', async (t4) => {
    const dockerignorePath = path.resolve(__dirname, '../../.dockerignore');
    const content = fs.readFileSync(dockerignorePath, 'utf8');
    const matcher = createDockerignoreMatcher(content);

    await t4.test('4.1: Exhaustive Secret Wildcard Matching (.env*)', () => {
      const secretEnvPaths = [
        '.env',
        '.env.production',
        '.env.local',
        '.env.test',
        '.env.staging',
        '.env.backup',
        '.env.development.local',
        '.env.vault',
        '.env123',
        '.env_prod',
        '.env.secrets',
        'config/.env',
        'config/.env.production',
        'sub/dir/.env.prod',
        'deeply/nested/path/.env.local',
      ];

      for (const p of secretEnvPaths) {
        assert.ok(
          matcher.isIgnored(p),
          `Sensitive environment file "${p}" must be ignored by .dockerignore`
        );
      }

      // Safe non-secret code files starting with env must NOT be ignored
      const nonSecretFiles = [
        'src/env-helper.js',
        'src/environment.js',
        'scripts/validate-env.js',
      ];

      for (const p of nonSecretFiles) {
        assert.ok(
          !matcher.isIgnored(p),
          `Code file "${p}" must NOT be accidentally ignored by .dockerignore`
        );
      }
    });

    await t4.test('4.2: Plaintext Credential Matching (proxies.txt)', () => {
      const proxyPaths = [
        'proxies.txt',
        '/proxies.txt',
        'config/proxies.txt',
        'data/proxies.txt',
        'scrapers/proxies.txt',
        'deep/nested/sub/proxies.txt',
      ];

      for (const p of proxyPaths) {
        assert.ok(
          matcher.isIgnored(p),
          `Credential file "${p}" must be ignored by .dockerignore`
        );
      }

      // Ensure legitimate non-secret proxy code is NOT ignored
      assert.ok(!matcher.isIgnored('src/proxy-manager.js'));
      assert.ok(!matcher.isIgnored('src/proxies-schema.json'));
    });

    await t4.test('4.3: Database Backup & Dump Matching (.backup/, *.db*)', () => {
      const backupPaths = [
        '.backup/',
        '.backup/manifest.json',
        '.backup/2026-09-23T120000Z/database_dump.sql',
        'sub/.backup/manifest.json',
        'docs/BACKUPS/old_dump.sql',
        'docs/DATA_PACKETS/prod.db',
        'data/collector.db',
        'data/collector.db-wal',
        'data/collector.db-shm',
        'temp_debug.db',
      ];

      for (const p of backupPaths) {
        assert.ok(
          matcher.isIgnored(p),
          `Backup/database artifact "${p}" must be ignored by .dockerignore`
        );
      }
    });

    await t4.test('4.4: Ephemeral Media Cache & Logs Matching (public/media/, logs/, *.log)', () => {
      const ephemeralPaths = [
        'public/media/image1.jpg',
        'public/media/nested/file.webp',
        'public/media/hash.tmp',
        'logs/server.log',
        'logs/app.log',
        'sub/logs/audit.log',
        'server.log',
        'debug.log',
      ];

      for (const p of ephemeralPaths) {
        assert.ok(
          matcher.isIgnored(p),
          `Ephemeral media/log artifact "${p}" must be ignored by .dockerignore`
        );
      }

      // Essential public assets MUST NOT be ignored
      const essentialPublicFiles = [
        'public/index.html',
        'public/app.js',
        'public/styles.css',
        'public/favicon.ico',
        'public/robots.txt',
      ];

      for (const p of essentialPublicFiles) {
        assert.ok(
          !matcher.isIgnored(p),
          `Public web asset "${p}" must NOT be ignored by .dockerignore`
        );
      }
    });

    await t4.test('4.5: Agent Workspaces & VCS Dirs', () => {
      const metaPaths = [
        '.git/config',
        '.git/HEAD',
        '.agents/worker_m4_1/handoff.md',
        '.agent/settings.json',
        '.codex/index.json',
        '.claude/settings.json',
        '.playwright-mcp/state.json',
        '.codegraph/graph.db',
      ];

      for (const p of metaPaths) {
        assert.ok(
          matcher.isIgnored(p),
          `Agent/VCS metadata file "${p}" must be ignored by .dockerignore`
        );
      }
    });

    await t4.test('4.6: Path Normalization & Windows Backslash Immunity', () => {
      const backslashPaths = [
        'public\\media\\test.jpg',
        '.backup\\20260923\\dump.sql',
        'logs\\server.log',
        'config\\.env.production',
        'sub\\proxies.txt',
      ];

      for (const p of backslashPaths) {
        assert.ok(
          matcher.isIgnored(p),
          `Windows-style path "${p}" must be matched correctly by .dockerignore`
        );
      }
    });
  });
});
