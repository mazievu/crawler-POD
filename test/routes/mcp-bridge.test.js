'use strict';

/**
 * Unit tests for src/routes/mcp-bridge.js — MCP Bridge Lockdown (Milestone M2)
 *
 * Verifies:
 * - Constant-time service key comparison (crypto.timingSafeEqual on SHA-256)
 * - Header extraction: x-internal-service-key, Authorization: Bearer <key>
 * - Immediate 403 when key is missing, mismatched, or empty
 * - Ingress defense-in-depth: loopback socket check and browser check
 * - Unknown /api/internal/* endpoints return 404 when key is valid, 403 when not
 * - SQL read-only validation & statement execution
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const {
  createMcpBridgeRouter,
  assertReadOnlySql,
  isLoopbackAddress,
  extractInternalServiceKey,
  verifyInternalServiceKey,
  guardInternalService,
  QUERY_PATH,
} = require('../../src/routes/mcp-bridge');

const TEST_KEY = 'test-secret-service-key-32-chars-long!';

// ---------------------------------------------------------------------------
// Pure functions: SQL & Loopback Validation
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
// Pure functions: Service Key Extraction & Timing-Safe Verification
// ---------------------------------------------------------------------------

test('extractInternalServiceKey: extracts from x-internal-service-key header', () => {
  assert.strictEqual(extractInternalServiceKey({ headers: { 'x-internal-service-key': 'secret-123' } }), 'secret-123');
  assert.strictEqual(extractInternalServiceKey({ headers: { 'x-internal-service-key': ['secret-array'] } }), 'secret-array');
});

test('extractInternalServiceKey: extracts from Authorization: Bearer <key>', () => {
  assert.strictEqual(extractInternalServiceKey({ headers: { authorization: 'Bearer secret-bearer-456' } }), 'secret-bearer-456');
  assert.strictEqual(extractInternalServiceKey({ headers: { authorization: 'bearer lowercase-bearer-456' } }), 'lowercase-bearer-456');
});

test('extractInternalServiceKey: returns null when headers are missing or malformed', () => {
  assert.strictEqual(extractInternalServiceKey(null), null);
  assert.strictEqual(extractInternalServiceKey({ headers: {} }), null);
  assert.strictEqual(extractInternalServiceKey({ headers: { authorization: 'Basic dXNlcjpwYXNz' } }), null);
  assert.strictEqual(extractInternalServiceKey({ headers: { 'x-internal-service-key': '' } }), null);
});

test('verifyInternalServiceKey: returns true for identical keys', () => {
  assert.strictEqual(verifyInternalServiceKey('exact-matching-secret-key-32', 'exact-matching-secret-key-32'), true);
});

test('verifyInternalServiceKey: returns false for mismatched keys without RangeError', () => {
  assert.strictEqual(verifyInternalServiceKey('wrong', 'exact-matching-secret-key-32'), false);
  assert.strictEqual(verifyInternalServiceKey('exact-matching-secret-key-33', 'exact-matching-secret-key-32'), false);
  assert.strictEqual(verifyInternalServiceKey('', 'exact-matching-secret-key-32'), false);
  assert.strictEqual(verifyInternalServiceKey(null, 'exact-matching-secret-key-32'), false);
  assert.strictEqual(verifyInternalServiceKey('exact-matching-secret-key-32', null), false);
});

test('verifyInternalServiceKey: preserves control characters and rejects embedded newlines', () => {
  assert.strictEqual(verifyInternalServiceKey('exact-key\r\n', 'exact-key'), false);
  assert.strictEqual(verifyInternalServiceKey(' exact-key', 'exact-key'), false);
});

// ---------------------------------------------------------------------------
// Router over HTTP Server with Stubbed Database
// ---------------------------------------------------------------------------

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

test('mcp-bridge router: rejects request with 403 if INTERNAL_SERVICE_KEY is unset in environment', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  delete process.env.INTERNAL_SERVICE_KEY;
  const stub = createStubDatabase();
  const router = createMcpBridgeRouter({ database: stub });

  try {
    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-service-key': 'some-key' },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error, 'Forbidden');
    });
  } finally {
    if (oldKey !== undefined) process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: rejects request with 403 when x-internal-service-key is missing', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error, 'Forbidden');
      assert.match(body.message, /INTERNAL_SERVICE_KEY required/);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: rejects request with 403 when service key is invalid', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-service-key': 'invalid-key' },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error, 'Forbidden');
      assert.match(body.message, /Invalid service credentials/);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: allows request with valid x-internal-service-key header', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
    const stub = createStubDatabase({ 'SELECT * FROM runs': [{ id: 1, status: 'done' }] });
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-key': TEST_KEY,
        },
        body: JSON.stringify({ sql: 'SELECT * FROM runs', params: [] }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, { rows: [{ id: 1, status: 'done' }] });
      assert.strictEqual(stub.calls.length, 1);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: forwards positional bind params to Statement.all(...) with valid key', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
    const stub = createStubDatabase({ 'SELECT * FROM runs WHERE id = $1': [{ id: 42 }] });
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-key': TEST_KEY,
        },
        body: JSON.stringify({ sql: 'SELECT * FROM runs WHERE id = $1', params: [42] }),
      });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(stub.calls[0].args, [42]);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: allows request with valid Authorization: Bearer <key>', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
    const stub = createStubDatabase({ 'SELECT 1': [{ '?column?': 1 }] });
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TEST_KEY}`,
        },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res.status, 200);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: rejects browser-originated requests even with valid service key', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-key': TEST_KEY,
          origin: 'https://malicious.example.com',
        },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.match(body.message, /browser-originated/);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: unknown /api/internal/* route returns 403 without key, 404 with key', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      // Without key -> 403
      const resNoKey = await fetch(`${baseUrl}/api/internal/unknown-service`, {
        method: 'GET',
      });
      assert.strictEqual(resNoKey.status, 403);

      // With valid key -> 404 (endpoint not defined)
      const resWithKey = await fetch(`${baseUrl}/api/internal/unknown-service`, {
        method: 'GET',
        headers: { 'x-internal-service-key': TEST_KEY },
      });
      assert.strictEqual(resWithKey.status, 404);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: refuses write SQL statement with 400 even with valid key', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-key': TEST_KEY,
        },
        body: JSON.stringify({ sql: 'DELETE FROM runs' }),
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(stub.calls.length, 0);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: refuses a missing/empty sql field with 400 with valid key', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
    const stub = createStubDatabase();
    const router = createMcpBridgeRouter({ database: stub });

    await withServer(router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-key': TEST_KEY,
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(stub.calls.length, 0);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});

test('mcp-bridge router: a connection-level failure surfaces as a 500 with the error message, not a crash', async () => {
  const oldKey = process.env.INTERNAL_SERVICE_KEY;
  process.env.INTERNAL_SERVICE_KEY = TEST_KEY;
  try {
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
        headers: {
          'content-type': 'application/json',
          'x-internal-service-key': TEST_KEY,
        },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      assert.strictEqual(res.status, 500);
      const body = await res.json();
      assert.match(body.error, /connection reset/);
    });
  } finally {
    process.env.INTERNAL_SERVICE_KEY = oldKey;
  }
});
