const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveCdpUrl } = require('../src/marketplaces/cdp-url');

test('resolves Docker host aliases to an IP so Chrome accepts the CDP Host header', async () => {
  const url = await resolveCdpUrl('http://host.docker.internal:9222', async () => ({ address: '192.168.65.254', family: 4 }));
  assert.equal(url, 'http://192.168.65.254:9222/');
});

test('keeps an IP CDP address unchanged', async () => {
  const url = await resolveCdpUrl('http://127.0.0.1:9222');
  assert.equal(url, 'http://127.0.0.1:9222/');
});
