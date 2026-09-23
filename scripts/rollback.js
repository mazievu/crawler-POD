'use strict';

/**
 * Rollback Utility — Safe, tamper-verified database restoration
 * Usage: node scripts/rollback.js [BACKUP_ID] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

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

function listBackups(repoRoot = path.join(__dirname, '..'), customBackupDir = null) {
  const backupDir = customBackupDir || path.join(repoRoot, '.backup');
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter(d => fs.existsSync(path.join(backupDir, d, 'manifest.json')))
    .sort();
}

/**
 * Verifies that a target path is strictly contained within a base directory.
 * Prevents directory traversal, escaping, and sibling prefix attacks (e.g. /dir vs /dir-evil).
 *
 * @param {string} baseDir Base directory that must contain the target
 * @param {string} targetPath File or subdirectory path to test
 * @returns {boolean} True if targetPath is strictly inside baseDir
 */
function isPathContainedWithin(baseDir, targetPath) {
  if (!baseDir || !targetPath) return false;
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedBase, resolvedTarget);

  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../') || rel.startsWith('..\\') || path.isAbsolute(rel)) {
    return false;
  }

  const sep = path.sep;
  const basePrefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;

  if (process.platform === 'win32') {
    return resolvedTarget.toLowerCase().startsWith(basePrefix.toLowerCase());
  }
  return resolvedTarget.startsWith(basePrefix);
}

/**
 * Validates that an untrusted relative path is strictly confined within basePath.
 * Rejects null bytes, Windows drive letters, UNC paths, root-relative/absolute paths, and directory traversal.
 *
 * @param {string} basePath Base directory root (e.g., repoRoot)
 * @param {string} untrustedPath Potentially malicious path from untrusted input/manifest
 * @returns {boolean} True if safely confined within basePath
 */
function isPathConfined(basePath, untrustedPath) {
  if (typeof untrustedPath !== 'string' || !untrustedPath.trim()) return false;
  if (untrustedPath.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(untrustedPath)) return false;
  if (/^(\\\\|\/\/)/.test(untrustedPath)) return false;
  if (path.isAbsolute(untrustedPath) || /^[\/\\]/.test(untrustedPath)) return false;
  if (untrustedPath.includes('..')) return false;

  const normalized = path.normalize(untrustedPath);
  if (normalized.startsWith('..') || normalized.split(/[/\\]/).includes('..')) {
    return false;
  }

  return isPathContainedWithin(basePath, path.resolve(basePath, untrustedPath));
}

function verifyBackupIntegrity(manifest, repoRoot, options = {}) {
  const errors = [];
  if (!manifest || !Array.isArray(manifest.files)) {
    return { valid: false, errors: ['Invalid manifest: missing files list'] };
  }

  // Resolve designated backup directory (.backup/<timestamp>/)
  let designatedBackupDir = null;
  if (typeof options === 'string') {
    designatedBackupDir = path.resolve(options);
  } else if (options && options.backupDir) {
    const optDir = path.resolve(options.backupDir);
    if (manifest.timestamp && !optDir.endsWith(manifest.timestamp) && fs.existsSync(path.join(optDir, manifest.timestamp))) {
      designatedBackupDir = path.join(optDir, manifest.timestamp);
    } else {
      designatedBackupDir = optDir;
    }
  } else if (manifest.timestamp && typeof manifest.timestamp === 'string' && /^[a-zA-Z0-9_-]+$/.test(manifest.timestamp.trim())) {
    designatedBackupDir = path.resolve(repoRoot, '.backup', manifest.timestamp.trim());
  } else {
    designatedBackupDir = path.resolve(repoRoot, '.backup');
  }

  // Validate manifest timestamp if present
  if (manifest.timestamp && (
    typeof manifest.timestamp !== 'string' ||
    manifest.timestamp.includes('..') ||
    manifest.timestamp.includes('/') ||
    manifest.timestamp.includes('\\') ||
    manifest.timestamp.includes('\0')
  )) {
    errors.push(`Unsafe manifest timestamp: ${manifest.timestamp}`);
  }

  for (const f of manifest.files) {
    if (!f || typeof f.original !== 'string' || typeof f.backup !== 'string') {
      errors.push('Invalid file entry in manifest: missing original or backup property');
      continue;
    }

    // 1. Validate f.original: Must be strictly confined inside repoRoot
    if (!isPathConfined(repoRoot, f.original)) {
      errors.push(`Unsafe path traversal detected in original file path: ${f.original}`);
      continue;
    }

    // 2. Validate f.backup: Must be strictly confined inside repoRoot
    if (!isPathConfined(repoRoot, f.backup)) {
      errors.push(`Unsafe path traversal detected in backup file path: ${f.backup}`);
      continue;
    }

    // 3. Validate f.backup: Must reside strictly inside designatedBackupDir (.backup/<timestamp>/)
    const resolvedBackupFile = path.resolve(repoRoot, f.backup);
    if (!isPathContainedWithin(designatedBackupDir, resolvedBackupFile)) {
      errors.push(`Unsafe path traversal detected in backup file path (outside designated backup directory): ${f.backup}`);
      continue;
    }

    // 4. File existence check
    if (!fs.existsSync(resolvedBackupFile)) {
      errors.push(`Missing backup file: ${f.backup}`);
      continue;
    }

    // 5. SHA-256 integrity hash verification
    const currentHash = fileHash(resolvedBackupFile);
    if (f.sha256 && currentHash !== f.sha256) {
      errors.push(`SHA-256 hash mismatch for ${f.backup} (expected: ${f.sha256}, actual: ${currentHash})`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function restorePostgresViaClient(poolOrClient, dumpFilePath) {
  const isDirectClient = Boolean(poolOrClient && typeof poolOrClient.query === 'function' && typeof poolOrClient.connect !== 'function');
  const client = isDirectClient ? poolOrClient : await poolOrClient.connect();

  try {
    const sql = fs.readFileSync(dumpFilePath, 'utf8');
    await client.query('BEGIN;');
    try {
      await client.query("SET session_replication_role = 'replica';");
    } catch (_e) {
      // Permission bypass for non-superuser
    }
    await client.query(sql);
    try {
      await client.query("SET session_replication_role = 'origin';");
    } catch (_e) {
      // Permission bypass for non-superuser
    }
    await client.query('COMMIT;');
    return true;
  } catch (err) {
    await client.query('ROLLBACK;').catch(() => {});
    throw err;
  } finally {
    if (!isDirectClient && client && typeof client.release === 'function') {
      client.release();
    }
  }
}

function restoreViaPsql(pgConfig, dumpFilePath) {
  const args = ['-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', dumpFilePath];
  const env = { ...process.env };
  if (pgConfig.connectionString) {
    args.push(`--dbname=${pgConfig.connectionString}`);
  } else {
    args.push('-h', pgConfig.host, '-p', String(pgConfig.port), '-U', pgConfig.user, '-d', pgConfig.database);
    if (pgConfig.password) env.PGPASSWORD = pgConfig.password;
  }

  const res = child_process.spawnSync('psql', args, { env, stdio: 'pipe', encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`psql restore failed with exit code ${res.status}: ${res.stderr || res.stdout}`);
  }
  return true;
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

async function performRollback(targetBackupId, options = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const backupRootDir = options.backupDir || path.join(repoRoot, '.backup');
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');

  // Defend against directory traversal in targetBackupId (e.g. "../../evil")
  if (targetBackupId && (
    typeof targetBackupId !== 'string' ||
    !targetBackupId.trim() ||
    targetBackupId.includes('\0') ||
    /^[a-zA-Z]:/.test(targetBackupId) ||
    /^(\\\\|\/\/)/.test(targetBackupId) ||
    path.isAbsolute(targetBackupId) ||
    /^[\/\\]/.test(targetBackupId) ||
    targetBackupId.includes('..') ||
    !isPathConfined(backupRootDir, targetBackupId)
  )) {
    console.error(`[Rollback] Invalid targetBackupId containing traversal or invalid characters: ${targetBackupId}`);
    return { success: false, error: 'INVALID_BACKUP_ID' };
  }

  const available = listBackups(repoRoot, backupRootDir);
  if (!available.length) {
    console.error('[Rollback] No backups found in .backup/');
    return { success: false, error: 'NO_BACKUPS_FOUND' };
  }

  let backupId = targetBackupId;
  if (!backupId || backupId === 'latest') {
    backupId = available[available.length - 1];
  } else if (backupId === 'baseline') {
    backupId = available[0];
  }

  const selectedBackupDir = path.join(backupRootDir, backupId);
  const manifestPath = path.join(selectedBackupDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.error(`[Rollback] Manifest not found for backup: ${backupId}`);
    return { success: false, error: 'MANIFEST_NOT_FOUND', available };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  console.log('\n======================================================');
  console.log(`[Rollback] ${isDryRun ? 'DRY-RUN INSPECTION' : 'RESTORATION IN PROGRESS'}: ${backupId}`);
  console.log(`   Engine: ${manifest.engine || 'sqlite'}`);
  console.log(`   Phase ID: ${manifest.phaseId}`);
  console.log(`   Reason: ${manifest.reason}`);
  console.log(`   Files to restore: ${manifest.files.length}`);
  console.log('======================================================\n');

  // PRE-FLIGHT VERIFICATION: Check ALL file hashes before touching live files or DB
  const integrity = verifyBackupIntegrity(manifest, repoRoot, { backupDir: selectedBackupDir });
  if (!integrity.valid) {
    const errorMsg = `[Rollback] PRE-FLIGHT INTEGRITY CHECK FAILED — Tampered or corrupted backup detected!\n` +
      integrity.errors.map(e => `   * ${e}`).join('\n');
    console.error(errorMsg);
    if (options.throwOnError) throw new Error(errorMsg);
    return { success: false, error: 'TAMPER_DETECTED', details: integrity.errors };
  }
  console.log(`[Rollback] Pre-flight SHA-256 integrity verified for all ${manifest.files.length} file(s).`);

  // DRY-RUN EXIT: Print plan and stop
  if (isDryRun) {
    console.log('[Rollback] [DRY RUN] Verification passed. Restoration plan:');
    for (const f of manifest.files) {
      console.log(`   - Would restore ${f.original} from ${f.backup} (${f.size} bytes)`);
    }
    if (manifest.tables) {
      console.log('   - Database tables to restore:', Object.keys(manifest.tables).join(', '));
    }
    return { success: true, isDryRun: true, backupId, manifest };
  }

  // RESTORATION EXECUTION
  const restoredFiles = [];
  const engine = manifest.engine || (manifest.files.some(f => f.original.includes('collector.db')) ? 'sqlite' : 'postgres');

  // Restore PostgreSQL database
  if (engine === 'postgres') {
    const dumpEntry = manifest.files.find(f => f.original === 'database_dump.sql');
    if (dumpEntry) {
      if (!isPathConfined(repoRoot, dumpEntry.original) || !isPathConfined(repoRoot, dumpEntry.backup) || !isPathContainedWithin(selectedBackupDir, path.resolve(repoRoot, dumpEntry.backup))) {
        throw new Error(`[Rollback] Refusing to restore from unsafe dump path: ${dumpEntry.backup}`);
      }
      const dumpFilePath = path.join(repoRoot, dumpEntry.backup);
      const pgConfig = getPgConfig();

      let restoredVia = null;
      if (!options.client && !options.pool && isCommandAvailable('psql')) {
        try {
          restoreViaPsql(pgConfig, dumpFilePath);
          restoredVia = 'psql';
        } catch (err) {
          console.warn(`[Rollback] psql execution failed (${err.message}), falling back to pg client restore...`);
        }
      }

      if (!restoredVia) {
        let handle = null;
        try {
          handle = await getPgClientOrPool(options);
          await restorePostgresViaClient(handle.client, dumpFilePath);
          restoredVia = 'pg_client';
        } finally {
          if (handle) await closePgClientOrPool(handle);
        }
      }

      console.log(`[Rollback] PostgreSQL database restored successfully via ${restoredVia}.`);
      restoredFiles.push('database_dump.sql');
    }
  }

  // Restore SQLite database
  if (engine === 'sqlite') {
    const dbEntry = manifest.files.find(f => f.original.includes('collector.db'));
    if (dbEntry) {
      if (!isPathConfined(repoRoot, dbEntry.original)) {
        throw new Error(`[Rollback] Refusing to restore SQLite with unsafe destination: ${dbEntry.original}`);
      }
      if (!isPathConfined(repoRoot, dbEntry.backup) || !isPathContainedWithin(selectedBackupDir, path.resolve(repoRoot, dbEntry.backup))) {
        throw new Error(`[Rollback] Refusing to restore SQLite from unsafe backup path: ${dbEntry.backup}`);
      }
      const backupDbPath = path.join(repoRoot, dbEntry.backup);
      const destDbPath = path.join(repoRoot, dbEntry.original);

      // Truncate existing WAL if present
      if (fs.existsSync(destDbPath)) {
        try {
          const Database = require('better-sqlite3');
          const liveDb = new Database(destDbPath);
          liveDb.pragma('wal_checkpoint(TRUNCATE)');
          liveDb.close();
        } catch (_e) {
          // Ignore if live db is locked or unavailable
        }
      }

      fs.mkdirSync(path.dirname(destDbPath), { recursive: true });
      fs.copyFileSync(backupDbPath, destDbPath);

      // Verify SQLite integrity after copy
      const Database = require('better-sqlite3');
      const restoredDb = new Database(destDbPath, { readonly: true });
      const check = restoredDb.pragma('integrity_check');
      restoredDb.close();
      if (!Array.isArray(check) || check.length === 0 || check[0].integrity_check !== 'ok') {
        throw new Error('[Rollback] SQLite database integrity_check failed after restore!');
      }
      console.log(`[Rollback] SQLite database restored and integrity verified: ${dbEntry.original}`);
      restoredFiles.push(dbEntry.original);
    }
  }

  // Restore other files
  for (const f of manifest.files) {
    if (f.original === 'database_dump.sql' || f.original.includes('collector.db')) continue;

    if (!isPathConfined(repoRoot, f.original)) {
      throw new Error(`[Rollback] Refusing to restore file outside repository root: ${f.original}`);
    }
    if (!isPathConfined(repoRoot, f.backup) || !isPathContainedWithin(selectedBackupDir, path.resolve(repoRoot, f.backup))) {
      throw new Error(`[Rollback] Refusing to read backup file outside designated backup directory: ${f.backup}`);
    }

    const backupFilePath = path.join(repoRoot, f.backup);
    const destFilePath = path.join(repoRoot, f.original);

    fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
    fs.copyFileSync(backupFilePath, destFilePath);
    console.log(`[Rollback] Restored file: ${f.original}`);
    restoredFiles.push(f.original);
  }

  console.log(`\n[Rollback] Restoration completed successfully (${restoredFiles.length}/${manifest.files.length} items restored).\n`);
  return { success: true, backupId, restoredFiles, manifest };
}

module.exports = {
  performRollback,
  listBackups,
  verifyBackupIntegrity,
  restorePostgresViaClient,
  restoreViaPsql,
  fileHash,
  getPgConfig,
  isPathConfined,
  isPathContainedWithin,
  isSafeRelativePath: isPathConfined,
};

if (require.main === module) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const isDry = process.argv.includes('--dry-run');
  performRollback(args[0] || 'latest', { dryRun: isDry })
    .then(res => process.exit(res.success ? 0 : 1))
    .catch(err => {
      console.error('[Rollback Fatal]:', err);
      process.exit(1);
    });
}
