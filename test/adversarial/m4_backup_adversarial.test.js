'use strict';

/**
 * test/adversarial/m4_backup_adversarial.test.js
 * Adversarial Stress & Empirical Verification Suite for Milestone M4 (Backup & Rollback Subsystem)
 *
 * Attack Vectors Challenged:
 * 1. Tamper Verification: 1-byte file corruption, missing file, altered SHA-256 in manifest, atomic multi-file check.
 * 2. Path Traversal & Injection: malicious paths in manifest.json (e.g. ../../etc/passwd), targetBackupId traversal, SQL injection in dumps.
 * 3. Boundary Fidelity: zero-row table dump/restore, special character escaping in table dumps, dry-run zero disk write assertions.
 * 4. Retention Pruning Boundaries: pruning edge cases (retention count 0, retention count larger than available backups, identical timestamps).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  createBackup,
  pruneBackups,
  detectEngine,
  dumpPostgresViaClient,
  escapeSqlValue,
  getTimestamp,
} = require('../../scripts/backup-manager');

const {
  performRollback,
  listBackups,
  verifyBackupIntegrity,
  restorePostgresViaClient,
  fileHash,
} = require('../../scripts/rollback');

function createTempDir(prefix = 'm4-adv-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Milestone M4: Backup & Rollback Adversarial Challenge Suite', async (t) => {

  // ==========================================================================
  // VECTOR 1: TAMPER VERIFICATION & PRE-FLIGHT INTEGRITY
  // ==========================================================================

  await t.test('ADV-M4-1.1: 1-byte file corruption in backup aborts rollback with TAMPER_DETECTED (zero live files touched)', async () => {
    const tmpRoot = createTempDir('m4-tamper-1byte-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    const liveFile = path.join(tmpRoot, 'service-config.json');
    const originalContent = JSON.stringify({ cluster: 'production-east', maxWorkers: 16 });
    fs.writeFileSync(liveFile, originalContent, 'utf8');

    // 1. Create verified backup
    const backupRes = await createBackup(['service-config.json'], 'Pre-tamper drill', 'TAMPER_1BYTE', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
    });
    assert.strictEqual(backupRes.verified, true, 'Backup must initially be verified');

    // 2. Modify live file to simulate later state
    const modifiedLiveContent = JSON.stringify({ cluster: 'production-east', maxWorkers: 32, liveState: 'modified' });
    fs.writeFileSync(liveFile, modifiedLiveContent, 'utf8');
    const liveMtimeBefore = fs.statSync(liveFile).mtimeMs;

    // 3. Corrupt exactly 1 byte in the backup file
    const backupEntry = backupRes.manifest.files.find(f => f.original === 'service-config.json');
    const backedUpPath = path.join(tmpRoot, backupEntry.backup);
    const backupBuffer = fs.readFileSync(backedUpPath);
    // Flip 1 bit of the first byte
    backupBuffer[0] ^= 0x01;
    fs.writeFileSync(backedUpPath, backupBuffer);

    // 4. Attempt rollback
    const rollbackRes = await performRollback(backupRes.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
    });

    // 5. Assertions: Rollback MUST abort with TAMPER_DETECTED
    assert.strictEqual(rollbackRes.success, false, 'Rollback must fail when backup file is corrupted');
    assert.strictEqual(rollbackRes.error, 'TAMPER_DETECTED', 'Error code must be TAMPER_DETECTED');
    assert.ok(rollbackRes.details.some(d => d.includes('SHA-256 hash mismatch')), 'Details must cite SHA-256 mismatch');

    // 6. Live file invariant: MUST NOT be modified or reverted
    assert.strictEqual(fs.readFileSync(liveFile, 'utf8'), modifiedLiveContent, 'Live file must remain untouched');
    assert.strictEqual(fs.statSync(liveFile).mtimeMs, liveMtimeBefore, 'Live file mtime must remain unchanged');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('ADV-M4-1.2: Missing file in backup directory triggers pre-flight abort with TAMPER_DETECTED (zero live files touched)', async () => {
    const tmpRoot = createTempDir('m4-tamper-missing-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    const liveFile = path.join(tmpRoot, 'ml-model.bin');
    fs.writeFileSync(liveFile, Buffer.from('MODEL_WEIGHTS_V1_BINARY_DATA'), 'binary');

    const backupRes = await createBackup(['ml-model.bin'], 'Pre-delete backup', 'MISSING_FILE', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
    });

    // Modify live file
    fs.writeFileSync(liveFile, Buffer.from('MODEL_WEIGHTS_V2_NEW_LIVE_DATA'), 'binary');

    // Delete the backup file on disk
    const backupEntry = backupRes.manifest.files.find(f => f.original === 'ml-model.bin');
    fs.rmSync(path.join(tmpRoot, backupEntry.backup));

    // Attempt rollback
    const rollbackRes = await performRollback(backupRes.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
    });

    assert.strictEqual(rollbackRes.success, false, 'Rollback must fail when backup file is missing');
    assert.strictEqual(rollbackRes.error, 'TAMPER_DETECTED');
    assert.ok(rollbackRes.details.some(d => d.includes('Missing backup file')));
    assert.strictEqual(fs.readFileSync(liveFile, 'utf8'), 'MODEL_WEIGHTS_V2_NEW_LIVE_DATA', 'Live file must remain untouched');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('ADV-M4-1.3: Forged / tampered SHA-256 in manifest.json triggers pre-flight abort (zero live files touched)', async () => {
    const tmpRoot = createTempDir('m4-tamper-manifest-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    const liveFile = path.join(tmpRoot, 'secrets.env');
    fs.writeFileSync(liveFile, 'API_KEY=live_prod_key_12345\n', 'utf8');

    const backupRes = await createBackup(['secrets.env'], 'Manifest tamper drill', 'MANIFEST_FORGERY', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
    });

    // Forge the SHA-256 hash in manifest.json to an attacker-controlled hash
    const manifestPath = backupRes.manifestPath;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = manifest.files.find(f => f.original === 'secrets.env');
    entry.sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // empty string sha256
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    // Modify live file
    fs.writeFileSync(liveFile, 'API_KEY=modified_uncommitted_live_key\n', 'utf8');

    // Attempt rollback
    const rollbackRes = await performRollback(backupRes.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
    });

    assert.strictEqual(rollbackRes.success, false, 'Rollback must fail when manifest hash is forged');
    assert.strictEqual(rollbackRes.error, 'TAMPER_DETECTED');
    assert.ok(rollbackRes.details.some(d => d.includes('SHA-256 hash mismatch')));
    assert.strictEqual(fs.readFileSync(liveFile, 'utf8'), 'API_KEY=modified_uncommitted_live_key\n');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('ADV-M4-1.4: Multi-file atomic verification: corruption in file 3 aborts BEFORE file 1 or 2 are restored', async () => {
    const tmpRoot = createTempDir('m4-atomic-preflight-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    const files = ['module_a.js', 'module_b.js', 'module_c.js'];
    for (const f of files) {
      fs.writeFileSync(path.join(tmpRoot, f), `// Original ${f}`, 'utf8');
    }

    const backupRes = await createBackup(files, 'Multi-file atomic drill', 'ATOMIC_MULTI', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
    });

    // Mutate all live files
    for (const f of files) {
      fs.writeFileSync(path.join(tmpRoot, f), `// LIVE_CHANGED ${f}`, 'utf8');
    }

    // Corrupt ONLY module_c.js in the backup folder
    const entryC = backupRes.manifest.files.find(item => item.original === 'module_c.js');
    const backedUpC = path.join(tmpRoot, entryC.backup);
    fs.appendFileSync(backedUpC, '\n// CORRUPTED_BYTE', 'utf8');

    // Attempt rollback
    const rollbackRes = await performRollback(backupRes.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
    });

    assert.strictEqual(rollbackRes.success, false);
    assert.strictEqual(rollbackRes.error, 'TAMPER_DETECTED');

    // Invariant: ZERO live files modified — module_a and module_b MUST NOT be restored partially!
    for (const f of files) {
      const current = fs.readFileSync(path.join(tmpRoot, f), 'utf8');
      assert.strictEqual(current, `// LIVE_CHANGED ${f}`, `Live file ${f} must not be touched due to partial restore`);
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ==========================================================================
  // VECTOR 2: PATH TRAVERSAL & INJECTION DEFENSES
  // ==========================================================================

  await t.test('ADV-M4-2.1: Manifest path traversal in f.original (e.g. ../../etc/passwd) must be rejected by pre-flight validation', async () => {
    const parentContainer = createTempDir('m4-trav-parent-');
    const tmpRepo = path.join(parentContainer, 'repo');
    const outsideVictim = path.join(parentContainer, 'escaped_victim.txt');
    fs.mkdirSync(tmpRepo, { recursive: true });

    // Initial safe file inside repo
    const safeFile = path.join(tmpRepo, 'service.txt');
    fs.writeFileSync(safeFile, 'Safe Service Content', 'utf8');

    const backupRes = await createBackup(['service.txt'], 'Traversal drill', 'PATH_TRAV_1', {
      repoRoot: tmpRepo,
      engine: 'sqlite',
    });

    // Adversarially forge manifest: point original OUTSIDE repoRoot using ../../
    const manifest = JSON.parse(fs.readFileSync(backupRes.manifestPath, 'utf8'));
    const entry = manifest.files.find(f => f.original === 'service.txt');
    entry.original = '../../escaped_victim.txt';
    fs.writeFileSync(backupRes.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    // Test Pre-flight integrity check
    const integrity = verifyBackupIntegrity(manifest, tmpRepo);

    // CHALLENGE ASSERTION: Pre-flight validation MUST reject unsafe paths containing directory traversal!
    // If verifyBackupIntegrity returns valid: true, it allows arbitrary file write outside repoRoot.
    assert.strictEqual(
      integrity.valid,
      false,
      'Pre-flight integrity MUST reject manifest entries attempting directory traversal outside repoRoot'
    );

    // Test rollback execution
    const rollbackRes = await performRollback(backupRes.timestamp, { repoRoot: tmpRepo });
    assert.strictEqual(rollbackRes.success, false, 'Rollback must reject execution on path traversal manifest');
    assert.strictEqual(fs.existsSync(outsideVictim), false, 'Rollback MUST NOT write files outside repoRoot');

    fs.rmSync(parentContainer, { recursive: true, force: true });
  });

  await t.test('ADV-M4-2.2: Manifest path traversal in f.backup (reading outside backup folder) must be rejected', async () => {
    const parentContainer = createTempDir('m4-trav-backup-');
    const tmpRepo = path.join(parentContainer, 'repo');
    const outsideSecret = path.join(parentContainer, 'host_secret.env');
    fs.mkdirSync(tmpRepo, { recursive: true });
    fs.writeFileSync(outsideSecret, 'SUPER_SECRET_HOST_DATA', 'utf8');
    const secretHash = crypto.createHash('sha256').update('SUPER_SECRET_HOST_DATA').digest('hex');

    const manifest = {
      manifestVersion: 2,
      timestamp: '20260920-000000',
      phaseId: 'EVIL_BACKUP_READ',
      reason: 'Read outside backup dir',
      engine: 'sqlite',
      files: [
        {
          original: 'config.txt',
          backup: '../host_secret.env',
          sha256: secretHash,
          size: 22,
          verified: true,
        },
      ],
    };

    const integrity = verifyBackupIntegrity(manifest, tmpRepo);

    // CHALLENGE ASSERTION: Pre-flight integrity MUST reject f.backup referencing files outside the backup root
    assert.strictEqual(
      integrity.valid,
      false,
      'Pre-flight integrity MUST reject manifest entries pointing f.backup outside repository/backup root'
    );

    fs.rmSync(parentContainer, { recursive: true, force: true });
  });

  await t.test('ADV-M4-2.3: Directory traversal in targetBackupId (performRollback("../../evil")) must be rejected', async () => {
    const tmpRoot = createTempDir('m4-trav-id-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    // Attempt rollback with path traversal targetBackupId
    const rollbackRes = await performRollback('../../system32', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
    });

    assert.strictEqual(rollbackRes.success, false, 'Rollback must fail on path traversal backupId');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('ADV-M4-2.4: SQL injection payload resilience in PostgreSQL dump and restore', async () => {
    const tmpRoot = createTempDir('m4-sql-inj-');
    const dumpFile = path.join(tmpRoot, 'sql_injection_dump.sql');

    // Table with adversarial SQL injection strings
    const evilRows = [
      {
        id: 1,
        name: "shopee'; DROP TABLE platforms CASCADE; --",
        description: "' OR '1'='1' --",
        metadata: { payload: "'); DELETE FROM users; --", note: "line1\nline2'; DROP SCHEMA public;" },
      },
      {
        id: 2,
        name: 'standard_platform',
        description: "Backslash\\Quote'Single''Double\"",
        metadata: null,
      },
    ];

    const mockClient = {
      query: async (sql) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'platforms' }] };
        }
        if (sql.includes('SELECT * FROM "platforms"')) {
          return { rows: evilRows };
        }
        return { rows: [] };
      },
    };

    const dumpRes = await dumpPostgresViaClient(mockClient, dumpFile, null);
    assert.strictEqual(dumpRes.success, true);
    assert.strictEqual(dumpRes.totalRows, 2);

    const sqlContent = fs.readFileSync(dumpFile, 'utf8');

    // Verify quotes are doubled: '' instead of naked '
    assert.ok(sqlContent.includes("shopee''; DROP TABLE platforms CASCADE; --"));
    assert.ok(sqlContent.includes("'' OR ''1''=''1'' --"));

    // Verify restore executes clean transaction without running injected DDL
    const executedQueries = [];
    const mockRestoreClient = {
      query: async (sql) => {
        executedQueries.push(sql);
        return { rows: [] };
      },
    };

    const restoreRes = await restorePostgresViaClient(mockRestoreClient, dumpFile);
    assert.strictEqual(restoreRes, true);
    assert.ok(executedQueries.includes('BEGIN;'));
    assert.ok(executedQueries.includes('COMMIT;'));
    // Ensure DROP TABLE was never sent as an independent query
    assert.ok(!executedQueries.some(q => q.trim().startsWith('DROP TABLE platforms')));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ==========================================================================
  // VECTOR 3: BOUNDARY FIDELITY & ZERO-WRITE INVARIANTS
  // ==========================================================================

  await t.test('ADV-M4-3.1: Zero-row table dump and restore fidelity (empty tables)', async () => {
    const tmpRoot = createTempDir('m4-empty-table-');
    const dumpFile = path.join(tmpRoot, 'empty_dump.sql');

    const mockClient = {
      query: async (sql) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'runs' }, { table_name: 'snapshots' }] };
        }
        // Both tables are empty (0 rows)
        return { rows: [] };
      },
    };

    const dumpRes = await dumpPostgresViaClient(mockClient, dumpFile, null);
    assert.strictEqual(dumpRes.success, true);
    assert.strictEqual(dumpRes.totalRows, 0);
    assert.strictEqual(dumpRes.tableCounts.runs, 0);
    assert.strictEqual(dumpRes.tableCounts.snapshots, 0);

    const dumpSql = fs.readFileSync(dumpFile, 'utf8');
    assert.ok(dumpSql.includes('TRUNCATE TABLE "snapshots", "runs" CASCADE;'));
    // Must NOT contain invalid empty INSERT INTO ... VALUES ()
    assert.ok(!dumpSql.includes('INSERT INTO "runs"'));
    assert.ok(!dumpSql.includes('INSERT INTO "snapshots"'));
    assert.ok(dumpSql.includes('COMMIT;'));

    // Restore execution
    const mockRestoreClient = {
      query: async () => ({ rows: [] }),
    };
    const restoreRes = await restorePostgresViaClient(mockRestoreClient, dumpFile);
    assert.strictEqual(restoreRes, true);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('ADV-M4-3.2: Special character escaping fidelity in table dumps', async () => {
    // Test escapeSqlValue coverage directly
    assert.strictEqual(escapeSqlValue(null), 'NULL');
    assert.strictEqual(escapeSqlValue(undefined), 'NULL');
    assert.strictEqual(escapeSqlValue(true), 'TRUE');
    assert.strictEqual(escapeSqlValue(false), 'FALSE');
    assert.strictEqual(escapeSqlValue(0), '0');
    assert.strictEqual(escapeSqlValue(-42.5), '-42.5');
    assert.strictEqual(escapeSqlValue(NaN), 'NULL');
    assert.strictEqual(escapeSqlValue(Infinity), 'NULL');

    // Date
    const d = new Date('2026-09-23T06:00:00.000Z');
    assert.strictEqual(escapeSqlValue(d), "'2026-09-23T06:00:00.000Z'");

    // Multilingual & Unicode & Emojis
    const unicodeStr = "🚀 Tiếng Việt — 日本語 測試 \u0000";
    const escapedUnicode = escapeSqlValue(unicodeStr);
    assert.ok(escapedUnicode.startsWith("'") && escapedUnicode.endsWith("'"));
    assert.ok(escapedUnicode.includes('🚀 Tiếng Việt — 日本語 測試'));

    // Quotes and JSON objects
    const obj = { message: "It's a test with \"quotes\"", count: 42, active: true };
    const escapedObj = escapeSqlValue(obj);
    assert.ok(escapedObj.includes("It''s a test with \\\"quotes\\\""));
  });

  await t.test('ADV-M4-3.3: Dry-run mode produces ZERO disk writes and ZERO live mutations', async () => {
    const tmpRoot = createTempDir('m4-dryrun-zero-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');

    const liveFile = path.join(tmpRoot, 'important.data');
    const initialContent = 'IMPORTANT_DATA_BEFORE_DRY_RUN';
    fs.writeFileSync(liveFile, initialContent, 'utf8');

    // 1. Backup dry-run
    const backupDryRes = await createBackup(['important.data'], 'Dry run drill', 'PHASE_DRY', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      dryRun: true,
      engine: 'sqlite',
    });

    assert.strictEqual(backupDryRes.isDryRun, true);
    assert.strictEqual(fs.existsSync(tmpBackupDir), false, 'Dry-run backup MUST NOT create .backup directory on disk');

    // 2. Real backup to prepare for rollback dry-run
    const realBackupRes = await createBackup(['important.data'], 'Real backup for rollback dry-run', 'PHASE_REAL', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
    });
    assert.strictEqual(fs.existsSync(tmpBackupDir), true);

    // Mutate live file
    const mutatedContent = 'MUTATED_NEW_CONTENT_NOT_TO_BE_REVERTED_IN_DRY_RUN';
    fs.writeFileSync(liveFile, mutatedContent, 'utf8');
    const mtimeBefore = fs.statSync(liveFile).mtimeMs;

    // 3. Rollback dry-run
    const rollbackDryRes = await performRollback(realBackupRes.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      dryRun: true,
    });

    assert.strictEqual(rollbackDryRes.success, true);
    assert.strictEqual(rollbackDryRes.isDryRun, true);

    // Live file invariant: MUST NOT be modified during rollback dry-run
    assert.strictEqual(fs.readFileSync(liveFile, 'utf8'), mutatedContent, 'Live file must remain untouched during rollback dry-run');
    assert.strictEqual(fs.statSync(liveFile).mtimeMs, mtimeBefore, 'Live file mtime must remain unchanged during rollback dry-run');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ==========================================================================
  // VECTOR 4: RETENTION PRUNING BOUNDARIES & TIMESTAMP COLLISION
  // ==========================================================================

  await t.test('ADV-M4-4.1: Retention count larger than available backups prunes 0 entries', async () => {
    const tmpRoot = createTempDir('m4-retention-large-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    // Create 3 mock backup directories
    for (let i = 1; i <= 3; i++) {
      const bDir = path.join(tmpBackupDir, `20260920-00000${i}`);
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(path.join(bDir, 'manifest.json'), JSON.stringify({ files: [] }), 'utf8');
    }

    assert.strictEqual(listBackups(tmpRoot, tmpBackupDir).length, 3);

    // Prune with retention count 100 (much larger than available 3)
    const pruned = pruneBackups(tmpBackupDir, 100, false);
    assert.strictEqual(pruned.length, 0, 'No backups should be pruned when count <= retention');
    assert.strictEqual(listBackups(tmpRoot, tmpBackupDir).length, 3, 'All 3 backups must remain');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('ADV-M4-4.2: Retention count 0 boundary handling in pruneBackups and createBackup', async () => {
    const tmpRoot = createTempDir('m4-retention-zero-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    // 4.2a pruneBackups(dir, 0) prunes all excess
    for (let i = 1; i <= 3; i++) {
      const bDir = path.join(tmpBackupDir, `20260920-00000${i}`);
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(path.join(bDir, 'manifest.json'), JSON.stringify({ files: [] }), 'utf8');
    }
    const pruned = pruneBackups(tmpBackupDir, 0, false);
    assert.strictEqual(pruned.length, 3, 'pruneBackups with retention 0 must prune all 3 entries');
    assert.strictEqual(listBackups(tmpRoot, tmpBackupDir).length, 0, 'Zero backups remain');

    // 4.2b createBackup with retention: 0 boundary check
    // CHALLENGE: In scripts/backup-manager.js:270:
    // const retention = Number(options.retention || process.env.BACKUP_RETENTION_COUNT) || DEFAULT_RETENTION;
    // When options.retention is 0, JavaScript treats 0 as falsy, defaulting retention to 10 instead of 0!
    const dummyFile = path.join(tmpRoot, 'dummy.txt');
    fs.writeFileSync(dummyFile, 'dummy', 'utf8');

    const backupRes = await createBackup(['dummy.txt'], 'Retention 0 test', 'RETENTION_0', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
      retention: 0,
      dryRun: true,
    });

    // CHALLENGE ASSERTION: createBackup MUST honor retention: 0 rather than falling back to 10!
    assert.strictEqual(
      backupRes.retention,
      0,
      'createBackup MUST respect explicit retention: 0 (boundary defect: 0 is falsy and defaults to 10)'
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('ADV-M4-4.3: Identical timestamp / rapid consecutive backup collision analysis', async () => {
    // getTimestamp() format: YYYYMMDD-HHmmss (second precision)
    const ts1 = getTimestamp();
    const ts2 = getTimestamp();
    assert.strictEqual(typeof ts1, 'string');
    assert.strictEqual(ts1.length, 15); // e.g. 20260923-064500

    // Rapid consecutive backups in same second share identical folder name
    // Verify that getTimestamp produces matching names within same millisecond
    assert.strictEqual(ts1, ts2, 'Consecutive calls within the same second share identical timestamp string');
  });

});
