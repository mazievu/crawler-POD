const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const port = 31988;
const baseUrl = `http://127.0.0.1:${port}`;
const encryptionKey = Buffer.alloc(32, 12).toString('base64');
let server;

async function waitForServer() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/platforms`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
}

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), CREDENTIAL_ENCRYPTION_KEY: encryptionKey, SKIP_DEPS: '1' },
    stdio: 'ignore',
  });
  await waitForServer();
});


test.after(() => server?.kill());

test('proxy API saves SOCKS5 credentials encrypted and assigns the profile to an account', async () => {
  const proxyResponse = await fetch(`${baseUrl}/api/marketplace-proxies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'Proxy E2E', host: 'proxy.example.test', port: 1080, username: 'user', password: 'secret',
    }),
  });
  const proxy = await proxyResponse.json();
  assert.equal(proxyResponse.status, 201);
  assert.equal(JSON.stringify(proxy).includes('secret'), false);

  const accountResponse = await fetch(`${baseUrl}/api/marketplace-accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'etsy', label: 'Proxy account E2E', storageState: JSON.stringify({ cookies: [{ name: 'session', value: 'private' }] }),
    }),
  });
  const account = await accountResponse.json();
  assert.equal(accountResponse.status, 201);

  const assignmentResponse = await fetch(`${baseUrl}/api/marketplace-accounts/${account.id}/proxy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proxyId: proxy.id }),
  });
  const assigned = await assignmentResponse.json();
  assert.equal(assignmentResponse.status, 200);
  assert.equal(assigned.proxy_id, proxy.id);
  assert.equal(assigned.proxy_label, 'Proxy E2E');

  await fetch(`${baseUrl}/api/marketplace-accounts/${account.id}`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/marketplace-proxies/${proxy.id}`, { method: 'DELETE' });
});
