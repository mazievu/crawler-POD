'use strict';

/**
 * test/search-discovery-ssrf.test.js — imageFromProductPage must route through safeFetch.
 *
 * Product-page URLs come from search results (attacker-influenced), so they must be
 * validated per hop and never reach private/metadata addresses.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { imageFromProductPage } = require('../src/scrapers/search-discovery');

async function startServer(body) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.headers.host);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, hits, port: server.address().port };
}

async function stopServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

const OG_PAGE = '<html><head><meta property="og:image" content="https://cdn.example.com/p.jpg"></head></html>';

test('SD1: imageFromProductPage never touches the network for the cloud metadata address', async () => {
  const originalFetch = globalThis.fetch;
  let rawFetchCalls = 0;
  globalThis.fetch = async () => {
    rawFetchCalls++;
    throw new Error('raw fetch must not be used');
  };
  const started = Date.now();
  try {
    const image = await imageFromProductPage('http://169.254.169.254/latest/meta-data/');
    assert.equal(image, '');
    assert.equal(rawFetchCalls, 0);
    assert.ok(Date.now() - started < 2000, 'must be rejected up front, not after a connect timeout');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SD2: imageFromProductPage refuses a loopback product page (server never hit)', async () => {
  const { server, hits, port } = await startServer(OG_PAGE);
  try {
    const image = await imageFromProductPage(`http://127.0.0.1:${port}/listing/1`);
    assert.equal(image, '');
    assert.equal(hits.length, 0);
  } finally {
    await stopServer(server);
  }
});

test('SD3: imageFromProductPage still extracts og:image through the guarded fetch path', async () => {
  const { server, hits, port } = await startServer(OG_PAGE);
  try {
    const image = await imageFromProductPage(`http://shop.guard-test.example:${port}/listing/1`, {
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
      testOnly: { allowAddresses: ['127.0.0.1'] },
    });
    assert.equal(image, 'https://cdn.example.com/p.jpg');
    assert.deepEqual(hits, [`shop.guard-test.example:${port}`]);
  } finally {
    await stopServer(server);
  }
});
