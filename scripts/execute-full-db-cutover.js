const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'collector.db');

function sha256File(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

async function main() {
  console.log('==================================================');
  console.log('BUOC 1: XAC NHAN DB TARGET THAT');
  console.log('==================================================');
  console.log('DB_TARGET=' + DB_PATH);
  if (!fs.existsSync(DB_PATH)) {
    console.error('FATAL: DB target file does not exist at ' + DB_PATH);
    process.exit(1);
  }
  const preStat = fs.statSync(DB_PATH);
  console.log('Pre-migration File Size:', preStat.size, 'bytes');

  const rawDb = new Database(DB_PATH);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('busy_timeout = 5000');

  const tables = rawDb.prepare( SELECT name FROM sqlite_master WHERE type=table AND name NOT LIKE sqlite_% ORDER BY name).all().map(r => r.name);
  const preStats = {};
  for (const t of tables) {
    const count = rawDb.prepare('SELECT COUNT(1) c FROM  + t + ').get().c;
    preStats[t] = count;
    console.log('  - ' + t + ': ' + count + ' rows');
  }

  console.log('\n==================================================');
  console.log('BUOC 2: DONG WRITER + BACKUP');
  console.log('==================================================');
  rawDb.pragma('wal_checkpoint(TRUNCATE)');
  rawDb.close();

  const timestamp = getTimestamp();
  const backupFileName = 'collector.pre-v2-cutover-' + timestamp + '.db';
  const backupPath = path.join(PROJECT_ROOT, 'data', backupFileName);
  fs.copyFileSync(DB_PATH, backupPath);

  console.log('Backup created at:', backupPath);
  const sourceHash = sha256File(DB_PATH);
  const backupHash = sha256File(backupPath);
  console.log('SOURCE DB SHA256:', sourceHash);
  console.log('BACKUP DB SHA256:', backupHash);
  if (sourceHash !== backupHash) {
    console.error('FATAL: Backup SHA256 mismatch!');
    process.exit(1);
  }

  const srcDbCheck = new Database(DB_PATH, { readonly: true });
  const srcIntegrity = srcDbCheck.pragma('integrity_check');
  srcDbCheck.close();
  console.log('SOURCE DB integrity_check:', srcIntegrity);

  const bkpDbCheck = new Database(backupPath, { readonly: true });
  const bkpIntegrity = bkpDbCheck.pragma('integrity_check');
  bkpDbCheck.close();
  console.log('BACKUP DB integrity_check:', bkpIntegrity);

  if (srcIntegrity[0].integrity_check !== 'ok' || bkpIntegrity[0].integrity_check !== 'ok') {
    console.error('FATAL: Integrity check failed!');
    process.exit(1);
  }

  console.log('\n==================================================');
  console.log('BUOC 3: DETERMINISTIC V2 REBUILD');
  console.log('==================================================');
  const dbModule = require(path.join(PROJECT_ROOT, 'src', 'database'));
  
  // Rebuild 1: reset checkpoint & re-populate V2 from legacy snapshots
  const rwDb = new Database(DB_PATH);
  rwDb.prepare('DELETE FROM product_current').run();
  rwDb.prepare('DELETE FROM daily_packed_history').run();
  rwDb.prepare(DELETE FROM migration_checkpoints WHERE key = snapshots_v2_backfill ).run();
  rwDb.close();

  console.log('Running Rebuild 1...');
  const rebuild1Result = dbModule.backfillSnapshotsToV2();
  console.log('Rebuild 1 Result:', rebuild1Result);

  const r1Db = new Database(DB_PATH, { readonly: true });
  const r1ProductCount = r1Db.prepare('SELECT COUNT(1) c FROM product_current').get().c;
  const r1HistoryRowCount = r1Db.prepare('SELECT COUNT(1) c FROM daily_packed_history').get().c;
  const r1ObsSum = r1Db.prepare('SELECT SUM(observation_count) c FROM daily_packed_history').get().c || 0;
  
  let r1ObsIds = new Set();
  let r1Duplicates = 0;
  let r1Malformed = 0;
  for (const row of r1Db.prepare('SELECT observations_json FROM daily_packed_history').iterate()) {
    try {
      const arr = JSON.parse(row.observations_json);
      for (const o of arr) {
        if (!o || !o.observationId) { r1Malformed++; continue; }
        if (r1ObsIds.has(o.observationId)) { r1Duplicates++; }
        else { r1ObsIds.add(o.observationId); }
      }
    } catch { r1Malformed++; }
  }
  r1Db.close();

  console.log('Rebuild 1 Stats:');
  console.log('  product_current count:', r1ProductCount);
  console.log('  daily_packed_history rows:', r1HistoryRowCount);
  console.log('  total observation_count sum:', r1ObsSum);
  console.log('  unique observationId count:', r1ObsIds.size);
  console.log('  duplicate count:', r1Duplicates);
  console.log('  malformed count:', r1Malformed);

  console.log('\nRunning Rebuild 2 (Idempotence validation)...');
  const rwDb2 = new Database(DB_PATH);
  rwDb2.prepare( DELETE FROM migration_checkpoints WHERE key = snapshots_v2_backfill ).run();
  rwDb2.close();

  const rebuild2Result = dbModule.backfillSnapshotsToV2();
  console.log('Rebuild 2 Result:', rebuild2Result);

  const r2Db = new Database(DB_PATH, { readonly: true });
  const r2ProductCount = r2Db.prepare('SELECT COUNT(1) c FROM product_current').get().c;
  const r2HistoryRowCount = r2Db.prepare('SELECT COUNT(1) c FROM daily_packed_history').get().c;
  const r2ObsSum = r2Db.prepare('SELECT SUM(observation_count) c FROM daily_packed_history').get().c || 0;
  let r2ObsIds = new Set();
  let r2Duplicates = 0;
  let r2Malformed = 0;
  for (const row of r2Db.prepare('SELECT observations_json FROM daily_packed_history').iterate()) {
    try {
      const arr = JSON.parse(row.observations_json);
      for (const o of arr) {
        if (!o || !o.observationId) { r2Malformed++; continue; }
        if (r2ObsIds.has(o.observationId)) { r2Duplicates++; }
        else { r2ObsIds.add(o.observationId); }
      }
    } catch { r2Malformed++; }
  }
  r2Db.close();

  console.log('Rebuild 2 Stats:');
  console.log('  product_current count:', r2ProductCount);
  console.log('  daily_packed_history rows:', r2HistoryRowCount);
  console.log('  total observation_count sum:', r2ObsSum);
  console.log('  unique observationId count:', r2ObsIds.size);
  console.log('  duplicate count:', r2Duplicates);
  console.log('  malformed count:', r2Malformed);

  if (r1ProductCount !== r2ProductCount || r1HistoryRowCount !== r2HistoryRowCount || r1ObsSum !== r2ObsSum || r2Duplicates !== 0 || r2Malformed !== 0) {
    console.error('FATAL: Deterministic rebuild failed idempotence check!');
    process.exit(1);
  }
  console.log('DETERMINISTIC REBUILD: PASS (Idempotent 100%)');

  console.log('\n==================================================');
  console.log('BUOC 4: FULL PARITY VALIDATION');
  console.log('==================================================');
  const parity = dbModule.checkV2Parity();
  console.log('Full Parity Output:');
  console.log(JSON.stringify(parity, null, 2));

  if (!parity.parityOk) {
    console.error('FATAL: Parity check failed! parityOk !== true');
    process.exit(1);
  }
  console.log('FULL PARITY: PASS (0 mismatches, 0 data loss)');

  console.log('\n==================================================');
  console.log('BUOC 5: CUTOVER PHASE A (READ_MODEL_V2=true, LEGACY_SNAPSHOT_WRITE=true)');
  console.log('==================================================');
  const items = dbModule.getItems({ limit: 5 });
  console.log('Read /api/items sample count:', items.items ? items.items.length : 0);
  if (!items.items || items.items.length === 0) {
    console.error('FATAL: /api/items returned empty under V2 read model');
    process.exit(1);
  }

  const sampleUid = items.items[0].item_uid;
  const history = dbModule.getItemHistory(sampleUid, 30);
  console.log('Read /api/items/' + sampleUid + '/history count:', history.length);

  const sampleRun = dbModule.getRuns({ limit: 1 }).runs[0];
  if (sampleRun) {
    const runDetail = dbModule.getRunById(sampleRun.id);
    console.log('Read /api/runs/' + sampleRun.id + ' status:', runDetail ? runDetail.status : 'null');
    const runExport = dbModule.getExportData(sampleRun.id);
    console.log('Read /api/export/' + sampleRun.id + ' items:', runExport.items ? runExport.items.length : 0);
  }
  console.log('PHASE A VALIDATION: PASS');

  return {
    preStatSize: preStat.size,
    preStats,
    sourceHash,
    backupPath,
    backupFileName,
    backupHash,
    srcIntegrity: srcIntegrity[0].integrity_check,
    bkpIntegrity: bkpIntegrity[0].integrity_check,
    rebuild1: { r1ProductCount, r1HistoryRowCount, r1ObsSum, uniqueObs: r1ObsIds.size },
    rebuild2: { r2ProductCount, r2HistoryRowCount, r2ObsSum, uniqueObs: r2ObsIds.size },
    parity
  };
}

main().then(res => {
  fs.writeFileSync(path.join(PROJECT_ROOT, 'data', 'cutover_step1_5_result.json'), JSON.stringify(res, null, 2), 'utf8');
  console.log('\nSTEPS 1-5 COMPLETED SUCCESSFULLY');
}).catch(err => {
  console.error('ERROR IN CUTOVER:', err);
  process.exit(1);
});
