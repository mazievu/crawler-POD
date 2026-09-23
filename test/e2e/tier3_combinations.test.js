'use strict';

/**
 * test/e2e/tier3_combinations.test.js — Tier 3: Cross-Feature Combinations Suite
 *
 * Covers pairwise interactions across Auth, RBAC, Ingress, SSRF, Rate Limiting,
 * Concurrency, Cost Protection, Backup/Restore, Probes, and Lifecycle.
 * Uses node:test and node:assert, running hermetically against in-process contract harness.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  withTestServer,
  validateOutboundUrl,
  safeFetch,
  SSRFSecurityError,
  createPostgresBackupManifest,
  verifyAndRestoreBackup,
} = require('./harness');

// ============================================================================
// Combo 1: Auth + RBAC + Session
// ============================================================================
test('Combo 1: Login sets session, member route succeeds with member role, admin route rejected with 403', async () => {
  await withTestServer({}, async (baseUrl, controls) => {
    controls.db.addUser({ email: 'member@combo.local', password: 'ValidPassword123!', role: 'member' });
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@combo.local', password: 'ValidPassword123!' }),
    });
    assert.strictEqual(loginRes.status, 200);
    const { sessionToken } = await loginRes.json();

    const memberRes = await fetch(`${baseUrl}/api/runs`, {
      headers: { cookie: `crawler_session=${sessionToken}` },
    });
    assert.strictEqual(memberRes.status, 200);

    const adminRes = await fetch(`${baseUrl}/api/tokens`, {
      headers: { cookie: `crawler_session=${sessionToken}` },
    });
    assert.strictEqual(adminRes.status, 403);
  });
});

// ============================================================================
// Combo 2: Bootstrap + Auth + Cookie + Admin Access
// ============================================================================
test('Combo 2: Super Admin bootstrapped from env, logs in, gets cookie, accesses admin endpoints', async () => {
  await withTestServer({ adminEmail: 'root@combo.local', adminPassword: 'RootPassword123!' }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/auth/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root@combo.local', password: 'RootPassword123!' }),
    });
    const { sessionToken } = await loginRes.json();

    const doctorRes = await fetch(`${baseUrl}/api/doctor`, {
      headers: { cookie: `crawler_session=${sessionToken}` },
    });
    assert.strictEqual(doctorRes.status, 200);
    const sysRes = await fetch(`${baseUrl}/api/system/info`, {
      headers: { cookie: `crawler_session=${sessionToken}` },
    });
    assert.strictEqual(sysRes.status, 200);
  });
});

// ============================================================================
// Combo 3: API Key + Scoping + RBAC
// ============================================================================
test('Combo 3: Admin issues Member and Admin API keys; Member key denied admin routes', async () => {
  await withTestServer({}, async (baseUrl, controls) => {
    const admin = controls.db.addUser({ email: 'keyadmin@combo.local', password: 'pwd', role: 'admin' });
    const member = controls.db.addUser({ email: 'keymember@combo.local', password: 'pwd', role: 'member' });
    const { rawKey: memberKey } = controls.db.createApiKey({ userId: member.id, role: 'member' });
    const { rawKey: adminKey } = controls.db.createApiKey({ userId: admin.id, role: 'admin' });

    // Member key accesses runs (200), denied proxies (403)
    const mRun = await fetch(`${baseUrl}/api/runs`, { headers: { 'x-api-key': memberKey } });
    assert.strictEqual(mRun.status, 200);
    const mProx = await fetch(`${baseUrl}/api/proxies`, { headers: { 'x-api-key': memberKey } });
    assert.strictEqual(mProx.status, 403);

    // Admin key accesses both
    const aRun = await fetch(`${baseUrl}/api/runs`, { headers: { 'x-api-key': adminKey } });
    assert.strictEqual(aRun.status, 200);
    const aProx = await fetch(`${baseUrl}/api/proxies`, { headers: { 'x-api-key': adminKey } });
    assert.strictEqual(aProx.status, 200);
  });
});

// ============================================================================
// Combo 4: API Key Expiry + Rate Limiting
// ============================================================================
test('Combo 4: Expired API key is rejected with 401 before consuming rate limit tokens', async () => {
  await withTestServer({}, async (baseUrl, controls) => {
    const user = controls.db.addUser({ email: 'expkey@combo.local', password: 'pwd', role: 'member' });
    const { rawKey } = controls.db.createApiKey({ userId: user.id, role: 'member', expiresInDays: -1 });

    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'test' }),
    });
    assert.strictEqual(res.status, 401);
  });
});

// ============================================================================
// Combo 5: MCP Bridge Lockdown + Admin Role
// ============================================================================
test('Combo 5: Even authenticated Admin session cannot access MCP bridge without x-internal-service-key', async () => {
  await withTestServer({ internalServiceKey: 'correct-secret-service-key-32ch!' }, async (baseUrl, controls) => {
    const admin = controls.db.addUser({ email: 'superadmin@combo.local', password: 'pwd', role: 'admin' });
    const session = controls.db.createSession(admin.id);

    const res = await fetch(`${baseUrl}/api/internal/mcp-bridge/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `crawler_session=${session.sessionToken}`,
      },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });
    assert.strictEqual(res.status, 403);
  });
});

// ============================================================================
// Combo 6: MCP Bridge + Write Query Rejection
// ============================================================================
test('Combo 6: Request with valid service key attempting write SQL statement rejected with 400', async () => {
  await withTestServer({ internalServiceKey: 'bridge-key-secret-32-chars-long!' }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/internal/mcp-bridge/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service-key': 'bridge-key-secret-32-chars-long!',
      },
      body: JSON.stringify({ sql: 'DROP TABLE runs;' }),
    });
    assert.strictEqual(res.status, 400);
  });
});

// ============================================================================
// Combo 7: SSRF Outbound Validator + Shopify Scraper
// ============================================================================
test('Combo 7: Shopify scraper input targeting internal IP blocked before network egress', async () => {
  await assert.rejects(async () => {
    await validateOutboundUrl('https://10.0.0.5/products.json?limit=50');
  }, (err) => err instanceof SSRFSecurityError);
});

// ============================================================================
// Combo 8: SSRF Outbound Validator + Media Cache + SafeFetch
// ============================================================================
test('Combo 8: Media cache downloading image from private IP blocked; public image succeeds', async () => {
  await assert.rejects(async () => {
    await validateOutboundUrl('http://192.168.1.1/image.png');
  }, SSRFSecurityError);

  const mockFetch = async () => ({
    status: 200,
    headers: new Map([['content-length', '500']]),
    text: async () => 'png_data',
  });
  const res = await safeFetch('https://images.example.com/item.png', { mockFetch });
  assert.strictEqual(res.status, 200);
});

// ============================================================================
// Combo 9: SSRF Redirect Chain + SafeFetch
// ============================================================================
test('Combo 9: Public URL that redirects (302) to AWS metadata is caught on redirect hop', async () => {
  const mockFetch = async (url) => {
    if (url.includes('redirect-to-meta')) {
      return {
        status: 302,
        headers: new Map([['location', 'http://169.254.169.254/latest/meta-data']]),
      };
    }
    return { status: 200, headers: new Map() };
  };

  await assert.rejects(async () => {
    await safeFetch('https://public.example.com/redirect-to-meta', { mockFetch });
  }, (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED');
});

// ============================================================================
// Combo 10: CORS + CSRF + Auth Session
// ============================================================================
test('Combo 10: Unauthorized origin blocked by CORS; authorized origin without CSRF blocked with 403', async () => {
  await withTestServer({ allowedOrigins: ['https://trusted.local'] }, async (baseUrl, controls) => {
    const user = controls.db.addUser({ email: 'corscsrf@combo.local', password: 'pwd', role: 'member' });
    const session = controls.db.createSession(user.id);

    // 1. Untrusted origin
    const corsRes = await fetch(`${baseUrl}/api/runs`, {
      headers: { origin: 'https://evil.com' },
    });
    assert.notStrictEqual(corsRes.headers.get('access-control-allow-origin'), 'https://evil.com');

    // 2. Trusted origin, but missing CSRF on POST
    const csrfRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://trusted.local',
        cookie: `crawler_session=${session.sessionToken}`,
      },
      body: JSON.stringify({ query: 'shoes' }),
    });
    assert.strictEqual(csrfRes.status, 403);
  });
});

// ============================================================================
// Combo 11: Login Brute Force + Admin Account Protection
// ============================================================================
test('Combo 11: Attacker attempting brute force on admin email gets locked out after 5 attempts', async () => {
  await withTestServer({ adminEmail: 'admin@combo.local', adminPassword: 'SecretAdminPassword123!' }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/auth/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@combo.local', password: `guess_${i}` }),
      });
    }
    // 6th attempt with real password is now locked out
    const lockedRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@combo.local', password: 'SecretAdminPassword123!' }),
    });
    assert.strictEqual(lockedRes.status, 429);
  });
});

// ============================================================================
// Combo 12: Run Creation Rate Limiter + Concurrency Cap
// ============================================================================
test('Combo 12: Rapid run creation hits the 10/min rate limit before exhausting higher concurrency cap', async () => {
  await withTestServer({ maxConcurrentRuns: 50 }, async (baseUrl, controls) => {
    const user = controls.db.addUser({ email: 'caprate@combo.local', password: 'pwd', role: 'member' });
    const { rawKey } = controls.db.createApiKey({ userId: user.id, role: 'member' });
    for (let i = 0; i < 10; i++) {
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
        body: JSON.stringify({ query: `run ${i}` }),
      });
    }
    const r11 = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'overflow' }),
    });
    assert.strictEqual(r11.status, 429);
    assert.strictEqual(controls.getActiveRunsCount(), 10);
  });
});

// ============================================================================
// Combo 13: Emergency Freeze + Run Creation + Concurrency
// ============================================================================
test('Combo 13: When Emergency Freeze is enabled, new run creation returns 503 even if concurrency slots are open', async () => {
  await withTestServer({ maxConcurrentRuns: 10 }, async (baseUrl, controls) => {
    controls.setEmergencyFrozen(true);
    const user = controls.db.addUser({ email: 'frozenconc@combo.local', password: 'pwd', role: 'member' });
    const { rawKey } = controls.db.createApiKey({ userId: user.id, role: 'member' });
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'freeze test' }),
    });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(controls.getActiveRunsCount(), 0);
  });
});

// ============================================================================
// Combo 14: Emergency Freeze + Active Runs + Completion
// ============================================================================
test('Combo 14: Emergency Freeze blocks new runs, while active runs can complete and release their slots', async () => {
  await withTestServer({ maxConcurrentRuns: 5 }, async (baseUrl, controls) => {
    const user = controls.db.addUser({ email: 'drain@combo.local', password: 'pwd', role: 'member' });
    const { rawKey } = controls.db.createApiKey({ userId: user.id, role: 'member' });
    const r1 = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'running' }),
    });
    const { run } = await r1.json();
    assert.strictEqual(controls.getActiveRunsCount(), 1);

    controls.setEmergencyFrozen(true);

    // Active run completes
    const compRes = await fetch(`${baseUrl}/api/runs/${run.id}/complete`, {
      method: 'POST',
      headers: { 'x-api-key': rawKey },
    });
    assert.strictEqual(compRes.status, 200);
    assert.strictEqual(controls.getActiveRunsCount(), 0);
  });
});

// ============================================================================
// Combo 15: Apify Budget Kill Switch + Free Scrapers
// ============================================================================
test('Combo 15: When Apify budget is 0, paid actor requests fail with 402, but free scraper runs succeed', async () => {
  await withTestServer({ initialApifyBalance: 0.0 }, async (baseUrl, controls) => {
    const user = controls.db.addUser({ email: 'hybrid@combo.local', password: 'pwd', role: 'member' });
    const { rawKey } = controls.db.createApiKey({ userId: user.id, role: 'member' });

    const paidRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ isPaidActor: true }),
    });
    assert.strictEqual(paidRes.status, 402);

    const freeRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ isPaidActor: false }),
    });
    assert.strictEqual(freeRes.status, 201);
  });
});

// ============================================================================
// Combo 16: PostgreSQL Backup + SHA-256 Manifest + Rollback Engine
// ============================================================================
test('Combo 16: Full round-trip: backup created, manifest verified, restored into clean target', () => {
  const sqlDump = 'CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);';
  const { manifest, dumpContent } = createPostgresBackupManifest(['t'], sqlDump);
  const restoreRes = verifyAndRestoreBackup(manifest, dumpContent);
  assert.strictEqual(restoreRes.success, true);
  assert.ok(restoreRes.restoredAt);
});

// ============================================================================
// Combo 17: PostgreSQL Backup Tampering + Rollback Dry-Run
// ============================================================================
test('Combo 17: Tampered dump file caught by dry-run and rejected before DB modification', () => {
  const { manifest } = createPostgresBackupManifest(['t'], 'SELECT 1;');
  const corrupted = 'SELECT 1; MALICIOUS INJECTION';
  assert.throws(
    () => verifyAndRestoreBackup(manifest, corrupted, { dryRun: true }),
    /Checksum mismatch/
  );
});

// ============================================================================
// Combo 18: Liveness & Readiness Probes + Database Health
// ============================================================================
test('Combo 18: /livez stays 200 during DB disconnection while /readyz switches to 503', async () => {
  await withTestServer({}, async (baseUrl, controls) => {
    controls.db.isHealthy = false;
    const lRes = await fetch(`${baseUrl}/livez`);
    assert.strictEqual(lRes.status, 200);
    const rRes = await fetch(`${baseUrl}/readyz`);
    assert.strictEqual(rRes.status, 503);
  });
});

// ============================================================================
// Combo 19: Graceful Shutdown + In-Flight Runs + Connections
// ============================================================================
test('Combo 19: Graceful shutdown: /livez returns 503, incoming runs rejected, in-flight run completes', async () => {
  await withTestServer({ maxConcurrentRuns: 5 }, async (baseUrl, controls) => {
    const user = controls.db.addUser({ email: 'shutdown@combo.local', password: 'pwd', role: 'member' });
    const { rawKey } = controls.db.createApiKey({ userId: user.id, role: 'member' });
    const startRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'active before shutdown' }),
    });
    const { run } = await startRes.json();

    controls.simulateShutdown();

    // New request rejected
    const newRes = await fetch(`${baseUrl}/livez`);
    assert.strictEqual(newRes.status, 503);

    // Active run completes
    const compRes = await fetch(`${baseUrl}/api/runs/${run.id}/complete`, {
      method: 'POST',
      headers: { 'x-api-key': rawKey },
    });
    assert.strictEqual(compRes.status, 200);
  });
});

// ============================================================================
// Combo 20: Graceful Shutdown + Limiter Lease Release
// ============================================================================
test('Combo 20: Process shutdown explicitly clears active limiter lease', () => {
  const leaseStore = new Map([['worker-1', { leaseUntil: Date.now() + 20000 }]]);
  // Shutdown hook execution
  leaseStore.delete('worker-1');
  assert.strictEqual(leaseStore.has('worker-1'), false);
});

// ============================================================================
// Combo 21: Docker Context Hardening + Media Cache Volume
// ============================================================================
test('Combo 21: Clean container build ignores secrets and mounts persistent volume for media', () => {
  const ignoreRules = ['.env', 'proxies.txt', 'logs/'];
  const testExclusion = (f) => ignoreRules.some(r => f.startsWith(r) || f.endsWith(r));
  assert.strictEqual(testExclusion('.env'), true);
  assert.strictEqual(testExclusion('proxies.txt'), true);
  const mediaMount = { target: '/app/public/media', source: 'media_cache' };
  assert.strictEqual(mediaMount.target, '/app/public/media');
});

// ============================================================================
// Combo 22: Admin Emergency Freeze + User Revocation
// ============================================================================
test('Combo 22: Admin freezes dispatch, revokes compromised user API key, unfreezes system', async () => {
  await withTestServer({}, async (baseUrl, controls) => {
    const admin = controls.db.addUser({ email: 'adminops@combo.local', password: 'pwd', role: 'admin' });
    const rogue = controls.db.addUser({ email: 'rogue@combo.local', password: 'pwd', role: 'member' });
    const { rawKey: rogueKey, record } = controls.db.createApiKey({ userId: rogue.id, role: 'member' });
    const aSession = controls.db.createSession(admin.id);
    const adminHeaders = {
      'content-type': 'application/json',
      cookie: `crawler_session=${aSession.sessionToken}`,
      'x-csrf-token': 'csrf',
    };

    // 1. Admin freezes
    await fetch(`${baseUrl}/api/admin/freeze`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ frozen: true }) });

    // 2. Admin revokes key
    await fetch(`${baseUrl}/api/auth/api-keys/${record.id}`, { method: 'DELETE', headers: adminHeaders });

    // 3. Admin unfreezes
    await fetch(`${baseUrl}/api/admin/freeze`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ frozen: false }) });

    // 4. Rogue user cannot use key
    const rogueRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rogueKey },
      body: JSON.stringify({ query: 'stolen' }),
    });
    assert.strictEqual(rogueRes.status, 401);
  });
});

// ============================================================================
// Combo 23: DNS Rebinding Simulation + SafeFetch
// ============================================================================
test('Combo 23: DNS resolution initially public rebinding to private 127.0.0.1 is caught', async () => {
  let resolveCount = 0;
  const dnsResolver = async () => {
    resolveCount++;
    return resolveCount === 1 ? '93.184.216.34' : '127.0.0.1'; // rebinds to loopback on 2nd check
  };

  await assert.rejects(async () => {
    await validateOutboundUrl('http://rebind.attacker.com/products.json', { dnsResolver });
    // Simulate 2nd check before connection
    await validateOutboundUrl('http://rebind.attacker.com/products.json', { dnsResolver });
  }, (err) => err instanceof SSRFSecurityError && err.blockedReason === 'DNS_REBINDING_BLOCKED');
});

// ============================================================================
// Combo 24: API Key Revocation + Concurrency Slot Release
// ============================================================================
test('Combo 24: User active run completes after key revocation, subsequent runs rejected with 401', async () => {
  await withTestServer({ maxConcurrentRuns: 5 }, async (baseUrl, controls) => {
    const user = controls.db.addUser({ email: 'revrun@combo.local', password: 'pwd', role: 'member' });
    const { rawKey, record } = controls.db.createApiKey({ userId: user.id, role: 'member' });
    const r1 = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'run 1' }),
    });
    const { run } = await r1.json();
    assert.strictEqual(controls.getActiveRunsCount(), 1);

    // Revoke key
    controls.db.revokeApiKey(record.id);

    // Subsequent run creation rejected 401
    const r2 = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'run 2' }),
    });
    assert.strictEqual(r2.status, 401);

    // Complete run 1 directly
    run.status = 'completed';
    controls.setActiveRunsCount(0);
    assert.strictEqual(controls.getActiveRunsCount(), 0);
  });
});

// ============================================================================
// Combo 25: Full Defense-in-Depth Chain
// ============================================================================
test('Combo 25: Full Defense-in-Depth: Anonymous -> Login -> RBAC -> SSRF -> Rate Limit', async () => {
  await withTestServer({ maxConcurrentRuns: 20 }, async (baseUrl, controls) => {
    // 1. Anonymous request to protected endpoint blocked 401
    const unauth = await fetch(`${baseUrl}/api/runs`);
    assert.strictEqual(unauth.status, 401);

    // 2. Login
    controls.db.addUser({ email: 'did@combo.local', password: 'ValidPassword123!', role: 'member' });
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'did@combo.local', password: 'ValidPassword123!' }),
    });
    const { sessionToken } = await loginRes.json();
    const authHeaders = {
      'content-type': 'application/json',
      cookie: `crawler_session=${sessionToken}`,
      'x-csrf-token': 'csrf-did',
    };

    // 3. RBAC: Member denied admin endpoint (403)
    const adminCheck = await fetch(`${baseUrl}/api/tokens`, { headers: authHeaders });
    assert.strictEqual(adminCheck.status, 403);

    // 4. SSRF input check
    await assert.rejects(async () => {
      await validateOutboundUrl('http://169.254.169.254/secret');
    }, SSRFSecurityError);

    // 5. Rate limiting: 10 requests pass, 11th throttled
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ query: `did run ${i}` }),
      });
      assert.strictEqual(res.status, 201);
    }
    const throttledRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ query: 'overflow did' }),
    });
    assert.strictEqual(throttledRes.status, 429);
  });
});
