'use strict';

/**
 * OLD CONTRACT (removed here, not replaced 1:1 — see WHY below):
 * The pre-migration src/mcp/db.js opened ./data/collector.db directly with a
 * read-only better-sqlite3 handle, and this file proved a WRITER connection
 * (the collector, in SQLite WAL journal mode) and this READER connection
 * could operate concurrently on the same on-disk file without conflicting or
 * corrupting each other — a real, SQLite-specific guarantee (WAL allows one
 * writer + many readers against the same file).
 *
 * WHY THAT TEST IS STALE, NOT JUST "IMPLEMENTATION CHANGED":
 * There is no SQLite file left in this flow at all, so there is nothing left
 * to test in the old shape:
 *   - Against a real PostgreSQL SERVER (PG_MODE unset), concurrent
 *     reader/writer safety is PostgreSQL's own MVCC engine guarantee — not
 *     something src/mcp/db.js implements, and not something a unit test in
 *     this repo should be asserting on Postgres's behalf.
 *   - Against PGlite (PG_MODE=pglite), the situation is the OPPOSITE of the
 *     old test's premise: PGlite allows only ONE process to open its data
 *     directory at all. A second concurrent opener is exactly the corruption
 *     hazard src/routes/mcp-bridge.js exists to prevent (see that file's
 *     module doc, and src/mcp/db.js's). There is no "two connections safely
 *     concurrent" scenario to prove here, because the architecture's whole
 *     point is that a second connection must never be opened in the first
 *     place.
 * A smaller, honest suite beats a larger, dishonest one — fabricating a fake
 * "concurrency" test against a stubbed driver would prove nothing real.
 *
 * NEW CONTRACT TESTED HERE INSTEAD:
 * The actual guarantee this codebase now provides is "never open a second
 * PGlite connection, and fail loudly rather than silently if the one
 * legitimate path (the app's mcp-bridge) is unreachable" — see
 * src/mcp/db.js's module doc and its crawlerUnreachableError(). That is what
 * the tests below verify: by intercepting pg-client.js's createPool() (
 * proving it is never called when PG_MODE=pglite) and pointing the bridge at
 * an address nothing listens on (proving the failure is loud and actionable,
 * never a silent empty result). A third test contrasts the real-PostgreSQL
 * branch, which DOES open its own pg.Pool, because a real server safely
 * accepts many concurrent connections (see src/mcp/db.js's module doc).
 *
 * As with test/mcp/db-safety.test.js, no real PostgreSQL/PGlite connection
 * is ever opened here — only pg-client.js's createPool() is stubbed, and the
 * pglite-mode tests point CRAWLER_BASE_URL at a closed local port so the
 * bridge HTTP call fails fast instead of reaching this machine's real,
 * possibly-running, crawler-POD app server.
 */

const test = require('node:test');
const assert = require('node:assert');

const pgClient = require('../../src/database/pg-client');
let createPoolCalls = 0;

/** A minimal working driver: answers the table-existence check with the
 *  three required tables so createReadOnlyDb() can succeed end-to-end when
 *  the direct-PostgreSQL branch is exercised. */
function makeWorkingDriver() {
  return {
    async query(text) {
      if (/information_schema\.tables/.test(text)) {
        return { rows: [{ table_name: 'platforms' }, { table_name: 'runs' }, { table_name: 'snapshots' }] };
      }
      return { rows: [] };
    },
    async end() {},
  };
}

pgClient.createPool = () => {
  createPoolCalls++;
  return makeWorkingDriver();
};

const { createReadOnlyDb } = require('../../src/mcp/db');

test("createReadOnlyDb (PG_MODE=pglite): never opens a second PGlite connection — it never calls pg-client's createPool()", async () => {
  process.env.PG_MODE = 'pglite';
  process.env.CRAWLER_BASE_URL = 'http://127.0.0.1:1'; // nothing listens on port 1; refused fast, no live app touched
  createPoolCalls = 0;

  await assert.rejects(
    () => createReadOnlyDb(),
    (err) => {
      assert.strictEqual(err.code, 'CRAWLER_POD_UNREACHABLE');
      return true;
    }
  );

  assert.strictEqual(createPoolCalls, 0, 'PG_MODE=pglite must never open a direct PostgreSQL/PGlite connection of its own');

  delete process.env.PG_MODE;
  delete process.env.CRAWLER_BASE_URL;
});

test("createReadOnlyDb (PG_MODE=pglite): fails loudly and actionably when the app's mcp-bridge is unreachable — never a silent empty result", async () => {
  process.env.PG_MODE = 'pglite';
  process.env.CRAWLER_BASE_URL = 'http://127.0.0.1:1';

  await assert.rejects(
    () => createReadOnlyDb(),
    (err) => {
      assert.match(err.message, /must read PostgreSQL through the crawler-POD app/);
      assert.match(err.message, /http:\/\/127\.0\.0\.1:1/);
      return true;
    }
  );

  delete process.env.PG_MODE;
  delete process.env.CRAWLER_BASE_URL;
});

test('createReadOnlyDb (PG_MODE unset — real PostgreSQL server): DOES use a dedicated pg.Pool, because a real server safely accepts concurrent connections', async () => {
  delete process.env.PG_MODE;
  createPoolCalls = 0;

  const db = await createReadOnlyDb();
  await db.close();

  assert.strictEqual(createPoolCalls, 1, 'the direct-server branch must open its own pg.Pool via createPool()');
});
