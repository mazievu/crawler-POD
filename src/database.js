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
  CREATE INDEX IF NOT EXISTS idx_snapshots_run ON snapshots(run_id);
`);

// Migrate: if old schema exists, migrate
const tableInfo = db.prepare(`PRAGMA table_info(runs)`).all();
const hasRuns = tableInfo.some((c) => c.name === 'new_count');
if (!hasRuns) {
  // Old schema — keep old tables, just add runs/snapshots
  console.log('[DB] Adding snapshot tables...');
}

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
    INSERT INTO runs (platform, query, max_items, country)
    VALUES (@platform, @query, @maxItems, @country)
  `),
  findRunById: db.prepare('SELECT * FROM runs WHERE id = ?'),
  findAllRuns: db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?'),
  updateRun: db.prepare(`
    UPDATE runs SET status=@status, apify_run_id=@apifyRunId, apify_dataset_id=@apifyDatasetId,
      items_count=@itemsCount, new_count=@newCount, active_count=@activeCount,
      dropped_count=@droppedCount, error_message=@errorMessage, completed_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `),
  deleteRun: db.prepare('DELETE FROM runs WHERE id = ?'),

  // Snapshots
  insertSnapshot: db.prepare(`
    INSERT INTO snapshots (run_id, platform, query, item_uid, raw_data, title, url, image, author,
      price, likes, comments, shares, views, status, prev_snapshot_id)
    VALUES (@runId, @platform, @query, @itemUid, @rawData, @title, @url, @image, @author,
      @price, @likes, @comments, @shares, @views, @status, @prevSnapshotId)
  `),
  findSnapshotsByRunId: db.prepare('SELECT * FROM snapshots WHERE run_id = ? ORDER BY likes DESC'),
  findLatestSnapshots: db.prepare(`
    SELECT s.* FROM snapshots s
    INNER JOIN (SELECT platform, query, MAX(run_id) as max_run FROM snapshots GROUP BY platform, query) latest
    ON s.platform = latest.platform AND s.query = latest.query AND s.run_id = latest.max_run
    ORDER BY s.created_at DESC
  `),
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
};

// ==================== CRUD Operations ====================

function getAllPlatforms() { return stmt.findAllPlatforms.all(); }

function createRun({ platform, query, maxItems = 100, country = null }) {
  const r = stmt.createRun.run({ platform, query, maxItems, country });
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
        rawData: typeof item === 'string' ? item : JSON.stringify(item),
        title: parsed.title,
        url: parsed.url,
        image: parsed.image,
        author: parsed.author,
        price: parsed.price,
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

function getLatestSnapshots() { return stmt.findLatestSnapshots.all(); }
function getSnapshotHistory(itemUid) { return stmt.getSnapshotHistory.all(itemUid); }
function getSnapshotsByRunId(runId) { return stmt.findSnapshotsByRunId.all(runId); }

function getStats() {
  const totalRuns = stmt.countRuns.get().total;
  const totalSnapshots = stmt.countSnapshots.get().total;
  return { totalRuns, totalSnapshots };
}

function getRunStats() {
  return stmt.getRunsByPlatform.all();
}

// ==================== Helpers ====================

function parseItemData(item) {
  let d;
  try { d = typeof item === 'string' ? JSON.parse(item) : item; } catch { d = {}; }

  const title = d.title || d.adTitle || d.productTitle || d.name || d.text || '';
  const image = d.image || d.thumbnail || d.adVideoCover || d.imageUrl || d.cover || '';
  const url = d.url || d.permalink || d.adUrl || d.link || d.productUrl || '';
  const author = typeof (d.author || d.advertiserName || d.username || '') === 'object'
    ? (d.author?.name || d.author?.username || '')
    : (d.author || d.advertiserName || d.username || '');

  const price = parseNum(d.price || d.adSpend || d.product_price || 0);
  const likes = parseNum(d.likes || d.likeCount || d.like_count || d.upvotes || d.score || d.favouritesCount || 0);
  const comments = parseNum(d.comments || d.commentCount || d.replyCount || d.num_comments || 0);
  const shares = parseNum(d.shares || d.shareCount || d.retweetCount || d.reposts || 0);
  const views = parseNum(d.viewCount || d.view_count || d.impressions || 0);

  return { title: String(title).substring(0, 200), image, url, author: String(author).substring(0, 100),
    price, likes, comments, shares, views };
}

function parseNum(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

function generateUid(platform, query, parsed) {
  // Use URL if available, otherwise title+author hash
  if (parsed.url) return `${platform}:${parsed.url}`;
  return `${platform}:${query}:${parsed.title}:${parsed.author}`.toLowerCase().replace(/[^a-z0-9:]/g, '');
}

module.exports = {
  getAllPlatforms, createRun, getRunById, getAllRuns, updateRun, deleteRun,
  insertSnapshots, getLatestSnapshots, getSnapshotHistory, getSnapshotsByRunId,
  getStats, getRunStats,
};
