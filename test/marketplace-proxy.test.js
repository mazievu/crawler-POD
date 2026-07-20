const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSocks5ProxyUrl, validateSocks5Proxy } = require('../src/marketplaces/proxy');
const { createEverbeeContextSession } = require('../src/marketplaces/everbee-executor');

test('a SOCKS5 proxy URL safely encodes account credentials', () => {
  const proxy = validateSocks5Proxy({
    label: 'US residential',
    host: 'proxy.example.test',
    port: 1080,
    username: 'team+one',
    password: 'p@ss word',
  });

  assert.equal(buildSocks5ProxyUrl(proxy), 'socks5://team%2Bone:p%40ss%20word@proxy.example.test:1080');
});

test('Everbee receives an account proxy only at browser launch time', async () => {
  let launchOptions;
  const context = { close: async () => {} };

  const session = await createEverbeeContextSession({
    platform: 'etsy',
    accountId: 9,
    proxy: 'socks5://user:secret@proxy.example.test:1080',
    launchPersistentContext: async (options) => {
      launchOptions = options;
      return context;
    },
  });

  assert.equal(launchOptions.proxy, 'socks5://user:secret@proxy.example.test:1080');
  await session.close();
});
