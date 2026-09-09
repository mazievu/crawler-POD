const test = require('node:test');
const assert = require('node:assert/strict');

const { INPUT_BUILDERS, ACTOR_INPUT_BUILDERS, ACTOR_PAGE_LIMITS } = require('../src/apify-client');
const ApifyBackend = require('../src/backends/apify.backend');
const { nextScheduleRunAt, normalizeScheduleInput } = require('../src/marketplaces/capture-scheduler');
const tiktokShopChannel = require('../src/channels/tiktok_shop.channel');

/*
 * Task 5 Top-20 logic, verified without a paid 20-item run.
 *
 * Every fact asserted here was read from the actors' own live input schemas on
 * 2026-09-07:
 *   pratikdani/tiktok-shop-search-scraper -> limit.maximum = 10, page.minimum = 1
 *   unseenuser/TikTok-Shop-Scraper        -> maxResults.maximum = 5000
 */

test('TikTok Shop: the 10-per-call cap belongs to the actor that declares it', () => {
  assert.equal(ACTOR_PAGE_LIMITS['pratikdani/tiktok-shop-search-scraper'], 10);
  // The other actor caps at 5000, so listing it here would halve throughput for
  // no reason and force pointless extra paid calls.
  assert.equal(ACTOR_PAGE_LIMITS['unseenuser/TikTok-Shop-Scraper'], undefined);
});

test('TikTok Shop: a 20-item request never asks a capped actor for 20 in one call', () => {
  const page1 = INPUT_BUILDERS.tiktok_shop({ query: 'press on nails', maxItems: 20, country: 'US', page: 1 });
  assert.deepEqual(page1, { country_code: 'US', keyword: 'press on nails', limit: 10, page: 1 });

  const page2 = INPUT_BUILDERS.tiktok_shop({ query: 'press on nails', maxItems: 20, country: 'US', page: 2 });
  assert.equal(page2.page, 2);
  assert.equal(page2.limit, 10);

  // The uncapped actor takes the full 20 in a single call.
  const single = ACTOR_INPUT_BUILDERS['unseenuser/TikTok-Shop-Scraper']({ query: 'press on nails', maxItems: 20, country: 'US' });
  assert.deepEqual(single, { mode: 'shop_search', searchKeywords: ['press on nails'], region: 'US', maxResults: 20 });
});

test('TikTok Shop: country reaches the actor as its required market field', () => {
  assert.equal(INPUT_BUILDERS.tiktok_shop({ query: 'x', maxItems: 5, country: 'us' }).country_code, 'US');
  assert.equal(ACTOR_INPUT_BUILDERS['unseenuser/TikTok-Shop-Scraper']({ query: 'x', maxItems: 5, country: 'uk' }).region, 'UK');
  // country_code is this actor's only required input, so it must never be empty.
  assert.equal(INPUT_BUILDERS.tiktok_shop({ query: 'x', maxItems: 5 }).country_code, 'US');
});

test('TikTok Shop: paging walks consecutive pages and concatenates without duplicates', async () => {
  const backend = new ApifyBackend();
  const calls = [];
  // Stub the single-page path so this exercises the paging decision only — no
  // token, no network, no paid call.
  backend.run = async function (channel, backendConfig, query, options) {
    calls.push({ page: options.page, maxItems: options.maxItems });
    const start = (options.page - 1) * 10;
    return {
      backend: 'apify',
      backendRunId: 'run-' + options.page,
      rawStatus: 'SUCCEEDED',
      items: Array.from({ length: options.maxItems }, (_, i) => ({ product_id: String(start + i + 1) })),
    };
  };

  const result = await ApifyBackend.prototype.runPaged.call(
    backend, { name: 'tiktok_shop' }, { actorId: 'pratikdani/tiktok-shop-search-scraper' }, 'press on nails', {}, 20, 10
  );

  assert.deepEqual(calls, [{ page: 1, maxItems: 10 }, { page: 2, maxItems: 10 }]);
  assert.equal(result.items.length, 20);
  assert.deepEqual(result.items.map((i) => i.product_id).slice(0, 3), ['1', '2', '3']);
  assert.equal(new Set(result.items.map((i) => i.product_id)).size, 20);
  assert.equal(result.pagesFetched, 2);
});

test('TikTok Shop: a short page ends paging instead of buying an empty one', async () => {
  const backend = new ApifyBackend();
  let callCount = 0;
  backend.run = async function (channel, backendConfig, query, options) {
    callCount++;
    // Provider has only 4 products for this query.
    return { backend: 'apify', rawStatus: 'SUCCEEDED', backendRunId: 'r' + callCount,
      items: Array.from({ length: 4 }, (_, i) => ({ product_id: 'p' + i })) };
  };

  const result = await ApifyBackend.prototype.runPaged.call(
    backend, { name: 'tiktok_shop' }, { actorId: 'pratikdani/tiktok-shop-search-scraper' }, 'q', {}, 20, 10
  );

  assert.equal(callCount, 1, 'page 2 must not be requested after a short page 1');
  assert.equal(result.items.length, 4);
});

test('TikTok Shop channel: product actors only, video scraper gone', () => {
  const actorIds = tiktokShopChannel.backends.map((b) => b.actorId);
  assert.ok(actorIds.includes('unseenuser/TikTok-Shop-Scraper'));
  assert.ok(actorIds.includes('pratikdani/tiktok-shop-search-scraper'));
  // clockworks/tiktok-scraper scrapes TikTok VIDEOS — it carries no product,
  // price or sold data, so it must not serve this channel.
  assert.ok(!actorIds.includes('clockworks/tiktok-scraper'));

  const byPriority = [...tiktokShopChannel.backends].sort((a, b) => a.priority - b.priority);
  assert.equal(byPriority[0].actorId, 'unseenuser/TikTok-Shop-Scraper');
});

test('production schedule: daily 09:00 Vietnam time, 20 items, US market', () => {
  const input = normalizeScheduleInput({
    platform: 'tiktok_shop', keyword: 'press on nails', country: 'US',
    maxListings: 20, scheduleType: 'daily', dailyTime: '09:00',
  });
  assert.equal(input.platform, 'tiktok_shop');
  assert.equal(input.keyword, 'press on nails');
  assert.equal(input.country, 'US');
  assert.equal(input.maxListings, 20);
  assert.equal(input.scheduleType, 'daily');
  assert.equal(input.dailyTime, '09:00');

  // 09:00 in Vietnam (UTC+7) is 02:00Z. Asserted in UTC because that is what
  // gets stored, and a schedule that silently ran at 09:00Z would fire seven
  // hours late.
  const next = nextScheduleRunAt(
    { schedule_type: 'daily', daily_time: '09:00' },
    new Date('2026-09-07T12:00:00Z')
  );
  assert.equal(next.toISOString(), '2026-09-08T02:00:00.000Z');

  // Before that morning's slot, the next run is the same day, not tomorrow.
  const beforeSlot = nextScheduleRunAt(
    { schedule_type: 'daily', daily_time: '09:00' },
    new Date('2026-09-07T00:30:00Z')
  );
  assert.equal(beforeSlot.toISOString(), '2026-09-07T02:00:00.000Z');
});
