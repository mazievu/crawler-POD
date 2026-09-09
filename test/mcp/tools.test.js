'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { createReadOnlyDb } = require('../../src/mcp/db');

const listDataSources = require('../../src/mcp/tools/list-data-sources');
const describeItemSchema = require('../../src/mcp/tools/describe-item-schema');
const searchItems = require('../../src/mcp/tools/search-items');
const getItem = require('../../src/mcp/tools/get-item');
const getItemHistory = require('../../src/mcp/tools/get-item-history');
const getItemsInsightsSummary = require('../../src/mcp/tools/get-items-insights-summary');

// Helper to seed a rich test dataset in a temporary sqlite database
function createSeededTempDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-test-'));
  const dbPath = path.join(tempDir, 'collector.db');

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

    -- Platforms
    INSERT INTO platforms (id, name, display_name, description, query_type, country_support)
    VALUES 
      (1, 'etsy', 'Etsy', 'Etsy marketplace', 'keyword', 0),
      (2, 'amazon', 'Amazon', 'Amazon store', 'keyword', 1),
      (3, 'pinterest', 'Pinterest', 'Pinterest pins', 'keyword', 0);

    -- Runs: 2 done runs, 1 failed run
    INSERT INTO runs (id, platform, query, status, country, created_at, completed_at)
    VALUES 
      (1, 'etsy', 'nail art', 'done', 'US', '2026-08-01 10:00:00', '2026-08-01 10:05:00'),
      (2, 'etsy', 'nail art', 'done', 'US', '2026-08-02 10:00:00', '2026-08-02 10:05:00'),
      (3, 'amazon', 'press on nails', 'done', 'US', '2026-08-03 10:00:00', '2026-08-03 10:05:00'),
      (4, 'etsy', 'nail art', 'failed', 'US', '2026-08-04 10:00:00', '2026-08-04 10:01:00');

    -- Snapshots for Run 1
    INSERT INTO snapshots (id, run_id, platform, query, item_uid, raw_data, title, url, image, author, price, likes, comments, shares, views, status, prev_snapshot_id, created_at)
    VALUES 
      (101, 1, 'etsy', 'nail art', 'etsy:item1', '{"currency": "USD"}', 'Pink Press On Nails', 'https://etsy.com/item1', 'https://img.etsy.com/1.jpg', 'NailQueen', 20.0, 100, 10, 2, 500, 'new', NULL, '2026-08-01 10:01:00'),
      (102, 1, 'etsy', 'nail art', 'etsy:item2', '{"currency": "USD"}', 'Glitter Nail Set', 'https://etsy.com/item2', 'https://img.etsy.com/2.jpg', 'SparkleNails', 15.0, 50, 5, 0, 200, 'new', NULL, '2026-08-01 10:02:00'),
      (103, 1, 'etsy', 'nail art', 'etsy:item3', '{}', 'French Tip Nails', 'https://etsy.com/item3', 'https://img.etsy.com/3.jpg', 'ClassicNails', 25.0, 80, 8, 1, 400, 'new', NULL, '2026-08-01 10:03:00');

    -- Snapshots for Run 2 (item1 active with higher likes & price, item2 dropped, item4 new)
    INSERT INTO snapshots (id, run_id, platform, query, item_uid, raw_data, title, url, image, author, price, likes, comments, shares, views, status, prev_snapshot_id, created_at)
    VALUES 
      (104, 2, 'etsy', 'nail art', 'etsy:item1', '{"currency": "USD"}', 'Pink Press On Nails (Updated)', 'https://etsy.com/item1', 'https://img.etsy.com/1.jpg', 'NailQueen', 22.0, 150, 15, 5, 800, 'active', 101, '2026-08-02 10:01:00'),
      (105, 2, 'etsy', 'nail art', 'etsy:item2', '{"currency": "USD"}', 'Glitter Nail Set', 'https://etsy.com/item2', 'https://img.etsy.com/2.jpg', 'SparkleNails', 15.0, 50, 5, 0, 200, 'dropped', 102, '2026-08-02 10:02:00'),
      (106, 2, 'etsy', 'nail art', 'etsy:item4', '{"currency": "USD"}', 'Cat Eye Nail Set', 'https://etsy.com/item4', 'https://img.etsy.com/4.jpg', 'CatNails', 30.0, 20, 2, 0, 100, 'new', NULL, '2026-08-02 10:03:00');

    -- Snapshots for Run 3 (Amazon)
    INSERT INTO snapshots (id, run_id, platform, query, item_uid, raw_data, title, url, image, author, price, likes, comments, shares, views, status, prev_snapshot_id, created_at)
    VALUES 
      (107, 3, 'amazon', 'press on nails', 'amazon:item5', '{"currency": "USD"}', 'Amazon Basics Nail Kit', 'https://amazon.com/dp/item5', 'https://img.amazon.com/5.jpg', 'AmazonBasics', 12.99, 500, 30, 10, 5000, 'new', NULL, '2026-08-03 10:01:00');

    -- Snapshots for Failed Run 4 (should be excluded from search and current items)
    INSERT INTO snapshots (id, run_id, platform, query, item_uid, raw_data, title, url, image, author, price, likes, comments, shares, views, status, prev_snapshot_id, created_at)
    VALUES 
      (108, 4, 'etsy', 'nail art', 'etsy:item_failed', '{}', 'Failed Item', 'https://etsy.com/fail', '', 'FailAuthor', 1.0, 0, 0, 0, 0, 'new', NULL, '2026-08-04 10:01:00');
  `);
  db.close();

  return { tempDir, dbPath };
}

test('Tool 1: list_data_sources returns platform summaries and crawl dates', async () => {
  const { tempDir, dbPath } = createSeededTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });
    const result = await listDataSources.handler({}, db);

    assert.ok(Array.isArray(result.sources));
    assert.strictEqual(result.total_sources, 3);

    const etsySource = result.sources.find((s) => s.platform === 'etsy');
    assert.ok(etsySource);
    assert.strictEqual(etsySource.display_name, 'Etsy');
    assert.strictEqual(etsySource.item_count, 5); // 3 from run1 + 2 non-dropped from run2
    assert.strictEqual(etsySource.last_successful_crawl_at, '2026-08-02 10:00:00');

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Tool 2: describe_item_schema returns complete Item Contract and safety notices', async () => {
  const result = await describeItemSchema.handler();

  assert.strictEqual(result.contract_name, 'Crawler POD Item Contract');
  assert.ok(result.fields.item_uid);
  assert.ok(result.fields.price);
  assert.ok(result.fields.engagement);
  assert.ok(result.fields.provenance);
  assert.ok(result.fields.freshness);

  // Verify explicit currency notice
  assert.match(result.fields.price.properties.currency.description, /strictly NULL if not present in the DB/i);
  // Verify untrusted external data notice
  assert.match(result.safety_and_prompt_injection_boundary.notice, /UNTRUSTED EXTERNAL DATA/i);
});

test('Tool 3: search_items returns current active items, filters properly, and excludes dropped & failed items', async () => {
  const { tempDir, dbPath } = createSeededTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });

    // 1. Search all current items
    const allSearch = await searchItems.handler({}, db);
    // Expected current items:
    // - etsy:item1 (latest is id 104, active)
    // - etsy:item3 (latest is id 103, new)
    // - etsy:item4 (latest is id 106, new)
    // - amazon:item5 (latest is id 107, new)
    // Excluded:
    // - etsy:item2 (latest is id 105, dropped)
    // - etsy:item_failed (run status is failed)
    const uids = allSearch.items.map((i) => i.item_uid);
    assert.ok(uids.includes('etsy:item1'));
    assert.ok(uids.includes('etsy:item3'));
    assert.ok(uids.includes('etsy:item4'));
    assert.ok(uids.includes('amazon:item5'));
    assert.strictEqual(uids.includes('etsy:item2'), false, 'Dropped items must not be returned in current search');
    assert.strictEqual(uids.includes('etsy:item_failed'), false, 'Failed run items must not be returned');

    // 2. Keyword filter
    const kwSearch = await searchItems.handler({ keyword: 'Glitter' }, db);
    assert.strictEqual(kwSearch.items.length, 0, 'Glitter was dropped, should return 0 results');

    const kwSearch2 = await searchItems.handler({ keyword: 'Pink' }, db);
    assert.strictEqual(kwSearch2.items.length, 1);
    assert.strictEqual(kwSearch2.items[0].item_uid, 'etsy:item1');

    // 3. Platform filter
    const amazonSearch = await searchItems.handler({ platform: 'amazon' }, db);
    assert.strictEqual(amazonSearch.items.length, 1);
    assert.strictEqual(amazonSearch.items[0].platform, 'amazon');

    // 4. Price filter
    const priceSearch = await searchItems.handler({ price_min: 21.0 }, db);
    const priceUids = priceSearch.items.map((i) => i.item_uid);
    assert.ok(priceUids.includes('etsy:item1')); // price 22.0
    assert.ok(priceUids.includes('etsy:item3')); // price 25.0
    assert.ok(priceUids.includes('etsy:item4')); // price 30.0
    assert.strictEqual(priceUids.includes('amazon:item5'), false); // price 12.99

    // 5. Currency rule check: etsy:item3 has no currency in raw_data -> currency must be null
    const item3 = allSearch.items.find((i) => i.item_uid === 'etsy:item3');
    assert.strictEqual(item3.price.currency, null, 'Currency must be null if not in DB');

    // 6. Pagination with limit and cursor
    const pagedSearch1 = await searchItems.handler({ limit: 2, sort: 'price:asc' }, db);
    assert.strictEqual(pagedSearch1.items.length, 2);
    assert.ok(pagedSearch1.next_cursor);

    const pagedSearch2 = await searchItems.handler({ limit: 2, sort: 'price:asc', cursor: pagedSearch1.next_cursor }, db);
    assert.strictEqual(pagedSearch2.items.length, 2);

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Tool 4: get_item returns full Item Contract for active item, and status "not_current" for dropped item', async () => {
  const { tempDir, dbPath } = createSeededTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });

    // Active item (item1)
    const activeRes = await getItem.handler({ item_uid: 'etsy:item1' }, db);
    assert.strictEqual(activeRes.status, 'active');
    assert.ok(activeRes.item);
    assert.strictEqual(activeRes.item.item_uid, 'etsy:item1');
    assert.strictEqual(activeRes.item.price.amount, 22.0);
    assert.strictEqual(activeRes.item.first_seen_at, '2026-08-01 10:01:00');
    assert.strictEqual(activeRes.item.last_seen_at, '2026-08-02 10:01:00');

    // Dropped item (item2)
    const droppedRes = await getItem.handler({ item_uid: 'etsy:item2' }, db);
    assert.strictEqual(droppedRes.status, 'not_current');
    assert.strictEqual(droppedRes.item, null);

    // Non-existent item
    const notFoundRes = await getItem.handler({ item_uid: 'etsy:does_not_exist' }, db);
    assert.strictEqual(notFoundRes.status, 'not_current');
    assert.strictEqual(notFoundRes.item, null);

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Tool 5: get_item_history returns timeline with diffs and disclaimer', async () => {
  const { tempDir, dbPath } = createSeededTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });

    const historyRes = await getItemHistory.handler({ item_uid: 'etsy:item1' }, db);

    assert.strictEqual(historyRes.item_uid, 'etsy:item1');
    assert.strictEqual(historyRes.total_snapshots, 2);
    assert.ok(historyRes.disclaimer);

    const snap1 = historyRes.history[0];
    const snap2 = historyRes.history[1];

    assert.strictEqual(snap1.status, 'new');
    assert.strictEqual(snap1.price.amount, 20.0);
    assert.strictEqual(snap1.engagement.likes, 100);

    assert.strictEqual(snap2.status, 'active');
    assert.strictEqual(snap2.price.amount, 22.0);
    assert.strictEqual(snap2.engagement.likes, 150);
    assert.strictEqual(snap2.metrics_diff.price_diff, 2.0);
    assert.strictEqual(snap2.metrics_diff.likes_diff, 50);
    assert.strictEqual(snap2.metrics_diff.comments_diff, 5);
    assert.strictEqual(snap2.metrics_diff.status_changed, true);

    // Dropped item history can still be viewed in get_item_history
    const droppedHistory = await getItemHistory.handler({ item_uid: 'etsy:item2' }, db);
    assert.strictEqual(droppedHistory.total_snapshots, 2);
    assert.strictEqual(droppedHistory.history[1].status, 'dropped');

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Tool 6: get_items_insights_summary returns statistical aggregations and no business advice', async () => {
  const { tempDir, dbPath } = createSeededTempDb();
  try {
    const db = createReadOnlyDb({ dbPath });

    const summaryRes = await getItemsInsightsSummary.handler({}, db);

    assert.strictEqual(summaryRes.overview.total_snapshots, 7); // 3 in run1 + 3 in run2 + 1 in run3 (run 4 failed excluded)
    assert.strictEqual(summaryRes.overview.unique_items_count, 5);

    assert.ok(Array.isArray(summaryRes.platform_distribution));
    assert.ok(Array.isArray(summaryRes.status_distribution));

    assert.strictEqual(summaryRes.price_statistics.min, 12.99);
    assert.strictEqual(summaryRes.price_statistics.max, 30.0);

    assert.ok(summaryRes.engagement_distribution.likes.max >= 500);

    // Verify no business recommendation fields exist
    assert.strictEqual(summaryRes.recommendations, undefined);
    assert.strictEqual(summaryRes.business_advice, undefined);

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
