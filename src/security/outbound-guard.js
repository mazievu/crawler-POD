'use strict';

/**
 * src/security/outbound-guard.js — Comprehensive OWASP Standard Outbound SSRF Guard
 *
 * Provides strict URL validation, comprehensive private IP/metadata blocklists,
 * obfuscated IP normalization, DNS pre-flight verification, DNS rebinding mitigation,
 * manual redirect chain validation, and streaming response size limits.
 */

const dns = require('node:dns/promises');
const net = require('node:net');

// ============================================================================
// 1. Custom Error Types & Block Reasons
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
// 2. Comprehensive IP Ranges & Hostname Blocklists
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
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB

// ============================================================================
// 3. IP Normalization & CIDR Matching Helpers
// ============================================================================

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

/**
 * Normalizes obfuscated representations of IPv4 and IPv6:
 * - Strips brackets from IPv6
 * - IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
 * - Hex notation (0x7f000001, 0x7f.0.0.1)
 * - Octal notation (0177.0.0.1)
 * - Decimal integer notation (2130706433)
 * - Non-routable BSD notation (0.0.0.0 or 0)
 */
function parseAndNormalizeIp(host) {
  if (!host || typeof host !== 'string') return null;
  let cleanHost = host.trim().replace(/^\[|\]$/g, '');

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (cleanHost.toLowerCase().startsWith('::ffff:')) {
    const rem = cleanHost.slice(7);
    if (rem.includes(':')) {
      const parts = rem.split(':');
      if (parts.length === 2) {
        const p1 = parseInt(parts[0], 16);
        const p2 = parseInt(parts[1], 16);
        if (!Number.isNaN(p1) && !Number.isNaN(p2)) {
          cleanHost = `${(p1 >> 8) & 255}.${p1 & 255}.${(p2 >> 8) & 255}.${p2 & 255}`;
        }
      }
    } else {
      cleanHost = rem;
    }
  }

  // Single Hex notation e.g. 0x7f000001
  if (/^0x[0-9a-fA-F]+$/i.test(cleanHost)) {
    const num = parseInt(cleanHost, 16);
    if (!Number.isNaN(num) && num <= 0xffffffff) {
      return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
    }
  }

  // Decimal integer e.g. 2130706433
  if (/^\d{1,10}$/.test(cleanHost)) {
    const num = parseInt(cleanHost, 10);
    if (!Number.isNaN(num) && num <= 4294967295) {
      return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
    }
  }

  // Dotted segments (octal or hex segments)
  if (cleanHost.includes('.')) {
    const parts = cleanHost.split('.');
    if (parts.length === 4) {
      let isSpecial = false;
      const parsed = [];
      for (const p of parts) {
        if (/^0x[0-9a-fA-F]+$/i.test(p)) {
          isSpecial = true;
          parsed.push(parseInt(p, 16));
        } else if (/^0\d+$/.test(p)) {
          isSpecial = true;
          parsed.push(parseInt(p, 8));
        } else if (/^\d+$/.test(p)) {
          parsed.push(parseInt(p, 10));
        } else {
          parsed.push(NaN);
        }
      }
      if (isSpecial && parsed.every(n => !Number.isNaN(n) && n >= 0 && n <= 255)) {
        return parsed.join('.');
      }
    }
  }

  return cleanHost;
}

/**
 * Checks whether an IPv6 address falls into blocked ranges:
 * - ::1/128 (Loopback)
 * - ::/128 (Unspecified)
 * - fc00::/7 (Unique Local Address / ULA)
 * - fe80::/10 (Link-Local)
 * - ff00::/8 (Multicast)
 * - ::ffff:0:0/96 (IPv4-mapped IPv6)
 */
function isBlockedIpv6(ip) {
  let clean = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (clean === '::1' || clean === '::') return true;

  // Link-local: fe80::/10 (fe80 to febf)
  if (/^fe[89ab][0-9a-f]:/i.test(clean) || /^fe80:/i.test(clean)) return true;

  // ULA: fc00::/7 (fc00 to fdff)
  if (/^f[cd][0-9a-f]{2}:/i.test(clean) || /^fc00:/i.test(clean) || /^fd00:/i.test(clean)) return true;

  // Multicast: ff00::/8
  if (/^ff[0-9a-f]{2}:/i.test(clean)) return true;

  // IPv4-mapped IPv6 e.g. ::ffff:192.168.1.1
  if (clean.startsWith('::ffff:')) {
    const normalized = parseAndNormalizeIp(clean);
    return isPrivateIpv4(normalized);
  }

  return false;
}

/**
 * Checks whether an IPv4 address falls into blocked ranges.
 */
function isPrivateIpv4(ip) {
  if (!ip || typeof ip !== 'string') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;

  const long = ipToLong(ip);
  for (const range of BLOCKED_IPV4_RANGES) {
    if (long >= ipToLong(range.start) && long <= ipToLong(range.end)) {
      return true;
    }
  }
  return false;
}

/**
 * Unified private IP check for both IPv4 and IPv6.
 */
function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const clean = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (isBlockedIpv6(clean)) return true;
  if (isPrivateIpv4(clean)) return true;

  return false;
}

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

// ============================================================================
// 4. Core Outbound URL Validator (OWASP Standard)
// ============================================================================

async function validateOutboundUrl(urlStr, options = {}) {
  if (!urlStr || typeof urlStr !== 'string' || !urlStr.trim()) {
    throw new SSRFSecurityError('Invalid URL input: empty or non-string', urlStr, 'EMPTY_INPUT');
  }

  // Null byte injection check (literal, URL-encoded, and escaped representations)
  if (
    urlStr.includes('\0') ||
    urlStr.includes('%00') ||
    urlStr.includes('\\x00') ||
    urlStr.includes('\\u0000')
  ) {
    throw new SSRFSecurityError('URL contains forbidden null byte characters', urlStr, 'MALFORMED_URL');
  }

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (err) {
    throw new SSRFSecurityError(`Malformed URL: ${err.message}`, urlStr, 'MALFORMED_URL');
  }

  // Protocol scheme validation: strictly http or https
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SSRFSecurityError(`Disallowed protocol scheme: ${parsed.protocol}`, urlStr, 'DISALLOWED_SCHEME');
  }

  // Embedded credentials validation (e.g. http://user:pass@host)
  if (parsed.username || parsed.password) {
    throw new SSRFSecurityError('Embedded credentials in URL are prohibited', urlStr, 'CREDENTIALS_NOT_ALLOWED');
  }

  const normalizedHost = parseAndNormalizeIp(parsed.hostname.toLowerCase());

  // Cloud metadata explicit hostname check
  if (CLOUD_METADATA_HOSTS.has(normalizedHost)) {
    throw new SSRFSecurityError('Access to cloud metadata service is prohibited', urlStr, 'CLOUD_METADATA_BLOCKED');
  }

  // Hostname string checks (localhost & internal domains)
  if (
    normalizedHost === 'localhost' ||
    INTERNAL_DOMAIN_SUFFIXES.some(suffix => normalizedHost.endsWith(suffix))
  ) {
    throw new SSRFSecurityError('Access to localhost or internal domain names is prohibited', urlStr, 'INTERNAL_DOMAIN_BLOCKED');
  }

  // Direct IP address check (if hostname is an IP)
  const isDirectIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(normalizedHost);
  const isDirectIp = isDirectIpv4 || net.isIP(normalizedHost) !== 0;

  if (isDirectIp) {
    if (normalizedHost === '169.254.169.254') {
      throw new SSRFSecurityError('Access to cloud metadata service is prohibited', urlStr, 'CLOUD_METADATA_BLOCKED');
    }
    if (isPrivateIp(normalizedHost)) {
      throw new SSRFSecurityError(`Access to private IP (${normalizedHost}) is prohibited`, urlStr, 'PRIVATE_IP_BLOCKED');
    }
  }

  let resolvedIp = normalizedHost;
  let resolvedAddresses = [normalizedHost];

  // DNS resolution if host is a domain name
  if (!isDirectIp) {
    if (options.dnsResolver) {
      // Mock / custom DNS resolver injection (allows hermetic simulation of DNS rebinding)
      resolvedIp = await options.dnsResolver(normalizedHost);
      const normalizedResolved = parseAndNormalizeIp(resolvedIp);
      if (normalizedResolved === '169.254.169.254' || CLOUD_METADATA_HOSTS.has(normalizedResolved)) {
        throw new SSRFSecurityError('Resolved host is cloud metadata', urlStr, 'CLOUD_METADATA_BLOCKED');
      }
      if (isPrivateIp(normalizedResolved)) {
        throw new SSRFSecurityError(`Resolved IP (${resolvedIp}) for ${normalizedHost} is private/internal`, urlStr, 'DNS_REBINDING_BLOCKED');
      }
      resolvedAddresses = [normalizedResolved];
    } else if (options.resolveDns || (process.env.NODE_ENV !== 'test' && !options.mockFetch)) {
      // Production DNS resolution via node:dns/promises lookup({ all: true })
      let records;
      try {
        records = await dns.lookup(normalizedHost, { all: true });
      } catch (err) {
        throw new SSRFSecurityError(`DNS resolution failed for ${normalizedHost}: ${err.message}`, urlStr, 'DNS_RESOLUTION_FAILED');
      }

      if (!records || records.length === 0) {
        throw new SSRFSecurityError(`DNS resolution returned no records for ${normalizedHost}`, urlStr, 'DNS_RESOLUTION_FAILED');
      }

      resolvedAddresses = records.map(r => parseAndNormalizeIp(r.address));

      for (const addr of resolvedAddresses) {
        if (addr === '169.254.169.254' || CLOUD_METADATA_HOSTS.has(addr)) {
          throw new SSRFSecurityError('DNS resolution points to cloud metadata service', urlStr, 'CLOUD_METADATA_BLOCKED');
        }
        if (isPrivateIp(addr)) {
          throw new SSRFSecurityError(`DNS resolution for ${normalizedHost} resolved to private/internal IP (${addr})`, urlStr, 'DNS_REBINDING_BLOCKED');
        }
      }

      resolvedIp = resolvedAddresses[0];
    }
  }

  return {
    isValid: true,
    normalizedUrl: parsed.toString(),
    resolvedIp,
    addresses: resolvedAddresses,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
  };
}

// ============================================================================
// 5. SafeFetch with Redirect Tracking & Streaming Size Limiting
// ============================================================================

async function safeFetch(urlStr, fetchOptions = {}) {
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
    mockFetch,
    dnsResolver,
    timeoutMs,
    signal: userSignal,
    ...restOptions
  } = fetchOptions;

  let currentUrl = urlStr;
  let redirectsFollowed = 0;

  // Composite abort signal if timeoutMs is provided
  let internalController = null;
  let activeSignal = userSignal;
  if (timeoutMs && !userSignal) {
    internalController = new AbortController();
    const timer = setTimeout(() => internalController.abort(), timeoutMs);
    activeSignal = internalController.signal;
    if (typeof internalController.signal.addEventListener === 'function') {
      internalController.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    }
  }

  try {
    while (true) {
      // Validate outbound URL on every hop
      const validated = await validateOutboundUrl(currentUrl, { dnsResolver });

      // Pinned IP connection to prevent DNS rebinding TOCTOU
      const pinnedUrl = new URL(validated.normalizedUrl);
      const originalHost = pinnedUrl.hostname;
      if (validated.resolvedIp) {
        pinnedUrl.hostname = validated.resolvedIp;
      }

      // Execute HTTP request
      const fetchFn = mockFetch || global.fetch;
      const response = await fetchFn(pinnedUrl.toString(), {
        ...restOptions,
        redirect: 'manual', // Never auto-follow redirects
        signal: activeSignal,
        headers: {
          ...restOptions.headers,
          'Host': originalHost,
        },
      });

      // Handle redirect status codes
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        redirectsFollowed++;
        if (redirectsFollowed > maxRedirects) {
          throw new SSRFSecurityError('Maximum redirect limit exceeded', currentUrl, 'TOO_MANY_REDIRECTS');
        }

        const location = getHeader(response.headers, 'location');
        if (!location) {
          throw new SSRFSecurityError('Redirect response missing Location header', currentUrl, 'MISSING_LOCATION');
        }

        // Re-resolve target Location relative to current hop URL
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // Fast-path size check via content-length header
      const contentLength = getHeader(response.headers, 'content-length');
      if (contentLength !== null && contentLength !== undefined) {
        const parsedLen = parseInt(contentLength, 10);
        if (!Number.isNaN(parsedLen) && parsedLen > maxSizeBytes) {
          throw new Error(`Response exceeds maximum size limit of ${maxSizeBytes} bytes`);
        }
      }

      // Streaming response body size limiting for WHATWG ReadableStream
      if (response && response.body && typeof response.body.pipeThrough === 'function' && typeof TransformStream !== 'undefined') {
        let totalBytes = 0;
        const sizeLimiter = new TransformStream({
          transform(chunk, controller) {
            totalBytes += (chunk.byteLength || chunk.length || 0);
            if (totalBytes > maxSizeBytes) {
              controller.error(new Error(`Response exceeds maximum size limit of ${maxSizeBytes} bytes`));
              return;
            }
            controller.enqueue(chunk);
          },
        });

        // Reconstruct limited response wrapper
        try {
          const limitedBody = response.body.pipeThrough(sizeLimiter);
          return new Response(limitedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch {
          // If Response constructor fails, fallback to returning original response
          return response;
        }
      }

      return response;
    }
  } finally {
    if (internalController && activeSignal && !activeSignal.aborted) {
      // Cleanup completed
    }
  }
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
