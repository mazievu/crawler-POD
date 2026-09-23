'use strict';

/**
 * test/challenger-m1-2-rbac-adversarial.test.js
 *
 * Empirical Adversarial Test Suite for Milestone M1 (Authentication & RBAC)
 * Challenger 2 Verification Harness
 *
 * Covers:
 * 1. Privilege Escalation (Member attempting access to 35+ Admin routes & sub-paths)
 * 2. HTTP Method Tampering (HEAD, OPTIONS, PUT, PATCH, POST vs DELETE on /api/items & admin endpoints, method override headers)
 * 3. Path Traversal & URL Encoding Tricks (.., %2e%2e, %61, %64, case variations, trailing/double slashes, raw socket requests)
 * 4. Bulk Delete vs Single Item Delete Boundary Verification (trailing slash, wildcard, path parameters, admin bulk delete)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const PORT = 32198;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Low-level HTTP helper using node:http to send exact raw path and method without client-side auto-normalization
 */
function rawRequest({ method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    let payload = null;

    if (body !== null && body !== undefined) {
      if (typeof body === 'object' && !Buffer.isBuffer(body)) {
        payload = JSON.stringify(body);
        if (!reqHeaders['content-type'] && !reqHeaders['Content-Type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
      } else {
        payload = String(body);
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path, // raw unnormalized path
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const text = rawBuffer.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Raw TCP socket request to send raw bytes directly to port 32198
 */
function rawSocketRequest(rawHttpString) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: '127.0.0.1', port: PORT }, () => {
      client.write(rawHttpString);
    });

    const chunks = [];
    client.on('data', (data) => chunks.push(data));
    client.on('end', () => {
      const response = Buffer.concat(chunks).toString('utf8');
      const [headerPart, ...bodyParts] = response.split('\r\n\r\n');
      const statusLine = headerPart.split('\r\n')[0] || '';
      const match = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
      const status = match ? parseInt(match[1], 10) : 0;
      resolve({ status, response, body: bodyParts.join('\r\n\r\n') });
    });
    client.on('error', reject);
  });
}

test('Challenger 2 Empirical RBAC Adversarial Test Suite', async (t) => {
  const env = {
    ...process.env,
    PORT: String(PORT),
    PG_MODE: 'pglite',
    ADMIN_EMAIL: 'admin@system.local',
    ADMIN_PASSWORD: 'SuperAdminPassword123!',
  };

  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  let adminSessionToken = '';
  let adminApiKey = '';
  let memberApiKey = '';

  try {
    // 0. Await server ready
    const deadline = Date.now() + 15000;
    let isReady = false;
    while (Date.now() < deadline) {
      try {
        const probe = await rawRequest({ method: 'GET', path: '/livez' });
        if (probe.status === 200) {
          isReady = true;
          break;
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(isReady, 'Server failed to start within 15s');

    // Setup: Login as Super Admin
    const loginRes = await rawRequest({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'admin@system.local', password: 'SuperAdminPassword123!' },
    });
    assert.equal(loginRes.status, 200, 'Admin login must succeed');
    const setCookie = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie || '');
    const cookieMatch = cookieStr.match(/crawler_session=([a-f0-9]{64})/);
    assert.ok(cookieMatch, 'Must return 64-char hex session cookie');
    adminSessionToken = cookieMatch[1];

    // Setup: Issue Admin API key
    const admKeyRes = await rawRequest({
      method: 'POST',
      path: '/api/auth/api-keys',
      headers: { Cookie: `crawler_session=${adminSessionToken}`, 'x-requested-with': 'XMLHttpRequest' },
      body: { name: 'Challenger Admin Key', role: 'admin', prefix: 'cp_adm_' },
    });
    assert.equal(admKeyRes.status, 201, 'Admin key issuance must succeed');
    adminApiKey = admKeyRes.json.rawKey;

    // Setup: Issue Member API key
    const memKeyRes = await rawRequest({
      method: 'POST',
      path: '/api/auth/api-keys',
      headers: { Cookie: `crawler_session=${adminSessionToken}`, 'x-requested-with': 'XMLHttpRequest' },
      body: { name: 'Challenger Member Key', role: 'member', prefix: 'cp_live_' },
    });
    assert.equal(memKeyRes.status, 201, 'Member key issuance must succeed');
    memberApiKey = memKeyRes.json.rawKey;

    // =========================================================================
    // SECTION 1: PRIVILEGE ESCALATION
    // Can a Member access any Admin route?
    // =========================================================================
    await t.test('Section 1: Privilege Escalation — Comprehensive Admin Route Matrix', async () => {
      const adminEndpoints = [
        // Web UI
        { method: 'GET', path: '/admindashboard' },
        { method: 'GET', path: '/admindashboard/' },
        { method: 'GET', path: '/admin' },
        { method: 'GET', path: '/admin/' },

        // Admin Dashboard REST APIs
        { method: 'GET', path: '/api/admin/tasks' },
        { method: 'GET', path: '/api/admin/browser-metrics' },
        { method: 'POST', path: '/api/admin/tasks/reorder', body: { taskOrder: [] } },
        { method: 'POST', path: '/api/admin/tasks/toggle', body: { taskId: 'task-1', enabled: false } },
        { method: 'POST', path: '/api/admin/repo/update', body: { branch: 'main' } },
        { method: 'POST', path: '/api/admin/bulk-delete', body: { entity: 'all' } },

        // Apify Token Management
        { method: 'GET', path: '/api/apify-tokens' },
        { method: 'POST', path: '/api/apify-tokens', body: { token: 'apify_test' } },
        { method: 'GET', path: '/api/apify-tokens/status' },
        { method: 'POST', path: '/api/apify-tokens/cleanup' },
        { method: 'DELETE', path: '/api/apify-tokens/9999' },
        { method: 'GET', path: '/api/tokens' },
        { method: 'POST', path: '/api/tokens', body: { token: 'test' } },

        // Marketplace Accounts & Proxies
        { method: 'GET', path: '/api/marketplace-accounts?platform=etsy' },
        { method: 'POST', path: '/api/marketplace-accounts', body: { platform: 'etsy' } },
        { method: 'PUT', path: '/api/marketplace-accounts/1/proxy', body: { proxyUrl: 'http://p:1' } },
        { method: 'DELETE', path: '/api/marketplace-accounts/1' },
        { method: 'GET', path: '/api/marketplace-proxies' },
        { method: 'POST', path: '/api/marketplace-proxies', body: { proxyUrl: 'http://p:1' } },
        { method: 'DELETE', path: '/api/marketplace-proxies/1' },
        { method: 'GET', path: '/api/proxies' },
        { method: 'POST', path: '/api/proxies', body: { proxy: 'http://p:1' } },

        // Marketplace Login Sessions
        { method: 'POST', path: '/api/marketplace-login-sessions', body: { platform: 'etsy' } },
        { method: 'POST', path: '/api/marketplace-login-sessions/1/complete' },
        { method: 'DELETE', path: '/api/marketplace-login-sessions/1' },
        { method: 'GET', path: '/api/sessions' },

        // System, DB & Diagnostics
        { method: 'GET', path: '/api/doctor' },
        { method: 'GET', path: '/api/system/info' },
        { method: 'GET', path: '/api/database/health' },
        { method: 'GET', path: '/api/database/parity' },
        { method: 'GET', path: '/api/proxy-pool/status' },
        { method: 'GET', path: '/api/toidispy/check-login' },

        // Auth & API Key Management
        { method: 'GET', path: '/api/auth/api-keys' },
        { method: 'POST', path: '/api/auth/api-keys', body: { name: 'Hacked', role: 'admin' } },
        { method: 'DELETE', path: '/api/auth/api-keys/999' },
        { method: 'GET', path: '/api-keys' },
        { method: 'POST', path: '/api-keys', body: { name: 'Hacked', role: 'admin' } },
        { method: 'DELETE', path: '/api-keys/999' },

        // Method-specific admin guard
        { method: 'PUT', path: '/api/social-bots/reddit', body: { enabled: true } },
      ];

      for (const ep of adminEndpoints) {
        // Test A: Member using x-api-key MUST receive 403 Forbidden
        const resMemberApiKey = await rawRequest({
          method: ep.method,
          path: ep.path,
          headers: { 'x-api-key': memberApiKey },
          body: ep.body,
        });
        assert.equal(
          resMemberApiKey.status,
          403,
          `Member x-api-key to ${ep.method} ${ep.path} must return 403, got ${resMemberApiKey.status}`
        );

        // Test B: Member using Authorization: Bearer MUST receive 403 Forbidden
        const resMemberBearer = await rawRequest({
          method: ep.method,
          path: ep.path,
          headers: { Authorization: `Bearer ${memberApiKey}` },
          body: ep.body,
        });
        assert.equal(
          resMemberBearer.status,
          403,
          `Member Bearer to ${ep.method} ${ep.path} must return 403, got ${resMemberBearer.status}`
        );

        // Test C: Unauthenticated request MUST receive 401 Unauthorized
        const resUnauth = await rawRequest({
          method: ep.method,
          path: ep.path,
          body: ep.body,
        });
        assert.equal(
          resUnauth.status,
          401,
          `Unauthenticated request to ${ep.method} ${ep.path} must return 401, got ${resUnauth.status}`
        );

        // Test D: Admin MUST NOT be blocked by 401 or 403
        const resAdmin = await rawRequest({
          method: ep.method,
          path: ep.path,
          headers: { 'x-api-key': adminApiKey },
          body: ep.body,
        });
        assert.notEqual(
          resAdmin.status,
          401,
          `Admin to ${ep.method} ${ep.path} should not be 401`
        );
        assert.notEqual(
          resAdmin.status,
          403,
          `Admin to ${ep.method} ${ep.path} should not be 403 (got status ${resAdmin.status})`
        );
      }
    });

    await t.test('Section 1: Privilege Escalation — Self-Promotion and Bootstrap Attack Vectors', async () => {
      // 1. Member calls POST /api/auth/bootstrap trying to overwrite admin password.
      // The route itself no longer exists — bootstrap only happens from env
      // at server boot or via `npm run bootstrap:admin` — so this must be
      // rejected outright, never reach any bootstrap logic.
      const bootRes = await rawRequest({
        method: 'POST',
        path: '/api/auth/bootstrap',
        headers: { 'x-api-key': memberApiKey },
        body: { adminEmail: 'admin@system.local', adminPassword: 'AttackerNewPassword999!' },
      });
      assert.ok([401, 403, 404].includes(bootRes.status), `POST /api/auth/bootstrap must be rejected, got ${bootRes.status}`);

      // Verify original admin password is still intact
      const verifyLogin = await rawRequest({
        method: 'POST',
        path: '/api/auth/login',
        body: { email: 'admin@system.local', password: 'SuperAdminPassword123!' },
      });
      assert.equal(verifyLogin.status, 200, 'Original admin credentials must remain valid');

      // 2. Attacker attempt login with the attempted password -> must fail 401
      const failLogin = await rawRequest({
        method: 'POST',
        path: '/api/auth/login',
        body: { email: 'admin@system.local', password: 'AttackerNewPassword999!' },
      });
      assert.equal(failLogin.status, 401, 'Tampered password must be rejected');

      // 3. Member tries to create an Admin API key
      const createAdminKeyRes = await rawRequest({
        method: 'POST',
        path: '/api/auth/api-keys',
        headers: { 'x-api-key': memberApiKey },
        body: { name: 'Escalated Key', role: 'admin', prefix: 'cp_adm_' },
      });
      assert.equal(createAdminKeyRes.status, 403, 'Member cannot create admin API key');
    });

    await t.test('Section 1: Privilege Escalation — Legitimate Member Operations Preserved', async () => {
      const memberAccessible = [
        { method: 'GET', path: '/api/platforms' },
        { method: 'GET', path: '/api/runs' },
        { method: 'GET', path: '/api/items' },
        { method: 'GET', path: '/api/item-metrics' },
        { method: 'GET', path: '/api/stats' },
        { method: 'GET', path: '/api/captures' },
        { method: 'GET', path: '/api/exports' },
        { method: 'GET', path: '/api/marketplace-capture-schedules' },
        { method: 'GET', path: '/api/toidispy/filters' },
      ];

      for (const ep of memberAccessible) {
        const res = await rawRequest({
          method: ep.method,
          path: ep.path,
          headers: { 'x-api-key': memberApiKey },
        });
        assert.equal(
          res.status,
          200,
          `Member must have access to ${ep.method} ${ep.path}, got ${res.status}`
        );
      }
    });

    // =========================================================================
    // SECTION 2: HTTP METHOD TAMPERING
    // HEAD, OPTIONS, PUT, PATCH vs DELETE on /api/items & admin endpoints
    // =========================================================================
    await t.test('Section 2: HTTP Method Tampering on /api/items', async () => {
      // 1. GET /api/items (Member) -> 200 OK
      const getRes = await rawRequest({
        method: 'GET',
        path: '/api/items',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(getRes.status, 200, 'Member GET /api/items must succeed');

      // 2. DELETE /api/items (Member) -> 403 Forbidden
      const delRes = await rawRequest({
        method: 'DELETE',
        path: '/api/items',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(delRes.status, 403, 'Member DELETE /api/items must be 403');

      // 3. HEAD /api/items (Member) -> 200 (Express maps HEAD to GET)
      const headRes = await rawRequest({
        method: 'HEAD',
        path: '/api/items',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(headRes.status, 200, 'Member HEAD /api/items should mirror GET status');

      // 4. OPTIONS /api/items (Member) -> 200 or 204 (CORS / preflight)
      const optionsRes = await rawRequest({
        method: 'OPTIONS',
        path: '/api/items',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.ok([200, 204].includes(optionsRes.status), 'OPTIONS /api/items should return 200 or 204');

      // 5. POST /api/items (Member) -> 404 (no handler, does not trigger delete)
      const postRes = await rawRequest({
        method: 'POST',
        path: '/api/items',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(postRes.status, 404, 'POST /api/items must be 404');

      // 6. PUT /api/items (Member) -> 404
      const putRes = await rawRequest({
        method: 'PUT',
        path: '/api/items',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(putRes.status, 404, 'PUT /api/items must be 404');

      // 7. PATCH /api/items (Member) -> 404
      const patchRes = await rawRequest({
        method: 'PATCH',
        path: '/api/items',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(patchRes.status, 404, 'PATCH /api/items must be 404');

      // 8. Method Spoofing Headers: X-HTTP-Method-Override: DELETE
      const spoof1 = await rawRequest({
        method: 'POST',
        path: '/api/items',
        headers: {
          'x-api-key': memberApiKey,
          'X-HTTP-Method-Override': 'DELETE',
        },
      });
      assert.equal(spoof1.status, 404, 'X-HTTP-Method-Override on POST must not execute DELETE');

      const spoof2 = await rawRequest({
        method: 'GET',
        path: '/api/items',
        headers: {
          'x-api-key': memberApiKey,
          'X-HTTP-Method-Override': 'DELETE',
        },
      });
      // Stays a safe GET read (200) and does not perform DELETE
      assert.equal(spoof2.status, 200, 'X-HTTP-Method-Override on GET must remain safe GET');

      // 9. Method Spoofing via Query Parameter ?_method=DELETE
      const spoofQuery = await rawRequest({
        method: 'GET',
        path: '/api/items?_method=DELETE',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(spoofQuery.status, 200, '?_method=DELETE must not convert GET to DELETE');
    });

    await t.test('Section 2: HTTP Method Tampering on Admin Endpoints', async () => {
      // 1. HEAD /api/doctor (Member) -> 403 Forbidden!
      const headDoc = await rawRequest({
        method: 'HEAD',
        path: '/api/doctor',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(headDoc.status, 403, 'Member HEAD /api/doctor must be 403');

      // 2. HEAD /admindashboard (Member) -> 403 Forbidden!
      const headDash = await rawRequest({
        method: 'HEAD',
        path: '/admindashboard',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(headDash.status, 403, 'Member HEAD /admindashboard must be 403');

      // 3. POST /admindashboard (Member) -> 403 Forbidden!
      const postDash = await rawRequest({
        method: 'POST',
        path: '/admindashboard',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(postDash.status, 403, 'Member POST /admindashboard must be 403');

      // 4. DELETE /api/doctor (Member) -> 403 Forbidden!
      const delDoc = await rawRequest({
        method: 'DELETE',
        path: '/api/doctor',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(delDoc.status, 403, 'Member DELETE /api/doctor must be 403');

      // 5. PUT /api/apify-tokens (Member) -> 403 Forbidden!
      const putTok = await rawRequest({
        method: 'PUT',
        path: '/api/apify-tokens',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(putTok.status, 403, 'Member PUT /api/apify-tokens must be 403');

      // 6. PATCH /api/system/info (Member) -> 403 Forbidden!
      const patchSys = await rawRequest({
        method: 'PATCH',
        path: '/api/system/info',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(patchSys.status, 403, 'Member PATCH /api/system/info must be 403');
    });

    // =========================================================================
    // SECTION 3: PATH TRAVERSAL AND URL ENCODING TRICKS
    // =========================================================================
    await t.test('Section 3: Path Traversal & Dot Segment Normalization', async () => {
      // 1. Path traversal: /api/items/../apify-tokens
      const trav1 = await rawRequest({
        method: 'GET',
        path: '/api/items/../apify-tokens',
        headers: { 'x-api-key': memberApiKey },
      });
      // If normalized to /api/apify-tokens -> 403. If unnormalized 404. In NO case 200!
      assert.notEqual(trav1.status, 200, 'Traversal to /api/apify-tokens must never return 200');
      assert.ok([403, 404].includes(trav1.status), `Expected 403 or 404, got ${trav1.status}`);

      // 2. Path traversal: /api/items/../doctor
      const trav2 = await rawRequest({
        method: 'GET',
        path: '/api/items/../doctor',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(trav2.status, 200, 'Traversal to /api/doctor must never return 200');
      assert.ok([403, 404].includes(trav2.status), `Expected 403 or 404, got ${trav2.status}`);

      // 3. Encoded traversal: /api/items/%2e%2e/apify-tokens
      const trav3 = await rawRequest({
        method: 'GET',
        path: '/api/items/%2e%2e/apify-tokens',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(trav3.status, 200, 'Encoded traversal %2e%2e must not return 200');
      assert.ok([403, 404].includes(trav3.status));

      // 4. Semicolon path traversal trick: /api/items/..;/apify-tokens
      const travSemi = await rawRequest({
        method: 'GET',
        path: '/api/items/..;/apify-tokens',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(travSemi.status, 200, 'Semicolon traversal must not return 200');

      // 5. Raw TCP socket sending unnormalized path directly over wire
      const rawSocketRes = await rawSocketRequest(
        `GET /api/items/../doctor HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nx-api-key: ${memberApiKey}\r\nConnection: close\r\n\r\n`
      );
      assert.notEqual(rawSocketRes.status, 200, 'Raw TCP unnormalized traversal must not return 200');
      assert.ok([403, 404].includes(rawSocketRes.status));
    });

    await t.test('Section 3: URL Encoding Tricks on Admin Route Names', async () => {
      // 1. Percent encoding: /api/%61pify-tokens (%61 = 'a')
      const enc1 = await rawRequest({
        method: 'GET',
        path: '/api/%61pify-tokens',
        headers: { 'x-api-key': memberApiKey },
      });
      // Express router decodes %61 -> 'a', hitting requireAdmin (403), or 404. NEVER 200!
      assert.notEqual(enc1.status, 200, '/api/%61pify-tokens must not leak tokens');
      assert.ok([403, 404].includes(enc1.status));

      // 2. Percent encoding: /api/%64octor (%64 = 'd')
      const enc2 = await rawRequest({
        method: 'GET',
        path: '/api/%64octor',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(enc2.status, 200, '/api/%64octor must not leak doctor diagnostics');
      assert.ok([403, 404].includes(enc2.status));

      // 3. Percent encoding: /api/system/%69nfo (%69 = 'i')
      const enc3 = await rawRequest({
        method: 'GET',
        path: '/api/system/%69nfo',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(enc3.status, 200, '/api/system/%69nfo must not leak system info');
      assert.ok([403, 404].includes(enc3.status));

      // 4. Percent encoding: /api/%61dmin/tasks
      const enc4 = await rawRequest({
        method: 'GET',
        path: '/api/%61dmin/tasks',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(enc4.status, 200, '/api/%61dmin/tasks must not leak admin tasks');
      assert.ok([403, 404].includes(enc4.status));

      // 5. Percent encoding: /%61dmindashboard
      const enc5 = await rawRequest({
        method: 'GET',
        path: '/%61dmindashboard',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(enc5.status, 200, '/%61dmindashboard must not leak dashboard HTML');
      assert.ok([403, 404].includes(enc5.status));
    });

    await t.test('Section 3: Slashes, Dot Segments, and Case Sensitivity Variations', async () => {
      // 1. Trailing slash: /api/apify-tokens/
      const slash1 = await rawRequest({
        method: 'GET',
        path: '/api/apify-tokens/',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(slash1.status, 403, 'Trailing slash /api/apify-tokens/ must return 403');

      // 2. Double slash: /api//apify-tokens
      const slash2 = await rawRequest({
        method: 'GET',
        path: '/api//apify-tokens',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(slash2.status, 200, 'Double slash /api//apify-tokens must not return 200');
      assert.ok([403, 404].includes(slash2.status));

      // 3. Dot segment: /api/./apify-tokens
      const dot1 = await rawRequest({
        method: 'GET',
        path: '/api/./apify-tokens',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(dot1.status, 200, 'Dot segment /api/./apify-tokens must not return 200');
      assert.ok([403, 404].includes(dot1.status));

      // 4. Case variation: /API/APIFY-TOKENS
      const case1 = await rawRequest({
        method: 'GET',
        path: '/API/APIFY-TOKENS',
        headers: { 'x-api-key': memberApiKey },
      });
      // In Express 4 with case-insensitive routing, must be guarded (403) or not found (404), never leak 200
      assert.notEqual(case1.status, 200, 'Uppercase /API/APIFY-TOKENS must not leak 200');
      assert.ok([403, 404].includes(case1.status));

      // 5. Case variation: /api/Doctor
      const case2 = await rawRequest({
        method: 'GET',
        path: '/api/Doctor',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(case2.status, 200, 'Mixed case /api/Doctor must not leak 200');
      assert.ok([403, 404].includes(case2.status));

      // 6. Case variation: /AdminDashboard
      const case3 = await rawRequest({
        method: 'GET',
        path: '/AdminDashboard',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.notEqual(case3.status, 200, '/AdminDashboard must not leak 200');
      assert.ok([403, 404].includes(case3.status));
    });

    // =========================================================================
    // SECTION 4: BULK DELETE VS SINGLE ITEM DELETE BOUNDARY VERIFICATION
    // =========================================================================
    await t.test('Section 4: Bulk Delete vs Single Item Delete Boundaries', async () => {
      // 1. Single Item Delete by Member -> Allowed (200 OK)
      const singleDelMember = await rawRequest({
        method: 'DELETE',
        path: '/api/items/item_test_uid_001',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(singleDelMember.status, 200, 'Member single item delete must be allowed (200)');
      assert.equal(singleDelMember.json?.success, true);

      // 2. Single Item Delete by Admin -> Allowed (200 OK)
      const singleDelAdmin = await rawRequest({
        method: 'DELETE',
        path: '/api/items/item_test_uid_002',
        headers: { 'x-api-key': adminApiKey },
      });
      assert.equal(singleDelAdmin.status, 200, 'Admin single item delete must be allowed (200)');
      assert.equal(singleDelAdmin.json?.success, true);

      // 3. Single Item Delete Unauthenticated -> Blocked (401 Unauthorized)
      const singleDelUnauth = await rawRequest({
        method: 'DELETE',
        path: '/api/items/item_test_uid_003',
      });
      assert.equal(singleDelUnauth.status, 401, 'Unauthenticated single item delete must be 401');

      // 4. Bulk Delete by Member without query -> Blocked (403 Forbidden)
      const bulkDelMember = await rawRequest({
        method: 'DELETE',
        path: '/api/items',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(bulkDelMember.status, 403, 'Member bulk delete DELETE /api/items must be 403');

      // 5. Bulk Delete by Member with platform filter -> Blocked (403 Forbidden)
      const bulkDelPlatform = await rawRequest({
        method: 'DELETE',
        path: '/api/items?platform=etsy',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(bulkDelPlatform.status, 403, 'Member bulk delete with ?platform must be 403');

      // 6. Bulk Delete by Member with query filter -> Blocked (403 Forbidden)
      const bulkDelQuery = await rawRequest({
        method: 'DELETE',
        path: '/api/items?query=*',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(bulkDelQuery.status, 403, 'Member bulk delete with ?query must be 403');

      // 7. Bulk Delete by Member via POST /api/admin/bulk-delete -> Blocked (403 Forbidden)
      const adminBulkDelMember = await rawRequest({
        method: 'POST',
        path: '/api/admin/bulk-delete',
        headers: { 'x-api-key': memberApiKey },
        body: { entity: 'all' },
      });
      assert.equal(adminBulkDelMember.status, 403, 'Member POST /api/admin/bulk-delete must be 403');

      // 8. Bulk Delete by Admin -> Allowed (200 OK)
      const bulkDelAdmin = await rawRequest({
        method: 'DELETE',
        path: '/api/items',
        headers: { 'x-api-key': adminApiKey },
      });
      assert.equal(bulkDelAdmin.status, 200, 'Admin bulk delete must be allowed (200)');
      assert.equal(bulkDelAdmin.json?.success, true);

      // 9. POST /api/admin/bulk-delete by Admin -> Allowed (200 OK)
      const adminBulkDelAdmin = await rawRequest({
        method: 'POST',
        path: '/api/admin/bulk-delete',
        headers: { 'x-api-key': adminApiKey },
        body: { entity: 'all' },
      });
      assert.equal(adminBulkDelAdmin.status, 200, 'Admin POST /api/admin/bulk-delete must be allowed (200)');

      // 10. Trailing slash boundary: DELETE /api/items/
      // In Express, /api/items/ does not match /api/items/:uid (empty param is not captured)
      // It matches /api/items, which is guarded by requireAdmin -> 403 Forbidden!
      const trailingDelMember = await rawRequest({
        method: 'DELETE',
        path: '/api/items/',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(
        trailingDelMember.status,
        403,
        `DELETE /api/items/ must hit requireAdmin and return 403 for member, got ${trailingDelMember.status}`
      );

      // 11. Wildcard UID parameter: DELETE /api/items/*
      // Matches single item delete with uid = '*' -> Member allowed (200 OK), but changes is 0
      const wildcardDelMember = await rawRequest({
        method: 'DELETE',
        path: '/api/items/*',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(wildcardDelMember.status, 200, 'Wildcard /api/items/* matches single item delete');
      assert.equal(wildcardDelMember.json?.success, true);

      // 12. Path traversal in delete:
      // A) DELETE /api/items/.. treats '..' as literal item_uid parameter in Express router
      // Calling deleteItem('..') which deletes 0 items and NEVER executes deleteAllItems()
      const travDelMemberLiteral = await rawRequest({
        method: 'DELETE',
        path: '/api/items/..',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(travDelMemberLiteral.status, 200, 'DELETE /api/items/.. is routed to single item delete with uid=..');
      assert.equal(travDelMemberLiteral.json?.message, 'Item .. deleted');
      assert.equal(travDelMemberLiteral.json?.changes, 0, 'No items must be deleted');

      // B) Path traversal from nested segment: DELETE /api/items/foo/.. which normalizes to /api/items (bulk delete)
      const travDelMemberNormalized = await rawRequest({
        method: 'DELETE',
        path: '/api/items/foo/..',
        headers: { 'x-api-key': memberApiKey },
      });
      assert.equal(
        travDelMemberNormalized.status,
        404,
        'Unnormalized 3-segment traversal /api/items/foo/.. returns 404 and does not trigger delete'
      );
    });

  } finally {
    child.kill('SIGKILL');
  }
});
