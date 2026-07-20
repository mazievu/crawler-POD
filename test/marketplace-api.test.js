const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const port = 31987;
const baseUrl = `http://127.0.0.1:${port}`;
const encryptionKey = Buffer.alloc(32, 9).toString('base64');
let server;

async function waitForServer() {
  const deadline = Date.now() + 10000;
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
    env: { ...process.env, PORT: String(port), CREDENTIAL_ENCRYPTION_KEY: encryptionKey },
    stdio: 'ignore',
  });
  await waitForServer();
});

test.after(() => server?.kill());

test('account API saves a marketplace session without returning the secret', async () => {
  const response = await fetch(`${baseUrl}/api/marketplace-accounts`, {
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

  const listedResponse = await fetch(`${baseUrl}/api/marketplace-accounts?platform=etsy`);
  const accounts = await listedResponse.json();
  assert.equal(listedResponse.status, 200);
  assert.equal(accounts.some((candidate) => candidate.id === account.id && !Object.hasOwn(candidate, 'storageState')), true);

  const deletedResponse = await fetch(`${baseUrl}/api/marketplace-accounts/${account.id}`, { method: 'DELETE' });
  assert.deepEqual(await deletedResponse.json(), { success: true });
});
