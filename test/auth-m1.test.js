'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  hashPassword,
  verifyPassword,
  hashApiKey,
  generateRawApiKey,
  generateSessionToken,
  AuthService,
} = require('../src/security/auth.service');

const {
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createAuthMiddleware,
} = require('../src/security/auth.middleware');

const { createAuthRouter } = require('../src/security/auth.routes');

test('hashPassword produces scrypt format and verifyPassword validates correctly', () => {
  const pwd = 'TestPassword123!@#';
  const hash = hashPassword(pwd);
  assert.ok(hash.startsWith('scrypt:'), 'Hash must start with scrypt:');
  const parts = hash.split(':');
  assert.equal(parts.length, 3, 'Must have 3 parts: scrypt, salt, hash');
  assert.equal(parts[1].length, 32, 'Salt must be 16 bytes = 32 hex chars');
  assert.equal(parts[2].length, 64, 'Hash must be 32 bytes = 64 hex chars');

  // Positive verification
  assert.equal(verifyPassword(pwd, hash), true, 'Correct password must verify');

  // Negative verifications
  assert.equal(verifyPassword('WrongPassword', hash), false, 'Wrong password must fail');
  assert.equal(verifyPassword('', hash), false, 'Empty password must fail');
  assert.equal(verifyPassword(null, hash), false, 'Null password must fail');
  assert.equal(verifyPassword(pwd, 'invalid-hash-string'), false, 'Malformed hash must fail');
  assert.equal(verifyPassword(pwd, 'scrypt:short:hash'), false, 'Short salt/hash must fail safely without crash');
});

test('hashApiKey produces deterministic SHA-256 and generateRawApiKey uses prefixes', () => {
  const liveKey = generateRawApiKey('cp_live_');
  assert.ok(liveKey.startsWith('cp_live_'), 'Live key must start with cp_live_');
  assert.equal(liveKey.length, 8 + 48, 'Prefix (8) + 24 bytes hex (48) = 56 characters');

  const admKey = generateRawApiKey('cp_adm_');
  assert.ok(admKey.startsWith('cp_adm_'), 'Admin key must start with cp_adm_');

  const hash1 = hashApiKey(liveKey);
  const hash2 = hashApiKey(liveKey);
  assert.equal(hash1, hash2, 'hashApiKey must be deterministic');
  assert.equal(hash1.length, 64, 'SHA-256 must be 64 hex characters');

  assert.equal(hashApiKey(''), '', 'Empty key returns empty hash');
  assert.equal(hashApiKey(null), '', 'Null key returns empty hash');
});

test('generateSessionToken produces 64-character high-entropy hex string', () => {
  const token1 = generateSessionToken();
  const token2 = generateSessionToken();
  assert.equal(token1.length, 64, 'Token must be 64 characters');
  assert.notEqual(token1, token2, 'Consecutive tokens must be distinct');
  assert.match(token1, /^[a-f0-9]{64}$/, 'Token must be hex characters');
});

test('parseCookies handles single, multiple, empty, and malformed cookies resiliently', () => {
  // Empty & invalid
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(null), {});
  assert.deepEqual(parseCookies(undefined), {});

  // Standard cookie
  assert.deepEqual(parseCookies('crawler_session=abc123token'), { crawler_session: 'abc123token' });

  // Multiple and malformed cookies
  const complex = 'broken_cookie; malformed=; crawler_session=my_token_64chars; other=123; trailing=';
  const parsed = parseCookies(complex);
  assert.equal(parsed.crawler_session, 'my_token_64chars');
  assert.equal(parsed.other, '123');
  assert.equal(parsed.malformed, '');
  assert.equal(parsed.broken_cookie, '');
});

test('setSessionCookie and clearSessionCookie format Set-Cookie headers properly', () => {
  const dummyRes = {
    headers: {},
    setHeader(name, val) {
      this.headers[name.toLowerCase()] = val;
    },
  };

  setSessionCookie(dummyRes, 'dummy_token_123', { secure: true });
  assert.match(dummyRes.headers['set-cookie'], /crawler_session=dummy_token_123/);
  assert.match(dummyRes.headers['set-cookie'], /HttpOnly/);
  assert.match(dummyRes.headers['set-cookie'], /SameSite=Lax/);
  assert.match(dummyRes.headers['set-cookie'], /Secure/);

  clearSessionCookie(dummyRes);
  assert.match(dummyRes.headers['set-cookie'], /crawler_session=;/);
  assert.match(dummyRes.headers['set-cookie'], /Expires=Thu, 01 Jan 1970/);
});

test('AuthService with mock database handles user authentication and session lifecycle', async () => {
  const users = new Map();
  const sessions = new Map();
  const apiKeys = new Map();
  let idSeq = 1;

  const mockDb = {
    async createUser({ email, passwordHash, role, status }) {
      const user = { id: idSeq++, email, password_hash: passwordHash, role, status };
      users.set(user.email, user);
      return user;
    },
    async findUserByEmail(email) {
      return users.get(email.toLowerCase()) || null;
    },
    async createSession({ userId, sessionToken, expiresAt }) {
      const s = { id: idSeq++, user_id: userId, session_token: sessionToken, expires_at: expiresAt };
      sessions.set(sessionToken, s);
      return s;
    },
    async findSessionByToken(token) {
      const s = sessions.get(token);
      if (!s) return null;
      let foundUser = null;
      for (const u of users.values()) {
        if (u.id === s.user_id) { foundUser = u; break; }
      }
      return {
        session_id: s.id,
        user_id: s.user_id,
        session_token: s.session_token,
        expires_at: s.expires_at,
        email: foundUser?.email,
        role: foundUser?.role,
        user_status: foundUser?.status,
      };
    },
    async deleteSession(token) {
      const existed = sessions.has(token);
      sessions.delete(token);
      return { changes: existed ? 1 : 0 };
    },
    async createApiKey({ userId, name, keyHash, prefix, role, expiresAt }) {
      const k = { id: idSeq++, user_id: userId, name, key_hash: keyHash, prefix, role, expires_at: expiresAt, is_revoked: false };
      apiKeys.set(keyHash, k);
      return k;
    },
    async findApiKeyByHash(keyHash) {
      const k = apiKeys.get(keyHash);
      if (!k) return null;
      return {
        ...k,
        user_email: 'test@example.com',
        user_role: k.role,
        user_status: 'active',
      };
    },
    async revokeApiKey(id) {
      for (const k of apiKeys.values()) {
        if (k.id === id) {
          k.is_revoked = true;
          return true;
        }
      }
      return false;
    },
  };

  const authService = new AuthService(mockDb);

  // 1. Bootstrap super admin
  const bootResult = await authService.bootstrapSuperAdmin({
    email: 'admin@system.local',
    password: 'SuperAdminPassword123!',
  });
  assert.equal(bootResult.success, true);
  assert.equal(bootResult.created, true);

  // Idempotent retry returns alreadyExists: true
  const bootRetry = await authService.bootstrapSuperAdmin({
    email: 'admin@system.local',
    password: 'SuperAdminPassword123!',
  });
  assert.equal(bootRetry.alreadyExists, true);

  // 2. Authenticate
  const loginSuccess = await authService.authenticateCredentials('admin@system.local', 'SuperAdminPassword123!');
  assert.ok(loginSuccess);
  assert.equal(loginSuccess.user.email, 'admin@system.local');
  assert.equal(loginSuccess.user.role, 'admin');
  assert.ok(loginSuccess.sessionToken);

  const loginBadPass = await authService.authenticateCredentials('admin@system.local', 'WrongPassword!');
  assert.equal(loginBadPass, null);

  const loginBadEmail = await authService.authenticateCredentials('nobody@system.local', 'AnyPassword123!');
  assert.equal(loginBadEmail, null);

  // 3. Validate Session
  const validSession = await authService.validateSession(loginSuccess.sessionToken);
  assert.ok(validSession);
  assert.equal(validSession.user.role, 'admin');

  // 4. Revoke Session
  const revoked = await authService.revokeSession(loginSuccess.sessionToken);
  assert.equal(revoked, true);
  const checkRevoked = await authService.validateSession(loginSuccess.sessionToken);
  assert.equal(checkRevoked, null);

  // 5. API Key Generation and Validation
  const keyResult = await authService.createApiKey({
    userId: bootResult.user.id,
    name: 'CI Key',
    role: 'admin',
    prefix: 'cp_adm_',
    expiresInDays: 30,
  });
  assert.ok(keyResult.rawKey.startsWith('cp_adm_'));

  const validatedKey = await authService.validateApiKey(keyResult.rawKey);
  assert.ok(validatedKey);
  assert.equal(validatedKey.user.role, 'admin');

  // Tampered key rejected
  const tampered = keyResult.rawKey.slice(0, -1) + 'x';
  const badKey = await authService.validateApiKey(tampered);
  assert.equal(badKey, null);

  // Revoked key rejected
  await authService.revokeApiKey(keyResult.record.id);
  const revokedKeyCheck = await authService.validateApiKey(keyResult.rawKey);
  assert.equal(revokedKeyCheck, null);
});

test('createAuthMiddleware enforces 401 for unauthenticated and 403 for unauthorized roles', async () => {
  const dummyAuthService = {
    async validateApiKey(key) {
      if (key === 'cp_live_validmemberkey123456789012345678901234567890123456') {
        return { user: { id: 1, email: 'member@test.com', role: 'member' }, apiKey: { id: 10 } };
      }
      if (key === 'cp_adm_validadminkey12345678901234567890123456789012345678') {
        return { user: { id: 2, email: 'admin@test.com', role: 'admin' }, apiKey: { id: 20 } };
      }
      return null;
    },
    async validateSession(token) {
      if (token === 'valid_session_token_64_characters_hex_string_0123456789abcdef0123') {
        return { user: { id: 1, email: 'member@test.com', role: 'member' }, session: { id: 1 } };
      }
      return null;
    },
  };

  const { requireAuth, requireRole, requireAdmin } = createAuthMiddleware(dummyAuthService);

  function createMockReq(headers = {}) {
    return { headers, cookies: null };
  }
  function createMockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(obj) {
        this.body = obj;
        return this;
      },
    };
  }

  // 1. Missing credentials -> 401
  const reqUnauth = createMockReq();
  const resUnauth = createMockRes();
  let calledNext = false;
  await requireAuth(reqUnauth, resUnauth, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(resUnauth.statusCode, 401);

  // 2. Valid API key -> next called, req.user populated
  calledNext = false;
  const reqApiKey = createMockReq({ 'x-api-key': 'cp_live_validmemberkey123456789012345678901234567890123456' });
  const resApiKey = createMockRes();
  await requireAuth(reqApiKey, resApiKey, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(reqApiKey.user.role, 'member');
  assert.equal(reqApiKey.user.authMethod, 'api_key');

  // 3. Member blocked by requireAdmin -> 403
  calledNext = false;
  const resAdminCheck = createMockRes();
  requireAdmin(reqApiKey, resAdminCheck, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(resAdminCheck.statusCode, 403);

  // 4. Admin allowed by requireAdmin -> next called
  calledNext = false;
  const reqAdmin = createMockReq({ 'x-api-key': 'cp_adm_validadminkey12345678901234567890123456789012345678' });
  const resAdmin = createMockRes();
  await requireAuth(reqAdmin, resAdmin, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(reqAdmin.user.role, 'admin');

  calledNext = false;
  requireAdmin(reqAdmin, createMockRes(), () => { calledNext = true; });
  assert.equal(calledNext, true);
});
