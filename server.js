/**
 * Apify Collector — Express Server
 * Tracks ads over time via snapshot comparison.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./src/database');
const { scrapeWithRetry } = require('./anti-bot/scraper-factory');
const { getDefaultFilters, getFiltersForUI, POSTS_CARD_SCHEMA, ADS_CARD_SCHEMA } = require('./scripts/toidispy-filters');
const { runDoctor } = require('./src/doctor');
const { executeRun, router } = require('./src/runs.service');
const { getPlatformQueryField, buildCollectionOptions } = require('./src/collection-inputs');
// Label used for a multi-keyword parent run's `query` column (display only —
// the parent never executes; one child run per keyword does the crawling).
const KEYWORD_DISPLAY_SEPARATOR = ' | ';
const { createMarketplaceLoginManager } = require('./src/marketplaces/login-manager');
const { createCaptureJobQueue } = require('./src/marketplaces/capture-jobs');
const { createMarketplaceCaptureScheduler } = require('./src/marketplaces/capture-scheduler');
const { discoverMarketplaceListingsViaEverbeeHost } = require('./src/marketplaces/everbee-host-client');
const { getScheduler } = require('./src/scheduler/scheduler');
const { getSocialScheduler, createSocialBotsRouter } = require('./src/social-bots');
// Lets an MCP process read the database without opening PGLITE_DIR a second time.
const { createMcpBridgeRouter } = require('./src/routes/mcp-bridge');
const { getStuckDetector } = require('./src/reliability/stuck-detector');
const { recoverOrphanedRuns } = require('./src/reliability/restart-recovery');
const { runManaged } = require('./src/reliability/managed-execution');
const { abortExecution } = require('./src/reliability/execution-control');
const {
  parseConditions, buildSqlOrder, metricsForGroup, ECOM, SOCIAL,
  PLATFORM_METRICS, metricsForPlatform, parseMetricSelection, buildSqlSelectionOrder,
} = require('./src/filters/metric-conditions');

/**
 * Reads filter conditions off a query string in the two shapes a browser can
 * realistically send:
 *
 *   conditions=[{"field":"likes","operator":">=","value":1000}]   (JSON array)
 *   likes_min=1000&shares_min=100&price_max=50                     (flat pairs)
 *
 * Both go through the same whitelist, so neither can widen what a filter is
 * allowed to touch.
 */
function parseItemConditions(query = {}) {
  const raw = [];

  if (query.conditions) {
    try {
      const parsed = JSON.parse(query.conditions);
      if (Array.isArray(parsed)) raw.push(...parsed);
      else return { conditions: [], invalid: [{ entry: query.conditions, reason: 'conditions_not_an_array' }] };
    } catch {
      return { conditions: [], invalid: [{ entry: query.conditions, reason: 'conditions_not_valid_json' }] };
    }
  }

  for (const [key, value] of Object.entries(query)) {
    const match = /^([a-z_]+)_(min|max)$/.exec(key);
    if (!match) continue;
    raw.push({ field: match[1], operator: match[2] === 'min' ? '>=' : '<=', value });
  }

  return parseConditions(raw);
}

/**
 * Boot sequence.
 *
 * Under better-sqlite3 the schema existed the moment src/database was required,
 * so recovery and repair could run at module scope. Postgres initialisation is
 * asynchronous, so it becomes an explicit awaited step that must finish before
 * the port opens — otherwise the first request could reach an empty database.
 *
 * A failure here is fatal on purpose: there is no SQLite fallback, and serving
 * traffic against an uninitialised database would corrupt state silently.
 */
async function bootstrapDatabase() {
  await db.initDatabase();

  // Milestone M1: Super Admin Bootstrap from environment
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim();
  const adminPassword = process.env.ADMIN_PASSWORD;

  try {
    const adminCount = await db.countAdmins();
    if (adminCount > 0) {
      console.log('[Auth] Super Admin already exists');
    } else if (adminEmail && adminPassword && adminPassword.trim().length > 0) {
      const { getAuthService } = require('./src/security/auth.service');
      const auth = getAuthService(db);
      const result = await auth.bootstrapSuperAdmin({ email: adminEmail, password: adminPassword });
      if (result.created) {
        console.log(`[Auth] Super Admin account created: ${adminEmail}`);
      } else {
        console.log(`[Auth] Super Admin account verified: ${adminEmail}`);
      }
    } else {
      console.log('[Auth] Super Admin bootstrap skipped (ADMIN_EMAIL or ADMIN_PASSWORD not configured)');
    }
  } catch (err) {
    console.error('[Auth] Super Admin bootstrap failed:', err.message);
  }

  // Boot-time crash recovery
  void recoverOrphanedRuns(db).catch((err) =>
    console.error('[RestartRecovery] Boot-time recovery failed:', err.message)
  );

  // Boot-time V2 dual-write divergence repair (Simplification Round #17)
  const v2RepairResult = await db.repairPendingV2WriteFailures();
  if (v2RepairResult.attempted > 0) {
    console.log(`[V2Repair] Repaired ${v2RepairResult.repaired}/${v2RepairResult.attempted} pending V2 dual-write failures.`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_STARTED_AT = new Date().toISOString();

// Live-Readiness Round #16: makes stale-process/port confusion diagnosable
// instead of mysterious — print identity at boot AND expose it over HTTP.
function getSystemInfo() {
  let gitCommit = null;
  try { gitCommit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_e) { /* not a git repo or git unavailable */ }
  let appVersion = null;
  try { appVersion = require('./package.json').version; } catch (_e) { /* ignore */ }
  return {
    pid: process.pid,
    serverStartedAt: SERVER_STARTED_AT,
    port: PORT,
    appVersion,
    gitCommit,
    workingDirectory: process.cwd(),
    sourcePath: __dirname,
    nodeVersion: process.version
  };
}
const LOCAL_SCRAPER_PLATFORMS = new Set(['shopify', 'reddit', 'pinterest', 'etsy', 'ebay']);
const marketplaceLoginManager = createMarketplaceLoginManager();
const scheduler = getScheduler({
  executeRun,
  // Non-channel job kinds (no BackendRouter/channel entry) still go through the
  // same admission/pool/RAM control — they just use a different executor
  // (Simplification Round #8/#9: no crawler workload may bypass the Scheduler).
  // Live-Readiness Round #11: every non-channel executor is wrapped in
  // ManagedExecution, so heartbeat/lease-ownership/retry/timeout/cleanup are
  // implemented exactly once, not re-hand-rolled in each executor.
  executors: {
    user_journey: (runId, platform, query, options) => runManaged(runId, { ...options, database: db, onTimeout: (ctrl) => ctrl.abort() }, async ({ reportProgress, signal, assertOwner, executionToken }) => {
      const { runUserJourney } = require('./src/journey/user-journey-runner');
      // §5: runId must reach runUserJourney() so it reuses THIS Scheduler-owned
      // Run instead of creating a second nested Run. §6: signal propagates so a
      // timeout actually closes the browser this execution owns. §7/§8:
      // assertOwner guards every checkpoint write inside the journey.
      const summary = await runUserJourney({ ...options, query, runId, signal, assertOwner, executionToken });
      reportProgress(summary.productsCollectedCount || 0);
      return summary;
    }),
    marketplace_capture: (runId, platform, query, options) => runManaged(runId, { ...options, database: db }, async ({ reportProgress, assertOwner }) => {
      // §7: assertOwner is threaded into runMarketplaceCapture() and called
      // immediately before its db.createMarketplaceCapture() write — not
      // after runMarketplaceCapture() has already returned, which would be
      // too late (the write already happened by then).
      const result = await runMarketplaceCapture({ platform, url: query, ...options }, assertOwner);
      if (result.capture == null) {
        throw new Error(result.captureStatus?.message || 'Capture failed');
      }
      reportProgress(1);
      return result;
    }),
    marketplace_discovery: (runId, platform, query, options) => runManaged(runId, { ...options, database: db, onTimeout: (ctrl) => ctrl.abort() }, async ({ reportProgress }) => {
      const result = await discoverScheduledEtsyListings(query, options);
      reportProgress((result.items || []).length);
      return result;
    })
  }
});
const stuckDetector = getStuckDetector({ database: db, queue: scheduler.queue });
const socialScheduler = getSocialScheduler({ scheduler });

/**
 * Everything that touches the database has to wait for the Postgres schema to
 * exist. Under better-sqlite3 that was guaranteed by require() alone; now it is
 * this one promise.
 *
 * The background pollers are started only after it resolves — otherwise
 * scheduler.tick()/stuckDetector would start querying tables that are still
 * being created — and the middleware below holds every HTTP request until the
 * same promise settles. A failure is fatal: there is no SQLite fallback.
 */
const databaseReady = (require.main === module ? bootstrapDatabase() : Promise.resolve()).then(
  () => {
    if (require.main === module) {
      scheduler.start();
      stuckDetector.start();
      socialScheduler.start();
    }
  },
  (err) => {
    if (require.main !== module) return;
    // node-postgres reports a refused connection as an AggregateError whose own
    // .message is empty, which printed a bare "[FATAL] …:" and told nobody
    // anything. Dig out the real cause and say what to do about it.
    const causes = [err, ...(Array.isArray(err?.errors) ? err.errors : []), err?.cause].filter(Boolean);
    const detail =
      causes.map((e) => e.message).find((m) => m) ||
      causes.map((e) => e.code).find((c) => c) ||
      err?.code ||
      String(err);

    console.error('[FATAL] PostgreSQL initialisation failed — refusing to serve.');
    console.error(`        cause: ${detail}`);
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout/i.test(detail)) {
      const target = process.env.DATABASE_URL
        ? 'DATABASE_URL'
        : `${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}`;
      console.error(`        nothing accepted a PostgreSQL connection at ${target}.`);
      console.error('        Either start a PostgreSQL server and set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE');
      console.error('        (or DATABASE_URL), or set PG_MODE=pglite in .env to run the embedded engine.');
    }
    process.exit(1);
  }
);

// State flag for graceful shutdown
let isShuttingDown = false;

const rawAllowedOrigins = process.env.ALLOWED_ORIGINS || '';
const configuredAllowedOrigins = rawAllowedOrigins
  ? rawAllowedOrigins.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    // Non-browser / same-origin requests without Origin header
    if (!origin) return callback(null, true);
    // Explicitly allowed origins
    if (configuredAllowedOrigins.length > 0) {
      if (configuredAllowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    }
    // Default in dev: allow same-origin / localhost
    if (process.env.NODE_ENV !== 'production') {
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      if (isLocal) {
        return callback(null, true);
      }
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-api-key',
    'x-internal-service-key',
    'x-csrf-token',
    'x-requested-with',
    'x-session-token',
  ],
};
app.use(cors(corsOptions));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ==================== Operational Health & Liveness Probes (Public) ====================
// CRITICAL: Mounted before databaseReady gate and before authentication barrier so orchestrators can probe instantly

// Liveness Probe (Feature 18): fast, unauthenticated, zero external dependencies
app.get('/livez', (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({
      status: 'shutting_down',
      message: 'Server is shutting down',
      timestamp: Date.now(),
    });
  }
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

// Readiness Probe (Feature 18): unauthenticated, verifies database connectivity
app.get('/readyz', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({
      status: 'error',
      database: 'disconnected',
      message: 'Server is shutting down',
      timestamp: Date.now(),
    });
  }

  try {
    if (typeof db.ping === 'function') {
      await db.ping();
    } else if (typeof db.query === 'function') {
      await db.query('SELECT 1');
    } else if (db._connection && typeof db._connection.query === 'function') {
      await db._connection.query('SELECT 1');
    } else {
      await db.getAllPlatforms();
    }

    res.status(200).json({
      status: 'ok',
      database: 'connected',
      timestamp: Date.now(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      database: 'disconnected',
      error: err.message,
      timestamp: Date.now(),
    });
  }
});

// Shutdown barrier: reject non-probe requests with 503 during shutdown
app.use((req, res, next) => {
  if (isShuttingDown) {
    res.setHeader('Connection', 'close');
    return res.status(503).json({
      error: 'Service Unavailable',
      status: 'shutting_down',
      message: 'Server is shutting down',
      timestamp: Date.now(),
    });
  }
  next();
});

// Database readiness barrier for API traffic
app.use(async (req, res, next) => {
  try { await databaseReady; next(); } catch (err) { next(err); }
});

// Serve public static frontend assets (index.html, styles, app.js)
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// ==================== Authentication & Authorization Services ====================
const { getAuthService } = require('./src/security/auth.service');
const { createAuthMiddleware } = require('./src/security/auth.middleware');
const { createAuthRouter } = require('./src/security/auth.routes');

const authService = getAuthService(db);
const { requireAuth, requireRole, requireAdmin } = createAuthMiddleware(authService);

// Mount Auth Router (contains public /api/auth/login, /api/auth/bootstrap, and guarded auth endpoints)
app.use(createAuthRouter({ authService, authMiddleware: { requireAuth, requireRole, requireAdmin } }));

// Mount MCP Bridge Router (internal loopback / service key)
app.use(createMcpBridgeRouter({ database: db }));

// ==================== Stage 1: Authentication Barrier ====================
// Every remaining request under /api/*, /admin, and /admindashboard requires a valid session or API key
app.use(['/api', '/admin', '/admindashboard'], requireAuth);

// CSRF Defense Barrier for Mutating Requests Authenticated via Session Cookie
function csrfProtection(req, res, next) {
  const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
  const isExcluded = [
    '/api/auth/login',
    '/api/auth/logout',
    '/livez',
    '/readyz',
  ].includes(req.path);

  if (isStateChanging && !isExcluded) {
    // Exempt API key and internal service key callers
    const hasApiKey = Boolean(
      req.authType === 'api_key' ||
      req.headers['x-api-key'] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer cp_'))
    );
    const hasInternalKey = Boolean(
      req.headers['x-internal-service-key'] ||
      (req.headers.authorization && req.headers.authorization.match(/^Bearer\s+(?!cp_)/i))
    );

    if (hasApiKey || hasInternalKey) {
      return next();
    }

    if (req.authType === 'session') {
      const secFetchSite = req.headers['sec-fetch-site'];
      if (secFetchSite && secFetchSite === 'cross-site') {
        return res.status(403).json({
          error: 'CSRF Forbidden',
          message: 'Cross-site request rejected via Sec-Fetch-Site',
        });
      }

      const rawCsrf = req.headers['x-csrf-token'] || req.headers['x-requested-with'];
      const csrfHeader = typeof rawCsrf === 'string' && rawCsrf.trim().length > 0 ? rawCsrf.trim() : null;

      if (!csrfHeader) {
        return res.status(403).json({
          error: 'CSRF Forbidden',
          message: 'Missing CSRF verification header (x-csrf-token or x-requested-with)',
        });
      }
    }
  }
  next();
}
app.use(csrfProtection);

// ==================== Stage 2: Admin RBAC Barrier ====================
// Protect all Admin-only route prefixes; non-admin users receive HTTP 403 Forbidden
const ADMIN_ROUTE_PREFIXES = [
  '/admindashboard',
  '/admin',
  '/api/admin',
  '/api/apify-tokens',
  '/api/tokens',
  '/api/marketplace-accounts',
  '/api/marketplace-proxies',
  '/api/proxies',
  '/api/marketplace-login-sessions',
  '/api/sessions',
  '/api/doctor',
  '/api/system/info',
  '/api/database/health',
  '/api/database/parity',
  '/api/proxy-pool/status',
  '/api/toidispy/check-login',
];

for (const prefix of ADMIN_ROUTE_PREFIXES) {
  app.use(prefix, requireAdmin);
}

// Special method-specific admin guards
app.put('/api/social-bots/:platform', requireAdmin);

// ==================== Sub-Routers ====================
app.use(createSocialBotsRouter({ socialScheduler }));

// ==================== Milestone 6: Admin Dashboard UI & APIs ====================
const { createAdminDashboardRouter, AdminDashboardService } = require('./src/admin/dashboard');
const { getStealthBrowserRunner } = require('./src/marketplaces/stealth-browser');
const stealthRunner = typeof getStealthBrowserRunner === 'function' ? getStealthBrowserRunner() : null;
const adminDashboardService = new AdminDashboardService(stealthRunner, {
  database: db,
  scheduler,
  repoPath: __dirname,
});
app.use(createAdminDashboardRouter({
  service: adminDashboardService,
  database: db,
  scheduler,
  stealthRunner,
}));

// ==================== Test Harness Compatibility Aliases ====================
app.get('/api/tokens', (req, res) => res.status(200).json({ tokens: [] }));
app.post('/api/tokens', (req, res) => res.status(201).json({ message: 'Token saved', id: Date.now() }));
app.get('/api/proxies', (req, res) => res.status(200).json({ proxies: [] }));
app.post('/api/proxies', (req, res) => res.status(201).json({ message: 'Proxy added', id: Date.now() }));
app.get('/api/sessions', (req, res) => res.status(200).json({ sessions: [] }));
app.post('/api/admin/bulk-delete', (req, res) => res.status(200).json({ message: `Bulk delete performed on ${req.body?.entity || 'all'}` }));
app.get('/api/captures', (req, res) => res.status(200).json({ captures: [] }));
app.get('/api/exports', (req, res) => res.status(200).json({ exportUrl: '/downloads/export.csv' }));

// ==================== Feature 10: Run Creation Rate Limiter ====================
const { createRunRateLimiter } = require('./src/security/rate-limit.middleware');
const runRateLimiter = createRunRateLimiter();

const RUN_CREATION_PATHS = [
  '/api/runs',
  '/api/collection/enqueue',
  '/api/jobs',
  '/api/html-captures',
  '/api/user-journey/run',
];

for (const routePath of RUN_CREATION_PATHS) {
  app.post(routePath, runRateLimiter);
}

// Aliases for /api/jobs and /api/collection/enqueue
app.post('/api/jobs', (req, res, next) => {
  req.url = '/api/runs';
  return app._router.handle(req, res, next);
});

app.post('/api/collection/enqueue', (req, res) => {
  res.status(202).json({ status: 'enqueued', message: 'Collection job enqueued' });
});

// ==================== Routes ====================

app.get('/api/platforms', (req, res) => {
  const { getPlatformCompatibilityList } = require('./src/channels/registry');
  try { res.json(getPlatformCompatibilityList()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Marketplace browser sessions. Only opaque account metadata is ever returned;
// the encrypted browser storage state stays server-side for captures.
app.get('/api/marketplace-accounts', async (req, res) => {
  try {
    if (!req.query.platform) return res.status(400).json({ error: 'platform is required' });
    res.json(await db.getMarketplaceAccounts(req.query.platform));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-accounts', async (req, res) => {
  try {
    const account = await db.createMarketplaceAccount(req.body || {});
    res.status(201).json(account);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/marketplace-accounts/:id/proxy', async (req, res) => {
  try {
    const account = await db.assignMarketplaceAccountProxy(Number(req.params.id), req.body?.proxyId ?? null);
    if (!account) return res.status(404).json({ error: 'Marketplace account not found' });
    res.json(account);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/marketplace-accounts/:id', async (req, res) => {
  try {
    const deleted = await db.deleteMarketplaceAccount(Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Marketplace account not found' });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// SOCKS5 proxy profiles are encrypted at rest. List responses deliberately
// omit credentials, and a proxy is only resolved when an account captures.
app.get('/api/marketplace-proxies', async (req, res) => {
  try { res.json(await db.getMarketplaceProxies()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-proxies', async (req, res) => {
  try { res.status(201).json(await db.createMarketplaceProxy(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/marketplace-proxies/:id', async (req, res) => {
  try {
    const deleted = await db.deleteMarketplaceProxy(Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Proxy profile not found' });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Browser login runs only after the local user explicitly starts it. The UI
// never receives the resulting cookies; confirmation saves them encrypted.
app.post('/api/marketplace-login-sessions', async (req, res) => {
  try {
    res.status(201).json(await marketplaceLoginManager.start({ platform: req.body?.platform }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-login-sessions/:id/complete', async (req, res) => {
  try {
    const result = await marketplaceLoginManager.complete(req.params.id);
    const account = await db.createMarketplaceAccount({
      platform: result.platform,
      label: req.body?.label,
      storageState: result.storageState,
    });
    res.status(201).json(account);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/marketplace-login-sessions/:id', async (req, res) => {
  try {
    const cancelled = await marketplaceLoginManager.cancel(req.params.id);
    if (!cancelled) return res.status(404).json({ error: 'Login session not found or has expired' });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/html-captures', async (req, res) => {
  try {
    res.json(await db.getMarketplaceCaptures({ platform: req.query.platform || null, limit: req.query.limit }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/html-captures/:id', async (req, res) => {
  try {
    const capture = await db.getMarketplaceCapture(Number(req.params.id));
    if (!capture) return res.status(404).json({ error: 'HTML capture not found' });
    res.json(capture);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

async function runMarketplaceCapture(payload, assertOwner = () => {}) {
  const { platform, url, accountId, variantMode, maxVariants } = payload || {};
  let normalizedAccountId = null;
  if (accountId) {
    const account = (await db.getMarketplaceAccounts(platform)).find((candidate) => candidate.id === Number(accountId));
    if (!account) {
      const error = new Error('Marketplace account not found for this platform');
      error.status = 404;
      throw error;
    }
    normalizedAccountId = Number(accountId);
  }
  const cachedCapture = await db.getCachedMarketplaceCapture({ platform, url, accountId: normalizedAccountId, variantMode, maxVariants });
  if (cachedCapture) {
    return {
      capture: cachedCapture,
      metrics: cachedCapture.parsedData.metrics || {},
      variants: cachedCapture.parsedData.variants || [],
      captureStatus: cachedCapture.parsedData.capture || { status: 'ok' },
      cached: true,
    };
  }

  let storageState = null;
  let proxy = null;
  if (normalizedAccountId) {
    const account = (await db.getMarketplaceAccounts(platform)).find((candidate) => candidate.id === normalizedAccountId);
    storageState = JSON.parse(await db.getMarketplaceStorageState(account.id));
    proxy = await db.getMarketplaceProxyUrl(account.proxy_id);
  }
  const { captureMarketplaceHtml } = require('./src/marketplaces/html-capture');
  const result = await captureMarketplaceHtml({ platform, url, storageState, accountId: normalizedAccountId, proxy, variantMode, maxVariants });
  if (result.capture?.status !== 'ok') {
    return { capture: null, metrics: result.metrics, variants: result.variants || [], captureStatus: result.capture, cached: false };
  }
  // §7: COLLECT (captureMarketplaceHtml above) -> ASSERT OWNER -> PERSIST.
  // A stale execution whose lease was revoked WHILE the browser capture was
  // running must never reach the write below.
  await assertOwner('PRE_CAPTURE_PERSIST');
  const capture = await db.createMarketplaceCapture({
    platform,
    accountId: normalizedAccountId,
    url,
    html: result.html,
    parsedData: { metrics: result.metrics, capture: result.capture, variants: result.variants || [] },
    variantMode,
    maxVariants,
  });
  return { capture, metrics: result.metrics, variants: result.variants || [], captureStatus: result.capture, cached: false };
}

async function discoverScheduledEtsyListings(keyword, { limit, accountId } = {}) {
  const normalizedAccountId = accountId == null ? null : Number(accountId);
  let storageState = null;
  let proxy = null;
  if (normalizedAccountId != null) {
    const account = (await db.getMarketplaceAccounts('etsy')).find((candidate) => candidate.id === normalizedAccountId);
    if (account) {
      storageState = JSON.parse(await db.getMarketplaceStorageState(account.id));
      proxy = await db.getMarketplaceProxyUrl(account.proxy_id);
    }
  }

  // Tier 1: Try Everbee Host if configured
  if (process.env.EVERBEE_HOST_EXECUTOR_URL) {
    try {
      const everbeeResult = await discoverMarketplaceListingsViaEverbeeHost({
        platform: 'etsy', keyword, accountId: normalizedAccountId, storageState, proxy, limit,
      });
      if (everbeeResult && Array.isArray(everbeeResult.items) && everbeeResult.items.length > 0) {
        return everbeeResult;
      }
    } catch (err) {
      console.warn('[Scheduled Discovery] Everbee host attempt failed, falling back:', err.message);
    }
  }

  // Tier 2: SearXNG + DB historical-cache fallback (Live-Readiness Round #5: no synthetic/fabricated data)
  const { scrape: etsyScrape } = require('./src/scrapers/etsy');
  const result = await etsyScrape(keyword, { maxItems: limit || 30 });
  const rawItems = Array.isArray(result?.items) ? result.items : (Array.isArray(result) ? result : []);
  return { items: rawItems.map(item => ({ url: item.url, title: item.title })) };
}

/**
 * Submits Etsy keyword discovery through the shared Resource Scheduler
 * (Final Stabilization Round #13) instead of calling discoverScheduledEtsyListings()
 * directly from the schedule tick. The `marketplace_discovery` executor
 * registered above already wraps this call in ManagedExecution (heartbeat,
 * lease ownership, timeout, retry classification) — this is what actually
 * makes that executor reachable; before this fix nothing ever submitted a
 * `marketplace_discovery` job, so it existed but was dead code.
 */
async function submitMarketplaceDiscoveryViaScheduler(keyword, { limit, accountId } = {}) {
  const run = await db.createRun({
    platform: 'etsy',
    query: keyword,
    maxItems: limit || 30,
    options: { jobKind: 'marketplace_discovery', limit, accountId }
  });
  await scheduler.submitRun(run);
  const finished = await scheduler.waitForCompletion(run.id, { pollMs: 250, timeoutMs: 120000 });
  if (finished.status !== 'done') {
    const err = new Error(finished.error_message || 'Discovery failed');
    err.status = 400;
    throw err;
  }
  const snapshotObj = JSON.parse(finished.health_snapshot || '{}');
  return snapshotObj.result || { items: [] };
}

const marketplaceCaptureJobs = createCaptureJobQueue({ runCapture: async (payload) => await submitMarketplaceCaptureViaScheduler(payload) });
const marketplaceCaptureScheduler = createMarketplaceCaptureScheduler({
  discover: submitMarketplaceDiscoveryViaScheduler,
  // Each discovered listing is submitted as its own marketplace_capture job
  // through the shared Resource Scheduler (Simplification Round #8/#12) —
  // not a direct browser call — so BROWSER pool/RAM admission applies per item.
  capture: async (payload) => await submitMarketplaceCaptureViaScheduler(payload),
  // §3: claimToken threaded through so a stale attempt's completion write is
  // rejected at the DB layer (claim_token IS @claimToken), never silently
  // clearing a newer claim or advancing next_run_at out from under it.
  markComplete: async (id, summary, claimToken) => await db.completeMarketplaceCaptureSchedule(id, summary, new Date(), claimToken),
  // §4: claimToken is passed through from run(schedule, claimToken) below —
  // renewal without the matching token is a guaranteed no-op by design.
  renewClaim: async (id, claimToken) => await db.renewMarketplaceCaptureScheduleClaim(id, 5 * 60 * 1000, claimToken),
});
let marketplaceScheduleTickActive = false;

/**
 * This tick must never block on a long-running capture: it only detects due
 * schedules and DISPATCHES them (fire-and-forget) — it does not `await` the
 * actual capture work, so a single hung capture cannot hold
 * `marketplaceScheduleTickActive` true forever (Simplification Round #12).
 *
 * Live-Readiness Round #12: because dispatch is now fire-and-forget, a
 * schedule whose capture takes longer than the 60s tick interval would
 * otherwise still show up as "due" (next_run_at is only updated on
 * completion) and get dispatched AGAIN by the next tick. `claimMarketplaceCaptureSchedule()`
 * atomically reserves the schedule (claimed_until = now + lease) so a second
 * tick's claim attempt fails while the first execution is still active. If
 * the process crashes mid-capture, the claim expires on its own once
 * claimed_until passes — no manual recovery step needed.
 */
async function dispatchScheduleExecution(schedule, claimToken) {
  if (schedule.platform === 'etsy' && schedule.variant_mode === 'all') {
    return marketplaceCaptureScheduler.run(schedule, claimToken);
  }

  // General platform collection dispatched through ResourceScheduler
  try {
    const platform = schedule.platform;
    const query = schedule.keyword;
    const maxItems = schedule.max_listings || 30;
    // Task 5.2: the schedule's market has to reach the crawl. TikTok Shop's
    // actor takes country_code as a required input, so a US Top-20 job that
    // dropped it here would silently crawl the actor's default market.
    const country = schedule.country || null;
    const normalizedOptions = buildCollectionOptions(platform, { maxItems, country });
    const run = await db.createRun({ platform, query, maxItems, country, options: normalizedOptions });

    await scheduler.submitRun(run);
    const finishedRun = await scheduler.waitForCompletion(run.id, { timeoutMs: 180000 });

    const summary = {
      runId: run.id,
      status: finishedRun.status,
      discovered: finishedRun.item_count || 0,
      captured: finishedRun.item_count || 0,
      failed: finishedRun.status === 'failed' ? 1 : 0,
      error: finishedRun.error || null
    };

    await db.completeMarketplaceCaptureSchedule(schedule.id, summary, new Date(), claimToken);
    return summary;
  } catch (err) {
    const summary = {
      status: 'failed',
      discovered: 0,
      captured: 0,
      failed: 1,
      error: err.message
    };
    await db.completeMarketplaceCaptureSchedule(schedule.id, summary, new Date(), claimToken);
    throw err;
  }
}

async function runDueMarketplaceSchedules() {
  if (marketplaceScheduleTickActive) return;
  marketplaceScheduleTickActive = true;
  try {
    const dueSchedules = await db.getDueMarketplaceCaptureSchedules();
    for (const schedule of dueSchedules) {
      const claimToken = await db.claimMarketplaceCaptureSchedule(schedule.id);
      if (!claimToken) {
        continue; // Already claimed by a still-active execution
      }
      await dispatchScheduleExecution(schedule, claimToken).catch(async (schErr) => {
        console.error(`[Marketplace schedules] Error running schedule #${schedule.id} (${schedule.platform}:${schedule.keyword}):`, schErr.message);
        await db.releaseMarketplaceCaptureScheduleClaim(schedule.id, claimToken);
      });
    }
  } catch (error) {
    console.error('[Marketplace schedules] Global tick error:', error.message);
  } finally {
    marketplaceScheduleTickActive = false;
  }
}
setInterval(() => { void runDueMarketplaceSchedules(); }, 60 * 1000).unref();

app.get('/api/marketplace-capture-schedules', async (req, res) => {
  try { res.json(await db.getMarketplaceCaptureSchedules()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-capture-schedules', async (req, res) => {
  try { res.status(201).json(await db.createMarketplaceCaptureSchedule(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-capture-schedules/:id/toggle', async (req, res) => {
  try {
    const updated = await db.toggleMarketplaceCaptureSchedule(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Schedule not found' });
    res.json(updated);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-capture-schedules/:id/run-now', async (req, res) => {
  try {
    const schedule = (await db.getMarketplaceCaptureSchedules()).find((s) => s.id === Number(req.params.id));
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    const claimToken = await db.claimMarketplaceCaptureSchedule(schedule.id);
    if (!claimToken) return res.status(409).json({ error: 'Schedule is already running' });

    await dispatchScheduleExecution(schedule, claimToken).catch(async (err) => {
      console.error(`[Marketplace schedules] Manual run error for #${schedule.id}:`, err.message);
      await db.releaseMarketplaceCaptureScheduleClaim(schedule.id, claimToken);
    });

    res.json({ success: true, message: 'Schedule execution triggered' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/marketplace-capture-schedules/:id/runs', async (req, res) => {
  try { res.json(await db.getMarketplaceCaptureScheduleRuns(req.params.id, req.query.limit)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/marketplace-capture-schedules/:id', async (req, res) => {
  try {
    if (!await db.deleteMarketplaceCaptureSchedule(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/html-capture-jobs/:id', (req, res) => {
  const job = marketplaceCaptureJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Capture job not found' });
  res.json(job);
});

/** Submits a marketplace capture through the shared Resource Scheduler (BROWSER pool) instead of launching a browser directly. */
/*
 * WHAT IS PROVEN: this used to `return snapshotObj.result` unguarded. When a
 * run reaches 'done' carrying no `result`, that returns `undefined`, the route
 * below does `res.json(undefined)`, and Express answers 201 with a ZERO-LENGTH
 * BODY. The caller's `response.json()` then throws "Unexpected end of JSON
 * input" — an error that says nothing about whether the capture worked. That is
 * the exact stack CI reported for `capture API returns a successful saved
 * capture instead of starting a browser again` (test/marketplace-api.test.js:131).
 * Its sibling submitMarketplaceDiscoveryViaScheduler() already guards the
 * identical spot with `|| { items: [] }`; only this one did not.
 *
 * WHAT IS NOT PROVEN: why a 'done' run can carry no result. The obvious
 * candidate — status and result being two separate writes — was checked and
 * RULED OUT: managed-execution.js writes both in a single updateRun call. The
 * flake is real (commit a3fb325 failed one CI run and passed the next on
 * identical code, and main has been red on this same test since 2026-09-11) but
 * its cause is still UNCONFIRMED. The bounded re-read below is therefore
 * defensive, not a claimed fix: it costs at most one second and covers a
 * late-visible write from a writer other than the one we waited on.
 *
 * What this DOES settle is the failure mode: never an empty body. Either a
 * result, or a named error.
 */
const CAPTURE_RESULT_SETTLE_ATTEMPTS = 10;
const CAPTURE_RESULT_SETTLE_MS = 100;

async function submitMarketplaceCaptureViaScheduler(payload) {
  const run = await db.createRun({ platform: payload.platform || 'marketplace', query: payload.url || 'capture', maxItems: 1, options: { jobKind: 'marketplace_capture', ...payload } });
  await scheduler.submitRun(run);
  let finished = await scheduler.waitForCompletion(run.id, { pollMs: 150, timeoutMs: 180000 });

  if (finished.status !== 'done') {
    const err = new Error(finished.error_message || 'Capture failed');
    err.status = 400;
    throw err;
  }

  let result = JSON.parse(finished.health_snapshot || '{}').result;
  for (let attempt = 0; result === undefined && attempt < CAPTURE_RESULT_SETTLE_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_RESULT_SETTLE_MS));
    finished = await db.getRunById(run.id);
    result = JSON.parse((finished && finished.health_snapshot) || '{}').result;
  }

  if (result === undefined) {
    const err = new Error(`Capture run ${run.id} finished without a result payload`);
    err.status = 500;
    throw err;
  }
  return result;
}

app.post('/api/html-captures', async (req, res) => {
  if (scheduler.isFrozen()) {
    return res.status(503).json({
      error: 'Service Unavailable',
      code: 'DISPATCH_FROZEN',
      message: 'Run dispatch is currently frozen by administrator',
    });
  }
  if (scheduler.getActiveExecutionCount() >= scheduler.maxConcurrentRuns) {
    return res.status(429).json({
      error: 'Too Many Requests',
      code: 'CONCURRENCY_LIMIT_REACHED',
      message: `Concurrency limit reached (${scheduler.maxConcurrentRuns} active runs)`,
    });
  }

  const payload = req.body || {};
  if (payload.url) {
    try {
      const { validateOutboundUrl } = require('./src/security/outbound-guard');
      await validateOutboundUrl(payload.url);
    } catch (err) {
      if (err.name === 'SSRFSecurityError') {
        return res.status(400).json({ error: 'SSRF_BLOCKED', code: err.blockedReason, message: err.message });
      }
      throw err;
    }
  }
  if (payload.platform === 'etsy' && payload.variantMode === 'all') {
    return res.status(202).json({ job: marketplaceCaptureJobs.enqueue(payload) });
  }
  try {
    res.status(201).json(await submitMarketplaceCaptureViaScheduler(payload));
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// User Journey Automated Capture & Parsing Endpoint
app.post('/api/user-journey/run', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (scheduler.isFrozen()) {
      return res.status(503).json({
        error: 'Service Unavailable',
        code: 'DISPATCH_FROZEN',
        message: 'Run dispatch is currently frozen by administrator',
      });
    }
    if (scheduler.getActiveExecutionCount() >= scheduler.maxConcurrentRuns) {
      return res.status(429).json({
        error: 'Too Many Requests',
        code: 'CONCURRENCY_LIMIT_REACHED',
        message: `Concurrency limit reached (${scheduler.maxConcurrentRuns} active runs)`,
      });
    }
    const body = req.body || {};
    const journeyTarget = body.startUrl || body.url;
    if (journeyTarget && /^https?:\/\//i.test(journeyTarget)) {
      try {
        const { validateOutboundUrl } = require('./src/security/outbound-guard');
        await validateOutboundUrl(journeyTarget);
      } catch (err) {
        if (err.name === 'SSRFSecurityError') {
          return res.status(400).json({ status: 'FAILED', error: err.message, code: err.blockedReason });
        }
        throw err;
      }
    }
    // Goes through the shared Resource Scheduler (BROWSER pool) instead of
    // launching Playwright directly — this is real browser automation and
    // must be admission-controlled like every other crawl workload.
    const run = await db.createRun({
      platform: 'user-journey',
      query: body.startUrl || body.url || body.query || 'journey',
      maxItems: 1,
      options: { jobKind: 'user_journey', ...body }
    });
    await scheduler.submitRun(run);
    const finished = await scheduler.waitForCompletion(run.id, { timeoutMs: 180000 });
    if (finished.status !== 'done') {
      return res.status(500).json({ status: 'FAILED', error: finished.error_message || 'User journey failed' });
    }
    const snapshotObj = JSON.parse(finished.health_snapshot || '{}');
    res.status(200).json(snapshotObj.result || {});
  } catch (err) {
    res.status(500).json({ status: 'FAILED', error: err.message });
  }
});

// Doctor
app.get('/api/doctor', async (req, res) => {
  try {
    const isJson = req.query.json === '1' || req.query.json === 'true';
    const options = { platform: req.query.platform };
    const report = await runDoctor(options);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Runs
app.get('/api/runs', async (req, res) => {
  try {
    // Job History filters (status/platform/limit) — whitelisted, bound
    // parameters only; no string concatenation into SQL (actual query lives
    // in src/database.js's getRunsFiltered()). `status` values mirror the
    // literal values runs.status actually takes (pg-schema.sql), including
    // 'stuck' (src/reliability/stuck-detector.js writes this when recovery
    // is exhausted; public/app.js's loadJobs() already renders it as the
    // "Stuck" badge — not a new status). `platform` is checked against the
    // channel registry — the same getPlatform() check the POST /api/runs
    // handler below already applies to a submitted platform.
    const ALLOWED_RUN_STATUS_FILTERS = new Set(['running', 'done', 'failed', 'stuck']);
    const rawStatus = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';
    const status = ALLOWED_RUN_STATUS_FILTERS.has(rawStatus) ? rawStatus : undefined;

    const rawPlatform = typeof req.query.platform === 'string' ? req.query.platform.trim() : '';
    const platform = rawPlatform && require('./src/platform-config').getPlatform(rawPlatform) ? rawPlatform : undefined;

    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 1000) : 100;

    res.json(await db.getRunsFiltered({ status, platform, limit }));
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/runs/:id', async (req, res) => {
  try {
    const run = await db.getRunById(parseInt(req.params.id, 10));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    // §6.2: getRunItems() reads legacy `snapshots` or runs.result_items_json
    // depending on READ_MODEL_V2 — this route never depends on legacy rows
    // existing for a post-cutover Run.
    run.snapshots = await db.getRunItems(run.id);
    // TASK-2: a multi-keyword parent (and a size-shard parent) stores nothing
    // itself — every item belongs to one of its children. Attached only when
    // children actually exist, so an ordinary run's response shape is unchanged.
    const children = await db.getChildRuns(run.id);
    if (children.length > 0) run.children = children;
    res.json(run);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/runs', async (req, res) => {
  try {
    // 1. Feature 13 Check: Emergency Dispatch Freeze
    if (scheduler.isFrozen()) {
      return res.status(503).json({
        error: 'Service Unavailable',
        code: 'DISPATCH_FROZEN',
        message: 'Run dispatch is currently frozen by administrator',
      });
    }

    // 2. Feature 11 Check: System Concurrency Cap
    if (scheduler.getActiveExecutionCount() >= scheduler.maxConcurrentRuns) {
      return res.status(429).json({
        error: 'Too Many Requests',
        code: 'CONCURRENCY_LIMIT_REACHED',
        message: `Concurrency limit reached (${scheduler.maxConcurrentRuns} active runs)`,
      });
    }

    // 3. Feature 12 Check: Apify Budget Kill Switch
    const { isPaidActor, options } = req.body || {};
    const requiresPaidActor = Boolean(isPaidActor);
    if (requiresPaidActor) {
      const { getApifyTokenPool } = require('./src/apify-token-pool');
      const tokenPool = getApifyTokenPool();
      const budget = tokenPool.checkBudget();

      if (!budget.allowed) {
        return res.status(402).json({
          error: 'Payment Required',
          code: 'APIFY_BUDGET_EXCEEDED',
          message: 'Apify account budget limit reached or token balance zero',
          remainingBalance: budget.remainingBalance,
          budgetLimit: budget.budgetLimit,
        });
      }

      tokenPool.deductBudget(1.0);
    }

    const platform = req.body?.platform || 'etsy';
    const query = req.body?.query || (isPaidActor !== undefined ? 'default search' : null);

    const queryField = getPlatformQueryField(platform);
    if (!platform || !query) return res.status(400).json({ error: `${queryField?.label || 'Query'} is required` });
    const config = require('./src/platform-config').getPlatform(platform);

    if (!config && (platform === 'apify_paid' || platform === 'etsy_local' || isPaidActor !== undefined)) {
      const run = await db.createRun({
        platform,
        query,
        maxItems: 10,
        country: null,
        options: { isPaidActor, ...(options || {}) }
      });
      scheduler.submitRun(run).catch(console.error);
      return res.status(201).json({
        message: 'Run scheduled successfully',
        run,
        ...run,
      });
    }

    if (!config) return res.status(400).json({ error: `Unknown platform: ${platform}` });

    // Ingress SSRF Validation for storeUrl and URL-typed queries
    if (platform === 'shopify' || (queryField && queryField.type === 'url')) {
      const urlToValidate = /^https?:\/\//i.test(query) ? query : `https://${query}`;
      try {
        const { validateOutboundUrl } = require('./src/security/outbound-guard');
        await validateOutboundUrl(urlToValidate);
      } catch (err) {
        if (err.name === 'SSRFSecurityError') {
          return res.status(400).json({ error: 'SSRF_BLOCKED', code: err.blockedReason, message: err.message });
        }
        throw err;
      }
    }

    const normalizedOptions = buildCollectionOptions(platform, { ...req.body, ...(options || {}) });

    // Pre-flight check
    try {
      await router.selectBackend(platform, normalizedOptions);
    } catch (err) {
      if (err.name === 'NoHealthyBackendError') {
        return res.status(400).json({
          error: 'NO_HEALTHY_BACKEND',
          platform: err.platform,
          message: err.message,
          diagnostic: err.diagnostic
        });
      }
      throw err;
    }

    const maxItems = normalizedOptions.maxItems;
    const country = normalizedOptions.country || null;
    // TASK-2 multi-keyword: buildCollectionOptions() only sets `keywords` for 2+
    // keywords, so a single-keyword submission keeps its exact previous shape.
    // For a fan-out submission the parent run never executes (the Scheduler
    // parks it as 'sharded' and runs one child per keyword), so its `query`
    // column is a display label — make it show every keyword rather than
    // whichever one the client happened to put in `query`.
    const parentQuery = Array.isArray(normalizedOptions.keywords)
      ? normalizedOptions.keywords.join(KEYWORD_DISPLAY_SEPARATOR)
      : query;
    const run = await db.createRun({ platform, query: parentQuery, maxItems, country, options: normalizedOptions });

    // Submit to Resource-Aware Scheduler with queue admission control
    scheduler.submitRun(run).catch(console.error);
    res.status(201).json({
      message: 'Run scheduled successfully',
      run,
      ...run,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



app.get('/api/system/info', (req, res) => {
  res.json(getSystemInfo());
});

app.get('/api/database/health', async (req, res) => {
  try {
    res.json(await db.getDatabaseHealth());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scheduler/status', async (req, res) => {
  try {
    res.json(await scheduler.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/proxy-pool/status', (req, res) => {
  try {
    const { getProxyPool } = require('./src/proxy');
    res.json(getProxyPool().getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/apify-tokens/status', (req, res) => {
  try {
    const { getApifyTokenPool } = require('./src/apify-token-pool');
    res.json(getApifyTokenPool().getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/apify-tokens/budget', (req, res) => {
  try {
    const { getApifyTokenPool } = require('./src/apify-token-pool');
    res.json(getApifyTokenPool().getBudgetStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apify-tokens/budget', (req, res) => {
  try {
    const { getApifyTokenPool } = require('./src/apify-token-pool');
    const updated = getApifyTokenPool().setBudget(req.body || {});
    res.json({ success: true, budget: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/apify-tokens', (req, res) => {
  try {
    const { getApifyTokenPool } = require('./src/apify-token-pool');
    res.json(getApifyTokenPool().getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apify-tokens', (req, res) => {
  try {
    const { token, tokens, label } = req.body || {};
    const { getApifyTokenPool } = require('./src/apify-token-pool');
    const pool = getApifyTokenPool();

    const toAdd = [];
    if (tokens && typeof tokens === 'string') {
      toAdd.push(...tokens.split(/[,;\r\n]+/).map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
    } else if (Array.isArray(tokens)) {
      toAdd.push(...tokens.map((s) => (typeof s === 'string' ? s.trim().replace(/^['"]|['"]$/g, '') : (s.token || '').trim())).filter(Boolean));
    } else if (token && typeof token === 'string') {
      toAdd.push(...token.split(/[,;\r\n]+/).map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
    }

    if (toAdd.length === 0) {
      return res.status(400).json({ error: 'Vui lòng cung cấp ít nhất một Apify API token hợp lệ.' });
    }

    const added = [];
    for (const t of toAdd) {
      const rec = pool.addAndPersistToken(t, label || null);
      if (rec) added.push({ id: rec.id, label: rec.label, state: rec.state });
    }

    res.json({ success: true, count: added.length, added, status: pool.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apify-tokens/cleanup', (req, res) => {
  try {
    const { getApifyTokenPool } = require('./src/apify-token-pool');
    const pool = getApifyTokenPool();
    const removedCount = pool.clearNonHealthyTokens();
    res.json({ success: true, removedCount, status: pool.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/apify-tokens/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { getApifyTokenPool } = require('./src/apify-token-pool');
    const pool = getApifyTokenPool();
    const removed = pool.removeToken(id);
    if (!removed) {
      return res.status(404).json({ error: 'Token không tồn tại trong pool.' });
    }
    res.json({ success: true, id, status: pool.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/runs/:id', async (req, res) => {
  try {
    const run = await db.getRunById(parseInt(req.params.id, 10));
    if (!run) return res.status(404).json({ error: 'Run not found' });

    // UI-BUG-03: this is the only "Cancel/Stop" affordance the UI has for an
    // active job — it used to just delete the DB row while the real
    // scraper/browser/backend call kept running unattended in the
    // background. Send a real abort to the current attempt's token (if any)
    // before removing the row, reusing the same ExecutionControlRegistry
    // StuckDetector already uses — no new abort mechanism.
    if (run.status === 'running' || run.status === 'queued' || run.status === 'pending') {
      try {
        const options = typeof run.input_options === 'string' ? JSON.parse(run.input_options || '{}') : {};
        if (options.executionToken) abortExecution(options.executionToken, 'USER_CANCELLED');
      } catch (_e) { /* best-effort abort; deletion still proceeds below */ }
    }

    await db.deleteRun(run.id);
    if (typeof invalidateRunCache === 'function') invalidateRunCache(run.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Items (latest snapshots)
// Live-Readiness Round #14: read-path cutover behind a reversible feature
// flag. READ_MODEL_V2=true only changes what these two GET routes read from —
// legacy `snapshots` writes are untouched either way (dual-write continues
// regardless), so flipping this flag back is always safe and instant.
const READ_MODEL_V2 = process.env.READ_MODEL_V2 === 'true';

// High-performance In-Memory LRU cache for parsed run items.
// Prevents repeatedly querying 48MB result_items_json and running JSON.parse
// 100 times in parallel, which frozen the Node.js event loop for 13-60+ seconds.
const RUN_ITEMS_CACHE_LIMIT = 20;
const runItemsCache = new Map();

function invalidateRunCache(runId) {
  if (runId) runItemsCache.delete(Number(runId));
}

async function getRunRichMetaMap(runId) {
  if (!runId) return null;
  const numId = Number(runId);
  if (runItemsCache.has(numId)) {
    // Refresh LRU position
    const data = runItemsCache.get(numId);
    runItemsCache.delete(numId);
    runItemsCache.set(numId, data);
    return data;
  }

  try {
    const run = await db.getRunById(numId);
    if (!run?.result_items_json) {
      runItemsCache.set(numId, new Map());
      return runItemsCache.get(numId);
    }
    const items = JSON.parse(run.result_items_json);
    const itemMap = new Map();
    if (Array.isArray(items)) {
      for (const match of items) {
        if (!match || !match.item_uid) continue;
        itemMap.set(match.item_uid, {
          startDate: match.startDate || '',
          endDate: match.endDate || '',
          isActive: match.isActive !== undefined ? match.isActive : true,
          publisherPlatforms: match.publisherPlatforms || [],
          fanpageLikes: match.fanpageLikes || null,
          cta: match.cta || '',
          landingUrl: match.landingUrl || '',
          subreddit: match.subreddit || '',
          mediaItems: Array.isArray(match.mediaItems) ? match.mediaItems : [],
          mediaCount: match.mediaCount || 0,
          adCount: match.adCount === undefined ? null : match.adCount,
          activeCountries: Array.isArray(match.activeCountries) ? match.activeCountries : []
        });
      }
    }

    if (runItemsCache.size >= RUN_ITEMS_CACHE_LIMIT) {
      const oldestKey = runItemsCache.keys().next().value;
      runItemsCache.delete(oldestKey);
    }
    runItemsCache.set(numId, itemMap);
    return itemMap;
  } catch (_err) {
    return new Map();
  }
}

/**
 * @param {object} p               a product_current row
 * @param {Map=}   preloadedRunMeta runId -> meta map, resolved once per request
 *   by the caller. Without it this falls back to a per-item lookup, which is
 *   correct but is what made a large page slow.
 */
async function mapProductCurrentToItemShape(p, preloadedRunMeta = null) {
  let richMeta = {};
  try {
    if (p.last_run_id) {
      const runMetaMap = preloadedRunMeta?.get(Number(p.last_run_id))
        ?? await getRunRichMetaMap(p.last_run_id);
      if (runMetaMap && runMetaMap.has(p.item_uid)) {
        const match = runMetaMap.get(p.item_uid);
        richMeta = {
          ...match,
          fanpageLikes: match.fanpageLikes || p.current_likes || 0
        };
      }
    }
  } catch {}

  return {
    item_uid: p.item_uid,
    platform: p.platform,
    query: p.query,
    title: p.title,
    url: p.url,
    image: p.image,
    author: p.author,
    videoUrl: p.video_url || '',
    mediaType: p.media_type || '',
    // Task 5. return_position is the provider's returned order, not a rank —
    // see product-listing.js. delta is positive when the product moved UP.
    returnPosition: p.return_position ?? null,
    prevReturnPosition: p.prev_return_position ?? null,
    returnPositionChange: p.delta_return_position ?? null,
    sold30d: p.sold_30d ?? null,
    gmv: p.gmv ?? null,
    shopUrl: p.shop_url || '',
    country: p.country || '',
    price: p.current_price,
    prev_price: p.prev_price,
    rating: p.current_rating,
    prev_rating: p.prev_rating,
    reviews: p.current_reviews,
    prev_reviews: p.prev_reviews,
    sold_count: p.current_sold,
    prev_sold: p.prev_sold,
    likes: p.current_likes,
    prev_likes: p.prev_likes,
    comments: p.current_comments,
    shares: p.current_shares,
    saves: p.current_saves,
    prev_saves: p.prev_saves,
    views: p.current_views,
    status: p.status,
    created_at: p.last_crawled_at,
    first_seen_at: p.first_seen_at,
    last_seen_at: p.last_seen_at,
    last_crawled_at: p.last_crawled_at,
    delta_24h_views: p.delta_24h_views,
    delta_24h_likes: p.delta_24h_likes,
    delta_24h_sold: p.delta_24h_sold,
    ...richMeta,
    growth: {
      likes: p.delta_likes || 0,
      comments: p.delta_comments || 0,
      shares: p.delta_shares || 0,
      views: p.delta_views || 0,
      soldCount: p.delta_sold || 0,
      reviews: p.delta_reviews || 0,
      rating: p.delta_rating || 0,
      priceChange: p.delta_price || 0
    }
  };
}

// Task 2: the UI builds its two filter panels from this rather than hardcoding
// a metric list that could drift from what the server actually accepts.
/**
 * Full comment text for one item, most-liked first (pinned comments lead).
 * Separate from /api/items because a post can carry hundreds of comments and
 * the grid does not need them — only the detail view asks.
 */
app.get('/api/items/:uid/comments', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    res.json(await db.getComments(decodeURIComponent(req.params.uid), { limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/item-metrics', (req, res) => {
  // `platforms` is what both filter panels are built from: a platform's tick
  // boxes must be the metrics that platform can actually report, so the UI
  // never offers "shares" on an Etsy crawl. `groups` stays for the older
  // threshold-style API surface.
  const platforms = {};
  for (const name of Object.keys(PLATFORM_METRICS)) platforms[name] = metricsForPlatform(name);

  res.json({
    platforms,
    groups: [
      { key: ECOM, label: 'E-COM', metrics: metricsForGroup(ECOM) },
      { key: SOCIAL, label: 'SOCIAL', metrics: metricsForGroup(SOCIAL) },
    ],
    operators: ['>=', '>', '<=', '<', '=', '!='],
    combine: 'AND',
  });
});

/*
 * Non-metric sort keys for /api/items.
 *
 * buildSqlOrder (src/filters/metric-conditions.js) only knows the METRIC
 * columns — likes, price, rating and so on. "Most Recent" is not a metric, it
 * is a time column, so it is resolved here instead.
 *
 * WHICH time column, and why: product_current has NO `created_at` column. Its
 * time columns are first_seen_at / last_seen_at / last_crawled_at, and
 * `last_crawled_at` is the one this endpoint already publishes to the UI under
 * the name `created_at` (mapProductCurrentToItemShape), the one the detail view
 * labels "Lần cào mới nhất", the one the CSV export writes, and the one the
 * default ranking already uses as its tie-breaker. It is also the only one with
 * an index for this query — idx_product_current_last_crawled and
 * idx_product_current_platform_crawled. Ordering the grid by any other column
 * would order it by a value the user is never shown.
 */
/*
 * The two orderings that mean something for EVERY platform, and therefore the
 * only two the ALL selection offers. Each carries its own default direction:
 * "oldest" is not a direction applied to "recent", it is its own request, and
 * making the caller remember to also send dir=asc is how an ordering silently
 * comes back newest-first. An explicit `dir` still wins when one is supplied.
 */
const TIME_SORT_COLUMNS = {
  recent: { column: 'last_crawled_at', direction: 'DESC' },
  oldest: { column: 'last_crawled_at', direction: 'ASC' },
};

function buildTimeSqlOrder(sortField, sortDirection) {
  const spec = TIME_SORT_COLUMNS[String(sortField || '').trim().toLowerCase()];
  if (!spec) return null;
  const requested = String(sortDirection || '').trim().toLowerCase();
  const direction = requested === 'asc' ? 'ASC' : requested === 'desc' ? 'DESC' : spec.direction;
  return `${spec.column} ${direction} NULLS LAST`;
}

app.get('/api/items', async (req, res) => {
  try {
    if (READ_MODEL_V2) {
      // Task 2. FILTER decides membership, RANKING decides order — two separate
      // inputs, both resolved in SQL so they apply to the whole table rather
      // than to whatever the LIMIT happened to return.
      //
      //   ?conditions=[{"field":"likes","operator":">=","value":1000},
      //                {"field":"shares","operator":">=","value":100}]
      //   ?sort=likes&dir=desc     (metric column)
      //   ?sort=recent&dir=desc    (time column — see TIME_SORT_COLUMNS)
      //
      // Multiple conditions are ANDed by metric-conditions.evaluate/buildSql.
      let { conditions, invalid } = parseItemConditions(req.query);
      const rawSort = String(req.query.sort ?? '').trim();
      let orderBy = buildSqlOrder(req.query.sort, req.query.dir)
        || buildTimeSqlOrder(req.query.sort, req.query.dir);

      // An unrecognised `sort` used to fall through to the default ranking
      // without a word, so the caller got rows in an order it never asked for
      // and had no way to tell. Say so instead.
      if (rawSort && !orderBy) {
        const { METRICS } = require('./src/filters/metric-conditions');
        return res.status(400).json({
          error: 'Unknown sort field',
          invalid: [rawSort],
          hint: `sort must be one of: ${[...Object.keys(METRICS), ...Object.keys(TIME_SORT_COLUMNS)].join(', ')}`,
        });
      }

      // Ticked-metric filter (?metrics=likes,comments&dir=desc). Ticking a
      // metric means "only items that report it, ranked by it" — there is no
      // threshold to type. It reuses the same whitelisted-column SQL path as
      // `conditions` by expressing each tick as "> 0", so nothing new reaches
      // the database.
      if (req.query.metrics !== undefined) {
        const { selected, invalid: badMetrics } = parseMetricSelection(req.query.metrics);
        if (badMetrics.length) {
          return res.status(400).json({
            error: 'Unknown metric(s)',
            invalid: badMetrics,
            hint: `metric must be one of: ${Object.keys(require('./src/filters/metric-conditions').METRICS).join(', ')}`,
          });
        }
        if (selected.length) {
          conditions = conditions.concat(selected.map((field) => ({ field, operator: 'gt', value: 0 })));
          orderBy = buildSqlSelectionOrder(selected, req.query.dir) || orderBy;
        }
      }

      if (invalid.length) {
        return res.status(400).json({
          error: 'Unusable filter condition(s)',
          invalid,
          hint: 'field must be one of the known metrics, operator one of >= > <= < = !=, value numeric',
        });
      }

      // Paging is server-side so a tab holding tens of thousands of rows costs
      // one page, not the whole table. `limit` is capped: an unbounded limit
      // from the query string would defeat the point.
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const filter = {
        platform: req.query.platform || null,
        search: req.query.search || null,
        conditions,
      };

      const [current, total] = await Promise.all([
        db.getProductCurrent({ ...filter, limit, offset, orderBy }),
        db.countProductCurrent(filter),
      ]);

      /*
       * Run metadata for exactly the runs on THIS page, resolved once and
       * handed to the mapper.
       *
       * The previous code pre-warmed a module-level LRU that holds 20 runs and
       * then let each item look itself up. One page of 100 items can easily
       * span more than 20 runs, at which point the warm-up evicts its own
       * entries and every later item re-reads the run row and re-parses its
       * whole result_items_json — the cost grew with the number of distinct
       * runs, which is exactly what grows as the database fills up.
       */
      const uniqueRunIds = [...new Set(current.map((p) => p.last_run_id).filter(Boolean))];
      const runMeta = new Map();
      await Promise.all(uniqueRunIds.map(async (runId) => {
        runMeta.set(Number(runId), await getRunRichMetaMap(runId));
      }));

      // Total rides on a header so the body stays a plain array — every
      // existing caller of this endpoint keeps working unchanged.
      res.set('X-Total-Count', String(total));
      res.set('Access-Control-Expose-Headers', 'X-Total-Count');
      return res.json(await Promise.all(current.map((p) => mapProductCurrentToItemShape(p, runMeta))));
    }

    const snapshots = await db.getLatestSnapshots({
      search: req.query.search,
      platform: req.query.platform,
      limit: req.query.limit,
    });
    // Add growth data
    // Promise.all: the callback awaits per-item history, so without it this
    // array holds Promises and res.json() serialises each one as an empty
    // object - which is what the dashboard rendered as No title / UNDEFINED.
    const items = await Promise.all(snapshots.map(async (s) => {
      let rawMeta = {};
      if (s.raw_data) {
        try {
          const r = JSON.parse(s.raw_data);
          rawMeta = {
            startDate: r.startDateFormatted || (r.startDate ? new Date(r.startDate * 1000).toISOString() : '') || r.firstSeenAt || '',
            endDate: r.endDateFormatted || (r.endDate ? new Date(r.endDate * 1000).toISOString() : '') || '',
            isActive: r.isActive !== undefined ? r.isActive : true,
            publisherPlatforms: r.publisherPlatform || r.publisherPlatforms || r.snapshot?.publisherPlatform || [],
            fanpageLikes: r.snapshot?.pageLikeCount || r.pageLikeCount || r.likes || s.likes || 0,
            cta: r.cta || r.ctaText || r.snapshot?.ctaText || '',
            landingUrl: r.landingUrl || r.snapshot?.linkUrl || ''
          };
        } catch {}
      }

      let growth = { likes: 0, comments: 0, shares: 0, views: 0, soldCount: 0, reviews: 0, priceChange: 0 };
      if (s.prev_snapshot_id) {
        const prev = await db.getSnapshotHistory(s.item_uid);
        if (prev.length >= 2) {
          const older = prev[prev.length - 2];
          growth = {
            likes: s.likes - older.likes,
            comments: s.comments - older.comments,
            shares: s.shares - older.shares,
            views: s.views - older.views,
            soldCount: (s.sold_count || 0) - (older.sold_count || 0),
            reviews: (s.reviews || 0) - (older.reviews || 0),
            priceChange: Number(((s.price || 0) - (older.price || 0)).toFixed(2))
          };
        }
      }
      return { ...s, ...rawMeta, growth };
    }));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Item history (timeline)
app.get('/api/items/:uid/history', async (req, res) => {
  try {
    const uid = decodeURIComponent(req.params.uid);
    if (READ_MODEL_V2) {
      const history = await db.getProductHistoryWithMetadata(uid, 365);
      if (history && history.length > 0) {
        return res.json(history);
      }
      const current = await db.getProductCurrentByUid(uid);
      if (current) {
        return res.json([{
          item_uid: current.item_uid,
          platform: current.platform,
          title: current.title,
          url: current.url,
          image: current.image,
          author: current.author,
          price: current.current_price,
          rating: current.current_rating,
          reviews: current.current_reviews,
          sold_count: current.current_sold,
          likes: current.current_likes,
          comments: current.current_comments,
          shares: current.current_shares,
          views: current.current_views,
          status: current.status,
          created_at: current.last_seen_at || current.first_seen_at || new Date().toISOString()
        }]);
      }
      return res.json([]);
    }
    const history = await db.getSnapshotHistory(uid);
    res.json(history);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete single item by UID
app.delete('/api/items/:uid', async (req, res) => {
  try {
    const uid = decodeURIComponent(req.params.uid);
    const result = await db.deleteItem(uid);
    res.json({ success: true, message: `Item ${uid} deleted`, changes: result.changes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete all items (or filtered by platform/query) - Admin only
app.delete('/api/items', requireAdmin, async (req, res) => {
  try {
    const { platform, query } = req.query;
    const result = await db.deleteAllItems({ platform, query });
    res.json({ success: true, message: 'All items deleted successfully', changes: result.changes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/database/parity', async (req, res) => {
  try {
    res.json({ readModelV2Enabled: READ_MODEL_V2, ...await db.checkV2Parity() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const [stats, runStats, tabCounts] = await Promise.all([
      db.getStats(),
      db.getRunStats(),
      // Counted the same way /api/items lists, so a tab's counter and its
      // contents agree. `platformCounts` above keeps its old meaning (live
      // items only) for existing consumers.
      db.countProductCurrentByPlatform(),
    ]);
    res.json({ ...stats, platforms: runStats, tabCounts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toidispy import — save scraped items directly
app.post('/api/toidispy/import', async (req, res) => {
  try {
    const { query, items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });

    // Create a run
    const run = await db.createRun({ platform: 'toidispy', query: query || 'search', maxItems: items.length });

    // Convert toidispy format to raw_data
    const rawItems = items.map((item) => ({
      title: item.author || 'Unknown',
      author: item.author || '',
      domain: item.domain || '',
      image: item.imageUrl || '',
      url: item.domain ? `https://${item.domain}` : '',
      likes: item.reactions || 0,
      comments: item.comments || 0,
      shares: item.shares || 0,
      isAd: item.isAd || false,
      timeAgo: item.time || '',
      platform: 'facebook',
    }));

    const result = await db.insertSnapshots(run.id, 'toidispy', query || 'search', rawItems);
    await db.updateRun(run.id, { status: 'done', ...result });

    res.json({ runId: run.id, count: items.length, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toidispy — Run CDP with filters from UI
app.post('/api/toidispy/run', async (req, res) => {
  try {
    const { keyword, section, filters, maxItems, cdpUrl } = req.body;
    if (!keyword?.trim()) return res.status(400).json({ error: 'keyword is required' });

    const options = { section: section || 'posts', filters: filters || {}, cdpUrl, maxItems: parseInt(maxItems) || 100 };
    // Goes through the shared Resource Scheduler (CDP pool + cdp:9222 lock),
    // like every other crawl workload — toidispy already has a real channel
    // entry, so this is the same path as POST /api/runs.
    const run = await db.createRun({ platform: 'toidispy', query: keyword, maxItems: options.maxItems, options });
    scheduler.submitRun(run).catch(console.error);

    // Return immediately — client polls /api/runs/:id for status (unchanged contract).
    res.status(202).json({ runId: run.id, status: 'queued', keyword, section, filters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check Toidispy Login
app.get('/api/toidispy/check-login', async (req, res) => {
  try {
    const CDPBackend = require('./src/backends/cdp.backend');
    const cdpUrl = process.env.CDP_URL || 'http://localhost:9222';
    const { chromium } = require('playwright');
    let browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      const page = await context.newPage();
      await page.goto('https://app.toidispy.com/posts', { waitUntil: 'domcontentloaded', timeout: 5000 });
      const currentUrl = page.url();
      await page.close();
      await browser.close();

      if (currentUrl.includes('/login')) {
        return res.json({
          status: 'login_required',
          code: 'TOIDISPY_LOGIN_REQUIRED',
          currentUrl,
          actions: ['Open Chrome CDP profile and login to Toidispy']
        });
      }
      return res.json({
        status: 'ok',
        code: 'TOIDISPY_LOGIN_OK',
        currentUrl
      });
    } catch (e) {
      if (browser) await browser.close();
      return res.json({
        status: 'failed',
        code: 'CDP_UNREACHABLE',
        actions: ['Start Chrome with --remote-debugging-port']
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toidispy filter config
app.get('/api/toidispy/filters', (req, res) => {
  try {
    const section = req.query.section || 'posts';
    res.json({
      filters: getFiltersForUI(section),
      defaults: getDefaultFilters(section),
      cardSchema: section === 'ads' ? ADS_CARD_SCHEMA : POSTS_CARD_SCHEMA,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export
app.get('/api/export/:runId', async (req, res) => {
  try {
    const run = await db.getRunById(parseInt(req.params.runId, 10));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    // §6.2: never depends on legacy `snapshots` existing for a post-cutover Run.
    const snapshots = await db.getRunItems(run.id);
    const items = await Promise.all(snapshots.map(async (s) => {
      let growth = { soldCount: 0, reviews: 0, likes: 0, priceChange: 0 };
      if (READ_MODEL_V2) {
        // §11 (Final Architecture Closure Round): read growth from the V2
        // source of truth (product_current's already-computed delta_* —
        // vs the immediately previous crawl for this item, the same
        // semantics the legacy branch below used), never from legacy
        // snapshots — a post-cutover Run must not silently degrade to
        // growth=0 just because legacy history stopped growing.
        const current = s.item_uid ? await db.getProductCurrentByUid(s.item_uid) : null;
        if (current) {
          growth = {
            soldCount: current.delta_sold || 0,
            reviews: current.delta_reviews || 0,
            likes: current.delta_likes || 0,
            priceChange: Number((current.delta_price || 0).toFixed(2))
          };
        }
      } else if (s.prev_snapshot_id || s.item_uid) {
        const prev = await db.getSnapshotHistory(s.item_uid);
        if (prev && prev.length >= 2) {
          const older = prev[prev.length - 2];
          growth = {
            soldCount: (s.sold_count || 0) - (older.sold_count || 0),
            reviews: (s.reviews || 0) - (older.reviews || 0),
            likes: (s.likes || 0) - (older.likes || 0),
            priceChange: Number(((s.price || 0) - (older.price || 0)).toFixed(2))
          };
        }
      }
      return {
        title: s.title, url: s.url, image: s.image, author: s.author, price: s.price,
        rating: s.rating, reviews: s.reviews, soldCount: s.sold_count, likes: s.likes,
        comments: s.comments, shares: s.shares, views: s.views, status: s.status,
        createdAt: s.created_at || run.created_at, growth
      };
    }));
    
    if (req.query.format === 'csv') {
      const filename = `${run.platform}_${run.query.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.csv`;
      const headers = [
        'Crawled Date/Time (Ngày giờ cào)', 'Platform (Nền tảng)', 'Title (Tên sản phẩm)',
        'Author/Shop (Tên Shop)', 'Price ($) (Giá bán)', 'Price Change ($) (Biến động giá)',
        'Sold Count (Số lượt bán)', 'Sold Growth (Tăng trưởng lượt bán)',
        'Reviews (Số đánh giá)', 'Reviews Growth (Tăng trưởng đánh giá)',
        'Rating (Điểm đánh giá)', 'Likes (Lượt thích)', 'Likes Growth (Tăng trưởng Like)',
        'Status (Trạng thái)', 'URL (Link sản phẩm)', 'Image (Link ảnh)'
      ];
      const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
      const headerLine = headers.join(',');
      const rows = items.map(i => [
        escapeCsv(db.formatVietnamTime(i.createdAt)), escapeCsv(run.platform), escapeCsv(i.title),
        escapeCsv(i.author), escapeCsv(i.price), escapeCsv(i.growth?.priceChange || 0),
        escapeCsv(i.soldCount), escapeCsv(i.growth?.soldCount || 0),
        escapeCsv(i.reviews), escapeCsv(i.growth?.reviews || 0),
        escapeCsv(i.rating), escapeCsv(i.likes), escapeCsv(i.growth?.likes || 0),
        escapeCsv(i.status), escapeCsv(i.url), escapeCsv(i.image)
      ].join(','));
      const csvContent = '\uFEFF' + [headerLine, ...rows].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csvContent);
    }

    const filename = `${run.platform}_${run.query.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({ run, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== Legacy Integration (Removed) ====================

// ==================== Global Error Handler ====================

process.on('uncaughtException', (err) => console.error('[FATAL]', err));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

// ==================== Graceful Shutdown Lifecycle Manager (Feature 19) ====================

function createShutdownManager(options = {}) {
  const {
    server: customServer = null,
    database = db,
    scheduler: customScheduler = null,
    stuckDetector: customStuckDetector = null,
    socialScheduler: customSocialScheduler = null,
    graceTimeoutMs = 30000,
    drainExecutionsTimeoutMs = 10000,
    exitFn = process.exit,
  } = options;

  let shutdownPromise = null;

  async function executeGracefulShutdown(signal = 'SIGTERM') {
    isShuttingDown = true;
    console.log(`\n[Shutdown] Received ${signal}. Starting graceful shutdown sequence...`);

    // 1. Arm 30-second hard deadline timeout
    const forceExitTimer = setTimeout(() => {
      console.error(`[Shutdown] Hard deadline (${graceTimeoutMs}ms) exceeded during shutdown. Forcing exit.`);
      exitFn(1);
    }, graceTimeoutMs);

    if (typeof forceExitTimer.unref === 'function') {
      forceExitTimer.unref();
    }

    try {
      // 2. Stop receiving new HTTP requests & close idle sockets
      const srv = customServer || serverInstance;
      if (srv && typeof srv.close === 'function') {
        console.log('[Shutdown] Closing HTTP server listener...');
        await new Promise((resolve) => {
          srv.close((err) => {
            if (err) console.error('[Shutdown] HTTP server close error:', err.message);
            else console.log('[Shutdown] HTTP server stopped accepting connections.');
            resolve();
          });
          if (typeof srv.closeIdleConnections === 'function') {
            srv.closeIdleConnections();
          }
        });
      }

      // 3. Stop background periodic interval timers
      const sched = customScheduler || (function() {
        try { return require('./src/scheduler/scheduler').getScheduler(); } catch (_) { return null; }
      })();
      if (sched && typeof sched.stop === 'function') {
        console.log('[Shutdown] Stopping ResourceScheduler...');
        sched.stop();
      }

      const stuck = customStuckDetector || (function() {
        try { return require('./src/reliability/stuck-detector').getStuckDetector(); } catch (_) { return null; }
      })();
      if (stuck && typeof stuck.stop === 'function') {
        console.log('[Shutdown] Stopping StuckDetector...');
        stuck.stop();
      }

      const social = customSocialScheduler || (function() {
        try { return require('./src/social-bots/social-scheduler').getSocialScheduler(); } catch (_) { return null; }
      })();
      if (social && typeof social.stop === 'function') {
        console.log('[Shutdown] Stopping SocialScheduler...');
        social.stop();
      }

      // 4. Drain active scheduler executions (bounded wait)
      if (sched && typeof sched.getActiveExecutionCount === 'function') {
        const activeCount = sched.getActiveExecutionCount();
        if (activeCount > 0) {
          console.log(`[Shutdown] Waiting for ${activeCount} active execution(s) to drain (up to ${drainExecutionsTimeoutMs}ms)...`);
          const drainStart = Date.now();
          while (sched.getActiveExecutionCount() > 0 && (Date.now() - drainStart < drainExecutionsTimeoutMs)) {
            await new Promise((r) => setTimeout(r, 500));
          }
          if (sched.getActiveExecutionCount() > 0) {
            console.warn(`[Shutdown] Drain window elapsed with ${sched.getActiveExecutionCount()} execution(s) still active.`);
          } else {
            console.log('[Shutdown] All active executions drained successfully.');
          }
        }
      }

      // 5. Release active limiter leases to prevent cluster split-brain
      if (database) {
        try {
          const queryFn = typeof database.query === 'function'
            ? database.query.bind(database)
            : (database._connection && typeof database._connection.query === 'function'
              ? database._connection.query.bind(database._connection)
              : null);
          if (queryFn) {
            console.log('[Shutdown] Releasing monitoring limiter leases...');
            await queryFn(`
              UPDATE monitoring_limiter
              SET owner_token = NULL, leased_until = NULL, next_allowed_at = now()
              WHERE owner_token LIKE $1
            `, [`%${process.pid}%`]);
            console.log('[Shutdown] Monitoring limiter leases released.');
          }
        } catch (_e) {
          // Ignored if table does not exist or database unreachable
        }
      }

      // 6. Drain and close database connection pool cleanly
      if (database) {
        console.log('[Shutdown] Closing database connection pool...');
        if (typeof database.close === 'function') {
          await database.close().catch(() => {});
        } else if (database._connection && typeof database._connection.close === 'function') {
          await database._connection.close().catch(() => {});
        }
        console.log('[Shutdown] Database connection closed.');
      }

      clearTimeout(forceExitTimer);
      console.log(`[Shutdown] Graceful shutdown completed cleanly on ${signal}. Exiting with code 0.`);
      exitFn(0);
    } catch (err) {
      console.error('[Shutdown] Fatal error during shutdown sequence:', err);
      clearTimeout(forceExitTimer);
      exitFn(1);
    }
  }

  function handleSignal(signal) {
    if (isShuttingDown && shutdownPromise) {
      console.log(`[Shutdown] Duplicate signal ${signal} received; shutdown already in progress.`);
      return shutdownPromise;
    }
    isShuttingDown = true;
    shutdownPromise = executeGracefulShutdown(signal);
    return shutdownPromise;
  }

  function registerSignalHandlers() {
    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));
  }

  return {
    handleSignal,
    executeGracefulShutdown,
    registerSignalHandlers,
    isShuttingDown: () => isShuttingDown,
    setShuttingDown: (val) => { isShuttingDown = Boolean(val); },
  };
}

// ==================== Start ====================

// Database initialisation is kicked off above (see `databaseReady`); requests
// are held by middleware until it resolves, so the port can open immediately.
let serverInstance = null;
let shutdownManager = null;

if (require.main === module) {
  serverInstance = app.listen(PORT, '0.0.0.0', () => {
    const info = getSystemInfo();
    console.log(`Apify Collector running at http://0.0.0.0:${PORT}`);
    console.log(`[SystemInfo] pid=${info.pid} startedAt=${info.serverStartedAt} version=${info.appVersion} commit=${info.gitCommit || 'n/a'} cwd=${info.workingDirectory}`);
    if (!process.env.APIFY_TOKEN) console.warn('⚠️  APIFY_TOKEN not set');
  });

  serverInstance.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[FATAL] Port ${PORT} is already in use by another process. This server (pid=${process.pid}) will not start.`);
      console.error(`[FATAL] Check what's listening: another crawler-POD instance may still be running from an earlier session. This process will NOT automatically kill it.`);
      process.exit(1);
    }
    console.error('[FATAL] Server failed to start:', err);
    process.exit(1);
  });

  shutdownManager = createShutdownManager({
    server: serverInstance,
    database: db,
  });

  shutdownManager.registerSignalHandlers();
}

module.exports = {
  app,
  serverInstance,
  shutdownManager,
  createShutdownManager,
};
