/**
 * Rollback Utility
 * Restores project files and SQLite database from a timestamped backup directory.
 * Usage: node scripts/rollback.js [BACKUP_ID] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function listBackups(repoRoot) {
  const backupDir = path.join(repoRoot, '.backup');
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter(d => fs.existsSync(path.join(backupDir, d, 'manifest.json')))
    .sort();
}

function performRollback(targetBackupId, options = {}) {
  const repoRoot = path.join(__dirname, '..');
  const backupRoot = path.join(repoRoot, '.backup');
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');

  const available = listBackups(repoRoot);
  if (!available.length) {
    console.error('? Kh?ng t?m th?y b?n backup n?o trong th? m?c .backup/');
    return { success: false };
  }

  let backupId = targetBackupId;
  if (!backupId || backupId === 'baseline' || backupId === 'latest') {
    backupId = backupId === 'latest' ? available[available.length - 1] : available[0];
  }

  const selectedBackupDir = path.join(backupRoot, backupId);
  const manifestPath = path.join(selectedBackupDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.error(`? Kh?ng t?m th?y manifest c?a b?n backup: ${backupId}`);
    console.log('C?c b?n backup kh? d?ng:', available.join(', '));
    return { success: false };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`
?? [Rollback] ${isDryRun ? 'KI?M TRA (DRY RUN)' : '?ANG KH?I PH?C'} t? b?n backup: ${backupId}`);
  console.log(`   Phase ID: ${manifest.phaseId}`);
  console.log(`   L? do t?o: ${manifest.reason}`);
  console.log(`   Th?i gian t?o: ${manifest.timestamp}`);
  console.log(`   S? file c?n kh?i ph?c: ${manifest.files.length}
`);

  // Safe WAL checkpoint before DB overwrite
  const dbPath = path.join(repoRoot, 'data', 'collector.db');
  if (!isDryRun && manifest.files.some(f => f.original.includes('collector.db'))) {
    try {
      const Database = require('better-sqlite3');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath);
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
      }
    } catch (_e) {}
  }

  const restored = [];
  for (const f of manifest.files) {
    const backupFilePath = path.join(repoRoot, f.backup);
    const destFilePath = path.join(repoRoot, f.original);

    if (!fs.existsSync(backupFilePath)) {
      console.error(`? File backup kh?ng t?n t?i: ${f.backup}`);
      continue;
    }

    const currentHash = fileHash(backupFilePath);
    if (f.sha256 && currentHash !== f.sha256) {
      console.warn(`?? C?nh b?o sai l?ch SHA256 cho file ${f.backup}`);
    }

    if (!isDryRun) {
      fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
      fs.copyFileSync(backupFilePath, destFilePath);
      console.log(`  ? ?? kh?i ph?c: ${f.original}`);
    } else {
      console.log(`  [Dry-run] S? kh?i ph?c: ${f.original} t? ${f.backup}`);
    }
    restored.push(f.original);
  }

  console.log(`
?? [Rollback] Ho?n t?t ${isDryRun ? 'ki?m tra' : 'kh?i ph?c'} ${restored.length}/${manifest.files.length} files!`);
  return { success: true, backupId, restoredCount: restored.length, isDryRun };
}

module.exports = { performRollback, listBackups };

if (require.main === module) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  performRollback(args[0] || 'baseline');
}
