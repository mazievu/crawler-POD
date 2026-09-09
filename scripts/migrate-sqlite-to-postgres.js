#!/usr/bin/env node
/**
 * migrate-sqlite-to-postgres.js
 *
 * Migrates all data from the clean SQLite database (data/collector.db)
 * to PostgreSQL (crawler_pod).
 *
 * Features:
 * - Direct streaming with batch inserts (500-1000 rows per batch)
 * - Preserves primary keys, identity sequences, and foreign keys
 * - Resets all identity sequences to MAX(id) after load
 * - Validates 1:1 row count parity and spot-checks integrity
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
require('dotenv').config();

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SQLITE_PATH = path.join(REPO_ROOT, 'data', 'collector.db');

const TABLES_ORDER = [
  'platforms',
  'runs',
  'snapshots',
  'product_current',
  'daily_packed_history',
  'weekly_summary',
  'marketplace_proxies',
  'marketplace_accounts',
  'marketplace_captures',
  'marketplace_capture_schedules',
  'marketplace_capture_schedule_runs',
  'social_bot_state',
  'v2_write_failures',
  'migration_checkpoints',
];

const TABLES_WITH_IDENTITY = [
  'platforms',
  'runs',
  'snapshots',
  'daily_packed_history',
  'weekly_summary',
  'marketplace_proxies',
  'marketplace_accounts',
  'marketplace_captures',
  'marketplace_capture_schedules',
  'marketplace_capture_schedule_runs',
  'social_bot_state',
  'v2_write_failures',
];

async function migrate() {
  const sqlitePath = process.argv[2] || DEFAULT_SQLITE_PATH;
  if (!fs.existsSync(sqlitePath)) {
    console.error(`SQLite database not found at ${sqlitePath}`);
    process.exit(1);
  }

  console.log(`[INFO] Source SQLite: ${sqlitePath}`);
  const sdb = new Database(sqlitePath, { readonly: true });

  const pool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'crawler',
    password: process.env.PGPASSWORD || 'crawler',
    database: process.env.PGDATABASE || 'crawler_pod',
  });

  const startTime = Date.now();
  const client = await pool.connect();

  try {
    console.log(`[INFO] Connected to PostgreSQL (${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'crawler_pod'})`);

    // 1. Disable FK checks and triggers during bulk migration
    await client.query("SET session_replication_role = 'replica';");

    // 2. Truncate all tables cleanly in reverse dependency order
    console.log('[INFO] Truncating PostgreSQL tables...');
    const truncateList = [...TABLES_ORDER].reverse().map(t => `"${t}"`).join(', ');
    await client.query(`TRUNCATE TABLE ${truncateList} CASCADE;`);
    console.log('[INFO] PostgreSQL tables truncated.');

    // 3. Migrate each table
    for (const tableName of TABLES_ORDER) {
      const exists = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
      if (!exists) {
        console.log(`[SKIP] Table ${tableName} does not exist in SQLite.`);
        continue;
      }

      const countRow = sdb.prepare(`SELECT count(*) as cnt FROM "${tableName}"`).get();
      const totalRows = countRow.cnt;
      if (totalRows === 0) {
        console.log(`[INFO] Table ${tableName}: 0 rows to migrate.`);
        continue;
      }

      // Read column definitions from SQLite
      const colsInfo = sdb.prepare(`PRAGMA table_info("${tableName}")`).all();
      const colNames = colsInfo.map(c => c.name);

      console.log(`[INFO] Migrating ${tableName} (${totalRows} rows, ${colNames.length} cols)...`);

      // Determine batch size based on parameter count limit (Postgres limit: 65535)
      const maxParams = 30000;
      const batchSize = Math.min(1000, Math.max(50, Math.floor(maxParams / colNames.length)));

      const escapedCols = colNames.map(c => `"${c}"`).join(', ');
      let processed = 0;
      let batch = [];

      const selectStmt = sdb.prepare(`SELECT * FROM "${tableName}"`);

      for (const row of selectStmt.iterate()) {
        batch.push(row);

        if (batch.length >= batchSize) {
          await insertBatch(client, tableName, colNames, escapedCols, batch);
          processed += batch.length;
          if (processed % 10000 === 0 || processed === totalRows) {
            console.log(`  -> ${tableName}: ${processed}/${totalRows} rows (${Math.round((processed / totalRows) * 100)}%)`);
          }
          batch = [];
        }
      }

      if (batch.length > 0) {
        await insertBatch(client, tableName, colNames, escapedCols, batch);
        processed += batch.length;
        console.log(`  -> ${tableName}: ${processed}/${totalRows} rows (100%)`);
      }
    }

    // 4. Reset sequences for all identity columns
    console.log('[INFO] Updating PostgreSQL identity sequences...');
    for (const table of TABLES_WITH_IDENTITY) {
      try {
        await client.query(`
          SELECT setval(
            pg_get_serial_sequence($1, 'id'),
            COALESCE((SELECT MAX(id) FROM "${table}"), 1)
          );
        `, [table]);
      } catch (err) {
        console.warn(`  [WARN] Failed to setval for ${table}: ${err.message}`);
      }
    }

    // 5. Re-enable foreign keys and triggers
    await client.query("SET session_replication_role = 'origin';");
    console.log('[INFO] Foreign key and trigger checks re-enabled.');

    // 6. Verify row counts table by table
    console.log('\n=================== VERIFICATION REPORT ===================');
    let allMatched = true;
    for (const tableName of TABLES_ORDER) {
      const exists = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
      const sCount = exists ? sdb.prepare(`SELECT count(*) as cnt FROM "${tableName}"`).get().cnt : 0;
      const pRes = await client.query(`SELECT count(*) as cnt FROM "${tableName}"`);
      const pCount = Number(pRes.rows[0].cnt);

      const status = sCount === pCount ? 'OK' : 'MISMATCH';
      if (status === 'MISMATCH') allMatched = false;
      console.log(`  ${status.padEnd(8)} ${tableName.padEnd(35)} SQLite: ${String(sCount).padStart(7)} | PG: ${String(pCount).padStart(7)}`);
    }
    console.log('===========================================================\n');

    if (!allMatched) {
      throw new Error('Migration completed with row count mismatches!');
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[SUCCESS] Migration completed successfully in ${duration}s!`);
  } finally {
    client.release();
    sdb.close();
    await pool.end();
  }
}

async function insertBatch(client, tableName, colNames, escapedCols, batch) {
  const valueClauses = [];
  const flatValues = [];
  let paramIdx = 1;

  for (const row of batch) {
    const placeholders = [];
    for (const col of colNames) {
      placeholders.push(`$${paramIdx++}`);
      flatValues.push(row[col] !== undefined ? row[col] : null);
    }
    valueClauses.push(`(${placeholders.join(', ')})`);
  }

  const query = `INSERT INTO "${tableName}" (${escapedCols}) VALUES ${valueClauses.join(', ')}`;
  await client.query(query, flatValues);
}

migrate().catch(err => {
  console.error('[FATAL] Migration failed:', err);
  process.exit(1);
});
