'use strict';

/**
 * test/outbound-guard.test.js — Comprehensive Unit Tests for Outbound Guard
 *
 * Verifies OWASP standard outbound URL validation, IP normalization,
 * DNS pre-flight verification, DNS rebinding mitigation, and safeFetch streaming limits.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SSRFSecurityError,
  validateOutboundUrl,
  safeFetch,
  parseAndNormalizeIp,
  isPrivateIp,
  ipToLong,
} = require('../src/security/outbound-guard');

// ============================================================================
// 1. URL Scheme & Input Sanitization
// ============================================================================

test('OG1.1: Rejects null, undefined, empty, and non-string inputs', async () => {
  const invalidInputs = [null, undefined, '', '   ', 12345, {}, []];
  for (const input of invalidInputs) {
    await assert.rejects(
      async () => validateOutboundUrl(input),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'EMPTY_INPUT'
    );
  }
});

test('OG1.2: Rejects malformed and non-parseable URLs', async () => {
  const malformedUrls = ['not_a_url', 'http://', 'https://[invalid-ipv6', 'http://:8080/'];
  for (const url of malformedUrls) {
    await assert.rejects(
      async () => validateOutboundUrl(url),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'MALFORMED_URL'
    );
  }
});

test('OG1.3: Rejects disallowed protocol schemes (file, gopher, ftp, ws, data)', async () => {
  const badSchemes = [
    'file:///etc/passwd',
    'gopher://127.0.0.1:70/',
    'ftp://ftp.example.com/',
    'ws://echo.websocket.org',
    'wss://echo.websocket.org',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
  ];
  for (const url of badSchemes) {
    await assert.rejects(
      async () => validateOutboundUrl(url),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'DISALLOWED_SCHEME'
    );
  }
});

test('OG1.4: Rejects embedded HTTP credentials in URL authority', async () => {
  const credentialUrls = [
    'http://admin:secret@example.com/',
    'https://user:pass@127.0.0.1/products.json',
    'http://user@example.com/api',
  ];
  for (const url of credentialUrls) {
    await assert.rejects(
      async () => validateOutboundUrl(url),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CREDENTIALS_NOT_ALLOWED'
    );
  }
});

test('OG1.5: Rejects null byte injection in URL strings', async () => {
  const nullByteUrls = [
    'http://example.com\x00.evil.com',
    'http://example.com%00.evil.com',
    'http://example.com\\x00.evil.com',
    'http://example.com\\u0000.evil.com',
  ];
  for (const url of nullByteUrls) {
    await assert.rejects(
      async () => validateOutboundUrl(url),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'MALFORMED_URL'
    );
  }
});

// ============================================================================
// 2. Private IPv4 Range & RFC1918 Blocking
// ============================================================================

test('OG2.1: Blocks loopback addresses (127.0.0.0/8)', async () => {
  const loopbackIps = ['127.0.0.1', '127.0.0.2', '127.255.255.254', '127.1.2.3'];
  for (const ip of loopbackIps) {
    await assert.rejects(
      async () => validateOutboundUrl(`http://${ip}/`),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
    );
  }
});

test('OG2.2: Blocks RFC1918 Class A (10.0.0.0/8)', async () => {
  const classAIps = ['10.0.0.1', '10.255.255.254', '10.10.10.10'];
  for (const ip of classAIps) {
    await assert.rejects(
      async () => validateOutboundUrl(`http://${ip}/`),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
    );
  }
});

test('OG2.3: Blocks RFC1918 Class B (172.16.0.0/12)', async () => {
  const classBIps = ['172.16.0.1', '172.24.1.1', '172.31.255.254'];
  for (const ip of classBIps) {
    await assert.rejects(
      async () => validateOutboundUrl(`http://${ip}/`),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
    );
  }
  // Public IPs adjacent to Class B should not be blocked by Class B check
  assert.equal(isPrivateIp('172.15.255.255'), false);
  assert.equal(isPrivateIp('172.32.0.1'), false);
});

test('OG2.4: Blocks RFC1918 Class C (192.168.0.0/16)', async () => {
  const classCIps = ['192.168.0.1', '192.168.1.1', '192.168.255.254'];
  for (const ip of classCIps) {
    await assert.rejects(
      async () => validateOutboundUrl(`http://${ip}/`),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
    );
  }
});

test('OG2.5: Blocks Carrier-Grade NAT (100.64.0.0/10)', async () => {
  const cgnatIps = ['100.64.0.1', '100.100.0.1', '100.127.255.254'];
  for (const ip of cgnatIps) {
    await assert.rejects(
      async () => validateOutboundUrl(`http://${ip}/`),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
    );
  }
  // Boundary check: 100.128.0.1 is public
  assert.equal(isPrivateIp('100.128.0.1'), false);
});

test('OG2.6: Blocks Current Network (0.0.0.0/8), Multicast, and Broadcast', async () => {
  const specialIps = ['0.0.0.0', '0.0.0.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255'];
  for (const ip of specialIps) {
    await assert.rejects(
      async () => validateOutboundUrl(`http://${ip}/`),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
    );
  }
});

// ============================================================================
// 3. Cloud Metadata & Hostname Denylist
// ============================================================================

test('OG3.1: Blocks AWS/GCP/Azure link-local metadata (169.254.169.254)', async () => {
  await assert.rejects(
    async () => validateOutboundUrl('http://169.254.169.254/latest/meta-data/'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED'
  );
  await assert.rejects(
    async () => validateOutboundUrl('http://169.254.1.1/'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
  );
});

test('OG3.2: Blocks cloud provider internal metadata hostnames', async () => {
  const metadataHosts = [
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.goog/computeMetadata/v1/',
    'http://instance-data/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
  ];
  for (const url of metadataHosts) {
    await assert.rejects(
      async () => validateOutboundUrl(url),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED'
    );
  }
});

test('OG3.3: Blocks localhost and internal domain name suffixes', async () => {
  const internalDomains = [
    'http://localhost:3000/',
    'http://service.localhost/',
    'http://db.internal/',
    'http://router.local/',
    'http://api.corp/',
    'http://nas.lan/',
    'http://gateway.home/',
  ];
  for (const url of internalDomains) {
    await assert.rejects(
      async () => validateOutboundUrl(url),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'INTERNAL_DOMAIN_BLOCKED'
    );
  }
});

// ============================================================================
// 4. Obfuscated IP Normalization
// ============================================================================

test('OG4.1: Normalizes and blocks Hex notation (0x7f000001, 0x7f.0.0.1)', async () => {
  assert.equal(parseAndNormalizeIp('0x7f000001'), '127.0.0.1');
  assert.equal(parseAndNormalizeIp('0x7f.0.0.1'), '127.0.0.1');
  await assert.rejects(
    async () => validateOutboundUrl('http://0x7f000001/status'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
  );
});

test('OG4.2: Normalizes and blocks Octal notation (0177.0.0.1)', async () => {
  assert.equal(parseAndNormalizeIp('0177.0.0.1'), '127.0.0.1');
  await assert.rejects(
    async () => validateOutboundUrl('http://0177.0.0.1/admin'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
  );
});

test('OG4.3: Normalizes and blocks Decimal integer DWORD (2130706433)', async () => {
  assert.equal(parseAndNormalizeIp('2130706433'), '127.0.0.1');
  await assert.rejects(
    async () => validateOutboundUrl('http://2130706433/'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
  );
});

test('OG4.4: Normalizes and blocks IPv4-mapped IPv6 ([::ffff:127.0.0.1], [::ffff:7f00:1])', async () => {
  assert.equal(parseAndNormalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(parseAndNormalizeIp('::ffff:7f00:1'), '127.0.0.1');
  await assert.rejects(
    async () => validateOutboundUrl('http://[::ffff:127.0.0.1]/'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
  );
});

test('OG4.5: Blocks IPv6 loopback (::1), link-local (fe80::), and ULA (fc00::)', async () => {
  const ipv6Private = ['[::1]', '[fe80::1]', '[fc00::1]', '[fd00::1]'];
  for (const host of ipv6Private) {
    await assert.rejects(
      async () => validateOutboundUrl(`http://${host}/`),
      (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
    );
  }
});

// ============================================================================
// 5. DNS Pre-flight Verification & Rebinding Defenses
// ============================================================================

test('OG5.1: Allows valid public internet hostnames', async () => {
  const res = await validateOutboundUrl('https://example.com/products.json', {
    dnsResolver: async () => '93.184.216.34',
  });
  assert.equal(res.isValid, true);
  assert.equal(res.hostname, 'example.com');
  assert.equal(res.resolvedIp, '93.184.216.34');
});

test('OG5.2: Detects DNS rebinding when domain resolves to private IP', async () => {
  let count = 0;
  const dnsResolver = async () => {
    count++;
    return count === 1 ? '93.184.216.34' : '127.0.0.1';
  };

  const firstRes = await validateOutboundUrl('http://rebind.attacker.com/api', { dnsResolver });
  assert.equal(firstRes.isValid, true);

  await assert.rejects(
    async () => validateOutboundUrl('http://rebind.attacker.com/api', { dnsResolver }),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'DNS_REBINDING_BLOCKED'
  );
});

test('OG5.3: Detects DNS resolving to cloud metadata IP', async () => {
  const dnsResolver = async () => '169.254.169.254';
  await assert.rejects(
    async () => validateOutboundUrl('http://cloud.attacker.com/leak', { dnsResolver }),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED'
  );
});

// ============================================================================
// 6. SafeFetch: Redirect Interception & Streaming Limits
// ============================================================================

test('OG6.1: safeFetch follows valid public redirects up to maxRedirects', async () => {
  let hop = 0;
  const mockFetch = async () => {
    hop++;
    if (hop <= 2) {
      return { status: 302, headers: new Map([['location', `https://public.example.com/hop-${hop}`]]) };
    }
    return { status: 200, headers: new Map([['content-length', '50']]), text: async () => 'done' };
  };

  const res = await safeFetch('https://public.example.com/start', {
    maxRedirects: 5,
    mockFetch,
    dnsResolver: async () => '93.184.216.34',
  });
  assert.equal(res.status, 200);
  assert.equal(hop, 3);
});

test('OG6.2: safeFetch aborts redirect chain when target points to private IP', async () => {
  const mockFetch = async (url) => {
    if (url.includes('redirect-to-private')) {
      return { status: 302, headers: new Map([['location', 'http://192.168.1.1/secret']]) };
    }
    return { status: 200, headers: new Map() };
  };

  await assert.rejects(
    async () => safeFetch('https://public.example.com/redirect-to-private', {
      mockFetch,
      dnsResolver: async () => '93.184.216.34',
    }),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
  );
});

test('OG6.3: safeFetch throws TOO_MANY_REDIRECTS when redirect loop exceeds limit', async () => {
  let hop = 0;
  const mockFetch = async () => {
    hop++;
    return { status: 301, headers: new Map([['location', `https://public.example.com/loop-${hop}`]]) };
  };

  await assert.rejects(
    async () => safeFetch('https://public.example.com/infinite', {
      maxRedirects: 3,
      mockFetch,
      dnsResolver: async () => '93.184.216.34',
    }),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'TOO_MANY_REDIRECTS'
  );
});

test('OG6.4: safeFetch throws MISSING_LOCATION on redirect without Location header', async () => {
  const mockFetch = async () => ({ status: 302, headers: new Map() });
  await assert.rejects(
    async () => safeFetch('https://public.example.com/missing-loc', {
      mockFetch,
      dnsResolver: async () => '93.184.216.34',
    }),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'MISSING_LOCATION'
  );
});

test('OG6.5: safeFetch enforces strict byte size limits (content-length & stream)', async () => {
  const mockFetchOk = async () => ({
    status: 200,
    headers: new Map([['content-length', '1048576']]), // 1 MB
    text: async () => 'ok',
  });
  const mockFetchOverflow = async () => ({
    status: 200,
    headers: new Map([['content-length', '8388609']]), // 8MB + 1 byte
    text: async () => 'overflow',
  });

  const okRes = await safeFetch('https://example.com/file', {
    maxSizeBytes: 8 * 1024 * 1024,
    mockFetch: mockFetchOk,
    dnsResolver: async () => '93.184.216.34',
  });
  assert.equal(okRes.status, 200);

  await assert.rejects(
    async () => safeFetch('https://example.com/file', {
      maxSizeBytes: 8 * 1024 * 1024,
      mockFetch: mockFetchOverflow,
      dnsResolver: async () => '93.184.216.34',
    }),
    /exceeds maximum size limit/
  );
});

// ============================================================================
// 7. Scraper Integration Tests (Shopify, Web Reader, Media Cache)
// ============================================================================

test('OG7.1: shopify.js fetchProductsJson and scrape reject private IP hosts', async () => {
  const shopify = require('../src/scrapers/shopify');
  await assert.rejects(
    async () => shopify.fetchProductsJson('127.0.0.1', 10),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
  );
  await assert.rejects(
    async () => shopify.fetchProductsJson('169.254.169.254', 10),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED'
  );
  await assert.rejects(
    async () => shopify.scrape('http://192.168.1.100/products.json'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
  );
});

test('OG7.2: web-reader.js readPublicWebPage rejects private target and readerBase URLs', async () => {
  const webReader = require('../src/scrapers/web-reader');
  await assert.rejects(
    async () => webReader.readPublicWebPage('http://127.0.0.1:8080/internal-doc'),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'PRIVATE_IP_BLOCKED'
  );
  await assert.rejects(
    async () => webReader.readPublicWebPage('https://example.com/page', { readerBase: 'http://169.254.169.254/' }),
    (err) => err instanceof SSRFSecurityError && err.blockedReason === 'CLOUD_METADATA_BLOCKED'
  );
});

test('OG7.3: media-cache.js persistEphemeralImages safely handles SSRF attempts', async () => {
  const mediaCache = require('../src/media-cache');
  const items = [
    { image: 'http://127.0.0.1/leak.png' },
    { image: 'http://169.254.169.254/meta.jpg' },
  ];
  const warnings = [];
  const fakeLog = { warn: (msg) => warnings.push(msg) };
  mediaCache.EPHEMERAL_IMAGE_HOSTS.add('127.0.0.1');
  try {
    const summary = await mediaCache.persistEphemeralImages(items, { log: fakeLog });
    assert.equal(summary.failed, 1);
    assert.match(warnings[0], /Access to private IP/);
  } finally {
    mediaCache.EPHEMERAL_IMAGE_HOSTS.delete('127.0.0.1');
  }
});

