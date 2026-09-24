'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_RETENTION = 10;

/** Ordered list of known PostgreSQL tables */
const PG_TABLES_IN_ORDER = [
  'platforms',
  'users',
  'user_sessions',
  'api_keys',
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
  'post_comments',
  'monitoring_entities',
  'monitoring_items',
  'monitoring_jobs',
  'monitoring_entity_observations',
  'monitoring_limiter',
];

function getTimestamp(options = {}) {
  const d = options instanceof Date ? options : (options && options.date instanceof Date ? options.date : new Date());
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const base = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  if (options && (options.includeMs || options.withMs)) {
    return `${base}-${pad(d.getMilliseconds(), 3)}`;
  }
  return base;
}

function fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isCommandAvailable(cmd) {
  try {
    const res = child_process.spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 3000, shell: true });
    return res.status === 0;
  } catch (_e) {
    return false;
  }
}

function getPgConfig() {
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
  if (connectionString) {
    return {
      connectionString,
      ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
    };
  }
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'crawler',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'crawler_pod',
  };
}

function detectEngine(options = {}, repoRoot = path.join(__dirname, '..')) {
  if (options.engine) return options.engine.toLowerCase();
  if (process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || process.env.PGHOST || process.env.PGDATABASE) {
    return 'postgres';
  }
  if ((process.env.PG_MODE || '').toLowerCase() === 'pglite') {
    return 'postgres';
  }
  const sqliteDbPath = path.join(repoRoot, 'data', 'collector.db');
  if (fs.existsSync(sqliteDbPath)) {
    return 'sqlite';
  }
  return 'postgres';
}

function escapeSqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') {
    const jsonStr = JSON.stringify(value).replace(/'/g, "''");
    return `'${jsonStr}'`;
  }
  const str = String(value).replace(/'/g, "''");
  return `'${str}'`;
}

async function dumpPostgresViaClient(poolOrClient, destFilePath, schemaSqlPath) {
  const isDirectClient = Boolean(poolOrClient && typeof poolOrClient.query === 'function' && typeof poolOrClient.connect !== 'function');
  const client = isDirectClient ? poolOrClient : await poolOrClient.connect();
  const tableCounts = {};

  try {
    // 1. Discover all base tables in public schema
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    const existingTableNames = new Set((tablesRes.rows || []).map(r => r.table_name));

    // Order tables: prioritize known tables in order, then append remaining
    const orderedTables = [
      ...PG_TABLES_IN_ORDER.filter(t => existingTableNames.has(t)),
      ...[...existingTableNames].filter(t => !PG_TABLES_IN_ORDER.includes(t)),
    ];

    const lines = [];
    lines.push('-- ============================================================================');
    lines.push('-- Crawler-POD PostgreSQL Database Dump');
    lines.push(`-- Generated: ${new Date().toISOString()}`);
    lines.push('-- Engine: PostgreSQL (pg client fallback)');
    lines.push('-- ============================================================================');
    lines.push('BEGIN;');
    lines.push('DO $$ BEGIN SET session_replication_role = \'replica\'; EXCEPTION WHEN OTHERS THEN NULL; END $$;');
    lines.push('');

    // Optional schema inclusion
    if (schemaSqlPath && fs.existsSync(schemaSqlPath)) {
      lines.push('-- --- Schema DDL ---');
      lines.push(fs.readFileSync(schemaSqlPath, 'utf8'));
      lines.push('');
    }

    // Truncate tables cleanly
    if (orderedTables.length > 0) {
      lines.push('-- --- Truncate Existing Tables ---');
      const truncateList = [...orderedTables].reverse().map(t => `"${t}"`).join(', ');
      lines.push(`TRUNCATE TABLE ${truncateList} CASCADE;`);
      lines.push('');
    }

    // Dump data for each table
    for (const tableName of orderedTables) {
      const rowsRes = await client.query(`SELECT * FROM "${tableName}"`);
      const rows = rowsRes.rows || [];
      tableCounts[tableName] = rows.length;

      if (rows.length === 0) continue;

      lines.push(`-- Data for table: "${tableName}" (${rows.length} rows)`);
      const columns = Object.keys(rows[0]);
      const colList = columns.map(c => `"${c}"`).join(', ');

      const batchSize = 200;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const valueTuples = batch.map(row => {
          const vals = columns.map(col => escapeSqlValue(row[col]));
          return `(${vals.join(', ')})`;
        });
        lines.push(`INSERT INTO "${tableName}" (${colList}) VALUES\n  ${valueTuples.join(',\n  ')};`);
      }
      lines.push('');
    }

    // Sequence reset block
    lines.push('-- --- Reset Identity Sequences ---');
    lines.push(`DO $$
DECLARE
  r RECORD;
  seq TEXT;
BEGIN
  FOR r IN (SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id') LOOP
    seq := pg_get_serial_sequence(r.table_name, 'id');
    IF seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(id) FROM %I), 1), (SELECT MAX(id) IS NOT NULL FROM %I))', seq, r.table_name, r.table_name);
    END IF;
  END LOOP;
END $$;`);
    lines.push('');
    lines.push('DO $$ BEGIN SET session_replication_role = \'origin\'; EXCEPTION WHEN OTHERS THEN NULL; END $$;');
    lines.push('COMMIT;');

    fs.writeFileSync(destFilePath, lines.join('\n'), 'utf8');
    return { success: true, tableCounts, totalRows: Object.values(tableCounts).reduce((a, b) => a + b, 0) };
  } finally {
    if (!isDirectClient && client && typeof client.release === 'function') {
      client.release();
    }
  }
}

function dumpViaPgDump(pgConfig, destFilePath) {
  const args = ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--inserts', '--file', destFilePath];
  const env = { ...process.env };
  if (pgConfig.connectionString) {
    args.push(`--dbname=${pgConfig.connectionString}`);
  } else {
    args.push('-h', pgConfig.host, '-p', String(pgConfig.port), '-U', pgConfig.user, '-d', pgConfig.database);
    if (pgConfig.password) env.PGPASSWORD = pgConfig.password;
  }

  const res = child_process.spawnSync('pg_dump', args, { env, stdio: 'pipe', encoding: 'utf8' });
  if (res.status !== 0 || !fs.existsSync(destFilePath) || fs.statSync(destFilePath).size === 0) {
    throw new Error(`pg_dump failed with exit code ${res.status}: ${res.stderr || res.stdout}`);
  }
  return true;
}

function pruneBackups(backupRootDir, retentionCount = DEFAULT_RETENTION, isDryRun = false) {
  if (!fs.existsSync(backupRootDir)) return [];

  // Parse retention count safely, preserving explicit 0 and handling null/string/negative values
  let count = DEFAULT_RETENTION;
  if (retentionCount !== undefined && retentionCount !== null) {
    const num = Number(retentionCount);
    if (!Number.isNaN(num)) {
      count = Math.max(0, Math.floor(num));
    }
  }

  const entries = fs.readdirSync(backupRootDir)
    .filter(d => fs.existsSync(path.join(backupRootDir, d, 'manifest.json')))
    .sort();

  if (entries.length <= count) return [];

  const excessCount = entries.length - count;
  const toPrune = entries.slice(0, excessCount);

  for (const backupId of toPrune) {
    const targetDir = path.join(backupRootDir, backupId);
    if (!isDryRun) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      console.log(`[Backup] Pruned old backup exceeding retention (${count}): ${backupId}`);
    } else {
      console.log(`[Dry-run] Would prune old backup: ${backupId}`);
    }
  }
  return toPrune;
}

async function getPgClientOrPool(options = {}) {
  if (options.pool || options.client) {
    return { client: options.pool || options.client, isCustom: true };
  }
  if ((process.env.PG_MODE || '').toLowerCase() === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = options.pgliteDir || process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pgdata');
    const pglite = new PGlite(dir);
    return { client: pglite, isPglite: true };
  }
  const pgConfig = getPgConfig();
  const pool = new Pool(pgConfig);
  return { client: pool, isPool: true };
}

async function closePgClientOrPool(handle) {
  if (!handle || handle.isCustom) return;
  if (handle.isPglite && handle.client && typeof handle.client.close === 'function') {
    await handle.client.close().catch(() => {});
  } else if (handle.isPool && handle.client && typeof handle.client.end === 'function') {
    await handle.client.end().catch(() => {});
  }
}

async function createBackup(filesToBackup = [], reason = 'Pre-change backup', phaseId = 'UNKNOWN', options = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const backupRootDir = options.backupDir || path.join(repoRoot, '.backup');
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');

  // Parse retention count: prioritize options.retention (preserving explicit 0), then env var, then DEFAULT_RETENTION
  let retention = DEFAULT_RETENTION;
  if (options.retention !== undefined && options.retention !== null) {
    const optRetention = Number(options.retention);
    if (!Number.isNaN(optRetention)) {
      retention = Math.max(0, Math.floor(optRetention));
    }
  } else if (process.env.BACKUP_RETENTION_COUNT !== undefined && process.env.BACKUP_RETENTION_COUNT !== '') {
    const envRetention = Number(process.env.BACKUP_RETENTION_COUNT);
    if (!Number.isNaN(envRetention)) {
      retention = Math.max(0, Math.floor(envRetention));
    }
  }

  const engine = detectEngine(options, repoRoot);

  // Generate unique timestamp and backupDir to prevent accidental directory clobbering
  const baseTimestamp = options.timestamp || getTimestamp({ includeMs: Boolean(options.includeMs) });
  let timestamp = baseTimestamp;
  let backupDir = path.join(backupRootDir, timestamp);

  // If target directory already exists, append unique counter suffix (_1, _2, ...) to prevent collision/clobbering
  if (fs.existsSync(backupDir)) {
    let counter = 1;
    while (fs.existsSync(path.join(backupRootDir, `${baseTimestamp}_${counter}`))) {
      counter++;
    }
    timestamp = `${baseTimestamp}_${counter}`;
    backupDir = path.join(backupRootDir, timestamp);
  }

  let dumpMechanism = null;
  let tableCounts = {};
  let totalRows = 0;

  // DRY-RUN Mode handling
  if (isDryRun) {
    console.log('[Backup] [DRY RUN] Simulating backup creation:');
    console.log(`   Engine: ${engine}`);
    console.log(`   Phase ID: ${phaseId}`);
    console.log(`   Reason: ${reason}`);
    console.log(`   Planned Directory: ${backupDir}`);

    const wouldPrune = pruneBackups(backupRootDir, retention, true);

    return {
      isDryRun: true,
      timestamp,
      phaseId,
      reason,
      engine,
      plannedBackupDir: backupDir,
      filesToBackup,
      retention,
      wouldPrune,
    };
  }

  // Create target backup directory
  fs.mkdirSync(backupDir, { recursive: true });

  const manifest = {
    manifestVersion: 2,
    timestamp,
    phaseId,
    reason,
    engine,
    retention,
    dumpMechanism: null,
    files: [],
    tables: {},
    totalRows: 0,
    retentionPruned: [],
    verified: false,
  };

  // Engine: PostgreSQL
  if (engine === 'postgres') {
    const pgConfig = getPgConfig();
    const dumpFile = path.join(backupDir, 'database_dump.sql');
    const schemaPath = path.join(repoRoot, 'src', 'database', 'pg-schema.sql');

    if (!options.client && !options.pool && isCommandAvailable('pg_dump')) {
      try {
        dumpViaPgDump(pgConfig, dumpFile);
        dumpMechanism = 'pg_dump';
      } catch (dumpErr) {
        console.warn(`[Backup] pg_dump failed (${dumpErr.message}), falling back to pg client dump...`);
      }
    }

    if (!dumpMechanism) {
      let handle = null;
      try {
        handle = await getPgClientOrPool(options);
        const dumpRes = await dumpPostgresViaClient(handle.client, dumpFile, schemaPath);
        dumpMechanism = 'pg_client_fallback';
        tableCounts = dumpRes.tableCounts;
        totalRows = dumpRes.totalRows;
      } finally {
        if (handle) await closePgClientOrPool(handle);
      }
    }

    manifest.dumpMechanism = dumpMechanism;
    manifest.tables = tableCounts;
    manifest.totalRows = totalRows;

    const dumpHash = fileHash(dumpFile);
    manifest.files.push({
      original: 'database_dump.sql',
      backup: path.relative(repoRoot, dumpFile).replace(/\\/g, '/'),
      sha256: dumpHash,
      size: fs.existsSync(dumpFile) ? fs.statSync(dumpFile).size : 0,
      verified: Boolean(dumpHash),
      hashMatches: true,
    });
  }

  // Engine: SQLite
  if (engine === 'sqlite') {
    const dbPath = path.join(repoRoot, 'data', 'collector.db');
    if (fs.existsSync(dbPath)) {
      try {
        const Database = require('better-sqlite3');
        const db = new Database(dbPath);
        try {
          db.pragma('wal_checkpoint(TRUNCATE)');
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
          for (const t of tables) {
            const cnt = db.prepare(`SELECT count(*) as c FROM "${t.name}"`).get();
            tableCounts[t.name] = cnt.c;
            totalRows += cnt.c;
          }
        } finally {
          db.close();
        }
      } catch (err) {
        console.warn('[Backup] SQLite checkpoint error:', err.message);
      }

      const destDb = path.join(backupDir, 'data', 'collector.db');
      fs.mkdirSync(path.dirname(destDb), { recursive: true });
      fs.copyFileSync(dbPath, destDb);

      const srcHash = fileHash(dbPath);
      const destHash = fileHash(destDb);
      manifest.files.push({
        original: 'data/collector.db',
        backup: path.relative(repoRoot, destDb).replace(/\\/g, '/'),
        sha256: destHash,
        size: fs.statSync(destDb).size,
        verified: srcHash === destHash,
        hashMatches: srcHash === destHash,
      });
      manifest.tables = tableCounts;
      manifest.totalRows = totalRows;
      manifest.dumpMechanism = 'sqlite_copy';
    }
  }

  // Backup any additional specified files
  for (const relPath of filesToBackup) {
    if (relPath.includes('collector.db') && engine === 'sqlite') continue;
    const src = path.join(repoRoot, relPath);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(backupDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);

    const sHash = fileHash(src);
    const dHash = fileHash(dest);
    manifest.files.push({
      original: relPath.replace(/\\/g, '/'),
      backup: path.relative(repoRoot, dest).replace(/\\/g, '/'),
      sha256: dHash,
      size: fs.statSync(dest).size,
      verified: sHash === dHash,
      hashMatches: sHash === dHash,
    });
  }

  // Check retention and prune older backups
  const pruned = pruneBackups(backupRootDir, retention, false);
  manifest.retentionPruned = pruned;

  const allVerified = manifest.files.length > 0 && manifest.files.every(f => f.verified);
  manifest.verified = allVerified;

  const manifestPath = path.join(backupDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[Backup] Created backup at .backup/${timestamp} (Engine: ${engine}, files: ${manifest.files.length}, verified: ${allVerified})`);
  return { backupDir, manifestPath, timestamp, engine, verified: allVerified, manifest, retention };
}

module.exports = {
  createBackup,
  getTimestamp,
  fileHash,
  detectEngine,
  pruneBackups,
  dumpPostgresViaClient,
  dumpViaPgDump,
  isCommandAvailable,
  getPgConfig,
  escapeSqlValue,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const isDry = args.includes('--dry-run');
  let reason = 'Manual backup';
  let phaseId = 'CLI_INVOKE';
  let retention = DEFAULT_RETENTION;
  const files = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') continue;
    if (args[i] === '--reason' && args[i + 1]) {
      reason = args[++i];
    } else if (args[i] === '--phase' && args[i + 1]) {
      phaseId = args[++i];
    } else if (args[i] === '--retention' && args[i + 1] !== undefined) {
      const parsed = Number(args[++i]);
      if (!Number.isNaN(parsed)) {
        retention = Math.max(0, Math.floor(parsed));
      }
    } else if (!args[i].startsWith('--')) {
      files.push(args[i]);
    }
  }

  createBackup(files, reason, phaseId, { dryRun: isDry, retention })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[Backup Error]:', err);
      process.exit(1);
    });
}
