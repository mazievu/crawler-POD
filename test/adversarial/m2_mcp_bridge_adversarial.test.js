'use strict';

/**
 * test/adversarial/m2_mcp_bridge_adversarial.test.js
 * Adversarial Stress Test Suite for Milestone M2: MCP Bridge Lockdown.
 *
 * Covers:
 * 1. Missing INTERNAL_SERVICE_KEY (unauthenticated callers, empty headers, missing env)
 * 2. Wrong, corrupted, tampered, truncated, or extended service keys
 * 3. Reverse proxy loopback spoofing (unauthenticated 127.0.0.1, spoofed proxy headers, remote IPs, browser checks)
 * 4. Timing attack resistance (constant-time verification, length invariance, RangeError immunity)
 * 5. Header injection & CRLF attack vectors (raw socket CRLF, untrimmed whitespace/newlines)
 * 6. Path traversal, verb tampering, and subpath probing on /api/internal/*
 * 7. Malicious SQL payloads & restricted command smuggling through the bridge
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const net = require('node:net');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const {
  createMcpBridgeRouter,
  assertReadOnlySql,
  isLoopbackAddress,
  extractInternalServiceKey,
  verifyInternalServiceKey,
  guardInternalService,
  QUERY_PATH,
} = require('../../src/routes/mcp-bridge');

const VALID_KEY = 'super-secret-mcp-internal-service-key-32b!';
const WRONG_KEY = 'invalid-mcp-internal-service-key-32b!';

// Helper to create a stub database
function createStubDatabase(canned = {}) {
  const calls = [];
  return {
    calls,
    _connection: {
      prepare(sql) {
        return {
          async all(...args) {
            calls.push({ sql, args });
            if (sql in canned) return canned[sql];
            return [{ ok: 1 }];
          },
        };
      },
    },
  };
}

// Helper to start an isolated HTTP test server
async function withServer(router, fn, host = '127.0.0.1') {
  const app = express();
  app.use(express.json());
  app.use(router);
  // Default error handler to prevent noisy stack traces during adversarial malformed payloads
  app.use((err, req, res, next) => {
    res.status(err.status || 400).json({ error: err.message });
  });

  const server = app.listen(0, host);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  try {
    await fn(`http://${host}:${port}`, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// 1. Missing INTERNAL_SERVICE_KEY Header & Environment Fail-Closed Tests
// ---------------------------------------------------------------------------

test('M2-ADV-1.1: Request to /api/internal/mcp-bridge/query without key header is rejected with 403 Forbidden', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res.status, 403);
      const json = await res.json();
      assert.strictEqual(json.error, 'Forbidden');
      assert.match(json.message, /INTERNAL_SERVICE_KEY required/i);
      assert.strictEqual(stub.calls.length, 0);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('M2-ADV-1.2: Empty string or whitespace-only x-internal-service-key header returns 403 Forbidden', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      // Empty string
      const res1 = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-service-key': '' },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res1.status, 403);

      // Whitespace only
      const res2 = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-service-key': '   ' },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res2.status, 403);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('M2-ADV-1.3: Empty or malformed Authorization: Bearer returns 403 Forbidden', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const cases = [
        'Bearer ',
        'Bearer    ',
        'Basic dXNlcjpwYXNz',
        'Token 12345',
        '',
      ];
      for (const authHeader of cases) {
        const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: authHeader },
          body: JSON.stringify({ sql: 'SELECT 1' }),
        });
        assert.strictEqual(res.status, 403, `Failed for Authorization: "${authHeader}"`);
      }
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('M2-ADV-1.4: Fail-closed: Unset, empty, or whitespace-only INTERNAL_SERVICE_KEY env returns 403', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  const stub = createStubDatabase();
  const router = createMcpBridgeRouter({ database: stub });

  const envCases = [undefined, '', '   ', '\t\n'];
  try {
    for (const envVal of envCases) {
      if (envVal === undefined) {
        delete process.env.INTERNAL_SERVICE_KEY;
      } else {
        process.env.INTERNAL_SERVICE_KEY = envVal;
      }

      await withServer(router, async (baseUrl) => {
        const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-service-key': 'attacker-attempting-access',
          },
          body: JSON.stringify({ sql: 'SELECT 1' }),
        });
        assert.strictEqual(res.status, 403, `Failed fail-closed check for env="${envVal}"`);
        const json = await res.json();
        assert.strictEqual(json.error, 'Forbidden');
      });
    }
  } finally {
    if (oldKey !== undefined) process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

// ---------------------------------------------------------------------------
// 2. Wrong / Corrupted / Tampered Service Key Tests
// ---------------------------------------------------------------------------

test('M2-ADV-2.1: Tampered, truncated, or extended service keys are rejected with 403', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const badKeys = [
        WRONG_KEY,
        // First char mismatch
        (VALID_KEY[0] === 'a' ? 'b' : 'a') + VALID_KEY.slice(1),
        // Last char mismatch
        VALID_KEY.slice(0, -1) + (VALID_KEY.slice(-1) === '!' ? '?' : '!'),
        // Truncated by 1 char
        VALID_KEY.slice(0, -1),
        // Extended by 1 char
        VALID_KEY + 'X',
        // Inverted case
        VALID_KEY.toUpperCase(),
        // Long key within HTTP header limit (4KB)
        'A'.repeat(4000),
      ];

      for (const badKey of badKeys) {
        const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-service-key': badKey },
          body: JSON.stringify({ sql: 'SELECT 1' }),
        });
        assert.strictEqual(res.status, 403, `Expected 403 for bad key: ${badKey.slice(0, 20)}...`);
        const json = await res.json();
        assert.strictEqual(json.error, 'Forbidden');
      }
    });

    // Verification of embedded null byte directly on pure verification function
    assert.strictEqual(verifyInternalServiceKey(VALID_KEY.slice(0, 10) + '\0' + VALID_KEY.slice(11), VALID_KEY), false);
    // Verification of extreme length on pure verification function (100,000 chars)
    assert.strictEqual(verifyInternalServiceKey('A'.repeat(100000), VALID_KEY), false);
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('M2-ADV-2.2: Array headers and multiple header values are rejected cleanly if not matching', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      // Mocking request with array of wrong headers
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-key': 'wrong1, wrong2',
        },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res.status, 403);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

// ---------------------------------------------------------------------------
// 3. Reverse Proxy Loopback Spoofing & Network Egress Defense Tests
// ---------------------------------------------------------------------------

test('M2-ADV-3.1: Attacker on 127.0.0.1 (simulating reverse proxy forwarding) without key returns 403', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    // The test runner connects directly over 127.0.0.1 to 127.0.0.1, exactly what a reverse proxy does
    await withServer(router, async (baseUrl) => {
      const spoofHeaders = [
        {},
        { 'x-forwarded-for': '127.0.0.1' },
        { 'x-real-ip': '127.0.0.1' },
        { 'client-ip': '127.0.0.1' },
        { 'x-forwarded-for': '203.0.113.195, 127.0.0.1' },
        { forwarded: 'for=127.0.0.1;proto=http' },
      ];

      for (const headers of spoofHeaders) {
        const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ sql: 'SELECT 1' }),
        });
        assert.strictEqual(res.status, 403, 'Loopback connection without service key must return 403');
      }
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('M2-ADV-3.2: Non-loopback socket address is rejected even WITH valid key', () => {
  // Test unit guardInternalService directly with non-loopback sockets
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const remoteIps = ['192.168.1.50', '10.0.0.1', '172.16.0.1', '8.8.8.8', '::ffff:192.168.1.1'];
    for (const ip of remoteIps) {
      let statusCode = null;
      let jsonBody = null;
      const fakeReq = {
        headers: { 'x-internal-service-key': VALID_KEY },
        socket: { remoteAddress: ip },
      };
      const fakeRes = {
        status(c) {
          statusCode = c;
          return {
            json(b) { jsonBody = b; },
          };
        },
      };
      let nextCalled = false;
      guardInternalService(fakeReq, fakeRes, () => { nextCalled = true; });

      assert.strictEqual(statusCode, 403, `Remote IP ${ip} must be blocked`);
      assert.strictEqual(nextCalled, false);
      assert.match(jsonBody.message, /loopback requests only/);
    }
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('M2-ADV-3.3: Browser-originated requests are rejected even WITH valid key', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const browserScenarios = [
        { origin: 'https://malicious-site.com' },
        { 'sec-fetch-site': 'cross-site' },
        {
          'sec-fetch-mode': 'cors',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
        },
      ];

      for (const bHeaders of browserScenarios) {
        const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-service-key': VALID_KEY,
            ...bHeaders,
          },
          body: JSON.stringify({ sql: 'SELECT 1' }),
        });
        assert.strictEqual(res.status, 403, `Browser header ${JSON.stringify(bHeaders)} must be blocked`);
        const json = await res.json();
        assert.match(json.message, /browser-originated/);
      }
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

// ---------------------------------------------------------------------------
// 4. Timing Attack Resistance on Key Comparison
// ---------------------------------------------------------------------------

test('M2-ADV-4.1: Constant-time comparison: SHA-256 prehash prevents RangeError on differing lengths', () => {
  assert.strictEqual(verifyInternalServiceKey('short', 'much-longer-expected-key-here'), false);
  assert.strictEqual(verifyInternalServiceKey('a'.repeat(1000), 'b'), false);
  assert.strictEqual(verifyInternalServiceKey('', VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey(VALID_KEY, ''), false);
  assert.strictEqual(verifyInternalServiceKey(null, VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey(VALID_KEY, null), false);
  assert.strictEqual(verifyInternalServiceKey(undefined, VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey({}, VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey(VALID_KEY, 12345), false);
});

test('M2-ADV-4.2: Statistical timing test: First-byte mismatch vs Last-byte mismatch timing variance is negligible', () => {
  const expectedKey = 'K'.repeat(64); // 64-char key
  const firstMismatchKey = 'L' + 'K'.repeat(63); // mismatch at index 0
  const lastMismatchKey = 'K'.repeat(63) + 'L'; // mismatch at index 63

  // Warmup JIT
  for (let i = 0; i < 200; i++) {
    verifyInternalServiceKey(firstMismatchKey, expectedKey);
    verifyInternalServiceKey(lastMismatchKey, expectedKey);
  }

  const TRIALS = 2000;
  let timeFirst = 0;
  let timeLast = 0;

  for (let i = 0; i < TRIALS; i++) {
    const t0 = performance.now();
    verifyInternalServiceKey(firstMismatchKey, expectedKey);
    timeFirst += (performance.now() - t0);

    const t1 = performance.now();
    verifyInternalServiceKey(lastMismatchKey, expectedKey);
    timeLast += (performance.now() - t1);
  }

  const avgFirst = timeFirst / TRIALS;
  const avgLast = timeLast / TRIALS;

  // The timing variance ratio should be minimal (bounded within 25% jitter tolerance)
  const diffRatio = Math.abs(avgFirst - avgLast) / Math.max(avgFirst, avgLast);
  assert.ok(
    diffRatio < 0.25,
    `Timing variance between first-byte and last-byte mismatch must be negligible (avgFirst: ${avgFirst.toFixed(5)}ms, avgLast: ${avgLast.toFixed(5)}ms, diffRatio: ${diffRatio.toFixed(3)})`
  );
});

test('M2-ADV-4.3: Statistical timing test: Short key vs Long key timing variance is bounded', () => {
  const expectedKey = 'K'.repeat(32);
  const shortKey = 'K'.repeat(8);
  const longKey = 'K'.repeat(32);
  const wrongLongKey = 'K'.repeat(31) + 'X';

  // Warmup JIT
  for (let i = 0; i < 200; i++) {
    verifyInternalServiceKey(shortKey, expectedKey);
    verifyInternalServiceKey(wrongLongKey, expectedKey);
  }

  const TRIALS = 2000;
  let timeShort = 0;
  let timeLong = 0;

  for (let i = 0; i < TRIALS; i++) {
    const t0 = performance.now();
    verifyInternalServiceKey(shortKey, expectedKey);
    timeShort += (performance.now() - t0);

    const t1 = performance.now();
    verifyInternalServiceKey(wrongLongKey, expectedKey);
    timeLong += (performance.now() - t1);
  }

  const avgShort = timeShort / TRIALS;
  const avgLong = timeLong / TRIALS;

  const diffRatio = Math.abs(avgShort - avgLong) / Math.max(avgShort, avgLong);
  assert.ok(
    diffRatio < 0.30,
    `Timing variance across differing key lengths must be tightly bounded (diffRatio: ${diffRatio.toFixed(3)})`
  );
});

// ---------------------------------------------------------------------------
// 5. Header Injection & CRLF in x-internal-service-key Header
// ---------------------------------------------------------------------------

test('M2-ADV-5.1: Leading/trailing whitespace and CRLF control characters are NOT stripped/trimmed', () => {
  // extractInternalServiceKey must preserve exact characters
  const rawHeaderWithNewline = VALID_KEY + '\r\n';
  const extracted = extractInternalServiceKey({
    headers: { 'x-internal-service-key': rawHeaderWithNewline },
  });
  assert.strictEqual(extracted, rawHeaderWithNewline);

  // verifyInternalServiceKey must reject untrimmed keys because SHA-256 differs
  assert.strictEqual(verifyInternalServiceKey(rawHeaderWithNewline, VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey('\r\n' + VALID_KEY, VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey('\n' + VALID_KEY, VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey(VALID_KEY + ' ', VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey(' ' + VALID_KEY, VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey('\t' + VALID_KEY, VALID_KEY), false);
  assert.strictEqual(verifyInternalServiceKey(VALID_KEY + '\t', VALID_KEY), false);
});

test('M2-ADV-5.2: Raw TCP socket test: CRLF injection in HTTP headers is rejected by parser or bridge', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl, port) => {
      // Craft raw HTTP request with attempted header splitting CRLF
      const rawPayload =
        `POST ${QUERY_PATH} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Content-Type: application/json\r\n` +
        `x-internal-service-key: ${VALID_KEY}\r\nInjected-Header: evil\r\n` +
        `Content-Length: 17\r\n` +
        `Connection: close\r\n\r\n` +
        `{"sql":"SELECT 1"}`;

      const client = new net.Socket();
      let responseData = '';

      await new Promise((resolve) => {
        client.connect(port, '127.0.0.1', () => {
          client.write(rawPayload);
        });

        client.on('data', (data) => {
          responseData += data.toString();
        });

        client.on('close', resolve);
        client.on('error', resolve);
      });

      // Node's HTTP parser should either reject with 400 Bad Request due to invalid header format,
      // or if parsed, the key will not match and return 403 Forbidden.
      // Under NO circumstance should it return 200 OK!
      assert.ok(
        responseData.startsWith('HTTP/1.1 400') || responseData.startsWith('HTTP/1.1 403'),
        `Expected HTTP 400 or 403, received:\n${responseData.slice(0, 100)}`
      );
      assert.strictEqual(stub.calls.length, 0);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

// ---------------------------------------------------------------------------
// 6. Path Traversal & Subpath Requests on /api/internal/*
// ---------------------------------------------------------------------------

test('M2-ADV-6.1: Subpath requests under /api/internal/* return 403 without key, 404 with key', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const subpaths = [
        '/api/internal',
        '/api/internal/',
        '/api/internal/status',
        '/api/internal/exec',
        '/api/internal/mcp-bridge/query/extra',
        '/api/internal/admin/secret',
        '/api/internal/../internal/exec',
      ];

      for (const p of subpaths) {
        // Without key -> 403 Forbidden
        const resNoKey = await fetch(`${baseUrl}${p}`, { method: 'POST' });
        assert.strictEqual(resNoKey.status, 403, `Expected 403 without key on ${p}`);

        // With valid key -> 404 Not Found (or 403 if path normalized outside)
        const resWithKey = await fetch(`${baseUrl}${p}`, {
          method: 'POST',
          headers: { 'x-internal-service-key': VALID_KEY },
        });
        assert.ok([403, 404].includes(resWithKey.status), `Expected 403 or 404 with key on ${p}, got ${resWithKey.status}`);
      }
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('M2-ADV-6.2: HTTP verb tampering on QUERY_PATH: non-POST verbs return 403 without key, 404 with key', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const verbs = ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

      for (const method of verbs) {
        // Without key -> 403
        const resNoKey = await fetch(`${baseUrl}${QUERY_PATH}`, { method });
        assert.strictEqual(resNoKey.status, 403, `Expected 403 for ${method} without key`);

        // With key -> 404 (or 200 for OPTIONS if express handles it, but query is only mounted on POST)
        if (method !== 'OPTIONS') {
          const resWithKey = await fetch(`${baseUrl}${QUERY_PATH}`, {
            method,
            headers: { 'x-internal-service-key': VALID_KEY },
          });
          assert.strictEqual(resWithKey.status, 404, `Expected 404 for ${method} with key`);
        }
      }
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('M2-ADV-6.3: Path Traversal defense in Full Express stack: /api/internal/.. does NOT bypass User Auth', async () => {
  // Build a test Express app mimicking server.js's exact middleware order:
  // 1. mcp-bridge router
  // 2. Stage 1 User Auth Barrier
  // 3. User protected routes
  const app = express();
  app.use(express.json());

  const stubDb = createStubDatabase();
  app.use(createMcpBridgeRouter({ database: stubDb }));

  // Mock User Auth Middleware (returns 401 when no session/api_key)
  app.use(['/api', '/admin'], (req, res, next) => {
    // Check if authenticated as user
    if (req.headers['x-api-key'] || req.headers.authorization?.startsWith('Bearer cp_')) {
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  });

  // Protected user route
  app.post('/api/runs', (req, res) => {
    res.json({ success: true, runId: 101 });
  });

  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;

  try {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Attacker tries path traversal without any credentials:
      // /api/internal/../api/runs
      const resTraversalNoCreds = await fetch(`${baseUrl}/api/internal/../api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      // Express normalizes path to /api/runs, which hits user auth barrier -> 401 Unauthorized
      assert.strictEqual(
        resTraversalNoCreds.status,
        401,
        'Path traversal attempt must hit Auth Barrier and return 401'
      );

      // 2. Attacker tries path traversal WITH internal service key to access user endpoint:
      // The internal service key must NOT grant access to user endpoints!
      const resTraversalWithKey = await fetch(`${baseUrl}/api/internal/../api/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-key': VALID_KEY,
        },
      });
      assert.strictEqual(
        resTraversalWithKey.status,
        401,
        'Internal service key must NOT grant access to user /api/runs endpoint'
      );

      // 3. Normal access to /api/runs with internal service key directly is also 401
      const resDirectUserRouteWithKey = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-key': VALID_KEY,
        },
      });
      assert.strictEqual(resDirectUserRouteWithKey.status, 401);
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

// ---------------------------------------------------------------------------
// 7. Malicious SQL Payloads & Restricted Command Smuggling with Valid Key
// ---------------------------------------------------------------------------

test('M2-ADV-7.1: Malicious SQL statements are refused with 400 Bad Request even with valid service key', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const maliciousSqls = [
        'DELETE FROM runs',
        'DROP TABLE users',
        'UPDATE users SET role = \'admin\'',
        'INSERT INTO users (email) VALUES (\'hacker@evil.com\')',
        'TRUNCATE TABLE runs',
        'ALTER TABLE users ADD COLUMN hacked BOOLEAN',
        'GRANT ALL ON users TO public',
        'REVOKE ALL ON users FROM public',
        'COPY users TO \'/tmp/users.csv\'',
        'VACUUM runs',
        // Stacked query
        'SELECT 1; DROP TABLE users',
        'SELECT 1; DELETE FROM runs;',
        // Comment smuggling
        'SELECT 1 /* comment */; DELETE FROM runs',
        'SELECT 1 -- line comment \n; DELETE FROM runs',
        // Restricted functions
        'SELECT pg_read_file(\'server.js\')',
        'SELECT pg_read_binary_file(\'/etc/passwd\')',
        'SELECT pg_ls_dir(\'/\')',
        'SELECT pg_stat_file(\'server.js\')',
        'SELECT pg_sleep(10)',
        'SELECT lo_import(\'/etc/shadow\')',
        'SELECT lo_export(1, \'/tmp/out\')',
        'SELECT setval(\'users_id_seq\', 100)',
        // Writable CTE
        'WITH deleted AS (DELETE FROM runs RETURNING *) SELECT * FROM deleted',
        'WITH inserted AS (INSERT INTO users (email) VALUES (\'a\') RETURNING id) SELECT * FROM inserted',
      ];

      for (const sql of maliciousSqls) {
        const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-service-key': VALID_KEY,
          },
          body: JSON.stringify({ sql }),
        });
        assert.strictEqual(
          res.status,
          400,
          `Expected 400 Bad Request for malicious SQL: "${sql}", got ${res.status}`
        );
        const json = await res.json();
        assert.ok(json.error, `Response must contain error object for "${sql}"`);
      }
      assert.strictEqual(stub.calls.length, 0, 'No malicious SQL must ever reach database execution');
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('M2-ADV-7.2: Malformed request bodies (non-string SQL, empty body, garbage payload) return 400', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = VALID_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const badBodies = [
        {},
        { sql: 12345 },
        { sql: true },
        { sql: ['SELECT 1'] },
        { sql: { query: 'SELECT 1' } },
        { sql: '' },
        { sql: '   ' },
        null,
      ];

      for (const body of badBodies) {
        const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-service-key': VALID_KEY,
          },
          body: JSON.stringify(body),
        });
        assert.strictEqual(res.status, 400, `Expected 400 for body: ${JSON.stringify(body)}`);
      }
      assert.strictEqual(stub.calls.length, 0);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});
