'use strict';

/**
 * src/security/outbound-guard.js — OWASP-style outbound SSRF guard.
 *
 * Layers:
 *  1. validateOutboundUrl — scheme/credential/hostname/IP-literal checks plus DNS pre-flight.
 *  2. safeFetch — per-hop manual redirects (each hop re-validated), streaming size limit, and
 *     a guarded undici dispatcher whose connect-time `lookup` re-validates EVERY resolved
 *     address. This closes the DNS-rebinding TOCTOU without rewriting the URL to an IP, so
 *     TLS SNI, certificate validation and the Host header all keep the original hostname.
 */

const dns = require('node:dns/promises');
const net = require('node:net');
const { Agent } = require('undici');

// ============================================================================
// 1. Error type
// ============================================================================

class SSRFSecurityError extends Error {
  constructor(message, targetUrl, blockedReason) {
    super(message);
    this.name = 'SSRFSecurityError';
    this.targetUrl = targetUrl;
    this.blockedReason = blockedReason;
  }
}

// ============================================================================
// 2. Blocklists & constants
// ============================================================================

const BLOCKED_IPV4_RANGES = [
  { start: '0.0.0.0', end: '0.255.255.255', reason: 'Current network (RFC 1122)' },
  { start: '10.0.0.0', end: '10.255.255.255', reason: 'RFC1918 Private Class A' },
  { start: '100.64.0.0', end: '100.127.255.255', reason: 'Carrier-Grade NAT / Shared Address Space (RFC 6598)' },
  { start: '127.0.0.0', end: '127.255.255.255', reason: 'Loopback address (RFC 1122)' },
  { start: '169.254.0.0', end: '169.254.255.255', reason: 'Link-local / Cloud Metadata (RFC 3927)' },
  { start: '172.16.0.0', end: '172.31.255.255', reason: 'RFC1918 Private Class B' },
  { start: '192.0.0.0', end: '192.0.0.255', reason: 'IETF Protocol Assignments (RFC 6890)' },
  { start: '192.0.2.0', end: '192.0.2.255', reason: 'TEST-NET-1 (RFC 5737)' },
  { start: '192.88.99.0', end: '192.88.99.255', reason: '6to4 Relay Anycast (RFC 7526)' },
  { start: '192.168.0.0', end: '192.168.255.255', reason: 'RFC1918 Private Class C' },
  { start: '198.18.0.0', end: '198.19.255.255', reason: 'Benchmark testing (RFC 2544)' },
  { start: '198.51.100.0', end: '198.51.100.255', reason: 'TEST-NET-2 (RFC 5737)' },
  { start: '203.0.113.0', end: '203.0.113.255', reason: 'TEST-NET-3 (RFC 5737)' },
  { start: '224.0.0.0', end: '239.255.255.255', reason: 'Multicast (RFC 5771)' },
  { start: '240.0.0.0', end: '255.255.255.255', reason: 'Reserved / Future use / Broadcast (RFC 1112)' },
];

const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '100.100.100.200', // Alibaba Cloud metadata
]);

const INTERNAL_DOMAIN_SUFFIXES = [
  '.localhost',
  '.internal',
  '.local',
  '.corp',
  '.lan',
  '.home',
  '.arpa',
];

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_CAUSE_DEPTH = 5;
const NO_TEST_OVERRIDES = Object.freeze({ allowAddresses: new Set(), ca: undefined });

// ============================================================================
// 3. IP normalization & classification
// ============================================================================

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function stripBracketsAndZone(ip) {
  return ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
}

function normalizeDottedSegments(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return host;
  const isSpecial = parts.some(p => /^0x[0-9a-f]+$/i.test(p) || /^0\d+$/.test(p));
  const parsed = parts.map((p) => {
    if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
    if (/^0\d+$/.test(p)) return parseInt(p, 8);
    if (/^\d+$/.test(p)) return parseInt(p, 10);
    return NaN;
  });
  const valid = parsed.every(n => !Number.isNaN(n) && n >= 0 && n <= 255);
  return isSpecial && valid ? parsed.join('.') : host;
}

function longToIpv4(num) {
  return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
}

function unmapIpv4MappedIpv6(host) {
  if (!host.toLowerCase().startsWith('::ffff:')) return host;
  const rem = host.slice(7);
  if (!rem.includes(':')) return rem;
  const parts = rem.split(':');
  if (parts.length !== 2) return host;
  const p1 = parseInt(parts[0], 16);
  const p2 = parseInt(parts[1], 16);
  if (Number.isNaN(p1) || Number.isNaN(p2)) return host;
  return `${(p1 >> 8) & 255}.${p1 & 255}.${(p2 >> 8) & 255}.${p2 & 255}`;
}

/**
 * Normalizes obfuscated IPv4/IPv6 host representations:
 * brackets, IPv4-mapped IPv6 (::ffff:127.0.0.1 / ::ffff:7f00:1), hex (0x7f000001, 0x7f.0.0.1),
 * octal (0177.0.0.1) and decimal DWORD (2130706433).
 */
function parseAndNormalizeIp(host) {
  if (!host || typeof host !== 'string') return null;
  const cleanHost = unmapIpv4MappedIpv6(host.trim().replace(/^\[|\]$/g, ''));

  if (/^0x[0-9a-f]+$/i.test(cleanHost)) {
    const num = parseInt(cleanHost, 16);
    if (!Number.isNaN(num) && num <= 0xffffffff) return longToIpv4(num);
  }
  if (/^\d{1,10}$/.test(cleanHost)) {
    const num = parseInt(cleanHost, 10);
    if (!Number.isNaN(num) && num <= 4294967295) return longToIpv4(num);
  }
  return normalizeDottedSegments(cleanHost);
}

/** Replaces a trailing dotted IPv4 (e.g. ::127.0.0.1) with two hex hextets. */
function dottedTailToHex(text) {
  const match = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (!match) return text;
  const n = ipToLong(match[1]);
  return `${text.slice(0, -match[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
}

/** Expands any IPv6 text form into 8 numeric hextets, or null if not IPv6. */
function expandIpv6(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const clean = stripBracketsAndZone(ip);
  if (!net.isIPv6(clean)) return null;
  const text = dottedTailToHex(clean);
  const hasGap = text.includes('::');
  const [head, tail] = hasGap ? text.split('::') : [text, ''];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const fill = hasGap ? 8 - headParts.length - tailParts.length : 0;
  const hextets = [...headParts, ...Array(fill).fill('0'), ...tailParts].map(h => parseInt(h, 16));
  return hextets.length === 8 && hextets.every(h => h >= 0 && h <= 0xffff) ? hextets : null;
}

function embeddedIpv4(h, index) {
  return `${h[index] >> 8}.${h[index] & 255}.${h[index + 1] >> 8}.${h[index + 1] & 255}`;
}

const allZero = (h, from, to) => h.slice(from, to).every(x => x === 0);

/**
 * IPv6 rules, first match wins. `embedded: i` defers to the IPv4 policy for the IPv4
 * address carried in hextets i and i+1; `blocked: true` blocks the whole prefix.
 */
const IPV6_RULES = [
  { name: '::/96 unspecified, loopback, IPv4-compatible', match: h => allZero(h, 0, 6), blocked: true },
  { name: '::ffff:0:0/96 IPv4-mapped', match: h => allZero(h, 0, 5) && h[5] === 0xffff, embedded: 6 },
  { name: '::ffff:0:0:0/96 IPv4-translated', match: h => allZero(h, 0, 4) && h[4] === 0xffff && h[5] === 0, embedded: 6 },
  { name: '64:ff9b::/96 NAT64', match: h => h[0] === 0x64 && h[1] === 0xff9b && allZero(h, 2, 6), embedded: 6 },
  { name: '64:ff9b:1::/48 local-use NAT64', match: h => h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1, blocked: true },
  { name: '100::/64 discard-only', match: h => h[0] === 0x100 && allZero(h, 1, 4), blocked: true },
  { name: '2001::/32 Teredo', match: h => h[0] === 0x2001 && h[1] === 0, blocked: true },
  { name: '2001:db8::/32 documentation', match: h => h[0] === 0x2001 && h[1] === 0xdb8, blocked: true },
  { name: '2002::/16 6to4', match: h => h[0] === 0x2002, embedded: 1 },
  { name: 'fc00::/7 unique local', match: h => (h[0] & 0xfe00) === 0xfc00, blocked: true },
  { name: 'fe80::/10 link-local', match: h => (h[0] & 0xffc0) === 0xfe80, blocked: true },
  { name: 'fec0::/10 site-local', match: h => (h[0] & 0xffc0) === 0xfec0, blocked: true },
  { name: 'ff00::/8 multicast', match: h => (h[0] & 0xff00) === 0xff00, blocked: true },
];

function isBlockedIpv6(ip) {
  const h = expandIpv6(ip);
  if (!h) return false;
  const rule = IPV6_RULES.find(r => r.match(h));
  if (!rule) return false;
  return rule.blocked === true || isPrivateIpv4(embeddedIpv4(h, rule.embedded));
}

function isPrivateIpv4(ip) {
  if (!ip || typeof ip !== 'string') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const long = ipToLong(ip);
  return BLOCKED_IPV4_RANGES.some(r => long >= ipToLong(r.start) && long <= ipToLong(r.end));
}

/** Unified private IP check for both IPv4 and IPv6. */
function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const clean = stripBracketsAndZone(ip);
  return isBlockedIpv6(clean) || isPrivateIpv4(clean);
}

/** @returns {null | 'CLOUD_METADATA' | 'PRIVATE'} */
function classifyAddress(address) {
  const normalized = parseAndNormalizeIp(address);
  if (!normalized) return 'PRIVATE';
  if (CLOUD_METADATA_HOSTS.has(normalized)) return 'CLOUD_METADATA';
  return isPrivateIp(normalized) ? 'PRIVATE' : null;
}

// ============================================================================
// 4. DNS seams, test-only overrides & resolved-address policy
// ============================================================================

/** Default resolver: all records, in resolver order. */
function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

/** Adapts the legacy single-IP `dnsResolver(host) => ip` seam to a lookup function. */
function resolverToLookup(dnsResolver) {
  if (typeof dnsResolver !== 'function') return undefined;
  return async (hostname) => {
    const address = await dnsResolver(hostname);
    return [{ address, family: net.isIP(address) || 4 }];
  };
}

/**
 * Test-only escape hatch (reach a local 127.0.0.1 server, trust a test CA).
 * Refused unless NODE_ENV === 'test' so it can never be enabled in production.
 * IP-literal URLs are never affected — it only applies to DNS answers.
 */
function resolveTestOnly(testOnly) {
  if (!testOnly) return NO_TEST_OVERRIDES;
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('safeFetch testOnly options are only honoured when NODE_ENV=test');
  }
  const allowAddresses = new Set((testOnly.allowAddresses || []).map(parseAndNormalizeIp));
  return Object.freeze({ allowAddresses, ca: testOnly.ca });
}

/** Throws if ANY resolved address is private/metadata (unless explicitly test-allowed). */
function assertAddressesAllowed(addresses, hostname, targetUrl, allowAddresses) {
  for (const address of addresses) {
    if (allowAddresses.has(parseAndNormalizeIp(address))) continue;
    const verdict = classifyAddress(address);
    if (verdict === 'CLOUD_METADATA') {
      throw new SSRFSecurityError(`DNS for ${hostname} points to cloud metadata (${address})`, targetUrl, 'CLOUD_METADATA_BLOCKED');
    }
    if (verdict === 'PRIVATE') {
      throw new SSRFSecurityError(`DNS for ${hostname} resolved to private/internal IP (${address})`, targetUrl, 'DNS_REBINDING_BLOCKED');
    }
  }
}

// ============================================================================
// 5. Guarded dispatcher (connect-time DNS pinning)
// ============================================================================

function toRecords(records) {
  return (records || []).map(r => ({ address: r.address, family: r.family || net.isIP(r.address) }));
}

async function resolveValidated(lookup, hostname, family, allowAddresses) {
  const records = toRecords(await lookup(hostname));
  if (records.length === 0) {
    throw new SSRFSecurityError(`DNS returned no records for ${hostname}`, hostname, 'DNS_RESOLUTION_FAILED');
  }
  assertAddressesAllowed(records.map(r => r.address), hostname, hostname, allowAddresses);
  const usable = family === 4 || family === 6 ? records.filter(r => r.family === family) : records;
  if (usable.length === 0) {
    throw new SSRFSecurityError(`DNS returned no IPv${family} records for ${hostname}`, hostname, 'DNS_RESOLUTION_FAILED');
  }
  return usable;
}

function deliverLookup(callback, wantsAll, records) {
  if (wantsAll) {
    callback(null, records);
    return;
  }
  callback(null, records[0].address, records[0].family);
}

/**
 * net/tls-compatible `lookup(hostname, options, callback)`. Every address is validated
 * before net/tls sees it, so the socket can only ever dial a validated address.
 */
function createGuardedLookup(lookup, allowAddresses) {
  return function guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = options && typeof options === 'object' ? options : {};
    resolveValidated(lookup, hostname, opts.family, allowAddresses).then(
      records => process.nextTick(deliverLookup, cb, Boolean(opts.all), records),
      err => process.nextTick(cb, err)
    );
  };
}

function createGuardedDispatcher({ lookup = defaultLookup, allowAddresses = NO_TEST_OVERRIDES.allowAddresses, ca } = {}) {
  const connect = { lookup: createGuardedLookup(lookup, allowAddresses), ...(ca ? { ca } : {}) };
  return new Agent({ connect });
}

let sharedDispatcher = null;

/** Picks the process-wide dispatcher unless a DNS seam or test override needs a dedicated one. */
function selectDispatcher(lookup, testOverrides) {
  const isCustom = Boolean(lookup) || testOverrides !== NO_TEST_OVERRIDES;
  if (isCustom) {
    return createGuardedDispatcher({ lookup, allowAddresses: testOverrides.allowAddresses, ca: testOverrides.ca });
  }
  if (!sharedDispatcher) sharedDispatcher = createGuardedDispatcher();
  return sharedDispatcher;
}

// ============================================================================
// 6. Outbound URL validator
// ============================================================================

function hasNullByte(urlStr) {
  return ['\0', '%00', '\\x00', '\\u0000'].some(token => urlStr.includes(token));
}

function parseOutboundUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string' || !urlStr.trim()) {
    throw new SSRFSecurityError('Invalid URL input: empty or non-string', urlStr, 'EMPTY_INPUT');
  }
  if (hasNullByte(urlStr)) {
    throw new SSRFSecurityError('URL contains forbidden null byte characters', urlStr, 'MALFORMED_URL');
  }
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (err) {
    throw new SSRFSecurityError(`Malformed URL: ${err.message}`, urlStr, 'MALFORMED_URL');
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SSRFSecurityError(`Disallowed protocol scheme: ${parsed.protocol}`, urlStr, 'DISALLOWED_SCHEME');
  }
  if (parsed.username || parsed.password) {
    throw new SSRFSecurityError('Embedded credentials in URL are prohibited', urlStr, 'CREDENTIALS_NOT_ALLOWED');
  }
  return parsed;
}

function assertHostnameAllowed(normalizedHost, urlStr) {
  if (CLOUD_METADATA_HOSTS.has(normalizedHost)) {
    throw new SSRFSecurityError('Access to cloud metadata service is prohibited', urlStr, 'CLOUD_METADATA_BLOCKED');
  }
  if (normalizedHost === 'localhost' || INTERNAL_DOMAIN_SUFFIXES.some(suffix => normalizedHost.endsWith(suffix))) {
    throw new SSRFSecurityError('Access to localhost or internal domain names is prohibited', urlStr, 'INTERNAL_DOMAIN_BLOCKED');
  }
}

function isIpLiteral(normalizedHost) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalizedHost) || net.isIP(normalizedHost) !== 0;
}

/** Chooses the pre-flight lookup: explicit seams first, real DNS outside tests. */
function pickPreflightLookup(options) {
  if (options.dnsLookup) return options.dnsLookup;
  if (options.dnsResolver) return resolverToLookup(options.dnsResolver);
  const shouldResolve = options.resolveDns || (process.env.NODE_ENV !== 'test' && !options.mockFetch);
  return shouldResolve ? defaultLookup : null;
}

async function resolveAddresses(lookup, hostname, urlStr) {
  let records;
  try {
    records = await lookup(hostname);
  } catch (err) {
    throw new SSRFSecurityError(`DNS resolution failed for ${hostname}: ${err.message}`, urlStr, 'DNS_RESOLUTION_FAILED');
  }
  if (!records || records.length === 0) {
    throw new SSRFSecurityError(`DNS resolution returned no records for ${hostname}`, urlStr, 'DNS_RESOLUTION_FAILED');
  }
  return records.map(r => parseAndNormalizeIp(r.address));
}

/**
 * @param {string} urlStr
 * @param {{ dnsResolver?: Function, dnsLookup?: Function, resolveDns?: boolean,
 *           mockFetch?: Function, testOnly?: { allowAddresses?: string[] } }} [options]
 */
async function validateOutboundUrl(urlStr, options = {}) {
  const parsed = parseOutboundUrl(urlStr);
  const normalizedHost = parseAndNormalizeIp(parsed.hostname.toLowerCase());
  assertHostnameAllowed(normalizedHost, urlStr);

  const isDirectIp = isIpLiteral(normalizedHost);
  if (isDirectIp && isPrivateIp(normalizedHost)) {
    throw new SSRFSecurityError(`Access to private IP (${normalizedHost}) is prohibited`, urlStr, 'PRIVATE_IP_BLOCKED');
  }

  const lookup = isDirectIp ? null : pickPreflightLookup(options);
  const addresses = lookup ? await resolveAddresses(lookup, normalizedHost, urlStr) : [normalizedHost];
  if (lookup) {
    assertAddressesAllowed(addresses, normalizedHost, urlStr, resolveTestOnly(options.testOnly).allowAddresses);
  }

  return {
    isValid: true,
    normalizedUrl: parsed.toString(),
    resolvedIp: addresses[0],
    addresses,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
  };
}

// ============================================================================
// 7. safeFetch: per-hop redirects, guarded dispatcher, streaming size limit
// ============================================================================

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(name.toLowerCase());
  }
  const lowerName = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lowerName) return v;
  }
  return null;
}

function buildSignal(userSignal, timeoutMs) {
  const signals = [userSignal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** Surfaces an SSRFSecurityError raised by the guarded lookup through fetch's "fetch failed" wrapper. */
function unwrapSsrfError(err) {
  let current = err;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof SSRFSecurityError) return current;
    current = current.cause;
  }
  return err;
}

async function discardBody(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
  } catch {
    // Body already consumed/closed — nothing to release.
  }
}

async function fetchHop(url, ctx) {
  // Resolved per call so test doubles of global fetch keep working (mockFetch seam wins).
  const fetchFn = ctx.mockFetch || globalThis.fetch;
  try {
    return await fetchFn(url, ctx.init);
  } catch (err) {
    throw unwrapSsrfError(err);
  }
}

function nextRedirectUrl(response, currentUrl, redirectsFollowed, maxRedirects) {
  if (redirectsFollowed > maxRedirects) {
    throw new SSRFSecurityError('Maximum redirect limit exceeded', currentUrl, 'TOO_MANY_REDIRECTS');
  }
  const location = getHeader(response.headers, 'location');
  if (!location) {
    throw new SSRFSecurityError('Redirect response missing Location header', currentUrl, 'MISSING_LOCATION');
  }
  return new URL(location, currentUrl).toString();
}

/** Follows redirects manually; every hop is re-validated and dialled via the same guarded dispatcher. */
async function fetchFollowingRedirects(startUrl, ctx) {
  let currentUrl = startUrl;
  for (let redirectsFollowed = 1; ; redirectsFollowed++) {
    const validated = await validateOutboundUrl(currentUrl, ctx.validateOptions);
    const response = await fetchHop(validated.normalizedUrl, ctx);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await discardBody(response);
    currentUrl = nextRedirectUrl(response, currentUrl, redirectsFollowed, ctx.maxRedirects);
  }
}

function assertContentLength(response, maxSizeBytes) {
  const contentLength = getHeader(response.headers, 'content-length');
  if (contentLength === null || contentLength === undefined) return;
  const parsedLen = parseInt(contentLength, 10);
  if (!Number.isNaN(parsedLen) && parsedLen > maxSizeBytes) {
    throw new Error(`Response exceeds maximum size limit of ${maxSizeBytes} bytes`);
  }
}

function createSizeLimiter(maxSizeBytes) {
  let totalBytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      totalBytes += (chunk.byteLength || chunk.length || 0);
      if (totalBytes > maxSizeBytes) {
        controller.error(new Error(`Response exceeds maximum size limit of ${maxSizeBytes} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

function limitResponseBody(response, maxSizeBytes) {
  const canStream = response && response.body && typeof response.body.pipeThrough === 'function';
  if (!canStream || typeof TransformStream === 'undefined') return response;
  try {
    return new Response(response.body.pipeThrough(createSizeLimiter(maxSizeBytes)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    return response;
  }
}

/**
 * SSRF-safe fetch. Extra options (none required in production):
 *  - maxRedirects, maxSizeBytes, timeoutMs, signal
 *  - dnsLookup(hostname) => Promise<[{address, family}]>  DNS seam used at pre-flight AND connect time
 *  - dnsResolver(hostname) => Promise<string>            legacy single-IP DNS seam (same scope)
 *  - mockFetch(url, init)                                 replaces the network call (unit tests)
 *  - testOnly: { allowAddresses, ca }                     honoured only when NODE_ENV === 'test'
 * A caller-supplied `dispatcher` is always overridden by the guarded one.
 */
async function safeFetch(urlStr, fetchOptions = {}) {
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
    mockFetch,
    dnsResolver,
    dnsLookup,
    testOnly,
    timeoutMs,
    signal: userSignal,
    ...requestInit
  } = fetchOptions;

  const testOverrides = resolveTestOnly(testOnly);
  const lookup = dnsLookup || resolverToLookup(dnsResolver);
  const ctx = {
    maxRedirects,
    mockFetch,
    validateOptions: { dnsLookup: lookup, testOnly: testOverrides === NO_TEST_OVERRIDES ? undefined : testOnly },
    init: {
      ...requestInit,
      headers: new Headers(requestInit.headers),
      redirect: 'manual',
      signal: buildSignal(userSignal, timeoutMs),
      dispatcher: selectDispatcher(lookup, testOverrides),
    },
  };

  const response = await fetchFollowingRedirects(urlStr, ctx);
  assertContentLength(response, maxSizeBytes);
  return limitResponseBody(response, maxSizeBytes);
}

module.exports = {
  SSRFSecurityError,
  BLOCKED_IPV4_RANGES,
  CLOUD_METADATA_HOSTS,
  INTERNAL_DOMAIN_SUFFIXES,
  ipToLong,
  parseAndNormalizeIp,
  isPrivateIpv4,
  isBlockedIpv6,
  isPrivateIp,
  validateOutboundUrl,
  safeFetch,
};
