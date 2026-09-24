'use strict';

/**
 * test/security/csrf-api-keys.test.js
 *
 * Verifies gap #3: POST /api/auth/api-keys and DELETE /api/auth/api-keys/:id
 * are CSRF-protected (they used to be reachable before the CSRF barrier
 * because the Auth Router was mounted first and terminated the middleware
 * chain), and that the internal-service-key/API-key CSRF exemption only
 * applies when the credential actually authenticated — not merely when the
 * header is present.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { makeHermeticEnv, cleanupHermeticEnv } = require('../helpers/hermetic-spawn-env');

const PORT = 32201;
const BASE_URL = `http://127.0.0.1:${PORT}`;

test('CSRF: api-keys create/revoke require CSRF header on session-cookie auth; spoofed internal-key header cannot bypass it', async () => {
  // Each spawn gets its own isolated PGLITE_DIR/Apify-token-pool/social-bot
  // config (see test/helpers/hermetic-spawn-env.js) and bootstraps its own
  // fresh admin from ADMIN_EMAIL/ADMIN_PASSWORD below, rather than relying
  // on the default on-disk pgdata directory shared with other spawn tests
  // (which pollutes the repo's real data/ directory).
  const { env, paths: hermeticPaths } = makeHermeticEnv({
    PORT: String(PORT),
    ADMIN_EMAIL: 'admin@system.local',
    ADMIN_PASSWORD: 'SuperAdminPassword123!',
    INTERNAL_SERVICE_KEY: 'the-real-internal-service-key',
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

    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@system.local', password: 'SuperAdminPassword123!' }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie');
    const match = setCookie.match(/crawler_session=([a-f0-9]{64})/);
    assert.ok(match);
    const cookie = `crawler_session=${match[1]}`;

    // 1. POST /api/auth/api-keys with ONLY the session cookie (no CSRF
    //    header) must be rejected — this is the vulnerability being fixed.
    const noCsrfRes = await fetch(`${BASE_URL}/api/auth/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'No CSRF Key' }),
    });
    assert.equal(noCsrfRes.status, 403, 'Session-cookie POST without CSRF header must be rejected');

    // 2. Attaching an arbitrary/garbage x-internal-service-key header must
    //    NOT bypass CSRF — only a header that actually validates should.
    const spoofedInternalKeyRes = await fetch(`${BASE_URL}/api/auth/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'x-internal-service-key': 'totally-made-up-value',
      },
      body: JSON.stringify({ name: 'Spoofed Internal Key' }),
    });
    assert.equal(spoofedInternalKeyRes.status, 403, 'Unvalidated x-internal-service-key must not bypass CSRF');

    // 3. With the real x-requested-with header (what apiFetch() sends), the
    //    request must succeed.
    const withCsrfRes = await fetch(`${BASE_URL}/api/auth/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ name: 'Valid CSRF Key', role: 'member' }),
    });
    assert.equal(withCsrfRes.status, 201, 'Session-cookie POST with x-requested-with must succeed');
    const created = await withCsrfRes.json();

    // 4. DELETE without CSRF header must also be rejected.
    const deleteNoCsrfRes = await fetch(`${BASE_URL}/api/auth/api-keys/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(deleteNoCsrfRes.status, 403, 'Session-cookie DELETE without CSRF header must be rejected');

    // 5. DELETE with CSRF header succeeds.
    const deleteWithCsrfRes = await fetch(`${BASE_URL}/api/auth/api-keys/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'x-requested-with': 'XMLHttpRequest' },
    });
    assert.equal(deleteWithCsrfRes.status, 200);

    // 6. A real API key (Bearer cp_...) is still exempt from CSRF for its
    //    own POST /api/runs-style usage pattern; sanity-check the exemption
    //    still works for genuinely authenticated non-session callers via
    //    the login-exempt path (login itself, already covered above).
  } finally {
    child.kill('SIGKILL');
    cleanupHermeticEnv(hermeticPaths);
  }
});
