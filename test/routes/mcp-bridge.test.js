'use strict';

/**
 * Unit tests for src/routes/mcp-bridge.js — the loopback-only, read-only SQL
 * passthrough MCP processes use instead of opening PGLITE_DIR a second time
 * (see that file's module doc, and mcp/crawler-pod-server.mjs / src/mcp/db.js,
 * both of which route through it when PG_MODE=pglite).
 *
 * Deliberately does NOT require src/database.js or src/database/pg-client.js:
 * the `database` dependency is a plain stub with an in-memory `_connection`,
 * so these tests never open a real PostgreSQL/PGlite connection or touch
 * data/pgdata. The router is exercised over a real loopback HTTP server
 * (127.0.0.1), which is also what exercises the loopback-allow path of the
 * request-origin check for free; the reject path is covered directly via
 * isLoopbackAddress(), since simulating a genuinely non-loopback
 * req.socket.remoteAddress needs a real remote peer.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createMcpBridgeRouter, assertReadOnlySql, isLoopbackAddress, QUERY_PATH } = require('../../src/routes/mcp-bridge');

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

test('assertReadOnlySql: accepts a single SELECT or WITH statement', () => {
  assert.strictEqual(assertReadOnlySql('SELECT * FROM runs'), 'SELECT * FROM runs');
  assert.strictEqual(assertReadOnlySql('  select id from runs  '), 'select id from runs');
  assert.doesNotThrow(() => assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x'));
});

test('assertReadOnlySql: strips a single trailing semicolon and trailing comment/whitespace', () => {
  assert.strictEqual(assertReadOnlySql('SELECT 1;'), 'SELECT 1');
  assert.strictEqual(assertReadOnlySql('SELECT 1 -- trailing comment'), 'SELECT 1');
});

test('assertReadOnlySql: rejects anything that does not start with SELECT/WITH', () => {
  assert.throws(() => assertReadOnlySql('INSERT INTO runs (id) VALUES (1)'), /SELECT or WITH/);
  assert.throws(() => assertReadOnlySql('UPDATE runs SET status = 1'), /SELECT or WITH/);
  assert.throws(() => assertReadOnlySql('DELETE FROM runs'), /SELECT or WITH/);
  assert.throws(() => assertReadOnlySql('DROP TABLE runs'), /SELECT or WITH/);
  assert.throws(() => assertReadOnlySql('TRUNCATE runs'), /SELECT or WITH/);
});

test('assertReadOnlySql: rejects a write keyword smuggled after a SELECT via a second statement', () => {
  assert.throws(() => assertReadOnlySql('SELECT 1; DROP TABLE runs;'), /single statement/);
});

test('assertReadOnlySql: rejects a write keyword smuggled inside a WITH/SELECT statement (e.g. a writable CTE)', () => {
  // This starts with WITH, so it clears the first (SELECT/WITH-prefix) gate —
  // the forbidden-keyword scan is what must catch the DELETE inside the CTE.
  assert.throws(
    () => assertReadOnlySql('WITH gone AS (DELETE FROM runs RETURNING id) SELECT * FROM gone'),
    /write or DDL/
  );
});

test('assertReadOnlySql: rejects restricted system or write functions (setval, pg_read_file, lo_import)', () => {
  assert.throws(() => assertReadOnlySql("SELECT setval('runs_id_seq', 1)"), /restricted system\/write function/);
  assert.throws(() => assertReadOnlySql("SELECT pg_read_file('server.js')"), /restricted system\/write function/);
  assert.throws(() => assertReadOnlySql("SELECT lo_import('/etc/passwd')"), /restricted system\/write function/);
});

test('isLoopbackAddress: recognizes loopback forms, rejects everything else', () => {
  assert.strictEqual(isLoopbackAddress('127.0.0.1'), true);
  assert.strictEqual(isLoopbackAddress('::1'), true);
  assert.strictEqual(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.strictEqual(isLoopbackAddress('localhost'), true);
  assert.strictEqual(isLoopbackAddress('10.0.0.5'), false);
  assert.strictEqual(isLoopbackAddress('192.168.1.68'), false);
  assert.strictEqual(isLoopbackAddress(''), false);
  assert.strictEqual(isLoopbackAddress(null), false);
  assert.strictEqual(isLoopbackAddress(undefined), false);
});

test('createMcpBridgeRouter: throws synchronously without a database dependency', () => {
  assert.throws(() => createMcpBridgeRouter({}), /requires \{ database \}/);
});

// ---------------------------------------------------------------------------
// Router, over a real loopback HTTP server, against a stubbed database
// ---------------------------------------------------------------------------

/** Records every (sql, args) the stub was asked to run, and answers with
 *  canned rows keyed by exact sql text — never opens any real connection. */
function createStubDatabase(rowsBySql = {}) {
  const calls = [];
  return {
    calls,
    _connection: {
      prepare(sql) {
        return {
          async all(...args) {
            calls.push({ sql, args });
            if (sql in rowsBySql) return rowsBySql[sql];
            throw new Error(`stub database: no canned rows for: ${sql}`);
          },
        };
      },
    },
  };
}

async function withServer(router, fn) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('mcp-bridge router: runs a validated SELECT through the stubbed connection and returns its rows', async () => {
  const stub = createStubDatabase({ 'SELECT * FROM runs': [{ id: 1, status: 'done' }] });
  const router = createMcpBridgeRouter({ database: stub });

  await withServer(router, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT * FROM runs', params: [] }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, { rows: [{ id: 1, status: 'done' }] });
    assert.strictEqual(stub.calls.length, 1);
  });
});

test('mcp-bridge router: forwards positional bind params to Statement.all(...)', async () => {
  const stub = createStubDatabase({ 'SELECT * FROM runs WHERE id = $1': [{ id: 42 }] });
  const router = createMcpBridgeRouter({ database: stub });

  await withServer(router, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT * FROM runs WHERE id = $1', params: [42] }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(stub.calls[0].args, [42]);
  });
});

test('mcp-bridge router: refuses a write statement with 400 and never calls the connection', async () => {
  const stub = createStubDatabase();
  const router = createMcpBridgeRouter({ database: stub });

  await withServer(router, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'DELETE FROM runs' }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /SELECT or WITH/);
    assert.strictEqual(stub.calls.length, 0);
  });
});

test('mcp-bridge router: refuses a missing/empty sql field with 400', async () => {
  const stub = createStubDatabase();
  const router = createMcpBridgeRouter({ database: stub });

  await withServer(router, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(stub.calls.length, 0);
  });
});

test('mcp-bridge router: a connection-level failure surfaces as a 500 with the error message, not a crash', async () => {
  const router = createMcpBridgeRouter({
    database: {
      _connection: {
        prepare() {
          return { async all() { throw new Error('connection reset'); } };
        },
      },
    },
  });

  await withServer(router, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /connection reset/);
  });
});

test('mcp-bridge router: a loopback request (this test client) is allowed through', async () => {
  // The reject branch is covered directly by the isLoopbackAddress unit
  // tests above; this confirms the middleware does not also reject the
  // allowed case, i.e. it is not accidentally inverted.
  const stub = createStubDatabase({ 'SELECT 1': [{ '?column?': 1 }] });
  const router = createMcpBridgeRouter({ database: stub });

  await withServer(router, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });
    assert.strictEqual(res.status, 200);
  });
});
