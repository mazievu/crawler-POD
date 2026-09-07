/**
 * Database Module â€” Snapshot-based tracking
 * Each collection run creates snapshots. Comparing snapshots shows:
 * - New items (appeared since last run)
 * - Active items (still running)
 * - Dropped items (stopped since last run)
 * - Growth (likes/comments/shares change)
 */

const { openDatabase } = require('./database/pg-client');
const path = require('path');
const fs = require('fs');
const { PLATFORMS } = require('./platform-config');
const { cleanImageUrl, extractImage, sanitizeForStorage } = require('./image-utils');
// schema-v2's initSchemaV2/migrate* helpers were SQLite in-place upgrade paths
// (PRAGMA probe + ALTER TABLE). pg-schema.sql declares those columns up front,
// so they are no longer imported here.
const { createProductCurrentOps } = require('./database/product-current');
const { createDailyHistoryOps, normalizeLegacyUtcTimestamp } = require('./database/daily-history');
const { createWeeklySummaryOps } = require('./database/weekly-summary');

// Â§14/Â§16 DB Cutover flags â€” controlled via .env, default keeps legacy behavior.
const LEGACY_SNAPSHOT_WRITE = (process.env.LEGACY_SNAPSHOT_WRITE || 'true').toLowerCase() !== 'false';
const READ_MODEL_V2 = (process.env.READ_MODEL_V2 || 'false').toLowerCase() === 'true';

// PostgreSQL connection. Opening the pool is synchronous; the schema is created
// by initDatabase(), which entry points once before any query runs.
// There is deliberately NO SQLite fallback â€” if Postgres is unreachable the
// error must surface, never silently route writes back into the archived
// collector.db.
const db = openDatabase();

// The ops factories only build statement handles (pg-client's prepare() is
// synchronous, exactly like better-sqlite3's), so they are still constructed at
// module load and the statement tables below keep working unchanged.
const dailyHistoryOps = createDailyHistoryOps(db);
const productCurrentOps = createProductCurrentOps(db, dailyHistoryOps);
const weeklySummaryOps = createWeeklySummaryOps(db);

const PG_SCHEMA_PATH = path.join(__dirname, 'database', 'pg-schema.sql');

const insertPlatform = db.prepare(`
  INSERT OR IGNORE INTO platforms (name, display_name, description, query_type, actor_id, country_support, icon, color)
  VALUES (@name, @displayName, @description, @queryType, @actorId, @countrySupport, @icon, @color)
`);

let initPromise = null;

/**
 * Creates the schema and seeds the platform table.
 *
 * Under better-sqlite3 all of this ran as a side effect of require(), because
 * every call was synchronous. Postgres queries are async, so initialisation
 * becomes an explicit step callers once at startup. The promise is
 * memoised, so concurrent callers share a single initialisation.
 *
 * The long chain of `PRAGMA table_info` probes and conditional `ALTER TABLE`s
 * that used to live here existed only to upgrade *older SQLite files* in place.
 * A Postgres database is created from pg-schema.sql, which already declares
 * every one of those columns, so those probes have no work left to do.
 */
async function initDatabase() {
  if (!initPromise) {
    initPromise = (async () => {
      await db.exec(fs.readFileSync(PG_SCHEMA_PATH, 'utf8'));
      const seed = db.transaction(async () => {
        for (const p of PLATFORMS) await insertPlatform.run(p);
      });
      await seed();
      // Historic-data backfills; previously require()-time side effects.
      await backfillSnapshotImages();
      await backfillSnapshotProductMetrics();
    })();
  }
  return initPromise;
}

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
  // Final Implementation Closure Â§2: completed_at must only be stamped on a
  // terminal transition, never on a routine heartbeat/progress update â€” those
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
  // Â§12: marks a V2 product_current row dropped â€” used by insertSnapshots()
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
    FROM marketplace_captures WHERE (@platform::text IS NULL OR platform = @platform)
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
      AND ((account_id IS NULL AND @accountId::int IS NULL) OR account_id = @accountId)
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
  // â€” only extends a claim that is CURRENTLY still held (claimed_until in the
  // future), never one that has already expired (a second tick may have
  // claimed it in the meantime; renewal must not steal it back).
  // Â§6: claim_token must match â€” a second process that claimed between
  // renewals gets a different token and this renewal correctly no-ops.
  renewMarketplaceCaptureScheduleClaim: db.prepare(`
    UPDATE marketplace_capture_schedules SET claimed_until = @claimedUntil
    WHERE id = @id AND claimed_until IS NOT NULL AND claimed_until >= @now AND claim_token = @claimToken
  `),
  releaseMarketplaceCaptureScheduleClaim: db.prepare(`
    UPDATE marketplace_capture_schedules SET claimed_until = NULL, claim_token = NULL
    WHERE id = @id AND (claim_token IS NULL OR claim_token = @claimToken)
  `),
  // Â§3 (Final Blocker Fix Round): completion is claim_token-protected exactly
  // like renew/release â€” a stale attempt whose claim was already lost cannot
  // mark the schedule complete, clear a newer claim, or advance next_run_at.
  // `IS` (not `=`) is required for NULL-safe comparison: a never-claimed
  // schedule has claim_token IS NULL, and completing it with no claimToken
  // supplied (claimToken=NULL) must still match â€” `NULL = NULL` is NULL
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
async function backfillSnapshotImages() {
  const rows = await stmt.findSnapshotsMissingImage.all();
  const update = db.transaction(async (snapshots) => {
    for (const snapshot of snapshots) {
      try {
        const image = extractImage(JSON.parse(snapshot.raw_data));
        if (image) await stmt.updateSnapshotImage.run(image, snapshot.id);
      } catch {
        // Keep malformed historic payloads untouched.
      }
    }
  });
  await update(rows);
}

// Invoked from initDatabase() â€” these used to run as a require()-time side
// effect when every SQLite call was synchronous.

async function backfillSnapshotProductMetrics() {
  const rows = await db.prepare('SELECT id, raw_data, price, rating, reviews, sold_count FROM snapshots').all();
  const update = db.transaction(async (snapshots) => {
    for (const snapshot of snapshots) {
      try {
        const parsed = parseItemData(JSON.parse(snapshot.raw_data));
        const price = snapshot.price || parsed.price;
        const rating = snapshot.rating || parsed.rating;
        const reviews = snapshot.reviews || parsed.reviews;
        const soldCount = snapshot.sold_count || parsed.soldCount;
        if (price !== snapshot.price || rating !== snapshot.rating || reviews !== snapshot.reviews || soldCount !== snapshot.sold_count) {
          await stmt.updateSnapshotProductMetrics.run(price, rating, reviews, soldCount, snapshot.id);
        }
      } catch {
        // Keep malformed historic payloads untouched.
      }
    }
  });
  await update(rows);
}

// Invoked from initDatabase() (see above).

// ==================== CRUD Operations ====================

async function getAllPlatforms() { return await stmt.findAllPlatforms.all(); }

async function createRun({ platform, query, maxItems = 100, country = null, requestedBackend = null, options = {}, parentRunId = null }) {
  const r = await stmt.createRun.run({ platform, query, maxItems, country, requestedBackend, inputOptions: JSON.stringify(options || {}) });
  if (parentRunId) {
    await db.prepare('UPDATE runs SET parent_run_id = ? WHERE id = ?').run(parentRunId, r.lastInsertRowid);
  }
  return await stmt.findRunById.get(r.lastInsertRowid);
}

async function getChildRuns(parentRunId) {
  return await db.prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY id ASC').all(parentRunId);
}

async function getRunById(id) { return await stmt.findRunById.get(id); }
async function getQueuedRuns(limit = 10) { return await stmt.findQueuedRuns.all(limit); }
async function getAllRuns(limit = 100) { return await stmt.findAllRuns.all(limit); }
async function getRunsByStatus(status) { return await stmt.findRunsByStatus.all(status); }
async function deleteRun(id) { await stmt.deleteRun.run(id); }

async function deleteItem(itemUid) {
  if (!itemUid) return { changes: 0 };
  const tx = db.transaction(async (uid) => {
    const snapResult = await db.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(uid);
    try { await db.prepare('DELETE FROM product_current WHERE item_uid = ?').run(uid); } catch (_) {}
    try { await db.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(uid); } catch (_) {}
    try { await db.prepare('DELETE FROM weekly_product_summary WHERE item_uid = ?').run(uid); } catch (_) {}
    return { changes: snapResult.changes };
  });
  return await tx(itemUid);
}

async function deleteAllItems({ platform = null, query = null } = {}) {
  const tx = db.transaction(async () => {
    let snapResult;
    if (platform && query) {
      snapResult = await db.prepare('DELETE FROM snapshots WHERE platform = ? AND query = ?').run(platform, query);
      try { await db.prepare('DELETE FROM product_current WHERE platform = ? AND query = ?').run(platform, query); } catch (_) {}
      try { await db.prepare('DELETE FROM daily_packed_history WHERE platform = ? AND query = ?').run(platform, query); } catch (_) {}
    } else if (platform) {
      snapResult = await db.prepare('DELETE FROM snapshots WHERE platform = ?').run(platform);
      try { await db.prepare('DELETE FROM product_current WHERE platform = ?').run(platform); } catch (_) {}
      try { await db.prepare('DELETE FROM daily_packed_history WHERE platform = ?').run(platform); } catch (_) {}
    } else {
      snapResult = await db.prepare('DELETE FROM snapshots').run();
      try { await db.prepare('DELETE FROM product_current').run(); } catch (_) {}
      try { await db.prepare('DELETE FROM daily_packed_history').run(); } catch (_) {}
    }
    return { changes: snapResult.changes };
  });
  return await tx();
}

const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'stuck', 'cancelled', 'timeout']);

/**
 * Column names updateRun() accepts, in both camelCase and snake_case (callers
 * use both spellings).
 */
const RUN_UPDATE_COLUMNS = {
  status: 'status',
  apifyRunId: 'apify_run_id', apify_run_id: 'apify_run_id',
  apifyDatasetId: 'apify_dataset_id', apify_dataset_id: 'apify_dataset_id',
  itemsCount: 'items_count', items_count: 'items_count',
  newCount: 'new_count', new_count: 'new_count',
  activeCount: 'active_count', active_count: 'active_count',
  droppedCount: 'dropped_count', dropped_count: 'dropped_count',
  errorMessage: 'error_message', error_message: 'error_message',
  activeBackend: 'active_backend', active_backend: 'active_backend',
  backendKind: 'backend_kind', backend_kind: 'backend_kind',
  backendStatus: 'backend_status', backend_status: 'backend_status',
  backendVersion: 'backend_version', backend_version: 'backend_version',
  backendRunId: 'backend_run_id', backend_run_id: 'backend_run_id',
  healthSnapshot: 'health_snapshot', health_snapshot: 'health_snapshot',
  costEstimate: 'cost_estimate', cost_estimate: 'cost_estimate',
  inputOptions: 'input_options', input_options: 'input_options',
};

/**
 * Writes ONLY the fields the caller supplied.
 *
 * This used to read the whole row, merge `updates` over it, and write every
 * column back. That was safe while better-sqlite3 made read-then-write a single
 * uninterrupted step. Once the PostgreSQL cutover made both halves async, two
 * concurrent callers could interleave:
 *
 *   heartbeat  : read row (status='running')
 *   executeRun : read row (status='running')
 *   executeRun : write status='done'   + completed_at
 *   heartbeat  : write status='running'   <- from its own stale snapshot
 *
 * which left a finished run stuck at 'running' with completed_at already
 * stamped (seen on run #1: 20/20 items saved, heartbeat stage COMPLETED,
 * status still 'running'). completed_at survived only because its CASE keeps
 * the existing value on a non-terminal write.
 *
 * Touching just the supplied columns removes the lost update: a heartbeat
 * writing health_snapshot can no longer move `status` at all.
 */
async function updateRun(id, updates) {
  const run = await stmt.findRunById.get(id);
  if (!run) return;

  const assignments = [];
  const params = { id };
  const seen = new Set();

  for (const [key, value] of Object.entries(updates)) {
    const column = RUN_UPDATE_COLUMNS[key];
    // `undefined` meant "not supplied" to the old merge, which fell back to the
    // existing value — leaving the column alone is the same behaviour.
    if (!column || value === undefined || seen.has(column)) continue;
    seen.add(column);
    assignments.push(`${column}=@${key}`);
    params[key] = value;
  }

  // Gap #4 closure: `externalExecution: null` explicitly clears it; omitting it
  // entirely leaves the existing value untouched.
  if ('externalExecution' in updates) {
    assignments.push('external_execution_json=@externalExecutionJson');
    params.externalExecutionJson =
      updates.externalExecution == null ? null : JSON.stringify(updates.externalExecution);
  }

  // Only a terminal status stamps completed_at — a heartbeat/progress update
  // does not send `status` at all, so it must leave completed_at untouched.
  if (updates.status !== undefined) {
    params.isTerminal = TERMINAL_RUN_STATUSES.has(updates.status) ? 1 : 0;
    assignments.push('completed_at=CASE WHEN @isTerminal = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END');
  }

  if (assignments.length === 0) return;
  await db.prepare(`UPDATE runs SET ${assignments.join(', ')} WHERE id=@id`).run(params);
}

/**
 * Insert items from a collection run, comparing with previous run.
 * Returns { newItems, activeItems, droppedItems, snapshots }
 */
async function insertSnapshots(runId, platform, query, items) {
  const run = await stmt.findRunById.get(runId);
  if (!run) return { newItems: 0, activeItems: 0, droppedItems: 0 };

  // Get the most recent previous run for this platform+query
  const prevRun = await db.prepare(`
    SELECT id FROM runs WHERE platform=? AND query=? AND status='done' AND id < ?
    ORDER BY id DESC LIMIT 1
  `).get(platform, query, runId);

  const prevRunId = prevRun?.id || 0;

  let newCount = 0, activeCount = 0, droppedCount = 0;
  const currentUids = new Set();
  const resultItems = []; // Â§6.1: this Run's own packed result array

  const insertMany = db.transaction(async (txItems) => {
    for (const item of txItems) {
      const parsed = parseItemData(item);
      const itemUid = generateUid(platform, query, parsed);
      currentUids.add(itemUid);

      // Â§12: new/active must be derived from V2 (product_current), which is
      // authoritative regardless of LEGACY_SNAPSHOT_WRITE â€” the legacy
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
        v2Result = await productCurrentOps.upsertItem(v2Payload, runId);
        // Â§4: runId gives this observation a stable identity (run:<runId>:<itemUid>)
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
        // logging â€” recordV2WriteFailure() below.
        await recordV2WriteFailure(runId, itemUid, v2Err.message);
      }

      // Legacy status field kept for the optional legacy row below; falls
      // back to the pre-V2 legacy-snapshot lookup only in the degraded case
      // where the V2 write itself failed (v2Result is null).
      let prevSnapshotId = null;
      let status;
      if (v2Result) {
        status = v2Result.isNew ? 'new' : 'active';
      } else {
        const prevSnapshot = prevRunId > 0 ? await stmt.findPreviousSnapshot.get(platform, query, itemUid, runId + 1) : null;
        status = prevSnapshot ? 'active' : 'new';
        if (prevSnapshot) prevSnapshotId = prevSnapshot.id;
      }
      if (status === 'new') newCount++; else activeCount++;

      // Â§6.1: this Run's own packed result array â€” populated unconditionally
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

      // Â§14/Â§16: Gate legacy snapshot writes. When LEGACY_SNAPSHOT_WRITE=false,
      // the snapshots table stops growing (no new rows). V2 dual-write continues.
      if (LEGACY_SNAPSHOT_WRITE) {
        await stmt.insertSnapshot.run({
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

    // Â§12: dropped items â€” sourced from product_current (V2), never the
    // legacy snapshots table. An item counts as dropped for this run when it
    // was last touched by the immediately-preceding run for this
    // platform+query (product_current.last_run_id = prevRunId) but is absent
    // from this run's item set. This stays correct with LEGACY_SNAPSHOT_WRITE
    // off, across arbitrarily many subsequent runs, using only columns
    // product_current already has (no new metadata table).
    if (prevRunId > 0) {
      const staleCandidates = await db.prepare(
        "SELECT * FROM product_current WHERE platform = ? AND query = ? AND last_run_id = ? AND status != 'dropped'"
      ).all(platform, query, prevRunId);
      for (const cand of staleCandidates) {
        if (currentUids.has(cand.item_uid)) continue;
        droppedCount++;
        await stmt.markProductCurrentDropped.run(cand.item_uid);
        // Â§16: Only insert legacy dropped snapshots if flag is on. Sourced
        // from product_current's own fields, not a legacy-table read, so
        // this still works correctly even if legacy writes were already off
        // during the run that most recently touched this item.
        if (LEGACY_SNAPSHOT_WRITE) {
          await stmt.insertSnapshot.run({
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

  await insertMany(items);

  // Â§6.1: written unconditionally, independent of LEGACY_SNAPSHOT_WRITE.
  await db.prepare('UPDATE runs SET result_items_json = ? WHERE id = ?').run(JSON.stringify(resultItems), runId);

  // Update run counts
  await updateRun(runId, {
    itemsCount: items.length,
    newCount,
    activeCount,
    droppedCount,
  });

  return { newItems: newCount, activeItems: activeCount, droppedItems: droppedCount };
}

/**
 * Â§6.2: single helper for "what items did this Run produce" â€” used by both
 * /api/runs/:id and /api/export/:runId so neither route hand-rolls its own
 * legacy-vs-V2 branching. READ_MODEL_V2=false reads legacy `snapshots`
 * (unchanged behavior); READ_MODEL_V2=true reads runs.result_items_json,
 * which is populated on every insertSnapshots() call regardless of
 * LEGACY_SNAPSHOT_WRITE â€” so this never returns empty for a post-cutover Run.
 */
async function getRunItems(runId) {
  if (!READ_MODEL_V2) {
    return await getSnapshotsByRunId(runId);
  }
  const run = await stmt.findRunById.get(runId);
  if (!run || !run.result_items_json) return [];
  try {
    return JSON.parse(run.result_items_json);
  } catch (_e) {
    return [];
  }
}

/**
 * Â§6.3: idempotent backfill â€” only processes runs whose result_items_json is
 * still NULL, from their existing legacy `snapshots` rows. Running this
 * twice processes zero additional rows the second time. Never deletes or
 * modifies legacy data.
 */
async function backfillRunResultItems() {
  const targets = await db.prepare('SELECT id FROM runs WHERE result_items_json IS NULL').all();
  let migrated = 0;
  for (const { id } of targets) {
    const snapshots = await getSnapshotsByRunId(id);
    const resultItems = snapshots.map((s) => ({
      item_uid: s.item_uid, platform: s.platform, title: s.title, url: s.url, image: s.image, author: s.author,
      price: s.price, rating: s.rating, reviews: s.reviews, sold_count: s.sold_count, likes: s.likes,
      comments: s.comments, shares: s.shares, views: s.views, status: s.status, observed_at: s.created_at
    }));
    await db.prepare('UPDATE runs SET result_items_json = ? WHERE id = ?').run(JSON.stringify(resultItems), id);
    migrated++;
  }
  return { migrated, totalCandidates: targets.length };
}

async function getLatestSnapshots({ search = '', platform = '', limit = 200 } = {}) {
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
  return await db.prepare(`
    SELECT s.* FROM snapshots s
    INNER JOIN (SELECT platform, query, MAX(run_id) as max_run FROM snapshots GROUP BY platform, query) latest
    ON s.platform = latest.platform AND s.query = latest.query AND s.run_id = latest.max_run
    ${where}
    ORDER BY s.created_at DESC
    LIMIT @limit
  `).all(params);
}
async function getSnapshotHistory(itemUid) { return await stmt.getSnapshotHistory.all(itemUid); }
async function getLatestSnapshotByUid(itemUid) {
  return await db.prepare('SELECT * FROM snapshots WHERE item_uid = ? ORDER BY id DESC LIMIT 1').get(itemUid);
}
async function getSnapshotsByRunId(runId) { return await stmt.findSnapshotsByRunId.all(runId); }
/**
 * Cache-tier lookup for the marketplace scrapers' last-resort "reuse real past
 * data" step.
 *
 * The Etsy and eBay scrapers used to open ./data/collector.db directly with
 * their own read-only better-sqlite3 handle. After the Postgres cutover that
 * would have been an active runtime read of the archived SQLite file, so the
 * query lives here instead and runs against the same Postgres connection as
 * everything else. LIKE is rewritten to ILIKE by pg-client, preserving the
 * case-insensitive matching these scrapers relied on under SQLite.
 */
async function getSnapshotsMatchingQuery(platform, query, limit = 30) {
  const normalizedLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 30));
  const like = `%${String(query || '')}%`;
  return await db
    .prepare(
      `SELECT DISTINCT title, url, image, author, price, rating, reviews, sold_count
       FROM snapshots
       WHERE platform = ? AND (author LIKE ? OR query LIKE ? OR title LIKE ?)
       LIMIT ?`
    )
    .all(platform, like, like, like, normalizedLimit);
}

async function getSnapshotsMissingEtsyImages(limit = 50) {
  const normalizedLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 50));
  return await stmt.findSnapshotsMissingEtsyImage.all(normalizedLimit);
}
async function updateSnapshotImage(id, image) {
  const normalizedImage = cleanImageUrl(image);
  if (!normalizedImage) return false;
  return (await stmt.updateSnapshotImage.run(normalizedImage, id)).changes > 0;
}

async function getStats() {
  const totalRuns = (await stmt.countRuns.get()).total;
  let totalSnapshots = 0;
  const platformCounts = {};

  try {
    if (READ_MODEL_V2) {
      const totalRow = await db.prepare("SELECT COUNT(*) as total FROM product_current WHERE status != 'dropped'").get();
      totalSnapshots = totalRow?.total || 0;
      const rows = await db.prepare("SELECT platform, COUNT(*) as count FROM product_current WHERE status != 'dropped' GROUP BY platform").all();
      for (const r of rows) {
        platformCounts[r.platform] = r.count;
      }
    } else {
      totalSnapshots = (await stmt.countSnapshots.get()).total;
      const rows = await db.prepare("SELECT platform, COUNT(DISTINCT item_uid) as count FROM snapshots WHERE status != 'dropped' GROUP BY platform").all();
      for (const r of rows) {
        platformCounts[r.platform] = r.count;
      }
    }
  } catch (_e) {
    totalSnapshots = (await stmt.countSnapshots.get()).total;
  }

  return { totalRuns, totalSnapshots, platformCounts };
}

async function getRunStats() {
  return await stmt.getRunsByPlatform.all();
}

async function createMarketplaceAccount({ platform, label, storageState, proxyId = null }) {
  const { assertSupportedMarketplace } = require('./marketplaces/validation');
  const { encryptText } = require('./security/encrypted-store');
  const { normalizeBrowserStorageState } = require('./marketplaces/storage-state');
  assertSupportedMarketplace(platform);
  const cleanedLabel = String(label || '').trim();
  if (!cleanedLabel || cleanedLabel.length > 100) throw new Error('Account label must be between 1 and 100 characters');

  const state = normalizeBrowserStorageState(platform, storageState);
  const normalizedProxyId = await resolveMarketplaceProxyId(proxyId);

  const result = await stmt.createMarketplaceAccount.run({
    platform,
    label: cleanedLabel,
    sessionEncrypted: encryptText(JSON.stringify(state)),
    proxyId: normalizedProxyId,
  });
  return await stmt.findMarketplaceAccount.get(result.lastInsertRowid);
}

async function getMarketplaceAccounts(platform) {
  const { assertSupportedMarketplace } = require('./marketplaces/validation');
  assertSupportedMarketplace(platform);
  return await stmt.findMarketplaceAccounts.all(platform);
}

async function getMarketplaceStorageState(id) {
  const { decryptText } = require('./security/encrypted-store');
  const record = await stmt.findMarketplaceSession.get(id);
  if (!record) return null;
  return decryptText(record.session_encrypted);
}

async function deleteMarketplaceAccount(id) {
  return (await stmt.deleteMarketplaceAccount.run(id)).changes > 0;
}

async function createMarketplaceProxy(input) {
  const { validateSocks5Proxy } = require('./marketplaces/proxy');
  const { encryptText } = require('./security/encrypted-store');
  const proxy = validateSocks5Proxy(input);
  const result = await stmt.createMarketplaceProxy.run({
    label: proxy.label,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    configEncrypted: encryptText(JSON.stringify(proxy)),
  });
  return await stmt.findMarketplaceProxy.get(result.lastInsertRowid);
}

async function getMarketplaceProxies() {
  return await stmt.findMarketplaceProxies.all();
}

async function getMarketplaceProxyUrl(id) {
  if (!id) return null;
  const { decryptText } = require('./security/encrypted-store');
  const { buildSocks5ProxyUrl } = require('./marketplaces/proxy');
  const record = await stmt.findMarketplaceProxyConfig.get(Number(id));
  if (!record) return null;
  return buildSocks5ProxyUrl(JSON.parse(decryptText(record.config_encrypted)));
}

async function assignMarketplaceAccountProxy(accountId, proxyId = null) {
  const account = await stmt.findMarketplaceAccount.get(Number(accountId));
  if (!account) return null;
  const normalizedProxyId = await resolveMarketplaceProxyId(proxyId);
  await stmt.updateMarketplaceAccountProxy.run(normalizedProxyId, Number(accountId));
  return await stmt.findMarketplaceAccount.get(Number(accountId));
}

function deleteMarketplaceProxy(id) {
  const normalizedId = Number(id);
  if (!Number.isInteger(normalizedId) || normalizedId < 1) return false;
  return db.transaction(async () => {
    await stmt.clearMarketplaceProxyAssignments.run(normalizedId);
    return (await stmt.deleteMarketplaceProxy.run(normalizedId)).changes > 0;
  })();
}

async function resolveMarketplaceProxyId(proxyId) {
  if (proxyId == null || proxyId === '') return null;
  const normalizedId = Number(proxyId);
  if (!Number.isInteger(normalizedId) || normalizedId < 1) throw new Error('Proxy profile is invalid');
  if (!await stmt.findMarketplaceProxy.get(normalizedId)) throw new Error('Proxy profile was not found');
  return normalizedId;
}

function normalizeCaptureVariantOptions(variantMode, maxVariants) {
  const { normalizeVariantMode, normalizeMaxVariants } = require('./marketplaces/variant-pricing');
  const mode = normalizeVariantMode(variantMode);
  return { variantMode: mode, maxVariants: mode === 'all' ? normalizeMaxVariants(maxVariants) : 0 };
}

async function createMarketplaceCapture({ platform, accountId = null, url, html, parsedData, variantMode = 'base', maxVariants = 0 }) {
  const crypto = require('crypto');
  const { normalizeMarketplaceCaptureUrl } = require('./marketplaces/validation');
  const { encryptText } = require('./security/encrypted-store');
  const captureUrl = normalizeMarketplaceCaptureUrl(platform, url);
  const captureOptions = normalizeCaptureVariantOptions(variantMode, maxVariants);
  if (typeof html !== 'string' || !html.trim()) throw new Error('Captured HTML is required');

  const result = await stmt.createMarketplaceCapture.run({
    platform,
    accountId,
    url: captureUrl,
    htmlEncrypted: encryptText(html),
    htmlSha256: crypto.createHash('sha256').update(html).digest('hex'),
    parsedData: JSON.stringify(parsedData || {}),
    variantMode: captureOptions.variantMode,
    maxVariants: captureOptions.maxVariants,
  });
  return await getMarketplaceCaptureMetadata(result.lastInsertRowid);
}

async function getCachedMarketplaceCapture({ platform, accountId = null, url, variantMode = 'base', maxVariants = 0 }) {
  const { normalizeMarketplaceCaptureUrl } = require('./marketplaces/validation');
  const captureOptions = normalizeCaptureVariantOptions(variantMode, maxVariants);
  const captureUrl = normalizeMarketplaceCaptureUrl(platform, url);
  const captures = await stmt.findCachedMarketplaceCaptures.all({
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

async function getMarketplaceCaptureMetadata(id) {
  const capture = await stmt.findMarketplaceCapture.get(id);
  if (!capture) return null;
  const metadata = { ...capture };
  delete metadata.html_encrypted;
  const parsedData = JSON.parse(metadata.parsed_data);
  delete metadata.parsed_data;
  return { ...metadata, parsedData };
}

async function getMarketplaceCapture(id) {
  const { decryptText } = require('./security/encrypted-store');
  const capture = await stmt.findMarketplaceCapture.get(id);
  if (!capture) return null;
  const { html_encrypted, parsed_data, ...metadata } = capture;
  return { ...metadata, html: decryptText(html_encrypted), parsedData: JSON.parse(parsed_data) };
}

async function getMarketplaceCaptures({ platform = null, limit = 50 } = {}) {
  if (platform) require('./marketplaces/validation').assertSupportedMarketplace(platform);
  return (await stmt.findMarketplaceCaptures.all({ platform, limit: Math.min(Math.max(Number(limit) || 50, 1), 100) }))
    .map(({ parsed_data, ...capture }) => ({ ...capture, parsedData: JSON.parse(parsed_data) }));
}

async function createMarketplaceCaptureSchedule(input) {
  const { normalizeScheduleInput } = require('./marketplaces/capture-scheduler');
  const schedule = normalizeScheduleInput(input);
  if (schedule.accountId && !await stmt.findMarketplaceAccount.get(schedule.accountId)) throw new Error('Marketplace account not found');
  const { nextScheduleRunAt } = require('./marketplaces/capture-scheduler');
  const nextRunAt = nextScheduleRunAt({ schedule_type: schedule.scheduleType, daily_time: schedule.dailyTime, run_at: schedule.runAt, every_minutes: schedule.everyMinutes }).toISOString();
  if (schedule.scheduleType === 'once' && new Date(nextRunAt) <= new Date()) throw new Error('Choose a future date and time');
  const result = await stmt.createMarketplaceCaptureSchedule.run({ ...schedule, nextRunAt });
  return (await getMarketplaceCaptureSchedules()).find((candidate) => candidate.id === Number(result.lastInsertRowid));
}

async function getMarketplaceCaptureSchedules() {
  return (await stmt.findMarketplaceCaptureSchedules.all()).map((schedule) => ({ ...schedule, last_summary: schedule.last_summary ? JSON.parse(schedule.last_summary) : null }));
}

async function getDueMarketplaceCaptureSchedules(now = new Date()) {
  return await stmt.findDueMarketplaceCaptureSchedules.all({ now: now.toISOString() });
}

/**
 * Atomic claim (Live-Readiness Round #12): the UPDATE's WHERE clause re-checks
 * claimed_until at the moment of the write, so two ticks racing to claim the
 * same schedule cannot both succeed â€” only one UPDATE actually changes a row.
 * A crash mid-capture leaves claimed_until in the past once the lease expires,
 * so the schedule becomes claimable again automatically (no manual recovery needed).
 */
async function claimMarketplaceCaptureSchedule(id, leaseMs = 5 * 60 * 1000) {
  const crypto = require('crypto');
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + leaseMs).toISOString();
  const claimToken = crypto.randomBytes(12).toString('hex');
  const info = await stmt.claimMarketplaceCaptureSchedule.run({ id: Number(id), claimedUntil, claimToken, now: now.toISOString() });
  // Return the claim_token on success so callers can use it for renew/release.
  // Existing callers that check `=== true` will still be truthy with a string.
  return info.changes > 0 ? claimToken : false;
}

async function releaseMarketplaceCaptureScheduleClaim(id, claimToken = null) {
  await stmt.releaseMarketplaceCaptureScheduleClaim.run({ id: Number(id), claimToken });
}

/**
 * Final Stabilization Round #12: a fixed claim TTL is not sufficient for a
 * schedule whose real work (discovery + N sequential captures) can outlive
 * the original lease window. Extends claimed_until only while the caller
 * still holds an unexpired claim (see renewMarketplaceCaptureScheduleClaim
 * statement) â€” a process that already lost its lease cannot resurrect a claim
 * a second tick has since taken over.
 * Â§6: claim_token must match for renewal to succeed.
 */
async function renewMarketplaceCaptureScheduleClaim(id, leaseMs = 5 * 60 * 1000, claimToken = null) {
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + leaseMs).toISOString();
  const info = await stmt.renewMarketplaceCaptureScheduleClaim.run({ id: Number(id), claimedUntil, claimToken, now: now.toISOString() });
  return info.changes > 0;
}

// Â§3: claimToken is a 4th, optional param (kept after `now` for backward
// compatibility with existing callers that pass `now` positionally without a
// claim in play, e.g. test schedules that were never claimed).
async function completeMarketplaceCaptureSchedule(id, summary, now = new Date(), claimToken = null) {
  const schedule = (await getMarketplaceCaptureSchedules()).find((candidate) => candidate.id === Number(id));
  if (!schedule) return false;
  const summaryJson = JSON.stringify(summary);
  return db.transaction(async () => {
    // Â§3: the schedule-row UPDATE is claim_token-protected FIRST. If a stale
    // attempt's token no longer matches the current claim (or no claim
    // exists but one was expected), 0 rows change â€” do NOT insert a
    // completion history row or touch next_run_at for whoever actually owns
    // the schedule now.
    let changes;
    if (schedule.schedule_type === 'once') {
      changes = (await stmt.completeOneTimeMarketplaceCaptureSchedule.run({ id: Number(id), now: now.toISOString(), summary: summaryJson, claimToken })).changes;
    } else {
      const { nextScheduleRunAt } = require('./marketplaces/capture-scheduler');
      changes = (await stmt.completeMarketplaceCaptureSchedule.run({ id: Number(id), now: now.toISOString(), nextRunAt: nextScheduleRunAt(schedule, now).toISOString(), summary: summaryJson, claimToken })).changes;
    }
    if (changes === 0) return false; // MARKETPLACE_CLAIM_LOST
    await stmt.createMarketplaceCaptureScheduleRun.run({ scheduleId: Number(id), summary: summaryJson, completedAt: now.toISOString() });
    return true;
  })();
}

async function getMarketplaceCaptureScheduleRuns(scheduleId, limit = 20) {
  const normalizedId = Number(scheduleId);
  if (!Number.isInteger(normalizedId) || normalizedId < 1) return [];
  return (await stmt.findMarketplaceCaptureScheduleRuns.all({ scheduleId: normalizedId, limit: Math.min(Math.max(Number(limit) || 20, 1), 100) }))
    .map((run) => ({ ...run, summary: JSON.parse(run.summary) }));
}

async function deleteMarketplaceCaptureSchedule(id) {
  return (await stmt.deleteMarketplaceCaptureSchedule.run(Number(id))).changes > 0;
}

async function toggleMarketplaceCaptureSchedule(id) {
  const info = await stmt.toggleMarketplaceCaptureSchedule.run(Number(id));
  if (info.changes === 0) return null;
  return (await getMarketplaceCaptureSchedules()).find((c) => c.id === Number(id)) || null;
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
  // already carries the real total comment count â€” both reused as-is, only
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

async function getProductCurrent(options = {}) {
  return await productCurrentOps.listCurrent(options);
}

/**
 * Â§11 (Final Architecture Closure Round): single-row V2 lookup so callers
 * (export growth) can read this item's already-computed delta_* fields
 * instead of falling back to legacy getSnapshotHistory().
 */
async function getProductCurrentByUid(itemUid) {
  return await productCurrentOps.findByUid(itemUid);
}

async function getProductHistory(itemUid, limitDays = 30) {
  return await dailyHistoryOps.getHistory(itemUid, limitDays);
}

// UI-BUG-04: SQLite's default CURRENT_TIMESTAMP format is naive
// "YYYY-MM-DD HH:MM:SS" UTC, with no timezone marker â€” writing it straight
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
// fields (price/likes/comments/shares/views/sold/rating/reviews) â€” never the
// item's static metadata (title/platform/url/image/author/status), which
// lives in product_current instead. The Product Detail modal renders
// `history[history.length-1].title/platform/url`, so every point was
// rendering "Untitled", platform `undefined`, and no URL even though
// product_current itself has correct data. Look the item's metadata up once
// and denormalize it onto every point, matching what the legacy
// `snapshots`-backed history path already returns per-row.
async function getProductHistoryWithMetadata(itemUid, limitDays = 365) {
  const currentItem = await getProductCurrentByUid(itemUid);
  let richMeta = {};
  if (currentItem?.last_run_id) {
    try {
      const run = await stmt.findRunById.get(currentItem.last_run_id);
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

  const dailyRows = await getProductHistory(itemUid, limitDays);
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
async function getProductWeekly(itemUid, limitWeeks = 12) {
  return await weeklySummaryOps.getWeekly(itemUid, limitWeeks);
}

// Table created by pg-schema.sql via initDatabase(); the inline DDL that
// used to run at module load here is redundant under PostgreSQL.

/**
 * Durable repair task (Simplification Round #17) â€” a V2 (Current/History)
 * write failure is recorded here instead of only console.warn'd, so a
 * legacy-write-succeeded-but-V2-write-failed divergence is discoverable and
 * repairable, not silently lost. repairPendingV2WriteFailures() replays these
 * against the same snapshot data already safely stored in `snapshots`.
 */
async function recordV2WriteFailure(runId, itemUid, errorMessage) {
  console.warn('[DB V2 Dual-Write Error]:', errorMessage);
  await db.prepare('INSERT INTO v2_write_failures (run_id, item_uid, error_message) VALUES (?, ?, ?)').run(runId, itemUid, String(errorMessage || ''));
}

async function getPendingV2WriteFailures() {
  return await db.prepare("SELECT * FROM v2_write_failures WHERE status = 'pending' ORDER BY id ASC").all();
}

/** Re-attempts each pending V2 write failure from its original snapshot row. Marks repaired on success. */
async function repairPendingV2WriteFailures() {
  const pending = await getPendingV2WriteFailures();
  let repaired = 0;
  for (const failure of pending) {
    const snap = await db.prepare('SELECT * FROM snapshots WHERE run_id = ? AND item_uid = ? ORDER BY id DESC LIMIT 1').get(failure.run_id, failure.item_uid);
    if (!snap) continue;
    try {
      const v2Item = {
        item_uid: snap.item_uid, platform: snap.platform, query: snap.query, title: snap.title, url: snap.url,
        image: snap.image, author: snap.author, price: snap.price, rating: snap.rating, reviews: snap.reviews,
        sold_count: snap.sold_count, likes: snap.likes, comments: snap.comments, shares: snap.shares, views: snap.views
      };
      await productCurrentOps.upsertItem(v2Item, snap.run_id, snap.created_at);
      // Â§4.1: migrated observations use legacy:<snapshot_id> identity â€” a
      // re-run of this migration for the same legacy row replaces its own
      // prior entry instead of duplicating it (Â§4.2 idempotency).
      dailyHistoryOps.appendObservation(v2Item, snap.created_at, { legacySnapshotId: snap.id });
      await db.prepare("UPDATE v2_write_failures SET status = 'repaired' WHERE id = ?").run(failure.id);
      repaired++;
    } catch (_err) {
      // Still pending; will be retried on the next repair pass.
    }
  }
  return { attempted: pending.length, repaired };
}

// Table created by pg-schema.sql via initDatabase(); the inline DDL that
// used to run at module load here is redundant under PostgreSQL.

const BACKFILL_CHECKPOINT_KEY = 'backfill_v2_last_snapshot_id';

/**
 * Idempotent (Simplification Round #18): only processes snapshots newer than
 * the last recorded checkpoint. Running this twice in a row processes zero
 * new rows the second time â€” it cannot append duplicate observations to
 * daily_packed_history or re-count deltas in product_current.
 */
async function backfillSnapshotsToV2() {
  const checkpointRow = await db.prepare('SELECT value FROM migration_checkpoints WHERE key = ?').get(BACKFILL_CHECKPOINT_KEY);
  const lastId = checkpointRow ? Number(checkpointRow.value) : 0;
  const allSnapshots = await db.prepare('SELECT * FROM snapshots WHERE id > ? ORDER BY created_at ASC, id ASC').all(lastId);
  let migrated = 0;
  let maxId = lastId;

  const tx = db.transaction(async (rows) => {
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
      await productCurrentOps.upsertItem(v2Item, snap.run_id, normalizedTs);
      // Â§4.1: migrated observations use legacy:<snapshot_id> identity â€” a
      // re-run of this migration for the same legacy row replaces its own
      // prior entry instead of duplicating it (Â§4.2 idempotency).
      dailyHistoryOps.appendObservation(v2Item, normalizedTs, { legacySnapshotId: snap.id });
      // weekly_summary deprecated from backfill too â€” see note in insertSnapshots.
      maxId = Math.max(maxId, snap.id);
      migrated++;
    }
    await db.prepare('INSERT INTO migration_checkpoints (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP')
      .run(BACKFILL_CHECKPOINT_KEY, String(maxId));
  });

  await tx(allSnapshots);
  return { migrated, totalSnapshots: allSnapshots.length };
}

// Â§13: fields checked for semantic current-state parity â€” price/likes alone
// (the pre-Â§13 check) is not enough to gate a real cutover.
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
 * V2 Read/Write Parity Check (Live-Readiness Round #14, extended Â§13) â€”
 * this is the gate for safely flipping READ_MODEL_V2=true and disabling
 * LEGACY_SNAPSHOT_WRITE; it never modifies data. Two independent checks:
 *
 *  current: every item_uid in legacy `snapshots` must exist in
 *    `product_current` with agreeing price/views/likes/comments/shares/
 *    sold/rating/reviews/platform (a field null on either side is treated as
 *    "unknown", not a mismatch â€” a platform that never populated a metric on
 *    one side isn't a parity failure).
 *
 *  history: legacy stores one row per crawl per item_uid; V2 packs same-day
 *    observations into daily_packed_history's observation_count. The summed
 *    packed count per item_uid must not be LESS than the legacy count (V2
 *    capturing MORE granularity than legacy is fine, losing observations is
 *    not). Also scans for genuine duplicate observations (same item_uid+date
 *    +time recorded twice) within packed rows.
 */
async function checkV2Parity() {
  const snapshotUids = (await db.prepare('SELECT DISTINCT item_uid FROM snapshots').all()).map(r => r.item_uid);
  const productCurrentUids = new Set((await db.prepare('SELECT item_uid FROM product_current').all()).map(r => r.item_uid));

  const missingCurrent = [];
  const metricMismatches = [];
  const findLatestSnapshot = db.prepare('SELECT * FROM snapshots WHERE item_uid = ? ORDER BY id DESC LIMIT 1');
  const findCurrent = db.prepare('SELECT * FROM product_current WHERE item_uid = ?');

  let checked = 0;
  for (const uid of snapshotUids) {
    if (!productCurrentUids.has(uid)) { missingCurrent.push(uid); continue; }
    checked++;
    const latestSnap = await findLatestSnapshot.get(uid);
    const current = await findCurrent.get(uid);

    if (latestSnap.platform && current.platform && latestSnap.platform !== current.platform) {
      metricMismatches.push({ itemUid: uid, field: 'platform', legacyValue: latestSnap.platform, v2Value: current.platform });
    }

    for (const { legacy, v2 } of V2_PARITY_METRIC_FIELDS) {
      const legacyValue = latestSnap[legacy];
      const v2Value = current[v2];
      if (legacyValue == null && v2Value == null) continue; // both unpopulated â€” equal
      if (legacyValue == null || v2Value == null || Number(legacyValue) !== Number(v2Value)) {
        metricMismatches.push({ itemUid: uid, field: legacy, legacyValue, v2Value });
      }
    }
  }

  const legacyObsCountByUid = new Map(
    (await db.prepare('SELECT item_uid, COUNT(*) c FROM snapshots GROUP BY item_uid').all()).map(r => [r.item_uid, r.c])
  );
  const packedObsCountByUid = new Map(
    (await db.prepare('SELECT item_uid, SUM(observation_count) c FROM daily_packed_history GROUP BY item_uid').all()).map(r => [r.item_uid, r.c])
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

  // Â§4/Â§16.E: prefer the stable observationId identity (present on every
  // observation written by the current appendObservation()) when available â€”
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

  for (const row of await db.prepare('SELECT * FROM daily_packed_history').all()) {
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

  // .all(), not .iterate(): the adapter's iterate() is an async generator, so
  // a plain for...of over it throws "is not iterable". The row count here is
  // small enough to materialise.
  for (const snap of await db.prepare('SELECT * FROM snapshots').all()) {
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
      if (legacyValue == null && obsValue == null) continue; // both unpopulated â€” equal
      if (legacyValue == null || obsValue == null || Number(legacyValue) !== Number(obsValue)) {
        historyMetricMismatches += 1;
        if (historyMetricMismatchSamples.length < 20) {
          historyMetricMismatchSamples.push({ itemUid: snap.item_uid, observationId: expectedObservationId, field: legacy, legacyValue, obsValue });
        }
      }
    }

    // Gap #5 / Patch 2B: Timestamp Parity â€” compare legacy snapshot timestamp
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
  const allLegacySnapshotIds = new Set((await db.prepare('SELECT id FROM snapshots').all()).map((r) => String(r.id)));
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

  // Â§5/Gap #5: every history failure mode gates parityOk â€” duplicates/malformed
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
 * DB Health Monitor (Simplification Round #16) â€” replaces the mandatory 10M
 * synthetic benchmark as a release gate. Reports the metrics that actually
 * matter for "is row growth under control", not a one-off performance claim.
 */
async function getDatabaseHealth() {
  // Previously stat()'d the collector.db file. Postgres has no single file to
  // measure, and reading the archived SQLite file here would keep an active
  // runtime dependency on it â€” so the size now comes from Postgres itself.
  const dbSizeBytes = Number(
    (await db.prepare('SELECT pg_database_size(current_database()) AS size').get()).size
  ) || 0;

  const productCurrentRows = (await db.prepare('SELECT COUNT(*) c FROM product_current').get()).c;
  const dailyHistoryStats = await db.prepare('SELECT COUNT(*) c, AVG(observation_count) avgObs, MAX(observation_count) maxObs, SUM(observation_count) totalObs FROM daily_packed_history').get();
  const legacySnapshotRows = (await db.prepare('SELECT COUNT(*) c FROM snapshots').get()).c;
  const weeklySummaryRows = (await db.prepare('SELECT COUNT(*) c FROM weekly_summary').get()).c;
  // Â§15: pending V2 repair count â€” dual-write failures recorded by
  // recordV2WriteFailure() that repairPendingV2WriteFailures() hasn't
  // resolved yet. A non-zero count here means product_current/daily_packed_history
  // is currently missing data that legacy `snapshots` has, independent of the
  // full checkV2Parity() scan.
  const pendingV2RepairCount = (await db.prepare("SELECT COUNT(*) c FROM v2_write_failures WHERE status = 'pending'").get()).c;

  const t0 = process.hrtime.bigint();
  await db.prepare('SELECT * FROM product_current ORDER BY rank_score DESC LIMIT 1').get();
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
 * prior tick (before or after a restart â€” this table is the persistent source of
 * truth, unlike the old in-memory Map/Set). The UNIQUE constraint is what makes
 * this safe under concurrent ticks.
 */
async function reserveSocialBotWindow(botKey, scheduledWindow, queryKey) {
  try {
    const info = await socialBotStmt.reserveWindow.run({ botKey, scheduledWindow, queryKey });
    return info.lastInsertRowid;
  } catch (err) {
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) return null; // Already reserved.
    throw err;
  }
}

async function markSocialBotDispatched(id, runId) { await socialBotStmt.markDispatched.run({ id, runId }); }
async function markSocialBotFailed(id, errorMessage) { await socialBotStmt.markFailed.run({ id, errorMessage: String(errorMessage || '') }); }
async function releaseSocialBotWindow(id) { await socialBotStmt.deleteById.run(id); }

/**
 * Crash-safety sweep (Simplification Round #20): if the process crashed after
 * reserveSocialBotWindow() inserted a 'pending' row but before markSocialBot
 * Dispatched()/releaseSocialBotWindow() ran, that row would otherwise block
 * the UNIQUE(bot_key, scheduled_window, query_key) constraint forever â€” the
 * window could never be retried. Any 'pending' row older than thresholdMs is
 * assumed abandoned and deleted so the next tick can legitimately re-reserve
 * and re-enqueue it exactly once.
 */
async function recoverStalePendingSocialBotWindows(thresholdMs = 5 * 60 * 1000) {
  // SQLite's CURRENT_TIMESTAMP formats as 'YYYY-MM-DD HH:MM:SS' (UTC, no 'T'/'Z'/ms);
  // the cutoff must match exactly or the string comparison sorts incorrectly.
  const cutoff = new Date(Date.now() - thresholdMs).toISOString().replace('T', ' ').slice(0, 19);
  const info = await db.prepare("DELETE FROM social_bot_state WHERE status = 'pending' AND created_at < ?").run(cutoff);
  if (info.changes > 0) {
    console.warn(`[SocialBotRecovery] Cleared ${info.changes} stale pending window(s) older than ${thresholdMs}ms so they can be retried.`);
  }
  return { cleared: info.changes };
}
async function getLastDispatchedSocialBotWindow(botKey) { return await socialBotStmt.findLastDispatched.get(botKey); }
async function countDispatchedSocialBotRuns(botKey) { return (await socialBotStmt.countDispatched.get(botKey)).c; }

const api = {
  // Test/diagnostic access to the underlying PostgreSQL connection. Tests used
  // to open a second better-sqlite3 handle on data/collector.db to inspect rows
  // directly; with PostgreSQL a second connection would contend for the same
  // database, so they share this one instead.
  _connection: db,
  // Creates the Postgres schema and seeds platforms â€” work that used to happen
  // implicitly at require() time, when every SQLite call was synchronous.
  // server.js awaits this explicitly at boot so failures are fatal there, but
  // it is memoised and every async export below also waits on it (see the
  // wrapper at the end of this file), so no caller can race an empty database.
  initDatabase,
  getAllPlatforms, createRun, getRunById, getQueuedRuns, getAllRuns, getRunsByStatus, getChildRuns, updateRun, deleteRun,
  deleteItem, deleteAllItems,
  reserveSocialBotWindow, markSocialBotDispatched, markSocialBotFailed, releaseSocialBotWindow,
  getLastDispatchedSocialBotWindow, countDispatchedSocialBotRuns, recoverStalePendingSocialBotWindows,
  insertSnapshots, getLatestSnapshots, getLatestSnapshotByUid, getSnapshotHistory, getSnapshotsByRunId, getRunItems, backfillRunResultItems,
  getProductCurrent, getProductCurrentByUid, getProductHistory, getProductHistoryWithMetadata, getProductWeekly, backfillSnapshotsToV2, getDatabaseHealth, formatVietnamTime,
  getPendingV2WriteFailures, repairPendingV2WriteFailures, checkV2Parity, normalizeLegacyUtcTimestamp,
  getSnapshotsMissingEtsyImages, updateSnapshotImage, getSnapshotsMatchingQuery,
  getStats, getRunStats,
  createMarketplaceAccount, getMarketplaceAccounts, getMarketplaceStorageState, deleteMarketplaceAccount,
  createMarketplaceProxy, getMarketplaceProxies, getMarketplaceProxyUrl, assignMarketplaceAccountProxy, deleteMarketplaceProxy,
  createMarketplaceCapture, getCachedMarketplaceCapture, getMarketplaceCapture, getMarketplaceCaptures,
  createMarketplaceCaptureSchedule, getMarketplaceCaptureSchedules, getDueMarketplaceCaptureSchedules, completeMarketplaceCaptureSchedule, getMarketplaceCaptureScheduleRuns, deleteMarketplaceCaptureSchedule, toggleMarketplaceCaptureSchedule,
  claimMarketplaceCaptureSchedule, releaseMarketplaceCaptureScheduleClaim, renewMarketplaceCaptureScheduleClaim,
};

/**
 * Every asynchronous export waits for initDatabase() before it runs.
 *
 * Under better-sqlite3 the schema was guaranteed to exist the instant this
 * module was required. Making initialisation async would otherwise turn that
 * guarantee into a footgun â€” any caller that forgot to await initDatabase()
 * would get "relation does not exist" instead. initDatabase() is memoised, so
 * this costs one already-resolved promise per call after the first.
 *
 * Synchronous helpers (formatVietnamTime, normalizeLegacyUtcTimestamp) are
 * passed through untouched so they keep returning values, not promises.
 */
module.exports = Object.fromEntries(
  Object.entries(api).map(([name, value]) => {
    if (name === 'initDatabase' || typeof value !== 'function') return [name, value];
    if (value.constructor.name !== 'AsyncFunction') return [name, value];
    return [name, async (...args) => {
      await initDatabase();
      return value(...args);
    }];
  })
);
