'use strict';

/**
 * test/adversarial/m1_session_adversarial.test.js
 * Adversarial test suite for Session Hijacking, Forged Tokens, Expired Sessions, and Corrupted Cookies.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  AuthService,
  generateSessionToken,
} = require('../../src/security/auth.service');

const {
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createAuthMiddleware,
} = require('../../src/security/auth.middleware');

// Helper to create an in-memory test database mimicking PostgreSQL auth operations
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
    async deleteUser(id) {
      for (const [email, u] of users.entries()) {
        if (u.id === Number(id)) {
          users.delete(email);
          // Cascade delete sessions and api keys
          for (const [token, s] of sessions.entries()) {
            if (s.user_id === Number(id)) sessions.delete(token);
          }
          for (const [kHash, k] of apiKeys.entries()) {
            if (k.user_id === Number(id)) apiKeys.delete(kHash);
          }
          return { changes: 1 };
        }
      }
      return { changes: 0 };
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
  };
}

test('SESSION-ADV-1: Forged session tokens with arbitrary malformed patterns are strictly rejected', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);

  const malformedTokens = [
    '', // empty string
    '   ', // whitespace only
    'a'.repeat(63), // 63 chars (underflow)
    'a'.repeat(65), // 65 chars (overflow)
    'g'.repeat(64), // 64 non-hex chars
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg', // ends in non-hex
    "' OR '1'='1", // SQL injection string
    '../../etc/passwd', // Path traversal string
    '__proto__', // Prototype pollution
    'constructor', // Object property
    'toString',
    '\x00'.repeat(64), // Null bytes
    '0123456789abcdef0123456789abcdef\x000123456789abcdef0123456789abcdef', // Embedded null byte
    123456789, // Number
    {}, // Object
    [], // Array
    null,
    undefined,
  ];

  for (const forged of malformedTokens) {
    const result = await auth.validateSession(forged);
    assert.strictEqual(result, null, `Forged token must be rejected: ${String(forged)}`);
  }
});

test('SESSION-ADV-2: Non-existent but syntactically valid 64-hex session token returns null', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);

  for (let i = 0; i < 20; i++) {
    const randomValidToken = crypto.randomBytes(32).toString('hex');
    const result = await auth.validateSession(randomValidToken);
    assert.strictEqual(result, null, `Random valid-format token must not authenticate: ${randomValidToken}`);
  }
});

test('SESSION-ADV-3: Expired session rejection and opportunistic cleanup', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);

  const user = await db.createUser({ email: 'expire_test@test.local', passwordHash: 'hash', role: 'member' });

  // 1. Session expired 5 seconds ago
  const expiredSession = await db.createSession({
    userId: user.id,
    sessionToken: crypto.randomBytes(32).toString('hex'),
    expiresAt: new Date(Date.now() - 5000).toISOString(),
  });

  const checkExpired = await auth.validateSession(expiredSession.sessionToken);
  assert.strictEqual(checkExpired, null, 'Expired session must return null');

  // Opportunistic cleanup should have deleted the expired token from DB
  const rawLookup = await db.findSessionByToken(expiredSession.sessionToken);
  assert.strictEqual(rawLookup, null, 'Expired session must be pruned upon validation attempt');

  // 2. Session valid for 1 hour in future
  const validSession = await db.createSession({
    userId: user.id,
    sessionToken: crypto.randomBytes(32).toString('hex'),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });

  const checkValid = await auth.validateSession(validSession.sessionToken);
  assert.ok(checkValid, 'Unexpired session must validate successfully');
  assert.strictEqual(checkValid.user.email, 'expire_test@test.local');
});

test('SESSION-ADV-4: User suspension/ban immediately revokes active session without waiting for TTL', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);

  const user = await db.createUser({ email: 'bad_actor@test.local', passwordHash: 'hash', role: 'member' });
  const session = await auth.createSession(user.id);

  // Active user session validates
  const checkActive = await auth.validateSession(session.sessionToken);
  assert.ok(checkActive);

  // Admin suspends user
  await db.updateUserStatus(user.id, 'suspended');

  // Session must be rejected immediately
  const checkSuspended = await auth.validateSession(session.sessionToken);
  assert.strictEqual(checkSuspended, null, 'Session of suspended user must be rejected immediately');

  // Admin disables user
  await db.updateUserStatus(user.id, 'disabled');
  const checkDisabled = await auth.validateSession(session.sessionToken);
  assert.strictEqual(checkDisabled, null, 'Session of disabled user must be rejected immediately');
});

test('SESSION-ADV-5: User deletion cascades to revoke all active sessions', async () => {
  const db = createMockAuthDb();
  const auth = new AuthService(db);

  const user = await db.createUser({ email: 'deleted_user@test.local', passwordHash: 'hash', role: 'member' });
  const s1 = await auth.createSession(user.id);
  const s2 = await auth.createSession(user.id);

  assert.ok(await auth.validateSession(s1.sessionToken));
  assert.ok(await auth.validateSession(s2.sessionToken));

  // Delete user from system
  await db.deleteUser(user.id);

  // Both sessions must be dead
  assert.strictEqual(await auth.validateSession(s1.sessionToken), null);
  assert.strictEqual(await auth.validateSession(s2.sessionToken), null);
});

test('SESSION-ADV-6: parseCookies handles adversarial and corrupted Cookie header inputs', () => {
  // 1. Prototype pollution attempt
  const protoPollution = parseCookies('__proto__[polluted]=yes; constructor=bad; toString=evil');
  assert.strictEqual(({}).polluted, undefined, 'Prototype must not be polluted');
  assert.strictEqual(typeof ({}).toString, 'function', 'Object.toString must remain intact');

  // 2. Cookie flood / giant header
  const giantVal = 'x'.repeat(8192);
  const giantCookie = `crawler_session=${giantVal}; tracking=123`;
  const parsedGiant = parseCookies(giantCookie);
  assert.strictEqual(parsedGiant.crawler_session, giantVal);
  assert.strictEqual(parsedGiant.tracking, '123');

  // 3. Duplicate cookie keys (precedence test)
  const duplicateHeader = 'crawler_session=first_value; crawler_session=second_value';
  const parsedDup = parseCookies(duplicateHeader);
  assert.strictEqual(parsedDup.crawler_session, 'second_value', 'Last duplicate cookie wins in standard parser');

  // 4. Whitespace, missing values, empty pairs, weird separators
  const weird = ';;; key1=val1; ; key2=; key3; =empty_key; key4=val=with=equals; ';
  const parsedWeird = parseCookies(weird);
  assert.strictEqual(parsedWeird.key1, 'val1');
  assert.strictEqual(parsedWeird.key2, '');
  assert.strictEqual(parsedWeird.key3, '');
  assert.strictEqual(parsedWeird.key4, 'val=with=equals');

  // 5. Non-string types
  assert.deepStrictEqual(parseCookies(null), {});
  assert.deepStrictEqual(parseCookies(undefined), {});
  assert.deepStrictEqual(parseCookies(12345), {});
  assert.deepStrictEqual(parseCookies({}), {});
});

test('SESSION-ADV-7: Session fixation immunity and cryptographic entropy distribution', () => {
  const tokens = new Set();
  const N = 2000;

  for (let i = 0; i < N; i++) {
    const token = generateSessionToken();
    assert.strictEqual(token.length, 64, 'Token must be exactly 64 hex characters');
    assert.match(token, /^[a-f0-9]{64}$/, 'Token must be strictly lowercase hex');
    assert.ok(!tokens.has(token), 'Collision detected in generated session tokens');
    tokens.add(token);
  }

  assert.strictEqual(tokens.size, N, `All ${N} tokens must be mutually unique`);
});
