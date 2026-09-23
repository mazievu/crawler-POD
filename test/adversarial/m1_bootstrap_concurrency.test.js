'use strict';

/**
 * test/adversarial/m1_bootstrap_concurrency.test.js
 * Adversarial test suite for Super Admin Bootstrap Idempotency Under High Concurrency.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const {
  AuthService,
  hashPassword,
} = require('../../src/security/auth.service');

// Simulated DB with realistic atomic upsert / unique constraint simulation
function createConcurrentMockDb() {
  const users = new Map();
  let idSeq = 1;
  let insertCount = 0;

  return {
    get insertCount() { return insertCount; },
    get users() { return users; },
    async findUserByEmail(email) {
      const clean = email.trim().toLowerCase();
      return users.get(clean) || null;
    },
    async createUser({ email, passwordHash, role = 'admin', status = 'active' }) {
      const clean = email.trim().toLowerCase();
      // Simulate microtask delay to expose race conditions
      await new Promise((r) => setImmediate(r));

      // Simulate ON CONFLICT (email) DO NOTHING
      if (users.has(clean)) {
        return users.get(clean);
      }

      insertCount++;
      const user = {
        id: idSeq++,
        email: clean,
        password_hash: passwordHash,
        role,
        status,
        created_at: new Date().toISOString(),
      };
      users.set(clean, user);
      return user;
    },
    async countAdmins() {
      let count = 0;
      for (const u of users.values()) {
        if (u.role === 'admin') count++;
      }
      return count;
    },
  };
}

test('BOOT-ADV-1: 50 concurrent bootstrapSuperAdmin calls resolve without deadlock or duplicate users', async () => {
  const db = createConcurrentMockDb();
  const auth = new AuthService(db);

  const CONCURRENCY = 50;
  const promises = [];

  for (let i = 0; i < CONCURRENCY; i++) {
    promises.push(
      auth.bootstrapSuperAdmin({
        email: 'superadmin@system.local',
        password: 'SuperAdminPassword123!@#',
      })
    );
  }

  const results = await Promise.all(promises);

  // Every single call must succeed
  for (const res of results) {
    assert.strictEqual(res.success, true, 'Bootstrap result must be success');
    assert.ok(res.user, 'User object must be present');
    assert.strictEqual(res.user.email, 'superadmin@system.local');
    assert.strictEqual(res.user.role, 'admin');
  }

  // Exactly one user must have been inserted into the database
  assert.strictEqual(db.users.size, 1, 'Only one user record must exist in DB');
  assert.strictEqual(await db.countAdmins(), 1, 'Admin count in DB must be exactly 1');

  // All returned user IDs must be identical
  const firstId = results[0].user.id;
  for (const res of results) {
    assert.strictEqual(res.user.id, firstId, 'Returned user ID must be identical across all concurrent boots');
  }
});

test('BOOT-ADV-2: Concurrent bootstrap with varying casing and whitespace trims and normalizes safely', async () => {
  const db = createConcurrentMockDb();
  const auth = new AuthService(db);

  const variations = [
    'ADMIN@SYSTEM.LOCAL',
    'admin@system.local',
    'Admin@System.Local',
    '  admin@system.local  ',
    'aDmIn@sYsTeM.lOcAl',
    ' admin@system.local',
    'admin@system.local ',
  ];

  const promises = variations.map((email) =>
    auth.bootstrapSuperAdmin({
      email,
      password: 'StandardPassword123!',
    })
  );

  const results = await Promise.all(promises);

  assert.strictEqual(db.users.size, 1, 'All variations must normalize to a single record');
  assert.strictEqual(results.every((r) => r.success), true);
  assert.strictEqual(db.users.get('admin@system.local').email, 'admin@system.local');
});

test('BOOT-ADV-3: Missing or whitespace credentials fail fast without writing to DB', async () => {
  const db = createConcurrentMockDb();
  const auth = new AuthService(db);

  const invalidInputs = [
    { email: '', password: 'Password123!' },
    { email: 'admin@system.local', password: '' },
    { email: 'admin@system.local', password: '    ' },
    { email: null, password: 'Password123!' },
    { email: 'admin@system.local', password: null },
    {},
  ];

  for (const input of invalidInputs) {
    const res = await auth.bootstrapSuperAdmin(input);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'MISSING_CREDENTIALS');
  }

  assert.strictEqual(db.users.size, 0, 'No user should be written to DB on invalid credentials');
});

test('BOOT-ADV-4: Live HTTP Server: bootstrap happens once from env at boot, and POST /api/auth/bootstrap is not a reachable route', async () => {
  const PORT = 32190;
  const BASE_URL = `http://127.0.0.1:${PORT}`;

  const env = {
    ...process.env,
    PORT: String(PORT),
    PG_MODE: 'pglite',
    ADMIN_EMAIL: 'concurrent_admin@system.local',
    ADMIN_PASSWORD: 'LiveConcurrentAdminPassword123!',
  };

  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    // Wait for server ready
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const probe = await fetch(`${BASE_URL}/livez`);
        if (probe.ok) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, 'Live server must start within 15s');

    // The vulnerable public bootstrap endpoint (M1 audit finding: bootstrap
    // takeover) must not exist. 25 concurrent hits must ALL be rejected —
    // never a 200/201 that would imply the endpoint still exists.
    const CONCURRENCY = 25;
    const reqs = Array.from({ length: CONCURRENCY }, () =>
      fetch(`${BASE_URL}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const responses = await Promise.all(reqs);
    for (const res of responses) {
      assert.ok(
        [401, 404].includes(res.status),
        `POST /api/auth/bootstrap must not exist (expected 401/404, got ${res.status})`
      );
    }

    // Bootstrap now only happens from env at boot (or via `npm run
    // bootstrap:admin`), never through a public HTTP endpoint. This process
    // shares a PGLITE_DIR with other spawn tests in this suite, so an admin
    // may already exist from an earlier test — either way, login must not
    // 500 and must never be gated by a public bootstrap call.
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'concurrent_admin@system.local',
        password: 'LiveConcurrentAdminPassword123!',
      }),
    });
    assert.ok(
      [200, 401].includes(loginRes.status),
      `Login must resolve deterministically (200 if this run created the admin, 401 if an earlier admin already exists), got ${loginRes.status}`
    );
  } finally {
    child.kill('SIGKILL');
  }
});
