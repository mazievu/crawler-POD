const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');

const { captureViaEverbeeHost, deriveEverbeeHostToken } = require('../src/marketplaces/everbee-host-client');

test('host executor request is authenticated and returns only captured HTML', async () => {
  let request;
  const html = '<html><head><title>Product</title></head><body>Captured product</body></html>';

  const result = await captureViaEverbeeHost({
    platform: 'etsy',
    url: 'https://www.etsy.com/listing/1773159286/example',
    accountId: 1,
    storageState: { cookies: [{ name: 'session', value: 'private' }], origins: [] },
    proxy: 'socks5://user:secret@proxy.example.test:1080',
    executorUrl: 'http://127.0.0.1:9333',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ html, finalUrl: 'https://www.etsy.com/listing/1773159286/example' }), { status: 200 });
    },
  });

  assert.equal(request.url, 'http://127.0.0.1:9333/v1/captures');
  assert.equal(request.options.headers['x-everbee-executor-token'], deriveEverbeeHostToken());
  assert.equal(JSON.parse(request.options.body).storageState.cookies[0].value, 'private');
  assert.deepEqual(result, { html, finalUrl: 'https://www.etsy.com/listing/1773159286/example', browserMode: 'everbee_host' });
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
