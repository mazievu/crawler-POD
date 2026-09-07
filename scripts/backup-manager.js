const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function createBackup(filesToBackup, reason, phaseId) {
  const timestamp = getTimestamp();
  const repoRoot = path.join(__dirname, '..');
  const backupDir = path.join(repoRoot, '.backup', timestamp);
  fs.mkdirSync(backupDir, { recursive: true });

  const manifest = {
    timestamp,
    phaseId: phaseId || 'UNKNOWN',
    reason: reason || 'Pre-change backup',
    files: []
  };

  const dbPath = path.join(repoRoot, 'data', 'collector.db');
  if (filesToBackup.some(f => f.includes('collector.db'))) {
    try {
      const Database = require('better-sqlite3');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath);
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
      }
    } catch (err) {
      console.warn('Could not run wal_checkpoint before backup:', err.message);
    }
  }

  const verificationFailures = [];

  for (const relPath of filesToBackup) {
    const src = path.join(repoRoot, relPath);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(backupDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);

    const sourceHash = fileHash(src);
    const backupHash = fileHash(dest);
    const hashMatches = sourceHash === backupHash;

    let sqliteIntegrityOk = null;
    if (relPath.endsWith('.db')) {
      try {
        const Database = require('better-sqlite3');
        const backupDb = new Database(dest, { readonly: true });
        const result = backupDb.pragma('integrity_check');
        backupDb.close();
        sqliteIntegrityOk = Array.isArray(result) && result.length === 1 && result[0].integrity_check === 'ok';
      } catch (err) {
        sqliteIntegrityOk = false;
        console.error(`[Backup] SQLite integrity_check failed to run for ${relPath}:`, err.message);
      }
    }

    const verified = hashMatches && (sqliteIntegrityOk === null || sqliteIntegrityOk === true);
    if (!verified) verificationFailures.push(relPath);

    manifest.files.push({
      original: relPath.replace(/\\/g, '/'),
      backup: path.relative(repoRoot, dest).replace(/\\/g, '/'),
      sha256: sourceHash,
      size: fs.statSync(src).size,
      verified,
      hashMatches,
      sqliteIntegrityOk
    });
  }

  const manifestPath = path.join(backupDir, 'manifest.json');
  manifest.verified = verificationFailures.length === 0;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[Backup] Created backup at .backup/${timestamp} (${manifest.files.length} files backed up, verified=${manifest.verified})`);

  if (verificationFailures.length > 0) {
    throw new Error(`[Backup] VERIFICATION FAILED for: ${verificationFailures.join(', ')} — refusing to proceed with any destructive change that depends on this backup.`);
  }

  return { backupDir, manifestPath, timestamp, verified: true };
}

module.exports = { createBackup, getTimestamp, fileHash };

if (require.main === module) {
  const files = process.argv.slice(2);
  createBackup(files.length ? files : ['src/database.js', 'src/runs.service.js', 'server.js', 'data/collector.db'], 'Manual initial baseline backup', 'PHASE_0');
}
