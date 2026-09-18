'use strict';

/*
 * The card grid is being changed from "some metrics in a vertical box, some on a
 * horizontal dot-separated line above it" to "every metric in the vertical box".
 *
 * The layout itself is not what these tests pin — CSS is not worth unit testing.
 * What they pin is the thing the layout change can silently break: WHICH metrics
 * each platform shows. Every row asserted below is a metric that is on the card
 * today, so a passing suite means the redesign moved things without losing them.
 *
 * buildItemMetricRows() is deliberately pure: it takes an item plus the three
 * formatting helpers and returns row descriptors. No DOM, so it runs in Node.
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildItemMetricRows } = require('../public/item-metric-rows.js');

// Identity-ish stubs: the tests assert WHICH metric is present and what value it
// carries, not how a number is punctuated. Real formatting is exercised in the
// browser, where it is actually visible.
const helpers = {
  formatCommas: (n) => String(n),
  formatNum: (n) => String(n),
  formatTimeAgo: (d) => (d ? `ago(${d})` : '—'),
  escapeHtml: (s) => String(s),
};

const rowsFor = (item) => buildItemMetricRows(item, helpers);
const labels = (item) => rowsFor(item).map((r) => r.label);
const rowNamed = (item, label) => rowsFor(item).find((r) => r.label === label);

// ---------------------------------------------------------------- e-commerce

test('etsy card keeps Sold, Daily sales, Favorers, Created, Updated', () => {
  const item = {
    platform: 'etsy',
    sold_count: 298,
    growth: { soldCount: 12 },
    likes: 205,
    first_seen_at: '2026-09-07',
    last_crawled_at: '2026-09-15',
  };

  assert.deepStrictEqual(labels(item), ['Sold', 'Daily sales', 'Favorers', 'Created', 'Updated']);
  assert.strictEqual(rowNamed(item, 'Sold').value, '298');
  assert.strictEqual(rowNamed(item, 'Favorers').value, '205');
});

test('ebay names its follower metric Watchers, not Favorers', () => {
  const item = { platform: 'ebay', views: 40, likes: 7 };
  assert.ok(labels(item).includes('Watchers'));
  assert.ok(!labels(item).includes('Favorers'));
});

/*
 * The bug these pin: the follower row used to be
 *   value: item.likes || item.saves || item.reviews
 * so an Amazon listing with 0 likes and 361 reviews rendered "Likes 361" —
 * the review count wearing a label for a metric Amazon does not even have,
 * while the detail view for the same product said "361 reviews". A number is
 * only ever allowed under its own name.
 */
test('amazon reports its review count as Reviews, never as Likes', () => {
  const item = { platform: 'amazon', likes: 0, reviews: 361, rating: 4.6 };
  const present = labels(item);

  assert.ok(present.includes('Reviews'), 'amazon must show a Reviews row');
  assert.ok(!present.includes('Likes'), 'amazon has no likes — it must not claim one');
  assert.strictEqual(rowNamed(item, 'Reviews').value, '361');
});

test('ebay calls its review count Feedback, matching the detail view', () => {
  const item = { platform: 'ebay', likes: 0, reviews: 48 };
  assert.ok(labels(item).includes('Feedback'));
  assert.strictEqual(rowNamed(item, 'Feedback').value, '48');
});

test('etsy reports favorers and reviews as two separate rows', () => {
  const item = { platform: 'etsy', likes: 205, reviews: 41 };

  assert.strictEqual(rowNamed(item, 'Favorers').value, '205', 'favorers must come from likes');
  assert.strictEqual(rowNamed(item, 'Reviews').value, '41', 'reviews must come from reviews');
});

test('a zero metric is never filled in from a different metric', () => {
  const item = { platform: 'amazon', likes: 0, saves: 0, reviews: 900 };
  const likeRow = rowNamed(item, 'Likes');

  assert.strictEqual(likeRow, undefined, 'no Likes row at all when there are no likes');
});

test('a listing with views shows Views; one with only sales shows Sold', () => {
  const viewed = { platform: 'etsy', views: 950, sold_count: 0 };
  const sold = { platform: 'etsy', views: 0, sold_count: 575 };

  assert.ok(labels(viewed).includes('Views'));
  assert.ok(labels(sold).includes('Sold'));
});

// ------------------------------------------------- tiktok shop: the new rows

test('tiktok shop moves return position, 30d sales and GMV into the box', () => {
  const item = {
    platform: 'tiktok_shop',
    sold_count: 956,
    likes: 3,
    returnPosition: 7,
    returnPositionChange: 3,
    sold30d: 913,
    gmv: 11400,
  };

  const present = labels(item);
  assert.ok(present.includes('Return position'), 'return position must survive the move off the horizontal line');
  assert.ok(present.includes('Sold 30d'), '30d sales must survive the move');
  assert.ok(present.includes('GMV'), 'GMV must survive the move');
});

test('a rising return position keeps its up indicator', () => {
  const item = { platform: 'tiktok_shop', returnPosition: 7, returnPositionChange: 3 };
  const row = rowNamed(item, 'Return position');

  assert.strictEqual(row.value, '#7');
  assert.deepStrictEqual(row.change, { direction: 'up', amount: 3 });
});

test('a falling return position keeps its down indicator, as a positive amount', () => {
  const item = { platform: 'tiktok_shop', returnPosition: 12, returnPositionChange: -4 };
  const row = rowNamed(item, 'Return position');

  assert.deepStrictEqual(row.change, { direction: 'down', amount: 4 });
});

test('an unchanged return position carries no indicator', () => {
  const item = { platform: 'tiktok_shop', returnPosition: 7, returnPositionChange: 0 };
  assert.strictEqual(rowNamed(item, 'Return position').change, null);
});

test('a listing with no return position does not invent one', () => {
  const item = { platform: 'tiktok_shop', sold_count: 10 };
  assert.ok(!labels(item).includes('Return position'));
});

// ------------------------------------------------------------- facebook ads

test('facebook ads keeps its ad count, views, countries and dates', () => {
  const item = {
    platform: 'facebook_ads',
    adCount: 4,
    fanpageLikes: 1200,
    views: 0,
    activeCountries: ['US', 'GB'],
    startDate: '2026-09-01',
  };

  const present = labels(item);
  ['Số QC', 'Fanpage Likes', 'Views', 'Quốc gia', 'Bắt đầu', 'Updated'].forEach((l) => {
    assert.ok(present.includes(l), `facebook ads lost the "${l}" row`);
  });
});

test('facebook ads says Meta withholds views rather than printing a fake zero', () => {
  const item = { platform: 'facebook_ads', views: 0 };
  assert.strictEqual(rowNamed(item, 'Views').value, 'Meta N/A');
});

// ------------------------------------------------------------------- social

test('reddit keeps upvotes, comments and subreddit', () => {
  const item = { platform: 'reddit', likes: 7493, comments: 134, subreddit: 'Nails' };
  const present = labels(item);

  ['Upvotes', 'Comments', 'Subreddit'].forEach((l) => {
    assert.ok(present.includes(l), `reddit lost the "${l}" row`);
  });
  assert.strictEqual(rowNamed(item, 'Subreddit').value, 'r/Nails');
});

test('twitter keeps views, likes, replies and retweets', () => {
  const item = { platform: 'twitter', views: 158, likes: 1, comments: 0, shares: 1 };
  const present = labels(item);

  ['Views', 'Likes', 'Replies', 'Retweets'].forEach((l) => {
    assert.ok(present.includes(l), `twitter lost the "${l}" row`);
  });
});

test('an unknown platform still gets the generic social rows', () => {
  const item = { platform: 'pinterest', views: 10, likes: 2, comments: 1, saves: 5 };
  const present = labels(item);

  ['Views', 'Likes', 'Comments'].forEach((l) => {
    assert.ok(present.includes(l), `social fallback lost the "${l}" row`);
  });
});

// ------------------------------------------------------------- shape contract

test('every row is renderable: a label, a string value, and a known colour class', () => {
  const platforms = ['etsy', 'tiktok_shop', 'facebook_ads', 'reddit', 'twitter', 'pinterest'];
  const allowed = new Set(['val-red', 'val-blue', 'val-teal', 'val-orange']);

  for (const platform of platforms) {
    for (const row of rowsFor({ platform, views: 1, likes: 1, returnPosition: 2 })) {
      assert.ok(row.label, `${platform}: row with no label`);
      assert.strictEqual(typeof row.value, 'string', `${platform}: "${row.label}" value is not a string`);
      assert.ok(allowed.has(row.cls), `${platform}: "${row.label}" has unknown colour class ${row.cls}`);
    }
  }
});
