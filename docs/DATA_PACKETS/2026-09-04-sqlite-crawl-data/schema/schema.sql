-- crawler-POD — SQLite schema snapshot
-- Generated: 2026-09-04T10:36:16.308Z
-- Objects: 32
CREATE TABLE daily_packed_history (
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

CREATE TABLE marketplace_accounts (
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

CREATE TABLE marketplace_capture_schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    summary TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    FOREIGN KEY (schedule_id) REFERENCES marketplace_capture_schedules(id) ON DELETE CASCADE
  );

CREATE TABLE marketplace_capture_schedules (
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, claimed_until TEXT, claim_token TEXT,
    FOREIGN KEY (account_id) REFERENCES marketplace_accounts(id) ON DELETE SET NULL
  );

CREATE TABLE marketplace_captures (
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

CREATE TABLE marketplace_proxies (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    label             TEXT NOT NULL UNIQUE,
    protocol          TEXT NOT NULL DEFAULT 'socks5',
    host              TEXT NOT NULL,
    port              INTEGER NOT NULL,
    config_encrypted  TEXT NOT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE migration_checkpoints (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE platforms (
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

CREATE TABLE product_current (
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
      prev_likes        INTEGER,
      prev_comments     INTEGER,
      prev_shares       INTEGER,
      prev_views        INTEGER,
      prev_sold         INTEGER,
      prev_reviews      INTEGER,

      delta_price       REAL NOT NULL DEFAULT 0,
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
    , prev_rating REAL, delta_rating REAL NOT NULL DEFAULT 0);

CREATE TABLE runs (
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
  , active_backend TEXT, backend_kind TEXT, backend_status TEXT, backend_version TEXT, backend_run_id TEXT, health_snapshot TEXT, cost_estimate REAL DEFAULT 0, parent_run_id INTEGER, result_items_json TEXT, external_execution_json TEXT);

CREATE TABLE snapshots (
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

CREATE TABLE social_bot_state (
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

CREATE TABLE v2_write_failures (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER,
    item_uid      TEXT NOT NULL,
    error_message TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending', -- pending | repaired
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE weekly_summary (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      item_uid          TEXT NOT NULL,
      platform          TEXT NOT NULL,
      year_week         TEXT NOT NULL, -- 'YYYY-WW'
      avg_price         REAL NOT NULL DEFAULT 0,
      max_likes         INTEGER NOT NULL DEFAULT 0,
      max_views         INTEGER NOT NULL DEFAULT 0,
      delta_likes       INTEGER NOT NULL DEFAULT 0,
      delta_views       INTEGER NOT NULL DEFAULT 0,
      delta_sold        INTEGER NOT NULL DEFAULT 0,
      growth_rate       REAL NOT NULL DEFAULT 0,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP, sample_count INTEGER NOT NULL DEFAULT 0, sum_price REAL NOT NULL DEFAULT 0, first_price REAL, last_price REAL, first_views INTEGER, last_views INTEGER, first_likes INTEGER, last_likes INTEGER, first_sold INTEGER, last_sold INTEGER, first_comments INTEGER, last_comments INTEGER, first_shares INTEGER, last_shares INTEGER,
      UNIQUE(item_uid, year_week)
    );

CREATE INDEX idx_daily_history_platform_date ON daily_packed_history(platform, date DESC);

CREATE INDEX idx_daily_history_uid_date ON daily_packed_history(item_uid, date DESC);

CREATE INDEX idx_marketplace_capture_schedule_runs_schedule ON marketplace_capture_schedule_runs(schedule_id, id DESC);

CREATE INDEX idx_marketplace_capture_schedules_due ON marketplace_capture_schedules(enabled, next_run_at);

CREATE INDEX idx_marketplace_captures_cache ON marketplace_captures(platform, url, account_id, variant_mode, max_variants, id DESC);

CREATE INDEX idx_marketplace_captures_platform ON marketplace_captures(platform, created_at DESC);

CREATE INDEX idx_product_current_last_crawled ON product_current(last_crawled_at DESC);

CREATE INDEX idx_product_current_platform_crawled ON product_current(platform, last_crawled_at DESC);

CREATE INDEX idx_product_current_platform_rank ON product_current(platform, rank_score DESC);

CREATE INDEX idx_product_current_query ON product_current(platform, query);

CREATE INDEX idx_runs_parent ON runs(parent_run_id);

CREATE INDEX idx_snapshots_latest ON snapshots(platform, query, run_id DESC);

CREATE INDEX idx_snapshots_platform_query ON snapshots(platform, query);

CREATE INDEX idx_snapshots_run ON snapshots(run_id);

CREATE INDEX idx_snapshots_uid ON snapshots(item_uid);

CREATE INDEX idx_social_bot_state_bot ON social_bot_state(bot_key, scheduled_window DESC);

CREATE INDEX idx_weekly_summary_platform_week ON weekly_summary(platform, year_week DESC);

CREATE INDEX idx_weekly_summary_uid_week ON weekly_summary(item_uid, year_week DESC);
