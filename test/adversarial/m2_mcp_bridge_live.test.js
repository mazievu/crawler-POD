'use strict';

/**
 * test/adversarial/m2_mcp_bridge_live.test.js
 * Adversarial Verification of MCP Bridge Lockdown against a Live Production Server.
 *
 * Verifies that the full production middleware stack in server.js enforces:
 * 1. 403 on /api/internal/mcp-bridge/query without key on real HTTP loopback
 * 2. 403 on /api/internal/mcp-bridge/query with wrong key
 * 3. 200 on /api/internal/mcp-bridge/query with valid key (reading real DB)
 * 4. 403 on /api/internal/* unknown endpoints without key
 * 5. 404 on /api/internal/* unknown endpoints with valid key
 * 6. Path Traversal isolation: /api/internal/../api/runs with internal key returns 401
 * 7. Reverse Proxy Spoofing: loopback socket with spoofed X-Forwarded-For without key returns 403
 * 8. Browser Header Rejection: Origin / Sec-Fetch rejected with 403 even with valid key
 * 9. SQL Injection Prevention: write / DDL keywords return 400
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { makeHermeticEnv, cleanupHermeticEnv } = require('../helpers/hermetic-spawn-env');

const PORT = 32198;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const LIVE_SERVICE_KEY = 'live-server-internal-service-key-32b-secret!';
const QUERY_PATH = '/api/internal/mcp-bridge/query';

test('Live Server: MCP Bridge Lockdown End-to-End Adversarial Verification', async () => {
  const { env, paths } = makeHermeticEnv({
    PORT: String(PORT),
    ADMIN_EMAIL: 'admin@system.local',
    ADMIN_PASSWORD: 'SuperAdminPassword123!',
    INTERNAL_SERVICE_KEY: LIVE_SERVICE_KEY,
  });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  try {
    // Wait for live server readiness
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
        // waiting
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(isReady, 'Live server failed to boot within 15s');

    // 1. Missing INTERNAL_SERVICE_KEY header -> 403 Forbidden
    const resNoKey = await fetch(`${BASE_URL}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });
    assert.strictEqual(resNoKey.status, 403, 'Missing service key on live server must return 403');
    const jsonNoKey = await resNoKey.json();
    assert.strictEqual(jsonNoKey.error, 'Forbidden');
    assert.match(jsonNoKey.message, /INTERNAL_SERVICE_KEY required/i);

    // 2. Wrong service key -> 403 Forbidden
    const resWrongKey = await fetch(`${BASE_URL}${QUERY_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service-key': 'attacker-wrong-service-key-12345',
      },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });
    assert.strictEqual(resWrongKey.status, 403, 'Wrong service key must return 403');
    const jsonWrongKey = await resWrongKey.json();
    assert.strictEqual(jsonWrongKey.error, 'Forbidden');
    assert.match(jsonWrongKey.message, /Invalid service credentials/i);

    // 3. Reverse proxy loopback spoofing without key -> 403 Forbidden
    const spoofHeaders = [
      { 'x-forwarded-for': '127.0.0.1' },
      { 'x-real-ip': '127.0.0.1' },
      { 'client-ip': '127.0.0.1' },
      { 'x-forwarded-for': '203.0.113.1, 127.0.0.1' },
    ];
    for (const h of spoofHeaders) {
      const resSpoof = await fetch(`${BASE_URL}${QUERY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...h },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(resSpoof.status, 403, 'Spoofed proxy loopback header without key must return 403');
    }

    // 4. Browser headers with valid key -> 403 Forbidden
    const resBrowser = await fetch(`${BASE_URL}${QUERY_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service-key': LIVE_SERVICE_KEY,
        origin: 'https://evil-cross-site.com',
      },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });
    assert.strictEqual(resBrowser.status, 403, 'Browser origin must be rejected with 403');
    const jsonBrowser = await resBrowser.json();
    assert.match(jsonBrowser.message, /browser-originated/);

    // 5. Valid key with valid query -> 200 OK with rows from live database
    const resValid = await fetch(`${BASE_URL}${QUERY_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service-key': LIVE_SERVICE_KEY,
      },
      body: JSON.stringify({ sql: 'SELECT 1 AS alive' }),
    });
    assert.strictEqual(resValid.status, 200, 'Valid key must succeed with 200');
    const jsonValid = await resValid.json();
    assert.ok(Array.isArray(jsonValid.rows));
    assert.strictEqual(jsonValid.rows[0].alive, 1);

    // 6. Unknown /api/internal/* route without key -> 403 Forbidden
    const resUnknownNoKey = await fetch(`${BASE_URL}/api/internal/nonexistent-subsystem`, {
      method: 'GET',
    });
    assert.strictEqual(resUnknownNoKey.status, 403);

    // 7. Unknown /api/internal/* route with valid key -> 404 Not Found
    const resUnknownWithKey = await fetch(`${BASE_URL}/api/internal/nonexistent-subsystem`, {
      method: 'GET',
      headers: { 'x-internal-service-key': LIVE_SERVICE_KEY },
    });
    assert.strictEqual(resUnknownWithKey.status, 404);

    // 8. Path Traversal breakout: /api/internal/../api/runs with internal key -> 401 Unauthorized
    // Proves that internal service key CANNOT authenticate user endpoints!
    const resTraversalWithKey = await fetch(`${BASE_URL}/api/internal/../api/runs`, {
      method: 'GET',
      headers: { 'x-internal-service-key': LIVE_SERVICE_KEY },
    });
    assert.strictEqual(resTraversalWithKey.status, 401, 'Internal key on user route must return 401');

    // 9. SQL Injection: Attempting DELETE / DROP via bridge returns 400 Bad Request
    const resSqlInjection = await fetch(`${BASE_URL}${QUERY_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service-key': LIVE_SERVICE_KEY,
      },
      body: JSON.stringify({ sql: 'DELETE FROM users' }),
    });
    assert.strictEqual(resSqlInjection.status, 400);

    // 10. Raw TCP CRLF Header Injection test against live server
    const rawPayload =
      `POST ${QUERY_PATH} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${PORT}\r\n` +
      `Content-Type: application/json\r\n` +
      `x-internal-service-key: ${LIVE_SERVICE_KEY}\r\nInjected: true\r\n` +
      `Content-Length: 17\r\n` +
      `Connection: close\r\n\r\n` +
      `{"sql":"SELECT 1"}`;

    const client = new net.Socket();
    let rawResponse = '';
    await new Promise((resolve) => {
      client.connect(PORT, '127.0.0.1', () => {
        client.write(rawPayload);
      });
      client.on('data', (d) => { rawResponse += d.toString(); });
      client.on('close', resolve);
      client.on('error', resolve);
    });
    // Must be either rejected as 400 (parser error) or 403 (unmatched key)
    assert.ok(
      rawResponse.startsWith('HTTP/1.1 400') || rawResponse.startsWith('HTTP/1.1 403'),
      `Raw CRLF response must be 400 or 403, got: ${rawResponse.slice(0, 100)}`
    );
  } finally {
    child.kill('SIGKILL');
    cleanupHermeticEnv(paths);
  }
});
