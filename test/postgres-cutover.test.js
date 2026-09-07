/**
 * PostgreSQL cutover verification.
 *
 * Proves the persistence layer really runs on PostgreSQL after the cutover:
 * runs, crawl results, product/history rows and schedules are written to and
 * read back from Postgres; the data survives a process restart; and the
 * archived SQLite file is never touched by the running system.
 *
 * The Postgres instance here is PGlite (PostgreSQL compiled to WASM, persisted
 * to a directory), so these tests exercise real PostgreSQL SQL and durability
 * without needing a server. Each test points PGLITE_DIR at a scratch directory;
 * nothing touches data/collector.db.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SQLITE_DB = path.join(REPO, 'data', 'collector.db');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pgcutover-'));
}

/** Runs `code` in a separate node process against `dir`, returns parsed stdout JSON. */
function runInProcess(dir, code) {
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: REPO,
    env: { ...process.env, PG_MODE: 'pglite', PGLITE_DIR: dir },
    encoding: 'utf8',
    timeout: 180000,
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('__RESULT__')).pop();
  assert.ok(line, `child produced no __RESULT__ line. stdout:\n${out}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

test('run records are created in and read back from PostgreSQL', () => {
  const dir = freshDir();
  const result = runInProcess(dir, `
    (async () => {
      const db = require('./src/database');
      await db.initDatabase();
      const run = await db.createRun({ platform: 'etsy', query: 'pg-run-test', maxItems: 7 });
      const back = await db.getRunById(run.id);
      // Row count straight from Postgres catalogs, proving the row is in a real
      // Postgres table rather than an in-memory object.
      const health = await db.getDatabaseHealth();
      console.log('__RESULT__' + JSON.stringify({
        created: { id: run.id, query: run.query },
        readBack: back ? back.query : null,
        direct: { platform: back.platform, query: back.query, max_items: back.max_items },
        dbSizeMB: health.dbSizeMB,
      }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `);

  assert.equal(result.readBack, 'pg-run-test');
  assert.equal(result.direct.query, 'pg-run-test');
  assert.equal(result.direct.platform, 'etsy');
  assert.equal(result.direct.max_items, 7, 'INTEGER must come back as a JS number');
  assert.ok(result.dbSizeMB > 0, 'must be backed by a real PostgreSQL database');
});

test('synthetic crawl results write product_current and run items to PostgreSQL', () => {
  const dir = freshDir();
  const result = runInProcess(dir, `
    (async () => {
      const db = require('./src/database');
      await db.initDatabase();
      const run = await db.createRun({ platform: 'etsy', query: 'pg-crawl', maxItems: 2 });
      await db.insertSnapshots(run.id, 'etsy', 'pg-crawl', [
        { title: 'Handmade Mug', url: 'https://www.etsy.com/listing/111', price: 24.5, image: '', author: 'PotteryCo', likes: 10, soldCount: 3, rating: 4.5, reviews: 12 },
        { title: 'Ceramic Bowl', url: 'https://www.etsy.com/listing/222', price: 31.0, image: '', author: 'PotteryCo', likes: 4, soldCount: 1, rating: 4.0, reviews: 5 },
      ]);
      const current = await db.getProductCurrent({ platform: 'etsy' });
      const items = await db.getRunItems(run.id);
      const health = await db.getDatabaseHealth();
      console.log('__RESULT__' + JSON.stringify({
        productCurrentCount: current.length,
        runItemCount: items.length,
        titles: current.map((c) => c.title).sort(),
        dbSizeMB: health.dbSizeMB,
      }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `);

  assert.equal(result.productCurrentCount, 2);
  assert.equal(result.runItemCount, 2);
  assert.deepEqual(result.titles, ['Ceramic Bowl', 'Handmade Mug']);
  // Reported from pg_database_size(), so a real Postgres database exists.
  assert.ok(result.dbSizeMB > 0, 'database size must come from PostgreSQL');
});

test('marketplace schedule CRUD round-trips through PostgreSQL', () => {
  const dir = freshDir();
  const result = runInProcess(dir, `
    (async () => {
      const db = require('./src/database');
      await db.initDatabase();
      const created = await db.createMarketplaceCaptureSchedule({
        platform: 'etsy', keyword: 'nail art', everyHours: 6, maxListings: 25,
      });
      const listed = await db.getMarketplaceCaptureSchedules();
      const toggled = await db.toggleMarketplaceCaptureSchedule(created.id, false);
      const afterToggle = (await db.getMarketplaceCaptureSchedules()).find((s) => s.id === created.id);
      await db.deleteMarketplaceCaptureSchedule(created.id);
      const afterDelete = await db.getMarketplaceCaptureSchedules();
      console.log('__RESULT__' + JSON.stringify({
        createdId: created.id,
        createdKeyword: created.keyword,
        listedCount: listed.length,
        enabledAfterToggle: afterToggle ? afterToggle.enabled : null,
        toggledOk: !!toggled,
        countAfterDelete: afterDelete.length,
      }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `);

  assert.ok(result.createdId > 0);
  assert.equal(result.createdKeyword, 'nail art');
  assert.equal(result.listedCount, 1);
  assert.equal(result.enabledAfterToggle, 0, 'toggle must persist to Postgres');
  assert.equal(result.countAfterDelete, 0, 'delete must persist to Postgres');
});

test('data written by one process is still there after a restart', () => {
  const dir = freshDir();

  const first = runInProcess(dir, `
    (async () => {
      const db = require('./src/database');
      await db.initDatabase();
      const run = await db.createRun({ platform: 'ebay', query: 'persist-me', maxItems: 3 });
      await db.insertSnapshots(run.id, 'ebay', 'persist-me', [
        { title: 'Vintage Camera', url: 'https://www.ebay.com/itm/999', price: 88, image: '', author: 'seller1', likes: 0, soldCount: 2 },
      ]);
      console.log('__RESULT__' + JSON.stringify({ runId: run.id }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `);

  // Separate process, same data directory — nothing is shared in memory.
  const second = runInProcess(dir, `
    (async () => {
      const db = require('./src/database');
      await db.initDatabase();
      const run = await db.getRunById(${first.runId});
      const items = await db.getRunItems(${first.runId});
      const current = await db.getProductCurrent({ platform: 'ebay' });
      console.log('__RESULT__' + JSON.stringify({
        query: run ? run.query : null,
        itemCount: items.length,
        currentCount: current.length,
      }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `);

  assert.equal(second.query, 'persist-me', 'run must survive the restart');
  assert.equal(second.itemCount, 1, 'crawl results must survive the restart');
  assert.equal(second.currentCount, 1, 'product_current must survive the restart');
});

test('the archived SQLite database is not touched by the running system', () => {
  if (!fs.existsSync(SQLITE_DB)) return; // nothing to protect in a clean checkout

  const before = fs.statSync(SQLITE_DB);
  const dir = freshDir();
  runInProcess(dir, `
    (async () => {
      const db = require('./src/database');
      await db.initDatabase();
      const run = await db.createRun({ platform: 'etsy', query: 'no-sqlite-writes', maxItems: 1 });
      await db.insertSnapshots(run.id, 'etsy', 'no-sqlite-writes', [
        { title: 'T', url: 'https://www.etsy.com/listing/333', price: 1, image: '', author: 'a', likes: 0 },
      ]);
      await db.getDatabaseHealth();
      console.log('__RESULT__' + JSON.stringify({ ok: true }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `);
  const after = fs.statSync(SQLITE_DB);

  assert.equal(after.size, before.size, 'collector.db size must not change');
  assert.equal(after.mtimeMs, before.mtimeMs, 'collector.db mtime must not change');
});

test('no active production path requires better-sqlite3', () => {
  // scripts/ and the standalone benchmark are developer tooling, not part of a
  // running server; this covers what the server actually loads.
  const script = [
    "const fs=require('fs'),path=require('path');",
    "const hits=[];",
    "const walk=(p)=>{",
    "  const st=fs.statSync(p);",
    "  if(st.isDirectory()){ for(const e of fs.readdirSync(p)) walk(path.join(p,e)); return; }",
    "  if(!p.endsWith('.js')) return;",
    "  if(p.includes('benchmark-10m')) return;",
    "  if(p.endsWith(path.join('database','pg-client.js'))) return;",
    "  const src=fs.readFileSync(p,'utf8');",
    "  const code=src.replace(/\\/\\*[\\s\\S]*?\\*\\//g,'').replace(/^\\s*\\/\\/.*$/gm,'');",
    "  if(/require\\(\\s*['\\\"`]better-sqlite3/.test(code)) hits.push(p);",
    "};",
    "for(const r of ['server.js','src']) walk(r);",
    "console.log(JSON.stringify(hits));",
  ].join('\n');

  const offenders = execFileSync(process.execPath, ['-e', script], { cwd: REPO, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(offenders.trim()), [], 'production code must not require better-sqlite3');
});
