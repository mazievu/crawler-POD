const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * These tests seed data through the in-process `db` module and then assert on
 * it through a SEPARATELY SPAWNED server.js — so the two processes must share
 * one database.
 *
 * Under SQLite they shared the data/collector.db file. PostgreSQL supports this
 * too, via a server both processes connect to. PGlite does not: it is an
 * in-process engine, and two processes pointed at the same PGLITE_DIR each get
 * their own isolated state (verified: a run created by one is invisible to the
 * other). So on PGlite these two cross-process tests cannot pass for reasons
 * unrelated to the code under test, and are skipped with the reason stated
 * rather than weakened. Point PGHOST/PGPORT or DATABASE_URL at a real
 * PostgreSQL server and they run normally.
 */
const NEEDS_SHARED_SERVER = (process.env.PG_MODE || '').toLowerCase() === 'pglite';
const crossProcessTest = NEEDS_SHARED_SERVER
  ? (name, fn) => test.skip(`${name} [needs a shared PostgreSQL server; PGlite is per-process]`, fn)
  : test;

const port = 31987;
const baseUrl = `http://127.0.0.1:${port}`;
const encryptionKey = Buffer.alloc(32, 9).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY = encryptionKey;
const db = require('../src/database');
let server;
let hermeticPaths;
let sessionCookie;

// All /api routes now sit behind the auth barrier added on this branch
// (server.js: `app.use(['/api', '/admin', '/admindashboard'], requireAuth)`),
// and /api/marketplace-accounts et al. are admin-only routes; mutating verbs
// additionally require the CSRF header apiFetch() sends in the real client
// (`x-requested-with: XMLHttpRequest`). Log in once as the bootstrapped
// admin and reuse the session cookie for every request below instead of
// weakening the security middleware.
function authedFetch(pathAndQuery, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}), Cookie: sessionCookie };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['x-requested-with'] = 'XMLHttpRequest';
  }
  return fetch(`${baseUrl}${pathAndQuery}`, { ...options, headers });
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/livez`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
}

async function login() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@system.local', password: 'SuperAdminPassword123!' }),
  });
  assert.equal(response.status, 200, `login must succeed: ${await response.text()}`);
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie && setCookie.match(/crawler_session=([a-f0-9]{64})/);
  assert.ok(match, `login response must set a session cookie, got: ${setCookie}`);
  return `crawler_session=${match[1]}`;
}

test.before(async () => {
  // NOTE: unlike the pglite-based spawn tests elsewhere, this file
  // deliberately shares the *real* Postgres connection (PGHOST/PGPORT/...)
  // between this process's `db` module and the spawned server.js — that's
  // what lets the cross-process tests below see rows created by either
  // side (see the file banner). So PG_MODE/PGHOST must be inherited from
  // process.env as-is, not forced into pglite. Only the Apify token pool
  // and social-bot config files are redirected to a temp location, so this
  // spawn never writes into the repo's real data/ directory.
  const runId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  hermeticPaths = {
    apifyTokensPath: path.join(os.tmpdir(), `crawler-pod-marketplace-api-apify-tokens-${runId}.json`),
    socialBotsPath: path.join(os.tmpdir(), `crawler-pod-marketplace-api-social-bots-${runId}.json`),
    capturesDir: path.join(os.tmpdir(), `crawler-pod-marketplace-api-captures-${runId}`),
    everbeeProfileRoot: path.join(os.tmpdir(), `crawler-pod-marketplace-api-everbee-${runId}`),
  };
  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
      ADMIN_EMAIL: 'admin@system.local',
      ADMIN_PASSWORD: 'SuperAdminPassword123!',
      APIFY_TOKENS_PATH: hermeticPaths.apifyTokensPath,
      SOCIAL_BOTS_CONFIG_PATH: hermeticPaths.socialBotsPath,
      CAPTURES_DIR: hermeticPaths.capturesDir,
      EVERBEE_PROFILE_ROOT: hermeticPaths.everbeeProfileRoot,
    },
    stdio: 'ignore',
  });
  await waitForServer();
  sessionCookie = await login();
});

test.after(async () => {
  if (server) {
    server.kill('SIGKILL');
  }
  for (const target of Object.values(hermeticPaths || {})) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
  await db._connection.close();
});

test('account API saves a marketplace session without returning the secret', async () => {
  const response = await authedFetch('/api/marketplace-accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'etsy',
      label: 'E2E account',
      storageState: JSON.stringify({ cookies: [{ name: 'session', value: 'private' }], origins: [] }),
    }),
  });
  const account = await response.json();
  assert.equal(response.status, 201);
  assert.equal(account.platform, 'etsy');
  assert.equal(account.label, 'E2E account');
  assert.equal(JSON.stringify(account).includes('private'), false);

  const listedResponse = await authedFetch('/api/marketplace-accounts?platform=etsy');
  const accounts = await listedResponse.json();
  assert.equal(listedResponse.status, 200);
  assert.equal(accounts.some((candidate) => candidate.id === account.id && !Object.hasOwn(candidate, 'storageState')), true);

  const deletedResponse = await authedFetch(`/api/marketplace-accounts/${account.id}`, { method: 'DELETE' });
  assert.deepEqual(await deletedResponse.json(), { success: true });
});

test('all Etsy variants are acknowledged as a background capture job', async () => {
  const response = await authedFetch('/api/html-captures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Uses a real, resolvable-but-harmless domain rather than the
    // RFC 2606 `.invalid` TLD: the outbound SSRF guard (src/security/
    // outbound-guard.js) now runs a DNS pre-check on every submitted URL
    // before this handler ever reaches the platform-ownership validation
    // this test is exercising, and a non-resolving hostname is rejected as
    // SSRF_BLOCKED/DNS_RESOLUTION_FAILED before that. example.com always
    // resolves and is never actually fetched — assertMarketplaceUrl()
    // (src/marketplaces/validation.js) rejects it on the hostname regex
    // alone, with no network call involved.
    body: JSON.stringify({ platform: 'etsy', url: 'https://example.com/listing/1', variantMode: 'all', maxVariants: 1 }),
  });
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.job.status, 'running');

  // The capture now goes through the shared Resource Scheduler (Simplification
  // Round #8: no crawler workload bypasses admission control), so it is no
  // longer synchronous — poll instead of assuming a fixed short delay.
  let status;
  const deadline = Date.now() + 10000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const statusResponse = await authedFetch(`/api/html-capture-jobs/${encodeURIComponent(body.job.id)}`);
    assert.equal(statusResponse.status, 200);
    status = await statusResponse.json();
  } while (status.status === 'running' && Date.now() < deadline);

  assert.equal(status.status, 'failed');
  assert.match(status.error, /URL does not belong to etsy/);
});

crossProcessTest('capture API returns a successful saved capture instead of starting a browser again', async () => {
  const listingId = `${Date.now()}`.slice(-10);
  const saved = await db.createMarketplaceCapture({
    platform: 'etsy',
    url: `https://www.etsy.com/listing/${listingId}/saved-product`,
    html: '<html><title>Saved product</title></html>',
    parsedData: {
      metrics: { title: 'Saved product', price: 123, currency: 'USD' },
      capture: { status: 'ok', browserMode: 'everbee' },
      variants: [],
    },
    variantMode: 'base',
  });

  const response = await authedFetch('/api/html-captures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'etsy', url: `https://www.etsy.com/listing/${listingId}/saved-product?utm_source=test`, variantMode: 'base' }),
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.cached, true);
  assert.equal(body.capture.id, saved.id);
  assert.equal(body.metrics.title, 'Saved product');
});

crossProcessTest('schedule run API returns the persisted history shown by the dashboard', async () => {
  const schedule = await db.createMarketplaceCaptureSchedule({
    platform: 'etsy', keyword: `history-${Date.now()}`, scheduleType: 'once', runAt: '2099-12-31T23:45',
  });
  try {
    await db.completeMarketplaceCaptureSchedule(schedule.id, { discovered: 30, captured: 24, blocked: 4, failed: 2 }, new Date('2099-12-31T16:46:00.000Z'));
    const response = await authedFetch(`/api/marketplace-capture-schedules/${schedule.id}/runs`);
    const history = await response.json();
    assert.equal(response.status, 200);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].summary, { discovered: 30, captured: 24, blocked: 4, failed: 2 });
  } finally {
    await db.deleteMarketplaceCaptureSchedule(schedule.id);
  }
});
