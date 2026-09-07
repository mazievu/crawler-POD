#!/usr/bin/env node
/**
 * build-sqlite-data-packet.js
 *
 * Packages the entire current SQLite crawl dataset into a self-contained
 * handoff packet for the lead.
 *
 * The source database is opened READ-ONLY and is never written to, vacuumed,
 * checkpointed or otherwise mutated.
 *
 * WHY THE ONLINE BACKUP API AND NOT A FILE COPY:
 * data/collector.db runs in WAL mode and normally carries several MB of
 * committed-but-not-yet-checkpointed pages in collector.db-wal. Copying only
 * the .db file would silently produce a snapshot that is missing the most
 * recent writes; copying .db + -wal + -shm by hand is racy while the server is
 * running. better-sqlite3's db.backup() drives SQLite's Online Backup API,
 * which produces one consistent single-file snapshot that already includes the
 * WAL contents, safely, while other processes keep using the database.
 *
 * Packet layout:
 *   <packet>/
 *     README.md                  human-readable description + verify steps
 *     collector.snapshot.db      consistent single-file snapshot (WAL included)
 *     schema/schema.sql          full DDL (tables + indexes) from the source
 *     export/<table>.json        one JSON array per table, all rows
 *     MANIFEST.json              per-table row counts + integrity results
 *     checksums.sha256           sha256 of every file in the packet
 *
 * Usage:
 *   node scripts/build-sqlite-data-packet.js [--out <dir>] [--source <db>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');

// Columns holding encrypted credential material. Their contents are ciphertext
// (already encrypted at rest by the application), never plaintext secrets, but
// the packet still has to be treated as sensitive — flagged in the README so
// whoever receives it transfers it over a secure channel. See rules §24.
const SENSITIVE_COLUMNS = {
  marketplace_accounts: ['session_encrypted'],
  marketplace_proxies: ['config_encrypted'],
};

function parseArgs(argv) {
  const args = { out: null, source: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--source') args.source = argv[++i];
  }
  return args;
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

function dumpSchema(db) {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`
    )
    .all();
  const header = [
    '-- crawler-POD — SQLite schema snapshot',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Objects: ${rows.length}`,
    '',
  ].join('\n');
  return header + rows.map((r) => `${r.sql.trim()};`).join('\n\n') + '\n';
}

/**
 * BigInt-safe JSON. SQLite INTEGER columns can exceed Number.MAX_SAFE_INTEGER;
 * better-sqlite3 hands those back as BigInt, which JSON.stringify throws on.
 * Emitting them as strings keeps the export lossless rather than silently
 * truncating to a float. Buffers (BLOB) are emitted as base64 for the same
 * reason.
 */
function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return { __blob_base64__: value.toString('base64') };
  return value;
}

function main() {
  const args = parseArgs(process.argv);
  const sourceDb = args.source ? path.resolve(args.source) : path.join(REPO_ROOT, 'data', 'collector.db');
  const packetDir = args.out
    ? path.resolve(args.out)
    : path.join(REPO_ROOT, 'docs', 'DATA_PACKETS', `${todayStamp()}-sqlite-crawl-data`);

  if (!fs.existsSync(sourceDb)) {
    console.error(`FATAL: source database not found: ${sourceDb}`);
    process.exit(1);
  }

  console.log('=== crawler-POD SQLite data packet ===');
  console.log(`Source : ${sourceDb}  (opened READ-ONLY, never modified)`);
  console.log(`Packet : ${packetDir}`);

  fs.mkdirSync(path.join(packetDir, 'schema'), { recursive: true });
  fs.mkdirSync(path.join(packetDir, 'export'), { recursive: true });

  const sourceStatBefore = fs.statSync(sourceDb);
  const db = new Database(sourceDb, { readonly: true });

  const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  const tables = listTables(db);
  console.log(`Journal mode: ${journalMode} | tables: ${tables.length}`);

  // ---------- 1. Schema ----------
  const schemaPath = path.join(packetDir, 'schema', 'schema.sql');
  fs.writeFileSync(schemaPath, dumpSchema(db), 'utf8');
  console.log(`\n[1/4] schema -> ${path.relative(packetDir, schemaPath)}`);

  // ---------- 2. Per-table JSON export + row counts ----------
  console.log('[2/4] exporting tables:');
  const tableReport = [];
  let totalRows = 0;
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all();
    const count = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    const outFile = path.join(packetDir, 'export', `${table}.json`);
    fs.writeFileSync(outFile, JSON.stringify(rows, jsonReplacer, 2), 'utf8');
    totalRows += count;
    tableReport.push({
      table,
      rowCount: count,
      exportedRows: rows.length,
      exportMatchesCount: rows.length === count,
      exportFile: `export/${table}.json`,
      exportSha256: sha256File(outFile),
      sensitiveColumns: SENSITIVE_COLUMNS[table] || [],
    });
    console.log(`        ${String(count).padStart(6)}  ${table}`);
  }

  // ---------- 3. Consistent snapshot via Online Backup API ----------
  const snapshotPath = path.join(packetDir, 'collector.snapshot.db');
  if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
  console.log('[3/4] snapshot via SQLite Online Backup API (WAL-safe)...');

  return db
    .backup(snapshotPath)
    .then(() => {
      // ---------- 4. Verify the snapshot independently ----------
      console.log('[4/4] verifying snapshot against source...');
      // Opened writable (this is our own fresh copy — the source is never
      // touched) purely to convert the snapshot out of WAL mode. db.backup()
      // inherits the source's journal_mode=wal, which means the snapshot drags
      // along -wal/-shm sidecar files; a handoff artifact should be ONE
      // portable file that can be copied or checksummed on its own.
      const snap = new Database(snapshotPath);
      snap.pragma('journal_mode = DELETE');

      const integrity = snap.prepare('PRAGMA integrity_check').get().integrity_check;
      const snapTables = listTables(snap);

      const verification = [];
      let allMatch = integrity === 'ok' && snapTables.length === tables.length;
      for (const t of tableReport) {
        const snapCount = snap.prepare(`SELECT COUNT(*) AS n FROM "${t.table}"`).get().n;
        const match = snapCount === t.rowCount;
        if (!match) allMatch = false;
        verification.push({ table: t.table, sourceRows: t.rowCount, snapshotRows: snapCount, match });
      }
      snap.close();
      db.close();

      // Remove any sidecar left behind by an earlier WAL-mode run of this
      // script, so the packet contains exactly one snapshot file.
      for (const sidecar of [`${snapshotPath}-wal`, `${snapshotPath}-shm`]) {
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
      }

      // Prove the source file was not mutated by this run.
      const sourceStatAfter = fs.statSync(sourceDb);
      const sourceUntouched =
        sourceStatBefore.size === sourceStatAfter.size &&
        sourceStatBefore.mtimeMs === sourceStatAfter.mtimeMs;

      const manifest = {
        packetName: path.basename(packetDir),
        generatedAt: new Date().toISOString(),
        source: {
          path: path.relative(REPO_ROOT, sourceDb).replace(/\\/g, '/'),
          journalMode,
          sizeBytes: sourceStatAfter.size,
          modifiedByThisRun: !sourceUntouched,
        },
        snapshot: {
          file: 'collector.snapshot.db',
          method: 'SQLite Online Backup API (better-sqlite3 db.backup) — includes WAL contents',
          sizeBytes: fs.statSync(snapshotPath).size,
          integrityCheck: integrity,
          sha256: sha256File(snapshotPath),
        },
        totals: { tables: tables.length, rows: totalRows },
        tables: tableReport,
        snapshotVerification: verification,
        verdict: {
          allTableCountsMatch: allMatch,
          integrityOk: integrity === 'ok',
          sourceUntouched,
        },
        note:
          'Columns listed under sensitiveColumns hold application-encrypted credential ' +
          'material (ciphertext, not plaintext). Transfer this packet over a secure channel.',
      };

      const manifestPath = path.join(packetDir, 'MANIFEST.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      writeReadme(packetDir, manifest);
      writeChecksums(packetDir);

      console.log('\n=== RESULT ===');
      console.log(`tables: ${tables.length} | total rows: ${totalRows}`);
      console.log(`integrity_check      : ${integrity}`);
      console.log(`all counts match     : ${allMatch}`);
      console.log(`source untouched     : ${sourceUntouched}`);
      console.log(`packet: ${packetDir}`);

      if (!allMatch || integrity !== 'ok' || !sourceUntouched) {
        console.error('\nFAILED: packet did not verify cleanly.');
        process.exit(1);
      }
      console.log('\nPACKET OK');
    })
    .catch((err) => {
      console.error('FATAL during snapshot/verify:', err);
      process.exit(1);
    });
}

function writeReadme(packetDir, manifest) {
  const rows = manifest.tables
    .map((t) => `| ${t.table} | ${t.rowCount} | ${t.exportSha256.slice(0, 16)}… |`)
    .join('\n');

  const md = `# crawler-POD — SQLite crawl data packet

Generated: ${manifest.generatedAt}
Source: \`${manifest.source.path}\` (journal mode: ${manifest.source.journalMode})

This packet contains the complete crawl dataset held in the project's SQLite
database at the time of generation. The source database was opened read-only
and **was not modified** (verified: \`sourceUntouched = ${manifest.verdict.sourceUntouched}\`).

## Contents

| Path | What it is |
|---|---|
| \`collector.snapshot.db\` | Consistent single-file SQLite snapshot. Produced with SQLite's Online Backup API, so it **includes WAL contents** — a plain file copy of a WAL-mode database would have missed recent writes. |
| \`schema/schema.sql\` | Full DDL: every table and index, exactly as defined in the source. |
| \`export/<table>.json\` | One JSON array per table containing every row. Portable, engine-independent. |
| \`MANIFEST.json\` | Row counts, per-file SHA-256, and the snapshot verification results. |
| \`checksums.sha256\` | SHA-256 for every file in this packet. |

## Totals

- Tables: **${manifest.totals.tables}**
- Rows: **${manifest.totals.rows}**
- Snapshot \`PRAGMA integrity_check\`: **${manifest.snapshot.integrityCheck}**
- All table counts match between source and snapshot: **${manifest.verdict.allTableCountsMatch}**

| Table | Rows | Export SHA-256 |
|---|---:|---|
${rows}

## How to verify this packet

Check every file against the recorded checksums:

\`\`\`bash
sha256sum -c checksums.sha256
\`\`\`

Confirm the snapshot opens and its row counts match \`MANIFEST.json\`:

\`\`\`bash
sqlite3 collector.snapshot.db "PRAGMA integrity_check;"
sqlite3 collector.snapshot.db "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
sqlite3 collector.snapshot.db "SELECT COUNT(*) FROM runs;"
\`\`\`

## Sensitive material

${manifest.note}

Affected columns:

${manifest.tables
  .filter((t) => t.sensitiveColumns.length)
  .map((t) => `- \`${t.table}\`: ${t.sensitiveColumns.map((c) => `\`${c}\``).join(', ')}`)
  .join('\n') || '- none'}
`;
  fs.writeFileSync(path.join(packetDir, 'README.md'), md, 'utf8');
}

function writeChecksums(packetDir) {
  const lines = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== 'checksums.sha256') {
        const rel = path.relative(packetDir, full).replace(/\\/g, '/');
        lines.push(`${sha256File(full)}  ${rel}`);
      }
    }
  };
  walk(packetDir);
  fs.writeFileSync(path.join(packetDir, 'checksums.sha256'), lines.join('\n') + '\n', 'utf8');
}

main();
