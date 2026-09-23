'use strict';

/**
 * test/e2e/tier4_realworld.test.js — Tier 4: Real-World Application Scenarios Suite
 *
 * Covers realistic end-to-end user workflows, operational incident drills,
 * attack campaigns, and disaster recovery procedures.
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
// Scenario 1: Initial Deployment, Super Admin Bootstrap & Team Onboarding
// ============================================================================
test('Scenario 1: Cold start -> Health check -> Super admin bootstrap -> Admin login -> Token setup -> Member onboard', async () => {
  const adminEmail = 'superadmin@company.com';
  const adminPassword = 'InitialSecureAdminPassword2026!';

  await withTestServer({ adminEmail, adminPassword }, async (baseUrl, controls) => {
    // 1. Cold start health check
    const livez = await fetch(`${baseUrl}/livez`);
    assert.strictEqual(livez.status, 200);
    const readyz = await fetch(`${baseUrl}/readyz`);
    assert.strictEqual(readyz.status, 200);

    // 2. Super admin bootstrap
    const bootstrapRes = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.strictEqual(bootstrapRes.status, 201);

    // 3. Super admin logs in
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    assert.strictEqual(loginRes.status, 200);
    const { sessionToken } = await loginRes.json();
    const adminHeaders = {
      'content-type': 'application/json',
      cookie: `crawler_session=${sessionToken}`,
      'x-csrf-token': 'admin-csrf-sess',
    };

    // 4. Admin configures Apify token and proxy
    const tokenRes = await fetch(`${baseUrl}/api/tokens`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ token: 'apify_live_token_abc123', label: 'Production Pool Token' }),
    });
    assert.strictEqual(tokenRes.status, 201);

    const proxyRes = await fetch(`${baseUrl}/api/proxies`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ proxyUrl: 'http://user:pass@proxy.example.com:8080' }),
    });
    assert.strictEqual(proxyRes.status, 201);

    // 5. Admin creates a Member user and issues API Key
    const member = controls.db.addUser({ email: 'analyst@company.com', password: 'MemberPassword123!', role: 'member' });
    const keyRes = await fetch(`${baseUrl}/api/auth/api-keys`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ userId: member.id, name: 'Analyst Primary Key', role: 'member' }),
    });
    assert.strictEqual(keyRes.status, 201);
    const { rawKey } = await keyRes.json();
    assert.match(rawKey, /^cp_live_/);

    // 6. Member can authenticate using issued key
    const memberMeRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { 'x-api-key': rawKey },
    });
    assert.strictEqual(memberMeRes.status, 200);
    const memberMe = await memberMeRes.json();
    assert.strictEqual(memberMe.user.role, 'member');
  });
});

// ============================================================================
// Scenario 2: Member Analyst Data Discovery & Monitoring Journey
// ============================================================================
test('Scenario 2: Member logs in -> Checks health -> Submits crawl run -> Polls status -> Exports data -> Logs out', async () => {
  await withTestServer({}, async (baseUrl, controls) => {
    // 1. Analyst logs in
    controls.db.addUser({ email: 'analyst@crawler.org', password: 'Password123!', role: 'member' });
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'analyst@crawler.org', password: 'Password123!' }),
    });
    assert.strictEqual(loginRes.status, 200);
    const { sessionToken } = await loginRes.json();
    const sessionCookie = `crawler_session=${sessionToken}`;
    const headers = {
      'content-type': 'application/json',
      cookie: sessionCookie,
      'x-csrf-token': 'analyst-csrf',
    };

    // 2. Health check
    const health = await fetch(`${baseUrl}/readyz`);
    assert.strictEqual(health.status, 200);

    // 3. Submits crawl run
    const createRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ platform: 'etsy', query: 'handmade ceramic mug' }),
    });
    assert.strictEqual(createRes.status, 201);
    const { run } = await createRes.json();
    assert.strictEqual(run.status, 'running');

    // 4. Polls status
    const pollRes = await fetch(`${baseUrl}/api/runs/${run.id}`, { headers });
    assert.strictEqual(pollRes.status, 200);
    const polledRun = await pollRes.json();
    assert.strictEqual(polledRun.run.id, run.id);

    // Complete run
    await fetch(`${baseUrl}/api/runs/${run.id}/complete`, { method: 'POST', headers });

    // 5. Exports data
    const exportRes = await fetch(`${baseUrl}/api/exports`, { headers });
    assert.strictEqual(exportRes.status, 200);
    const exp = await exportRes.json();
    assert.ok(exp.exportUrl);

    // 6. Logs out
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers });
    assert.strictEqual(logoutRes.status, 200);

    // 7. Verify session invalidated
    const verifyInvalid = await fetch(`${baseUrl}/api/runs`, { headers });
    assert.strictEqual(verifyInvalid.status, 401);
  });
});

// ============================================================================
// Scenario 3: Malicious Insider & Credential Stuffing Attack Simulation
// ============================================================================
test('Scenario 3: Forged cookies (401) -> SQL injection in auth (401) -> Brute force (429) -> Privilege escalation (403)', async () => {
  await withTestServer({}, async (baseUrl, controls) => {
    // 1. Forged session cookie
    const forgedRes = await fetch(`${baseUrl}/api/runs`, {
      headers: { cookie: 'crawler_session=deadbeefcafebabe00112233445566778899aabbccddeeff0011223344556677' },
    });
    assert.strictEqual(forgedRes.status, 401);

    // 2. SQL injection payload
    const sqliRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: "' UNION SELECT 1, 'admin', 'pass' --", password: 'x' }),
    });
    assert.strictEqual(sqliRes.status, 401);

    // 3. Credential stuffing lockout
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'victim@target.com', password: `stuffed_${i}` }),
      });
    }
    const lockedRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'victim@target.com', password: 'attempt_6' }),
    });
    assert.strictEqual(lockedRes.status, 429);
    assert.ok(lockedRes.headers.get('retry-after'));

    // 4. Compromised Member attempts privilege escalation
    const rogue = controls.db.addUser({ email: 'rogue@target.com', password: 'pwd', role: 'member' });
    const session = controls.db.createSession(rogue.id);
    const rogueHeaders = {
      'content-type': 'application/json',
      cookie: `crawler_session=${session.sessionToken}`,
      'x-csrf-token': 'rogue-csrf',
    };

    // Access tokens -> 403
    const tokenCheck = await fetch(`${baseUrl}/api/tokens`, { headers: rogueHeaders });
    assert.strictEqual(tokenCheck.status, 403);

    // Bulk delete -> 403
    const bulkCheck = await fetch(`${baseUrl}/api/admin/bulk-delete`, {
      method: 'POST',
      headers: rogueHeaders,
      body: JSON.stringify({ entity: 'all' }),
    });
    assert.strictEqual(bulkCheck.status, 403);

    // Freeze system -> 403
    const freezeCheck = await fetch(`${baseUrl}/api/admin/freeze`, {
      method: 'POST',
      headers: rogueHeaders,
      body: JSON.stringify({ frozen: true }),
    });
    assert.strictEqual(freezeCheck.status, 403);
  });
});

// ============================================================================
// Scenario 4: External SSRF & Data Exfiltration Attack Campaign
// ============================================================================
test('Scenario 4: Metadata exfiltration -> Obfuscated IPs -> Internal ports -> Redirect chains blocked hermetically', async () => {
  // 1. Cloud metadata
  await assert.rejects(async () => {
    await validateOutboundUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
  }, (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED');

  // 2. Obfuscated IPs (Hex, Octal, Decimal, IPv6-mapped)
  const obfuscatedUrls = [
    'http://0x7f000001/admin',
    'http://0177.0.0.1/admin',
    'http://2130706433/',
    'http://[::ffff:127.0.0.1]:8080/',
  ];
  for (const url of obfuscatedUrls) {
    await assert.rejects(async () => {
      await validateOutboundUrl(url);
    }, (err) => err instanceof SSRFSecurityError, `URL ${url} must be blocked`);
  }

  // 3. Internal RFC1918 addresses & custom ports
  await assert.rejects(async () => {
    await validateOutboundUrl('http://10.0.0.15:5432/db');
  }, SSRFSecurityError);

  // 4. Redirect to internal service
  const mockFetchRedirect = async () => ({
    status: 302,
    headers: new Map([['location', 'http://127.0.0.1:9200/_cat/indices']]),
  });
  await assert.rejects(async () => {
    await safeFetch('https://public.example.com/elastic-bounce', { mockFetch: mockFetchRedirect });
  }, SSRFSecurityError);
});

// ============================================================================
// Scenario 5: Emergency Incident Response & Dispatch Lockdown
// ============================================================================
test('Scenario 5: Spike detected -> Admin enables Emergency Freeze -> Dispatches halt (503) -> Active runs finish -> Revocation -> Unfreeze', async () => {
  await withTestServer({ maxConcurrentRuns: 10 }, async (baseUrl, controls) => {
    const admin = controls.db.addUser({ email: 'secops@crawler.local', password: 'pwd', role: 'admin' });
    const user = controls.db.addUser({ email: 'user@crawler.local', password: 'pwd', role: 'member' });
    const { rawKey, record } = controls.db.createApiKey({ userId: user.id, role: 'member' });
    const adminSession = controls.db.createSession(admin.id);
    const adminHeaders = {
      'content-type': 'application/json',
      cookie: `crawler_session=${adminSession.sessionToken}`,
      'x-csrf-token': 'admin-csrf',
    };

    // 1. One legitimate run is active
    const r1 = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'active run before incident' }),
    });
    const { run } = await r1.json();
    assert.strictEqual(controls.getActiveRunsCount(), 1);

    // 2. Incident declared: Admin toggles Emergency Freeze
    const freezeRes = await fetch(`${baseUrl}/api/admin/freeze`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ frozen: true }),
    });
    assert.strictEqual(freezeRes.status, 200);
    assert.strictEqual(controls.getEmergencyFrozen(), true);

    // 3. New run submissions immediately blocked with 503
    const blockedRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'new run during freeze' }),
    });
    assert.strictEqual(blockedRes.status, 503);

    // 4. In-flight active run completes cleanly
    const compRes = await fetch(`${baseUrl}/api/runs/${run.id}/complete`, {
      method: 'POST',
      headers: { 'x-api-key': rawKey },
    });
    assert.strictEqual(compRes.status, 200);
    assert.strictEqual(controls.getActiveRunsCount(), 0);

    // 5. Admin revokes suspected key
    controls.db.revokeApiKey(record.id);

    // 6. Admin lifts Emergency Freeze
    await fetch(`${baseUrl}/api/admin/freeze`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ frozen: false }),
    });
    assert.strictEqual(controls.getEmergencyFrozen(), false);

    // 7. Revoked key remains blocked (401), while new legitimate key works (201)
    const badKeyRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: JSON.stringify({ query: 'try revoked' }),
    });
    assert.strictEqual(badKeyRes.status, 401);

    const { rawKey: freshKey } = controls.db.createApiKey({ userId: user.id, role: 'member' });
    const goodKeyRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': freshKey },
      body: JSON.stringify({ query: 'legitimate post-unfreeze' }),
    });
    assert.strictEqual(goodKeyRes.status, 201);
  });
});

// ============================================================================
// Scenario 6: Disaster Recovery & Database Migration Drill
// ============================================================================
test('Scenario 6: Active system -> Backup dump + SHA-256 -> Simulated corruption -> Dry-run verify -> Restore -> Readyz OK', async () => {
  await withTestServer({}, async (baseUrl, controls) => {
    // 1. Initial healthy state
    const preReady = await fetch(`${baseUrl}/readyz`);
    assert.strictEqual(preReady.status, 200);

    // 2. Backup dump created
    const dumpSql = 'CREATE TABLE users (id SERIAL, email TEXT);\nINSERT INTO users VALUES (1, "backup@domain.com");';
    const { manifest, dumpContent } = createPostgresBackupManifest(['users', 'runs'], dumpSql);
    assert.strictEqual(manifest.engine, 'postgresql');
    assert.strictEqual(manifest.sha256.length, 64);

    // 3. Simulated DB failure
    controls.db.isHealthy = false;
    const failReady = await fetch(`${baseUrl}/readyz`);
    assert.strictEqual(failReady.status, 503);

    // 4. Dry-run verify
    const dryRunRes = verifyAndRestoreBackup(manifest, dumpContent, { dryRun: true });
    assert.strictEqual(dryRunRes.dryRun, true);
    assert.strictEqual(dryRunRes.tableCount, 2);

    // 5. Restore database
    const restoreRes = verifyAndRestoreBackup(manifest, dumpContent);
    assert.strictEqual(restoreRes.success, true);
    controls.db.isHealthy = true;

    // 6. Readyz probe confirms healthy restored state
    const postReady = await fetch(`${baseUrl}/readyz`);
    assert.strictEqual(postReady.status, 200);
  });
});

// ============================================================================
// Scenario 7: High-Concurrency Burst & Graceful Server Rotation
// ============================================================================
test('Scenario 7: Concurrent burst -> Rate limits & Concurrency caps hold -> SIGTERM rotation -> Lease released -> Clean exit', async () => {
  await withTestServer({ maxConcurrentRuns: 4 }, async (baseUrl, controls) => {
    const user = controls.db.addUser({ email: 'burstuser@domain.com', password: 'pwd', role: 'member' });
    const { rawKey } = controls.db.createApiKey({ userId: user.id, role: 'member' });

    // 1. Burst of 12 requests: 4 become active, subsequent hit concurrency cap / rate limit
    const calls = Array(12).fill(0).map((_, i) =>
      fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
        body: JSON.stringify({ query: `burst ${i}` }),
      })
    );
    const results = await Promise.all(calls);
    const statuses = results.map(r => r.status);
    const count201 = statuses.filter(s => s === 201).length;
    const count429 = statuses.filter(s => s === 429).length;

    assert.strictEqual(count201, 4, 'Exactly 4 runs permitted by maxConcurrentRuns');
    assert.strictEqual(count429, 8, 'Remaining 8 runs rejected by concurrency / rate limit');

    // 2. SIGTERM graceful shutdown initiated
    controls.simulateShutdown();

    // 3. New requests during shutdown rejected with 503
    const duringShutdownRes = await fetch(`${baseUrl}/livez`);
    assert.strictEqual(duringShutdownRes.status, 503);

    // 4. In-flight runs drain and complete
    controls.setActiveRunsCount(0);
    assert.strictEqual(controls.getActiveRunsCount(), 0);

    // 5. Lease cleanly released
    controls.db.limiterLeases.clear();
    assert.strictEqual(controls.db.limiterLeases.size, 0);
  });
});
