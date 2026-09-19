'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createMcpServer, PROTOCOL_VERSION, SERVER_INFO } = require('../../src/mcp/server');

/**
 * These tests exercise the JSON-RPC envelope (initialize/ping/tools-list/
 * tools-call/error handling) in src/mcp/server.js, which is UNCHANGED by the
 * PostgreSQL port of src/mcp/db.js — server.js only ever calls
 * `tool.handler(args, db)` and never touches the database itself. Nothing
 * here is a stale contract; this is a mechanical fixture change only.
 *
 * None of these tests need real data: the one tool exercised here,
 * describe_item_schema, ignores its `db` argument entirely. So `db` is a
 * trivial stub — no SQLite fixture, no PostgreSQL/PGlite connection of any
 * kind (the old version built a temporary better-sqlite3 file for a `db`
 * argument that was never actually read).
 */
function createStubDb() {
  return { async close() {} };
}

test('JSON-RPC Protocol: initialize handshake', async () => {
  const server = createMcpServer(createStubDb());

  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  });

  assert.strictEqual(res.jsonrpc, '2.0');
  assert.strictEqual(res.id, 1);
  assert.strictEqual(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.strictEqual(res.result.serverInfo.name, SERVER_INFO.name);
  assert.ok(res.result.capabilities.tools);
});

test('JSON-RPC Protocol: ping returns empty result', async () => {
  const server = createMcpServer(createStubDb());

  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'ping',
  });

  assert.strictEqual(res.jsonrpc, '2.0');
  assert.strictEqual(res.id, 2);
  assert.deepStrictEqual(res.result, {});
});

test('JSON-RPC Protocol: tools/list returns all 6 tools', async () => {
  const server = createMcpServer(createStubDb());

  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
  });

  assert.strictEqual(res.jsonrpc, '2.0');
  assert.strictEqual(res.id, 3);
  assert.strictEqual(res.result.tools.length, 6);

  const toolNames = res.result.tools.map((t) => t.name);
  assert.deepStrictEqual(toolNames.sort(), [
    'describe_item_schema',
    'get_item',
    'get_item_history',
    'get_items_insights_summary',
    'list_data_sources',
    'search_items',
  ]);
});

test('JSON-RPC Protocol: tools/call executes tool and formats content text', async () => {
  const server = createMcpServer(createStubDb());

  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'describe_item_schema',
      arguments: {},
    },
  });

  assert.strictEqual(res.jsonrpc, '2.0');
  assert.strictEqual(res.id, 4);
  assert.strictEqual(res.result.isError, false);
  assert.ok(Array.isArray(res.result.content));
  assert.strictEqual(res.result.content[0].type, 'text');

  const parsedContent = JSON.parse(res.result.content[0].text);
  assert.strictEqual(parsedContent.contract_name, 'Crawler POD Item Contract');
});

test('JSON-RPC Protocol: error handling for unknown method and invalid tool', async () => {
  const server = createMcpServer(createStubDb());

  // Unknown method
  const resUnknown = await server.handleMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'non_existent_method',
  });
  assert.strictEqual(resUnknown.error.code, -32601);

  // Unknown tool
  const resInvalidTool = await server.handleMessage({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'unknown_tool_xyz',
    },
  });
  assert.strictEqual(resInvalidTool.error.code, -32601);
});
