/**
 * Database Module — Snapshot-based tracking
 * Each collection run creates snapshots. Comparing snapshots shows:
 * - New items (appeared since last run)
 * - Active items (still running)
 * - Dropped items (stopped since last run)
 * - Growth (likes/comments/shares change)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { PLATFORMS } = require('./platform-config');
const { cleanImageUrl, extractImage, sanitizeForStorage } = require('./image-utils');
const { initSchemaV2, migrateDeltaColumnsNullable, migrateWeeklySummaryColumns, migrateRatingDeltaColumns } = require('./database/schema-v2');
const { createProductCurrentOps } = require('./database/product-current');
const { createDailyHistoryOps, normalizeLegacyUtcTimestamp } = require('./database/daily-history');
const { createWeeklySummaryOps, recomputeWeeklySummaryFromHistory } = require('./database/weekly-summary');

const DB_PATH = path.join(__dirname, '..', 'data', 'collector.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// §14/§16 DB Cutover flags — controlled via .env, default keeps legacy behavior.
const LEGACY_SNAPSHOT_WRITE = (process.env.LEGACY_SNAPSHOT_WRITE || 'true').toLowerCase() !== 'false';
const READ_MODEL_V2 = (process.env.READ_MODEL_V2 || 'false').toLowerCase() === 'true';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Real concurrent-writer contention (multiple Scheduler executions writing
// at once, or multiple processes opening this same file) previously failed
// immediately with SQLITE_BUSY/SQLITE_BUSY_SNAPSHOT instead of waiting
// briefly for the other writer's transaction to finish. Found via a real
// SQLITE_BUSY_SNAPSHOT failure during a concurrent test run this round.
db.pragma('busy_timeout = 5000');

initSchemaV2(db);
migrateDeltaColumnsNullable(db);
migrateRatingDeltaColumns(db);
const weeklyMigration = migrateWeeklySummaryColumns(db);
if (weeklyMigration.migrated) {
  // Old rows used the wrong (avg+new)/2 running-average formula; rebuild every
  // week from Tier 2 (daily_packed_history), which is untouched and authoritative.
  recomputeWeeklySummaryFromHistory(db);
}
const dailyHistoryOps = createDailyHistoryOps(db);
const productCurrentOps = createProductCurrentOps(db, dailyHistoryOps);
const weeklySummaryOps = createWeeklySummaryOps(db);

// ==================== Schema ====================

db.exec(`
  CREATE TABLE IF NOT EXISTS platforms (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT UNIQUE NOT NULL,
    display_name    TEXT NOT NULL,
    description     TEXT,
    query_type      TEXT DEFAULT 'keyword',
    actor_id        TEXT NOT NULL,
    country_support INTEGER DEFAULT 0,
    icon            TEXT DEFAULT '🔗',
    color           TEXT DEFAULT '#888888'
  );

  CREATE TABLE IF NOT EXISTS runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    platform         TEXT NOT NULL,
    query            TEXT NOT NULL,
    status           TEXT DEFAULT 'pending',
    apify_run_id     TEXT,
    apify_dataset_id TEXT,
    items_count      INTEGER DEFAULT 0,
    new_count        INTEGER DEFAULT 0,
    active_count     INTEGER DEFAULT 0,
    dropped_count    INTEGER DEFAULT 0,
    error_message    TEXT,
    max_items        INTEGER DEFAULT 100,
    country          TEXT,
    input_options    TEXT DEFAULT '{}',
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at     DATETIME
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL,
    platform        TEXT NOT NULL,
    query           TEXT NOT NULL,
    item_uid        TEXT NOT NULL,
    raw_data        TEXT NOT NULL,
    title           TEXT DEFAULT '',
    url             TEXT DEFAULT '',
    image           TEXT DEFAULT '',
    author          TEXT DEFAULT '',
    price           REAL DEFAULT 0,
    rating          REAL DEFAULT 0,
    reviews         INTEGER DEFAULT 0,
    sold_count      INTEGER DEFAULT 0,
    likes           INTEGER DEFAULT 0,
    comments        INTEGER DEFAULT 0,
    shares          INTEGER DEFAULT 0,
    views           INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'new',
    prev_snapshot_id INTEGER,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_uid ON snapshots(item_uid);
  CREATE INDEX IF NOT EXISTS idx_snapshots_platform_query ON snapshots(platform, query);
  CREATE INDEX IF NOT EXISTS idx_snapshots_latest ON snapshots(platform, query, run_id DESC);
  CREATE INDEX IF NOT EXISTS idx_snapshots_run ON snapshots(run_id);

  CREATE TABLE IF NOT EXISTS marketplace_proxies (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    label             TEXT NOT NULL UNIQUE,
    protocol          TEXT NOT NULL DEFAULT 'socks5',
    host              TEXT NOT NULL,
    port              INTEGER NOT NULL,
    config_encrypted  TEXT NOT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS marketplace_accounts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    platform          TEXT NOT NULL,
    label             TEXT NOT NULL,
    session_encrypted TEXT NOT NULL,
    proxy_id          INTEGER,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, label),
    FOREIGN KEY (proxy_id) REFERENCES marketplace_proxies(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS marketplace_captures (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    platform          TEXT NOT NULL,
    account_id        INTEGER,
    url               TEXT NOT NULL,
    html_encrypted    TEXT NOT NULL,
    html_sha256       TEXT NOT NULL,
    parsed_data       TEXT NOT NULL,
    variant_mode      TEXT NOT NULL DEFAULT 'base',
    max_variants      INTEGER NOT NULL DEFAULT 0,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES marketplace_accounts(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_marketplace_captures_platform ON marketplace_captures(platform, created_at DESC);

  CREATE TABLE IF NOT EXISTS marketplace_capture_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    keyword TEXT NOT NULL,
    account_id INTEGER,
    every_minutes INTEGER NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'interval',
    daily_time TEXT,
    run_at TEXT,
    variant_mode TEXT NOT NULL DEFAULT 'base',
    max_variants INTEGER NOT NULL DEFAULT 0,
    max_listings INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    last_summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES marketplace_accounts(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_marketplace_capture_schedules_due ON marketplace_capture_schedules(enabled, next_run_at);

  CREATE TABLE IF NOT EXISTS marketplace_capture_schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    summary TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    FOREIGN KEY (schedule_id) REFERENCES marketplace_capture_schedules(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_marketplace_capture_schedule_runs_schedule ON marketplace_capture_schedule_runs(schedule_id, id DESC);

  CREATE TABLE IF NOT EXISTS social_bot_state (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_key           TEXT NOT NULL,
    scheduled_window  INTEGER NOT NULL,
    query_key         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    run_id            INTEGER,
    error_message     TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bot_key, scheduled_window, query_key)
  );
  CREATE INDEX IF NOT EXISTS idx_social_bot_state_bot ON social_bot_state(bot_key, scheduled_window DESC);
`);

const marketplaceCaptureColumns = db.prepare('PRAGMA table_info(marketplace_captures)').all();
if (!marketplaceCaptureColumns.some((column) => column.name === 'variant_mode')) {
  db.exec("ALTER TABLE marketplace_captures ADD COLUMN variant_mode TEXT NOT NULL DEFAULT 'base'");
}
if (!marketplaceCaptureColumns.some((column) => column.name === 'max_variants')) {
  db.exec('ALTER TABLE marketplace_captures ADD COLUMN max_variants INTEGER NOT NULL DEFAULT 0');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_marketplace_captures_cache ON marketplace_captures(platform, url, account_id, variant_mode, max_variants, id DESC)');
const marketplaceScheduleColumns = db.prepare('PRAGMA table_info(marketplace_capture_schedules)').all();
if (!marketplaceScheduleColumns.some((column) => column.name === 'schedule_type')) db.exec("ALTER TABLE marketplace_capture_schedules ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'interval'");
if (!marketplaceScheduleColumns.some((column) => column.name === 'daily_time')) db.exec('ALTER TABLE marketplace_capture_schedules ADD COLUMN daily_time TEXT');
if (!marketplaceScheduleColumns.some((column) => column.name === 'run_at')) db.exec('ALTER TABLE marketplace_capture_schedules ADD COLUMN run_at TEXT');
if (!marketplaceScheduleColumns.some((column) => column.name === 'claimed_until')) db.exec('ALTER TABLE marketplace_capture_schedules ADD COLUMN claimed_until TEXT');
if (!marketplaceScheduleColumns.some((column) => column.name === 'claim_token')) db.exec('ALTER TABLE marketplace_capture_schedules ADD COLUMN claim_token TEXT');
try {
  const { normalizeMarketplaceCaptureUrl } = require('./marketplaces/validation');
  const normalizeCaptureUrl = db.prepare('UPDATE marketplace_captures SET url = ? WHERE id = ?');
  for (const capture of db.prepare('SELECT id, platform, url FROM marketplace_captures').all()) {
    const normalizedUrl = normalizeMarketplaceCaptureUrl(capture.platform, capture.url);
    if (normalizedUrl !== capture.url) normalizeCaptureUrl.run(normalizedUrl, capture.id);
  }
} catch (error) {
  console.warn('[DB] Could not normalize existing marketplace capture URLs:', error.message);
}

// Migrate: if old schema exists, migrate
const tableInfo = db.prepare(`PRAGMA table_info(runs)`).all();
const hasRuns = tableInfo.some((c) => c.name === 'new_count');
if (!hasRuns) {
  // Old schema — keep old tables, just add runs/snapshots
  console.log('[DB] Adding snapshot tables...');
}

// Run backend metadata migration
try {
  const runBackendMetadataMigration = require('./migrations/001_run_backend_metadata');
  runBackendMetadataMigration(db);
} catch (e) {
  console.error('[DB] Failed to run backend metadata migration:', e);
}

// Product fields are additive so existing local databases remain usable.
const snapshotColumns = new Set(db.prepare('PRAGMA table_info(snapshots)').all().map((column) => column.name));
for (const [name, definition] of Object.entries({
  rating: 'REAL DEFAULT 0',
  reviews: 'INTEGER DEFAULT 0',
  sold_count: 'INTEGER DEFAULT 0',
})) {
  if (!snapshotColumns.has(name)) db.exec(`ALTER TABLE snapshots ADD COLUMN ${name} ${definition}`);
}

const runColumns = new Set(db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name));
if (!runColumns.has('input_options')) db.exec("ALTER TABLE runs ADD COLUMN input_options TEXT DEFAULT '{}'");
if (!runColumns.has('parent_run_id')) db.exec('ALTER TABLE runs ADD COLUMN parent_run_id INTEGER');
// §6.1 (Final Blocker Fix Round): a Run's own packed result array, for
// run-detail/export/debug reads that must work regardless of
// LEGACY_SNAPSHOT_WRITE. A normal Run is <=20-30 items, so this is a small
// JSON column on the existing runs row — not a new one-row-per-item table
// (explicitly avoided per this round's "no row explosion" instruction).
// History (trends over time) is never sourced from this column — that
// remains daily_packed_history exclusively.
if (!runColumns.has('result_items_json')) db.exec('ALTER TABLE runs ADD COLUMN result_items_json TEXT');
// Gap #4 closure (Final Gap Closure Round): minimum metadata to identify
// external work that can outlive this Node process (Toidispy/CDP child
// process, Apify actor run) — {executionClass, externalExecutionId,
// startedAt}. RestartRecovery reads this on boot to avoid blindly
// duplicating a still-running external execution. Kept separate from
// health_snapshot (which heartbeat.js overwrites on its own throttled
// schedule) so neither write path clobbers the other.
if (!runColumns.has('external_execution_json')) db.exec('ALTER TABLE runs ADD COLUMN external_execution_json TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id)');

const marketplaceAccountColumns = new Set(db.prepare('PRAGMA table_info(marketplace_accounts)').all().map((column) => column.name));
if (!marketplaceAccountColumns.has('proxy_id')) db.exec('ALTER TABLE marketplace_accounts ADD COLUMN proxy_id INTEGER');

// ==================== Seed Platforms ====================

const insertPlatform = db.prepare(`
  INSERT OR IGNORE INTO platforms (name, display_name, description, query_type, actor_id, country_support, icon, color)
  VALUES (@name, @displayName, @description, @queryType, @actorId, @countrySupport, @icon, @color)
`);
db.transaction(() => { for (const p of PLATFORMS) insertPlatform.run(p); })();

// ==================== Prepared Statements ====================

const stmt = {
  // Platforms
  findAllPlatforms: db.prepare('SELECT * FROM platforms ORDER BY name'),

  // Runs
  createRun: db.prepare(`
    INSERT INTO runs (platform, query, max_items, country, active_backend, input_options)
    VALUES (@platform, @query, @maxItems, @country, @requestedBackend, @inputOptions)
  `),
  findRunById: db.prepare('SELECT * FROM runs WHERE id = ?'),
  findQueuedRuns: db.prepare("SELECT * FROM runs WHERE status IN ('queued', 'pending') ORDER BY id ASC LIMIT ?"),
  findAllRuns: db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?'),
  findRunsByStatus: db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY id ASC'),
  // Final Implementation Closure §2: completed_at must only be stamped on a
  // terminal transition, never on a routine heartbeat/progress update — those
  // call updateRun() too (via HeartbeatTracker.persist()) while the Run is
  // still legitimately running.
  updateRun: db.prepare(`
    UPDATE runs SET status=@status, apify_run_id=@apifyRunId, apify_dataset_id=@apifyDatasetId,
      items_count=@itemsCount, new_count=@newCount, active_count=@activeCount,
      dropped_count=@droppedCount, error_message=@errorMessage,
      active_backend=@activeBackend, backend_kind=@backendKind, backend_status=@backendStatus,
      backend_version=@backendVersion, backend_run_id=@backendRunId, health_snapshot=@healthSnapshot,
      cost_estimate=@costEstimate, input_options=@inputOptions,
      external_execution_json=@externalExecutionJson,
      completed_at=CASE WHEN @isTerminal = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id=@id
  `),
  deleteRun: db.prepare('DELETE FROM runs WHERE id = ?'),

  // Snapshots
  insertSnapshot: db.prepare(`
    INSERT INTO snapshots (run_id, platform, query, item_uid, raw_data, title, url, image, author,
      price, rating, reviews, sold_count, likes, comments, shares, views, status, prev_snapshot_id)
    VALUES (@runId, @platform, @query, @itemUid, @rawData, @title, @url, @image, @author,
      @price, @rating, @reviews, @soldCount, @likes, @comments, @shares, @views, @status, @prevSnapshotId)
  `),
  findSnapshotsByRunId: db.prepare('SELECT * FROM snapshots WHERE run_id = ? ORDER BY likes DESC'),
  findSnapshotsByPlatformQuery: db.prepare(`
    SELECT * FROM snapshots WHERE platform = ? AND query = ? ORDER BY created_at DESC
  `),
  findPreviousSnapshot: db.prepare(`
    SELECT * FROM snapshots WHERE platform = ? AND query = ? AND item_uid = ? AND run_id < ?
    ORDER BY run_id DESC LIMIT 1
  `),
  // §12: marks a V2 product_current row dropped — used by insertSnapshots()
  // for dropped-item detection that no longer depends on the legacy
  // snapshots table.
  markProductCurrentDropped: db.prepare(`UPDATE product_current SET status = 'dropped' WHERE item_uid = ?`),
  getSnapshotHistory: db.prepare(`
    SELECT s.*, r.created_at as run_date FROM snapshots s
    JOIN runs r ON s.run_id = r.id
    WHERE s.item_uid = ? ORDER BY r.created_at ASC
  `),

  // Stats
  countRuns: db.prepare('SELECT COUNT(*) as total FROM runs'),
  countSnapshots: db.prepare('SELECT COUNT(*) as total FROM snapshots'),
  getRunsByPlatform: db.prepare(`
    SELECT platform, COUNT(*) as runs, SUM(items_count) as items,
      SUM(new_count) as new_items, SUM(dropped_count) as dropped_items
    FROM runs WHERE status='done' GROUP BY platform
  `),
  findSnapshotsMissingImage: db.prepare(`
    SELECT id, raw_data FROM snapshots WHERE TRIM(image) = ''
  `),
  updateSnapshotImage: db.prepare(`
    UPDATE snapshots SET image = ? WHERE id = ?
  `),
  findSnapshotsMissingEtsyImage: db.prepare(`
    SELECT id, url FROM snapshots
    WHERE platform = 'etsy'
      AND TRIM(COALESCE(image, '')) = ''
      AND url LIKE 'https://www.etsy.com/listing/%'
    ORDER BY id ASC
    LIMIT ?
  `),
  updateSnapshotProductMetrics: db.prepare(`
    UPDATE snapshots SET price = ?, rating = ?, reviews = ?, sold_count = ? WHERE id = ?
  `),

  // Marketplace sessions and captures. Encrypted values are intentionally only
  // selected by the dedicated accessor below; list queries never expose them.
  createMarketplaceAccount: db.prepare(`
    INSERT INTO marketplace_accounts (platform, label, session_encrypted, proxy_id)
    VALUES (@platform, @label, @sessionEncrypted, @proxyId)
  `),
  findMarketplaceAccounts: db.prepare(`
    SELECT a.id, a.platform, a.label, a.proxy_id, p.label AS proxy_label, a.created_at, a.updated_at
    FROM marketplace_accounts a LEFT JOIN marketplace_proxies p ON p.id = a.proxy_id
    WHERE a.platform = ? ORDER BY a.updated_at DESC, a.id DESC
  `),
  findMarketplaceAccount: db.prepare(`
    SELECT a.id, a.platform, a.label, a.proxy_id, p.label AS proxy_label, a.created_at, a.updated_at
    FROM marketplace_accounts a LEFT JOIN marketplace_proxies p ON p.id = a.proxy_id WHERE a.id = ?
  `),
  findMarketplaceSession: db.prepare('SELECT session_encrypted FROM marketplace_accounts WHERE id = ?'),
  updateMarketplaceAccountProxy: db.prepare('UPDATE marketplace_accounts SET proxy_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
  deleteMarketplaceAccount: db.prepare('DELETE FROM marketplace_accounts WHERE id = ?'),
  createMarketplaceProxy: db.prepare(`
    INSERT INTO marketplace_proxies (label, protocol, host, port, config_encrypted)
    VALUES (@label, @protocol, @host, @port, @configEncrypted)
  `),
  findMarketplaceProxies: db.prepare(`
    SELECT id, label, protocol, host, port, created_at, updated_at FROM marketplace_proxies ORDER BY updated_at DESC, id DESC
  `),
  findMarketplaceProxy: db.prepare(`
    SELECT id, label, protocol, host, port, created_at, updated_at FROM marketplace_proxies WHERE id = ?
  `),
  findMarketplaceProxyConfig: db.prepare('SELECT config_encrypted FROM marketplace_proxies WHERE id = ?'),
  clearMarketplaceProxyAssignments: db.prepare('UPDATE marketplace_accounts SET proxy_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE proxy_id = ?'),
  deleteMarketplaceProxy: db.prepare('DELETE FROM marketplace_proxies WHERE id = ?'),
  createMarketplaceCapture: db.prepare(`
    INSERT INTO marketplace_captures (platform, account_id, url, html_encrypted, html_sha256, parsed_data, variant_mode, max_variants)
    VALUES (@platform, @accountId, @url, @htmlEncrypted, @htmlSha256, @parsedData, @variantMode, @maxVariants)
  `),
  findMarketplaceCaptures: db.prepare(`
    SELECT id, platform, account_id, url, html_sha256, parsed_data, variant_mode, max_variants, created_at
    FROM marketplace_captures WHERE (@platform IS NULL OR platform = @platform)
    ORDER BY id DESC LIMIT @limit
  `),
  findMarketplaceCapture: db.prepare(`
    SELECT id, platform, account_id, url, html_encrypted, html_sha256, parsed_data, variant_mode, max_variants, created_at
    FROM marketplace_captures WHERE id = ?
  `),
  findCachedMarketplaceCaptures: db.prepare(`
    SELECT id, platform, account_id, url, html_sha256, parsed_data, created_at
    FROM marketplace_captures
    WHERE platform = @platform
      AND url = @url
      AND ((account_id IS NULL AND @accountId IS NULL) OR account_id = @accountId)
      AND variant_mode = @variantMode
      AND max_variants = @maxVariants
    ORDER BY id DESC
    LIMIT 20
  `),
  createMarketplaceCaptureSchedule: db.prepare(`
    INSERT INTO marketplace_capture_schedules (platform, keyword, account_id, every_minutes, schedule_type, daily_time, run_at, variant_mode, max_variants, max_listings, next_run_at)
    VALUES (@platform, @keyword, @accountId, @everyMinutes, @scheduleType, @dailyTime, @runAt, @variantMode, @maxVariants, @maxListings, @nextRunAt)
  `),
  findMarketplaceCaptureSchedules: db.prepare(`
    SELECT id, platform, keyword, account_id, every_minutes, schedule_type, daily_time, run_at, variant_mode, max_variants, max_listings, enabled, next_run_at, last_run_at, last_summary, created_at
    FROM marketplace_capture_schedules ORDER BY id DESC
  `),
  findDueMarketplaceCaptureSchedules: db.prepare(`
    SELECT id, platform, keyword, account_id, every_minutes, schedule_type, daily_time, run_at, variant_mode, max_variants, max_listings
    FROM marketplace_capture_schedules
    WHERE enabled = 1 AND next_run_at <= @now AND (claimed_until IS NULL OR claimed_until < @now)
    ORDER BY next_run_at ASC LIMIT 5
  `),
  claimMarketplaceCaptureSchedule: db.prepare(`
    UPDATE marketplace_capture_schedules SET claimed_until = @claimedUntil, claim_token = @claimToken
    WHERE id = @id AND (claimed_until IS NULL OR claimed_until < @now)
  `),
  // Final Stabilization Round #12: opposite guard from the initial claim above
  // — only extends a claim that is CURRENTLY still held (claimed_until in the
  // future), never one that has already expired (a second tick may have
  // claimed it in the meantime; renewal must not steal it back).
  // §6: claim_token must match — a second process that claimed between
  // renewals gets a different token and this renewal correctly no-ops.
  renewMarketplaceCaptureScheduleClaim: db.prepare(`
    UPDATE marketplace_capture_schedules SET claimed_until = @claimedUntil
    WHERE id = @id AND claimed_until IS NOT NULL AND claimed_until >= @now AND claim_token = @claimToken
  `),
  releaseMarketplaceCaptureScheduleClaim: db.prepare(`
    UPDATE marketplace_capture_schedules SET claimed_until = NULL, claim_token = NULL
    WHERE id = @id AND (claim_token IS NULL OR claim_token = @claimToken)
  `),
  // §3 (Final Blocker Fix Round): completion is claim_token-protected exactly
  // like renew/release — a stale attempt whose claim was already lost cannot
  // mark the schedule complete, clear a newer claim, or advance next_run_at.
  // `IS` (not `=`) is required for NULL-safe comparison: a never-claimed
  // schedule has claim_token IS NULL, and completing it with no claimToken
  // supplied (claimToken=NULL) must still match — `NULL = NULL` is NULL
  // (never true) in SQL, but `NULL IS NULL` is true.
  completeMarketplaceCaptureSchedule: db.prepare(`
    UPDATE marketplace_capture_schedules SET last_run_at = @now, next_run_at = @nextRunAt, last_summary = @summary, claimed_until = NULL, claim_token = NULL
    WHERE id = @id AND claim_token IS @claimToken
  `),
  completeOneTimeMarketplaceCaptureSchedule: db.prepare(`
    UPDATE marketplace_capture_schedules SET enabled = 0, last_run_at = @now, last_summary = @summary, claimed_until = NULL, claim_token = NULL
    WHERE id = @id AND claim_token IS @claimToken
  `),
  createMarketplaceCaptureScheduleRun: db.prepare(`
    INSERT INTO marketplace_capture_schedule_runs (schedule_id, summary, completed_at)
    VALUES (@scheduleId, @summary, @completedAt)
  `),
  findMarketplaceCaptureScheduleRuns: db.prepare(`
    SELECT id, schedule_id, summary, completed_at
    FROM marketplace_capture_schedule_runs
    WHERE schedule_id = @scheduleId
    ORDER BY id DESC
    LIMIT @limit
  `),
  deleteMarketplaceCaptureSchedule: db.prepare('DELETE FROM marketplace_capture_schedules WHERE id = ?'),
  toggleMarketplaceCaptureSchedule: db.prepare(`
    UPDATE marketplace_capture_schedules
    SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END
    WHERE id = ?
  `),
};

// Existing records keep their history, but recover images that were already
// present in raw payloads and were missed by the former fixed-field parser.
function backfillSnapshotImages() {
  const rows = stmt.findSnapshotsMissingImage.all();
  const update = db.transaction((snapshots) => {
    for (const snapshot of snapshots) {
      try {
        const image = extractImage(JSON.parse(snapshot.raw_data));
        if (image) stmt.updateSnapshotImage.run(image, snapshot.id);
      } catch {
        // Keep malformed historic payloads untouched.
      }
    }
  });
  update(rows);
}

backfillSnapshotImages();

function backfillSnapshotProductMetrics() {
  const rows = db.prepare('SELECT id, raw_data, price, rating, reviews, sold_count FROM snapshots').all();
  const update = db.transaction((snapshots) => {
    for (const snapshot of snapshots) {
      try {
        const parsed = parseItemData(JSON.parse(snapshot.raw_data));
        const price = snapshot.price || parsed.price;
        const rating = snapshot.rating || parsed.rating;
        const reviews = snapshot.reviews || parsed.reviews;
        const soldCount = snapshot.sold_count || parsed.soldCount;
        if (price !== snapshot.price || rating !== snapshot.rating || reviews !== snapshot.reviews || soldCount !== snapshot.sold_count) {
          stmt.updateSnapshotProductMetrics.run(price, rating, reviews, soldCount, snapshot.id);
        }
      } catch {
        // Keep malformed historic payloads untouched.
      }
    }
  });
  update(rows);
}

backfillSnapshotProductMetrics();

// ==================== CRUD Operations ====================

function getAllPlatforms() { return stmt.findAllPlatforms.all(); }

function createRun({ platform, query, maxItems = 100, country = null, requestedBackend = null, options = {}, parentRunId = null }) {
  const r = stmt.createRun.run({ platform, query, maxItems, country, requestedBackend, inputOptions: JSON.stringify(options || {}) });
  if (parentRunId) {
    db.prepare('UPDATE runs SET parent_run_id = ? WHERE id = ?').run(parentRunId, r.lastInsertRowid);
  }
  return stmt.findRunById.get(r.lastInsertRowid);
}

function getChildRuns(parentRunId) {
  return db.prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY id ASC').all(parentRunId);
}

function getRunById(id) { return stmt.findRunById.get(id); }
function getQueuedRuns(limit = 10) { return stmt.findQueuedRuns.all(limit); }
function getAllRuns(limit = 100) { return stmt.findAllRuns.all(limit); }
function getRunsByStatus(status) { return stmt.findRunsByStatus.all(status); }
function deleteRun(id) { stmt.deleteRun.run(id); }

function deleteItem(itemUid) {
  if (!itemUid) return { changes: 0 };
  const tx = db.transaction((uid) => {
    const snapResult = db.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(uid);
    try { db.prepare('DELETE FROM product_current WHERE item_uid = ?').run(uid); } catch (_) {}
    try { db.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(uid); } catch (_) {}
    try { db.prepare('DELETE FROM weekly_product_summary WHERE item_uid = ?').run(uid); } catch (_) {}
    return { changes: snapResult.changes };
  });
  return tx(itemUid);
}

function deleteAllItems({ platform = null, query = null } = {}) {
  const tx = db.transaction(() => {
    let snapResult;
    if (platform && query) {
      snapResult = db.prepare('DELETE FROM snapshots WHERE platform = ? AND query = ?').run(platform, query);
      try { db.prepare('DELETE FROM product_current WHERE platform = ? AND query = ?').run(platform, query); } catch (_) {}
      try { db.prepare('DELETE FROM daily_packed_history WHERE platform = ? AND query = ?').run(platform, query); } catch (_) {}
    } else if (platform) {
      snapResult = db.prepare('DELETE FROM snapshots WHERE platform = ?').run(platform);
      try { db.prepare('DELETE FROM product_current WHERE platform = ?').run(platform); } catch (_) {}
      try { db.prepare('DELETE FROM daily_packed_history WHERE platform = ?').run(platform); } catch (_) {}
    } else {
      snapResult = db.prepare('DELETE FROM snapshots').run();
      try { db.prepare('DELETE FROM product_current').run(); } catch (_) {}
      try { db.prepare('DELETE FROM daily_packed_history').run(); } catch (_) {}
    }
    return { changes: snapResult.changes };
  });
  return tx();
}

const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'stuck', 'cancelled', 'timeout']);

function updateRun(id, updates) {
  const run = stmt.findRunById.get(id);
  if (!run) return;
  const nextStatus = updates.status ?? run.status;
  // Only a terminal status stamps completed_at — a heartbeat/progress update
  // (which calls updateRun() with the SAME non-terminal status, e.g. 'running')
  // must leave completed_at untouched.
  const isTerminal = TERMINAL_RUN_STATUSES.has(nextStatus) ? 1 : 0;
  stmt.updateRun.run({
    id,
    isTerminal,
    status: updates.status ?? run.status,
    apifyRunId: updates.apifyRunId ?? run.apify_run_id,
    apifyDatasetId: updates.apifyDatasetId ?? run.apify_dataset_id,
    itemsCount: updates.itemsCount ?? run.items_count,
    newCount: updates.newCount ?? run.new_count,
    activeCount: updates.activeCount ?? run.active_count,
    droppedCount: updates.droppedCount ?? run.dropped_count,
    errorMessage: updates.errorMessage ?? run.error_message,
    activeBackend: updates.activeBackend ?? updates.active_backend ?? run.active_backend,
    backendKind: updates.backendKind ?? updates.backend_kind ?? run.backend_kind,
    backendStatus: updates.backendStatus ?? updates.backend_status ?? run.backend_status,
    backendVersion: updates.backendVersion ?? updates.backend_version ?? run.backend_version,
    backendRunId: updates.backendRunId ?? updates.backend_run_id ?? run.backend_run_id,
    healthSnapshot: updates.healthSnapshot ?? updates.health_snapshot ?? run.health_snapshot,
    costEstimate: updates.costEstimate ?? updates.cost_estimate ?? run.cost_estimate,
    inputOptions: updates.inputOptions ?? updates.input_options ?? run.input_options,
    // Gap #4 closure: `externalExecution: null` explicitly clears it (e.g. once
    // no longer relevant); omitted entirely leaves the existing value untouched.
    externalExecutionJson: 'externalExecution' in updates
      ? (updates.externalExecution == null ? null : JSON.stringify(updates.externalExecution))
      : run.external_execution_json,
  });
}

/**
 * Insert items from a collection run, comparing with previous run.
 * Returns { newItems, activeItems, droppedItems, snapshots }
 */
function insertSnapshots(runId, platform, query, items) {
  const run = stmt.findRunById.get(runId);
  if (!run) return { newItems: 0, activeItems: 0, droppedItems: 0 };

  // Get the most recent previous run for this platform+query
  const prevRun = db.prepare(`
    SELECT id FROM runs WHERE platform=? AND query=? AND status='done' AND id < ?
    ORDER BY id DESC LIMIT 1
  `).get(platform, query, runId);

  const prevRunId = prevRun?.id || 0;

  let newCount = 0, activeCount = 0, droppedCount = 0;
  const currentUids = new Set();
  const resultItems = []; // §6.1: this Run's own packed result array

  const insertMany = db.transaction((txItems) => {
    for (const item of txItems) {
      const parsed = parseItemData(item);
      const itemUid = generateUid(platform, query, parsed);
      currentUids.add(itemUid);

      // §12: new/active must be derived from V2 (product_current), which is
      // authoritative regardless of LEGACY_SNAPSHOT_WRITE — the legacy
      // snapshots table stops growing once legacy writes are disabled, which
      // would otherwise make every item look "new" forever from that point on.
      const v2Payload = {
        item_uid: itemUid,
        platform,
        query,
        title: parsed.title,
        url: parsed.url,
        image: parsed.image,
        author: parsed.author,
        price: parsed.price,
        rating: parsed.rating,
        reviews: parsed.reviews,
        sold_count: parsed.soldCount,
        likes: parsed.likes,
        comments: parsed.comments,
        shares: parsed.shares,
        views: parsed.views
      };

      let v2Result = null;
      try {
        v2Result = productCurrentOps.upsertItem(v2Payload, runId);
        // §4: runId gives this observation a stable identity (run:<runId>:<itemUid>)
        // so a retried insertSnapshots() call for the same run never duplicates it.
        dailyHistoryOps.appendObservation(v2Payload, new Date(), { runId });
        // weekly_summary is deprecated from the core write path (Simplification
        // Round #13/#14): the table and its historical rows are preserved for
        // read/rollback, but nothing writes to it anymore. Core data model is
        // now exactly product_current + daily_packed_history.
      } catch (v2Err) {
        // Simplification Round #17: a V2 write failure must never be a silent
        // divergence between legacy snapshots (already committed above) and
        // V2 Current/History. Record a durable repair task instead of only
        // logging — recordV2WriteFailure() below.
        recordV2WriteFailure(runId, itemUid, v2Err.message);
      }

      // Legacy status field kept for the optional legacy row below; falls
      // back to the pre-V2 legacy-snapshot lookup only in the degraded case
      // where the V2 write itself failed (v2Result is null).
      let prevSnapshotId = null;
      let status;
      if (v2Result) {
        status = v2Result.isNew ? 'new' : 'active';
      } else {
        const prevSnapshot = prevRunId > 0 ? stmt.findPreviousSnapshot.get(platform, query, itemUid, runId + 1) : null;
        status = prevSnapshot ? 'active' : 'new';
        if (prevSnapshot) prevSnapshotId = prevSnapshot.id;
      }
      if (status === 'new') newCount++; else activeCount++;

      // §6.1: this Run's own packed result array — populated unconditionally
      // (not gated by LEGACY_SNAPSHOT_WRITE), so /api/runs/:id and
      // /api/export/:runId never depend on legacy `snapshots` rows existing.
      resultItems.push({
        item_uid: itemUid,
        platform,
        title: parsed.title,
        url: parsed.url,
        landingUrl: parsed.landingUrl,
        image: parsed.image,
        author: parsed.author,
        price: parsed.price,
        currency: parsed.currency,
        source_price: parsed.source_price,
        source_currency: parsed.source_currency,
        fx_rate: parsed.fx_rate,
        fx_at: parsed.fx_at,
        rating: parsed.rating,
        reviews: parsed.reviews,
        sold_count: parsed.soldCount,
        likes: parsed.likes,
        fanpageLikes: parsed.fanpageLikes,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        isActive: parsed.isActive,
        publisherPlatforms: parsed.publisherPlatforms,
        cta: parsed.cta,
        subreddit: parsed.subreddit,
        comments: parsed.comments,
        shares: parsed.shares,
        views: parsed.views,
        status,
        observed_at: new Date().toISOString()
      });

      // §14/§16: Gate legacy snapshot writes. When LEGACY_SNAPSHOT_WRITE=false,
      // the snapshots table stops growing (no new rows). V2 dual-write continues.
      if (LEGACY_SNAPSHOT_WRITE) {
        stmt.insertSnapshot.run({
          runId,
          platform,
          query,
          itemUid,
          rawData: serializeItemForStorage(item),
          title: parsed.title,
          url: parsed.url,
          image: parsed.image,
          author: parsed.author,
          price: parsed.price,
          rating: parsed.rating,
          reviews: parsed.reviews,
          soldCount: parsed.soldCount,
          likes: parsed.likes,
          comments: parsed.comments,
          shares: parsed.shares,
          views: parsed.views,
          status,
          prevSnapshotId,
        });
      }
    }

    // §12: dropped items — sourced from product_current (V2), never the
    // legacy snapshots table. An item counts as dropped for this run when it
    // was last touched by the immediately-preceding run for this
    // platform+query (product_current.last_run_id = prevRunId) but is absent
    // from this run's item set. This stays correct with LEGACY_SNAPSHOT_WRITE
    // off, across arbitrarily many subsequent runs, using only columns
    // product_current already has (no new metadata table).
    if (prevRunId > 0) {
      const staleCandidates = db.prepare(
        "SELECT * FROM product_current WHERE platform = ? AND query = ? AND last_run_id = ? AND status != 'dropped'"
      ).all(platform, query, prevRunId);
      for (const cand of staleCandidates) {
        if (currentUids.has(cand.item_uid)) continue;
        droppedCount++;
        stmt.markProductCurrentDropped.run(cand.item_uid);
        // §16: Only insert legacy dropped snapshots if flag is on. Sourced
        // from product_current's own fields, not a legacy-table read, so
        // this still works correctly even if legacy writes were already off
        // during the run that most recently touched this item.
        if (LEGACY_SNAPSHOT_WRITE) {
          stmt.insertSnapshot.run({
            runId,
            platform,
            query,
            itemUid: cand.item_uid,
            rawData: JSON.stringify(cand),
            title: cand.title,
            url: cand.url,
            image: cand.image,
            author: cand.author,
            price: cand.current_price,
            rating: cand.current_rating,
            reviews: cand.current_reviews,
            soldCount: cand.current_sold,
            likes: cand.current_likes,
            comments: cand.current_comments,
            shares: cand.current_shares,
            views: cand.current_views,
            status: 'dropped',
            prevSnapshotId: null,
          });
        }
      }
    }
  });

  insertMany(items);

  // §6.1: written unconditionally, independent of LEGACY_SNAPSHOT_WRITE.
  db.prepare('UPDATE runs SET result_items_json = ? WHERE id = ?').run(JSON.stringify(resultItems), runId);

  // Update run counts
  updateRun(runId, {
    itemsCount: items.length,
    newCount,
    activeCount,
    droppedCount,
  });

  return { newItems: newCount, activeItems: activeCount, droppedItems: droppedCount };
}

/**
 * §6.2: single helper for "what items did this Run produce" — used by both
 * /api/runs/:id and /api/export/:runId so neither route hand-rolls its own
 * legacy-vs-V2 branching. READ_MODEL_V2=false reads legacy `snapshots`
 * (unchanged behavior); READ_MODEL_V2=true reads runs.result_items_json,
 * which is populated on every insertSnapshots() call regardless of
 * LEGACY_SNAPSHOT_WRITE — so this never returns empty for a post-cutover Run.
 */
function getRunItems(runId) {
  if (!READ_MODEL_V2) {
    return getSnapshotsByRunId(runId);
  }
  const run = stmt.findRunById.get(runId);
  if (!run || !run.result_items_json) return [];
  try {
    return JSON.parse(run.result_items_json);
  } catch (_e) {
    return [];
  }
}

/**
 * §6.3: idempotent backfill — only processes runs whose result_items_json is
 * still NULL, from their existing legacy `snapshots` rows. Running this
 * twice processes zero additional rows the second time. Never deletes or
 * modifies legacy data.
 */
function backfillRunResultItems() {
  const targets = db.prepare('SELECT id FROM runs WHERE result_items_json IS NULL').all();
  let migrated = 0;
  for (const { id } of targets) {
    const snapshots = getSnapshotsByRunId(id);
    const resultItems = snapshots.map((s) => ({
      item_uid: s.item_uid, platform: s.platform, title: s.title, url: s.url, image: s.image, author: s.author,
      price: s.price, rating: s.rating, reviews: s.reviews, sold_count: s.sold_count, likes: s.likes,
      comments: s.comments, shares: s.shares, views: s.views, status: s.status, observed_at: s.created_at
    }));
    db.prepare('UPDATE runs SET result_items_json = ? WHERE id = ?').run(JSON.stringify(resultItems), id);
    migrated++;
  }
  return { migrated, totalCandidates: targets.length };
}

function getLatestSnapshots({ search = '', platform = '', limit = 200 } = {}) {
  const terms = String(search).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const filters = [];
  const params = { limit: Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 200)) };
  if (String(platform).trim()) {
    filters.push('s.platform = @platform');
    params.platform = String(platform).trim();
  }
  for (const [index, term] of terms.entries()) {
    const parameter = `term${index}`;
    filters.push(`LOWER(s.title || ' ' || s.author || ' ' || s.platform || ' ' || s.raw_data) LIKE @${parameter}`);
    params[parameter] = `%${term}%`;
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db.prepare(`
    SELECT s.* FROM snapshots s
    INNER JOIN (SELECT platform, query, MAX(run_id) as max_run FROM snapshots GROUP BY platform, query) latest
    ON s.platform = latest.platform AND s.query = latest.query AND s.run_id = latest.max_run
    ${where}
    ORDER BY s.created_at DESC
    LIMIT @limit
  `).all(params);
}
function getSnapshotHistory(itemUid) { return stmt.getSnapshotHistory.all(itemUid); }
function getLatestSnapshotByUid(itemUid) {
  return db.prepare('SELECT * FROM snapshots WHERE item_uid = ? ORDER BY id DESC LIMIT 1').get(itemUid);
}
function getSnapshotsByRunId(runId) { return stmt.findSnapshotsByRunId.all(runId); }
function getSnapshotsMissingEtsyImages(limit = 50) {
  const normalizedLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 50));
  return stmt.findSnapshotsMissingEtsyImage.all(normalizedLimit);
}
function updateSnapshotImage(id, image) {
  const normalizedImage = cleanImageUrl(image);
  if (!normalizedImage) return false;
  return stmt.updateSnapshotImage.run(normalizedImage, id).changes > 0;
}

function getStats() {
  const totalRuns = stmt.countRuns.get().total;
  let totalSnapshots = 0;
  const platformCounts = {};

  try {
    if (READ_MODEL_V2) {
      const totalRow = db.prepare("SELECT COUNT(*) as total FROM product_current WHERE status != 'dropped'").get();
      totalSnapshots = totalRow?.total || 0;
      const rows = db.prepare("SELECT platform, COUNT(*) as count FROM product_current WHERE status != 'dropped' GROUP BY platform").all();
      for (const r of rows) {
        platformCounts[r.platform] = r.count;
      }
    } else {
      totalSnapshots = stmt.countSnapshots.get().total;
      const rows = db.prepare("SELECT platform, COUNT(DISTINCT item_uid) as count FROM snapshots WHERE status != 'dropped' GROUP BY platform").all();
      for (const r of rows) {
        platformCounts[r.platform] = r.count;
      }
    }
  } catch (_e) {
    totalSnapshots = stmt.countSnapshots.get().total;
  }

  return { totalRuns, totalSnapshots, platformCounts };
}

function getRunStats() {
  return stmt.getRunsByPlatform.all();
}

function createMarketplaceAccount({ platform, label, storageState, proxyId = null }) {
  const { assertSupportedMarketplace } = require('./marketplaces/validation');
  const { encryptText } = require('./security/encrypted-store');
  const { normalizeBrowserStorageState } = require('./marketplaces/storage-state');
  assertSupportedMarketplace(platform);
  const cleanedLabel = String(label || '').trim();
  if (!cleanedLabel || cleanedLabel.length > 100) throw new Error('Account label must be between 1 and 100 characters');

  const state = normalizeBrowserStorageState(platform, storageState);
  const normalizedProxyId = resolveMarketplaceProxyId(proxyId);

  const result = stmt.createMarketplaceAccount.run({
    platform,
    label: cleanedLabel,
    sessionEncrypted: encryptText(JSON.stringify(state)),
    proxyId: normalizedProxyId,
  });
  return stmt.findMarketplaceAccount.get(result.lastInsertRowid);
}

function getMarketplaceAccounts(platform) {
  const { assertSupportedMarketplace } = require('./marketplaces/validation');
  assertSupportedMarketplace(platform);
  return stmt.findMarketplaceAccounts.all(platform);
}

function getMarketplaceStorageState(id) {
  const { decryptText } = require('./security/encrypted-store');
  const record = stmt.findMarketplaceSession.get(id);
  if (!record) return null;
  return decryptText(record.session_encrypted);
}

function deleteMarketplaceAccount(id) {
  return stmt.deleteMarketplaceAccount.run(id).changes > 0;
}

function createMarketplaceProxy(input) {
  const { validateSocks5Proxy } = require('./marketplaces/proxy');
  const { encryptText } = require('./security/encrypted-store');
  const proxy = validateSocks5Proxy(input);
  const result = stmt.createMarketplaceProxy.run({
    label: proxy.label,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    configEncrypted: encryptText(JSON.stringify(proxy)),
  });
  return stmt.findMarketplaceProxy.get(result.lastInsertRowid);
}

function getMarketplaceProxies() {
  return stmt.findMarketplaceProxies.all();
}

function getMarketplaceProxyUrl(id) {
  if (!id) return null;
  const { decryptText } = require('./security/encrypted-store');
  const { buildSocks5ProxyUrl } = require('./marketplaces/proxy');
  const record = stmt.findMarketplaceProxyConfig.get(Number(id));
  if (!record) return null;
  return buildSocks5ProxyUrl(JSON.parse(decryptText(record.config_encrypted)));
}

function assignMarketplaceAccountProxy(accountId, proxyId = null) {
  const account = stmt.findMarketplaceAccount.get(Number(accountId));
  if (!account) return null;
  const normalizedProxyId = resolveMarketplaceProxyId(proxyId);
  stmt.updateMarketplaceAccountProxy.run(normalizedProxyId, Number(accountId));
  return stmt.findMarketplaceAccount.get(Number(accountId));
}

function deleteMarketplaceProxy(id) {
  const normalizedId = Number(id);
  if (!Number.isInteger(normalizedId) || normalizedId < 1) return false;
  return db.transaction(() => {
    stmt.clearMarketplaceProxyAssignments.run(normalizedId);
    return stmt.deleteMarketplaceProxy.run(normalizedId).changes > 0;
  })();
}

function resolveMarketplaceProxyId(proxyId) {
  if (proxyId == null || proxyId === '') return null;
  const normalizedId = Number(proxyId);
  if (!Number.isInteger(normalizedId) || normalizedId < 1) throw new Error('Proxy profile is invalid');
  if (!stmt.findMarketplaceProxy.get(normalizedId)) throw new Error('Proxy profile was not found');
  return normalizedId;
}

function normalizeCaptureVariantOptions(variantMode, maxVariants) {
  const { normalizeVariantMode, normalizeMaxVariants } = require('./marketplaces/variant-pricing');
  const mode = normalizeVariantMode(variantMode);
  return { variantMode: mode, maxVariants: mode === 'all' ? normalizeMaxVariants(maxVariants) : 0 };
}

function createMarketplaceCapture({ platform, accountId = null, url, html, parsedData, variantMode = 'base', maxVariants = 0 }) {
  const crypto = require('crypto');
  const { normalizeMarketplaceCaptureUrl } = require('./marketplaces/validation');
  const { encryptText } = require('./security/encrypted-store');
  const captureUrl = normalizeMarketplaceCaptureUrl(platform, url);
  const captureOptions = normalizeCaptureVariantOptions(variantMode, maxVariants);
  if (typeof html !== 'string' || !html.trim()) throw new Error('Captured HTML is required');

  const result = stmt.createMarketplaceCapture.run({
    platform,
    accountId,
    url: captureUrl,
    htmlEncrypted: encryptText(html),
    htmlSha256: crypto.createHash('sha256').update(html).digest('hex'),
    parsedData: JSON.stringify(parsedData || {}),
    variantMode: captureOptions.variantMode,
    maxVariants: captureOptions.maxVariants,
  });
  return getMarketplaceCaptureMetadata(result.lastInsertRowid);
}

function getCachedMarketplaceCapture({ platform, accountId = null, url, variantMode = 'base', maxVariants = 0 }) {
  const { normalizeMarketplaceCaptureUrl } = require('./marketplaces/validation');
  const captureOptions = normalizeCaptureVariantOptions(variantMode, maxVariants);
  const captureUrl = normalizeMarketplaceCaptureUrl(platform, url);
  const captures = stmt.findCachedMarketplaceCaptures.all({
    platform,
    accountId: accountId == null ? null : Number(accountId),
    url: captureUrl,
    variantMode: captureOptions.variantMode,
    maxVariants: captureOptions.maxVariants,
  });
  for (const capture of captures) {
    const parsedData = JSON.parse(capture.parsed_data);
    if (parsedData?.capture?.status === 'ok') {
      const { parsed_data, ...metadata } = capture;
      return { ...metadata, parsedData };
    }
  }
  return null;
}

function getMarketplaceCaptureMetadata(id) {
  const capture = stmt.findMarketplaceCapture.get(id);
  if (!capture) return null;
  const metadata = { ...capture };
  delete metadata.html_encrypted;
  const parsedData = JSON.parse(metadata.parsed_data);
  delete metadata.parsed_data;
  return { ...metadata, parsedData };
}

function getMarketplaceCapture(id) {
  const { decryptText } = require('./security/encrypted-store');
  const capture = stmt.findMarketplaceCapture.get(id);
  if (!capture) return null;
  const { html_encrypted, parsed_data, ...metadata } = capture;
  return { ...metadata, html: decryptText(html_encrypted), parsedData: JSON.parse(parsed_data) };
}

function getMarketplaceCaptures({ platform = null, limit = 50 } = {}) {
  if (platform) require('./marketplaces/validation').assertSupportedMarketplace(platform);
  return stmt.findMarketplaceCaptures.all({ platform, limit: Math.min(Math.max(Number(limit) || 50, 1), 100) })
    .map(({ parsed_data, ...capture }) => ({ ...capture, parsedData: JSON.parse(parsed_data) }));
}

function createMarketplaceCaptureSchedule(input) {
  const { normalizeScheduleInput } = require('./marketplaces/capture-scheduler');
  const schedule = normalizeScheduleInput(input);
  if (schedule.accountId && !stmt.findMarketplaceAccount.get(schedule.accountId)) throw new Error('Marketplace account not found');
  const { nextScheduleRunAt } = require('./marketplaces/capture-scheduler');
  const nextRunAt = nextScheduleRunAt({ schedule_type: schedule.scheduleType, daily_time: schedule.dailyTime, run_at: schedule.runAt, every_minutes: schedule.everyMinutes }).toISOString();
  if (schedule.scheduleType === 'once' && new Date(nextRunAt) <= new Date()) throw new Error('Choose a future date and time');
  const result = stmt.createMarketplaceCaptureSchedule.run({ ...schedule, nextRunAt });
  return getMarketplaceCaptureSchedules().find((candidate) => candidate.id === Number(result.lastInsertRowid));
}

function getMarketplaceCaptureSchedules() {
  return stmt.findMarketplaceCaptureSchedules.all().map((schedule) => ({ ...schedule, last_summary: schedule.last_summary ? JSON.parse(schedule.last_summary) : null }));
}

function getDueMarketplaceCaptureSchedules(now = new Date()) {
  return stmt.findDueMarketplaceCaptureSchedules.all({ now: now.toISOString() });
}

/**
 * Atomic claim (Live-Readiness Round #12): the UPDATE's WHERE clause re-checks
 * claimed_until at the moment of the write, so two ticks racing to claim the
 * same schedule cannot both succeed — only one UPDATE actually changes a row.
 * A crash mid-capture leaves claimed_until in the past once the lease expires,
 * so the schedule becomes claimable again automatically (no manual recovery needed).
 */
function claimMarketplaceCaptureSchedule(id, leaseMs = 5 * 60 * 1000) {
  const crypto = require('crypto');
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + leaseMs).toISOString();
  const claimToken = crypto.randomBytes(12).toString('hex');
  const info = stmt.claimMarketplaceCaptureSchedule.run({ id: Number(id), claimedUntil, claimToken, now: now.toISOString() });
  // Return the claim_token on success so callers can use it for renew/release.
  // Existing callers that check `=== true` will still be truthy with a string.
  return info.changes > 0 ? claimToken : false;
}

function releaseMarketplaceCaptureScheduleClaim(id, claimToken = null) {
  stmt.releaseMarketplaceCaptureScheduleClaim.run({ id: Number(id), claimToken });
}

/**
 * Final Stabilization Round #12: a fixed claim TTL is not sufficient for a
 * schedule whose real work (discovery + N sequential captures) can outlive
 * the original lease window. Extends claimed_until only while the caller
 * still holds an unexpired claim (see renewMarketplaceCaptureScheduleClaim
 * statement) — a process that already lost its lease cannot resurrect a claim
 * a second tick has since taken over.
 * §6: claim_token must match for renewal to succeed.
 */
function renewMarketplaceCaptureScheduleClaim(id, leaseMs = 5 * 60 * 1000, claimToken = null) {
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + leaseMs).toISOString();
  const info = stmt.renewMarketplaceCaptureScheduleClaim.run({ id: Number(id), claimedUntil, claimToken, now: now.toISOString() });
  return info.changes > 0;
}

// §3: claimToken is a 4th, optional param (kept after `now` for backward
// compatibility with existing callers that pass `now` positionally without a
// claim in play, e.g. test schedules that were never claimed).
function completeMarketplaceCaptureSchedule(id, summary, now = new Date(), claimToken = null) {
  const schedule = getMarketplaceCaptureSchedules().find((candidate) => candidate.id === Number(id));
  if (!schedule) return false;
  const summaryJson = JSON.stringify(summary);
  return db.transaction(() => {
    // §3: the schedule-row UPDATE is claim_token-protected FIRST. If a stale
    // attempt's token no longer matches the current claim (or no claim
    // exists but one was expected), 0 rows change — do NOT insert a
    // completion history row or touch next_run_at for whoever actually owns
    // the schedule now.
    let changes;
    if (schedule.schedule_type === 'once') {
      changes = stmt.completeOneTimeMarketplaceCaptureSchedule.run({ id: Number(id), now: now.toISOString(), summary: summaryJson, claimToken }).changes;
    } else {
      const { nextScheduleRunAt } = require('./marketplaces/capture-scheduler');
      changes = stmt.completeMarketplaceCaptureSchedule.run({ id: Number(id), now: now.toISOString(), nextRunAt: nextScheduleRunAt(schedule, now).toISOString(), summary: summaryJson, claimToken }).changes;
    }
    if (changes === 0) return false; // MARKETPLACE_CLAIM_LOST
    stmt.createMarketplaceCaptureScheduleRun.run({ scheduleId: Number(id), summary: summaryJson, completedAt: now.toISOString() });
    return true;
  })();
}

function getMarketplaceCaptureScheduleRuns(scheduleId, limit = 20) {
  const normalizedId = Number(scheduleId);
  if (!Number.isInteger(normalizedId) || normalizedId < 1) return [];
  return stmt.findMarketplaceCaptureScheduleRuns.all({ scheduleId: normalizedId, limit: Math.min(Math.max(Number(limit) || 20, 1), 100) })
    .map((run) => ({ ...run, summary: JSON.parse(run.summary) }));
}

function deleteMarketplaceCaptureSchedule(id) {
  return stmt.deleteMarketplaceCaptureSchedule.run(Number(id)).changes > 0;
}

function toggleMarketplaceCaptureSchedule(id) {
  const info = stmt.toggleMarketplaceCaptureSchedule.run(Number(id));
  if (info.changes === 0) return null;
  return getMarketplaceCaptureSchedules().find((c) => c.id === Number(id)) || null;
}

// ==================== Helpers ====================

function parseItemData(item) {
  let d;
  try { d = typeof item === 'string' ? JSON.parse(item) : item; } catch { d = {}; }

  const title = d.title || d.adTitle || d.productTitle || d.name || d.text || '';
  const image = d.image || extractImage(d);
  const archiveId = d.adArchiveId || d.adArchiveID || '';
  const adLibraryUrl = archiveId ? `https://www.facebook.com/ads/library/?id=${archiveId}` : '';
  const url = d.url || adLibraryUrl || d.permalink || d.adUrl || d.link || d.productUrl || '';
  const author = typeof (d.author || d.advertiserName || d.advertiser || d.pageName || d.snapshot?.pageName || d.username || '') === 'object'
    ? (d.author?.name || d.author?.username || '')
    : (d.author || d.advertiserName || d.advertiser || d.pageName || d.snapshot?.pageName || d.username || '');

  const price = parseDecimal(d.price || d.adSpend || d.product_price || d.currentPrice || 0);
  const currency = d.currency || 'USD';
  const sourcePrice = d.source_price !== undefined ? parseDecimal(d.source_price) : price;
  const sourceCurrency = d.source_currency || currency;
  const fxRate = d.fx_rate !== undefined ? d.fx_rate : (currency === 'USD' ? 1.0 : null);
  const fxAt = d.fx_at || null;

  const rating = parseDecimal(d.rating || d.averageRating || d.average_rating || d.stars || d.productRating || d.score || d.review_score || 0);
  const reviews = parseNum(d.reviewCount || d.review_count || d.reviews || d.reviewsCount || d.ratingsCount || d.ratingCount || d.total_reviews || 0);
  const soldCount = parseNum(d.soldCount || d.sold_count || d.sold || d.sales || d.orders || d.orderCount || d.total_sold || d.item_sold || d.volume || 0);
  const likes = parseNum(d.likes || d.likeCount || d.like_count || d.favorite_count || d.favoriteCount || d.favorites || d.upvotes || d.score || d.favouritesCount || d.reactions_count || 0);
  const comments = parseNum(d.comments || d.commentCount || d.commentsCount || d.replyCount || d.reply_count || d.replies || d.conversation_count || d.num_comments || d.numComments || d.comments_count || 0);
  const shares = parseNum(d.shares || d.shareCount || d.sharesCount || d.retweetCount || d.retweet_count || d.retweets || d.reposts || d.repostCount || d.reshare_count || 0);
  const views = parseNum(d.views || d.viewCount || d.viewsCount || d.impressions || d.impression_count || d.view_count || d.video_view_count || 0);

  const parseSafeDate = (val) => {
    if (!val) return '';
    if (typeof val === 'number') {
      const dt = new Date(val > 1e11 ? val : val * 1000);
      return isNaN(dt.getTime()) ? '' : dt.toISOString();
    }
    const dt = new Date(val);
    return isNaN(dt.getTime()) ? String(val) : dt.toISOString();
  };
  const startDate = d.startDateFormatted || parseSafeDate(d.startDate) || d.firstSeenAt || '';
  const endDate = d.endDateFormatted || parseSafeDate(d.endDate) || '';
  const isActive = d.isActive !== undefined ? d.isActive : true;
  const publisherPlatforms = d.publisherPlatforms || d.publisherPlatform || d.snapshot?.publisherPlatform || [];
  const fanpageLikes = parseNum(d.fanpageLikes || d.snapshot?.pageLikeCount || d.pageLikeCount || likes || 0);
  const cta = d.cta || d.ctaText || d.snapshot?.ctaText || '';
  const landingUrl = d.landingUrl || d.snapshot?.linkUrl || '';
  // Reddit-specific: subreddit name for UI display (r/xxx). `likes` already
  // carries Reddit's upvote score (reddit.js sets likes:d.ups) and `comments`
  // already carries the real total comment count — both reused as-is, only
  // the subreddit label itself was missing from persisted metadata.
  const subreddit = d.subreddit || '';

  return { title: String(title).substring(0, 200), image, url, author: String(author).substring(0, 100),
    price, currency, source_price: sourcePrice, source_currency: sourceCurrency, fx_rate: fxRate, fx_at: fxAt,
    rating, reviews, soldCount, likes, comments, shares, views,
    startDate, endDate, isActive, publisherPlatforms, fanpageLikes, cta, landingUrl, subreddit };
}

function serializeItemForStorage(item) {
  if (typeof item !== 'string') return JSON.stringify(sanitizeForStorage(item));
  try {
    return JSON.stringify(sanitizeForStorage(JSON.parse(item)));
  } catch {
    return JSON.stringify({ rawText: item });
  }
}

function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0;
  const match = String(v ?? '').replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
  if (!match) return 0;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return Math.round(Number(match[1]) * multiplier) || 0;
}

function parseDecimal(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const match = String(v ?? '').replace(/,/g, '').match(/[\d.]+/);
  return match ? Number(match[0]) || 0 : 0;
}

function generateUid(platform, query, parsed) {
  // Use URL if available, otherwise title+author hash
  if (parsed.url) return `${platform}:${parsed.url}`;
  return `${platform}:${query}:${parsed.title}:${parsed.author}`.toLowerCase().replace(/[^a-z0-9:]/g, '');
}

// ==================== V2 3-Tier Storage Accessors & Backfill ====================

function getProductCurrent(options = {}) {
  return productCurrentOps.listCurrent(options);
}

/**
 * §11 (Final Architecture Closure Round): single-row V2 lookup so callers
 * (export growth) can read this item's already-computed delta_* fields
 * instead of falling back to legacy getSnapshotHistory().
 */
function getProductCurrentByUid(itemUid) {
  return productCurrentOps.findByUid(itemUid);
}

function getProductHistory(itemUid, limitDays = 30) {
  return dailyHistoryOps.getHistory(itemUid, limitDays);
}

// UI-BUG-04: SQLite's default CURRENT_TIMESTAMP format is naive
// "YYYY-MM-DD HH:MM:SS" UTC, with no timezone marker — writing it straight
// into a CSV export reads as if it were already local time to anyone opening
// the file, a ~7h (UTC+7) gap from the real Vietnam-local time it
// represents. Convert explicitly and label it, matching the "(Vietnam)"
// convention already used elsewhere in this app.
function formatVietnamTime(utcString) {
  if (!utcString) return '';
  const date = new Date(String(utcString).replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return String(utcString);
  return date.toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }).replace(',', '') + ' (Vietnam)';
}

// UI-BUG-01: daily_packed_history observations only ever carry the metric
// fields (price/likes/comments/shares/views/sold/rating/reviews) — never the
// item's static metadata (title/platform/url/image/author/status), which
// lives in product_current instead. The Product Detail modal renders
// `history[history.length-1].title/platform/url`, so every point was
// rendering "Untitled", platform `undefined`, and no URL even though
// product_current itself has correct data. Look the item's metadata up once
// and denormalize it onto every point, matching what the legacy
// `snapshots`-backed history path already returns per-row.
function getProductHistoryWithMetadata(itemUid, limitDays = 365) {
  const currentItem = getProductCurrentByUid(itemUid);
  let richMeta = {};
  if (currentItem?.last_run_id) {
    try {
      const run = stmt.findRunById.get(currentItem.last_run_id);
      if (run?.result_items_json) {
        const items = JSON.parse(run.result_items_json);
        const match = items.find(it => it.item_uid === itemUid);
        if (match) {
          richMeta = {
            startDate: match.startDate || '',
            endDate: match.endDate || '',
            isActive: match.isActive !== undefined ? match.isActive : true,
            publisherPlatforms: match.publisherPlatforms || [],
            fanpageLikes: match.fanpageLikes || currentItem.current_likes || 0,
            cta: match.cta || '',
            landingUrl: match.landingUrl || '',
            subreddit: match.subreddit || ''
          };
        }
      }
    } catch {}
  }

  const metadata = currentItem
    ? {
        platform: currentItem.platform,
        title: currentItem.title,
        url: currentItem.url,
        image: currentItem.image,
        author: currentItem.author,
        status: currentItem.status,
        ...richMeta
      }
    : {};

  const dailyRows = getProductHistory(itemUid, limitDays);
  const points = [];
  for (const day of dailyRows) {
    for (const obs of day.observations || []) {
      points.push({
        item_uid: itemUid,
        ...metadata,
        created_at: `${day.date} ${obs.time}`,
        price: obs.price, likes: obs.likes, comments: obs.comments,
        shares: obs.shares, views: obs.views, sold_count: obs.sold,
        rating: obs.rating, reviews: obs.reviews
      });
    }
  }
  points.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return points;
}

/**
 * @deprecated weekly_summary is no longer part of the core data path
 * (Simplification Round #13/#14). Nothing writes to it anymore; this reads
 * whatever historical rows already exist for rollback/archival purposes only.
 * No API route in server.js calls this.
 */
function getProductWeekly(itemUid, limitWeeks = 12) {
  return weeklySummaryOps.getWeekly(itemUid, limitWeeks);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS v2_write_failures (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER,
    item_uid      TEXT NOT NULL,
    error_message TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending', -- pending | repaired
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

/**
 * Durable repair task (Simplification Round #17) — a V2 (Current/History)
 * write failure is recorded here instead of only console.warn'd, so a
 * legacy-write-succeeded-but-V2-write-failed divergence is discoverable and
 * repairable, not silently lost. repairPendingV2WriteFailures() replays these
 * against the same snapshot data already safely stored in `snapshots`.
 */
function recordV2WriteFailure(runId, itemUid, errorMessage) {
  console.warn('[DB V2 Dual-Write Error]:', errorMessage);
  db.prepare('INSERT INTO v2_write_failures (run_id, item_uid, error_message) VALUES (?, ?, ?)').run(runId, itemUid, String(errorMessage || ''));
}

function getPendingV2WriteFailures() {
  return db.prepare("SELECT * FROM v2_write_failures WHERE status = 'pending' ORDER BY id ASC").all();
}

/** Re-attempts each pending V2 write failure from its original snapshot row. Marks repaired on success. */
function repairPendingV2WriteFailures() {
  const pending = getPendingV2WriteFailures();
  let repaired = 0;
  for (const failure of pending) {
    const snap = db.prepare('SELECT * FROM snapshots WHERE run_id = ? AND item_uid = ? ORDER BY id DESC LIMIT 1').get(failure.run_id, failure.item_uid);
    if (!snap) continue;
    try {
      const v2Item = {
        item_uid: snap.item_uid, platform: snap.platform, query: snap.query, title: snap.title, url: snap.url,
        image: snap.image, author: snap.author, price: snap.price, rating: snap.rating, reviews: snap.reviews,
        sold_count: snap.sold_count, likes: snap.likes, comments: snap.comments, shares: snap.shares, views: snap.views
      };
      productCurrentOps.upsertItem(v2Item, snap.run_id, snap.created_at);
      // §4.1: migrated observations use legacy:<snapshot_id> identity — a
      // re-run of this migration for the same legacy row replaces its own
      // prior entry instead of duplicating it (§4.2 idempotency).
      dailyHistoryOps.appendObservation(v2Item, snap.created_at, { legacySnapshotId: snap.id });
      db.prepare("UPDATE v2_write_failures SET status = 'repaired' WHERE id = ?").run(failure.id);
      repaired++;
    } catch (_err) {
      // Still pending; will be retried on the next repair pass.
    }
  }
  return { attempted: pending.length, repaired };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS migration_checkpoints (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const BACKFILL_CHECKPOINT_KEY = 'backfill_v2_last_snapshot_id';

/**
 * Idempotent (Simplification Round #18): only processes snapshots newer than
 * the last recorded checkpoint. Running this twice in a row processes zero
 * new rows the second time — it cannot append duplicate observations to
 * daily_packed_history or re-count deltas in product_current.
 */
function backfillSnapshotsToV2() {
  const checkpointRow = db.prepare('SELECT value FROM migration_checkpoints WHERE key = ?').get(BACKFILL_CHECKPOINT_KEY);
  const lastId = checkpointRow ? Number(checkpointRow.value) : 0;
  const allSnapshots = db.prepare('SELECT * FROM snapshots WHERE id > ? ORDER BY created_at ASC, id ASC').all(lastId);
  let migrated = 0;
  let maxId = lastId;

  const tx = db.transaction((rows) => {
    for (const snap of rows) {
      const v2Item = {
        item_uid: snap.item_uid,
        platform: snap.platform,
        query: snap.query,
        title: snap.title,
        url: snap.url,
        image: snap.image,
        author: snap.author,
        price: snap.price,
        rating: snap.rating,
        reviews: snap.reviews,
        sold_count: snap.sold_count,
        likes: snap.likes,
        comments: snap.comments,
        shares: snap.shares,
        views: snap.views
      };
      const normalizedTs = normalizeLegacyUtcTimestamp(snap.created_at);
      productCurrentOps.upsertItem(v2Item, snap.run_id, normalizedTs);
      // §4.1: migrated observations use legacy:<snapshot_id> identity — a
      // re-run of this migration for the same legacy row replaces its own
      // prior entry instead of duplicating it (§4.2 idempotency).
      dailyHistoryOps.appendObservation(v2Item, normalizedTs, { legacySnapshotId: snap.id });
      // weekly_summary deprecated from backfill too — see note in insertSnapshots.
      maxId = Math.max(maxId, snap.id);
      migrated++;
    }
    db.prepare('INSERT INTO migration_checkpoints (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP')
      .run(BACKFILL_CHECKPOINT_KEY, String(maxId));
  });

  tx(allSnapshots);
  return { migrated, totalSnapshots: allSnapshots.length };
}

// §13: fields checked for semantic current-state parity — price/likes alone
// (the pre-§13 check) is not enough to gate a real cutover.
const V2_PARITY_METRIC_FIELDS = [
  { legacy: 'price', v2: 'current_price' },
  { legacy: 'views', v2: 'current_views' },
  { legacy: 'likes', v2: 'current_likes' },
  { legacy: 'comments', v2: 'current_comments' },
  { legacy: 'shares', v2: 'current_shares' },
  { legacy: 'sold_count', v2: 'current_sold' },
  { legacy: 'rating', v2: 'current_rating' },
  { legacy: 'reviews', v2: 'current_reviews' }
];

// Gap #3 closure (Final Gap Closure Round): maps a legacy `snapshots` column
// to its corresponding field inside a daily_packed_history observation, for
// exact per-observation (not just per-count) history parity.
const HISTORY_OBSERVATION_METRIC_FIELDS = [
  { legacy: 'price', obs: 'price' },
  { legacy: 'views', obs: 'views' },
  { legacy: 'likes', obs: 'likes' },
  { legacy: 'comments', obs: 'comments' },
  { legacy: 'shares', obs: 'shares' },
  { legacy: 'sold_count', obs: 'sold' },
  { legacy: 'rating', obs: 'rating' },
  { legacy: 'reviews', obs: 'reviews' }
];

/**
 * V2 Read/Write Parity Check (Live-Readiness Round #14, extended §13) —
 * this is the gate for safely flipping READ_MODEL_V2=true and disabling
 * LEGACY_SNAPSHOT_WRITE; it never modifies data. Two independent checks:
 *
 *  current: every item_uid in legacy `snapshots` must exist in
 *    `product_current` with agreeing price/views/likes/comments/shares/
 *    sold/rating/reviews/platform (a field null on either side is treated as
 *    "unknown", not a mismatch — a platform that never populated a metric on
 *    one side isn't a parity failure).
 *
 *  history: legacy stores one row per crawl per item_uid; V2 packs same-day
 *    observations into daily_packed_history's observation_count. The summed
 *    packed count per item_uid must not be LESS than the legacy count (V2
 *    capturing MORE granularity than legacy is fine, losing observations is
 *    not). Also scans for genuine duplicate observations (same item_uid+date
 *    +time recorded twice) within packed rows.
 */
function checkV2Parity() {
  const snapshotUids = db.prepare('SELECT DISTINCT item_uid FROM snapshots').all().map(r => r.item_uid);
  const productCurrentUids = new Set(db.prepare('SELECT item_uid FROM product_current').all().map(r => r.item_uid));

  const missingCurrent = [];
  const metricMismatches = [];
  const findLatestSnapshot = db.prepare('SELECT * FROM snapshots WHERE item_uid = ? ORDER BY id DESC LIMIT 1');
  const findCurrent = db.prepare('SELECT * FROM product_current WHERE item_uid = ?');

  let checked = 0;
  for (const uid of snapshotUids) {
    if (!productCurrentUids.has(uid)) { missingCurrent.push(uid); continue; }
    checked++;
    const latestSnap = findLatestSnapshot.get(uid);
    const current = findCurrent.get(uid);

    if (latestSnap.platform && current.platform && latestSnap.platform !== current.platform) {
      metricMismatches.push({ itemUid: uid, field: 'platform', legacyValue: latestSnap.platform, v2Value: current.platform });
    }

    for (const { legacy, v2 } of V2_PARITY_METRIC_FIELDS) {
      const legacyValue = latestSnap[legacy];
      const v2Value = current[v2];
      if (legacyValue == null && v2Value == null) continue; // both unpopulated — equal
      if (legacyValue == null || v2Value == null || Number(legacyValue) !== Number(v2Value)) {
        metricMismatches.push({ itemUid: uid, field: legacy, legacyValue, v2Value });
      }
    }
  }

  const legacyObsCountByUid = new Map(
    db.prepare('SELECT item_uid, COUNT(*) c FROM snapshots GROUP BY item_uid').all().map(r => [r.item_uid, r.c])
  );
  const packedObsCountByUid = new Map(
    db.prepare('SELECT item_uid, SUM(observation_count) c FROM daily_packed_history GROUP BY item_uid').all().map(r => [r.item_uid, r.c])
  );

  let missingHistoricalObservations = 0;
  const missingHistoricalObservationUids = [];
  for (const [uid, legacyCount] of legacyObsCountByUid.entries()) {
    const packedCount = packedObsCountByUid.get(uid) || 0;
    if (packedCount < legacyCount) {
      missingHistoricalObservations += (legacyCount - packedCount);
      missingHistoricalObservationUids.push(uid);
    }
  }

  // §4/§16.E: prefer the stable observationId identity (present on every
  // observation written by the current appendObservation()) when available —
  // it correctly distinguishes two real observations that legitimately land
  // in the same second from an actual duplicate. Rows written before this
  // round have no observationId; those fall back to the weaker time-based
  // check, which is still a real (if less precise) duplicate signal.
  let duplicateHistoricalObservations = 0;
  const duplicateHistoricalObservationUids = [];
  const globalObservationIds = new Set();
  let malformedObservations = 0;
  const malformedObservationUids = [];
  const malformedObservationSamples = [];
  const REQUIRED_OBSERVATION_FIELDS = [
    'observationId', 'runId', 'time', 'price', 'views',
    'likes', 'comments', 'shares', 'sold', 'rating', 'reviews'
  ];
  // Gap #3/#5 closure: item_uid -> Map<observationId, observation> and global
  // observationId set to detect duplicates across ALL rows in daily_packed_history.
  const observationIndex = new Map();
  const obsRowDateMap = new Map(); // observationId -> date

  for (const row of db.prepare('SELECT * FROM daily_packed_history').iterate()) {
    let observations = [];
    try {
      observations = JSON.parse(row.observations_json || '[]');
      if (!Array.isArray(observations)) observations = [];
    } catch (_e) {
      observations = [];
    }

    const seenTimesThisRow = new Set();
    for (const o of observations) {
      if (o && o.observationId != null) {
        if (globalObservationIds.has(o.observationId)) {
          duplicateHistoricalObservations += 1;
          if (duplicateHistoricalObservationUids.length < 20) duplicateHistoricalObservationUids.push(row.item_uid);
        } else {
          globalObservationIds.add(o.observationId);
        }
      } else if (o && o.time) {
        if (seenTimesThisRow.has(o.time)) {
          duplicateHistoricalObservations += 1;
          if (duplicateHistoricalObservationUids.length < 20) duplicateHistoricalObservationUids.push(row.item_uid);
        } else {
          seenTimesThisRow.add(o.time);
        }
      }

      // Gap #5 closure: Schema completeness validation on every packed observation
      if (!o || typeof o !== 'object') {
        malformedObservations += 1;
        if (!malformedObservationUids.includes(row.item_uid) && malformedObservationUids.length < 20) {
          malformedObservationUids.push(row.item_uid);
        }
        if (malformedObservationSamples.length < 20) malformedObservationSamples.push({ itemUid: row.item_uid, date: row.date, reason: 'non-object observation' });
      } else {
        const missingKeys = REQUIRED_OBSERVATION_FIELDS.filter(k => !(k in o));
        if (missingKeys.length > 0) {
          malformedObservations += 1;
          if (!malformedObservationUids.includes(row.item_uid) && malformedObservationUids.length < 20) {
            malformedObservationUids.push(row.item_uid);
          }
          if (malformedObservationSamples.length < 20) {
            malformedObservationSamples.push({ itemUid: row.item_uid, date: row.date, missingKeys });
          }
        }
      }
    }

    if (!observationIndex.has(row.item_uid)) observationIndex.set(row.item_uid, new Map());
    const byId = observationIndex.get(row.item_uid);
    for (const o of observations) {
      if (o && o.observationId != null) {
        byId.set(o.observationId, o);
        obsRowDateMap.set(o.observationId, row.date);
      }
    }
  }

  // Gap #3/#5 / Patch 2: exact per-observation identity + per-metric and timestamp comparison
  // against the legacy source-of-truth.
  let historyMissingByIdentity = 0;
  const historyMissingByIdentityUids = [];
  let historyMetricMismatches = 0;
  const historyMetricMismatchSamples = [];
  let historyTimestampMismatches = 0;
  const historyTimestampMismatchSamples = [];

  for (const snap of db.prepare('SELECT * FROM snapshots').iterate()) {
    const expectedObservationId = `legacy:${snap.id}`;
    const byId = observationIndex.get(snap.item_uid);
    const obs = byId ? byId.get(expectedObservationId) : null;
    if (!obs) {
      historyMissingByIdentity += 1;
      if (historyMissingByIdentityUids.length < 20) historyMissingByIdentityUids.push(snap.item_uid);
      continue;
    }
    for (const { legacy, obs: obsField } of HISTORY_OBSERVATION_METRIC_FIELDS) {
      const legacyValue = snap[legacy];
      const obsValue = obs[obsField];
      if (legacyValue == null && obsValue == null) continue; // both unpopulated — equal
      if (legacyValue == null || obsValue == null || Number(legacyValue) !== Number(obsValue)) {
        historyMetricMismatches += 1;
        if (historyMetricMismatchSamples.length < 20) {
          historyMetricMismatchSamples.push({ itemUid: snap.item_uid, observationId: expectedObservationId, field: legacy, legacyValue, obsValue });
        }
      }
    }

    // Gap #5 / Patch 2B: Timestamp Parity — compare legacy snapshot timestamp
    // with the exact V2 observation timestamp (normalized to canonical UTC representation).
    if (snap.created_at && obs.time) {
      const snapIso = normalizeLegacyUtcTimestamp(snap.created_at);
      if (snapIso) {
        const snapDate = snapIso.slice(0, 10);
        const snapTime = snapIso.slice(11, 19);
        const obsDate = obsRowDateMap.get(expectedObservationId);
        const obsTime = obs.time;
        if (obsDate && (snapDate !== obsDate || snapTime !== obsTime)) {
          historyTimestampMismatches += 1;
          if (historyTimestampMismatchSamples.length < 20) {
            historyTimestampMismatchSamples.push({
              itemUid: snap.item_uid,
              observationId: expectedObservationId,
              legacyTimestamp: snap.created_at,
              v2Date: obsDate,
              v2Time: obsTime
            });
          }
        }
      }
    }
  }

  // Gap #3 closure: a packed observation claiming a `legacy:<id>` identity
  // that no real legacy snapshot row backs is an extra/orphaned observation
  // (e.g. a corrupted or duplicated migration write).
  const allLegacySnapshotIds = new Set(db.prepare('SELECT id FROM snapshots').all().map((r) => String(r.id)));
  let historyExtraObservations = 0;
  const historyExtraObservationUids = [];
  for (const [uid, byId] of observationIndex.entries()) {
    for (const obsId of byId.keys()) {
      if (typeof obsId === 'string' && obsId.startsWith('legacy:') && !allLegacySnapshotIds.has(obsId.slice('legacy:'.length))) {
        historyExtraObservations += 1;
        if (historyExtraObservationUids.length < 20) historyExtraObservationUids.push(uid);
      }
    }
  }

  const legacyObservations = Array.from(legacyObsCountByUid.values()).reduce((a, b) => a + b, 0);
  const packedObservations = Array.from(packedObsCountByUid.values()).reduce((a, b) => a + b, 0);

  // §5/Gap #5: every history failure mode gates parityOk — duplicates/malformed
  // observations, metric mismatches, and timestamp mismatches all gate parityOk.
  const parityOk = missingCurrent.length === 0
    && metricMismatches.length === 0
    && missingHistoricalObservations === 0
    && duplicateHistoricalObservations === 0
    && malformedObservations === 0
    && historyMissingByIdentity === 0
    && historyExtraObservations === 0
    && historyMetricMismatches === 0
    && historyTimestampMismatches === 0;

  return {
    parityOk,
    current: {
      checked,
      totalSnapshotItemUids: snapshotUids.length,
      productCurrentItemUidCount: productCurrentUids.size,
      missingCurrentCount: missingCurrent.length,
      missingCurrent: missingCurrent.slice(0, 20), // capped sample, not a full dump
      metricMismatchCount: metricMismatches.length,
      metricMismatches: metricMismatches.slice(0, 20)
    },
    history: {
      legacyObservations,
      packedObservations,
      missingHistoricalObservations,
      missingHistoricalObservationUids: missingHistoricalObservationUids.slice(0, 20),
      duplicateHistoricalObservations,
      duplicateHistoricalObservationUids: duplicateHistoricalObservationUids.slice(0, 20),
      malformedObservations,
      malformedObservationUids: malformedObservationUids.slice(0, 20),
      // Gap #3/#5 closure: exact per-observation identity + per-metric and timestamp comparison.
      historyMissingByIdentity,
      historyMissingByIdentityUids: historyMissingByIdentityUids.slice(0, 20),
      historyExtraObservations,
      historyExtraObservationUids: historyExtraObservationUids.slice(0, 20),
      historyMetricMismatches,
      historyMetricMismatchSamples: historyMetricMismatchSamples.slice(0, 20),
      historyTimestampMismatches,
      historyTimestampMismatchSamples: historyTimestampMismatchSamples.slice(0, 20)
    },
    checkedAt: new Date().toISOString()
  };
}

/**
 * DB Health Monitor (Simplification Round #16) — replaces the mandatory 10M
 * synthetic benchmark as a release gate. Reports the metrics that actually
 * matter for "is row growth under control", not a one-off performance claim.
 */
function getDatabaseHealth() {
  const fs = require('fs');
  const dbSizeBytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;

  const productCurrentRows = db.prepare('SELECT COUNT(*) c FROM product_current').get().c;
  const dailyHistoryStats = db.prepare('SELECT COUNT(*) c, AVG(observation_count) avgObs, MAX(observation_count) maxObs, SUM(observation_count) totalObs FROM daily_packed_history').get();
  const legacySnapshotRows = db.prepare('SELECT COUNT(*) c FROM snapshots').get().c;
  const weeklySummaryRows = db.prepare('SELECT COUNT(*) c FROM weekly_summary').get().c;
  // §15: pending V2 repair count — dual-write failures recorded by
  // recordV2WriteFailure() that repairPendingV2WriteFailures() hasn't
  // resolved yet. A non-zero count here means product_current/daily_packed_history
  // is currently missing data that legacy `snapshots` has, independent of the
  // full checkV2Parity() scan.
  const pendingV2RepairCount = db.prepare("SELECT COUNT(*) c FROM v2_write_failures WHERE status = 'pending'").get().c;

  const t0 = process.hrtime.bigint();
  db.prepare('SELECT * FROM product_current ORDER BY rank_score DESC LIMIT 1').get();
  const representativeQueryLatencyMs = Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(3));

  return {
    dbSizeMB: Number((dbSizeBytes / (1024 * 1024)).toFixed(2)),
    productCurrentRowCount: productCurrentRows,
    dailyPackedHistoryRowCount: dailyHistoryStats.c,
    packedObservationCount: dailyHistoryStats.totalObs || 0,
    avgObservationsPerDailyRow: Number((dailyHistoryStats.avgObs || 0).toFixed(2)),
    maxObservationsInDailyRow: dailyHistoryStats.maxObs || 0,
    legacySnapshotRowCount: legacySnapshotRows,
    weeklySummaryRowCount: weeklySummaryRows, // deprecated table, reported for visibility only
    pendingV2RepairCount,
    representativeIndexedQueryLatencyMs: representativeQueryLatencyMs,
    checkedAt: new Date().toISOString()
  };
}

// ==================== Social Bot Persistent Scheduling State (P0-7) ====================

const socialBotStmt = {
  reserveWindow: db.prepare(`
    INSERT INTO social_bot_state (bot_key, scheduled_window, query_key, status)
    VALUES (@botKey, @scheduledWindow, @queryKey, 'pending')
  `),
  markDispatched: db.prepare(`UPDATE social_bot_state SET status='dispatched', run_id=@runId, updated_at=CURRENT_TIMESTAMP WHERE id=@id`),
  markFailed: db.prepare(`UPDATE social_bot_state SET status='failed', error_message=@errorMessage, updated_at=CURRENT_TIMESTAMP WHERE id=@id`),
  deleteById: db.prepare('DELETE FROM social_bot_state WHERE id = ?'),
  findLastDispatched: db.prepare(`
    SELECT * FROM social_bot_state WHERE bot_key = ? AND status = 'dispatched' ORDER BY scheduled_window DESC LIMIT 1
  `),
  countDispatched: db.prepare(`SELECT COUNT(*) c FROM social_bot_state WHERE bot_key = ? AND status = 'dispatched'`)
};

/**
 * Atomically reserves a (bot_key, scheduled_window, query_key) slot. Returns the
 * new row id, or null if this window/query was already reserved/dispatched by a
 * prior tick (before or after a restart — this table is the persistent source of
 * truth, unlike the old in-memory Map/Set). The UNIQUE constraint is what makes
 * this safe under concurrent ticks.
 */
function reserveSocialBotWindow(botKey, scheduledWindow, queryKey) {
  try {
    const info = socialBotStmt.reserveWindow.run({ botKey, scheduledWindow, queryKey });
    return info.lastInsertRowid;
  } catch (err) {
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) return null; // Already reserved.
    throw err;
  }
}

function markSocialBotDispatched(id, runId) { socialBotStmt.markDispatched.run({ id, runId }); }
function markSocialBotFailed(id, errorMessage) { socialBotStmt.markFailed.run({ id, errorMessage: String(errorMessage || '') }); }
function releaseSocialBotWindow(id) { socialBotStmt.deleteById.run(id); }

/**
 * Crash-safety sweep (Simplification Round #20): if the process crashed after
 * reserveSocialBotWindow() inserted a 'pending' row but before markSocialBot
 * Dispatched()/releaseSocialBotWindow() ran, that row would otherwise block
 * the UNIQUE(bot_key, scheduled_window, query_key) constraint forever — the
 * window could never be retried. Any 'pending' row older than thresholdMs is
 * assumed abandoned and deleted so the next tick can legitimately re-reserve
 * and re-enqueue it exactly once.
 */
function recoverStalePendingSocialBotWindows(thresholdMs = 5 * 60 * 1000) {
  // SQLite's CURRENT_TIMESTAMP formats as 'YYYY-MM-DD HH:MM:SS' (UTC, no 'T'/'Z'/ms);
  // the cutoff must match exactly or the string comparison sorts incorrectly.
  const cutoff = new Date(Date.now() - thresholdMs).toISOString().replace('T', ' ').slice(0, 19);
  const info = db.prepare("DELETE FROM social_bot_state WHERE status = 'pending' AND created_at < ?").run(cutoff);
  if (info.changes > 0) {
    console.warn(`[SocialBotRecovery] Cleared ${info.changes} stale pending window(s) older than ${thresholdMs}ms so they can be retried.`);
  }
  return { cleared: info.changes };
}
function getLastDispatchedSocialBotWindow(botKey) { return socialBotStmt.findLastDispatched.get(botKey); }
function countDispatchedSocialBotRuns(botKey) { return socialBotStmt.countDispatched.get(botKey).c; }

module.exports = {
  getAllPlatforms, createRun, getRunById, getQueuedRuns, getAllRuns, getRunsByStatus, getChildRuns, updateRun, deleteRun,
  deleteItem, deleteAllItems,
  reserveSocialBotWindow, markSocialBotDispatched, markSocialBotFailed, releaseSocialBotWindow,
  getLastDispatchedSocialBotWindow, countDispatchedSocialBotRuns, recoverStalePendingSocialBotWindows,
  insertSnapshots, getLatestSnapshots, getLatestSnapshotByUid, getSnapshotHistory, getSnapshotsByRunId, getRunItems, backfillRunResultItems,
  getProductCurrent, getProductCurrentByUid, getProductHistory, getProductHistoryWithMetadata, getProductWeekly, backfillSnapshotsToV2, getDatabaseHealth, formatVietnamTime,
  getPendingV2WriteFailures, repairPendingV2WriteFailures, checkV2Parity, normalizeLegacyUtcTimestamp,
  getSnapshotsMissingEtsyImages, updateSnapshotImage,
  getStats, getRunStats,
  createMarketplaceAccount, getMarketplaceAccounts, getMarketplaceStorageState, deleteMarketplaceAccount,
  createMarketplaceProxy, getMarketplaceProxies, getMarketplaceProxyUrl, assignMarketplaceAccountProxy, deleteMarketplaceProxy,
  createMarketplaceCapture, getCachedMarketplaceCapture, getMarketplaceCapture, getMarketplaceCaptures,
  createMarketplaceCaptureSchedule, getMarketplaceCaptureSchedules, getDueMarketplaceCaptureSchedules, completeMarketplaceCaptureSchedule, getMarketplaceCaptureScheduleRuns, deleteMarketplaceCaptureSchedule, toggleMarketplaceCaptureSchedule,
  claimMarketplaceCaptureSchedule, releaseMarketplaceCaptureScheduleClaim, renewMarketplaceCaptureScheduleClaim,
};
