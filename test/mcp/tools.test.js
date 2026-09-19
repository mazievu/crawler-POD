'use strict';

const test = require('node:test');
const assert = require('node:assert');

const listDataSources = require('../../src/mcp/tools/list-data-sources');
const describeItemSchema = require('../../src/mcp/tools/describe-item-schema');
const searchItems = require('../../src/mcp/tools/search-items');
const getItem = require('../../src/mcp/tools/get-item');
const getItemHistory = require('../../src/mcp/tools/get-item-history');
const getItemsInsightsSummary = require('../../src/mcp/tools/get-items-insights-summary');

/**
 * Creates an in-memory stub db implementing the 5 read methods expected by
 * createReadOnlyDb() to test the tool handlers without requiring a live
 * PostgreSQL connection or obsolete SQLite database file.
 */
function createStubDb() {
  const currentItems = [
    {
      item_uid: 'etsy:item1',
      title: 'Pink Press On Nails (Updated)',
      url: 'https://etsy.com/item1',
      image: 'https://img.etsy.com/1.jpg',
      author: 'NailQueen',
      platform: 'etsy',
      query: 'nail art',
      price: 22.0,
      likes: 150,
      comments: 15,
      shares: 5,
      views: 800,
      status: 'active',
      raw_data: '{"currency": "USD"}',
      first_seen_at: '2026-08-01 10:01:00',
      created_at: '2026-08-02 10:01:00',
      run_completed_at: '2026-08-02 10:05:00',
    },
    {
      item_uid: 'etsy:item3',
      title: 'French Tip Nails',
      url: 'https://etsy.com/item3',
      image: 'https://img.etsy.com/3.jpg',
      author: 'ClassicNails',
      platform: 'etsy',
      query: 'nail art',
      price: 25.0,
      likes: 80,
      comments: 8,
      shares: 1,
      views: 400,
      status: 'new',
      raw_data: '{}',
      first_seen_at: '2026-08-01 10:03:00',
      created_at: '2026-08-01 10:03:00',
      run_completed_at: '2026-08-02 10:05:00',
    },
    {
      item_uid: 'etsy:item4',
      title: 'Cat Eye Nail Set',
      url: 'https://etsy.com/item4',
      image: 'https://img.etsy.com/4.jpg',
      author: 'CatNails',
      platform: 'etsy',
      query: 'nail art',
      price: 30.0,
      likes: 20,
      comments: 2,
      shares: 0,
      views: 100,
      status: 'new',
      raw_data: '{"currency": "USD"}',
      first_seen_at: '2026-08-02 10:03:00',
      created_at: '2026-08-02 10:03:00',
      run_completed_at: '2026-08-02 10:05:00',
    },
    {
      item_uid: 'amazon:item5',
      title: 'Amazon Basics Nail Kit',
      url: 'https://amazon.com/dp/item5',
      image: 'https://img.amazon.com/5.jpg',
      author: 'AmazonBasics',
      platform: 'amazon',
      query: 'press on nails',
      price: 12.99,
      likes: 500,
      comments: 30,
      shares: 10,
      views: 5000,
      status: 'new',
      raw_data: '{"currency": "USD"}',
      first_seen_at: '2026-08-03 10:01:00',
      created_at: '2026-08-03 10:01:00',
      run_completed_at: '2026-08-03 10:05:00',
    },
  ];

  return {
    async close() {},

    async listPlatformsWithStats() {
      return [
        {
          platform: 'etsy',
          display_name: 'Etsy',
          description: 'Etsy marketplace',
          query_type: 'keyword',
          country_support: 0,
          icon: '🔗',
          color: '#888888',
          item_count: 5,
          last_successful_crawl_at: '2026-08-02 10:00:00',
          data_as_of: '2026-08-02 10:05:00',
        },
        {
          platform: 'amazon',
          display_name: 'Amazon',
          description: 'Amazon store',
          query_type: 'keyword',
          country_support: 1,
          icon: '🔗',
          color: '#888888',
          item_count: 1,
          last_successful_crawl_at: '2026-08-03 10:00:00',
          data_as_of: '2026-08-03 10:05:00',
        },
        {
          platform: 'pinterest',
          display_name: 'Pinterest',
          description: 'Pinterest pins',
          query_type: 'keyword',
          country_support: 0,
          icon: '🔗',
          color: '#888888',
          item_count: 0,
          last_successful_crawl_at: null,
          data_as_of: null,
        },
      ];
    },

    async searchItems(filterParams = {}) {
      let filtered = [...currentItems];

      if (filterParams.keyword) {
        const kw = filterParams.keyword.toLowerCase();
        filtered = filtered.filter(
          (i) =>
            i.title.toLowerCase().includes(kw) ||
            i.author.toLowerCase().includes(kw) ||
            i.query.toLowerCase().includes(kw)
        );
      }

      if (filterParams.platform) {
        filtered = filtered.filter((i) => i.platform === filterParams.platform);
      }

      if (filterParams.priceMin !== undefined) {
        filtered = filtered.filter((i) => i.price >= filterParams.priceMin);
      }

      if (filterParams.sort === 'price:asc') {
        filtered.sort((a, b) => a.price - b.price);
      }

      const limit = filterParams.limit || 50;
      let rows = filtered;
      let nextCursor = null;

      if (filterParams.cursor === 'cursor-page-2') {
        rows = filtered.slice(2, 4);
      } else if (limit === 2) {
        rows = filtered.slice(0, 2);
        if (filtered.length > 2) nextCursor = 'cursor-page-2';
      }

      return {
        rows,
        nextCursor,
        dataAsOf: '2026-08-03 10:05:00',
      };
    },

    async getItemByUid(uid) {
      if (uid === 'etsy:item2') {
        return { isDropped: true, row: null };
      }
      if (uid === 'etsy:does_not_exist') {
        return null;
      }
      const found = currentItems.find((i) => i.item_uid === uid);
      if (!found) return null;
      return { isDropped: false, row: found };
    },

    async getItemHistory(uid) {
      if (uid === 'etsy:item1') {
        return {
          rows: [
            {
              id: 101,
              run_id: 1,
              status: 'new',
              price: 20.0,
              likes: 100,
              comments: 10,
              shares: 2,
              views: 500,
              created_at: '2026-08-01 10:01:00',
              raw_data: '{"currency": "USD"}',
            },
            {
              id: 104,
              run_id: 2,
              status: 'active',
              price: 22.0,
              likes: 150,
              comments: 15,
              shares: 5,
              views: 800,
              created_at: '2026-08-02 10:01:00',
              raw_data: '{"currency": "USD"}',
            },
          ],
          nextCursor: null,
        };
      }
      if (uid === 'etsy:item2') {
        return {
          rows: [
            {
              id: 102,
              run_id: 1,
              status: 'new',
              price: 15.0,
              likes: 50,
              comments: 5,
              shares: 0,
              views: 200,
              created_at: '2026-08-01 10:02:00',
              raw_data: '{"currency": "USD"}',
            },
            {
              id: 105,
              run_id: 2,
              status: 'dropped',
              price: 15.0,
              likes: 50,
              comments: 5,
              shares: 0,
              views: 200,
              created_at: '2026-08-02 10:02:00',
              raw_data: '{"currency": "USD"}',
            },
          ],
          nextCursor: null,
        };
      }
      return { rows: [], nextCursor: null };
    },

    async getInsightsSummary() {
      return {
        stats: {
          total_snapshots: 7,
          unique_items_count: 5,
          earliest_crawl: '2026-08-01 10:00:00',
          latest_crawl: '2026-08-03 10:05:00',
          min_price: 12.99,
          max_price: 30.0,
          avg_price: 21.0,
          price_known_count: 7,
          price_unknown_or_zero_count: 0,
          min_likes: 20,
          max_likes: 500,
          avg_likes: 150,
          total_likes: 850,
          min_comments: 0,
          max_comments: 30,
          avg_comments: 10,
          total_comments: 65,
          min_shares: 0,
          max_shares: 10,
          avg_shares: 3,
          total_shares: 18,
          min_views: 100,
          max_views: 5000,
          avg_views: 1000,
          total_views: 7000,
        },
        platformDistribution: [
          { platform: 'etsy', count: 6, unique_count: 4 },
          { platform: 'amazon', count: 1, unique_count: 1 },
        ],
        statusDistribution: [
          { status: 'new', count: 4 },
          { status: 'active', count: 2 },
          { status: 'dropped', count: 1 },
        ],
      };
    },
  };
}

test('Tool 1: list_data_sources returns platform summaries and crawl dates', async () => {
  const db = createStubDb();
  const result = await listDataSources.handler({}, db);

  assert.ok(Array.isArray(result.sources));
  assert.strictEqual(result.total_sources, 3);

  const etsySource = result.sources.find((s) => s.platform === 'etsy');
  assert.ok(etsySource);
  assert.strictEqual(etsySource.display_name, 'Etsy');
  assert.strictEqual(etsySource.item_count, 5); // 3 from run1 + 2 non-dropped from run2
  assert.strictEqual(etsySource.last_successful_crawl_at, '2026-08-02 10:00:00');
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
  const db = createStubDb();

  // 1. Search all current items
  const allSearch = await searchItems.handler({}, db);
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
});

test('Tool 4: get_item returns full Item Contract for active item, and status "not_current" for dropped item', async () => {
  const db = createStubDb();

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
});

test('Tool 5: get_item_history returns timeline with diffs and disclaimer', async () => {
  const db = createStubDb();

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
});

test('Tool 6: get_items_insights_summary returns statistical aggregations and no business advice', async () => {
  const db = createStubDb();

  const summaryRes = await getItemsInsightsSummary.handler({}, db);

  assert.strictEqual(summaryRes.overview.total_snapshots, 7);
  assert.strictEqual(summaryRes.overview.unique_items_count, 5);

  assert.ok(Array.isArray(summaryRes.platform_distribution));
  assert.ok(Array.isArray(summaryRes.status_distribution));

  assert.strictEqual(summaryRes.price_statistics.min, 12.99);
  assert.strictEqual(summaryRes.price_statistics.max, 30.0);

  assert.ok(summaryRes.engagement_distribution.likes.max >= 500);

  // Verify no business recommendation fields exist
  assert.strictEqual(summaryRes.recommendations, undefined);
  assert.strictEqual(summaryRes.business_advice, undefined);
});
