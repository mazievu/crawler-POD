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

const DB_PATH = path.join(__dirname, '..', 'data', 'collector.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
  findAllRuns: db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?'),
  updateRun: db.prepare(`
    UPDATE runs SET status=@status, apify_run_id=@apifyRunId, apify_dataset_id=@apifyDatasetId,
      items_count=@itemsCount, new_count=@newCount, active_count=@activeCount,
      dropped_count=@droppedCount, error_message=@errorMessage,
      active_backend=@activeBackend, backend_kind=@backendKind, backend_status=@backendStatus,
      backend_version=@backendVersion, backend_run_id=@backendRunId, health_snapshot=@healthSnapshot,
      cost_estimate=@costEstimate, completed_at=CURRENT_TIMESTAMP
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
    FROM marketplace_capture_schedules WHERE enabled = 1 AND next_run_at <= @now ORDER BY next_run_at ASC LIMIT 5
  `),
  completeMarketplaceCaptureSchedule: db.prepare(`
    UPDATE marketplace_capture_schedules SET last_run_at = @now, next_run_at = @nextRunAt, last_summary = @summary WHERE id = @id
  `),
  completeOneTimeMarketplaceCaptureSchedule: db.prepare(`
    UPDATE marketplace_capture_schedules SET enabled = 0, last_run_at = @now, last_summary = @summary WHERE id = @id
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

function createRun({ platform, query, maxItems = 100, country = null, requestedBackend = null, options = {} }) {
  const r = stmt.createRun.run({ platform, query, maxItems, country, requestedBackend, inputOptions: JSON.stringify(options || {}) });
  return stmt.findRunById.get(r.lastInsertRowid);
}

function getRunById(id) { return stmt.findRunById.get(id); }
function getAllRuns(limit = 100) { return stmt.findAllRuns.all(limit); }
function deleteRun(id) { stmt.deleteRun.run(id); }

function updateRun(id, updates) {
  const run = stmt.findRunById.get(id);
  if (!run) return;
  stmt.updateRun.run({
    id,
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

  const insertMany = db.transaction((txItems) => {
    for (const item of txItems) {
      const parsed = parseItemData(item);
      const itemUid = generateUid(platform, query, parsed);
      currentUids.add(itemUid);

      // Find previous snapshot for this item
      let prevSnapshot = null;
      if (prevRunId > 0) {
        prevSnapshot = stmt.findPreviousSnapshot.get(platform, query, itemUid, runId + 1);
      }

      let status = 'new';
      let prevSnapshotId = null;

      if (prevSnapshot) {
        status = 'active';
        activeCount++;
        prevSnapshotId = prevSnapshot.id;
      } else {
        newCount++;
      }

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

    // Find dropped items (in previous run but not in current)
    if (prevRunId > 0) {
      const prevSnapshots = stmt.findSnapshotsByRunId.all(prevRunId);
      for (const prev of prevSnapshots) {
        if (!currentUids.has(prev.item_uid)) {
          droppedCount++;
          // Insert a "dropped" snapshot
          stmt.insertSnapshot.run({
            runId,
            platform,
            query,
            itemUid: prev.item_uid,
            rawData: prev.raw_data,
            title: prev.title,
            url: prev.url,
            image: prev.image,
            author: prev.author,
            price: prev.price,
            rating: prev.rating,
            reviews: prev.reviews,
            soldCount: prev.sold_count,
            likes: prev.likes,
            comments: prev.comments,
            shares: prev.shares,
            views: prev.views,
            status: 'dropped',
            prevSnapshotId: prev.id,
          });
        }
      }
    }
  });

  insertMany(items);

  // Update run counts
  updateRun(runId, {
    itemsCount: items.length,
    newCount,
    activeCount,
    droppedCount,
  });

  return { newItems: newCount, activeItems: activeCount, droppedItems: droppedCount };
}

function getLatestSnapshots({ search = '', platform = '', limit = 1000 } = {}) {
  const terms = String(search).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const filters = [];
  const params = { limit: Math.min(5000, Math.max(1, Number.parseInt(limit, 10) || 1000)) };

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
  const totalSnapshots = stmt.countSnapshots.get().total;
  return { totalRuns, totalSnapshots };
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

function completeMarketplaceCaptureSchedule(id, summary, now = new Date()) {
  const schedule = getMarketplaceCaptureSchedules().find((candidate) => candidate.id === Number(id));
  if (!schedule) return false;
  const summaryJson = JSON.stringify(summary);
  return db.transaction(() => {
    stmt.createMarketplaceCaptureScheduleRun.run({ scheduleId: Number(id), summary: summaryJson, completedAt: now.toISOString() });
    if (schedule.schedule_type === 'once') {
      return stmt.completeOneTimeMarketplaceCaptureSchedule.run({ id: Number(id), now: now.toISOString(), summary: summaryJson }).changes > 0;
    }
    const { nextScheduleRunAt } = require('./marketplaces/capture-scheduler');
    return stmt.completeMarketplaceCaptureSchedule.run({ id: Number(id), now: now.toISOString(), nextRunAt: nextScheduleRunAt(schedule, now).toISOString(), summary: summaryJson }).changes > 0;
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

// ==================== Helpers ====================

function parseItemData(item) {
  let d;
  try { d = typeof item === 'string' ? JSON.parse(item) : item; } catch { d = {}; }

  const title = d.title || d.adTitle || d.productTitle || d.name || d.text || '';
  const image = extractImage(d);
  const url = d.url || d.permalink || d.adUrl || d.link || d.productUrl || '';
  const author = typeof (d.author || d.advertiserName || d.username || '') === 'object'
    ? (d.author?.name || d.author?.username || '')
    : (d.author || d.advertiserName || d.username || '');

  const price = parseDecimal(d.price || d.adSpend || d.product_price || d.currentPrice || 0);
  const rating = parseDecimal(d.rating || d.averageRating || d.average_rating || d.stars || d.productRating || 0);
  const reviews = parseNum(d.reviewCount || d.review_count || d.reviews || d.ratingsCount || d.ratingCount || 0);
  const soldCount = parseNum(d.soldCount || d.sold_count || d.sales || d.orders || d.orderCount || 0);
  const likes = parseNum(d.likes || d.likeCount || d.like_count || d.upvotes || d.score || d.favouritesCount || d.reactions_count || 0);
  const comments = parseNum(d.comments || d.commentCount || d.replyCount || d.num_comments || d.numComments || d.comments_count || 0);
  const shares = parseNum(d.shares || d.shareCount || d.retweetCount || d.reposts || d.reshare_count || 0);
  const views = parseNum(d.views || d.viewCount || d.view_count || d.video_view_count || d.impressions || 0);

  return { title: String(title).substring(0, 200), image, url, author: String(author).substring(0, 100),
    price, rating, reviews, soldCount, likes, comments, shares, views };
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

module.exports = {
  getAllPlatforms, createRun, getRunById, getAllRuns, updateRun, deleteRun,
  insertSnapshots, getLatestSnapshots, getSnapshotHistory, getSnapshotsByRunId,
  getSnapshotsMissingEtsyImages, updateSnapshotImage,
  getStats, getRunStats,
  createMarketplaceAccount, getMarketplaceAccounts, getMarketplaceStorageState, deleteMarketplaceAccount,
  createMarketplaceProxy, getMarketplaceProxies, getMarketplaceProxyUrl, assignMarketplaceAccountProxy, deleteMarketplaceProxy,
  createMarketplaceCapture, getCachedMarketplaceCapture, getMarketplaceCapture, getMarketplaceCaptures,
  createMarketplaceCaptureSchedule, getMarketplaceCaptureSchedules, getDueMarketplaceCaptureSchedules, completeMarketplaceCaptureSchedule, getMarketplaceCaptureScheduleRuns, deleteMarketplaceCaptureSchedule,
};
