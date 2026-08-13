const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const port = 31987;
const baseUrl = `http://127.0.0.1:${port}`;
const encryptionKey = Buffer.alloc(32, 9).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY = encryptionKey;
const db = require('../src/database');
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

test('all Etsy variants are acknowledged as a background capture job', async () => {
  const response = await fetch(`${baseUrl}/api/html-captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'etsy', url: 'https://example.invalid/listing/1', variantMode: 'all', maxVariants: 1 }),
  });
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.job.status, 'running');

  await new Promise((resolve) => setTimeout(resolve, 25));
  const statusResponse = await fetch(`${baseUrl}/api/html-capture-jobs/${encodeURIComponent(body.job.id)}`);
  const status = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(status.status, 'failed');
  assert.match(status.error, /URL does not belong to etsy/);
});

test('capture API returns a successful saved capture instead of starting a browser again', async () => {
  const listingId = `${Date.now()}`.slice(-10);
  const saved = db.createMarketplaceCapture({
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

  const response = await fetch(`${baseUrl}/api/html-captures`, {
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

test('schedule run API returns the persisted history shown by the dashboard', async () => {
  const schedule = db.createMarketplaceCaptureSchedule({
    platform: 'etsy', keyword: `history-${Date.now()}`, scheduleType: 'once', runAt: '2099-12-31T23:45',
  });
  try {
    db.completeMarketplaceCaptureSchedule(schedule.id, { discovered: 30, captured: 24, blocked: 4, failed: 2 }, new Date('2099-12-31T16:46:00.000Z'));
    const response = await fetch(`${baseUrl}/api/marketplace-capture-schedules/${schedule.id}/runs`);
    const history = await response.json();
    assert.equal(response.status, 200);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].summary, { discovered: 30, captured: 24, blocked: 4, failed: 2 });
  } finally {
    db.deleteMarketplaceCaptureSchedule(schedule.id);
  }
});
