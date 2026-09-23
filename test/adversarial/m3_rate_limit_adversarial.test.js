'use strict';

/**
 * test/adversarial/m3_rate_limit_adversarial.test.js
 * Adversarial Stress & Empirical Verification Suite — Milestone M3 (Rate Limiting Subsystem)
 *
 * Implements rigorous stress vectors for:
 * - Feature 9: Login Brute Force Throttler (5 failures / 15 min per IP/email)
 * - Feature 10: Run Creation Rate Limiter (10 requests / min per user/session/API key with IP fallback)
 *
 * Test Groups:
 * 1. Login Brute Force: Rapid burst of 20 invalid attempts (exact threshold: 5 fail 401, 6th-20th return 429 with Retry-After)
 * 2. Counter Reset Verification: 4 failed attempts + 1 successful login -> subsequent logins unblocked
 * 3. Multi-Tenant & Distributed IP Evasion: multiple IPs against same email vs multiple emails from same IP
 * 4. Run Creation Rate Limit Flood: rapid burst of 25 run creation requests (10 admitted, 15 rejected with 429)
 * 5. Header Manipulation & IP Spoofing: spoofed X-Forwarded-For, case/whitespace evasion, prototype pollution
 * 6. Memory Leak & Capacity Stress: 15,000 distinct keys in SlidingWindowMemoryStore verifying LRU eviction cap at 10,000
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  RATE_LIMIT_DEFAULTS,
  SlidingWindowMemoryStore,
  getClientIp,
  createLoginKeyGenerator,
  createRunKeyGenerator,
  createLoginRateLimiter,
  createRunRateLimiter,
} = require('../../src/security/rate-limit.middleware');

const { createAuthRouter } = require('../../src/security/auth.routes');
const { createAuthMiddleware } = require('../../src/security/auth.middleware');

// Helper to spawn an in-process isolated HTTP test server on an ephemeral port
async function withTestServer(configureApp, testFn) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  configureApp(app);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await testFn(baseUrl, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Mock authService simulating user credentials, session issuance, and API keys
function createMockAuthService() {
  const users = new Map([
    ['victim@target.local', { id: 101, email: 'victim@target.local', password: 'CorrectPassword123!', role: 'member' }],
    ['legit@target.local', { id: 102, email: 'legit@target.local', password: 'LegitPassword123!', role: 'member' }],
    ['admin@target.local', { id: 100, email: 'admin@target.local', password: 'AdminPassword123!', role: 'admin' }],
  ]);

  let authCallsCount = 0;

  return {
    getAuthCallsCount() { return authCallsCount; },
    resetAuthCallsCount() { authCallsCount = 0; },

    async authenticateCredentials(email, password) {
      authCallsCount++;
      const user = users.get(email?.trim().toLowerCase());
      if (user && user.password === password) {
        return {
          user: { id: user.id, email: user.email, role: user.role },
          sessionToken: `mock_session_${user.id}_${Date.now()}`,
        };
      }
      return null;
    },

    async validateSession(token) {
      if (token && token.startsWith('mock_session_')) {
        return {
          user: { id: 101, email: 'victim@target.local', role: 'member' },
          session: { sessionToken: token },
        };
      }
      return null;
    },

    async validateApiKey(key) {
      if (key === 'cp_live_testvalidkey123456789012345678901234567890') {
        return {
          user: { id: 101, email: 'victim@target.local', role: 'member' },
          apiKey: { id: 55, role: 'member' },
        };
      }
      return null;
    },

    async getUserByEmail(email) {
      return users.get(email?.trim().toLowerCase()) || null;
    },

    async bootstrapSuperAdmin() {
      return { success: true };
    },

    async revokeSession() {
      return true;
    },

    async listApiKeys() {
      return [];
    },

    async generateApiKey() {
      return { rawKey: 'cp_live_newkey', record: { id: 1, role: 'member' } };
    },
  };
}

// ============================================================================
// SUITE 1: Login Brute Force Throttler (Feature 9)
// ============================================================================

test('ADV-M3-1.1: Rapid burst of 20 invalid login attempts enforces exact threshold (5 fail 401, 15 return 429)', async () => {
  const authService = createMockAuthService();
  const loginLimiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxFailures: 5,
  });

  await withTestServer((app) => {
    const authMiddleware = createAuthMiddleware(authService);
    app.use(createAuthRouter({
      authService,
      authMiddleware,
      loginRateLimiter: loginLimiter,
    }));
  }, async (baseUrl) => {
    const email = 'victim@target.local';
    const wrongPassword = 'WrongPassword999!';
    const responses = [];

    // Send 20 rapid sequential failed login attempts
    for (let i = 1; i <= 20; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: wrongPassword }),
      });
      const data = await res.json();
      responses.push({
        attempt: i,
        status: res.status,
        retryAfter: res.headers.get('Retry-After'),
        data,
      });
    }

    // Verify 1st through 5th attempts: 401 Unauthorized
    for (let i = 0; i < 5; i++) {
      const r = responses[i];
      assert.strictEqual(r.status, 401, `Attempt ${r.attempt} must return 401 Unauthorized`);
      assert.strictEqual(r.data.error, 'Unauthorized');
      assert.strictEqual(r.retryAfter, null, `Attempt ${r.attempt} must not set Retry-After`);
    }

    // Verify 6th through 20th attempts: 429 Too Many Requests
    for (let i = 5; i < 20; i++) {
      const r = responses[i];
      assert.strictEqual(r.status, 429, `Attempt ${r.attempt} must return 429 Too Many Requests`);
      assert.strictEqual(r.data.error, 'TOO_MANY_REQUESTS');
      assert.strictEqual(r.data.message, 'Too many failed login attempts. Please try again later.');
      assert.ok(r.data.retryAfterSeconds > 0, `Attempt ${r.attempt} retryAfterSeconds must be > 0`);
      assert.ok(r.retryAfter !== null, `Attempt ${r.attempt} must include Retry-After header`);
      assert.strictEqual(parseInt(r.retryAfter, 10), r.data.retryAfterSeconds);
    }

    // Exact count check: 5 admitted (401), 15 rejected (429)
    const count401 = responses.filter((r) => r.status === 401).length;
    const count429 = responses.filter((r) => r.status === 429).length;
    assert.strictEqual(count401, 5, 'Exactly 5 attempts must return 401');
    assert.strictEqual(count429, 15, 'Exactly 15 attempts must return 429');

    loginLimiter.destroy();
  });
});

test('ADV-M3-1.2: CPU & DB protection under brute force: authService credentials check bypassed once throttled', async () => {
  const authService = createMockAuthService();
  const loginLimiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxFailures: 5,
  });

  await withTestServer((app) => {
    const authMiddleware = createAuthMiddleware(authService);
    app.use(createAuthRouter({
      authService,
      authMiddleware,
      loginRateLimiter: loginLimiter,
    }));
  }, async (baseUrl) => {
    authService.resetAuthCallsCount();

    // Send 25 failed login attempts
    for (let i = 1; i <= 25; i++) {
      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'victim@target.local', password: 'bad' }),
      });
    }

    // authenticateCredentials MUST be called exactly 5 times, zero times for the 20 blocked requests!
    assert.strictEqual(
      authService.getAuthCallsCount(),
      5,
      'authService.authenticateCredentials must ONLY be called 5 times; subsequent 20 requests must fast-fail at middleware'
    );

    loginLimiter.destroy();
  });
});

test('ADV-M3-1.3: Sliding window temporal eviction unblocks account after 15-minute window expires', () => {
  let simulatedTime = 1000000;
  const store = new SlidingWindowMemoryStore({
    windowMs: 15 * 60 * 1000, // 15 min = 900,000 ms
    maxEntries: 5,
    nowProvider: () => simulatedTime,
  });

  const limiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxFailures: 5,
    store,
  });

  const key = '127.0.0.1:victim@target.local';

  // Record 5 failures at t = 1,000,000
  for (let i = 0; i < 5; i++) {
    limiter.recordFailure(key);
  }
  assert.strictEqual(limiter.isBlocked(key), true, 'Account must be blocked after 5 failures');

  // Advance time by 14 minutes (840,000 ms) -> still inside 15 min window
  simulatedTime += 14 * 60 * 1000;
  assert.strictEqual(limiter.isBlocked(key), true, 'Account must still be blocked at 14 minutes');

  // Advance time by 61 seconds (total elapsed 15m 1s) -> oldest failure drops out of window
  simulatedTime += 61 * 1000;
  assert.strictEqual(limiter.isBlocked(key), false, 'Account must be unblocked after window rolls over');

  const check = store.check(key);
  assert.strictEqual(check.allowed, true);
  assert.strictEqual(check.remaining, 5, 'All entries recorded at t=1,000,000 must have expired');

  limiter.destroy();
});

// ============================================================================
// SUITE 2: Counter Reset Verification
// ============================================================================

test('ADV-M3-2.1: 4 failed logins followed by 1 successful login resets failure counter (subsequent logins not blocked)', async () => {
  const authService = createMockAuthService();
  const loginLimiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxFailures: 5,
  });

  await withTestServer((app) => {
    const authMiddleware = createAuthMiddleware(authService);
    app.use(createAuthRouter({
      authService,
      authMiddleware,
      loginRateLimiter: loginLimiter,
    }));
  }, async (baseUrl) => {
    const email = 'legit@target.local';
    const badPassword = 'WrongPassword!';
    const goodPassword = 'LegitPassword123!';

    // Step 1: 4 failed attempts
    for (let i = 1; i <= 4; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: badPassword }),
      });
      assert.strictEqual(res.status, 401, `Failed attempt ${i} must return 401`);
    }

    // Step 2: 5th attempt is successful
    const successRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: goodPassword }),
    });
    assert.strictEqual(successRes.status, 200, '5th attempt with correct credentials must return 200 OK');
    const successBody = await successRes.json();
    assert.strictEqual(successBody.message, 'Login successful');

    // Step 3: Attempt 6: another login attempt (with bad password) must NOT be blocked with 429
    const sixthRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: badPassword }),
    });
    assert.strictEqual(sixthRes.status, 401, 'Attempt after successful reset must be admitted (returns 401, not 429)');

    // Step 4: 3 more failures (total 4 failures after reset) -> still admitted
    for (let i = 2; i <= 4; i++) {
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: badPassword }),
      });
      assert.strictEqual(r.status, 401, `Post-reset failure ${i} must return 401`);
    }

    // 5th failure after reset (the 5th failed attempt post-reset)
    const fifthPostReset = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: badPassword }),
    });
    assert.strictEqual(fifthPostReset.status, 401, '5th post-reset failure must return 401');

    // 6th attempt post-reset -> now blocked with 429
    const blockedPostReset = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: badPassword }),
    });
    assert.strictEqual(blockedPostReset.status, 429, '6th post-reset attempt must return 429');

    loginLimiter.destroy();
  });
});

test('ADV-M3-2.2: 400 Bad Request input validation errors do NOT increment failure counter', async () => {
  const authService = createMockAuthService();
  const loginLimiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxFailures: 5,
  });

  await withTestServer((app) => {
    const authMiddleware = createAuthMiddleware(authService);
    app.use(createAuthRouter({
      authService,
      authMiddleware,
      loginRateLimiter: loginLimiter,
    }));
  }, async (baseUrl) => {
    // Send 10 malformed login requests (missing password, empty email)
    for (let i = 1; i <= 10; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'legit@target.local' }), // missing password
      });
      assert.strictEqual(res.status, 400, 'Malformed body must return 400 Bad Request');
    }

    // Now send legitimate login with correct credentials -> must succeed immediately
    const validRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legit@target.local', password: 'LegitPassword123!' }),
    });
    assert.strictEqual(validRes.status, 200, '400 errors must not exhaust brute force threshold; login must succeed 200');

    loginLimiter.destroy();
  });
});

// ============================================================================
// SUITE 3: Multi-Tenant & Distributed IP Evasion
// ============================================================================

test('ADV-M3-3.1: Anti-DoS / Distributed Evasion — Multiple IPs targeting the same email are tracked separately', () => {
  const limiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxFailures: 5,
  });

  const email = 'ceo@target.local';
  const attackerIp = '198.51.100.1';
  const legitOfficeIp = '203.0.113.50';

  const attackerReq = { ip: attackerIp, body: { email } };
  const legitReq = { ip: legitOfficeIp, body: { email } };

  // Attacker fails 5 times from attackerIp
  for (let i = 0; i < 5; i++) {
    const listeners = {};
    const res = { statusCode: 401, on(ev, fn) { listeners[ev] = fn; } };
    limiter(attackerReq, res, () => {});
    listeners['finish']();
  }

  // Attacker IP is blocked
  assert.strictEqual(limiter.isBlocked(`${attackerIp}:${email}`), true);

  // Legitimate user from office IP is NOT blocked (preventing DoS lockout)
  assert.strictEqual(
    limiter.isBlocked(`${legitOfficeIp}:${email}`),
    false,
    'Legitimate user from distinct IP must not be locked out by attacker brute force'
  );

  let legitNextCalled = false;
  limiter(legitReq, { on() {} }, () => { legitNextCalled = true; });
  assert.strictEqual(legitNextCalled, true, 'Legitimate user request must call next()');

  limiter.destroy();
});

test('ADV-M3-3.2: Account Enumeration — Same IP targeting multiple emails tracks each account independently', () => {
  const limiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxFailures: 5,
  });

  const ip = '198.51.100.99';
  const emailA = 'alice@target.local';
  const emailB = 'bob@target.local';

  // Fail 5 times on alice
  for (let i = 0; i < 5; i++) {
    const listeners = {};
    limiter({ ip, body: { email: emailA } }, { statusCode: 401, on(e, fn) { listeners[e] = fn; } }, () => {});
    listeners['finish']();
  }

  assert.strictEqual(limiter.isBlocked(`${ip}:${emailA}`), true, 'Alice must be blocked');
  assert.strictEqual(limiter.isBlocked(`${ip}:${emailB}`), false, 'Bob must NOT be blocked');

  limiter.destroy();
});

test('ADV-M3-3.3: Case & Whitespace Normalization Resilience (cannot bypass limiter via string casing or padding)', () => {
  const limiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxFailures: 5,
  });

  const ip = '127.0.0.1';
  const variations = [
    '  Victim@Target.Local  ',
    'VICTIM@TARGET.LOCAL',
    'victim@target.local',
    '  victim@target.local',
    'Victim@Target.Local',
  ];

  // Record 5 failures using varied casing and whitespace
  for (const v of variations) {
    const listeners = {};
    limiter({ ip, body: { email: v } }, { statusCode: 401, on(e, fn) { listeners[e] = fn; } }, () => {});
    listeners['finish']();
  }

  // 6th attempt with mixed case must be blocked
  let nextCalled = false;
  let resStatus = null;
  const dummyRes = {
    statusCode: 200,
    setHeader() {},
    status(c) { resStatus = c; return this; },
    json() { return this; },
    on() {},
  };

  limiter({ ip, body: { email: 'vIcTiM@tArGeT.lOcAl' } }, dummyRes, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false, '6th attempt with varied casing must be blocked');
  assert.strictEqual(resStatus, 429, 'Status must be 429');

  limiter.destroy();
});

// ============================================================================
// SUITE 4: Run Creation Rate Limit Flood (Feature 10)
// ============================================================================

test('ADV-M3-4.1: Rapid burst of 25 run creation requests admits 10 and rejects 15 with HTTP 429 and headers', async () => {
  const runLimiter = createRunRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 10,
  });

  await withTestServer((app) => {
    // Simulate authenticated session
    app.use((req, res, next) => {
      req.user = { id: 42, role: 'member' };
      req.session = { sessionToken: 'session_token_xyz_42' };
      next();
    });

    app.post('/api/runs', runLimiter, (req, res) => {
      res.status(201).json({ id: 'run_created_ok', status: 'created' });
    });
  }, async (baseUrl) => {
    const responses = [];

    // Rapid burst of 25 run creation requests
    for (let i = 1; i <= 25; i++) {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'etsy', query: 'vintage shirts' }),
      });
      const data = await res.json();
      responses.push({
        index: i,
        status: res.status,
        limit: res.headers.get('RateLimit-Limit'),
        remaining: res.headers.get('RateLimit-Remaining'),
        reset: res.headers.get('RateLimit-Reset'),
        retryAfter: res.headers.get('Retry-After'),
        data,
      });
    }

    // Verify 1st to 10th: 201 Created with RateLimit-* headers
    for (let i = 0; i < 10; i++) {
      const r = responses[i];
      assert.strictEqual(r.status, 201, `Run ${r.index} must be admitted with 201`);
      assert.strictEqual(r.limit, '10');
      assert.strictEqual(r.remaining, String(9 - i));
      assert.ok(r.reset !== null, `Run ${r.index} must have RateLimit-Reset header`);
      assert.strictEqual(r.retryAfter, null);
    }

    // Verify 11th to 25th: 429 Too Many Requests with Retry-After header
    for (let i = 10; i < 25; i++) {
      const r = responses[i];
      assert.strictEqual(r.status, 429, `Run ${r.index} must be rejected with 429`);
      assert.strictEqual(r.data.error, 'TOO_MANY_REQUESTS');
      assert.strictEqual(r.data.message, 'Run creation rate limit exceeded. Maximum 10 requests per minute.');
      assert.ok(r.retryAfter !== null, `Run ${r.index} must have Retry-After header`);
      assert.strictEqual(parseInt(r.retryAfter, 10), r.data.retryAfterSeconds);
    }

    const count201 = responses.filter((r) => r.status === 201).length;
    const count429 = responses.filter((r) => r.status === 429).length;
    assert.strictEqual(count201, 10, 'Exactly 10 runs must be created');
    assert.strictEqual(count429, 15, 'Exactly 15 runs must be rejected with 429');

    runLimiter.destroy();
  });
});

test('ADV-M3-4.2: Rate limiter covers all run creation entrypoints and aliases (/api/runs, /api/jobs, /api/collection/enqueue, etc.)', async () => {
  const runLimiter = createRunRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 3, // Low cap for test
  });

  await withTestServer((app) => {
    app.use((req, res, next) => {
      req.user = { id: 77 };
      next();
    });

    const RUN_CREATION_PATHS = [
      '/api/runs',
      '/api/collection/enqueue',
      '/api/jobs',
      '/api/html-captures',
      '/api/user-journey/run',
    ];

    for (const p of RUN_CREATION_PATHS) {
      app.post(p, runLimiter, (req, res) => res.status(200).json({ ok: true, path: p }));
    }
  }, async (baseUrl) => {
    // 3 requests across different paths share the user quota:
    const r1 = await fetch(`${baseUrl}/api/runs`, { method: 'POST' });
    assert.strictEqual(r1.status, 200);

    const r2 = await fetch(`${baseUrl}/api/jobs`, { method: 'POST' });
    assert.strictEqual(r2.status, 200);

    const r3 = await fetch(`${baseUrl}/api/collection/enqueue`, { method: 'POST' });
    assert.strictEqual(r3.status, 200);

    // 4th request on /api/html-captures must be blocked
    const r4 = await fetch(`${baseUrl}/api/html-captures`, { method: 'POST' });
    assert.strictEqual(r4.status, 429, '4th request across shared paths must be rejected with 429');

    // 5th request on /api/user-journey/run must also be blocked
    const r5 = await fetch(`${baseUrl}/api/user-journey/run`, { method: 'POST' });
    assert.strictEqual(r5.status, 429, '5th request across shared paths must be rejected with 429');

    runLimiter.destroy();
  });
});

test('ADV-M3-4.3: Multi-tenant quota isolation between distinct users (User A exhaust does not affect User B)', () => {
  const limiter = createRunRateLimiter({ windowMs: 60000, maxRequests: 2 });
  const userAReq = { user: { id: 1001 } };
  const userBReq = { user: { id: 1002 } };

  const dummyRes = { setHeader() {}, status() { return this; }, json() { return this; } };

  // User A consumes 2
  limiter(userAReq, dummyRes, () => {});
  limiter(userAReq, dummyRes, () => {});
  assert.strictEqual(limiter.isBlocked('user:1001'), true);

  // User B is fresh
  assert.strictEqual(limiter.isBlocked('user:1002'), false);
  let userBCalled = false;
  limiter(userBReq, dummyRes, () => { userBCalled = true; });
  assert.strictEqual(userBCalled, true, 'User B must not be throttled by User A consumption');

  limiter.destroy();
});

// ============================================================================
// SUITE 5: Header Manipulation & IP Spoofing
// ============================================================================

test('ADV-M3-5.1: Express Live Socket — Spoofed X-Forwarded-For cannot bypass login rate limit when trust proxy is false', async () => {
  const authService = createMockAuthService();
  const loginLimiter = createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxFailures: 5,
  });

  await withTestServer((app) => {
    // Note: app.set('trust proxy', false) is Express default
    const authMiddleware = createAuthMiddleware(authService);
    app.use(createAuthRouter({
      authService,
      authMiddleware,
      loginRateLimiter: loginLimiter,
    }));
  }, async (baseUrl) => {
    const email = 'victim@target.local';

    // Attacker rotates X-Forwarded-For on each of the 5 requests
    for (let i = 1; i <= 5; i++) {
      const spoofedIp = `198.51.100.${i}`;
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': spoofedIp,
        },
        body: JSON.stringify({ email, password: 'wrong' }),
      });
      assert.strictEqual(res.status, 401, `Spoofed attempt ${i} must return 401`);
    }

    // 6th attempt with another spoofed IP must be BLOCKED (429) because Express uses socket remoteAddress
    const res6 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.99',
      },
      body: JSON.stringify({ email, password: 'wrong' }),
    });
    assert.strictEqual(res6.status, 429, 'Spoofed X-Forwarded-For must NOT bypass login limit; 6th attempt must be 429');

    loginLimiter.destroy();
  });
});

test('ADV-M3-5.2: Authenticated Run Creation — Spoofed IP headers cannot evade run rate limits (quota bound to identity)', async () => {
  const runLimiter = createRunRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 5,
  });

  await withTestServer((app) => {
    app.use((req, res, next) => {
      // Authenticated via API key or user
      req.user = { id: 88, apiKeyId: 'key_88' };
      next();
    });
    app.post('/api/runs', runLimiter, (req, res) => res.status(200).json({ ok: true }));
  }, async (baseUrl) => {
    // Send 5 requests with 5 different spoofed IPs
    for (let i = 1; i <= 5; i++) {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: {
          'X-Forwarded-For': `10.0.0.${i}`,
          'X-Real-IP': `10.0.0.${i}`,
          'Client-IP': `10.0.0.${i}`,
        },
      });
      assert.strictEqual(res.status, 200, `Run ${i} must succeed`);
    }

    // 6th request with another spoofed IP must be blocked
    const res6 = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'X-Forwarded-For': '10.0.0.99' },
    });
    assert.strictEqual(res6.status, 429, 'Spoofed IP headers cannot evade authenticated run quota');

    runLimiter.destroy();
  });
});

test('ADV-M3-5.3: Adversarial and malformed payload resilience (prototype pollution, giant strings, non-string types)', () => {
  const keyGen = createLoginKeyGenerator();

  // 1. Prototype pollution keys in email
  const pollReq = { ip: '127.0.0.1', body: { email: '__proto__' } };
  const pollKey = keyGen(pollReq);
  assert.strictEqual(pollKey, '127.0.0.1:__proto__');
  assert.strictEqual(Object.prototype.hasOwnProperty('polluted'), false);

  // 2. Giant email string (10,000 characters) is truncated to 256 characters
  const giantEmail = 'a'.repeat(10000) + '@target.local';
  const giantReq = { ip: '127.0.0.1', body: { email: giantEmail } };
  const giantKey = keyGen(giantReq);
  assert.strictEqual(giantKey.length, '127.0.0.1:'.length + 256);

  // 3. Non-string types in email body (object, array, number, boolean, null)
  const nonStringReqs = [
    { ip: '127.0.0.1', body: { email: { $ne: null } } },
    { ip: '127.0.0.1', body: { email: ['admin@target.local'] } },
    { ip: '127.0.0.1', body: { email: 12345 } },
    { ip: '127.0.0.1', body: { email: true } },
    { ip: '127.0.0.1', body: { email: null } },
    { ip: '127.0.0.1', body: {} },
    { ip: '127.0.0.1' }, // body undefined
  ];

  for (const r of nonStringReqs) {
    const k = keyGen(r);
    assert.strictEqual(k, '127.0.0.1:__anonymous__', `Non-string body must safely fall back to __anonymous__`);
  }

  // 4. Null bytes in email
  const nullByteReq = { ip: '127.0.0.1', body: { email: 'admin\x00@target.local' } };
  const nullByteKey = keyGen(nullByteReq);
  assert.ok(typeof nullByteKey === 'string');
});

// ============================================================================
// SUITE 6: Memory Leak & Capacity Stress (SlidingWindowMemoryStore)
// ============================================================================

test('ADV-M3-6.1: High-Volume Flood — 15,000 distinct keys in store capped at maxKeys: 10000 with zero unbounded growth', () => {
  const store = new SlidingWindowMemoryStore({
    windowMs: 60000,
    maxEntries: 5,
    maxKeys: 10000, // Explicitly set to default production capacity
    sweepIntervalMs: 0, // Disable automatic background sweep for deterministic test
  });

  // Generate 15,000 distinct keys
  for (let i = 0; i < 15000; i++) {
    const key = `flood_key_${i}`;
    store.record(key);

    if (i >= 10000) {
      assert.strictEqual(
        store.hits.size,
        10000,
        `Store size must NEVER exceed maxKeys (10,000) during insertion ${i}`
      );
    }
  }

  // Verification: store capacity is exactly 10,000
  assert.strictEqual(store.hits.size, 10000, 'Final store size must be exactly 10,000');

  // Verification: first 5,000 keys (0 to 4,999) were LRU-evicted
  for (let i = 0; i < 5000; i++) {
    assert.strictEqual(store.hits.has(`flood_key_${i}`), false, `Key ${i} must have been evicted`);
  }

  // Verification: last 10,000 keys (5,000 to 14,999) are present
  for (let i = 5000; i < 15000; i++) {
    assert.strictEqual(store.hits.has(`flood_key_${i}`), true, `Key ${i} must be retained`);
  }

  store.destroy();
});

test('ADV-M3-6.2: Consume capacity cap — 15,000 distinct keys via consume() strictly bounded at maxKeys', () => {
  const store = new SlidingWindowMemoryStore({
    windowMs: 60000,
    maxEntries: 10,
    maxKeys: 10000,
    sweepIntervalMs: 0,
  });

  for (let i = 0; i < 15000; i++) {
    const key = `consume_key_${i}`;
    store.consume(key);

    if (i >= 10000) {
      assert.strictEqual(store.hits.size, 10000);
    }
  }

  assert.strictEqual(store.hits.size, 10000);
  assert.strictEqual(store.hits.has('consume_key_0'), false);
  assert.strictEqual(store.hits.has('consume_key_14999'), true);

  store.destroy();
});

test('ADV-M3-6.3: LRU Map Order Promotion Stress — Re-accessed key survives eviction while un-accessed oldest is evicted', () => {
  const store = new SlidingWindowMemoryStore({
    windowMs: 60000,
    maxEntries: 5,
    maxKeys: 3, // Small capacity for exact order verification
    sweepIntervalMs: 0,
  });

  store.record('k0'); // oldest
  store.record('k1');
  store.record('k2'); // newest
  assert.strictEqual(store.hits.size, 3);

  // Access k0 again (promotes k0 to newest / most recently used)
  store.record('k0');

  // Insert k3 -> capacity exceeded -> oldest entry must be evicted
  store.record('k3');

  assert.strictEqual(store.hits.size, 3);
  assert.strictEqual(store.hits.has('k0'), true, 'k0 must NOT be evicted because it was promoted');
  assert.strictEqual(store.hits.has('k1'), false, 'k1 must be evicted because it became the oldest');
  assert.strictEqual(store.hits.has('k2'), true, 'k2 must be retained');
  assert.strictEqual(store.hits.has('k3'), true, 'k3 must be retained');

  store.destroy();
});

test('ADV-M3-6.4: Background Sweep & Time Eviction clears expired keys and reclaims memory', () => {
  let simulatedTime = 1000000;
  const store = new SlidingWindowMemoryStore({
    windowMs: 60000,
    maxEntries: 5,
    maxKeys: 10000,
    sweepIntervalMs: 0,
    nowProvider: () => simulatedTime,
  });

  // Insert 2,000 keys at t = 1,000,000
  for (let i = 0; i < 2000; i++) {
    store.record(`sweep_key_${i}`);
  }
  assert.strictEqual(store.hits.size, 2000);

  // Advance clock past windowMs (60s + 1ms)
  simulatedTime += 60001;

  // Run sweep()
  store.sweep();

  // All 2,000 keys must be swept out of memory
  assert.strictEqual(store.hits.size, 0, 'All expired keys must be swept, reducing Map size to 0');

  store.destroy();
});

test('ADV-M3-6.5: Memory Footprint & Heap Stability under 50,000 continuous operations', () => {
  const store = new SlidingWindowMemoryStore({
    windowMs: 60000,
    maxEntries: 10,
    maxKeys: 5000,
    sweepIntervalMs: 0,
  });

  const heapBefore = process.memoryUsage().heapUsed;

  // Run 50,000 mixed record/consume/check operations across 25,000 keys
  for (let i = 0; i < 50000; i++) {
    const key = `load_${i % 25000}`;
    if (i % 3 === 0) store.record(key);
    else if (i % 3 === 1) store.consume(key);
    else store.check(key);
  }

  assert.strictEqual(store.hits.size, 5000, 'Store must remain strictly capped at maxKeys: 5000');

  // Verify heap has not exploded (reasonable bounds check)
  const heapAfter = process.memoryUsage().heapUsed;
  const heapGrowthMB = (heapAfter - heapBefore) / (1024 * 1024);
  assert.ok(
    heapGrowthMB < 50,
    `Heap growth during 50,000 ops (${heapGrowthMB.toFixed(2)} MB) must be well within bounded limits (< 50 MB)`
  );

  store.destroy();
});
