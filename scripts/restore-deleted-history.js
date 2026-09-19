#!/usr/bin/env node
'use strict';

/**
 * restore-deleted-history.js — re-insert the rows that commit 4095e5e deleted.
 *
 * WHAT THIS IS FOR
 * ----------------
 * On 2026-09-16 commit 4095e5e ("db cleanup / empty items") deleted rows it
 * judged to be "junk items with no data":
 *
 *     product_current           88 rows   (reddit 83, amazon 2, facebook_posts 1,
 *                                          twitter 1, ebay 1 — all with image='')
 *     snapshots                607 rows
 *     daily_packed_history     135 rows
 *
 * Those are exactly the imageless rows that were supposed to be KEPT. Before
 * deleting, it wrote a backup to
 *
 *     docs/BACKUPS/2026-09-16/db-cleanup-empty-items/
 *         candidate_deleted_items_product_current.json   (88 rows, 17 columns)
 *         candidate_deleted_snapshots.json               (607 rows, 10 columns)
 *         candidate_deleted_daily_packed_history.json    (135 rows, 14 columns)
 *         pgdata/                                        (complete pre-deletion DB)
 *
 * This script puts back whatever of that is genuinely missing from the live
 * database, and nothing else.
 *
 * READ THIS BEFORE RUNNING — IT IS PROBABLY A NO-OP
 * -------------------------------------------------
 * Verified against the live database on 2026-09-18 via the loopback read-only
 * SQL bridge: all 88 product_current rows, all 607 snapshots rows and all 135
 * daily_packed_history rows are ALREADY PRESENT, at their original ids, with
 * their original (item_uid, date) / (run_id, item_uid) keys and their original
 * timestamps. The live product_current rows also carry columns the JSON backup
 * never captured (last_run_id, status, rank_score, observation_count,
 * first_seen_at), which a JSON-based restore could not have produced — so the
 * live rows are the ORIGINAL pre-deletion rows, recovered when the data
 * directory was restored from the pgdata copy, not a reconstruction.
 *
 * Consequence: an earlier restore attempt reporting "daily_packed_history
 * inserted 0" was CORRECT BEHAVIOUR — ON CONFLICT DO NOTHING found all 135 rows
 * already there. The `null value in column "query"` error on snapshots was a
 * defect in the backup EXPORTER (it captured 10 of the 22 snapshot columns and
 * omitted the NOT NULL `query` and `raw_data`), not evidence of missing rows.
 *
 * Run this script anyway as a verifier. Expected output today:
 *
 *     product_current      :  88 expected /  88 present /   0 missing
 *     snapshots            : 607 expected / 607 present /   0 missing
 *     daily_packed_history : 135 expected / 135 present /   0 missing
 *     NOTHING TO RESTORE.
 *
 * SAFETY
 * ------
 * PGlite is single-process. Opening data/pgdata while the server holds it
 * corrupts the directory (this already happened once, on 2026-09-18, and cost a
 * full restore). This script therefore REFUSES TO RUN unless the server is
 * stopped — it checks both the HTTP port and data/pgdata/postmaster.pid.
 *
 * It never opens the backup pgdata copy in place either: when it needs complete
 * rows it copies that directory to a scratch location first and opens the copy,
 * so the only complete pre-deletion backup is never mutated by WAL recovery.
 *
 * USAGE
 * -----
 *     node scripts/restore-deleted-history.js              # verify only (default)
 *     node scripts/restore-deleted-history.js --apply      # actually insert
 *
 * Options:
 *     --apply                   Perform the inserts. Without it nothing is written.
 *     --source=auto|pgdata|json Where complete rows come from when something IS
 *                               missing. Default `auto` = pgdata copy if present,
 *                               else json. Only consulted when missing > 0.
 *     --skip-product-current    Verify product_current but never insert into it.
 *     --port=N                  Extra port to probe for a running server.
 *
 * WHY pgdata IS THE DEFAULT SOURCE
 * --------------------------------
 * The JSON exports are column-truncated:
 *   - snapshots.json has 10 of 22 columns and is missing BOTH NOT NULL columns
 *     `query` and `raw_data`. `query` is derivable from runs.query; `raw_data`
 *     is NOT derivable — it is the original provider payload and can only be
 *     approximated, never recovered, from the 10 captured columns.
 *   - product_current.json has 17 of ~40 columns; last_run_id, status,
 *     observation_count, rank_score, first_seen_at and every prev_/delta_
 *     column are absent, so a JSON restore silently downgrades a row to schema
 *     defaults.
 *   - daily_packed_history.json is the only complete one (all 14 columns).
 * The pgdata copy is a byte-level pre-deletion database and has every column,
 * so it is the correct source. --source=json exists only as a fallback and,
 * for snapshots, writes a clearly-marked reconstructed raw_data (see below).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'docs', 'BACKUPS', '2026-09-16', 'db-cleanup-empty-items');
const BACKUP_PGDATA = path.join(BACKUP_DIR, 'pgdata');
const LIVE_PGDATA = process.env.PGLITE_DIR || path.join(ROOT, 'data', 'pgdata');

const FILES = {
  product_current: path.join(BACKUP_DIR, 'candidate_deleted_items_product_current.json'),
  snapshots: path.join(BACKUP_DIR, 'candidate_deleted_snapshots.json'),
  daily_packed_history: path.join(BACKUP_DIR, 'candidate_deleted_daily_packed_history.json'),
};

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const APPLY = has('--apply');
const SKIP_PRODUCT_CURRENT = has('--skip-product-current');
const SOURCE = valueOf('source', 'auto');
const EXTRA_PORT = Number(valueOf('port', '')) || null;

if (!['auto', 'pgdata', 'json'].includes(SOURCE)) {
  console.error(`FATAL: --source must be auto|pgdata|json, got "${SOURCE}"`);
  process.exit(2);
}

const log = (...a) => console.log(...a);
const section = (t) => log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);

// ---------------------------------------------------------------------------
// GUARD: the server must not be running.
//
// Two independent checks, because either one alone can be fooled:
//   1. a TCP connect to the HTTP port — catches a server that is up even if
//      postmaster.pid was never written;
//   2. data/pgdata/postmaster.pid with a LIVE owning process — catches a
//      process that holds the data directory without serving HTTP.
// A postmaster.pid whose pid is dead is a stale file from an unclean exit and
// is only a warning; refusing on it would make the script unrunnable after
// every crash.
//
// MEASURED 2026-09-18: PGlite writes the sentinel pid "-42" into
// data/pgdata/postmaster.pid rather than a real OS pid, so check (2) never
// fires in this deployment — it exists for a real postgres data directory.
// The TCP probe is the guard that actually protects the database here, which
// is why it runs first and is unconditional.
// ---------------------------------------------------------------------------
function probePort(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function assertServerDown() {
  section('GUARD — the server must be stopped');

  const ports = new Set([20129, Number(process.env.PORT) || 3000]);
  if (EXTRA_PORT) ports.add(EXTRA_PORT);

  for (const port of ports) {
    if (await probePort(port)) {
      console.error(
        `\nREFUSING TO RUN: something is listening on 127.0.0.1:${port}.\n` +
        `The crawler-POD server holds data/pgdata open and PGlite is single-process —\n` +
        `opening it from here would corrupt the data directory.\n\n` +
        `Stop the server, then re-run this script.`
      );
      process.exit(3);
    }
    log(`  port ${port}: closed  OK`);
  }

  const pidFile = path.join(LIVE_PGDATA, 'postmaster.pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).split(/\r?\n/)[0].trim());
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
    if (alive) {
      console.error(
        `\nREFUSING TO RUN: ${pidFile} names pid ${pid}, which is still alive.\n` +
        `Another process holds the data directory. Stop it, then re-run.`
      );
      process.exit(3);
    }
    log(`  postmaster.pid present but pid ${pid || '?'} is not running — stale, continuing`);
  } else {
    log('  postmaster.pid: absent  OK');
  }
}

// ---------------------------------------------------------------------------
// PGlite (ESM-only, so it has to be dynamically imported)
// ---------------------------------------------------------------------------
async function openPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dir);
  await db.query('SELECT 1');
  return db;
}

const rowsOf = (result) => (result && Array.isArray(result.rows) ? result.rows : []);

function readJson(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} is not a JSON array`);
  return parsed;
}

// ---------------------------------------------------------------------------
// VERIFY — which backup rows are actually absent from the live database?
//
// Compared on the row's REAL identity, never on id:
//   product_current       item_uid                 (primary key)
//   snapshots             (run_id, item_uid)       one observation of one item
//                                                  in one run; snapshots has no
//                                                  unique constraint, so this is
//                                                  enforced by the script
//   daily_packed_history  (item_uid, date)         the table's UNIQUE key
// Using id would be wrong: an id freed by the delete can since have been taken
// by an unrelated row, which would make a present row look missing and an
// absent row look present.
// ---------------------------------------------------------------------------
async function verify(live, backup) {
  section('VERIFY — what is actually missing from the live database');

  const platforms = [...new Set(backup.product_current.map((r) => r.platform))];
  if (!platforms.length) throw new Error('backup product_current export names no platform — refusing to build an empty IN () list');
  const platformList = platforms.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(',');
  log(`  platforms touched by the backup: ${platforms.join(', ')}`);

  const livePc = new Set(
    rowsOf(await live.query(`SELECT item_uid FROM product_current WHERE platform IN (${platformList})`))
      .map((r) => r.item_uid)
  );
  const liveSnapKeys = new Set(
    rowsOf(await live.query(`SELECT run_id, item_uid FROM snapshots WHERE platform IN (${platformList})`))
      .map((r) => `${r.run_id} ${r.item_uid}`)
  );
  const liveSnapIds = new Set(
    rowsOf(await live.query('SELECT id FROM snapshots')).map((r) => Number(r.id))
  );
  const liveDailyKeys = new Set(
    rowsOf(await live.query(`SELECT item_uid, date FROM daily_packed_history WHERE platform IN (${platformList})`))
      .map((r) => `${r.item_uid} ${r.date}`)
  );
  const liveDailyIds = new Set(
    rowsOf(await live.query('SELECT id FROM daily_packed_history')).map((r) => Number(r.id))
  );

  const missing = {
    product_current: backup.product_current.filter((r) => !livePc.has(r.item_uid)),
    snapshots: backup.snapshots.filter((r) => !liveSnapKeys.has(`${r.run_id} ${r.item_uid}`)),
    daily_packed_history: backup.daily_packed_history.filter(
      (r) => !liveDailyKeys.has(`${r.item_uid} ${r.date}`)
    ),
  };

  log('');
  for (const table of ['product_current', 'snapshots', 'daily_packed_history']) {
    const total = backup[table].length;
    const gone = missing[table].length;
    log(`  ${table.padEnd(22)}: ${String(total).padStart(4)} expected / ${String(total - gone).padStart(4)} present / ${String(gone).padStart(4)} missing`);
  }

  return { missing, liveSnapIds, liveDailyIds };
}

// ---------------------------------------------------------------------------
// SOURCE — complete rows for the keys that are missing.
// ---------------------------------------------------------------------------
async function fetchFromBackupPgdata(missing) {
  section('SOURCE — extracting complete rows from the pgdata backup copy');

  if (!fs.existsSync(BACKUP_PGDATA)) throw new Error(`backup pgdata not found at ${BACKUP_PGDATA}`);

  // Work on a COPY. PGlite writes to a data directory the moment it opens it
  // (WAL replay, pg_stat), so opening the backup in place would mutate the only
  // complete pre-deletion snapshot that exists.
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'crawlerpod-restore-'));
  const copyDir = path.join(scratch, 'pgdata');
  log(`  copying ${BACKUP_PGDATA}\n       -> ${copyDir}  (this is ~800 MB, allow a minute)`);
  await fsp.cp(BACKUP_PGDATA, copyDir, { recursive: true });
  // A postmaster.pid inherited from the source would make PGlite think the
  // directory is in use.
  await fsp.rm(path.join(copyDir, 'postmaster.pid'), { force: true });

  let src;
  try {
    src = await openPglite(copyDir);

    const out = { product_current: [], snapshots: [], daily_packed_history: [] };

    if (missing.product_current.length) {
      const uids = missing.product_current.map((r) => r.item_uid);
      out.product_current = rowsOf(
        await src.query('SELECT * FROM product_current WHERE item_uid = ANY($1)', [uids])
      );
    }
    if (missing.snapshots.length) {
      const runIds = [...new Set(missing.snapshots.map((r) => Number(r.run_id)))];
      const uids = [...new Set(missing.snapshots.map((r) => r.item_uid))];
      const wanted = new Set(missing.snapshots.map((r) => `${r.run_id} ${r.item_uid}`));
      const candidates = rowsOf(
        await src.query('SELECT * FROM snapshots WHERE run_id = ANY($1) AND item_uid = ANY($2)', [runIds, uids])
      );
      out.snapshots = candidates.filter((r) => wanted.has(`${r.run_id} ${r.item_uid}`));
    }
    if (missing.daily_packed_history.length) {
      const uids = [...new Set(missing.daily_packed_history.map((r) => r.item_uid))];
      const wanted = new Set(missing.daily_packed_history.map((r) => `${r.item_uid} ${r.date}`));
      const candidates = rowsOf(
        await src.query('SELECT * FROM daily_packed_history WHERE item_uid = ANY($1)', [uids])
      );
      out.daily_packed_history = candidates.filter((r) => wanted.has(`${r.item_uid} ${r.date}`));
    }

    for (const t of Object.keys(out)) log(`  ${t.padEnd(22)}: recovered ${out[t].length} complete rows`);
    return out;
  } finally {
    if (src) await src.close().catch(() => {});
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    log('  scratch copy removed; the backup itself was not opened or modified');
  }
}

/**
 * JSON fallback. Fills the NOT NULL columns the exporter dropped:
 *
 *   snapshots.query       <- runs.query for that run_id (authoritative: a
 *                            snapshot belongs to exactly one run, and the run
 *                            records the query it was launched with), then
 *                            product_current.query, then refuse the row.
 *   snapshots.created_at  <- runs.created_at, so a restored historical snapshot
 *                            does not land with today's date and distort the
 *                            history chart. Falls back to the column default.
 *   snapshots.raw_data    <- CANNOT be recovered. The original provider payload
 *                            is not in the export. A JSON object rebuilt from
 *                            the 10 captured columns is written instead, tagged
 *                            "_reconstructed": true so nothing downstream
 *                            mistakes it for the real payload.
 */
async function fetchFromJson(live, missing) {
  section('SOURCE — rebuilding rows from the JSON exports');
  console.warn(
    '  WARNING: the JSON snapshot export omits `raw_data` (the original provider\n' +
    '  payload). It will be written as a reconstruction flagged "_reconstructed":true.\n' +
    '  Prefer --source=pgdata whenever the pgdata copy is available.'
  );

  const runIds = [...new Set(missing.snapshots.map((r) => Number(r.run_id)))];
  const runMeta = new Map();
  if (runIds.length) {
    for (const r of rowsOf(await live.query('SELECT id, query, created_at FROM runs WHERE id = ANY($1)', [runIds]))) {
      runMeta.set(Number(r.id), r);
    }
  }
  const uids = [...new Set(missing.snapshots.map((r) => r.item_uid))];
  const uidQuery = new Map();
  if (uids.length) {
    for (const r of rowsOf(await live.query('SELECT item_uid, query FROM product_current WHERE item_uid = ANY($1)', [uids]))) {
      uidQuery.set(r.item_uid, r.query);
    }
  }
  const backupPcQuery = new Map(readJson(FILES.product_current).map((r) => [r.item_uid, r.query]));

  const snapshots = [];
  const refused = [];
  for (const r of missing.snapshots) {
    const run = runMeta.get(Number(r.run_id));
    const query = run?.query ?? uidQuery.get(r.item_uid) ?? backupPcQuery.get(r.item_uid) ?? null;
    if (query == null) {
      refused.push(r);
      continue;
    }
    snapshots.push({
      id: r.id,
      run_id: r.run_id,
      platform: r.platform,
      query,
      item_uid: r.item_uid,
      raw_data: JSON.stringify({
        _reconstructed: true,
        _reason: 'original raw_data was not captured by the 2026-09-16 backup exporter',
        platform: r.platform,
        title: r.title ?? '',
        url: r.url ?? '',
        image: r.image ?? '',
        price: r.price ?? 0,
        likes: r.likes ?? 0,
        comments: r.comments ?? 0,
      }),
      title: r.title ?? '',
      url: r.url ?? '',
      image: r.image ?? '',
      price: r.price ?? 0,
      likes: r.likes ?? 0,
      comments: r.comments ?? 0,
      created_at: run?.created_at ?? null,
    });
  }
  if (refused.length) {
    console.warn(`  REFUSED ${refused.length} snapshot row(s): no run and no product_current row supplies a NOT NULL query. Not fabricating one.`);
  }
  log(`  snapshots            : ${snapshots.length} rows rebuilt`);
  log(`  daily_packed_history : ${missing.daily_packed_history.length} rows (export is complete for this table)`);
  log(`  product_current      : ${missing.product_current.length} rows (17 of ~40 columns; rest take schema defaults)`);

  return {
    product_current: missing.product_current,
    snapshots,
    daily_packed_history: missing.daily_packed_history,
  };
}

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------
function insertStatement(row, { dropId }) {
  const cols = Object.keys(row).filter((c) => !(dropId && c === 'id') && row[c] !== undefined);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const values = cols.map((c) => row[c]);
  return { cols, placeholders, values };
}

async function apply(live, rows, ids) {
  section('APPLY — inserting');

  const inserted = { product_current: [], snapshots: [], daily_packed_history: [] };

  await live.query('BEGIN');
  try {
    // --- product_current: PK item_uid ------------------------------------
    if (!SKIP_PRODUCT_CURRENT) {
      for (const row of rows.product_current) {
        const { cols, placeholders, values } = insertStatement(row, { dropId: false });
        const res = await live.query(
          `INSERT INTO product_current (${cols.map((c) => `"${c}"`).join(',')})
           VALUES (${placeholders.join(',')})
           ON CONFLICT (item_uid) DO NOTHING
           RETURNING item_uid`,
          values
        );
        if (rowsOf(res).length) inserted.product_current.push(row.item_uid);
      }
    } else if (rows.product_current.length) {
      log(`  product_current: ${rows.product_current.length} missing row(s) SKIPPED (--skip-product-current)`);
    }

    // --- snapshots: the table has no unique key besides id, so ON CONFLICT
    //     cannot express "this item already has a row for this run". The
    //     duplicate check is therefore an explicit SELECT immediately before
    //     the INSERT, inside this transaction — which is race-free here
    //     because PGlite is single-process and the server is stopped.
    //
    //     (An `INSERT ... SELECT $1,$2,... WHERE NOT EXISTS (...)` would be one
    //     statement instead of two, but a bare parameterised SELECT with no
    //     FROM clause can leave Postgres unable to infer the parameter types.
    //     Two plain statements avoid that failure mode entirely.)
    //
    //     The original id is preserved only when it is still free; otherwise
    //     the sequence assigns a new one, because an id that an unrelated row
    //     has since taken must not be stolen.
    for (const row of rows.snapshots) {
      const dup = rowsOf(
        await live.query('SELECT 1 FROM snapshots WHERE run_id = $1 AND item_uid = $2 LIMIT 1', [row.run_id, row.item_uid])
      );
      if (dup.length) continue;

      const idFree = row.id != null && !ids.liveSnapIds.has(Number(row.id));
      const payload = { ...row };
      if (payload.created_at == null) delete payload.created_at; // let the column default apply
      const { cols, placeholders, values } = insertStatement(payload, { dropId: !idFree });
      const res = await live.query(
        `INSERT INTO snapshots (${cols.map((c) => `"${c}"`).join(',')})
         VALUES (${placeholders.join(',')})
         RETURNING id`,
        values
      );
      const got = rowsOf(res);
      if (got.length) {
        inserted.snapshots.push(Number(got[0].id));
        ids.liveSnapIds.add(Number(got[0].id));
      }
    }

    // --- daily_packed_history: UNIQUE (item_uid, date) --------------------
    for (const row of rows.daily_packed_history) {
      const idFree = row.id != null && !ids.liveDailyIds.has(Number(row.id));
      const { cols, placeholders, values } = insertStatement(row, { dropId: !idFree });
      const res = await live.query(
        `INSERT INTO daily_packed_history (${cols.map((c) => `"${c}"`).join(',')})
         VALUES (${placeholders.join(',')})
         ON CONFLICT (item_uid, date) DO NOTHING
         RETURNING id`,
        values
      );
      const got = rowsOf(res);
      if (got.length) {
        inserted.daily_packed_history.push(Number(got[0].id));
        ids.liveDailyIds.add(Number(got[0].id));
      }
    }

    // --- sequences --------------------------------------------------------
    // snapshots.id and daily_packed_history.id are
    // INTEGER GENERATED BY DEFAULT AS IDENTITY. Inserting explicit ids does not
    // advance the sequence, so without this the next natural insert would try
    // to reuse an id we just restored and fail on the primary key.
    for (const [table, list] of [['snapshots', inserted.snapshots], ['daily_packed_history', inserted.daily_packed_history]]) {
      if (!list.length) continue;
      const res = await live.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1),
                       true) AS v`
      );
      log(`  setval(${table}.id) -> ${rowsOf(res)[0]?.v}`);
    }

    await live.query('COMMIT');
  } catch (err) {
    await live.query('ROLLBACK').catch(() => {});
    console.error('\nINSERT FAILED — transaction rolled back, database unchanged.');
    throw err;
  }

  return inserted;
}

async function writeUndoManifest(inserted) {
  const total = inserted.product_current.length + inserted.snapshots.length + inserted.daily_packed_history.length;
  if (!total) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const day = stamp.slice(0, 10);
  const dir = path.join(ROOT, 'docs', 'BACKUPS', day, 'restore-deleted-history');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `inserted-${stamp}.json`);
  await fsp.writeFile(file, JSON.stringify({ insertedAt: stamp, ...inserted }, null, 2), 'utf8');

  log(`\n  UNDO MANIFEST: ${file}`);
  log('  To undo exactly this run (server stopped), remove only these keys:');
  if (inserted.snapshots.length) log(`      DELETE FROM snapshots            WHERE id = ANY('{${inserted.snapshots.join(',')}}');`);
  if (inserted.daily_packed_history.length) log(`      DELETE FROM daily_packed_history WHERE id = ANY('{${inserted.daily_packed_history.join(',')}}');`);
  if (inserted.product_current.length) log(`      DELETE FROM product_current      WHERE item_uid IN (see ${path.basename(file)});`);
  return file;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  section('restore-deleted-history — commit 4095e5e recovery');
  log(`  live data dir : ${LIVE_PGDATA}`);
  log(`  backup dir    : ${BACKUP_DIR}`);
  log(`  mode          : ${APPLY ? 'APPLY (will write)' : 'VERIFY ONLY (no writes) — pass --apply to write'}`);
  log(`  source        : ${SOURCE}`);

  for (const [table, file] of Object.entries(FILES)) {
    if (!fs.existsSync(file)) {
      console.error(`FATAL: missing backup export for ${table}: ${file}`);
      process.exit(2);
    }
  }

  await assertServerDown();

  const backup = {
    product_current: readJson(FILES.product_current),
    snapshots: readJson(FILES.snapshots),
    daily_packed_history: readJson(FILES.daily_packed_history),
  };

  let live;
  let exitCode = 0;
  try {
    live = await openPglite(LIVE_PGDATA);

    const { missing, liveSnapIds, liveDailyIds } = await verify(live, backup);
    const totalMissing =
      missing.product_current.length + missing.snapshots.length + missing.daily_packed_history.length;

    if (totalMissing === 0) {
      section('RESULT');
      log('  NOTHING TO RESTORE — every backed-up row is already present in the live database.');
      log('  The change history for all 88 items is intact; no write was performed.');
      return;
    }

    log(`\n  ${totalMissing} row(s) are genuinely missing.`);
    if (!APPLY) {
      section('RESULT');
      log('  VERIFY ONLY — nothing was written.');
      log('  Re-run with --apply to insert the rows listed above.');
      return;
    }

    const useJson = SOURCE === 'json' || (SOURCE === 'auto' && !fs.existsSync(BACKUP_PGDATA));
    const rows = useJson ? await fetchFromJson(live, missing) : await fetchFromBackupPgdata(missing);

    const inserted = await apply(live, rows, { liveSnapIds, liveDailyIds });

    section('RESULT');
    log(`  product_current      : inserted ${inserted.product_current.length}`);
    log(`  snapshots            : inserted ${inserted.snapshots.length}`);
    log(`  daily_packed_history : inserted ${inserted.daily_packed_history.length}`);
    await writeUndoManifest(inserted);
    log('\n  Start the server and confirm with:');
    log('    node scripts/restore-deleted-history.js      # should now report 0 missing');
  } catch (err) {
    exitCode = 1;
    console.error('\nERROR:', err && err.stack ? err.stack : err);
  } finally {
    if (live) await live.close().catch(() => {});
    log('\n  live database closed.');
    process.exit(exitCode);
  }
})();
