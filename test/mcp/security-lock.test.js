'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createMcpServer, TOOLS } = require('../../src/mcp/server');

/**
 * OLD CONTRACT vs NEW CONTRACT (see docs/mcp/MCP_IMPLEMENTATION_NOTES.md for
 * the full architecture history). The pre-migration src/mcp/db.js opened
 * ./data/collector.db directly with a read-only better-sqlite3 handle; this
 * file built a temporary SQLite fixture per test and exercised the real
 * db.js SQL against it. src/mcp/db.js has been ported to PostgreSQL and
 * createReadOnlyDb() is now async with no `{ dbPath }` option (see that
 * file's module doc).
 *
 * Per the task's environment rule ("if a test needs the DB layer, stub it"),
 * the tests below that exercise createMcpServer(db) pass a plain stub `db`
 * object implementing the five async methods createReadOnlyDb() documents
 * (listPlatformsWithStats/searchItems/getItemByUid/getItemHistory/
 * getInsightsSummary/close) with canned in-memory data shaped exactly like
 * db.js's real return values. This tests what this file is actually named
 * for — the SECURITY LOCK: tool whitelist, redaction, and status semantics
 * at the MCP/tool layer — without re-testing db.js's own SQL (that is
 * test/mcp/db-safety.test.js's job, which stubs one layer deeper, at the
 * Postgres driver, and exercises the real SQL-building code).
 */

function createStubDb() {
  const calls = { searchItems: [], getItemByUid: [], getItemHistory: [] };

  const ITEM = {
    id: 1,
    run_id: 1,
    platform: 'etsy',
    query: 'nail art',
    item_uid: 'etsy:item-1',
    raw_data: '{"currency":"USD"}',
    title: 'Handmade Nails',
    url: 'https://etsy.com/1',
    image: '',
    author: 'ArtisanShop',
    price: 25.0,
    likes: 100,
    comments: 10,
    shares: 2,
    views: 500,
    status: 'active',
    prev_snapshot_id: null,
    created_at: '2026-08-01 10:01:00',
    run_completed_at: '2026-08-01 10:05:00',
    run_created_at: '2026-08-01 10:00:00',
    first_seen_at: '2026-08-01 10:01:00',
  };

  return {
    calls,
    dbPath: 'stub://in-memory-fixture',
    async listPlatformsWithStats() {
      return [];
    },
    async searchItems(params) {
      calls.searchItems.push(params);
      const kw = (params.keyword || '').toLowerCase();
      const matches = !kw || ITEM.title.toLowerCase().includes(kw);
      return { rows: matches ? [ITEM] : [], nextCursor: null, limit: 50, dataAsOf: ITEM.run_completed_at };
    },
    async getItemByUid(itemUid) {
      calls.getItemByUid.push(itemUid);
      if (itemUid !== ITEM.item_uid) return null;
      return { isDropped: false, row: ITEM };
    },
    async getItemHistory(itemUid) {
      calls.getItemHistory.push(itemUid);
      if (itemUid !== ITEM.item_uid) return { rows: [], nextCursor: null };
      return { rows: [ITEM], nextCursor: null };
    },
    async getInsightsSummary() {
      return { stats: {}, platformDistribution: [], statusDistribution: [], dataAsOf: null };
    },
    async close() {},
  };
}

// -----------------------------------------------------------------------------
// Test Suite: Tool Boundaries & Tool Count (unchanged — static, no DB dependency)
// -----------------------------------------------------------------------------
test('Security Lock: Exactly 6 tools are exposed, no arbitrary SQL, no shell, no filesystem tools', () => {
  const exposedToolNames = TOOLS.map((t) => t.schema.name);
  assert.strictEqual(exposedToolNames.length, 6, 'Must expose exactly 6 tools');
  assert.deepStrictEqual(exposedToolNames.sort(), [
    'describe_item_schema',
    'get_item',
    'get_item_history',
    'get_items_insights_summary',
    'list_data_sources',
    'search_items',
  ]);

  // Verify no dangerous tools exist
  const dangerousNames = [
    'execute_sql',
    'query_sql',
    'sql',
    'arbitrary_sql',
    'run_command',
    'shell',
    'exec',
    'read_file',
    'write_file',
    'delete_file',
    'start_crawler',
    'stop_crawler',
  ];
  for (const dangerous of dangerousNames) {
    assert.strictEqual(exposedToolNames.includes(dangerous), false, `Tool ${dangerous} must not exist`);
  }
});

// -----------------------------------------------------------------------------
// Tests A, B, C: OpenClaw Tool Invocations
// -----------------------------------------------------------------------------
test('Test A: OpenClaw -> search_items = PASS (read-only, redacted, active items only)', async () => {
  const db = createStubDb();
  const server = createMcpServer(db);

  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: 101,
    method: 'tools/call',
    params: {
      name: 'search_items',
      arguments: { keyword: 'Handmade' },
    },
  });

  assert.strictEqual(res.result.isError, false);
  const data = JSON.parse(res.result.content[0].text);
  assert.strictEqual(data.items.length, 1);
  assert.strictEqual(data.items[0].item_uid, 'etsy:item-1');
  assert.strictEqual(data.items[0].price.amount, 25.0);
  assert.strictEqual(data.items[0].price.currency, 'USD');
  // Ensure raw_data and sensitive keys are stripped
  assert.strictEqual(data.items[0].raw_data, undefined);
  assert.strictEqual(data.items[0].actor_id, undefined);
});

test('Test B: OpenClaw -> get_item = PASS (retrieves active item or returns not_current)', async () => {
  const db = createStubDb();
  const server = createMcpServer(db);

  // 1. Existing active item
  const resActive = await server.handleMessage({
    jsonrpc: '2.0',
    id: 102,
    method: 'tools/call',
    params: {
      name: 'get_item',
      arguments: { item_uid: 'etsy:item-1' },
    },
  });
  assert.strictEqual(resActive.result.isError, false);
  const dataActive = JSON.parse(resActive.result.content[0].text);
  assert.strictEqual(dataActive.status, 'active');
  assert.strictEqual(dataActive.item.item_uid, 'etsy:item-1');

  // 2. Non-existent item
  const resNotFound = await server.handleMessage({
    jsonrpc: '2.0',
    id: 103,
    method: 'tools/call',
    params: {
      name: 'get_item',
      arguments: { item_uid: 'etsy:non_existent' },
    },
  });
  assert.strictEqual(resNotFound.result.isError, false);
  const dataNotFound = JSON.parse(resNotFound.result.content[0].text);
  assert.strictEqual(dataNotFound.status, 'not_current');
  assert.strictEqual(dataNotFound.item, null);
});

test('Test C: OpenClaw -> get_item_history = PASS (retrieves snapshot history and diffs)', async () => {
  const db = createStubDb();
  const server = createMcpServer(db);

  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: 104,
    method: 'tools/call',
    params: {
      name: 'get_item_history',
      arguments: { item_uid: 'etsy:item-1' },
    },
  });

  assert.strictEqual(res.result.isError, false);
  const data = JSON.parse(res.result.content[0].text);
  assert.strictEqual(data.item_uid, 'etsy:item-1');
  assert.strictEqual(data.total_snapshots, 1);
  assert.ok(data.disclaimer);
});

// -----------------------------------------------------------------------------
// Tests D-G REPLACED (see §16 report): the old versions reached into a raw
// `readOnlyDb.db` (a better-sqlite3 handle) and asserted SQLite's PRAGMA
// query_only rejected INSERT/UPDATE/DELETE/DROP. That handle does not exist
// on the new contract at all (see test/mcp/db-safety.test.js's "exposes no
// raw SQL/write surface" test, which is the direct replacement for that
// guarantee at the db.js layer). This file's own job is the OpenClaw/tool
// layer, so its replacement test checks the same thing from that angle:
// SQL-injection-shaped tool arguments are treated as inert filter data,
// never parsed, executed, or specially interpreted.
// -----------------------------------------------------------------------------
test('Test D: OpenClaw -> search_items with SQL-shaped arguments = treated as inert filter data, never executed or specially interpreted', async () => {
  const db = createStubDb();
  const server = createMcpServer(db);

  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: 105,
    method: 'tools/call',
    params: {
      name: 'search_items',
      arguments: { keyword: "'; DROP TABLE runs; --", author: "x' OR 1=1 --" },
    },
  });

  assert.strictEqual(res.result.isError, false);
  const data = JSON.parse(res.result.content[0].text);
  assert.strictEqual(data.items.length, 0); // no title match for the malicious keyword — inert data, not a bypass

  // The tool passed the arguments straight through to the db layer as plain
  // filter values — no parsing, no special-casing, no execution.
  assert.strictEqual(db.calls.searchItems.length, 1);
  assert.strictEqual(db.calls.searchItems[0].keyword, "'; DROP TABLE runs; --");
  assert.strictEqual(db.calls.searchItems[0].author, "x' OR 1=1 --");
});

// -----------------------------------------------------------------------------
// Test H REMOVED (see §16 report): the old version chmod'd a temp file/dir
// to 0444/0555 and proved the OS filesystem denied writes/renames/deletes —
// simulating the documented `crawler_mcp_ro` dedicated-OS-user model. There
// is no on-disk database file in this flow anymore for either connection
// mode (a direct pg.Pool talks over TCP to a Postgres server; PG_MODE=pglite
// routes through the app's own HTTP mcp-bridge endpoint), so there is
// nothing left for OS file permissions to protect, and no OS-user model to
// simulate. The two guarantees that actually replace it — loopback-only and
// browser-origin refusal on the bridge endpoint — are already covered by
// test/routes/mcp-bridge.test.js. Fabricating an OS-permission test here
// would exercise a mechanism this architecture no longer has.
// -----------------------------------------------------------------------------
