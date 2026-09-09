'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { createReadOnlyDb } = require('../../src/mcp/db');
const { createMcpServer, TOOLS } = require('../../src/mcp/server');

// Helper to create an isolated temporary test database fixture
function createIsolatedTestFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-security-lock-test-'));
  const dbDir = path.join(tempDir, 'data');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'collector.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE platforms (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE,
      display_name TEXT,
      description TEXT,
      query_type TEXT DEFAULT 'keyword',
      country_support INTEGER DEFAULT 0,
      icon TEXT DEFAULT '🔗',
      color TEXT DEFAULT '#888888'
    );
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY,
      platform TEXT,
      query TEXT,
      status TEXT DEFAULT 'pending',
      apify_run_id TEXT,
      apify_dataset_id TEXT,
      items_count INTEGER DEFAULT 0,
      new_count INTEGER DEFAULT 0,
      active_count INTEGER DEFAULT 0,
      dropped_count INTEGER DEFAULT 0,
      error_message TEXT,
      max_items INTEGER DEFAULT 100,
      country TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY,
      run_id INTEGER,
      platform TEXT,
      query TEXT,
      item_uid TEXT,
      raw_data TEXT,
      title TEXT,
      url TEXT,
      image TEXT,
      author TEXT,
      price REAL,
      rating REAL,
      reviews INTEGER,
      sold_count INTEGER,
      likes INTEGER,
      comments INTEGER,
      shares INTEGER,
      views INTEGER,
      status TEXT DEFAULT 'new',
      prev_snapshot_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO platforms (name, display_name) VALUES ('etsy', 'Etsy');
    INSERT INTO runs (id, platform, query, status, created_at, completed_at) VALUES (1, 'etsy', 'nail art', 'done', '2026-08-01 10:00:00', '2026-08-01 10:05:00');
    INSERT INTO snapshots (id, run_id, platform, query, item_uid, raw_data, title, url, price, likes, comments, shares, views, status, created_at)
    VALUES (1, 1, 'etsy', 'nail art', 'etsy:item-1', '{"currency":"USD"}', 'Handmade Nails', 'https://etsy.com/1', 25.0, 100, 10, 2, 500, 'active', '2026-08-01 10:01:00');
  `);
  db.close();

  return { tempDir, dbDir, dbPath };
}

// -----------------------------------------------------------------------------
// Test Suite: Tool Boundaries & Tool Count
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
  const { tempDir, dbPath } = createIsolatedTestFixture();
  try {
    const db = createReadOnlyDb({ dbPath });
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

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Test B: OpenClaw -> get_item = PASS (retrieves active item or returns not_current)', async () => {
  const { tempDir, dbPath } = createIsolatedTestFixture();
  try {
    const db = createReadOnlyDb({ dbPath });
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

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Test C: OpenClaw -> get_item_history = PASS (retrieves snapshot history and diffs)', async () => {
  const { tempDir, dbPath } = createIsolatedTestFixture();
  try {
    const db = createReadOnlyDb({ dbPath });
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

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Tests D, E, F, G: Destructive SQL Protection on Isolated Test DB
// -----------------------------------------------------------------------------
test('Test D: MCP attempting INSERT = DENIED (blocked by SQLite readonly + query_only)', () => {
  const { tempDir, dbPath } = createIsolatedTestFixture();
  try {
    const readOnlyDb = createReadOnlyDb({ dbPath });
    assert.throws(
      () => {
        readOnlyDb.db.prepare("INSERT INTO platforms (name, display_name) VALUES ('hack', 'Hacked')").run();
      },
      /attempt to write a readonly database|cannot execute.*in a read-only transaction/i
    );
    readOnlyDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Test E: MCP attempting UPDATE = DENIED (blocked by SQLite readonly + query_only)', () => {
  const { tempDir, dbPath } = createIsolatedTestFixture();
  try {
    const readOnlyDb = createReadOnlyDb({ dbPath });
    assert.throws(
      () => {
        readOnlyDb.db.prepare("UPDATE platforms SET display_name = 'Modified' WHERE id = 1").run();
      },
      /attempt to write a readonly database|cannot execute.*in a read-only transaction/i
    );
    readOnlyDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Test F: MCP attempting DELETE = DENIED (blocked by SQLite readonly + query_only)', () => {
  const { tempDir, dbPath } = createIsolatedTestFixture();
  try {
    const readOnlyDb = createReadOnlyDb({ dbPath });
    assert.throws(
      () => {
        readOnlyDb.db.prepare('DELETE FROM platforms WHERE id = 1').run();
      },
      /attempt to write a readonly database|cannot execute.*in a read-only transaction/i
    );
    readOnlyDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Test G: MCP attempting DROP = DENIED (blocked by SQLite readonly + query_only)', () => {
  const { tempDir, dbPath } = createIsolatedTestFixture();
  try {
    const readOnlyDb = createReadOnlyDb({ dbPath });
    assert.throws(
      () => {
        readOnlyDb.db.prepare('DROP TABLE snapshots').run();
      },
      /attempt to write a readonly database|cannot execute.*in a read-only transaction/i
    );
    readOnlyDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Test H: OS Filesystem Read-Only Permissions on Directory and Files
// -----------------------------------------------------------------------------
test('Test H: OS user crawler_mcp_ro permission model (cannot delete, rename, overwrite, create files)', () => {
  const { tempDir, dbDir, dbPath } = createIsolatedTestFixture();
  try {
    // Simulate read-only directory and file permissions:
    // Files are chmod 0444 (read-only)
    fs.chmodSync(dbPath, 0o444);
    // Directory is chmod 0555 (read & execute only, no write bit)
    fs.chmodSync(dbDir, 0o555);

    // 1. Verify file cannot be opened for writing / overwriting
    assert.throws(() => {
      fs.openSync(dbPath, 'r+');
    }, /EACCES|permission denied/i);

    // 2. Verify file cannot be truncated
    assert.throws(() => {
      fs.truncateSync(dbPath, 0);
    }, /EACCES|permission denied/i);

    // 3. Verify files cannot be created in the read-only directory
    assert.throws(() => {
      fs.writeFileSync(path.join(dbDir, 'new-file.txt'), 'data');
    }, /EACCES|permission denied/i);

    // 4. Verify database file cannot be deleted (unlink) from read-only directory
    assert.throws(() => {
      fs.unlinkSync(dbPath);
    }, /EACCES|permission denied/i);

    // 5. Verify database file cannot be renamed in read-only directory
    assert.throws(() => {
      fs.renameSync(dbPath, path.join(dbDir, 'renamed.db'));
    }, /EACCES|permission denied/i);

    // Restore permissions for cleanup
    fs.chmodSync(dbDir, 0o777);
    fs.chmodSync(dbPath, 0o666);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
