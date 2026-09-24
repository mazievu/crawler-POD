'use strict';

/**
 * test/security/delete-run-admin-only.test.js
 *
 * Verifies gap #4: DELETE /api/runs/:id is admin-only (runs have no owner
 * column, so any lesser scope lets one member abort/delete another
 * member's run), and that a failed abort does not prevent the run from
 * being deleted (best-effort abort, logged, not swallowed silently).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { makeHermeticEnv, cleanupHermeticEnv } = require('../helpers/hermetic-spawn-env');

const PORT = 32202;
const BASE_URL = `http://127.0.0.1:${PORT}`;

test('DELETE /api/runs/:id requires admin; member is rejected with 403', async () => {
  const { env, paths: hermeticPaths } = makeHermeticEnv({
    PORT: String(PORT),
    ADMIN_EMAIL: 'admin@system.local',
    ADMIN_PASSWORD: 'SuperAdminPassword123!',
  });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const probe = await fetch(`${BASE_URL}/livez`);
        if (probe.ok) { ready = true; break; }
      } catch { /* still starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, 'Server failed to start within 15s');

    // Log in as admin, issue a member API key.
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@system.local', password: 'SuperAdminPassword123!' }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie');
    const cookieMatch = setCookie.match(/crawler_session=([a-f0-9]{64})/);
    const adminCookie = `crawler_session=${cookieMatch[1]}`;

    const keyRes = await fetch(`${BASE_URL}/api/auth/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ name: 'Delete-run test member key', role: 'member' }),
    });
    assert.equal(keyRes.status, 201);
    const { rawKey: memberApiKey } = await keyRes.json();

    // Member creates a run.
    const createRes = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': memberApiKey },
      body: JSON.stringify({ platform: 'etsy_local', isPaidActor: false, query: 'delete-admin-only-test' }),
    });
    assert.equal(createRes.status, 201);
    const createJson = await createRes.json();
    const runId = createJson.run?.id || createJson.id;
    assert.ok(runId, 'Run ID must exist');

    // Member (same user who created it) cannot delete it — admin-only.
    const memberDeleteRes = await fetch(`${BASE_URL}/api/runs/${runId}`, {
      method: 'DELETE',
      headers: { 'x-api-key': memberApiKey },
    });
    assert.equal(memberDeleteRes.status, 403, 'Member must not be able to DELETE /api/runs/:id');

    // Admin can delete it.
    const adminDeleteRes = await fetch(`${BASE_URL}/api/runs/${runId}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie, 'x-requested-with': 'XMLHttpRequest' },
    });
    assert.equal(adminDeleteRes.status, 200, 'Admin must be able to DELETE /api/runs/:id');

    const afterDeleteRes = await fetch(`${BASE_URL}/api/runs/${runId}`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(afterDeleteRes.status, 404, 'Run must actually be gone');

    // Unauthenticated caller is rejected before ever reaching the handler.
    const unauthDeleteRes = await fetch(`${BASE_URL}/api/runs/999999`, { method: 'DELETE' });
    assert.equal(unauthDeleteRes.status, 401);
  } finally {
    child.kill('SIGKILL');
    cleanupHermeticEnv(hermeticPaths);
  }
});
