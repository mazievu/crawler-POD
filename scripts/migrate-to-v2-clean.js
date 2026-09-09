'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { initSchemaV2 } = require('../src/database/schema-v2');
const { createProductCurrentOps } = require('../src/database/product-current');
const { createDailyHistoryOps, normalizeLegacyUtcTimestamp } = require('../src/database/daily-history');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_DB_PATH = path.join(PROJECT_ROOT, 'data', 'collector.db');
const DEST_DB_PATH = path.join(PROJECT_ROOT, 'data', 'collector.v2.db');

async function migrate() {
  console.log('====================================================');
  console.log('STARTING CLEAN V2 DATABASE MIGRATION');
  console.log('====================================================');
  console.log('Source DB:', SRC_DB_PATH);
  console.log('Destination DB:', DEST_DB_PATH);

  if (!fs.existsSync(SRC_DB_PATH)) {
    console.error('ERROR: Source database not found!');
    process.exit(1);
  }

  // Remove existing destination file if any previous failed run
  if (fs.existsSync(DEST_DB_PATH)) {
    fs.unlinkSync(DEST_DB_PATH);
  }
  const destWal = DEST_DB_PATH + '-wal';
  const destShm = DEST_DB_PATH + '-shm';
  if (fs.existsSync(destWal)) fs.unlinkSync(destWal);
  if (fs.existsSync(destShm)) fs.unlinkSync(destShm);

  const srcDb = new Database(SRC_DB_PATH, { readonly: true });
  const destDb = new Database(DEST_DB_PATH);

  destDb.pragma('journal_mode = WAL');
  destDb.pragma('synchronous = NORMAL');
  destDb.pragma('busy_timeout = 10000');

  // 1. Create table schemas
  console.log('\n[1/5] Creating table schemas...');
  
  // Create config/ancillary tables
  destDb.exec(`
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
      completed_at     DATETIME,
      active_backend   TEXT,
      backend_kind     TEXT,
      backend_status   TEXT,
      backend_version  TEXT,
      backend_run_id   TEXT,
      health_snapshot  TEXT,
      cost_estimate    REAL DEFAULT 0,
      parent_run_id    INTEGER,
      result_items_json TEXT,
      external_execution_json TEXT
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
    CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_run_likes ON snapshots(run_id, likes DESC);

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
    CREATE INDEX IF NOT EXISTS idx_marketplace_captures_cache ON marketplace_captures(platform, url, account_id, variant_mode, max_variants, id DESC);

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
      claimed_until TEXT,
      claim_token TEXT,
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

    CREATE TABLE IF NOT EXISTS migration_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Initialize V2 storage schema
  initSchemaV2(destDb);
  console.log('✓ Schemas initialized successfully.');

  // 2. Copy ancillary/configuration tables
  console.log('\n[2/5] Copying ancillary tables...');
  const ancillaryTables = [
    'platforms',
    'marketplace_proxies',
    'marketplace_accounts',
    'marketplace_captures',
    'marketplace_capture_schedules',
    'marketplace_capture_schedule_runs',
    'social_bot_state'
  ];

  for (const table of ancillaryTables) {
    const rows = srcDb.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length > 0) {
      const keys = Object.keys(rows[0]);
      const placeholders = keys.map(k => `@${k}`).join(', ');
      const insertStmt = destDb.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`);
      const insertMany = destDb.transaction((items) => {
        for (const item of items) insertStmt.run(item);
      });
      insertMany(rows);
    }
    console.log(`  - ${table}: copied ${rows.length} rows`);
  }

  // 3. Migrate Runs and Items into V2
  console.log('\n[3/5] Migrating 206 runs and ~87k genuine items to V2...');
  const dailyHistoryOps = createDailyHistoryOps(destDb);
  const productCurrentOps = createProductCurrentOps(destDb, dailyHistoryOps);

  const srcRuns = srcDb.prepare('SELECT * FROM runs ORDER BY id ASC').all();
  console.log(`Found ${srcRuns.length} runs to process.`);

  const insertRunStmt = destDb.prepare(`
    INSERT INTO runs (
      id, platform, query, status, apify_run_id, apify_dataset_id,
      items_count, new_count, active_count, dropped_count, error_message,
      max_items, country, input_options, created_at, completed_at,
      active_backend, backend_kind, backend_status, backend_version,
      backend_run_id, health_snapshot, cost_estimate, parent_run_id,
      result_items_json, external_execution_json
    ) VALUES (
      @id, @platform, @query, @status, @apify_run_id, @apify_dataset_id,
      @items_count, @new_count, @active_count, @dropped_count, @error_message,
      @max_items, @country, @input_options, @created_at, @completed_at,
      @active_backend, @backend_kind, @backend_status, @backend_version,
      @backend_run_id, @health_snapshot, @cost_estimate, @parent_run_id,
      @result_items_json, @external_execution_json
    )
  `);

  let totalItemsMigrated = 0;
  let startTime = Date.now();

  const selectSnapsStmt = srcDb.prepare(`
    SELECT * FROM snapshots 
    WHERE run_id = ? 
    ORDER BY id ASC 
    LIMIT ?
  `);

  for (let i = 0; i < srcRuns.length; i++) {
    const run = srcRuns[i];
    const itemsCount = run.items_count || 0;
    const resultItems = [];

    destDb.transaction(() => {
      if (itemsCount > 0) {
        const snaps = selectSnapsStmt.all(run.id, itemsCount);
        for (const snap of snaps) {
          const v2Item = {
            item_uid: snap.item_uid,
            platform: snap.platform,
            query: snap.query,
            title: snap.title || '',
            url: snap.url || '',
            image: snap.image || '',
            author: snap.author || '',
            price: Number(snap.price) || 0,
            rating: Number(snap.rating) || 0,
            reviews: Number(snap.reviews) || 0,
            sold_count: Number(snap.sold_count) || 0,
            likes: Number(snap.likes) || 0,
            comments: Number(snap.comments) || 0,
            shares: Number(snap.shares) || 0,
            views: Number(snap.views) || 0
          };

          const normalizedTs = normalizeLegacyUtcTimestamp(snap.created_at);
          productCurrentOps.upsertItem(v2Item, run.id, normalizedTs);
          dailyHistoryOps.appendObservation(v2Item, normalizedTs, { runId: run.id });

          resultItems.push({
            ...v2Item,
            status: snap.status || 'new',
            observed_at: snap.created_at
          });
          totalItemsMigrated++;
        }
      }

      run.result_items_json = resultItems.length > 0 ? JSON.stringify(resultItems) : null;
      insertRunStmt.run(run);
    })();

    if ((i + 1) % 25 === 0 || i === srcRuns.length - 1) {
      console.log(`  Progress: ${i + 1}/${srcRuns.length} runs processed (${totalItemsMigrated} items migrated)...`);
    }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✓ Migration loop finished in ${elapsedSec}s. Total items processed: ${totalItemsMigrated}.`);

  // 4. Verification of new DB
  console.log('\n[4/5] Verifying new database integrity and stats...');
  const integrity = destDb.pragma('integrity_check');
  console.log('Integrity check:', integrity[0].integrity_check);
  if (integrity[0].integrity_check !== 'ok') {
    throw new Error('Destination database integrity check failed!');
  }

  const pcCount = destDb.prepare('SELECT count(*) as c FROM product_current').get().c;
  const dhCount = destDb.prepare('SELECT count(*) as c FROM daily_packed_history').get().c;
  const runsCount = destDb.prepare('SELECT count(*) as c FROM runs').get().c;
  const snapCount = destDb.prepare('SELECT count(*) as c FROM snapshots').get().c;

  console.log('V2 Table Counts:');
  console.log(`  - product_current:     ${pcCount.toLocaleString()} rows (unique live products)`);
  console.log(`  - daily_packed_history: ${dhCount.toLocaleString()} rows (daily compressed history)`);
  console.log(`  - runs:                 ${runsCount.toLocaleString()} rows`);
  console.log(`  - snapshots:            ${snapCount.toLocaleString()} rows (clean legacy table)`);

  // Record migration checkpoint
  destDb.prepare(`
    INSERT INTO migration_checkpoints (key, value, updated_at) 
    VALUES ('snapshots_v2_backfill', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(String(totalItemsMigrated));

  // Checkpoint WAL and close
  destDb.pragma('wal_checkpoint(TRUNCATE)');
  destDb.close();
  srcDb.close();

  const v2FileSize = fs.statSync(DEST_DB_PATH).size;
  console.log(`\nNew database file size: ${(v2FileSize / (1024 * 1024)).toFixed(2)} MB`);
  console.log('\n[5/5] Migration complete! Next step: swap files.');
}

migrate().catch((err) => {
  console.error('FATAL MIGRATION ERROR:', err);
  process.exit(1);
});
