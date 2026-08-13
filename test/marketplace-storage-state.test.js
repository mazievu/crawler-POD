const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeBrowserStorageState } = require('../src/marketplaces/storage-state');

test('wraps one exported Etsy cookie as a Playwright storage state', () => {
  const state = normalizeBrowserStorageState('etsy', JSON.stringify({
    name: 'etsy_session', value: 'private', domain: '.etsy.com', path: '/', secure: true,
  }));

  assert.deepEqual(state, {
    cookies: [{ name: 'etsy_session', value: 'private', domain: '.etsy.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }],
    origins: [],
  });
});

test('accepts a cookie header and assigns the selected marketplace domain', () => {
  const state = normalizeBrowserStorageState('etsy', 'sessionid=private; currency=USD');

  assert.deepEqual(state.cookies.map(({ name, value, domain }) => ({ name, value, domain })), [
    { name: 'sessionid', value: 'private', domain: '.etsy.com' },
    { name: 'currency', value: 'USD', domain: '.etsy.com' },
  ]);
});

test('rejects a cookie with no name or value', () => {
  assert.throws(() => normalizeBrowserStorageState('amazon', '{}'), /cookie/i);
});
