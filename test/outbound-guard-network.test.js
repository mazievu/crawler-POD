'use strict';

/**
 * test/outbound-guard-network.test.js — real-socket tests for connect-time SSRF pinning.
 *
 * These tests start local HTTP/HTTPS servers on 127.0.0.1 and drive safeFetch through
 * its real (undici) network path. The DNS answer is injected via the `dnsLookup` seam,
 * so a public-looking hostname can be "rebound" to loopback between the pre-flight check
 * and the socket connect. Reaching loopback deliberately (positive controls) requires the
 * `testOnly.allowAddresses` escape hatch, which is only honoured when NODE_ENV === 'test'.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { SSRFSecurityError, safeFetch } = require('../src/security/outbound-guard');

const PUBLIC_ANSWER = [{ address: '93.184.216.34', family: 4 }];
const LOOPBACK_ANSWER = [{ address: '127.0.0.1', family: 4 }];
const TLS_DIR = path.join(__dirname, 'fixtures', 'tls');
const TEST_CERT = fs.readFileSync(path.join(TLS_DIR, 'test-only-sni.crt'));
const TEST_KEY = fs.readFileSync(path.join(TLS_DIR, 'test-only-sni.key'));

function recordingHandler(hits, respond) {
  return (req, res) => {
    hits.push({
      host: req.headers.host,
      probe: req.headers['x-probe'],
      servername: req.socket.servername,
      url: req.url,
    });
    respond(req, res);
  };
}

function okResponder(req, res) {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}

async function startServer(respond = okResponder, tls = null) {
  const hits = [];
  const handler = recordingHandler(hits, respond);
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, hits, port: server.address().port };
}

async function stopServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

/** DNS seam that returns each answer in turn (last answer repeats). */
function sequencedLookup(...answers) {
  const calls = [];
  const lookup = async (hostname) => {
    calls.push(hostname);
    return answers[Math.min(calls.length - 1, answers.length - 1)];
  };
  return { lookup, calls };
}

function isSsrf(reason) {
  return (err) => err instanceof SSRFSecurityError && err.blockedReason === reason;
}

test('OGN1: DNS rebinding (public at pre-flight, 127.0.0.1 at connect) is rejected and never reaches the server', async () => {
  const { server, hits, port } = await startServer();
  const dns = sequencedLookup(PUBLIC_ANSWER, LOOPBACK_ANSWER);
  try {
    await assert.rejects(
      () => safeFetch(`http://rebind.guard-test.example:${port}/secret`, { dnsLookup: dns.lookup }),
      isSsrf('DNS_REBINDING_BLOCKED')
    );
    assert.equal(hits.length, 0, 'loopback server must never be hit');
    assert.ok(dns.calls.length >= 2, 'connect-time lookup must run after the pre-flight lookup');
  } finally {
    await stopServer(server);
  }
});

test('OGN2: connect-time answer mixing public and private addresses is rejected (every address validated)', async () => {
  const { server, hits, port } = await startServer();
  const mixed = [...PUBLIC_ANSWER, ...LOOPBACK_ANSWER];
  const dns = sequencedLookup(PUBLIC_ANSWER, mixed);
  try {
    await assert.rejects(
      () => safeFetch(`http://mixed.guard-test.example:${port}/`, { dnsLookup: dns.lookup }),
      isSsrf('DNS_REBINDING_BLOCKED')
    );
    assert.equal(hits.length, 0);
  } finally {
    await stopServer(server);
  }
});

test('OGN3: connect-time rebinding to IPv6 loopback / IPv4-compatible loopback is rejected', async () => {
  for (const address of ['::1', '::7f00:1']) {
    const dns = sequencedLookup(PUBLIC_ANSWER, [{ address, family: 6 }]);
    await assert.rejects(
      () => safeFetch('http://v6rebind.guard-test.example:8081/', { dnsLookup: dns.lookup }),
      isSsrf('DNS_REBINDING_BLOCKED'),
      address
    );
  }
});

test('OGN4: positive control — allow-listed loopback is reached with original Host and caller headers intact', async () => {
  const { server, hits, port } = await startServer();
  try {
    const res = await safeFetch(`http://allowed.guard-test.example:${port}/ping`, {
      dnsLookup: async () => LOOPBACK_ANSWER,
      testOnly: { allowAddresses: ['127.0.0.1'] },
      headers: new Headers({ 'X-Probe': 'kept' }),
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].host, `allowed.guard-test.example:${port}`);
    assert.equal(hits[0].probe, 'kept');
  } finally {
    await stopServer(server);
  }
});

test('OGN5: testOnly allow-list is refused outside NODE_ENV=test', async () => {
  const { server, hits, port } = await startServer();
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      () => safeFetch(`http://allowed.guard-test.example:${port}/`, {
        dnsLookup: async () => LOOPBACK_ANSWER,
        testOnly: { allowAddresses: ['127.0.0.1'] },
      }),
      /testOnly/
    );
    assert.equal(hits.length, 0);
  } finally {
    process.env.NODE_ENV = 'test';
    await stopServer(server);
  }
});

test('OGN6: HTTPS keeps SNI and Host equal to the original hostname and validates the certificate', async () => {
  const { server, hits, port } = await startServer(okResponder, { key: TEST_KEY, cert: TEST_CERT });
  try {
    const res = await safeFetch(`https://sni.guard-test.example:${port}/secure`, {
      dnsLookup: async () => LOOPBACK_ANSWER,
      testOnly: { allowAddresses: ['127.0.0.1'], ca: TEST_CERT },
    });
    assert.equal(res.status, 200);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].servername, 'sni.guard-test.example');
    assert.equal(hits[0].host, `sni.guard-test.example:${port}`);
  } finally {
    await stopServer(server);
  }
});

test('OGN7: HTTPS against an untrusted certificate still fails (verification is not disabled)', async () => {
  const { server, hits, port } = await startServer(okResponder, { key: TEST_KEY, cert: TEST_CERT });
  try {
    await assert.rejects(() => safeFetch(`https://sni.guard-test.example:${port}/`, {
      dnsLookup: async () => LOOPBACK_ANSWER,
      testOnly: { allowAddresses: ['127.0.0.1'] },
    }));
    assert.equal(hits.length, 0);
  } finally {
    await stopServer(server);
  }
});

test('OGN8: real redirects are followed hop-by-hop and each hop is re-validated', async () => {
  const { server, hits, port } = await startServer((req, res) => {
    const targets = {
      '/to-metadata': 'http://169.254.169.254/latest/meta-data/',
      '/to-next': `http://next.guard-test.example:${port}/final`,
    };
    if (targets[req.url]) {
      res.writeHead(302, { location: targets[req.url] });
      res.end();
      return;
    }
    okResponder(req, res);
  });
  const options = { dnsLookup: async () => LOOPBACK_ANSWER, testOnly: { allowAddresses: ['127.0.0.1'] } };
  try {
    await assert.rejects(
      () => safeFetch(`http://start.guard-test.example:${port}/to-metadata`, options),
      isSsrf('CLOUD_METADATA_BLOCKED')
    );
    const res = await safeFetch(`http://start.guard-test.example:${port}/to-next`, options);
    assert.equal(res.status, 200);
    assert.deepEqual(hits.map(h => h.host), [
      `start.guard-test.example:${port}`,
      `start.guard-test.example:${port}`,
      `next.guard-test.example:${port}`,
    ]);
  } finally {
    await stopServer(server);
  }
});
