'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { createReadOnlyDb } = require('../../src/mcp/db');

// Helper to create an isolated temporary test database
function createTempTestDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-safety-test-'));
  const dbPath = path.join(tempDir, 'test-collector.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE platforms (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE,
      display_name TEXT,
      description TEXT,
      query_type TEXT DEFAULT 'keyword',
      actor_id TEXT,
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

    INSERT INTO platforms (id, name, display_name, description) VALUES (1, 'etsy', 'Etsy', 'Etsy platform');
    INSERT INTO runs (id, platform, query, status, created_at, completed_at) VALUES (1, 'etsy', 'gift', 'done', '2026-08-01 10:00:00', '2026-08-01 10:05:00');
    INSERT INTO snapshots (id, run_id, platform, query, item_uid, raw_data, title, url, price, likes, status, created_at)
    VALUES (1, 1, 'etsy', 'gift', 'etsy:https://etsy.com/1', '{"price": 19.99, "currency": "USD"}', 'Personalized Gift', 'https://etsy.com/1', 19.99, 50, 'new', '2026-08-01 10:01:00');
  `);
  db.close();

  return { tempDir, dbPath };
}

test('Read-only DB Safety: fail startup if database file does not exist', () => {
  const nonExistentPath = path.join(os.tmpdir(), 'non-existent-db-' + Date.now() + '.db');
  assert.throws(
    () => {
      createReadOnlyDb({ dbPath: nonExistentPath });
    },
    {
      code: 'SQLITE_CANTOPEN',
    }
  );
});

test('Read-only DB Safety: PRAGMA query_only strictly blocks INSERT, UPDATE, DELETE, DROP on read-only connection', () => {
  const { tempDir, dbPath } = createTempTestDb();

  try {
    const readOnlyDb = createReadOnlyDb({ dbPath });
    assert.ok(readOnlyDb.db);

    // 1. Verify INSERT fails
    assert.throws(
      () => {
        readOnlyDb.db.prepare("INSERT INTO platforms (name, display_name) VALUES ('test', 'Test')").run();
      },
      /attempt to write a readonly database|cannot execute.*in a read-only transaction/i
    );

    // 2. Verify UPDATE fails
    assert.throws(
      () => {
        readOnlyDb.db.prepare("UPDATE platforms SET display_name = 'Modified' WHERE id = 1").run();
      },
      /attempt to write a readonly database|cannot execute.*in a read-only transaction/i
    );

    // 3. Verify DELETE fails
    assert.throws(
      () => {
        readOnlyDb.db.prepare('DELETE FROM platforms WHERE id = 1').run();
      },
      /attempt to write a readonly database|cannot execute.*in a read-only transaction/i
    );

    // 4. Verify DROP TABLE fails
    assert.throws(
      () => {
        readOnlyDb.db.prepare('DROP TABLE snapshots').run();
      },
      /attempt to write a readonly database|cannot execute.*in a read-only transaction/i
    );

    // 5. Verify SELECT succeeds
    const platforms = readOnlyDb.db.prepare('SELECT * FROM platforms').all();
    assert.strictEqual(platforms.length, 1);
    assert.strictEqual(platforms[0].name, 'etsy');

    readOnlyDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Read-only DB Safety: Parameterized queries prevent SQL injection payloads', () => {
  const { tempDir, dbPath } = createTempTestDb();

  try {
    const readOnlyDb = createReadOnlyDb({ dbPath });

    // Injection attempt 1: OR 1=1 in keyword
    const search1 = readOnlyDb.searchItems({ keyword: "' OR 1=1 --" });
    assert.strictEqual(search1.rows.length, 0);

    // Injection attempt 2: UNION SELECT in platform
    const search2 = readOnlyDb.searchItems({ platform: "etsy' UNION SELECT 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24 --" });
    assert.strictEqual(search2.rows.length, 0);

    readOnlyDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
