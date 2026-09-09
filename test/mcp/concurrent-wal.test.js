'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { createReadOnlyDb } = require('../../src/mcp/db');

test('Concurrency Safety: Collector WRITE and MCP READ in WAL mode do not conflict or corrupt', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-wal-test-'));
  const dbPath = path.join(tempDir, 'collector.db');

  // 1. Writer creates DB in WAL mode
  const writerDb = new Database(dbPath);
  writerDb.pragma('journal_mode = WAL');
  writerDb.exec(`
    CREATE TABLE platforms (id INTEGER PRIMARY KEY, name TEXT UNIQUE, display_name TEXT, description TEXT, query_type TEXT, country_support INTEGER, icon TEXT, color TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, platform TEXT, query TEXT, status TEXT, apify_run_id TEXT, apify_dataset_id TEXT, items_count INTEGER, new_count INTEGER, active_count INTEGER, dropped_count INTEGER, error_message TEXT, max_items INTEGER, country TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME);
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY, run_id INTEGER, platform TEXT, query TEXT, item_uid TEXT, raw_data TEXT, title TEXT, url TEXT, image TEXT, author TEXT, price REAL, rating REAL, reviews INTEGER, sold_count INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, views INTEGER, status TEXT, prev_snapshot_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    
    INSERT INTO platforms (name, display_name) VALUES ('etsy', 'Etsy');
    INSERT INTO runs (id, platform, query, status, created_at, completed_at) VALUES (1, 'etsy', 'nail', 'done', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO snapshots (id, run_id, platform, query, item_uid, raw_data, title, url, price, likes, status) VALUES (1, 1, 'etsy', 'nail', 'etsy:item1', '{"currency":"USD"}', 'Initial Item', 'https://etsy.com/1', 10, 5, 'new');
  `);

  // 2. Open MCP read-only connection
  const readerMcp = createReadOnlyDb({ dbPath });

  try {
    // Initial read
    const search1 = readerMcp.searchItems({ platform: 'etsy' });
    assert.strictEqual(search1.rows.length, 1);
    assert.strictEqual(search1.rows[0].title, 'Initial Item');

    // 3. Collector performs simultaneous write operations (Insert run, Insert snapshot)
    writerDb.prepare("INSERT INTO runs (id, platform, query, status, created_at, completed_at) VALUES (2, 'etsy', 'nail', 'done', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
    writerDb.prepare("INSERT INTO snapshots (id, run_id, platform, query, item_uid, raw_data, title, url, price, likes, status) VALUES (2, 2, 'etsy', 'nail', 'etsy:item2', '{\"currency\":\"USD\"}', 'Concurrent Item', 'https://etsy.com/2', 20, 15, 'new')").run();

    // 4. MCP reader queries again while writer connection is open
    const search2 = readerMcp.searchItems({ platform: 'etsy' });
    assert.strictEqual(search2.rows.length, 2);
    const titles = search2.rows.map((r) => r.title);
    assert.ok(titles.includes('Initial Item'));
    assert.ok(titles.includes('Concurrent Item'));
  } finally {
    readerMcp.close();
    writerDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
