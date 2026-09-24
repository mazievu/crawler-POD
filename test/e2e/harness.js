'use strict';

/**
 * test/e2e/harness.js — Hermetic E2E Test Harness & Contract Simulation
 *
 * Provides a self-contained, in-process test server, mock database,
 * security validators, and helper utilities for the Crawler-POD
 * Internet Launch Security & Auth 4-Tier Test Suite.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');

// ============================================================================
// 1. Password & Token Hashing Utilities (bcrypt/scrypt compatible)
// ============================================================================

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, originalHash] = parts;
  const testHash = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(originalHash, 'hex'));
}

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateApiKey(prefix = 'cp_live_') {
  const randomPart = crypto.randomBytes(24).toString('hex');
  return `${prefix}${randomPart}`;
}

// ============================================================================
// 2. Outbound SSRF Validator & SafeFetch (OWASP Compliant)
// ============================================================================

class SSRFSecurityError extends Error {
  constructor(message, targetUrl, blockedReason) {
    super(message);
    this.name = 'SSRFSecurityError';
    this.targetUrl = targetUrl;
    this.blockedReason = blockedReason;
  }
}

const BLOCKED_IPV4_RANGES = [
  { start: '127.0.0.0', end: '127.255.255.255', reason: 'Loopback address' },
  { start: '10.0.0.0', end: '10.255.255.255', reason: 'RFC1918 Private Class A' },
  { start: '172.16.0.0', end: '172.31.255.255', reason: 'RFC1918 Private Class B' },
  { start: '192.168.0.0', end: '192.168.255.255', reason: 'RFC1918 Private Class C' },
  { start: '169.254.0.0', end: '169.254.255.255', reason: 'Link-local / Cloud Metadata' },
  { start: '0.0.0.0', end: '0.255.255.255', reason: 'Current network' },
];

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  // IPv6 checks
  if (ip === '::1' || ip === '::' || /^fe80:/i.test(ip) || /^fc00:/i.test(ip) || /^fd00:/i.test(ip)) {
    return true;
  }
  // IPv4 mapped IPv6 (e.g. ::ffff:127.0.0.1)
  const ipv4Mapped = ip.replace(/^::ffff:/i, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ipv4Mapped)) {
    const long = ipToLong(ipv4Mapped);
    for (const range of BLOCKED_IPV4_RANGES) {
      if (long >= ipToLong(range.start) && long <= ipToLong(range.end)) {
        return true;
      }
    }
  }
  return false;
}

function parseAndNormalizeIp(host) {
  if (!host) return null;
  // Strip brackets from IPv6
  let cleanHost = host.replace(/^\[|\]$/g, '');
  if (cleanHost.toLowerCase().startsWith('::ffff:')) {
    const rem = cleanHost.slice(7);
    if (rem.includes(':')) {
      const parts = rem.split(':');
      const p1 = parseInt(parts[0], 16);
      const p2 = parseInt(parts[1], 16);
      cleanHost = `${(p1 >> 8) & 255}.${p1 & 255}.${(p2 >> 8) & 255}.${p2 & 255}`;
    } else {
      cleanHost = rem;
    }
  }
  
  // Hex notation e.g. 0x7f000001
  if (/^0x[0-9a-fA-F]+$/i.test(cleanHost)) {
    const num = parseInt(cleanHost, 16);
    return `${(num >> 24) & 255}.${(num >> 16) & 255}.${(num >> 8) & 255}.${num & 255}`;
  }
  // Octal notation e.g. 0177.0.0.1
  if (/^0\d+(\.\d+)+$/.test(cleanHost)) {
    const parts = cleanHost.split('.').map(p => p.startsWith('0') && p.length > 1 ? parseInt(p, 8) : parseInt(p, 10));
    return parts.join('.');
  }
  // Decimal integer e.g. 2130706433
  if (/^\d{8,10}$/.test(cleanHost)) {
    const num = parseInt(cleanHost, 10);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return cleanHost;
}

async function validateOutboundUrl(urlStr, options = {}) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new SSRFSecurityError('Invalid URL input: empty or non-string', urlStr, 'EMPTY_INPUT');
  }

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (err) {
    throw new SSRFSecurityError(`Malformed URL: ${err.message}`, urlStr, 'MALFORMED_URL');
  }

  // Scheme validation: strictly http or https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFSecurityError(`Disallowed protocol scheme: ${parsed.protocol}`, urlStr, 'DISALLOWED_SCHEME');
  }

  const normalizedHost = parseAndNormalizeIp(parsed.hostname.toLowerCase());

  // Cloud metadata explicit hostname block
  if (normalizedHost === '169.254.169.254' || normalizedHost === 'metadata.google.internal' || normalizedHost === 'instance-data') {
    throw new SSRFSecurityError('Access to cloud metadata service is prohibited', urlStr, 'CLOUD_METADATA_BLOCKED');
  }

  // Hostname string checks
  if (normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost') || normalizedHost.endsWith('.internal') || normalizedHost.endsWith('.local')) {
    throw new SSRFSecurityError('Access to localhost or internal domain names is prohibited', urlStr, 'INTERNAL_DOMAIN_BLOCKED');
  }

  // Check IP directly if hostname is IP
  if (isPrivateIp(normalizedHost)) {
    throw new SSRFSecurityError(`Access to private IP (${normalizedHost}) is prohibited`, urlStr, 'PRIVATE_IP_BLOCKED');
  }

  // Optional mock DNS resolver check (allows simulation of DNS rebinding)
  let resolvedIp = normalizedHost;
  if (options.dnsResolver) {
    resolvedIp = await options.dnsResolver(normalizedHost);
    if (isPrivateIp(resolvedIp)) {
      throw new SSRFSecurityError(`Resolved IP (${resolvedIp}) for ${normalizedHost} is private/internal`, urlStr, 'DNS_REBINDING_BLOCKED');
    }
  }

  return {
    isValid: true,
    normalizedUrl: parsed.toString(),
    resolvedIp,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
  };
}

async function safeFetch(urlStr, fetchOptions = {}) {
  const { maxRedirects = 5, maxSizeBytes = 8 * 1024 * 1024, mockFetch, ...restOptions } = fetchOptions;
  let currentUrl = urlStr;
  let redirectsFollowed = 0;

  while (true) {
    const validated = await validateOutboundUrl(currentUrl, fetchOptions);
    
    // Execute request via mock or real fetch
    const fetchFn = mockFetch || global.fetch;
    const response = await fetchFn(validated.normalizedUrl, {
      ...restOptions,
      redirect: 'manual', // do not auto-follow redirects to prevent bypass
    });

    // Check redirect
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      redirectsFollowed++;
      if (redirectsFollowed > maxRedirects) {
        throw new SSRFSecurityError('Maximum redirect limit exceeded', currentUrl, 'TOO_MANY_REDIRECTS');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new SSRFSecurityError('Redirect response missing Location header', currentUrl, 'MISSING_LOCATION');
      }
      // Re-resolve location relative to currentUrl
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    // Stream size validation
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
      throw new Error(`Response exceeds maximum size limit of ${maxSizeBytes} bytes`);
    }

    return response;
  }
}

// ============================================================================
// 3. Hermetic In-Memory Database Stub
// ============================================================================

class InMemoryDatabase {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.apiKeys = new Map();
    this.runs = new Map();
    this.proxies = new Map();
    this.tokens = new Map();
    this.limiterLeases = new Map();
    this.auditLogs = [];
    this.isHealthy = true;
    this.nextUserId = 1;
    this.nextKeyId = 1;
    this.nextRunId = 1;
  }

  async reset() {
    this.users.clear();
    this.sessions.clear();
    this.apiKeys.clear();
    this.runs.clear();
    this.proxies.clear();
    this.tokens.clear();
    this.limiterLeases.clear();
    this.auditLogs = [];
    this.isHealthy = true;
  }

  // User management
  addUser({ email, password, role = 'member' }) {
    const id = this.nextUserId++;
    const passwordHash = hashPassword(password);
    const user = { id, email: email.toLowerCase().trim(), passwordHash, role, createdAt: new Date() };
    this.users.set(user.email, user);
    return user;
  }

  getUserByEmail(email) {
    return this.users.get(email.toLowerCase().trim()) || null;
  }

  countAdmins() {
    let count = 0;
    for (const u of this.users.values()) {
      if (u.role === 'admin') count += 1;
    }
    return count;
  }

  getUserById(id) {
    for (const u of this.users.values()) {
      if (u.id === id) return u;
    }
    return null;
  }

  // Session management
  createSession(userId, durationMs = 24 * 60 * 60 * 1000) {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + durationMs);
    const session = { sessionToken, userId, expiresAt, createdAt: new Date() };
    this.sessions.set(sessionToken, session);
    return session;
  }

  getSession(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (new Date() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  deleteSession(token) {
    return this.sessions.delete(token);
  }

  // API Key management
  createApiKey({ userId, name, role = 'member', prefix = 'cp_live_', expiresInDays = 30 }) {
    const rawKey = generateApiKey(prefix);
    const keyHash = hashApiKey(rawKey);
    const id = this.nextKeyId++;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const record = { id, userId, name, role, keyHash, prefix, expiresAt, isRevoked: false, createdAt: new Date() };
    this.apiKeys.set(keyHash, record);
    return { rawKey, record };
  }

  getApiKey(rawKey) {
    const keyHash = hashApiKey(rawKey);
    const record = this.apiKeys.get(keyHash);
    if (!record || record.isRevoked) return null;
    if (new Date() > record.expiresAt) return null;
    return record;
  }

  revokeApiKey(id) {
    for (const record of this.apiKeys.values()) {
      if (record.id === id) {
        record.isRevoked = true;
        return true;
      }
    }
    return false;
  }
}

// ============================================================================
// 4. Rate Limiting Middlewares (Brute Force & Run Creation)
// ============================================================================

class RateLimiter {
  constructor({ windowMs, maxRequests, keyGenerator }) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.keyGenerator = keyGenerator || ((req) => req.ip);
    this.hits = new Map();
  }

  middleware() {
    return (req, res, next) => {
      const key = this.keyGenerator(req);
      const now = Date.now();
      let record = this.hits.get(key);

      if (!record || now - record.resetTime > this.windowMs) {
        record = { count: 0, resetTime: now };
        this.hits.set(key, record);
      }

      record.count++;
      const remaining = Math.max(0, this.maxRequests - record.count);
      const resetSeconds = Math.ceil((record.resetTime + this.windowMs - now) / 1000);

      res.setHeader('X-RateLimit-Limit', this.maxRequests);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', resetSeconds);

      if (record.count > this.maxRequests) {
        res.setHeader('Retry-After', resetSeconds);
        return res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please wait before retrying.',
          retryAfter: resetSeconds,
        });
      }
      next();
    };
  }

  recordFailure(key) {
    const now = Date.now();
    let record = this.hits.get(key);
    if (!record || now - record.resetTime > this.windowMs) {
      record = { count: 0, resetTime: now };
      this.hits.set(key, record);
    }
    record.count++;
    return record.count;
  }

  isBlocked(key) {
    const now = Date.now();
    const record = this.hits.get(key);
    if (!record) return false;
    if (now - record.resetTime > this.windowMs) {
      this.hits.delete(key);
      return false;
    }
    return record.count >= this.maxRequests;
  }

  resetKey(key) {
    this.hits.delete(key);
  }

  clear() {
    this.hits.clear();
  }
}

// ============================================================================
// 5. Test Application Factory (Full-Fidelity Contract Express App)
// ============================================================================

/**
 * Mirrors server.js's bootstrapDatabase(): Super Admin bootstrap happens at
 * server "boot" from ADMIN_EMAIL/ADMIN_PASSWORD (env or config), and refuses
 * once any admin already exists. There is intentionally NO HTTP route for
 * this — a public/authenticated `/api/auth/bootstrap` endpoint was the M1
 * "bootstrap takeover" vulnerability the real server had removed.
 */
function bootstrapAdminFromConfig(db, config) {
  const adminEmail = (process.env.ADMIN_EMAIL || config.adminEmail || '').trim();
  const adminPassword = process.env.ADMIN_PASSWORD || config.adminPassword;

  if (db.countAdmins() > 0) return;
  if (!adminEmail || !adminPassword || (typeof adminPassword === 'string' && !adminPassword.trim())) return;
  if (db.getUserByEmail(adminEmail)) return;

  db.addUser({ email: adminEmail, password: adminPassword, role: 'admin' });
}

function createTestApp(config = {}) {
  const db = config.database || new InMemoryDatabase();
  bootstrapAdminFromConfig(db, config);
  const internalServiceKey = config.internalServiceKey || 'test-internal-secret-key-32chars!!';
  const allowedOrigins = config.allowedOrigins || ['http://localhost:3000', 'https://crawler-pod.local'];
  const maxConcurrentRuns = config.maxConcurrentRuns !== undefined ? config.maxConcurrentRuns : 5;

  let activeConcurrentRuns = 0;
  let isEmergencyFrozen = false;
  let apifyBudgetBalance = config.initialApifyBalance ?? 100.0;
  let isShutdown = false;

  // Rate limiters
  const loginLimiter = new RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 5,
    keyGenerator: (req) => `${req.ip}_${(req.body && req.body.email) || 'anon'}`.toLowerCase(),
  });

  const runLimiter = new RateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 10,
    keyGenerator: (req) => (req.user ? `user_${req.user.id}` : req.ip),
  });

  const app = express();
  app.disable('x-powered-by');

  // CORS Middleware
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS Not Allowed'));
      }
    },
    credentials: true,
  }));

  // Body parser
  app.use(express.json({ limit: '1mb' }));

  // Cookie parser (lightweight in-line)
  app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      cookieHeader.split(';').forEach((cookie) => {
        const parts = cookie.split('=');
        if (parts.length >= 2) {
          req.cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
        }
      });
    }
    next();
  });

  // CSRF Protection Middleware for state-changing requests
  app.use((req, res, next) => {
    const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    // Exclude public login/logout/probes from CSRF
    const isExcluded = ['/api/auth/login', '/api/auth/logout', '/livez', '/readyz'].includes(req.path);
    
    if (isStateChanging && !isExcluded) {
      const csrfHeader = req.headers['x-csrf-token'] || req.headers['x-requested-with'];
      const hasApiKey = Boolean(req.headers['x-api-key'] || (req.headers.authorization && req.headers.authorization.startsWith('Bearer cp_')));
      const hasInternalKey = Boolean(req.headers['x-internal-service-key']);
      
      // If authenticating via cookie, require custom header to prevent CSRF
      if (!csrfHeader && !hasApiKey && !hasInternalKey) {
        return res.status(403).json({ error: 'CSRF Forbidden', message: 'Missing CSRF verification header (x-csrf-token or x-requested-with)' });
      }
    }
    next();
  });

  // ==========================================
  // Public Lifecycle & Health Probes (F18)
  // ==========================================
  app.get('/livez', (req, res) => {
    if (isShutdown) {
      return res.status(503).json({ status: 'shutting_down' });
    }
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/readyz', (req, res) => {
    if (isShutdown || !db.isHealthy) {
      return res.status(503).json({ status: 'error', database: 'disconnected' });
    }
    res.status(200).json({ status: 'ok', database: 'connected' });
  });

  // ==========================================
  // Authentication & Session Endpoints (F1, F2, F3)
  // ==========================================
  
  // Super Admin Bootstrap (F2) is intentionally NOT an HTTP route — see
  // bootstrapAdminFromConfig() above, called once when this app is created.
  // (Historical note: an earlier version exposed POST /api/auth/bootstrap,
  // which was the M1 "bootstrap takeover" vulnerability; any request to that
  // path now simply falls through to the global auth barrier / 404, exactly
  // like the real server.)

  // User Login (F1, F9)
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const clientKey = `${req.ip}_${email || 'anon'}`.toLowerCase();

    // Check brute force lockout
    if (loginLimiter.isBlocked(clientKey)) {
      res.setHeader('Retry-After', 900);
      return res.status(429).json({ error: 'Too Many Requests', message: 'Account temporarily locked due to multiple failed login attempts. Try again in 15 minutes.' });
    }

    if (!email || !password || (typeof password === 'string' && !password.trim())) {
      loginLimiter.recordFailure(clientKey);
      return res.status(400).json({ error: 'Bad Request', message: 'Email and password required' });
    }

    const user = db.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      loginLimiter.recordFailure(clientKey);
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password' });
    }

    // Success: reset failures, create session
    loginLimiter.resetKey(clientKey);
    const session = db.createSession(user.id);

    // Set secure cookie
    const isProd = process.env.NODE_ENV === 'production';
    res.setHeader('Set-Cookie', `crawler_session=${session.sessionToken}; Path=/; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`);

    res.status(200).json({
      message: 'Login successful',
      user: { id: user.id, email: user.email, role: user.role },
      sessionToken: session.sessionToken,
    });
  });

  // Logout (F1)
  app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies.crawler_session || req.headers['x-session-token'];
    if (token) {
      db.deleteSession(token);
    }
    res.setHeader('Set-Cookie', 'crawler_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly');
    res.status(200).json({ message: 'Logged out successfully' });
  });

  // ==========================================
  // Auth & RBAC Middleware (F4)
  // ==========================================
  function authenticate(req, res, next) {
    // 1. Try API Key Header
    const apiKeyHeader = req.headers['x-api-key'];
    const authBearer = req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;
    
    const candidateApiKey = apiKeyHeader || authBearer;
    if (candidateApiKey && candidateApiKey.startsWith('cp_')) {
      const keyRecord = db.getApiKey(candidateApiKey);
      if (!keyRecord) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid, revoked, or expired API key' });
      }
      const user = db.getUserById(keyRecord.userId);
      req.user = { id: keyRecord.userId, role: keyRecord.role, authMethod: 'api_key', apiKeyId: keyRecord.id, email: user?.email };
      return next();
    }

    // 2. Try Session Cookie / Token
    const sessionToken = req.cookies.crawler_session || req.headers['x-session-token'];
    if (sessionToken) {
      const session = db.getSession(sessionToken);
      if (!session) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired session' });
      }
      const user = db.getUserById(session.userId);
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
      }
      req.user = { id: user.id, email: user.email, role: user.role, authMethod: 'session' };
      return next();
    }

    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }

  function requireRole(requiredRole) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (req.user.role !== requiredRole && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden', message: `Requires ${requiredRole} role permissions` });
      }
      next();
    };
  }

  // Current User Profile
  app.get('/api/auth/me', authenticate, (req, res) => {
    res.status(200).json({ user: req.user });
  });

  // ==========================================
  // MCP Bridge Lockdown (F5)
  // ==========================================
  app.post('/api/internal/mcp-bridge/query', (req, res) => {
    const providedKey = req.headers['x-internal-service-key'];
    if (!providedKey || typeof providedKey !== 'string') {
      return res.status(403).json({ error: 'Forbidden', message: 'mcp-bridge: INTERNAL_SERVICE_KEY required' });
    }

    // Constant-time comparison
    const expectedBuf = Buffer.from(internalServiceKey);
    const providedBuf = Buffer.from(providedKey);

    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return res.status(403).json({ error: 'Forbidden', message: 'mcp-bridge: Invalid service credentials' });
    }

    const { sql, params = [] } = req.body || {};
    if (!sql || typeof sql !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'SQL query required' });
    }

    // Only SELECT or WITH allowed
    const trimmed = sql.trim();
    if (!/^(SELECT|WITH)\b/i.test(trimmed) || /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i.test(trimmed)) {
      return res.status(400).json({ error: 'Bad Request', message: 'mcp-bridge: Read-only SELECT/WITH statements only' });
    }

    res.status(200).json({ rows: [{ id: 1, query_result: 'ok' }] });
  });

  // ==========================================
  // Member Routes (F4, F10, F11, F12, F13)
  // ==========================================
  
  // Create Run (Subject to Rate Limit, Emergency Freeze, Concurrency Cap, Apify Budget)
  app.post('/api/runs', authenticate, runLimiter.middleware(), (req, res) => {
    // Check Emergency Freeze (F13)
    if (isEmergencyFrozen) {
      return res.status(503).json({ error: 'Service Unavailable', message: 'Dispatch frozen by administrator emergency lock' });
    }

    // Check Concurrency Cap (F11)
    if (activeConcurrentRuns >= maxConcurrentRuns) {
      return res.status(429).json({ error: 'Too Many Requests', message: `Concurrency limit reached (${maxConcurrentRuns} active runs)` });
    }

    const { platform = 'etsy', query, isPaidActor = false } = req.body || {};

    // Check Apify Budget Kill Switch (F12)
    //
    // NOTE on divergence from the real server: server.js used to let a
    // client-supplied `isPaidActor` flag drive budget accounting directly
    // in this same POST /api/runs handler — a client could burn the budget
    // with fake paid runs, or dodge the check by omitting the flag. That
    // was fixed (see server.js's own comment above its /api/runs handler,
    // and test/apify-budget-server.test.js /
    // test/adversarial/m3_concurrency_budget_adversarial.test.js "Live
    // Vector 4"): the real server now enforces the budget only inside the
    // Apify token pool, atomically, at the moment a real actor actually
    // starts, and ignores the client's isPaidActor for accounting.
    //
    // This mock harness intentionally still models the OLD client-driven
    // behavior below. It is a deliberately simplified in-memory fake used
    // only by the F12 harness tests (test/e2e/tier1_features.test.js,
    // tier2_boundaries.test.js, tier3_combinations.test.js) to exercise the
    // *shape* of the budget-kill-switch contract (402 + APIFY_BUDGET_EXCEEDED
    // once balance is exhausted) without a real Apify token pool. Those
    // tests assert against this mock's own modeled balance
    // (`controls.getApifyBalance()`), not against server.js, so keeping the
    // simpler client-driven model here does not claim the real server still
    // works this way — the real, non-spoofable enforcement path is covered
    // separately by the live-server spawn tests referenced above. Do not
    // read this block as documentation of current server.js behavior.
    if (isPaidActor) {
      if (apifyBudgetBalance <= 0) {
        return res.status(402).json({ error: 'Payment Required', code: 'APIFY_BUDGET_EXCEEDED', message: 'Apify account budget limit reached or token balance zero' });
      }
      apifyBudgetBalance -= 1.0;
    }

    // Allocate concurrency slot
    activeConcurrentRuns++;
    const runId = db.nextRunId++;
    const run = {
      id: runId,
      platform,
      query: query || 'default search',
      userId: req.user.id,
      status: 'running',
      createdAt: new Date(),
    };
    db.runs.set(runId, run);

    res.status(201).json({ message: 'Run scheduled successfully', run });
  });

  app.get('/api/runs', authenticate, (req, res) => {
    const list = Array.from(db.runs.values());
    res.status(200).json({ runs: list });
  });

  app.get('/api/runs/:id', authenticate, (req, res) => {
    const run = db.runs.get(parseInt(req.params.id, 10));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.status(200).json({ run });
  });

  // POST /api/runs/:id/complete is intentionally NOT an HTTP route — the
  // real server has no such public endpoint either (run completion is
  // internal to the scheduler/ManagedExecution, never a caller-triggered
  // HTTP action that could let any authenticated member free up any run's
  // concurrency slot). Tests simulate completion via controls.completeRun().

  app.get('/api/items', authenticate, (req, res) => {
    res.status(200).json({ items: [] });
  });

  app.get('/api/captures', authenticate, (req, res) => {
    res.status(200).json({ captures: [] });
  });

  app.get('/api/exports', authenticate, (req, res) => {
    res.status(200).json({ exportUrl: '/downloads/export.csv' });
  });

  // ==========================================
  // Admin-Only Routes (F4, F3, F13)
  // ==========================================
  app.get('/api/tokens', authenticate, requireRole('admin'), (req, res) => {
    res.status(200).json({ tokens: Array.from(db.tokens.values()) });
  });

  app.post('/api/tokens', authenticate, requireRole('admin'), (req, res) => {
    const { token, label } = req.body || {};
    const id = Date.now();
    db.tokens.set(id, { id, token, label });
    res.status(201).json({ message: 'Token saved', id });
  });

  app.get('/api/proxies', authenticate, requireRole('admin'), (req, res) => {
    res.status(200).json({ proxies: Array.from(db.proxies.values()) });
  });

  app.post('/api/proxies', authenticate, requireRole('admin'), (req, res) => {
    const { proxyUrl } = req.body || {};
    const id = Date.now();
    db.proxies.set(id, { id, proxyUrl });
    res.status(201).json({ message: 'Proxy added', id });
  });

  app.get('/api/sessions', authenticate, requireRole('admin'), (req, res) => {
    res.status(200).json({ sessions: Array.from(db.sessions.values()) });
  });

  app.get('/api/doctor', authenticate, requireRole('admin'), (req, res) => {
    res.status(200).json({ system: 'healthy', database: 'connected', scheduler: 'active' });
  });

  app.get('/api/system/info', authenticate, requireRole('admin'), (req, res) => {
    res.status(200).json({ nodeVersion: process.version, uptime: process.uptime(), memoryUsage: process.memoryUsage() });
  });

  // Emergency Freeze Toggle (F13)
  app.post('/api/admin/freeze', authenticate, requireRole('admin'), (req, res) => {
    const { frozen } = req.body || {};
    isEmergencyFrozen = Boolean(frozen);
    res.status(200).json({ message: `Emergency freeze ${isEmergencyFrozen ? 'ENABLED' : 'DISABLED'}`, isFrozen: isEmergencyFrozen });
  });

  app.get('/api/admin/freeze', authenticate, requireRole('admin'), (req, res) => {
    res.status(200).json({ isFrozen: isEmergencyFrozen });
  });

  // Bulk Delete (F4)
  app.post('/api/admin/bulk-delete', authenticate, requireRole('admin'), (req, res) => {
    const { entity } = req.body || {};
    res.status(200).json({ message: `Bulk delete performed on ${entity || 'all'}` });
  });

  // Issue API Key (F3)
  app.post('/api/auth/api-keys', authenticate, requireRole('admin'), (req, res) => {
    const { name, role = 'member', prefix = 'cp_live_', expiresInDays = 30 } = req.body || {};
    const result = db.createApiKey({ userId: req.user.id, name, role, prefix, expiresInDays });
    res.status(201).json({
      message: 'API Key issued successfully',
      rawKey: result.rawKey,
      id: result.record.id,
      role: result.record.role,
      expiresAt: result.record.expiresAt,
    });
  });

  app.delete('/api/auth/api-keys/:id', authenticate, requireRole('admin'), (req, res) => {
    const success = db.revokeApiKey(parseInt(req.params.id, 10));
    if (!success) return res.status(404).json({ error: 'API key not found' });
    res.status(200).json({ message: 'API key revoked' });
  });

  // ==========================================
  // Export State & Controls for Tests
  // ==========================================
  const controls = {
    db,
    setEmergencyFrozen: (val) => { isEmergencyFrozen = Boolean(val); },
    getEmergencyFrozen: () => isEmergencyFrozen,
    setApifyBalance: (val) => { apifyBudgetBalance = val; },
    getApifyBalance: () => apifyBudgetBalance,
    getActiveRunsCount: () => activeConcurrentRuns,
    setActiveRunsCount: (val) => { activeConcurrentRuns = val; },
    // Test-only equivalent of the removed public POST /api/runs/:id/complete
    // route: marks a run completed and frees its concurrency slot, without
    // exposing that as an HTTP action any authenticated caller could hit.
    completeRun: (runId) => {
      const run = db.runs.get(parseInt(runId, 10));
      if (!run) return null;
      run.status = 'completed';
      if (activeConcurrentRuns > 0) activeConcurrentRuns--;
      return run;
    },
    simulateShutdown: () => { isShutdown = true; },
    simulateRestore: () => { isShutdown = false; },
    loginLimiter,
    runLimiter,
  };

  return { app, controls };
}

// ==========================================
// 6. Test Server Lifecycle Wrapper
// ==========================================

async function withTestServer(options = {}, testFn) {
  const { app, controls } = createTestApp(options);
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      try {
        await testFn(baseUrl, controls);
        server.close(resolve);
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

// ==========================================
// 7. Backup & Restore Simulation Engine (F14, F15)
// ==========================================

function createPostgresBackupManifest(tables = ['users', 'user_sessions', 'api_keys', 'runs'], dumpContent = '-- PostgreSQL Dump') {
  const hash = crypto.createHash('sha256').update(dumpContent).digest('hex');
  return {
    manifest: {
      version: '1.0.0',
      engine: 'postgresql',
      createdAt: new Date().toISOString(),
      tables,
      sha256: hash,
    },
    dumpContent,
  };
}

function verifyAndRestoreBackup(manifest, dumpContent, options = {}) {
  if (!manifest || manifest.engine !== 'postgresql') {
    throw new Error('Invalid manifest: engine must be postgresql');
  }
  const calculatedHash = crypto.createHash('sha256').update(dumpContent).digest('hex');
  if (calculatedHash !== manifest.sha256) {
    throw new Error(`Checksum mismatch: expected ${manifest.sha256}, got ${calculatedHash}`);
  }
  if (options.dryRun) {
    return { success: true, dryRun: true, tableCount: manifest.tables.length };
  }
  return { success: true, restoredAt: new Date(), tables: manifest.tables };
}

module.exports = {
  createTestApp,
  withTestServer,
  InMemoryDatabase,
  RateLimiter,
  validateOutboundUrl,
  safeFetch,
  SSRFSecurityError,
  hashPassword,
  verifyPassword,
  hashApiKey,
  generateApiKey,
  createPostgresBackupManifest,
  verifyAndRestoreBackup,
};
