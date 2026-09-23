'use strict';

/**
 * test/adversarial/m1_apikey_adversarial.test.js
 * Adversarial test suite for API Key Tampering, Revocation, Malformed Headers, and Privilege Escalation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  AuthService,
  hashApiKey,
  generateRawApiKey,
} = require('../../src/security/auth.service');

const {
  createAuthMiddleware,
} = require('../../src/security/auth.middleware');

function createMockApiKeyDb() {
  const users = new Map();
  const apiKeys = new Map();
  let idSeq = 1;

  return {
    users,
    apiKeys,
    async createUser({ email, passwordHash, role = 'member', status = 'active' }) {
      const u = { id: idSeq++, email, password_hash: passwordHash, role, status };
      users.set(u.id, u);
      return u;
    },
    async deleteUser(id) {
      users.delete(Number(id));
      for (const [hash, k] of apiKeys.entries()) {
        if (k.user_id === Number(id)) apiKeys.delete(hash);
      }
      return { changes: 1 };
    },
    async updateUserStatus(id, status) {
      const u = users.get(Number(id));
      if (u) {
        u.status = status;
        return true;
      }
      return false;
    },
    async createApiKey({ userId, name, keyHash, prefix, role = 'member', expiresAt = null }) {
      const k = {
        id: idSeq++,
        user_id: userId ? Number(userId) : null,
        name,
        key_hash: keyHash,
        prefix,
        role,
        expires_at: expiresAt,
        is_revoked: false,
        created_at: new Date().toISOString(),
      };
      apiKeys.set(keyHash, k);
      return k;
    },
    async findApiKeyByHash(keyHash) {
      const k = apiKeys.get(keyHash);
      if (!k) return null;
      const u = k.user_id ? users.get(k.user_id) : null;
      return {
        ...k,
        user_email: u ? u.email : null,
        user_role: u ? u.role : k.role,
        user_status: u ? u.status : 'active',
      };
    },
    async revokeApiKey(id) {
      for (const k of apiKeys.values()) {
        if (k.id === Number(id)) {
          k.is_revoked = true;
          return true;
        }
      }
      return false;
    },
    async deleteApiKey(id) {
      for (const [hash, k] of apiKeys.entries()) {
        if (k.id === Number(id)) {
          apiKeys.delete(hash);
          return true;
        }
      }
      return false;
    },
  };
}

function mockHttp(headers = {}) {
  const req = { headers, cookies: null };
  const res = {
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
  return { req, res };
}

test('APIKEY-ADV-1: Single-bit and multi-char tampering of API keys strictly rejected', async () => {
  const db = createMockApiKeyDb();
  const auth = new AuthService(db);
  const user = await db.createUser({ email: 'admin@system.local', passwordHash: 'hash', role: 'admin' });

  const { rawKey } = await auth.createApiKey({
    userId: user.id,
    name: 'Production Key',
    role: 'admin',
    prefix: 'cp_adm_',
  });

  // Valid key works
  const valid = await auth.validateApiKey(rawKey);
  assert.ok(valid);
  assert.strictEqual(valid.user.role, 'admin');

  // 1. Bit flip in payload
  const lastChar = rawKey.slice(-1);
  const replacement = lastChar === 'a' ? 'b' : 'a';
  const tampered1 = rawKey.slice(0, -1) + replacement;
  assert.strictEqual(await auth.validateApiKey(tampered1), null);

  // 2. Middle char mutation
  const tampered2 = rawKey.slice(0, 20) + (rawKey[20] === '0' ? '1' : '0') + rawKey.slice(21);
  assert.strictEqual(await auth.validateApiKey(tampered2), null);

  // 3. Truncated key
  assert.strictEqual(await auth.validateApiKey(rawKey.slice(0, 15)), null);
  assert.strictEqual(await auth.validateApiKey('cp_adm_'), null);

  // 4. Extended key
  assert.strictEqual(await auth.validateApiKey(rawKey + 'ffff'), null);

  // 5. Privilege escalation attempt: swap prefix from cp_live_ to cp_adm_
  const memberKeyObj = await auth.createApiKey({
    userId: user.id,
    name: 'Member Key',
    role: 'member',
    prefix: 'cp_live_',
  });
  const forgedAdminKey = 'cp_adm_' + memberKeyObj.rawKey.slice(8);
  assert.strictEqual(await auth.validateApiKey(forgedAdminKey), null, 'Prefix swap must alter hash and fail validation');
});

test('APIKEY-ADV-2: Revoked and expired API keys cannot be authenticated', async () => {
  const db = createMockApiKeyDb();
  const auth = new AuthService(db);
  const user = await db.createUser({ email: 'key_owner@test.local', passwordHash: 'hash', role: 'member' });

  // 1. Revoked key
  const keyToRevoke = await auth.createApiKey({
    userId: user.id,
    name: 'Revoke Me',
    role: 'member',
  });
  assert.ok(await auth.validateApiKey(keyToRevoke.rawKey));

  await auth.revokeApiKey(keyToRevoke.record.id);
  assert.strictEqual(await auth.validateApiKey(keyToRevoke.rawKey), null, 'Revoked key must return null');

  // 2. Expired key in database (past date)
  const expiredKeyRecord = await db.createApiKey({
    userId: user.id,
    name: 'Expired Key',
    keyHash: hashApiKey('cp_live_expiredkey12345678901234567890123456789012345678'),
    prefix: 'cp_live_',
    role: 'member',
    expiresAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
  });
  const expiredKeyVal = 'cp_live_expiredkey12345678901234567890123456789012345678';
  assert.strictEqual(await auth.validateApiKey(expiredKeyVal), null, 'Expired key in DB must return null');

  // Also check future key expiresAt works
  const futureKey = await auth.createApiKey({
    userId: user.id,
    name: 'Future Key',
    role: 'member',
    expiresInDays: 30,
  });
  assert.ok(await auth.validateApiKey(futureKey.rawKey), 'Future key must validate');
});

test('APIKEY-ADV-3: Malformed Authorization header variants are rejected with 401', async () => {
  const db = createMockApiKeyDb();
  const auth = new AuthService(db);
  const { requireAuth } = createAuthMiddleware(auth);

  const testCases = [
    { authHeader: 'Basic dXNlcjpwYXNz', reason: 'Unsupported scheme Basic' },
    { authHeader: 'Digest username="MIME"', reason: 'Unsupported scheme Digest' },
    { authHeader: 'Bearer', reason: 'Missing token after Bearer' },
    { authHeader: 'Bearer ', reason: 'Empty token after Bearer' },
    { authHeader: 'Bearer   ', reason: 'Whitespace-only token' },
    { authHeader: 'bearer cp_live_valid', reason: 'Lowercase bearer' },
    { authHeader: 'Token 12345', reason: 'Scheme Token' },
    { authHeader: 'Bearer cp_unknown_prefix_12345', reason: 'Unrecognized API key prefix' },
    { authHeader: 'Bearer undefined', reason: 'Literal undefined' },
    { authHeader: 'Bearer null', reason: 'Literal null' },
  ];

  for (const { authHeader, reason } of testCases) {
    const { req, res } = mockHttp({ authorization: authHeader });
    let nextCalled = false;
    await requireAuth(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, `Next must not be called for: ${reason}`);
    assert.strictEqual(res.statusCode, 401, `Status must be 401 for: ${reason}`);
  }
});

test('APIKEY-ADV-4: Malformed x-api-key header variants are rejected with 401', async () => {
  const db = createMockApiKeyDb();
  const auth = new AuthService(db);
  const { requireAuth } = createAuthMiddleware(auth);

  const testCases = [
    { keyHeader: '', expectedMsg: 'Empty API key provided' },
    { keyHeader: '   ', expectedMsg: 'Empty API key provided' },
    { keyHeader: 'cp_invalid_prefix_123', expectedMsg: 'Unrecognized API key prefix' },
    { keyHeader: 'cp_live_', expectedMsg: 'Invalid, revoked, or expired API key' },
    { keyHeader: 'secret_without_prefix', expectedMsg: 'Unrecognized API key prefix' },
    { keyHeader: 'cp_adm_nonexistent12345678901234567890123456789012345678', expectedMsg: 'Invalid, revoked, or expired API key' },
  ];

  for (const { keyHeader, expectedMsg } of testCases) {
    const { req, res } = mockHttp({ 'x-api-key': keyHeader });
    let nextCalled = false;
    await requireAuth(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.message, expectedMsg);
  }
});

test('APIKEY-ADV-5: Strict RBAC enforcement and user cascade revocation', async () => {
  const db = createMockApiKeyDb();
  const auth = new AuthService(db);
  const { requireAuth, requireAdmin } = createAuthMiddleware(auth);

  const adminUser = await db.createUser({ email: 'admin@system.local', passwordHash: 'hash', role: 'admin' });
  const memberUser = await db.createUser({ email: 'member@system.local', passwordHash: 'hash', role: 'member' });

  const adminKey = await auth.createApiKey({ userId: adminUser.id, name: 'Admin Key', role: 'admin', prefix: 'cp_adm_' });
  const memberKey = await auth.createApiKey({ userId: memberUser.id, name: 'Member Key', role: 'member', prefix: 'cp_live_' });

  // 1. Member tries Admin endpoint -> 403 Forbidden
  const { req: memberReq, res: memberRes } = mockHttp({ 'x-api-key': memberKey.rawKey });
  await requireAuth(memberReq, memberRes, () => {});
  assert.strictEqual(memberReq.user.role, 'member');

  let adminNextCalled = false;
  const adminCheckRes = mockHttp().res;
  requireAdmin(memberReq, adminCheckRes, () => { adminNextCalled = true; });
  assert.strictEqual(adminNextCalled, false);
  assert.strictEqual(adminCheckRes.statusCode, 403, 'Member must be rejected by requireAdmin with 403');

  // 2. Admin tries Admin endpoint -> 200 / Next called
  const { req: adminReq, res: adminRes } = mockHttp({ 'x-api-key': adminKey.rawKey });
  await requireAuth(adminReq, adminRes, () => {});
  assert.strictEqual(adminReq.user.role, 'admin');

  adminNextCalled = false;
  requireAdmin(adminReq, mockHttp().res, () => { adminNextCalled = true; });
  assert.strictEqual(adminNextCalled, true, 'Admin must be granted access');

  // 3. User suspended -> API key rejected
  await db.updateUserStatus(adminUser.id, 'disabled');
  assert.strictEqual(await auth.validateApiKey(adminKey.rawKey), null, 'API key of disabled user must be rejected');

  // 4. Cascade delete: user deleted -> API key purged
  await db.deleteUser(memberUser.id);
  assert.strictEqual(await auth.validateApiKey(memberKey.rawKey), null, 'API key of deleted user must be purged');
});
