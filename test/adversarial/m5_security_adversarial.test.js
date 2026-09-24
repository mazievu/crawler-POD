'use strict';

/**
 * test/adversarial/m5_security_adversarial.test.js — Milestone M5 Security & Ingress Core Adversarial Suite
 *
 * Tier 5 White-Box Adversarial Hardening:
 * 1. Authentication, Session, API Keys & RBAC Stress
 * 2. Outbound Guard SSRF, Redirects & Stream Limits
 * 3. Rate Limiting Sliding Windows, Boundary Attacks, IP Spoofing & Memory Exhaustion
 * 4. MCP Bridge Lockdown, Constant-Time Key Verification, Path Traversal & Query Hardening
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const {
  AuthService,
  hashPassword,
  verifyPassword,
  hashApiKey,
  generateRawApiKey,
  generateSessionToken,
} = require('../../src/security/auth.service');

const {
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createAuthMiddleware,
} = require('../../src/security/auth.middleware');

const {
  SSRFSecurityError,
  validateOutboundUrl,
  safeFetch,
  parseAndNormalizeIp,
  isPrivateIp,
} = require('../../src/security/outbound-guard');

const {
  SlidingWindowMemoryStore,
  getClientIp,
  createLoginKeyGenerator,
  createRunKeyGenerator,
  createLoginRateLimiter,
  createRunRateLimiter,
} = require('../../src/security/rate-limit.middleware');

const {
  createMcpBridgeRouter,
  assertReadOnlySql,
  isLoopbackAddress,
  extractInternalServiceKey,
  verifyInternalServiceKey,
  guardInternalService,
} = require('../../src/routes/mcp-bridge');

// ============================================================================
// Shared Mock Database Helper for Auth Testing
// ============================================================================
function createMockAuthDb() {
  const users = new Map();
  const sessions = new Map();
  const apiKeys = new Map();
  let idSeq = 1;

  return {
    users,
    sessions,
    apiKeys,
    async createUser({ email, passwordHash, role = 'member', status = 'active' }) {
      const cleanEmail = email.trim().toLowerCase();
      if (users.has(cleanEmail)) {
        return users.get(cleanEmail);
      }
      const user = { id: idSeq++, email: cleanEmail, password_hash: passwordHash, role, status };
      users.set(cleanEmail, user);
      return user;
    },
    async findUserByEmail(email) {
      return users.get(email.trim().toLowerCase()) || null;
    },
    async findUserById(id) {
      for (const u of users.values()) {
        if (u.id === Number(id)) return u;
      }
      return null;
    },
    async updateUserStatus(id, status) {
      for (const u of users.values()) {
        if (u.id === Number(id)) {
          u.status = status;
          return true;
        }
      }
      return false;
    },
    async createSession({ userId, sessionToken, expiresAt, ipAddress = null, userAgent = null }) {
      const s = {
        session_id: idSeq++,
        user_id: Number(userId),
        session_token: sessionToken,
        expires_at: typeof expiresAt === 'string' ? expiresAt : new Date(expiresAt).toISOString(),
        ip_address: ipAddress,
        user_agent: userAgent,
        created_at: new Date().toISOString(),
      };
      sessions.set(sessionToken, s);
      return { id: s.session_id, userId, sessionToken, expiresAt: s.expires_at };
    },
    async findSessionByToken(token) {
      const s = sessions.get(token);
      if (!s) return null;
      let foundUser = null;
      for (const u of users.values()) {
        if (u.id === s.user_id) {
          foundUser = u;
          break;
        }
      }
      if (!foundUser) return null;
      return {
        session_id: s.session_id,
        user_id: s.user_id,
        session_token: s.session_token,
        expires_at: s.expires_at,
        email: foundUser.email,
        role: foundUser.role,
        user_status: foundUser.status,
      };
    },
    async deleteSession(token) {
      const existed = sessions.has(token);
      sessions.delete(token);
      return { changes: existed ? 1 : 0 };
    },
    async deleteSessionsByUserId(userId) {
      let count = 0;
      for (const [token, s] of sessions.entries()) {
        if (s.user_id === Number(userId)) {
          sessions.delete(token);
          count++;
        }
      }
      return { changes: count };
    },
    async cleanExpiredSessions() {
      let count = 0;
      const now = new Date();
      for (const [token, s] of sessions.entries()) {
        if (new Date(s.expires_at) <= now) {
          sessions.delete(token);
          count++;
        }
      }
      return count;
    },
    async createApiKey({ userId, name, keyHash, prefix, role = 'member', expiresAt = null }) {
      const rec = {
        id: idSeq++,
        user_id: userId ? Number(userId) : null,
        name,
        key_hash: keyHash,
        prefix,
        role,
        is_revoked: false,
        expires_at: expiresAt ? (typeof expiresAt === 'string' ? expiresAt : new Date(expiresAt).toISOString()) : null,
        created_at: new Date().toISOString(),
      };
      apiKeys.set(keyHash, rec);
      return rec;
    },
    async findApiKeyByHash(keyHash) {
      const rec = apiKeys.get(keyHash);
      if (!rec) return null;
      let userEmail = null;
      let userStatus = 'active';
      if (rec.user_id) {
        for (const u of users.values()) {
          if (u.id === rec.user_id) {
            userEmail = u.email;
            userStatus = u.status;
            break;
          }
        }
      }
      return {
        ...rec,
        user_email: userEmail,
        user_status: userStatus,
      };
    },
    async revokeApiKey(id) {
      for (const rec of apiKeys.values()) {
        if (rec.id === Number(id)) {
          rec.is_revoked = true;
          return true;
        }
      }
      return false;
    },
    async listApiKeys() {
      return Array.from(apiKeys.values());
    },
  };
}

// ============================================================================
// CHAPTER 1: AUTHENTICATION, SESSION, API KEYS & RBAC ADVERSARIAL STRESS
// ============================================================================

test('M5-AUTH-1.1: Session token entropy and randomness distribution', () => {
  const tokenCount = 1000;
  const tokens = new Set();
  const hexDigitCounts = new Array(16).fill(0);

  for (let i = 0; i < tokenCount; i++) {
    const token = generateSessionToken();
    assert.equal(token.length, 64, 'Token must be exactly 64 hex characters (32 bytes)');
    assert.match(token, /^[0-9a-f]{64}$/, 'Token must consist strictly of lowercase hex digits');
    tokens.add(token);

    for (const ch of token) {
      hexDigitCounts[parseInt(ch, 16)]++;
    }
  }

  // 1. Zero collisions across 1,000 tokens
  assert.equal(tokens.size, tokenCount, 'All generated session tokens must be unique');

  // 2. Uniformity check: total hex digits = 64,000, expected per digit = 4,000
  const expectedPerDigit = (tokenCount * 64) / 16;
  for (let i = 0; i < 16; i++) {
    const diff = Math.abs(hexDigitCounts[i] - expectedPerDigit);
    const deviation = diff / expectedPerDigit;
    assert.ok(deviation < 0.15, `Hex digit ${i.toString(16)} frequency deviated by ${deviation * 100}%`);
  }
});

test('M5-AUTH-1.2: Session token boundary validation and format strictness', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);

  const invalidTokens = [
    '', // empty
    '   ', // whitespace
    'a'.repeat(63), // 63 chars (underflow)
    'a'.repeat(65), // 65 chars (overflow)
    '0'.repeat(32), // 32 chars
    'z'.repeat(64), // non-hex character
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde!', // symbol
    '0123456789abcdef0123456789abcdef\x00123456789abcdef0123456789abcdef', // null byte
    ' 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ', // padded
    null,
    undefined,
    123456,
  ];

  for (const token of invalidTokens) {
    const result = await auth.validateSession(token);
    assert.equal(result, null, `Malformed token "${token}" should be rejected immediately`);
  }
});

test('M5-AUTH-1.3: Session expiration millisecond boundary conditions', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);
  const user = await db.createUser({ email: 'boundary@example.com', passwordHash: 'hash', role: 'member' });

  // 1. Session expiring 1 second from now
  const now = Date.now();
  const tokenValid = generateSessionToken();
  await db.createSession({
    userId: user.id,
    sessionToken: tokenValid,
    expiresAt: new Date(now + 2000).toISOString(),
  });

  const validRes = await auth.validateSession(tokenValid);
  assert.ok(validRes, 'Session before expiration must be valid');
  assert.equal(validRes.user.email, 'boundary@example.com');

  // 2. Session expired 1 millisecond ago
  const tokenExpired = generateSessionToken();
  await db.createSession({
    userId: user.id,
    sessionToken: tokenExpired,
    expiresAt: new Date(now - 1).toISOString(),
  });

  const expiredRes = await auth.validateSession(tokenExpired);
  assert.equal(expiredRes, null, 'Session expired 1ms ago must return null');
  assert.equal(db.sessions.has(tokenExpired), false, 'Expired session must be automatically purged from DB');
});

test('M5-AUTH-1.4: Instant session invalidation on user deactivation or status change', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);
  const user = await db.createUser({ email: 'active@example.com', passwordHash: 'hash', role: 'member', status: 'active' });

  const token = generateSessionToken();
  await db.createSession({
    userId: user.id,
    sessionToken: token,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });

  // Verify initially valid
  const initial = await auth.validateSession(token);
  assert.ok(initial, 'Initially active user session should validate');

  // Deactivate user
  await db.updateUserStatus(user.id, 'suspended');

  // Subsequent validation should instantly return null
  const suspended = await auth.validateSession(token);
  assert.equal(suspended, null, 'Suspended user session must return null immediately');

  // Reactivate user
  await db.updateUserStatus(user.id, 'active');
  const restored = await auth.validateSession(token);
  assert.ok(restored, 'Active status restoration should allow session validation again');
});

test('M5-AUTH-1.5: Concurrent session revocation race conditions', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);
  const user = await db.createUser({ email: 'race@example.com', passwordHash: 'hash', role: 'member' });

  const token = generateSessionToken();
  await db.createSession({
    userId: user.id,
    sessionToken: token,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });

  // Launch 30 concurrent validateSession and revokeSession operations
  const promises = [];
  for (let i = 0; i < 15; i++) {
    promises.push(auth.validateSession(token));
  }
  promises.push(auth.revokeSession(token));
  for (let i = 0; i < 15; i++) {
    promises.push(auth.validateSession(token));
  }

  const results = await Promise.all(promises);
  assert.ok(results.length === 31, 'All concurrent operations should resolve');

  // Final check: token must definitely be revoked
  const finalCheck = await auth.validateSession(token);
  assert.equal(finalCheck, null, 'Revoked token must not validate after revocation complete');
});

test('M5-AUTH-1.6: Cross-user session isolation and concurrency stress', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);
  const middleware = createAuthMiddleware(auth);

  const userA = await db.createUser({ email: 'usera@example.com', passwordHash: 'hashA', role: 'member' });
  const userB = await db.createUser({ email: 'adminb@example.com', passwordHash: 'hashB', role: 'admin' });

  const tokenA = generateSessionToken();
  const tokenB = generateSessionToken();

  await db.createSession({ userId: userA.id, sessionToken: tokenA, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  await db.createSession({ userId: userB.id, sessionToken: tokenB, expiresAt: new Date(Date.now() + 3600000).toISOString() });

  // Concurrently simulate 50 requests alternating between user A and user B
  const reqPromises = [];
  for (let i = 0; i < 50; i++) {
    const isUserA = i % 2 === 0;
    const req = {
      headers: {
        cookie: `crawler_session=${isUserA ? tokenA : tokenB}`,
      },
    };
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; return this; },
    };

    reqPromises.push(new Promise((resolve, reject) => {
      middleware.requireAuth(req, res, (err) => {
        if (err) return reject(err);
        try {
          if (isUserA) {
            assert.equal(req.user.id, userA.id);
            assert.equal(req.user.email, 'usera@example.com');
            assert.equal(req.user.role, 'member');
          } else {
            assert.equal(req.user.id, userB.id);
            assert.equal(req.user.email, 'adminb@example.com');
            assert.equal(req.user.role, 'admin');
          }
          resolve(true);
        } catch (assertErr) {
          reject(assertErr);
        }
      });
    }));
  }

  await Promise.all(reqPromises);
});

test('M5-AUTH-1.7: Cookie parser prototype pollution and malformed header resilience', () => {
  // Test prototype pollution attempt in cookie string
  const maliciousCookie = '__proto__=polluted; constructor=hack; crawler_session=abc123; dummy; =novalue; valid=123';
  const cookies = parseCookies(maliciousCookie);

  assert.equal(cookies.crawler_session, 'abc123');
  assert.equal(cookies.valid, '123');
  assert.equal(Object.prototype.polluted, undefined, 'Prototype pollution attempt must not contaminate Object.prototype');

  // Empty and garbage cookies
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(null), {});
  assert.deepEqual(parseCookies(';;;'), {});
  assert.deepEqual(parseCookies('   '), {});
});

test('M5-AUTH-1.8: Cookie security attributes enforcement', () => {
  const dummyRes = {
    headers: {},
    setHeader(name, val) { this.headers[name.toLowerCase()] = val; },
  };

  // 1. setSessionCookie in dev
  process.env.NODE_ENV = 'development';
  setSessionCookie(dummyRes, 'dummytoken123');
  const devCookie = dummyRes.headers['set-cookie'];
  assert.ok(devCookie.includes('crawler_session=dummytoken123'));
  assert.ok(devCookie.includes('HttpOnly'));
  assert.ok(devCookie.includes('SameSite=Lax'));
  assert.ok(!devCookie.includes('Secure'));

  // 2. setSessionCookie in prod or options.secure
  setSessionCookie(dummyRes, 'dummytoken123', { secure: true });
  const prodCookie = dummyRes.headers['set-cookie'];
  assert.ok(prodCookie.includes('Secure'), 'Production or secure option must set Secure flag');

  // 3. clearSessionCookie
  clearSessionCookie(dummyRes);
  const clearCookie = dummyRes.headers['set-cookie'];
  assert.ok(clearCookie.includes('Expires=Thu, 01 Jan 1970 00:00:00 GMT'));
  assert.ok(clearCookie.includes('HttpOnly'));
});

test('M5-AUTH-1.9: API key prefix validation and role scoping enforcement', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);
  const middleware = createAuthMiddleware(auth);

  const memberKey = await auth.createApiKey({ name: 'Member Key', role: 'member', prefix: 'cp_live_' });
  const adminKey = await auth.createApiKey({ name: 'Admin Key', role: 'admin', prefix: 'cp_adm_' });

  assert.ok(memberKey.rawKey.startsWith('cp_live_'));
  assert.ok(adminKey.rawKey.startsWith('cp_adm_'));

  // 1. Member API key authentication
  const reqMember = { headers: { 'x-api-key': memberKey.rawKey } };
  const resMember = { status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } };

  await new Promise((resolve) => middleware.requireAuth(reqMember, resMember, resolve));
  assert.equal(reqMember.user.role, 'member');

  // 2. Member API key attempting requireAdmin -> 403 Forbidden
  let forbiddenCalled = false;
  const resAdminGuard = {
    status(c) {
      assert.equal(c, 403);
      forbiddenCalled = true;
      return this;
    },
    json(j) {
      assert.equal(j.error, 'Forbidden');
      return this;
    },
  };
  middleware.requireAdmin(reqMember, resAdminGuard, () => {
    assert.fail('Member API key should not pass requireAdmin');
  });
  assert.ok(forbiddenCalled, 'requireAdmin must return HTTP 403 for member API key');

  // 3. Unrecognized prefixes rejected
  const fakePrefixes = ['cp_dev_123', 'cp_test_123', 'admin_123', 'cp_123', 'token123'];
  for (const fake of fakePrefixes) {
    const reqFake = { headers: { 'x-api-key': fake } };
    const resFake = {
      status(c) {
        assert.equal(c, 401);
        return this;
      },
      json(j) {
        assert.equal(j.error, 'Unauthorized');
        return this;
      },
    };
    await middleware.requireAuth(reqFake, resFake, () => {
      assert.fail(`Unrecognized prefix ${fake} should be rejected`);
    });
  }
});

test('M5-AUTH-1.10: Expired, revoked, and deactivated user API key rejection', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);

  const user = await db.createUser({ email: 'apikey@example.com', passwordHash: 'hash', role: 'member', status: 'active' });

  // 1. Expired API Key (set explicit expired date in DB)
  const expiredRawKey = generateRawApiKey('cp_live_');
  await db.createApiKey({
    userId: user.id,
    name: 'Expired',
    keyHash: hashApiKey(expiredRawKey),
    prefix: 'cp_live_',
    expiresAt: new Date(Date.now() - 5000).toISOString(),
  });
  const valExpired = await auth.validateApiKey(expiredRawKey);
  assert.equal(valExpired, null, 'Expired API key must return null');

  // 2. Revoked API Key
  const activeKey = await auth.createApiKey({ userId: user.id, name: 'To Revoke', expiresInDays: 10 });
  await auth.revokeApiKey(activeKey.record.id);
  const valRevoked = await auth.validateApiKey(activeKey.rawKey);
  assert.equal(valRevoked, null, 'Revoked API key must return null');

  // 3. Deactivated User's API Key
  const userKey = await auth.createApiKey({ userId: user.id, name: 'User Key', expiresInDays: 10 });
  await db.updateUserStatus(user.id, 'banned');
  const valBanned = await auth.validateApiKey(userKey.rawKey);
  assert.equal(valBanned, null, 'API key belonging to banned user must return null');
});

test('M5-AUTH-1.11: Header injection and malformed authorization headers on API key routes', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);
  const middleware = createAuthMiddleware(auth);

  const malformedAuthHeaders = [
    'Basic YWRtaW46cGFzc3dvcmQ=', // Basic auth scheme
    'Token cp_live_12345', // Token scheme
    'Bearer', // Missing token
    'Bearer ', // Empty token
    'Bearer cp_invalid_prefix_123', // Unsupported prefix
  ];

  for (const authHeader of malformedAuthHeaders) {
    const req = { headers: { authorization: authHeader } };
    let rejected = false;
    const res = {
      status(c) {
        assert.equal(c, 401);
        rejected = true;
        return this;
      },
      json() { return this; },
    };
    await middleware.requireAuth(req, res, () => {
      assert.fail(`Malformed auth header "${authHeader}" should not call next()`);
    });
    assert.ok(rejected, `Expected 401 rejection for "${authHeader}"`);
  }
});

test('M5-AUTH-1.12: Super Admin bootstrap high-concurrency idempotency and zero leakage', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);

  const email = 'superadmin@crawler-pod.internal';
  const password = 'SuperSecretMasterPassword123!#';

  // 50 concurrent bootstrap attempts
  const attempts = 50;
  const promises = [];
  for (let i = 0; i < attempts; i++) {
    promises.push(auth.bootstrapSuperAdmin({ email, password }));
  }

  const results = await Promise.all(promises);

  // Every single call must succeed
  for (const res of results) {
    assert.equal(res.success, true);
    assert.equal(res.user.email, email);
    assert.equal(res.user.role, 'admin');

    // Security check: Zero credential leakage in return object
    assert.equal(res.password, undefined);
    assert.equal(res.passwordHash, undefined);
    assert.equal(res.user.password, undefined);
    assert.equal(res.user.password_hash, undefined);
  }

  // Exactly one user must have been inserted into the database
  assert.equal(db.users.size, 1, 'Only one user record must exist in DB');
  const firstId = results[0].user.id;
  for (const res of results) {
    assert.equal(res.user.id, firstId, 'All concurrent calls must resolve to the identical user ID');
  }

  // Subsequent call after initial bootstrap completes must return alreadyExists: true
  const subsequent = await auth.bootstrapSuperAdmin({ email, password });
  assert.equal(subsequent.success, true);
  assert.equal(subsequent.alreadyExists, true);
  assert.equal(subsequent.created, false);
});

test('M5-AUTH-1.13: Header spoofing and query/body parameter pollution resistance', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);
  const middleware = createAuthMiddleware(auth);

  const memberUser = await db.createUser({ email: 'spoof@example.com', passwordHash: 'hash', role: 'member' });
  const token = generateSessionToken();
  await db.createSession({ userId: memberUser.id, sessionToken: token, expiresAt: new Date(Date.now() + 3600000).toISOString() });

  // Attacker attempts header and body/query parameter pollution
  const maliciousReq = {
    headers: {
      cookie: `crawler_session=${token}`,
      'x-user-role': 'admin',
      'x-role': 'admin',
      'x-admin': 'true',
    },
    query: { role: 'admin' },
    body: { role: 'admin' },
  };
  const res = { status() { return this; }, json() { return this; } };

  await new Promise((resolve) => middleware.requireAuth(maliciousReq, res, resolve));

  // req.user.role must strictly reflect DB role ('member')
  assert.equal(maliciousReq.user.role, 'member', 'Role must remain member despite spoofed headers/query/body');

  let adminBlocked = false;
  const adminRes = {
    status(c) {
      assert.equal(c, 403);
      adminBlocked = true;
      return this;
    },
    json() { return this; },
  };
  middleware.requireAdmin(maliciousReq, adminRes, () => {
    assert.fail('Spoofed member must not bypass requireAdmin');
  });
  assert.ok(adminBlocked);
});

test('M5-AUTH-1.14: CSRF validation on mutation endpoints for cookie sessions', () => {
  const middleware = createAuthMiddleware({ validateApiKey: async () => null, validateSession: async () => null });
  const { csrfProtection } = middleware;

  // 1. State-changing POST with session auth missing CSRF header -> 403
  let rejected = false;
  const reqPostNoCsrf = {
    method: 'POST',
    path: '/api/runs',
    authType: 'session',
    headers: {},
  };
  const resPostNoCsrf = {
    status(c) {
      assert.equal(c, 403);
      rejected = true;
      return this;
    },
    json(j) {
      assert.equal(j.error, 'CSRF Forbidden');
      return this;
    },
  };
  csrfProtection(reqPostNoCsrf, resPostNoCsrf, () => assert.fail('Should not allow POST without CSRF'));
  assert.ok(rejected);

  // 2. State-changing POST with x-csrf-token -> allowed
  let allowed = false;
  const reqPostWithCsrf = {
    method: 'POST',
    path: '/api/runs',
    authType: 'session',
    headers: { 'x-csrf-token': 'valid-csrf-token' },
  };
  csrfProtection(reqPostWithCsrf, {}, () => { allowed = true; });
  assert.ok(allowed);

  // 3. State-changing POST with API key auth -> exempt from CSRF
  let apiKeyAllowed = false;
  const reqApiKey = {
    method: 'POST',
    path: '/api/runs',
    authType: 'api_key',
    headers: {},
  };
  csrfProtection(reqApiKey, {}, () => { apiKeyAllowed = true; });
  assert.ok(apiKeyAllowed);
});

// ============================================================================
// CHAPTER 2: OUTBOUND GUARD SSRF, REDIRECTS & STREAM LIMITS
// ============================================================================

test('M5-SSRF-2.1: Advanced IPv4 & IPv6 SSRF vectors', async () => {
  const ssrfVectors = [
    { url: 'http://0.0.0.0', desc: '0.0.0.0 (RFC 1122 Current network)' },
    { url: 'http://0.0.0.0:8080/admin', desc: '0.0.0.0 with port' },
    { url: 'http://0', desc: 'Non-routable single zero' },
    { url: 'http://[::1]', desc: 'IPv6 loopback [::1]' },
    { url: 'http://[0:0:0:0:0:0:0:1]', desc: 'Full IPv6 loopback' },
    { url: 'http://[::]', desc: 'IPv6 unspecified [::]' },
    { url: 'http://[::ffff:127.0.0.1]', desc: 'IPv4-mapped IPv6 loopback' },
    { url: 'http://[::ffff:7f00:1]', desc: 'IPv4-mapped IPv6 loopback hex' },
    { url: 'http://[::ffff:10.0.0.1]', desc: 'IPv4-mapped IPv6 RFC1918 Class A' },
    { url: 'http://[::ffff:192.168.1.1]', desc: 'IPv4-mapped IPv6 RFC1918 Class C' },
    { url: 'http://[::ffff:169.254.169.254]', desc: 'IPv4-mapped IPv6 Cloud Metadata' },
  ];

  for (const item of ssrfVectors) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError, `Expected SSRFSecurityError for ${item.desc}`);
        return true;
      }
    );
  }
});

test('M5-SSRF-2.2: Obfuscated IP formats (hex, octal, DWORD)', async () => {
  const obfuscatedIps = [
    { url: 'http://0177.0.0.1/test', desc: 'Octal 0177.0.0.1 (127.0.0.1)' },
    { url: 'http://012.0.0.1/test', desc: 'Octal 012.0.0.1 (10.0.0.1)' },
    { url: 'http://0x7f000001/test', desc: 'Single Hex 0x7f000001 (127.0.0.1)' },
    { url: 'http://0x7f.0.0.1/test', desc: 'Dotted Hex 0x7f.0.0.1' },
    { url: 'http://2130706433/test', desc: 'Decimal DWORD 2130706433 (127.0.0.1)' },
    { url: 'http://167772161/test', desc: 'Decimal DWORD 167772161 (10.0.0.1)' },
    { url: 'http://2852039166/test', desc: 'Decimal DWORD 2852039166 (169.254.169.254)' },
  ];

  for (const item of obfuscatedIps) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError, `Expected SSRFSecurityError for ${item.desc}`);
        return true;
      }
    );
  }
});

test('M5-SSRF-2.3: Cloud metadata endpoint variations', async () => {
  const metadataHosts = [
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.goog/',
    'http://instance-data/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/', // Alibaba cloud
  ];

  for (const url of metadataHosts) {
    await assert.rejects(
      async () => validateOutboundUrl(url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, 'CLOUD_METADATA_BLOCKED');
        return true;
      }
    );
  }
});

test('M5-SSRF-2.4: Non-standard URI scheme rejection', async () => {
  const nonStandardSchemes = [
    'file:///etc/passwd',
    'file:///C:/Windows/win.ini',
    'gopher://127.0.0.1:6379/_flushall',
    'ftp://attacker.com/dump.tar',
    'dict://127.0.0.1:11211/stat',
    'ldap://127.0.0.1:389/o=crawler',
    'javascript:alert(1)',
    'data:text/html,<h1>attack</h1>',
  ];

  for (const url of nonStandardSchemes) {
    await assert.rejects(
      async () => validateOutboundUrl(url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.ok(['DISALLOWED_SCHEME', 'MALFORMED_URL'].includes(err.blockedReason));
        return true;
      }
    );
  }
});

test('M5-SSRF-2.5: URL null byte and embedded credential injection', async () => {
  const attackUrls = [
    { url: 'http://public.com\x00.internal.net', reason: 'MALFORMED_URL' },
    { url: 'http://public.com%00.internal.net', reason: 'MALFORMED_URL' },
    { url: 'http://user:password@public.com/path', reason: 'CREDENTIALS_NOT_ALLOWED' },
  ];

  for (const item of attackUrls) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, item.reason);
        return true;
      }
    );
  }
});

test('M5-SSRF-2.6: DNS rebinding attack simulations', async () => {
  // 1. Host resolves to loopback IP
  await assert.rejects(
    async () => validateOutboundUrl('http://rebind-test.com/data', {
      dnsResolver: async () => '127.0.0.1',
    }),
    (err) => {
      assert.ok(err instanceof SSRFSecurityError);
      assert.equal(err.blockedReason, 'DNS_REBINDING_BLOCKED');
      return true;
    }
  );

  // 2. Host resolves to cloud metadata
  await assert.rejects(
    async () => validateOutboundUrl('http://rebind-metadata.com/data', {
      dnsResolver: async () => '169.254.169.254',
    }),
    (err) => {
      assert.ok(err instanceof SSRFSecurityError);
      assert.equal(err.blockedReason, 'CLOUD_METADATA_BLOCKED');
      return true;
    }
  );
});

test('M5-SSRF-2.7: Multi-hop redirect limits and redirect loops in safeFetch', async () => {
  let hopCount = 0;
  const mockFetchLoop = async (url) => {
    hopCount++;
    return {
      status: 302,
      headers: { get: () => 'http://public-target.com/hop' },
    };
  };

  await assert.rejects(
    async () => safeFetch('http://public-target.com/start', {
      mockFetch: mockFetchLoop,
      dnsResolver: async () => '93.184.216.34',
      maxRedirects: 5,
    }),
    (err) => {
      assert.ok(err instanceof SSRFSecurityError);
      assert.equal(err.blockedReason, 'TOO_MANY_REDIRECTS');
      return true;
    }
  );

  assert.equal(hopCount, 6, 'Should have stopped after 6 attempts (initial + 5 redirects)');
});

test('M5-SSRF-2.8: Redirect escaping from public URL to private IP is blocked on next hop', async () => {
  const mockFetchEscape = async (url) => {
    if (url.includes('start')) {
      return {
        status: 302,
        headers: { get: () => 'http://127.0.0.1:3000/api/doctor' },
      };
    }
    return { status: 200 };
  };

  await assert.rejects(
    async () => safeFetch('http://public-safe.com/start', {
      mockFetch: mockFetchEscape,
      dnsResolver: async () => '93.184.216.34',
    }),
    (err) => {
      assert.ok(err instanceof SSRFSecurityError);
      assert.equal(err.blockedReason, 'PRIVATE_IP_BLOCKED');
      return true;
    }
  );
});

test('M5-SSRF-2.9: Fast-path Content-Length and streaming body size truncation', async () => {
  // Fast path: Content-Length header exceeds limit
  const mockFetchBig = async () => ({
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? '10485760' : null) }, // 10MB
  });

  await assert.rejects(
    async () => safeFetch('http://public-safe.com/bigfile', {
      mockFetch: mockFetchBig,
      dnsResolver: async () => '93.184.216.34',
      maxSizeBytes: 8 * 1024 * 1024,
    }),
    /exceeds maximum size limit/
  );
});

// ============================================================================
// CHAPTER 3: RATE LIMITING SLIDING WINDOWS, BOUNDARY ATTACKS & MEMORY
// ============================================================================

test('M5-RATE-3.1: Sliding window bucket boundary attacks on Login Throttler', () => {
  let currentTime = 1000000;
  const nowProvider = () => currentTime;

  const store = new SlidingWindowMemoryStore({
    windowMs: 15 * 60 * 1000, // 15 mins = 900,000 ms
    maxEntries: 5,
    nowProvider,
    sweepIntervalMs: 0,
  });

  const ipKey = '192.168.1.100:test@example.com';

  // Record 5 failed attempts at currentTime
  for (let i = 0; i < 5; i++) {
    const res = store.record(ipKey);
    assert.equal(res.allowed, i < 4 ? true : true);
  }

  // 1. Immediately after 5 failures: check must return allowed = false
  const checkBlocked = store.check(ipKey);
  assert.equal(checkBlocked.allowed, false);
  assert.equal(checkBlocked.remaining, 0);
  assert.equal(checkBlocked.retryAfterSeconds, 900);

  // 2. Advance clock to 14 minutes 59 seconds (899,000 ms): still blocked
  currentTime += 899000;
  const checkStillBlocked = store.check(ipKey);
  assert.equal(checkStillBlocked.allowed, false);
  assert.equal(checkStillBlocked.retryAfterSeconds, 1);

  // 3. Advance clock by 2 more seconds to 15 minutes 1 second (901,000 ms from start): unblocked!
  currentTime += 2000;
  const checkUnblocked = store.check(ipKey);
  assert.equal(checkUnblocked.allowed, true);
  assert.equal(checkUnblocked.remaining, 5);
  assert.equal(checkUnblocked.retryAfterSeconds, 0);
});

test('M5-RATE-3.2: Login Throttler rapid burst handling and success reset', () => {
  let currentTime = 5000000;
  const nowProvider = () => currentTime;

  const loginLimiter = createLoginRateLimiter({
    nowProvider,
    windowMs: 900000,
    maxFailures: 5,
    sweepIntervalMs: 0,
  });

  const req = { ip: '10.10.10.10', body: { email: 'burst@example.com' } };

  // 1. Simulate 5 failed login attempts
  for (let i = 0; i < 5; i++) {
    loginLimiter.recordFailure('10.10.10.10:burst@example.com');
  }

  // Check limiter status
  assert.equal(loginLimiter.isBlocked('10.10.10.10:burst@example.com'), true);

  // 2. Simulate successful login -> resets failure counter immediately
  loginLimiter.recordSuccess('10.10.10.10:burst@example.com');
  assert.equal(loginLimiter.isBlocked('10.10.10.10:burst@example.com'), false);
});

test('M5-RATE-3.3: Sliding window bucket boundary attacks on Run Creation Limiter', () => {
  let currentTime = 2000000;
  const nowProvider = () => currentTime;

  const store = new SlidingWindowMemoryStore({
    windowMs: 60000, // 1 min
    maxEntries: 10,
    nowProvider,
    sweepIntervalMs: 0,
  });

  const userKey = 'user:42';

  // 10 requests consumed at t=0
  for (let i = 0; i < 10; i++) {
    const res = store.consume(userKey);
    assert.equal(res.allowed, true);
    assert.equal(res.remaining, 9 - i);
  }

  // 11th request at t=0 -> rejected
  const req11 = store.consume(userKey);
  assert.equal(req11.allowed, false);
  assert.equal(req11.remaining, 0);
  assert.equal(req11.retryAfterSeconds, 60);

  // Advance time to t=30s -> still rejected
  currentTime += 30000;
  const reqAt30 = store.consume(userKey);
  assert.equal(reqAt30.allowed, false);
  assert.equal(reqAt30.retryAfterSeconds, 30);

  // Advance time to t=60.1s -> 10 requests from t=0 expired, slot available!
  currentTime += 30100;
  const reqAt60 = store.consume(userKey);
  assert.equal(reqAt60.allowed, true);
  assert.equal(reqAt60.remaining, 9);
});

test('M5-RATE-3.4: Reverse proxy IP spoofing resistance via getClientIp', () => {
  // When req.ip is set (Express socket-derived remoteAddress)
  const reqWithSocketIp = {
    ip: '127.0.0.1',
    headers: {
      'x-forwarded-for': '203.0.113.195, 10.0.0.1',
      'x-real-ip': '198.51.100.42',
    },
  };

  const ip = getClientIp(reqWithSocketIp);
  assert.equal(ip, '127.0.0.1', 'req.ip from socket must not be overridden by x-forwarded-for spoofing');
});

test('M5-RATE-3.5: Run key generator fallback priority hierarchy', () => {
  const keyGen = createRunKeyGenerator();

  // Priority 1: req.apiKey.id
  assert.equal(keyGen({ apiKey: { id: 7 } }), 'apikey:7');

  // Priority 2: req.user.apiKeyId
  assert.equal(keyGen({ user: { id: 10, apiKeyId: 8 } }), 'apikey:8');

  // Priority 3: req.user.id
  assert.equal(keyGen({ user: { id: 10 } }), 'user:10');

  // Priority 4: req.session.sessionToken
  assert.equal(keyGen({ session: { sessionToken: 'token123' } }), 'session:token123');

  // Priority 5: client IP
  assert.equal(keyGen({ ip: '192.168.1.5' }), 'ip:192.168.1.5');
});

test('M5-RATE-3.6: Login key generator input sanitization', () => {
  const keyGen = createLoginKeyGenerator();

  // Extremely long email truncated to 256 chars and lowercased
  const massiveEmail = 'A'.repeat(1000) + '@example.COM';
  const req = { ip: '1.2.3.4', body: { email: massiveEmail } };
  const key = keyGen(req);

  assert.equal(key.startsWith('1.2.3.4:'), true);
  const emailPart = key.split(':')[1];
  assert.equal(emailPart.length, 256);
  assert.equal(emailPart, emailPart.toLowerCase());
});

test('M5-RATE-3.7: Memory store bounded LRU eviction under 10,000 unique keys flood', () => {
  const maxKeys = 200;
  const store = new SlidingWindowMemoryStore({
    windowMs: 60000,
    maxEntries: 10,
    maxKeys,
    sweepIntervalMs: 0,
  });

  // Flood with 1,000 distinct IP keys
  for (let i = 0; i < 1000; i++) {
    store.record(`ip-flood-${i}`);
  }

  // Memory assertion: store size MUST NEVER exceed maxKeys
  assert.equal(store.hits.size, maxKeys, 'Store size must strictly stay bounded at maxKeys');

  // LRU verification: earliest keys (0..799) must be evicted, latest (800..999) must be retained
  assert.equal(store.hits.has('ip-flood-0'), false, 'Earliest key must be evicted');
  assert.equal(store.hits.has('ip-flood-100'), false, 'Earlier key must be evicted');
  assert.equal(store.hits.has('ip-flood-999'), true, 'Latest key must be present');
  assert.equal(store.hits.has('ip-flood-850'), true, 'Recent key must be present');
});

test('M5-RATE-3.8: Sliding window sweep purges expired entries cleanly', () => {
  let currentTime = 10000;
  const store = new SlidingWindowMemoryStore({
    windowMs: 5000,
    maxEntries: 10,
    nowProvider: () => currentTime,
    sweepIntervalMs: 0,
  });

  store.record('key1');
  store.record('key2');
  assert.equal(store.hits.size, 2);

  // Advance time past windowMs
  currentTime += 6000;
  store.sweep();

  assert.equal(store.hits.size, 0, 'Sweep must purge completely expired keys');
});

// ============================================================================
// CHAPTER 4: MCP BRIDGE LOCKDOWN, CONSTANT-TIME VERIFICATION & PATH TRAVERSAL
// ============================================================================

test('M5-MCP-4.1: Constant-time internal service key verification resilience', () => {
  const expectedKey = 'super-secret-internal-service-key-xyz123';

  // 1. Exact match
  assert.equal(verifyInternalServiceKey(expectedKey, expectedKey), true);

  // 2. Mismatched keys (same length)
  const wrongSameLen = 'super-secret-internal-service-key-xyz999';
  assert.equal(verifyInternalServiceKey(wrongSameLen, expectedKey), false);

  // 3. Mismatched keys (different length)
  assert.equal(verifyInternalServiceKey('short', expectedKey), false);
  assert.equal(verifyInternalServiceKey(expectedKey + '-extra', expectedKey), false);

  // 4. Boundary invalid inputs
  assert.equal(verifyInternalServiceKey('', expectedKey), false);
  assert.equal(verifyInternalServiceKey(null, expectedKey), false);
  assert.equal(verifyInternalServiceKey(undefined, expectedKey), false);
  assert.equal(verifyInternalServiceKey(12345, expectedKey), false);
});

test('M5-MCP-4.2: MCP Bridge header extraction (x-internal-service-key & Authorization Bearer)', () => {
  // Priority 1: x-internal-service-key
  assert.equal(
    extractInternalServiceKey({ headers: { 'x-internal-service-key': 'key-alpha' } }),
    'key-alpha'
  );

  // Priority 2: Authorization: Bearer <key>
  assert.equal(
    extractInternalServiceKey({ headers: { authorization: 'Bearer key-beta' } }),
    'key-beta'
  );

  // Case insensitive header keys in Node HTTP
  assert.equal(
    extractInternalServiceKey({ headers: { 'x-internal-service-key': 'key-gamma' } }),
    'key-gamma'
  );

  // Malformed headers
  assert.equal(extractInternalServiceKey({ headers: { authorization: 'Basic 123' } }), null);
  assert.equal(extractInternalServiceKey({ headers: {} }), null);
  assert.equal(extractInternalServiceKey(null), null);
});

test('M5-MCP-4.3: MCP Bridge ingress lockdown middleware defense-in-depth', () => {
  process.env.INTERNAL_SERVICE_KEY = 'valid-test-service-key';

  // 1. Missing service key -> 403 Forbidden
  let rejectedNoKey = false;
  const reqNoKey = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const resNoKey = {
    status(c) {
      assert.equal(c, 403);
      rejectedNoKey = true;
      return this;
    },
    json(j) {
      assert.equal(j.error, 'Forbidden');
      return this;
    },
  };
  guardInternalService(reqNoKey, resNoKey, () => assert.fail('Missing key must not pass'));
  assert.ok(rejectedNoKey);

  // 2. Invalid service key -> 403 Forbidden
  let rejectedInvalidKey = false;
  const reqInvalidKey = {
    headers: { 'x-internal-service-key': 'wrong-key' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const resInvalidKey = {
    status(c) {
      assert.equal(c, 403);
      rejectedInvalidKey = true;
      return this;
    },
    json(j) {
      assert.equal(j.error, 'Forbidden');
      return this;
    },
  };
  guardInternalService(reqInvalidKey, resInvalidKey, () => assert.fail('Invalid key must not pass'));
  assert.ok(rejectedInvalidKey);

  // 3. Valid service key but NON-LOOPBACK remoteAddress -> 403 Forbidden (Defense in Depth)
  let rejectedNonLoopback = false;
  const reqNonLoopback = {
    headers: { 'x-internal-service-key': 'valid-test-service-key' },
    socket: { remoteAddress: '203.0.113.50' },
  };
  const resNonLoopback = {
    status(c) {
      assert.equal(c, 403);
      rejectedNonLoopback = true;
      return this;
    },
    json(j) {
      assert.equal(j.message, 'mcp-bridge: loopback requests only');
      return this;
    },
  };
  guardInternalService(reqNonLoopback, resNonLoopback, () => assert.fail('Non-loopback socket must not pass'));
  assert.ok(rejectedNonLoopback);

  // 4. Valid service key on loopback but with browser headers -> 403 Forbidden
  let rejectedBrowser = false;
  const reqBrowser = {
    headers: {
      'x-internal-service-key': 'valid-test-service-key',
      origin: 'http://attacker-site.com',
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const resBrowser = {
    status(c) {
      assert.equal(c, 403);
      rejectedBrowser = true;
      return this;
    },
    json(j) {
      assert.equal(j.message, 'mcp-bridge: browser-originated requests are refused');
      return this;
    },
  };
  guardInternalService(reqBrowser, resBrowser, () => assert.fail('Browser request must not pass'));
  assert.ok(rejectedBrowser);

  // 5. Valid service key on loopback without browser headers -> allowed!
  let passedValid = false;
  const reqValid = {
    headers: { 'x-internal-service-key': 'valid-test-service-key' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  guardInternalService(reqValid, {}, () => { passedValid = true; });
  assert.ok(passedValid, 'Legitimate service call on loopback must pass');
});

test('M5-MCP-4.4: Path traversal and endpoint discovery rejection on /api/internal/*', async () => {
  process.env.INTERNAL_SERVICE_KEY = 'test-key';
  const mockDb = { _connection: { prepare: () => ({ all: async () => [] }) } };

  const app = express();
  app.use(express.json());
  app.use(createMcpBridgeRouter({ database: mockDb }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Endpoint discovery without service key -> 403 Forbidden
    const unauthRes = await fetch(`http://127.0.0.1:${port}/api/internal/secret-probe`);
    assert.equal(unauthRes.status, 403, 'Unknown endpoint without key must return 403');

    // 2. Unknown internal endpoint with valid service key -> 404 Not Found (zero info disclosure)
    const authRes = await fetch(`http://127.0.0.1:${port}/api/internal/unknown-subroute`, {
      headers: { 'x-internal-service-key': 'test-key' },
    });
    assert.equal(authRes.status, 404, 'Unknown endpoint with key must return 404');
    const body = await authRes.json();
    assert.equal(body.error, 'Not Found');
    assert.equal(body.message, 'Unknown internal endpoint');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('M5-MCP-4.5: assertReadOnlySql SQL injection and keyword rejection', () => {
  // Allowed queries
  assert.ok(assertReadOnlySql('SELECT * FROM runs WHERE status = $1'));
  assert.ok(assertReadOnlySql('WITH items AS (SELECT * FROM snapshots) SELECT * FROM items'));

  // Disallowed write keywords
  const disallowedWrites = [
    'INSERT INTO runs (id) VALUES (1)',
    'UPDATE users SET role = "admin"',
    'DELETE FROM runs',
    'DROP TABLE users',
    'ALTER TABLE runs ADD COLUMN hacked text',
    'TRUNCATE snapshots',
    'CREATE TABLE test (id int)',
    'GRANT ALL PRIVILEGES ON DATABASE test TO public',
    'COPY users TO "/tmp/leak"',
  ];

  for (const sql of disallowedWrites) {
    assert.throws(
      () => assertReadOnlySql(sql),
      /mcp-bridge: (only a single SELECT or WITH statement is accepted|refused — the statement contains a write or DDL keyword)/
    );
  }

  // Embedded write/DDL in SELECT/WITH
  const embeddedWrites = [
    'SELECT * FROM (DELETE FROM runs)',
    'WITH x AS (INSERT INTO users VALUES (1)) SELECT 1',
    'SELECT * FROM runs WHERE 1 = 1 AND (DROP TABLE users)',
  ];

  for (const sql of embeddedWrites) {
    assert.throws(
      () => assertReadOnlySql(sql),
      /refused — the statement contains a write or DDL keyword/
    );
  }

  // Disallowed multi-statement / statement stacking
  assert.throws(
    () => assertReadOnlySql('SELECT 1; DROP TABLE users'),
    /only a single statement is accepted/
  );

  // Disallowed dangerous PostgreSQL functions
  const dangerousFuncs = [
    'SELECT pg_read_file("/etc/passwd")',
    'SELECT pg_ls_dir("/app")',
    'SELECT pg_sleep(10)',
    'SELECT lo_export(1, "/tmp/leak")',
  ];

  for (const sql of dangerousFuncs) {
    assert.throws(
      () => assertReadOnlySql(sql),
      /refused — the statement invokes a restricted system\/write function/
    );
  }
});
