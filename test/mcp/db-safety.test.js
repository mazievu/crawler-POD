'use strict';

/**
 * src/mcp/db.js used to open ./data/collector.db directly with a read-only
 * better-sqlite3 handle (readonly: true, fileMustExist: true, and immediate
 * `PRAGMA query_only = ON`). It has been ported to read PostgreSQL instead
 * (see that file's own module doc): createReadOnlyDb() is now ASYNC, takes
 * no `{ dbPath }` option, and talks to Postgres either via a dedicated
 * pg.Pool (src/database/pg-client.js) or, when PG_MODE=pglite, via the
 * app's own mcp-bridge HTTP endpoint (src/routes/mcp-bridge.js).
 *
 * These tests never open a real PostgreSQL/PGlite connection — per the
 * task's environment rule ("if a test needs the DB layer, stub it"), the
 * ONLY thing stubbed is the actual network driver that pg-client.js's
 * createPool() hands back. Everything above that — PgDatabase, Statement,
 * translateDialect, translateParams, and all of src/mcp/db.js's own SQL —
 * still runs for REAL, so these tests exercise db.js's actual SQL text and
 * actual parameter binding, not a hand-written imitation of it.
 *
 * HOW THE STUB WORKS
 * pg-client.js's `createPool` export is destructured by src/mcp/db.js at
 * require-time into a local const. So the monkeypatch below replaces
 * pg-client.js's `createPool` property with a stable wrapper BEFORE the
 * first `require('../../src/mcp/db')` in this process — the wrapper reads a
 * mutable closure variable (`currentDriver`), so later tests can swap fake
 * drivers freely even though db.js's own reference to `createPool` itself
 * never changes after that first require.
 */

const test = require('node:test');
const assert = require('node:assert');

delete process.env.PG_MODE; // force the direct pg.Pool branch, never the pglite bridge

const pgClient = require('../../src/database/pg-client');
let currentDriver = null;
pgClient.createPool = () => currentDriver;

const { createReadOnlyDb } = require('../../src/mcp/db');
const { assertReadOnlySql } = require('../../src/routes/mcp-bridge');

/**
 * A fake node-postgres-shaped driver. PgDatabase/Statement (pg-client.js)
 * only ever call `.query(text, values)` and `.end()` on it — never anything
 * SQLite-specific — so this is a faithful stand-in for a real pg.Pool.
 * `handlers` is tried in order; the first whose `match` regex tests true
 * against the (already dialect-translated) SQL text answers the query.
 */
function createFakeDriver(handlers) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      const handler = handlers.find((h) => h.match.test(text));
      if (!handler) throw new Error(`fake pg driver: no canned handler for query:\n${text}`);
      return handler.respond(text, values);
    },
    async end() {},
  };
}

const OK_HANDLER = { match: /^SELECT 1 AS ok$/, respond: () => ({ rows: [{ ok: 1 }] }) };
const TABLES_PRESENT_HANDLER = {
  match: /information_schema\.tables/,
  respond: () => ({ rows: [{ table_name: 'platforms' }, { table_name: 'runs' }, { table_name: 'snapshots' }] }),
};

test('createReadOnlyDb: rejects (does not silently return empty data) when PostgreSQL is unreachable', async () => {
  currentDriver = createFakeDriver([
    { match: /^SELECT 1 AS ok$/, respond: () => { throw new Error('ECONNREFUSED 127.0.0.1:1'); } },
  ]);

  await assert.rejects(
    () => createReadOnlyDb(),
    (err) => {
      assert.strictEqual(err.code, 'PG_CONNECT_FAILED');
      assert.match(err.message, /Could not reach PostgreSQL/);
      return true;
    }
  );
});

test('createReadOnlyDb: rejects when PostgreSQL is missing a required table', async () => {
  currentDriver = createFakeDriver([
    OK_HANDLER,
    { match: /information_schema\.tables/, respond: () => ({ rows: [{ table_name: 'platforms' }] }) }, // runs, snapshots missing
  ]);

  await assert.rejects(() => createReadOnlyDb(), /missing required table\(s\): runs, snapshots/);
});

test('createReadOnlyDb: exposes no raw SQL/write surface — only the five named read methods, dbPath, and close()', async () => {
  currentDriver = createFakeDriver([OK_HANDLER, TABLES_PRESENT_HANDLER]);
  const db = await createReadOnlyDb();

  assert.deepStrictEqual(Object.keys(db).sort(), [
    'close',
    'dbPath',
    'getInsightsSummary',
    'getItemByUid',
    'getItemHistory',
    'listPlatformsWithStats',
    'searchItems',
  ]);
  // The old SQLite wrapper exposed `.db`, a raw better-sqlite3 handle, that
  // any caller could run arbitrary SQL against (mitigated only by the
  // engine-level PRAGMA query_only lock). There is no such escape hatch at
  // all on the new contract — no raw handle, no prepare/exec/query passthrough.
  assert.strictEqual(db.db, undefined);
  assert.strictEqual(db.prepare, undefined);
  assert.strictEqual(db.exec, undefined);
  assert.strictEqual(db.query, undefined);

  await db.close();
});

test('createReadOnlyDb: every SQL statement its methods issue is a single read-only SELECT/WITH (no write/DDL keyword, ever)', async () => {
  currentDriver = createFakeDriver([
    OK_HANDLER,
    TABLES_PRESENT_HANDLER,
    { match: /stats\.item_count/, respond: () => ({ rows: [] }) }, // listPlatformsWithStats
    { match: /latest_snapshots/, respond: () => ({ rows: [] }) }, // searchItems
    { match: /first_s\.first_seen_at/, respond: () => ({ rows: [] }) }, // getItemByUid
    { match: /run_query/, respond: () => ({ rows: [] }) }, // getItemHistory
    { match: /price_known_count/, respond: () => ({ rows: [{}] }) }, // getInsightsSummary stats
    { match: /GROUP BY s\.platform/, respond: () => ({ rows: [] }) }, // getInsightsSummary platform dist
    { match: /GROUP BY s\.status/, respond: () => ({ rows: [] }) }, // getInsightsSummary status dist
  ]);

  const db = await createReadOnlyDb();
  await db.listPlatformsWithStats();
  await db.searchItems({ keyword: 'nails', platform: 'etsy' });
  await db.getItemByUid('etsy:item1');
  await db.getItemHistory('etsy:item1', {});
  await db.getInsightsSummary({});
  await db.close();

  assert.ok(currentDriver.calls.length >= 7, 'expected connectivity + table check + 5 data queries');
  for (const { text } of currentDriver.calls) {
    // Reuses the SAME validator the bridge applies to arbitrary caller SQL
    // (src/routes/mcp-bridge.js, already covered by test/routes/mcp-bridge.test.js).
    // db.js's own SQL is fixed, not caller-built, so it does not run through
    // that validator in production — but it is a real, honest property that
    // every statement db.js issues would ALSO pass it.
    assert.doesNotThrow(() => assertReadOnlySql(text), `not a safe read-only statement:\n${text}`);
  }
});

test('createReadOnlyDb: searchItems binds attacker-controlled input as parameters — it never gets concatenated into SQL text', async () => {
  currentDriver = createFakeDriver([
    OK_HANDLER,
    TABLES_PRESENT_HANDLER,
    { match: /latest_snapshots/, respond: () => ({ rows: [] }) },
  ]);

  const db = await createReadOnlyDb();

  // Keyword is tokenized into wildcarded %term% bind values (see db.js's
  // searchItems), never inlined into the SQL string.
  const keywordPayload = "' OR 1=1 --";
  const searchByKeyword = await db.searchItems({ keyword: keywordPayload });
  assert.strictEqual(searchByKeyword.rows.length, 0);

  // Platform is bound verbatim as a single parameter, never inlined either.
  const platformPayload = "etsy' UNION SELECT 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24 --";
  const searchByPlatform = await db.searchItems({ platform: platformPayload });
  assert.strictEqual(searchByPlatform.rows.length, 0);

  await db.close();

  const searchCalls = currentDriver.calls.filter((c) => /latest_snapshots/.test(c.text));
  assert.strictEqual(searchCalls.length, 2);

  for (const call of searchCalls) {
    assert.ok(!call.text.includes('UNION SELECT'), `injected SQL leaked into query text:\n${call.text}`);
    assert.ok(!call.text.includes('1=1'), `injected SQL leaked into query text:\n${call.text}`);
    assert.ok(/\$\d/.test(call.text), `expected $n bind placeholders, got:\n${call.text}`);
  }

  // The platform payload reaches Postgres only as a bound value, verbatim.
  assert.ok(searchCalls[1].values.includes(platformPayload));
});
