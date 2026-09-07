/**
 * V2 3-Tier Storage Schema
 * - Tier 1: product_current (1 row per unique item_uid)
 * - Tier 2: daily_packed_history (1 row per item_uid + date, packing all intraday observations)
 * - Tier 3: weekly_summary (1 row per item_uid + year_week for long-term trend analysis)
 */

function initSchemaV2(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_current (
      item_uid          TEXT PRIMARY KEY,
      platform          TEXT NOT NULL,
      query             TEXT NOT NULL DEFAULT '',
      title             TEXT NOT NULL DEFAULT '',
      url               TEXT NOT NULL DEFAULT '',
      image             TEXT NOT NULL DEFAULT '',
      author            TEXT NOT NULL DEFAULT '',
      
      current_price     REAL NOT NULL DEFAULT 0,
      current_rating    REAL NOT NULL DEFAULT 0,
      current_reviews   INTEGER NOT NULL DEFAULT 0,
      current_sold      INTEGER NOT NULL DEFAULT 0,
      current_likes     INTEGER NOT NULL DEFAULT 0,
      current_comments  INTEGER NOT NULL DEFAULT 0,
      current_shares    INTEGER NOT NULL DEFAULT 0,
      current_views     INTEGER NOT NULL DEFAULT 0,
      
      prev_price        REAL,
      prev_rating       REAL,
      prev_likes        INTEGER,
      prev_comments     INTEGER,
      prev_shares       INTEGER,
      prev_views        INTEGER,
      prev_sold         INTEGER,
      prev_reviews      INTEGER,

      delta_price       REAL NOT NULL DEFAULT 0,
      delta_rating      REAL NOT NULL DEFAULT 0,
      delta_likes       INTEGER NOT NULL DEFAULT 0,
      delta_comments    INTEGER NOT NULL DEFAULT 0,
      delta_shares      INTEGER NOT NULL DEFAULT 0,
      delta_views       INTEGER NOT NULL DEFAULT 0,
      delta_sold        INTEGER NOT NULL DEFAULT 0,
      delta_reviews     INTEGER NOT NULL DEFAULT 0,

      delta_3h_likes    INTEGER,
      delta_3h_views    INTEGER,
      delta_24h_likes   INTEGER,
      delta_24h_views   INTEGER,
      delta_24h_sold    INTEGER,

      rank_score        REAL NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'new', -- 'new' | 'active' | 'dropped'
      last_run_id       INTEGER,
      observation_count INTEGER NOT NULL DEFAULT 1,

      first_seen_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_crawled_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_product_current_platform_rank ON product_current(platform, rank_score DESC);
    CREATE INDEX IF NOT EXISTS idx_product_current_last_crawled ON product_current(last_crawled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_product_current_platform_crawled ON product_current(platform, last_crawled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_product_current_query ON product_current(platform, query);

    CREATE TABLE IF NOT EXISTS daily_packed_history (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      item_uid          TEXT NOT NULL,
      platform          TEXT NOT NULL,
      date              TEXT NOT NULL, -- 'YYYY-MM-DD'
      observations_json TEXT NOT NULL DEFAULT '[]', -- JSON array of observation objects
      observation_count INTEGER NOT NULL DEFAULT 0,
      min_price         REAL NOT NULL DEFAULT 0,
      max_price         REAL NOT NULL DEFAULT 0,
      latest_price      REAL NOT NULL DEFAULT 0,
      latest_likes      INTEGER NOT NULL DEFAULT 0,
      latest_views      INTEGER NOT NULL DEFAULT 0,
      latest_sold       INTEGER NOT NULL DEFAULT 0,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(item_uid, date)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_history_uid_date ON daily_packed_history(item_uid, date DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_history_platform_date ON daily_packed_history(platform, date DESC);

    CREATE TABLE IF NOT EXISTS weekly_summary (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      item_uid          TEXT NOT NULL,
      platform          TEXT NOT NULL,
      year_week         TEXT NOT NULL, -- 'YYYY-WW'
      sample_count      INTEGER NOT NULL DEFAULT 0,
      sum_price         REAL NOT NULL DEFAULT 0,
      avg_price         REAL NOT NULL DEFAULT 0,
      first_price       REAL,
      last_price        REAL,
      first_views       INTEGER,
      last_views        INTEGER,
      first_likes       INTEGER,
      last_likes        INTEGER,
      first_sold        INTEGER,
      last_sold         INTEGER,
      first_comments    INTEGER,
      last_comments     INTEGER,
      first_shares      INTEGER,
      last_shares       INTEGER,
      max_likes         INTEGER NOT NULL DEFAULT 0,
      max_views         INTEGER NOT NULL DEFAULT 0,
      delta_likes       INTEGER NOT NULL DEFAULT 0,
      delta_views       INTEGER NOT NULL DEFAULT 0,
      delta_sold        INTEGER NOT NULL DEFAULT 0,
      growth_rate       REAL NOT NULL DEFAULT 0,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(item_uid, year_week)
    );

    CREATE INDEX IF NOT EXISTS idx_weekly_summary_uid_week ON weekly_summary(item_uid, year_week DESC);
    CREATE INDEX IF NOT EXISTS idx_weekly_summary_platform_week ON weekly_summary(platform, year_week DESC);
  `);
}

/**
 * Migrates an existing product_current table whose delta_3h_ and delta_24h_
 * prefixed columns were created as NOT-NULL-DEFAULT-0 (Fix Round 1), moving them
 * to nullable columns, so a
 * missing historical reference point can be represented as NULL instead of a
 * fabricated 0 (which would be indistinguishable from "no growth"). SQLite has
 * no ALTER COLUMN DROP NOT NULL, so this rebuilds the table in a transaction,
 * preserving every existing row and index. No-ops if already nullable.
 */
function migrateDeltaColumnsNullable(db) {
  const cols = db.prepare('PRAGMA table_info(product_current)').all();
  if (cols.length === 0) return { migrated: false, reason: 'TABLE_NOT_FOUND' };
  const needsMigration = cols.some(c =>
    ['delta_3h_likes', 'delta_3h_views', 'delta_24h_likes', 'delta_24h_views', 'delta_24h_sold'].includes(c.name) && c.notnull === 1
  );
  if (!needsMigration) return { migrated: false, reason: 'ALREADY_NULLABLE' };

  const columnList = cols.map(c => c.name).join(', ');

  const tx = db.transaction(() => {
    db.exec('ALTER TABLE product_current RENAME TO product_current_pre_p04_migration');
    initSchemaV2(db); // recreates product_current with the nullable schema + indexes
    db.exec(`INSERT INTO product_current (${columnList}) SELECT ${columnList} FROM product_current_pre_p04_migration`);
    db.exec('DROP TABLE product_current_pre_p04_migration');
  });
  tx();

  const rowCount = db.prepare('SELECT COUNT(*) c FROM product_current').get().c;
  return { migrated: true, rowCount };
}

/**
 * P0-5: adds the sample_count, sum_price, and first_/last_ prefixed columns needed for
 * correct weekly math (avg = sum/count, delta = last-first) to an existing
 * weekly_summary table created by Fix Round 1's (avg+new)/2 running-average
 * formula. Plain ADD COLUMN is safe here (no rebuild needed, nothing is nullable
 * that used to be NOT NULL). Existing rows keep their old (incorrect) avg_price/
 * delta_* values until recomputeWeeklySummaryFromHistory() rebuilds them from
 * Tier 2 daily_packed_history, which is unaffected and remains the full-fidelity
 * source — this migration never touches or deletes historical observations.
 */
function migrateWeeklySummaryColumns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(weekly_summary)').all().map(c => c.name));
  if (cols.has('sample_count')) return { migrated: false, reason: 'ALREADY_MIGRATED' };

  const newColumns = [
    'sample_count INTEGER NOT NULL DEFAULT 0',
    'sum_price REAL NOT NULL DEFAULT 0',
    'first_price REAL', 'last_price REAL',
    'first_views INTEGER', 'last_views INTEGER',
    'first_likes INTEGER', 'last_likes INTEGER',
    'first_sold INTEGER', 'last_sold INTEGER',
    'first_comments INTEGER', 'last_comments INTEGER',
    'first_shares INTEGER', 'last_shares INTEGER'
  ];

  const tx = db.transaction(() => {
    for (const colDef of newColumns) {
      db.exec(`ALTER TABLE weekly_summary ADD COLUMN ${colDef}`);
    }
  });
  tx();

  return { migrated: true };
}

function migrateRatingDeltaColumns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(product_current)').all().map(c => c.name));
  if (cols.has('delta_rating') && cols.has('prev_rating')) return { migrated: false, reason: 'ALREADY_MIGRATED' };

  const tx = db.transaction(() => {
    if (!cols.has('prev_rating')) {
      db.exec('ALTER TABLE product_current ADD COLUMN prev_rating REAL');
    }
    if (!cols.has('delta_rating')) {
      db.exec('ALTER TABLE product_current ADD COLUMN delta_rating REAL NOT NULL DEFAULT 0');
    }
  });
  tx();

  return { migrated: true };
}

module.exports = { initSchemaV2, migrateDeltaColumnsNullable, migrateWeeklySummaryColumns, migrateRatingDeltaColumns };
