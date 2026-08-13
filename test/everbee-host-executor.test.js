const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');

const { captureViaEverbeeHost, discoverMarketplaceListingsViaEverbeeHost, deriveEverbeeHostToken } = require('../src/marketplaces/everbee-host-client');
const fs = require('node:fs');
const path = require('node:path');

test('host executor request is authenticated and returns only captured HTML', async () => {
  let request;
  const html = '<html><head><title>Product</title></head><body>Captured product</body></html>';

  const result = await captureViaEverbeeHost({
    platform: 'etsy',
    url: 'https://www.etsy.com/listing/1773159286/example',
    accountId: 1,
    storageState: { cookies: [{ name: 'session', value: 'private' }], origins: [] },
    proxy: 'socks5://user:secret@proxy.example.test:1080',
    variantMode: 'all',
    maxVariants: 10,
    executorUrl: 'http://127.0.0.1:9333',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ html, finalUrl: 'https://www.etsy.com/listing/1773159286/example' }), { status: 200 });
    },
  });

  assert.equal(request.url, 'http://127.0.0.1:9333/v1/captures');
  assert.equal(request.options.headers['x-everbee-executor-token'], deriveEverbeeHostToken());
  assert.equal(JSON.parse(request.options.body).storageState.cookies[0].value, 'private');
  assert.equal(JSON.parse(request.options.body).variantMode, 'all');
  assert.deepEqual(result, { html, finalUrl: 'https://www.etsy.com/listing/1773159286/example', browserMode: 'everbee_host', variants: [], variantMeta: null });
});

test('host executor rejects a malformed response without exposing request credentials', async () => {
  await assert.rejects(
    captureViaEverbeeHost({
      platform: 'etsy', url: 'https://www.etsy.com/listing/1773159286/example', executorUrl: 'http://127.0.0.1:9333',
      fetchImpl: async () => new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502 }),
    }),
    /Everbee host executor failed: bad gateway/,
  );
});

test('host executor limits Etsy selection to listing variation controls, not locale selects', () => {
  const executorSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'everbee-host-executor.mjs'), 'utf8');
  assert.match(executorSource, /variation-selector-/);
});

test('host executor can discover Etsy listing URLs using the saved browser profile', async () => {
  let request;
  const result = await discoverMarketplaceListingsViaEverbeeHost({
    platform: 'etsy', keyword: 'press on nails', accountId: 2,
    storageState: { cookies: [{ name: 'session', value: 'private' }], origins: [] },
    proxy: 'socks5://proxy.example.test:1080', limit: 30,
    executorUrl: 'http://127.0.0.1:9333',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ items: [{ url: 'https://www.etsy.com/listing/1773159286/example', title: 'Example' }] }), { status: 200 });
    },
  });

  assert.equal(request.url, 'http://127.0.0.1:9333/v1/discoveries');
  assert.equal(JSON.parse(request.options.body).keyword, 'press on nails');
  assert.equal(JSON.parse(request.options.body).accountId, 2);
  assert.deepEqual(result.items, [{ url: 'https://www.etsy.com/listing/1773159286/example', title: 'Example' }]);
});

test('host executor exposes the CloakBrowser Etsy discovery endpoint', () => {
  const executorSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'everbee-host-executor.mjs'), 'utf8');
  assert.match(executorSource, /\/v1\/discoveries/);
  assert.match(executorSource, /https:\/\/www\.etsy\.com\/search\?q=/);
});

test('CloakBrowser discovery validates the keyword and reports safe host failures', async () => {
  await assert.rejects(
    discoverMarketplaceListingsViaEverbeeHost({ platform: 'amazon', keyword: 'nails', executorUrl: 'http://127.0.0.1:9333' }),
    /Etsy only/,
  );
  await assert.rejects(
    discoverMarketplaceListingsViaEverbeeHost({ platform: 'etsy', keyword: '', executorUrl: 'http://127.0.0.1:9333' }),
    /Keyword/,
  );
  await assert.rejects(
    discoverMarketplaceListingsViaEverbeeHost({
      platform: 'etsy', keyword: 'nails', executorUrl: 'http://127.0.0.1:9333',
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Etsy search returned no listing results' }), { status: 400 }),
    }),
    /Everbee host discovery failed: Etsy search returned no listing results/,
  );
  await assert.rejects(
    discoverMarketplaceListingsViaEverbeeHost({
      platform: 'etsy', keyword: 'nails', executorUrl: 'http://127.0.0.1:9333',
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
    }),
    /returned no listing data/,
  );
});
