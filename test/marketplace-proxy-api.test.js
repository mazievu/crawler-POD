const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { makeHermeticEnv, cleanupHermeticEnv } = require('./helpers/hermetic-spawn-env');

const port = 31988;
const baseUrl = `http://127.0.0.1:${port}`;
const encryptionKey = Buffer.alloc(32, 12).toString('base64');
let server;
let hermeticPaths;
let sessionCookie;

// /api/marketplace-proxies and /api/marketplace-accounts sit behind the
// requireAuth + admin-RBAC + CSRF barriers added on this branch (server.js).
// Log in once as the bootstrapped admin and attach the session cookie (plus
// the x-requested-with CSRF header on mutating verbs) to every request,
// instead of weakening the security middleware for this test.
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
      if ((await fetch(`${baseUrl}/livez`)).ok) return;
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
  const { env, paths } = makeHermeticEnv({
    PORT: String(port),
    CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    ADMIN_EMAIL: 'admin@system.local',
    ADMIN_PASSWORD: 'SuperAdminPassword123!',
  });
  hermeticPaths = paths;
  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
    stdio: 'ignore',
  });
  await waitForServer();
  sessionCookie = await login();
});

test.after(() => {
  server?.kill();
  cleanupHermeticEnv(hermeticPaths);
});

test('proxy API saves SOCKS5 credentials encrypted and assigns the profile to an account', async () => {
  const proxyResponse = await authedFetch('/api/marketplace-proxies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'Proxy E2E', host: 'proxy.example.test', port: 1080, username: 'user', password: 'secret',
    }),
  });
  const proxy = await proxyResponse.json();
  assert.equal(proxyResponse.status, 201);
  assert.equal(JSON.stringify(proxy).includes('secret'), false);

  const accountResponse = await authedFetch('/api/marketplace-accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'etsy', label: 'Proxy account E2E', storageState: JSON.stringify({ cookies: [{ name: 'session', value: 'private' }] }),
    }),
  });
  const account = await accountResponse.json();
  assert.equal(accountResponse.status, 201);

  const assignmentResponse = await authedFetch(`/api/marketplace-accounts/${account.id}/proxy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proxyId: proxy.id }),
  });
  const assigned = await assignmentResponse.json();
  assert.equal(assignmentResponse.status, 200);
  assert.equal(assigned.proxy_id, proxy.id);
  assert.equal(assigned.proxy_label, 'Proxy E2E');

  await authedFetch(`/api/marketplace-accounts/${account.id}`, { method: 'DELETE' });
  await authedFetch(`/api/marketplace-proxies/${proxy.id}`, { method: 'DELETE' });
});
