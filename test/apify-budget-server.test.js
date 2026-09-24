'use strict';

/**
 * P0 (e): POST /api/runs must not let the CLIENT decide budget accounting.
 *
 * The request body's `isPaidActor` flag used to trigger checkBudget() +
 * deductBudget(1.0) before validation: a client could burn the budget with fake
 * paid runs, or dodge the check by omitting the flag. Budget is now enforced
 * only inside the token pool, at the moment a real actor is started.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 32377;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'admin@system.local', password: 'SuperAdminPassword123!' };

async function waitForLivez(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/livez`);
      if (res.ok) return true;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test('POST /api/runs with isPaidActor:true does not touch the Apify budget', async (t) => {
  const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apify-budget-server-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      PG_MODE: 'pglite',
      PGLITE_DIR: pgliteDir,
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_PASSWORD: ADMIN.password,
      APIFY_INITIAL_BALANCE_USD: '100.0',
      EMERGENCY_DISPATCH_FREEZE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  t.after(() => {
    child.kill('SIGKILL');
    try { fs.rmSync(pgliteDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  assert.ok(await waitForLivez(20000), 'server failed to start');

  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  const adminFetch = (urlPath, options = {}) => fetch(`${BASE_URL}${urlPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-requested-with': 'XMLHttpRequest', Cookie: cookie },
  });

  // 1. With a funded budget, a "paid" run must not be charged by the ingress.
  const setFunded = await adminFetch('/api/apify-tokens/budget', {
    method: 'POST',
    body: JSON.stringify({ remainingBalanceUsd: 5, resetSpent: true }),
  });
  assert.equal(setFunded.status, 200);

  const paid = await adminFetch('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ platform: 'apify_paid', isPaidActor: true, query: 'no-ingress-deduction' }),
  });
  assert.notEqual(paid.status, 402);

  const afterPaid = await (await adminFetch('/api/apify-tokens/budget')).json();
  assert.equal(afterPaid.totalSpentUsd, 0, 'ingress must not deduct budget');
  assert.equal(afterPaid.remainingBalanceUsd, 5);

  // 2. With a zero budget, the client flag no longer produces an ingress 402:
  //    the pool rejects at actor start instead.
  await adminFetch('/api/apify-tokens/budget', {
    method: 'POST',
    body: JSON.stringify({ remainingBalanceUsd: 0, resetSpent: true }),
  });
  const zero = await adminFetch('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ platform: 'apify_paid', isPaidActor: true, query: 'no-ingress-402' }),
  });
  assert.notEqual(zero.status, 402);

  const afterZero = await (await adminFetch('/api/apify-tokens/budget')).json();
  assert.equal(afterZero.totalSpentUsd, 0);
  assert.equal(afterZero.remainingBalanceUsd, 0);
});
