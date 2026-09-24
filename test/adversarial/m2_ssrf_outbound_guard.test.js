'use strict';

/**
 * test/adversarial/m2_ssrf_outbound_guard.test.js — Challenger 2 Adversarial Stress Suite
 *
 * Milestone M2 (Outbound Guard & SSRF Adversarial Challenge):
 * 1. Cloud metadata targets (169.254.169.254, metadata.google.internal, ::ffff:169.254.169.254, hex, octal, DWORD)
 * 2. Obfuscated IP formats (hex 0x7f.1, octal 0177.0.0.1, decimal DWORD 2130706433, mixed formats, IPv4-mapped IPv6)
 * 3. Open redirect chains (public -> internal IP, public -> metadata, multi-hop chains, scheme downgrade)
 * 4. DNS Rebinding (domains resolving to multiple IPs: public + private/metadata/IPv6, TOCTOU rebinding)
 * 5. Stream size exhaustion (mock HTTP server streaming infinite bytes to safeFetch and media-cache)
 * 6. Ingress CORS bypass and CSRF forgery on state-changing endpoints (live server verification)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const dns = require('node:dns/promises');
const { makeHermeticEnv, cleanupHermeticEnv } = require('../helpers/hermetic-spawn-env');

const {
  SSRFSecurityError,
  validateOutboundUrl,
  safeFetch,
  parseAndNormalizeIp,
  isPrivateIp,
} = require('../../src/security/outbound-guard');

// ============================================================================
// SUITE 1: Cloud Metadata Defense Stress Testing
// ============================================================================

test('ADV-M2-1.1: Blocks standard and alternative cloud metadata hostnames', async () => {
  const metadataTargets = [
    'http://169.254.169.254',
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.169.254:80/latest/user-data',
    'https://169.254.169.254/computeMetadata/v1/',
    'http://metadata.google.internal',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.goog',
    'http://instance-data',
    'http://instance-data/latest/meta-data/',
    'http://100.100.100.200', // Alibaba Cloud metadata
    'http://100.100.100.200/latest/meta-data/',
  ];

  for (const url of metadataTargets) {
    await assert.rejects(
      async () => validateOutboundUrl(url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError, `Expected SSRFSecurityError for ${url}`);
        assert.equal(err.blockedReason, 'CLOUD_METADATA_BLOCKED', `Expected CLOUD_METADATA_BLOCKED for ${url}`);
        return true;
      }
    );
  }
});

test('ADV-M2-1.2: Blocks obfuscated representations of cloud metadata IP (169.254.169.254)', async () => {
  const obfuscatedMetadata = [
    { url: 'http://2852039166/latest/meta-data/', desc: 'Decimal DWORD (2852039166)' },
    { url: 'http://0xa9fea9fe/latest/meta-data/', desc: 'Single Hex (0xa9fea9fe)' },
    { url: 'http://0xa9.0xfe.0xa9.0xfe/latest/meta-data/', desc: 'Dotted Hex' },
    { url: 'http://0251.0376.0251.0376/latest/meta-data/', desc: 'Dotted Octal' },
    { url: 'http://[::ffff:169.254.169.254]/latest/meta-data/', desc: 'IPv4-mapped IPv6 dotted' },
    { url: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/', desc: 'IPv4-mapped IPv6 hex' },
    { url: 'http://[0:0:0:0:0:ffff:169.254.169.254]/latest/meta-data/', desc: 'Full-form IPv4-mapped IPv6' },
    { url: 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data/', desc: 'Full-form IPv4-mapped IPv6 hex' },
  ];

  for (const item of obfuscatedMetadata) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError, `Expected SSRFSecurityError for ${item.desc}`);
        assert.equal(err.blockedReason, 'CLOUD_METADATA_BLOCKED', `Expected CLOUD_METADATA_BLOCKED for ${item.desc}`);
        return true;
      }
    );
  }
});

test('ADV-M2-1.3: Blocks DNS resolution returning cloud metadata (IPv4, mapped IPv6, hex, DWORD)', async () => {
  const metadataResolutions = [
    '169.254.169.254',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '2852039166',
    '0xa9fea9fe',
    '100.100.100.200',
  ];

  for (const resolvedIp of metadataResolutions) {
    await assert.rejects(
      async () => validateOutboundUrl('http://attacker-controlled-metadata.com/leak', {
        dnsResolver: async () => resolvedIp,
      }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, 'CLOUD_METADATA_BLOCKED');
        return true;
      }
    );
  }
});

test('ADV-M2-1.4: Blocks cloud metadata in Shopify, Web Reader, and Media Cache scrapers', async () => {
  const shopify = require('../../src/scrapers/shopify');
  const webReader = require('../../src/scrapers/web-reader');
  const mediaCache = require('../../src/media-cache');

  // 1. Shopify
  await assert.rejects(
    async () => shopify.fetchProductsJson('169.254.169.254', 10),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED'
  );
  await assert.rejects(
    async () => shopify.scrape('http://[::ffff:169.254.169.254]/products.json'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED'
  );

  // 2. Web Reader
  await assert.rejects(
    async () => webReader.readPublicWebPage('http://169.254.169.254/latest/meta-data'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED'
  );
  await assert.rejects(
    async () => webReader.readPublicWebPage('https://example.com', { readerBase: 'http://169.254.169.254/' }),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED'
  );

  // 3. Media Cache
  const fakeLog = { warn: () => {} };
  mediaCache.EPHEMERAL_IMAGE_HOSTS.add('169.254.169.254');
  try {
    const summary = await mediaCache.persistEphemeralImages([{ image: 'http://169.254.169.254/key.png' }], { log: fakeLog });
    assert.equal(summary.failed, 1);
    assert.equal(summary.cached, 0);
  } finally {
    mediaCache.EPHEMERAL_IMAGE_HOSTS.delete('169.254.169.254');
  }
});

// ============================================================================
// SUITE 2: Obfuscated IP Formats & Representation Bypasses
// ============================================================================

test('ADV-M2-2.1: Blocks Hex IP formats (single DWORD, dotted hex, 2-part, 3-part)', async () => {
  const hexTargets = [
    { url: 'http://0x7f000001/', desc: '127.0.0.1 as single hex 0x7f000001' },
    { url: 'http://0x7f.0.0.1/', desc: '127.0.0.1 as dotted hex 0x7f.0.0.1' },
    { url: 'http://0x7f.1/', desc: '127.0.0.1 as 2-part hex 0x7f.1' },
    { url: 'http://0x7f.0.1/', desc: '127.0.0.1 as 3-part hex 0x7f.0.1' },
    { url: 'http://0x0a000001/', desc: '10.0.0.1 as single hex 0x0a000001' },
    { url: 'http://0x0a.0.0.1/', desc: '10.0.0.1 as dotted hex 0x0a.0.0.1' },
    { url: 'http://0xac100001/', desc: '172.16.0.1 as single hex 0xac100001' },
    { url: 'http://0xc0a80101/', desc: '192.168.1.1 as single hex 0xc0a80101' },
  ];

  for (const item of hexTargets) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError, `Failed on ${item.desc}`);
        assert.equal(err.blockedReason, 'PRIVATE_IP_BLOCKED', `Failed on ${item.desc}`);
        return true;
      }
    );
  }
});

test('ADV-M2-2.2: Blocks Octal IP formats (4-part, 3-part, 2-part, single octal)', async () => {
  const octalTargets = [
    { url: 'http://0177.0.0.1/', desc: '127.0.0.1 as 4-part octal 0177.0.0.1' },
    { url: 'http://0177.0.1/', desc: '127.0.0.1 as 3-part octal 0177.0.1' },
    { url: 'http://0177.1/', desc: '127.0.0.1 as 2-part octal 0177.1' },
    { url: 'http://017700000001/', desc: '127.0.0.1 as single octal 017700000001' },
    { url: 'http://0012.0.0.1/', desc: '10.0.0.1 as octal 0012.0.0.1' },
    { url: 'http://0254.0020.0000.0001/', desc: '172.16.0.1 as octal' },
    { url: 'http://0300.0250.0001.0001/', desc: '192.168.1.1 as octal' },
  ];

  for (const item of octalTargets) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError, `Failed on ${item.desc}`);
        assert.equal(err.blockedReason, 'PRIVATE_IP_BLOCKED', `Failed on ${item.desc}`);
        return true;
      }
    );
  }
});

test('ADV-M2-2.3: Blocks Decimal DWORD formats and special numeric IPs', async () => {
  const dwordTargets = [
    { url: 'http://2130706433/', desc: '127.0.0.1 as decimal DWORD 2130706433' },
    { url: 'http://167772161/', desc: '10.0.0.1 as decimal DWORD 167772161' },
    { url: 'http://2886729729/', desc: '172.16.0.1 as decimal DWORD 2886729729' },
    { url: 'http://3232235777/', desc: '192.168.1.1 as decimal DWORD 3232235777' },
    { url: 'http://0/', desc: '0.0.0.0 as single 0' },
    { url: 'http://0.0.0.0/', desc: '0.0.0.0 dotted' },
    { url: 'http://127.1/', desc: '127.0.0.1 as 127.1' },
    { url: 'http://10.1/', desc: '10.0.0.1 as 10.1' },
  ];

  for (const item of dwordTargets) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError, `Failed on ${item.desc}`);
        assert.equal(err.blockedReason, 'PRIVATE_IP_BLOCKED', `Failed on ${item.desc}`);
        return true;
      }
    );
  }
});

test('ADV-M2-2.4: Blocks Mixed and Hybrid IP formats', async () => {
  const mixedTargets = [
    { url: 'http://0x7f.0.0.01/', desc: 'Hex and Octal mixed' },
    { url: 'http://0177.0x0.0.1/', desc: 'Octal and Hex mixed' },
    { url: 'http://127.0x0.0.1/', desc: 'Decimal and Hex mixed' },
    { url: 'http://0x7f.0.1/', desc: 'Hex 3-part' },
    { url: 'http://10.0x0.1/', desc: '10.0.0.1 mixed' },
    { url: 'http://192.168.1/', desc: '192.168.0.1 as 3-part decimal' },
  ];

  for (const item of mixedTargets) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError, `Failed on ${item.desc}`);
        assert.equal(err.blockedReason, 'PRIVATE_IP_BLOCKED', `Failed on ${item.desc}`);
        return true;
      }
    );
  }
});

test('ADV-M2-2.5: Blocks IPv4-mapped IPv6 formats (standard, hex, ULA, link-local, multicast)', async () => {
  const ipv6Targets = [
    { url: 'http://[::ffff:127.0.0.1]/', desc: 'IPv4-mapped 127.0.0.1' },
    { url: 'http://[::ffff:7f00:1]/', desc: 'IPv4-mapped hex 127.0.0.1' },
    { url: 'http://[::ffff:10.0.0.1]/', desc: 'IPv4-mapped 10.0.0.1' },
    { url: 'http://[::ffff:192.168.1.1]/', desc: 'IPv4-mapped 192.168.1.1' },
    { url: 'http://[0:0:0:0:0:ffff:127.0.0.1]/', desc: 'Full IPv4-mapped 127.0.0.1' },
    { url: 'http://[0:0:0:0:0:ffff:7f00:1]/', desc: 'Full IPv4-mapped hex' },
    { url: 'http://[::1]/', desc: 'IPv6 loopback' },
    { url: 'http://[fe80::1]/', desc: 'IPv6 link-local' },
    { url: 'http://[fc00::1]/', desc: 'IPv6 ULA fc00' },
    { url: 'http://[fd12:3456:789a::1]/', desc: 'IPv6 ULA fd00' },
    { url: 'http://[ff02::1]/', desc: 'IPv6 Multicast' },
  ];

  for (const item of ipv6Targets) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError, `Failed on ${item.desc}`);
        assert.equal(err.blockedReason, 'PRIVATE_IP_BLOCKED', `Failed on ${item.desc}`);
        return true;
      }
    );
  }
});

test('ADV-M2-2.6: Blocks credentials in URL authority and null-byte injection', async () => {
  const evasionTargets = [
    { url: 'http://admin:secret@127.0.0.1/', reason: 'CREDENTIALS_NOT_ALLOWED' },
    { url: 'http://user:pass@example.com/', reason: 'CREDENTIALS_NOT_ALLOWED' },
    { url: 'http://example.com\x00.evil.com/', reason: 'MALFORMED_URL' },
    { url: 'http://example.com%00.evil.com/', reason: 'MALFORMED_URL' },
    { url: 'http://example.com\\x00.evil.com/', reason: 'MALFORMED_URL' },
    { url: 'http://example.com\\u0000.evil.com/', reason: 'MALFORMED_URL' },
  ];

  for (const item of evasionTargets) {
    await assert.rejects(
      async () => validateOutboundUrl(item.url, { resolveDns: false }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, item.reason);
        return true;
      }
    );
  }
});

// ============================================================================
// SUITE 3: Open Redirect Chains & Scheme Traversal
// ============================================================================

test('ADV-M2-3.1: safeFetch blocks single redirect to private IPv4 targets (127.0.0.1, 10.0.0.1, 192.168.1.1)', async () => {
  const redirectTargets = [
    'http://127.0.0.1/admin',
    'http://10.0.0.1/internal-status',
    'http://172.16.0.1/metrics',
    'http://192.168.1.1/router',
  ];

  for (const target of redirectTargets) {
    const mockFetch = async (url) => {
      if (url.includes('redirect-me')) {
        return {
          status: 302,
          headers: new Map([['location', target]]),
        };
      }
      return { status: 200, headers: new Map() };
    };

    await assert.rejects(
      async () => safeFetch('https://public.cdn.com/redirect-me', {
        mockFetch,
        dnsResolver: async () => '93.184.216.34',
      }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, 'PRIVATE_IP_BLOCKED');
        return true;
      }
    );
  }
});

test('ADV-M2-3.2: safeFetch blocks redirect to cloud metadata and obfuscated private IPs', async () => {
  const metadataRedirects = [
    { target: 'http://169.254.169.254/latest/meta-data/', expectedReason: 'CLOUD_METADATA_BLOCKED' },
    { target: 'http://metadata.google.internal/computeMetadata/v1/', expectedReason: 'CLOUD_METADATA_BLOCKED' },
    { target: 'http://0x7f.1/flag', expectedReason: 'PRIVATE_IP_BLOCKED' },
    { target: 'http://2130706433/status', expectedReason: 'PRIVATE_IP_BLOCKED' },
    { target: 'http://0177.0.0.1/env', expectedReason: 'PRIVATE_IP_BLOCKED' },
    { target: 'http://[::ffff:169.254.169.254]/meta', expectedReason: 'CLOUD_METADATA_BLOCKED' },
    { target: 'http://[::1]/internal', expectedReason: 'PRIVATE_IP_BLOCKED' },
  ];

  for (const item of metadataRedirects) {
    const mockFetch = async () => ({
      status: 302,
      headers: new Map([['location', item.target]]),
    });

    await assert.rejects(
      async () => safeFetch('https://public.service.org/open-redirect', {
        mockFetch,
        dnsResolver: async () => '93.184.216.34',
      }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, item.expectedReason);
        return true;
      }
    );
  }
});

test('ADV-M2-3.3: safeFetch validates deep multi-hop redirect chains and catches late private hops', async () => {
  let hopIndex = 0;
  const chain = [
    'https://public-hop1.com/step1',
    'https://public-hop2.com/step2',
    'https://public-hop3.com/step3',
    'http://10.0.0.1/poison', // Final hop points to private IP
  ];

  const mockFetch = async () => {
    const nextHop = chain[hopIndex++];
    return {
      status: 302,
      headers: new Map([['location', nextHop]]),
    };
  };

  await assert.rejects(
    async () => safeFetch('https://public-entry.com/start', {
      mockFetch,
      dnsResolver: async () => '93.184.216.34',
      maxRedirects: 5,
    }),
    (err) => {
      assert.ok(err instanceof SSRFSecurityError);
      assert.equal(err.blockedReason, 'PRIVATE_IP_BLOCKED');
      assert.equal(hopIndex, 4, 'Must follow all legitimate public hops until encountering private target');
      return true;
    }
  );
});

test('ADV-M2-3.4: safeFetch rejects scheme downgrades (file, gopher, ftp) on redirect', async () => {
  const badSchemes = [
    'file:///etc/passwd',
    'gopher://127.0.0.1:70/',
    'ftp://ftp.local/file',
    'dict://127.0.0.1:2628/',
  ];

  for (const badScheme of badSchemes) {
    const mockFetch = async () => ({
      status: 301,
      headers: new Map([['location', badScheme]]),
    });

    await assert.rejects(
      async () => safeFetch('https://public.com/download', {
        mockFetch,
        dnsResolver: async () => '93.184.216.34',
      }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, 'DISALLOWED_SCHEME');
        return true;
      }
    );
  }
});

// ============================================================================
// SUITE 4: DNS Rebinding Defenses (Multi-record & TOCTOU)
// ============================================================================

test('ADV-M2-4.1: Blocks domains resolving to dual-homed records (Public IP + Private IP)', async () => {
  const origLookup = dns.lookup;
  try {
    dns.lookup = async () => [
      { address: '93.184.216.34', family: 4 }, // Legitimate public IP
      { address: '127.0.0.1', family: 4 },     // Malicious loopback IP
    ];

    await assert.rejects(
      async () => validateOutboundUrl('http://dual-homed-attack.com/products.json', { resolveDns: true }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, 'DNS_REBINDING_BLOCKED');
        assert.match(err.message, /127\.0\.0\.1/);
        return true;
      }
    );
  } finally {
    dns.lookup = origLookup;
  }
});

test('ADV-M2-4.2: Blocks domains resolving to dual-homed records (Public IP + Cloud Metadata IP)', async () => {
  const origLookup = dns.lookup;
  try {
    dns.lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];

    await assert.rejects(
      async () => validateOutboundUrl('http://dual-homed-metadata.com/products.json', { resolveDns: true }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, 'CLOUD_METADATA_BLOCKED');
        return true;
      }
    );
  } finally {
    dns.lookup = origLookup;
  }
});

test('ADV-M2-4.3: Blocks domains resolving to dual-homed records (Public IP + Private IPv6 ULA/Link-local)', async () => {
  const origLookup = dns.lookup;
  try {
    dns.lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: 'fe80::1', family: 6 },
    ];

    await assert.rejects(
      async () => validateOutboundUrl('http://dual-homed-ipv6.com/products.json', { resolveDns: true }),
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.equal(err.blockedReason, 'DNS_REBINDING_BLOCKED');
        return true;
      }
    );
  } finally {
    dns.lookup = origLookup;
  }
});

test('ADV-M2-4.4: Detects time-of-check to time-of-use (TOCTOU) DNS rebinding', async () => {
  let queryCount = 0;
  const rebindingResolver = async () => {
    queryCount++;
    // First query: public IP (passes initial check)
    // Second query: private IP (rebound to loopback)
    return queryCount === 1 ? '93.184.216.34' : '127.0.0.1';
  };

  // 1. Initial verification succeeds
  const initial = await validateOutboundUrl('http://rebinder.attacker.com/status', {
    dnsResolver: rebindingResolver,
  });
  assert.equal(initial.isValid, true);
  assert.equal(initial.resolvedIp, '93.184.216.34');

  // 2. Next query rebounds to 127.0.0.1 and is immediately blocked
  await assert.rejects(
    async () => validateOutboundUrl('http://rebinder.attacker.com/status', {
      dnsResolver: rebindingResolver,
    }),
    (err) => {
      assert.ok(err instanceof SSRFSecurityError);
      assert.equal(err.blockedReason, 'DNS_REBINDING_BLOCKED');
      return true;
    }
  );
});

// ============================================================================
// SUITE 5: Stream Size & Resource Exhaustion (Media Cache & SafeFetch)
// ============================================================================

test('ADV-M2-5.1: safeFetch TransformStream halts infinite byte streams at maxSizeBytes', async () => {
  const chunkSize = 64 * 1024; // 64 KB
  const chunk = Buffer.alloc(chunkSize, 'Z');
  let chunksEmitted = 0;

  const infiniteStream = new ReadableStream({
    pull(controller) {
      chunksEmitted++;
      controller.enqueue(chunk);
    },
  });

  const mockInfiniteFetch = async () => new Response(infiniteStream, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' }, // no Content-Length
  });

  const maxSize = 2 * 1024 * 1024; // 2 MB limit
  const res = await safeFetch('https://public.streamer.com/infinite', {
    mockFetch: mockInfiniteFetch,
    dnsResolver: async () => '93.184.216.34',
    maxSizeBytes: maxSize,
  });

  const reader = res.body.getReader();
  let totalBytesRead = 0;

  await assert.rejects(
    async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytesRead += value.length || value.byteLength || 0;
      }
    },
    /Response exceeds maximum size limit of 2097152 bytes/
  );

  assert.ok(totalBytesRead <= maxSize + chunkSize, 'Bytes read must not exceed max limit + single chunk');
  assert.ok(chunksEmitted <= 35, `Chunks emitted (${chunksEmitted}) must stop immediately upon limit hit`);
});

test('ADV-M2-5.2: media-cache safely aborts infinite streaming download without crashing', async () => {
  const mediaCache = require('../../src/media-cache');
  const origFetch = global.fetch;

  const chunkSize = 64 * 1024;
  const chunk = Buffer.alloc(chunkSize, 0xff);
  chunk[1] = 0xd8; // JPEG magic header
  chunk[2] = 0xff;

  let chunksSent = 0;
  global.fetch = async () => {
    const stream = new ReadableStream({
      pull(controller) {
        chunksSent++;
        controller.enqueue(chunk);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  };

  const fakeItems = [{ image: 'https://cdn-image.hdnet.workers.dev/infinite.jpg' }];
  const warnings = [];
  const fakeLog = { warn: (msg) => warnings.push(msg) };

  try {
    const summary = await mediaCache.persistEphemeralImages(fakeItems, { log: fakeLog });
    assert.equal(summary.considered, 1);
    assert.equal(summary.cached, 0);
    assert.equal(summary.failed, 1);
    assert.ok(warnings.length > 0);
    assert.match(warnings[0], /Response exceeds maximum size limit/);
    assert.ok(chunksSent <= 135, 'Must cease pulling chunks after 8MB');
  } finally {
    global.fetch = origFetch;
  }
});

test('ADV-M2-5.3: safeFetch fast-path immediately rejects content-length exceeding maxSizeBytes', async () => {
  let bodyReadAttempted = false;
  const mockFetchWithHugeContentLength = async () => ({
    status: 200,
    headers: new Map([
      ['content-length', '10737418240'], // 10 GB
    ]),
    body: {
      getReader() {
        bodyReadAttempted = true;
        throw new Error('Should not have attempted to read body');
      },
    },
  });

  await assert.rejects(
    async () => safeFetch('https://public.storage.com/huge.iso', {
      mockFetch: mockFetchWithHugeContentLength,
      dnsResolver: async () => '93.184.216.34',
      maxSizeBytes: 8 * 1024 * 1024,
    }),
    /Response exceeds maximum size limit/
  );

  assert.equal(bodyReadAttempted, false, 'Must reject via content-length header before streaming any body');
});

// ============================================================================
// SUITE 6: Ingress CORS Bypass & CSRF Forgery on State-Changing Endpoints
// ============================================================================

const LIVE_PORT = 32299;
const LIVE_BASE = `http://127.0.0.1:${LIVE_PORT}`;

test('ADV-M2-6.1: Live Server Ingress CORS and CSRF Protection Verification', async () => {
  const { env, paths: hermeticPaths } = makeHermeticEnv({
    PORT: String(LIVE_PORT),
    ADMIN_EMAIL: 'admin@system.local',
    ADMIN_PASSWORD: 'SuperAdminPassword123!',
    ALLOWED_ORIGINS: 'https://trusted.app.internal',
  });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    // 1. Wait for server readiness
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const p = await fetch(`${LIVE_BASE}/livez`);
        if (p.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    assert.ok(ready, 'Live server failed to boot on port ' + LIVE_PORT);

    // 2. CORS: Unauthorized origin (http://evil.com) receives no Access-Control-Allow-Origin
    const corsEvilRes = await fetch(`${LIVE_BASE}/livez`, {
      headers: { Origin: 'http://evil.com' },
    });
    assert.equal(corsEvilRes.headers.get('access-control-allow-origin'), null, 'Unauthorized origin must not receive allow header');

    // 3. CORS: Subdomain and prefix spoofing rejected
    const spoofOrigins = [
      'http://localhost.evil.com',
      'http://127.0.0.1.attacker.org',
      'https://trusted.app.internal.attacker.com',
      'http://attacker.com?trusted.app.internal',
    ];
    for (const origin of spoofOrigins) {
      const spoofRes = await fetch(`${LIVE_BASE}/livez`, {
        headers: { Origin: origin },
      });
      assert.equal(spoofRes.headers.get('access-control-allow-origin'), null, `Spoofed origin ${origin} must be rejected`);
    }

    // 4. CORS: Allowed origin gets exact Access-Control-Allow-Origin
    const corsGoodRes = await fetch(`${LIVE_BASE}/livez`, {
      headers: { Origin: 'https://trusted.app.internal' },
    });
    assert.equal(corsGoodRes.headers.get('access-control-allow-origin'), 'https://trusted.app.internal');
    assert.equal(corsGoodRes.headers.get('access-control-allow-credentials'), 'true');

    // 5. Login to acquire valid session cookie
    const loginRes = await fetch(`${LIVE_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@system.local', password: 'SuperAdminPassword123!' }),
    });
    assert.equal(loginRes.status, 200);
    const cookieHeader = loginRes.headers.get('set-cookie');
    assert.ok(cookieHeader && cookieHeader.includes('crawler_session='));
    const sessionToken = cookieHeader.match(/crawler_session=([a-f0-9]{64})/)[1];

    // 6. CSRF Attack 1: Mutating request (POST /api/runs) with session cookie but NO CSRF header -> 403 Forbidden
    const csrfNoHeaderRes = await fetch(`${LIVE_BASE}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `crawler_session=${sessionToken}`,
      },
      body: JSON.stringify({ platform: 'shopify', query: 'https://example-shop.com' }),
    });
    assert.equal(csrfNoHeaderRes.status, 403);
    const csrfNoHeaderJson = await csrfNoHeaderRes.json();
    assert.equal(csrfNoHeaderJson.error, 'CSRF Forbidden');
    assert.match(csrfNoHeaderJson.message, /Missing CSRF verification header/);

    // 7. CSRF Attack 2: Mutating request with Sec-Fetch-Site: cross-site -> 403 Forbidden
    const csrfCrossSiteRes = await fetch(`${LIVE_BASE}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `crawler_session=${sessionToken}`,
        'Sec-Fetch-Site': 'cross-site',
        'x-csrf-token': 'any-value',
      },
      body: JSON.stringify({ platform: 'shopify', query: 'https://example-shop.com' }),
    });
    assert.equal(csrfCrossSiteRes.status, 403);
    const csrfCrossSiteJson = await csrfCrossSiteRes.json();
    assert.equal(csrfCrossSiteJson.error, 'CSRF Forbidden');
    assert.match(csrfCrossSiteJson.message, /Cross-site request rejected via Sec-Fetch-Site/);

    // 8. CSRF Attack 3: Empty or whitespace-only x-csrf-token -> 403 Forbidden
    const csrfWhitespaceRes = await fetch(`${LIVE_BASE}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `crawler_session=${sessionToken}`,
        'x-csrf-token': '    ',
      },
      body: JSON.stringify({ platform: 'shopify', query: 'https://example-shop.com' }),
    });
    assert.equal(csrfWhitespaceRes.status, 403);
    const csrfWhitespaceJson = await csrfWhitespaceRes.json();
    assert.equal(csrfWhitespaceJson.error, 'CSRF Forbidden');

    // 9. Legitimate Request: With valid session cookie AND x-csrf-token header -> Passes CSRF guard
    // We send an SSRF target (127.0.0.1) so we can see it passes CSRF and reaches the SSRF guard!
    const legitimateWithSsrfTarget = await fetch(`${LIVE_BASE}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `crawler_session=${sessionToken}`,
        'x-csrf-token': 'valid-csrf-token-12345',
      },
      body: JSON.stringify({ platform: 'shopify', query: 'http://127.0.0.1/products.json' }),
    });
    // It must NOT be 403 CSRF Forbidden. It passed CSRF and hit SSRF protection returning 400 SSRF_BLOCKED!
    assert.equal(legitimateWithSsrfTarget.status, 400);
    const ssrfJson = await legitimateWithSsrfTarget.json();
    assert.equal(ssrfJson.error, 'SSRF_BLOCKED');
    assert.equal(ssrfJson.code, 'PRIVATE_IP_BLOCKED');

    // 10. Legitimate API Key caller: Exempt from CSRF header requirement
    // Admin creates an API key first
    const keyRes = await fetch(`${LIVE_BASE}/api/auth/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `crawler_session=${sessionToken}`,
        'x-csrf-token': 'token',
      },
      body: JSON.stringify({ name: 'CSRF Exemption Test Key', role: 'admin', prefix: 'cp_adm_' }),
    });
    assert.equal(keyRes.status, 201);
    const { rawKey } = await keyRes.json();

    // Now call POST /api/runs with x-api-key and NO CSRF header
    const apiKeyMutateRes = await fetch(`${LIVE_BASE}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': rawKey,
      },
      body: JSON.stringify({ platform: 'shopify', query: 'http://169.254.169.254' }),
    });
    // Must NOT be 403 CSRF Forbidden. It passed auth & CSRF exemption and was blocked by SSRF guard!
    assert.equal(apiKeyMutateRes.status, 400);
    const apiKeySsrfJson = await apiKeyMutateRes.json();
    // 11. Ingress SSRF check on POST /api/html-captures (169.254.169.254) -> 400 SSRF_BLOCKED
    const htmlCaptureRes = await fetch(`${LIVE_BASE}/api/html-captures`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': rawKey,
      },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });
    assert.equal(htmlCaptureRes.status, 400);
    const htmlCaptureJson = await htmlCaptureRes.json();
    assert.equal(htmlCaptureJson.error, 'SSRF_BLOCKED');
    assert.equal(htmlCaptureJson.code, 'CLOUD_METADATA_BLOCKED');

    // 12. Ingress SSRF check on POST /api/html-captures (10.0.0.1) -> 400 SSRF_BLOCKED
    const htmlCapturePrivRes = await fetch(`${LIVE_BASE}/api/html-captures`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': rawKey,
      },
      body: JSON.stringify({ url: 'http://10.0.0.1/sensitive.html' }),
    });
    assert.equal(htmlCapturePrivRes.status, 400);
    const htmlCapturePrivJson = await htmlCapturePrivRes.json();
    assert.equal(htmlCapturePrivJson.error, 'SSRF_BLOCKED');
    assert.equal(htmlCapturePrivJson.code, 'PRIVATE_IP_BLOCKED');

    // 13. Ingress SSRF check on POST /api/user-journey/run (127.0.0.1) -> 400 SSRF error
    const journeySsrfRes = await fetch(`${LIVE_BASE}/api/user-journey/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': rawKey,
      },
      body: JSON.stringify({ startUrl: 'http://127.0.0.1:3000/journey' }),
    });
    assert.equal(journeySsrfRes.status, 400);
    const journeySsrfJson = await journeySsrfRes.json();
    assert.equal(journeySsrfJson.code, 'PRIVATE_IP_BLOCKED');

  } finally {
    child.kill('SIGKILL');
    cleanupHermeticEnv(hermeticPaths);
  }
});

test('ADV-M2-2.7: CIDR Boundary stress testing (Class A, B, C, CGNAT, Loopback limits and allowed adjacent public IPs)', async () => {
  const boundaryTests = [
    // Loopback 127.0.0.0/8
    { ip: '127.0.0.0', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },
    { ip: '127.255.255.255', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },

    // Class A 10.0.0.0/8
    { ip: '10.0.0.0', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },
    { ip: '10.255.255.255', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },

    // Class B 172.16.0.0/12
    { ip: '172.15.255.255', blocked: false }, // 1 before -> PUBLIC
    { ip: '172.16.0.0', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },
    { ip: '172.31.255.255', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },
    { ip: '172.32.0.0', blocked: false }, // 1 after -> PUBLIC

    // Class C 192.168.0.0/16
    { ip: '192.167.255.255', blocked: false }, // 1 before -> PUBLIC
    { ip: '192.168.0.0', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },
    { ip: '192.168.255.255', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },
    { ip: '192.169.0.0', blocked: false }, // 1 after -> PUBLIC

    // CGNAT 100.64.0.0/10
    { ip: '100.63.255.255', blocked: false }, // 1 before -> PUBLIC
    { ip: '100.64.0.0', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },
    { ip: '100.127.255.255', blocked: true, reason: 'PRIVATE_IP_BLOCKED' },
    { ip: '100.128.0.0', blocked: false }, // 1 after -> PUBLIC
  ];

  for (const item of boundaryTests) {
    const url = `http://${item.ip}/`;
    if (item.blocked) {
      await assert.rejects(
        async () => validateOutboundUrl(url, { resolveDns: false }),
        (err) => {
          assert.ok(err instanceof SSRFSecurityError, `Failed on boundary ${item.ip}`);
          assert.equal(err.blockedReason, item.reason, `Failed on boundary ${item.ip}`);
          return true;
        }
      );
    } else {
      const res = await validateOutboundUrl(url, { resolveDns: false });
      assert.equal(res.isValid, true);
      assert.equal(res.resolvedIp, item.ip);
    }
  }
});
