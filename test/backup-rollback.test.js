'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  createBackup,
  pruneBackups,
  detectEngine,
  dumpPostgresViaClient,
} = require('../scripts/backup-manager');

const {
  performRollback,
  listBackups,
  verifyBackupIntegrity,
  restorePostgresViaClient,
} = require('../scripts/rollback');

function createTempDir(prefix = 'backup-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Feature 14 & 15: Automated Backup & Rollback Architecture', async (t) => {

  await t.test('1. Manifest generation and SHA-256 hash computation', async () => {
    const tmpRoot = createTempDir('cp-test-manifest-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    // Create a mock source file
    const sampleFilePath = path.join(tmpRoot, 'sample.txt');
    const sampleContent = 'Hello Crawler-POD Backup Manifest Test';
    fs.writeFileSync(sampleFilePath, sampleContent, 'utf8');
    const expectedHash = crypto.createHash('sha256').update(sampleContent).digest('hex');

    const backupResult = await createBackup(['sample.txt'], 'Test reason', 'PHASE_TEST_1', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite', // use sqlite/file mode for hermetic unit test
    });

    assert.equal(backupResult.verified, true, 'Backup must report verified true');
    assert.ok(fs.existsSync(backupResult.manifestPath), 'manifest.json must exist');

    const manifest = JSON.parse(fs.readFileSync(backupResult.manifestPath, 'utf8'));
    assert.equal(manifest.phaseId, 'PHASE_TEST_1');
    assert.equal(manifest.reason, 'Test reason');
    assert.equal(manifest.engine, 'sqlite');
    assert.ok(Array.isArray(manifest.files), 'files must be an array');

    const fileEntry = manifest.files.find(f => f.original === 'sample.txt');
    assert.ok(fileEntry, 'sample.txt must be recorded in manifest');
    assert.equal(fileEntry.sha256, expectedHash, 'Computed SHA-256 must match exact content hash');
    assert.equal(fileEntry.size, Buffer.byteLength(sampleContent));
    assert.equal(fileEntry.verified, true);
    assert.equal(fileEntry.hashMatches, true);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('2. Tamper detection: modified backup file causes rollback to abort', async () => {
    const tmpRoot = createTempDir('cp-test-tamper-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    const liveFile = path.join(tmpRoot, 'config.json');
    fs.writeFileSync(liveFile, JSON.stringify({ version: '1.0.0', secure: true }), 'utf8');

    const backupResult = await createBackup(['config.json'], 'Pre-tamper backup', 'PHASE_TAMPER', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
    });

    // Verify initial integrity before tampering
    const initialCheck = verifyBackupIntegrity(backupResult.manifest, tmpRoot);
    assert.equal(initialCheck.valid, true, 'Initial backup must be valid');

    // Tamper with the backup file on disk
    const backupEntry = backupResult.manifest.files.find(f => f.original === 'config.json');
    const backedUpFilePath = path.join(tmpRoot, backupEntry.backup);
    fs.appendFileSync(backedUpFilePath, '\n-- MALICIOUS_TAMPERED_INJECTION --', 'utf8');

    // Attempt rollback
    const rollbackResult = await performRollback(backupResult.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
    });

    // Assert that rollback ABORTED
    assert.equal(rollbackResult.success, false, 'Rollback must fail on tampered backup');
    assert.equal(rollbackResult.error, 'TAMPER_DETECTED', 'Error code must be TAMPER_DETECTED');
    assert.ok(rollbackResult.details.length > 0, 'Must provide details of the hash mismatch');
    assert.ok(rollbackResult.details[0].includes('SHA-256 hash mismatch'));

    // Live file must remain untouched
    const currentLive = fs.readFileSync(liveFile, 'utf8');
    assert.ok(!currentLive.includes('MALICIOUS_TAMPERED_INJECTION'), 'Live file must not be modified');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('3. Pre-flight integrity check catches missing backup files', async () => {
    const tmpRoot = createTempDir('cp-test-missing-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    const liveFile = path.join(tmpRoot, 'data.txt');
    fs.writeFileSync(liveFile, 'Some Data', 'utf8');

    const backupResult = await createBackup(['data.txt'], 'Missing file test', 'PHASE_MISSING', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
    });

    // Delete the backup file
    const backupEntry = backupResult.manifest.files.find(f => f.original === 'data.txt');
    fs.rmSync(path.join(tmpRoot, backupEntry.backup));

    const rollbackResult = await performRollback(backupResult.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
    });

    assert.equal(rollbackResult.success, false);
    assert.equal(rollbackResult.error, 'TAMPER_DETECTED');
    assert.ok(rollbackResult.details.some(d => d.includes('Missing backup file')));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('4. Dry-run mode for both backup and rollback', async () => {
    const tmpRoot = createTempDir('cp-test-dryrun-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');

    const sampleFile = path.join(tmpRoot, 'data.txt');
    fs.writeFileSync(sampleFile, 'Original Data', 'utf8');

    // 4a. Backup dry-run
    const backupDryRun = await createBackup(['data.txt'], 'Dry-run test', 'PHASE_DRY', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      dryRun: true,
      engine: 'sqlite',
    });

    assert.equal(backupDryRun.isDryRun, true, 'Backup result must flag isDryRun: true');
    assert.ok(!fs.existsSync(tmpBackupDir), 'Backup directory must NOT be created in dry-run mode');

    // Create real backup for rollback test
    const realBackup = await createBackup(['data.txt'], 'Real backup for rollback dry-run', 'PHASE_DRY_2', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
    });
    assert.ok(fs.existsSync(tmpBackupDir), 'Real backup created directory');

    // Modify live file
    fs.writeFileSync(sampleFile, 'Modified Data Before Rollback', 'utf8');

    // 4b. Rollback dry-run
    const rollbackDryRun = await performRollback(realBackup.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      dryRun: true,
    });

    assert.equal(rollbackDryRun.success, true, 'Rollback dry-run must succeed');
    assert.equal(rollbackDryRun.isDryRun, true, 'Rollback dry-run must flag isDryRun: true');

    // Live file must NOT be reverted during dry run
    assert.equal(fs.readFileSync(sampleFile, 'utf8'), 'Modified Data Before Rollback');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('5. Retention pruning logic', async () => {
    const tmpRoot = createTempDir('cp-test-retention-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    // Simulate 5 backup directories with timestamps 20260920-000001 .. 000005
    const timestamps = [
      '20260920-000001',
      '20260920-000002',
      '20260920-000003',
      '20260920-000004',
      '20260920-000005',
    ];

    for (const ts of timestamps) {
      const bDir = path.join(tmpBackupDir, ts);
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(path.join(bDir, 'manifest.json'), JSON.stringify({ timestamp: ts, files: [] }), 'utf8');
    }

    assert.equal(listBackups(tmpRoot, tmpBackupDir).length, 5, 'Must have 5 backups initially');

    // Prune with retention count = 3
    const pruned = pruneBackups(tmpBackupDir, 3, false);
    assert.equal(pruned.length, 2, 'Must prune exactly 2 excess backups');
    assert.deepEqual(pruned, ['20260920-000001', '20260920-000002'], 'Must prune the 2 oldest backups');

    const remaining = listBackups(tmpRoot, tmpBackupDir);
    assert.equal(remaining.length, 3, 'Must retain exactly 3 backups');
    assert.deepEqual(remaining, ['20260920-000003', '20260920-000004', '20260920-000005']);

    // Prune with retention count >= remaining count (should do nothing)
    const prunedAgain = pruneBackups(tmpBackupDir, 5, false);
    assert.equal(prunedAgain.length, 0, 'No backups pruned when count is within retention');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('6. Dual-engine detection and configuration resolution', async () => {
    const tmpRoot = createTempDir('cp-test-detect-');

    // With explicit engine option
    assert.equal(detectEngine({ engine: 'postgres' }, tmpRoot), 'postgres');
    assert.equal(detectEngine({ engine: 'sqlite' }, tmpRoot), 'sqlite');

    // Without DB or env vars, fallback to sqlite if collector.db exists
    const dataDir = path.join(tmpRoot, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'collector.db'), 'sqlite-stub');

    const origDbUrl = process.env.DATABASE_URL;
    const origPgHost = process.env.PGHOST;
    const origPgDb = process.env.PGDATABASE;
    const origPgConn = process.env.PG_CONNECTION_STRING;
    const origPgMode = process.env.PG_MODE;

    delete process.env.DATABASE_URL;
    delete process.env.PGHOST;
    delete process.env.PGDATABASE;
    delete process.env.PG_CONNECTION_STRING;
    delete process.env.PG_MODE;

    try {
      assert.equal(detectEngine({}, tmpRoot), 'sqlite');
    } finally {
      if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
      if (origPgHost) process.env.PGHOST = origPgHost;
      if (origPgDb) process.env.PGDATABASE = origPgDb;
      if (origPgConn) process.env.PG_CONNECTION_STRING = origPgConn;
      if (origPgMode) process.env.PG_MODE = origPgMode;
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('7. PostgreSQL client dump generation & restore execution', async () => {
    const tmpRoot = createTempDir('cp-test-pg-client-');
    const dumpFile = path.join(tmpRoot, 'database_dump.sql');

    // Mock pg client with in-memory tables
    const mockDbState = {
      platforms: [
        { id: 1, name: 'shopee', active: true, created_at: new Date('2026-01-01T00:00:00Z') },
        { id: 2, name: 'tiktok', active: true, created_at: new Date('2026-01-02T00:00:00Z') },
      ],
      users: [
        { id: 'usr_1', email: 'admin@system.local', role: 'admin' },
      ],
    };

    const executedSql = [];
    const mockClient = {
      query: async (sql, _params) => {
        executedSql.push(sql);
        if (sql.includes('information_schema.tables')) {
          return {
            rows: [
              { table_name: 'platforms' },
              { table_name: 'users' },
            ],
          };
        }
        if (sql.includes('SELECT * FROM "platforms"')) {
          return { rows: mockDbState.platforms };
        }
        if (sql.includes('SELECT * FROM "users"')) {
          return { rows: mockDbState.users };
        }
        return { rows: [] };
      },
    };

    // 7a. Dump generation
    const dumpResult = await dumpPostgresViaClient(mockClient, dumpFile, null);
    assert.equal(dumpResult.success, true);
    assert.equal(dumpResult.totalRows, 3);
    assert.equal(dumpResult.tableCounts.platforms, 2);
    assert.equal(dumpResult.tableCounts.users, 1);
    assert.ok(fs.existsSync(dumpFile));

    const dumpContent = fs.readFileSync(dumpFile, 'utf8');
    assert.ok(dumpContent.includes('BEGIN;'));
    assert.ok(dumpContent.includes('TRUNCATE TABLE "users", "platforms" CASCADE;'));
    assert.ok(dumpContent.includes('INSERT INTO "platforms"'));
    assert.ok(dumpContent.includes('shopee'));
    assert.ok(dumpContent.includes('tiktok'));
    assert.ok(dumpContent.includes('INSERT INTO "users"'));
    assert.ok(dumpContent.includes('admin@system.local'));
    assert.ok(dumpContent.includes('COMMIT;'));

    // 7b. Restore execution
    const restoreQueries = [];
    const mockRestoreClient = {
      query: async (sql) => {
        restoreQueries.push(sql);
        return { rows: [] };
      },
    };

    const restoreSuccess = await restorePostgresViaClient(mockRestoreClient, dumpFile);
    assert.equal(restoreSuccess, true);
    assert.ok(restoreQueries.includes('BEGIN;'));
    assert.ok(restoreQueries.includes('COMMIT;'));
    assert.ok(restoreQueries.some(q => q.includes('TRUNCATE TABLE')));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('8. Full PostgreSQL backup and restore flow with manifest verification', async () => {
    const tmpRoot = createTempDir('cp-test-pg-flow-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    const mockClient = {
      query: async (sql) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'platforms' }] };
        }
        if (sql.includes('SELECT * FROM "platforms"')) {
          return { rows: [{ id: 1, name: 'shopee' }] };
        }
        return { rows: [] };
      },
    };

    const backupRes = await createBackup([], 'Full PG Backup Test', 'PHASE_PG_FLOW', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'postgres',
      client: mockClient,
    });

    assert.equal(backupRes.engine, 'postgres');
    assert.equal(backupRes.verified, true);
    assert.ok(fs.existsSync(backupRes.manifestPath));

    const manifest = JSON.parse(fs.readFileSync(backupRes.manifestPath, 'utf8'));
    assert.equal(manifest.engine, 'postgres');
    assert.equal(manifest.totalRows, 1);
    const dumpEntry = manifest.files.find(f => f.original === 'database_dump.sql');
    assert.ok(dumpEntry);
    assert.ok(dumpEntry.sha256);

    const restoreRes = await performRollback(backupRes.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      client: mockClient,
    });

    assert.equal(restoreRes.success, true);
    assert.ok(restoreRes.restoredFiles.includes('database_dump.sql'));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('9. Path traversal defense: manifest entries escaping repo root are rejected', async () => {
    const tmpRoot = createTempDir('cp-test-traversal-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    const liveFile = path.join(tmpRoot, 'normal.txt');
    fs.writeFileSync(liveFile, 'Normal Content', 'utf8');

    const backupResult = await createBackup(['normal.txt'], 'Traversal test', 'PHASE_TRAV', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
    });

    const manifest = JSON.parse(fs.readFileSync(backupResult.manifestPath, 'utf8'));

    // 9a. Test path traversal in f.original (e.g., ../../escaped.txt)
    const forgedManifestOriginal = JSON.parse(JSON.stringify(manifest));
    forgedManifestOriginal.files[0].original = '../../escaped.txt';
    const checkOriginal = verifyBackupIntegrity(forgedManifestOriginal, tmpRoot);
    assert.equal(checkOriginal.valid, false, 'verifyBackupIntegrity must reject manifest with traversal in original');
    assert.ok(checkOriginal.errors.some(e => e.includes('Unsafe path traversal')), 'Must report path traversal in error');

    // 9b. Test path traversal in f.backup (e.g., ../secret.env)
    const forgedManifestBackup = JSON.parse(JSON.stringify(manifest));
    forgedManifestBackup.files[0].backup = '../secret.env';
    const checkBackup = verifyBackupIntegrity(forgedManifestBackup, tmpRoot);
    assert.equal(checkBackup.valid, false, 'verifyBackupIntegrity must reject manifest with traversal in backup');
    assert.ok(checkBackup.errors.some(e => e.includes('Unsafe path traversal')), 'Must report path traversal in error');

    // 9c. Test performRollback aborts without writing escaped file
    const outsideVictim = path.join(tmpRoot, '..', 'escaped_rollback_victim.txt');
    fs.writeFileSync(backupResult.manifestPath, JSON.stringify(forgedManifestOriginal, null, 2), 'utf8');
    const rollbackRes = await performRollback(backupResult.timestamp, {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
    });
    assert.equal(rollbackRes.success, false, 'Rollback must fail on path traversal manifest');
    assert.equal(rollbackRes.error, 'TAMPER_DETECTED');
    assert.equal(fs.existsSync(outsideVictim), false, 'Rollback must never write outside repoRoot');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('10. Retention boundary 0 handling in createBackup and pruneBackups', async () => {
    const tmpRoot = createTempDir('cp-test-ret-zero-');
    const tmpBackupDir = path.join(tmpRoot, '.backup');
    fs.mkdirSync(tmpBackupDir, { recursive: true });

    // 10a. pruneBackups with count 0 prunes all existing backups
    for (let i = 1; i <= 3; i++) {
      const bDir = path.join(tmpBackupDir, `20260920-00000${i}`);
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(path.join(bDir, 'manifest.json'), JSON.stringify({ files: [] }), 'utf8');
    }
    assert.equal(listBackups(tmpRoot, tmpBackupDir).length, 3);
    const pruned = pruneBackups(tmpBackupDir, 0, false);
    assert.equal(pruned.length, 3, 'pruneBackups with retention 0 must prune all 3');
    assert.equal(listBackups(tmpRoot, tmpBackupDir).length, 0, 'Zero backups remain');

    // 10b. createBackup with explicit retention: 0 (dryRun)
    const testFile = path.join(tmpRoot, 'test.txt');
    fs.writeFileSync(testFile, 'test content', 'utf8');
    const dryRes = await createBackup(['test.txt'], 'Retention 0 dry-run', 'RET_ZERO_DRY', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
      retention: 0,
      dryRun: true,
    });
    assert.equal(dryRes.retention, 0, 'createBackup must preserve retention: 0 (not default to 10)');

    // 10c. createBackup with explicit retention: 0 (real execution)
    const oldDir = path.join(tmpBackupDir, '20260920-000001');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'manifest.json'), JSON.stringify({ files: [] }), 'utf8');

    const realRes = await createBackup(['test.txt'], 'Retention 0 live', 'RET_ZERO_LIVE', {
      repoRoot: tmpRoot,
      backupDir: tmpBackupDir,
      engine: 'sqlite',
      retention: 0,
    });
    assert.equal(realRes.verified, true);
    assert.ok(realRes.manifest.retentionPruned.includes('20260920-000001'), 'Old backup must be pruned with retention 0');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
