const test = require('node:test');
const assert = require('node:assert/strict');

const { collectInteractiveStorageState, openInteractiveLogin } = require('../src/marketplaces/session-login');

test('interactive marketplace login opens the correct home page and returns browser state', async () => {
  let visitedUrl;
  let browserClosed = false;
  const page = { goto: async (url) => { visitedUrl = url; } };
  const context = {
    newPage: async () => page,
    storageState: async () => ({ cookies: [{ name: 'session', value: 'private' }], origins: [] }),
    close: async () => {},
  };
  const browser = {
    newContext: async () => context,
    close: async () => { browserClosed = true; },
  };

  const state = await collectInteractiveStorageState({
    platform: 'ebay',
    browserFactory: async () => browser,
    waitForConfirmation: async () => {},
  });

  assert.equal(visitedUrl, 'https://www.ebay.com/');
  assert.deepEqual(state, { cookies: [{ name: 'session', value: 'private' }], origins: [] });
  assert.equal(browserClosed, true);
});

test('interactive login can use a supplied server browser factory without CDP', async () => {
  let visitedUrl;
  let pageClosed = false;
  const page = { goto: async (url) => { visitedUrl = url; }, close: async () => { pageClosed = true; } };
  const context = {
    newPage: async () => page,
    storageState: async () => ({ cookies: [], origins: [] }),
  };
  const browser = { newContext: async () => context, close: async () => {} };

  const login = await openInteractiveLogin({
    platform: 'etsy',
    browserFactory: async () => browser,
  });

  await login.complete();
  assert.equal(visitedUrl, 'https://www.etsy.com/');
  assert.equal(pageClosed, true);
});
