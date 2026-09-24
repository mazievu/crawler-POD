'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { makeHermeticEnv, cleanupHermeticEnv } = require('./helpers/hermetic-spawn-env');

const PORT = 32189;
const BASE_URL = `http://127.0.0.1:${PORT}`;

test('Live Server: Probes, Bootstrap, Auth Barrier, and RBAC Matrix', async () => {
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

  child.stdout.on('data', (d) => {
    // console.log('[Server stdout]:', d.toString());
  });
  child.stderr.on('data', (d) => {
    // console.error('[Server stderr]:', d.toString());
  });

  try {
    // Wait for server to be ready using /livez
    const deadline = Date.now() + 15000;
    let isReady = false;
    while (Date.now() < deadline) {
      try {
        const probeRes = await fetch(`${BASE_URL}/livez`);
        if (probeRes.ok) {
          isReady = true;
          break;
        }
      } catch {
        // Still starting
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(isReady, 'Server failed to start within 15s');

    // 1. Verify /livez
    const livezRes = await fetch(`${BASE_URL}/livez`);
    assert.equal(livezRes.status, 200);
    const livezJson = await livezRes.json();
    assert.equal(livezJson.status, 'ok');
    assert.ok(typeof livezJson.uptime === 'number');

    // 2. Verify /readyz
    const readyzRes = await fetch(`${BASE_URL}/readyz`);
    assert.equal(readyzRes.status, 200);
    const readyzJson = await readyzRes.json();
    assert.equal(readyzJson.status, 'ok');
    assert.equal(readyzJson.database, 'connected');

    // 3. Verify unauthenticated access to /api/platforms is blocked with 401
    const unauthApiRes = await fetch(`${BASE_URL}/api/platforms`);
    assert.equal(unauthApiRes.status, 401);
    const unauthApiJson = await unauthApiRes.json();
    assert.equal(unauthApiJson.error, 'Unauthorized');

    // 4. Verify unauthenticated access to /admindashboard is blocked with 401
    const unauthAdminRes = await fetch(`${BASE_URL}/admindashboard`);
    assert.equal(unauthAdminRes.status, 401);

    // 5. Verify /api/auth/bootstrap no longer exists as an HTTP route —
    // Super Admin bootstrap now only happens from env at server boot
    // (bootstrapDatabase() in server.js) or via `npm run bootstrap:admin`
    // (scripts/bootstrap-admin.js), never a public/authenticated endpoint.
    const bootRes = await fetch(`${BASE_URL}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    // Unauthenticated: the global auth barrier rejects it with 401 before
    // Express ever gets to report the route missing — from the outside this
    // is indistinguishable from "does not exist", which is the point.
    assert.equal(bootRes.status, 401, 'POST /api/auth/bootstrap must not be reachable unauthenticated');

    // 6. Login as Super Admin
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@system.local',
        password: 'SuperAdminPassword123!',
      }),
    });
    assert.equal(loginRes.status, 200);
    const loginJson = await loginRes.json();
    assert.equal(loginJson.user.email, 'admin@system.local');
    assert.equal(loginJson.user.role, 'admin');

    const adminCookie = loginRes.headers.get('set-cookie');
    assert.ok(adminCookie && adminCookie.includes('crawler_session='));

    // Extract cookie value
    const match = adminCookie.match(/crawler_session=([a-f0-9]{64})/);
    assert.ok(match, 'Cookie must match 64 hex characters');
    const adminSessionToken = match[1];

    // 7. Verify /api/auth/me with admin session cookie
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Cookie: `crawler_session=${adminSessionToken}` },
    });
    assert.equal(meRes.status, 200);
    const meJson = await meRes.json();
    assert.equal(meJson.user.email, 'admin@system.local');
    assert.equal(meJson.user.role, 'admin');

    // 7b. Even authenticated (as admin, with CSRF header), the route is
    // truly gone — 404, not just gated by auth.
    const bootAuthedRes = await fetch(`${BASE_URL}/api/auth/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `crawler_session=${adminSessionToken}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    assert.equal(bootAuthedRes.status, 404, 'POST /api/auth/bootstrap must not exist, even authenticated');

    // 8. Admin issues API key for Member
    const keyRes = await fetch(`${BASE_URL}/api/auth/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `crawler_session=${adminSessionToken}`,
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        name: 'Member Test Key',
        role: 'member',
        prefix: 'cp_live_',
      }),
    });
    assert.equal(keyRes.status, 201);
    const keyJson = await keyRes.json();
    assert.ok(keyJson.rawKey.startsWith('cp_live_'));
    assert.equal(keyJson.role, 'member');
    const memberApiKey = keyJson.rawKey;

    // 9. Member accesses /api/platforms with x-api-key -> 200 OK
    const memberPlatformsRes = await fetch(`${BASE_URL}/api/platforms`, {
      headers: { 'x-api-key': memberApiKey },
    });
    assert.equal(memberPlatformsRes.status, 200);

    // 10. Member accesses Admin-only route (/api/doctor) -> 403 Forbidden
    const memberDoctorRes = await fetch(`${BASE_URL}/api/doctor`, {
      headers: { 'x-api-key': memberApiKey },
    });
    assert.equal(memberDoctorRes.status, 403);
    const memberDoctorJson = await memberDoctorRes.json();
    assert.equal(memberDoctorJson.error, 'Forbidden');

    // 11. Member attempts bulk delete (DELETE /api/items) -> 403 Forbidden
    const memberBulkDeleteRes = await fetch(`${BASE_URL}/api/items`, {
      method: 'DELETE',
      headers: { 'x-api-key': memberApiKey },
    });
    assert.equal(memberBulkDeleteRes.status, 403);

    // 12. Admin accesses /api/doctor -> not 401 or 403
    const adminDoctorRes = await fetch(`${BASE_URL}/api/doctor`, {
      headers: { Cookie: `crawler_session=${adminSessionToken}` },
    });
    assert.notEqual(adminDoctorRes.status, 401);
    assert.notEqual(adminDoctorRes.status, 403);

    // 13. Admin revokes API key
    const revokeRes = await fetch(`${BASE_URL}/api/auth/api-keys/${keyJson.id}`, {
      method: 'DELETE',
      headers: { Cookie: `crawler_session=${adminSessionToken}`, 'x-requested-with': 'XMLHttpRequest' },
    });
    assert.equal(revokeRes.status, 200);

    // 14. Revoked key now rejected with 401
    const revokedKeyRes = await fetch(`${BASE_URL}/api/platforms`, {
      headers: { 'x-api-key': memberApiKey },
    });
    assert.equal(revokedKeyRes.status, 401);

    // 15. Logout admin session
    const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `crawler_session=${adminSessionToken}` },
    });
    assert.equal(logoutRes.status, 200);

    // 16. Session is now invalid (401)
    const afterLogoutRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Cookie: `crawler_session=${adminSessionToken}` },
    });
    assert.equal(afterLogoutRes.status, 401);

  } finally {
    child.kill('SIGKILL');
    cleanupHermeticEnv(hermeticPaths);
  }
});
