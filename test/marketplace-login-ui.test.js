const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createMarketplaceLoginManager } = require('../src/marketplaces/login-manager');

test('login manager keeps a browser session pending until the user confirms login', async () => {
  let completed = false;
  const manager = createMarketplaceLoginManager({
    openInteractiveLogin: async ({ platform }) => ({
      platform,
      complete: async () => { completed = true; return { cookies: [{ name: 'session', value: 'private' }], origins: [] }; },
      cancel: async () => {},
    }),
  });

  const pending = await manager.start({ platform: 'amazon' });
  assert.equal(pending.platform, 'amazon');
  assert.equal(pending.status, 'pending_login');
  assert.equal(completed, false);

  const result = await manager.complete(pending.id);
  assert.deepEqual(result.storageState, { cookies: [{ name: 'session', value: 'private' }], origins: [] });
  assert.equal(completed, true);
  assert.equal(manager.get(pending.id), null);
});

test('dashboard offers a browser-login action and confirmation action', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  assert.match(html, /onclick="startMarketplaceBrowserLogin\(\)"/);
  assert.match(html, /id="marketplace-login-confirm"/);
  assert.match(app, /async function startMarketplaceBrowserLogin/);
  assert.match(app, /async function confirmMarketplaceBrowserLogin/);
});
