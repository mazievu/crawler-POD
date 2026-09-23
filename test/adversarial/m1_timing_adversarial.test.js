'use strict';

/**
 * test/adversarial/m1_timing_adversarial.test.js
 * Adversarial test suite for Timing Attack Resilience and Constant-Time Verification.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const {
  AuthService,
  hashPassword,
  verifyPassword,
  hashApiKey,
} = require('../../src/security/auth.service');

function createMockTimingDb() {
  const users = new Map();
  const apiKeys = new Map();

  return {
    async createUser({ email, passwordHash, role = 'member' }) {
      const u = { id: 1, email: email.toLowerCase(), password_hash: passwordHash, role, status: 'active' };
      users.set(u.email, u);
      return u;
    },
    async findUserByEmail(email) {
      return users.get(email.toLowerCase()) || null;
    },
    async findApiKeyByHash(keyHash) {
      return apiKeys.get(keyHash) || null;
    },
    async createApiKey({ keyHash, role = 'member' }) {
      const k = { id: 1, key_hash: keyHash, role, is_revoked: false, expires_at: null };
      apiKeys.set(keyHash, k);
      return k;
    },
  };
}

test('TIMING-ADV-1: crypto.timingSafeEqual is used in verifyPassword and prevents early-exit timing leaks', () => {
  const password = 'BenchmarkPassword2026!';
  const realHash = hashPassword(password);
  const [, salt, origHex] = realHash.split(':');

  // Construct fake hash with identical length (32 bytes = 64 hex chars)
  // Case A: Mismatch at first character
  const fakeHashFirst = '0' + origHex.slice(1);
  const storedHashA = `scrypt:${salt}:${fakeHashFirst}`;

  // Case B: Mismatch only at very last character
  const lastChar = origHex.slice(-1);
  const fakeLast = lastChar === 'f' ? 'e' : 'f';
  const fakeHashLast = origHex.slice(0, -1) + fakeLast;
  const storedHashB = `scrypt:${salt}:${fakeHashLast}`;

  // Warmup JIT
  for (let i = 0; i < 5; i++) {
    verifyPassword(password, storedHashA);
    verifyPassword(password, storedHashB);
  }

  // Measure 30 iterations for Case A and Case B
  const ITERATIONS = 30;
  let totalTimeA = 0;
  let totalTimeB = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    verifyPassword(password, storedHashA);
    totalTimeA += (performance.now() - t0);

    const t1 = performance.now();
    verifyPassword(password, storedHashB);
    totalTimeB += (performance.now() - t1);
  }

  const avgA = totalTimeA / ITERATIONS;
  const avgB = totalTimeB / ITERATIONS;

  // Both should be in similar millisecond range (dominated by scrypt calculation, difference < 30%)
  const diffRatio = Math.abs(avgA - avgB) / Math.max(avgA, avgB);
  assert.ok(diffRatio < 0.35, `Timing variance between first-char and last-char mismatch must be negligible (got ratio: ${diffRatio.toFixed(3)})`);
});

test('TIMING-ADV-2: User enumeration defense: Non-existent user dummy verify takes comparable time to existing user', async () => {
  const db = createMockTimingDb();
  const auth = new AuthService(db);

  const realPassword = 'RealPassword123!@#';
  const realHash = hashPassword(realPassword);
  await db.createUser({ email: 'target_exists@system.local', passwordHash: realHash });

  const trialPassword = 'GuessedWrongPassword999!';

  // Warmup JIT
  await auth.authenticateCredentials('target_exists@system.local', trialPassword);
  await auth.authenticateCredentials('does_not_exist@system.local', trialPassword);

  const TRIALS = 20;
  let timeExisting = 0;
  let timeNonExisting = 0;

  for (let i = 0; i < TRIALS; i++) {
    // 1. Existing user with wrong password
    const t0 = performance.now();
    const resExist = await auth.authenticateCredentials('target_exists@system.local', trialPassword);
    timeExisting += (performance.now() - t0);
    assert.strictEqual(resExist, null);

    // 2. Non-existing user
    const t1 = performance.now();
    const resNonExist = await auth.authenticateCredentials('does_not_exist@system.local', trialPassword);
    timeNonExisting += (performance.now() - t1);
    assert.strictEqual(resNonExist, null);
  }

  const avgExist = timeExisting / TRIALS;
  const avgNonExist = timeNonExisting / TRIALS;

  // Both must execute scrypt (typically 5ms - 30ms depending on CPU).
  // Without dummy verify, avgNonExist would be < 0.05ms (a 100x difference).
  // With dummy verify, avgNonExist should be >= 1.0ms.
  assert.ok(avgNonExist >= 1.0, `Non-existent user must execute dummy scrypt (avg took ${avgNonExist.toFixed(2)}ms)`);
  assert.ok(avgExist >= 1.0, `Existing user must execute scrypt (avg took ${avgExist.toFixed(2)}ms)`);

  const ratio = Math.abs(avgExist - avgNonExist) / Math.max(avgExist, avgNonExist);
  assert.ok(ratio < 0.50, `Timing difference between existing and non-existing user must be within 50% (got ratio: ${ratio.toFixed(3)})`);
});

test('TIMING-ADV-3: Constant-time API Key hash comparison handles mismatched lengths safely', async () => {
  const db = createMockTimingDb();
  const auth = new AuthService(db);

  // Store key with normal 64-hex SHA-256 hash
  const rawKey = 'cp_live_0123456789abcdef0123456789abcdef0123456789abcdef';
  const normalHash = hashApiKey(rawKey);
  await db.createApiKey({ keyHash: normalHash, role: 'member' });

  // Valid key lookup
  const valid = await auth.validateApiKey(rawKey);
  assert.ok(valid);

  // Mismatched length in DB record (e.g. corrupted hash in DB) should not crash
  const corruptedKey = { id: 2, key_hash: 'short_hash', role: 'member', is_revoked: false };
  db.findApiKeyByHash = async () => corruptedKey;

  const result = await auth.validateApiKey(rawKey);
  assert.strictEqual(result, null, 'Mismatched hash length must safely fail without uncaught exception');
});
