const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSocks5ProxyUrl, proxyMetadata, validateSocks5Proxy } = require('../src/marketplaces/proxy');
const { createEverbeeContextSession } = require('../src/marketplaces/everbee-executor');
const { captureMarketplaceHtml } = require('../src/marketplaces/html-capture');

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

test('a SOCKS5 proxy rejects partial credentials', () => {
  assert.throws(() => validateSocks5Proxy({ label: 'Broken proxy', host: 'proxy.example.test', port: 1080, username: 'user' }), /together/);
});

test('proxy metadata never contains credentials', () => {
  const metadata = proxyMetadata({
    id: 3, label: 'US proxy', protocol: 'socks5', host: 'proxy.example.test', port: 1080,
    username: 'user', password: 'secret', created_at: 'now', updated_at: 'now',
  });

  assert.equal(JSON.stringify(metadata).includes('secret'), false);
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

test('capture forwards the account proxy to its browser factory', async () => {
  let receivedProxy;
  const page = {
    goto: async () => {},
    content: async () => '<script type="application/ld+json">{"@type":"Product","name":"Proxy product"}</script>',
    close: async () => {},
  };
  const context = { newPage: async () => page, close: async () => {} };

  await captureMarketplaceHtml({
    platform: 'etsy',
    url: 'https://www.etsy.com/listing/1773159286/proxy-product',
    proxy: 'socks5://user:secret@proxy.example.test:1080',
    browserFactory: async ({ proxy }) => {
      receivedProxy = proxy;
      return { context, mode: 'everbee', close: async () => context.close() };
    },
  });

  assert.equal(receivedProxy, 'socks5://user:secret@proxy.example.test:1080');
});
