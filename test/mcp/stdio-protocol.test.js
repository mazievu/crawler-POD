'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { createReadOnlyDb } = require('../../src/mcp/db');
const { createMcpServer, PROTOCOL_VERSION, SERVER_INFO } = require('../../src/mcp/server');

function createTempDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-proto-test-'));
  const dbPath = path.join(tempDir, 'collector.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE platforms (id INTEGER PRIMARY KEY, name TEXT UNIQUE, display_name TEXT, description TEXT, query_type TEXT, country_support INTEGER, icon TEXT, color TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, platform TEXT, query TEXT, status TEXT, apify_run_id TEXT, apify_dataset_id TEXT, items_count INTEGER, new_count INTEGER, active_count INTEGER, dropped_count INTEGER, error_message TEXT, max_items INTEGER, country TEXT, created_at DATETIME, completed_at DATETIME);
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY, run_id INTEGER, platform TEXT, query TEXT, item_uid TEXT, raw_data TEXT, title TEXT, url TEXT, image TEXT, author TEXT, price REAL, rating REAL, reviews INTEGER, sold_count INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, views INTEGER, status TEXT, prev_snapshot_id INTEGER, created_at DATETIME);
    INSERT INTO platforms (name, display_name) VALUES ('etsy', 'Etsy');
  `);
  db.close();

  return { tempDir, dbPath };
}

test('JSON-RPC Protocol: initialize handshake', async () => {
  const { tempDir, dbPath } = createTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });
    const server = createMcpServer(db);

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

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('JSON-RPC Protocol: ping returns empty result', async () => {
  const { tempDir, dbPath } = createTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });
    const server = createMcpServer(db);

    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    });

    assert.strictEqual(res.jsonrpc, '2.0');
    assert.strictEqual(res.id, 2);
    assert.deepStrictEqual(res.result, {});

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('JSON-RPC Protocol: tools/list returns all 6 tools', async () => {
  const { tempDir, dbPath } = createTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });
    const server = createMcpServer(db);

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

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('JSON-RPC Protocol: tools/call executes tool and formats content text', async () => {
  const { tempDir, dbPath } = createTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });
    const server = createMcpServer(db);

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

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('JSON-RPC Protocol: error handling for unknown method and invalid tool', async () => {
  const { tempDir, dbPath } = createTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });
    const server = createMcpServer(db);

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

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
