const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMetricNumber,
  parseConditions,
  readMetric,
  evaluateConditions,
  applyConditions,
  buildSqlFilter,
  buildSqlOrder,
  metricsForGroup,
  ECOM,
  SOCIAL,
} = require('../src/filters/metric-conditions');

test('parseMetricNumber: provider-formatted numbers become real numbers', () => {
  assert.equal(parseMetricNumber(1234), 1234);
  assert.equal(parseMetricNumber('1234'), 1234);
  assert.equal(parseMetricNumber('1,234'), 1234);
  assert.equal(parseMetricNumber('160.23K'), 160230);
  assert.equal(parseMetricNumber('$2.95M'), 2950000);
  assert.equal(parseMetricNumber('$8.33'), 8.33);
  assert.equal(parseMetricNumber('4.6'), 4.6);
});

test('parseMetricNumber: absent is null, zero is zero', () => {
  // The whole point of returning null rather than 0: "no value reported" and
  // "the value is zero" drive opposite filter outcomes.
  assert.equal(parseMetricNumber(null), null);
  assert.equal(parseMetricNumber(undefined), null);
  assert.equal(parseMetricNumber(''), null);
  assert.equal(parseMetricNumber('   '), null);
  assert.equal(parseMetricNumber('N/A'), null);
  assert.equal(parseMetricNumber('*'), null); // TikTok Shop masks some prices with "*"
  assert.equal(parseMetricNumber(NaN), null);
  assert.equal(parseMetricNumber(true), null);
  assert.equal(parseMetricNumber(0), 0);
  assert.equal(parseMetricNumber('0'), 0);
});

test('parseConditions: accepts symbols and names, drops what it cannot understand', () => {
  const { conditions, invalid } = parseConditions([
    { field: 'likes', operator: '>=', value: 1000 },
    { field: 'shares', operator: 'gte', value: '100' },
    { field: 'price', operator: '<', value: '$50' },
    { field: 'sold', operator: '>=', value: '1K' },
    { field: 'wingspan', operator: '>=', value: 5 },      // unknown metric
    { field: 'likes', operator: 'LIKE', value: 5 },        // unknown operator
    { field: 'likes', operator: '>=', value: 'many' },     // unparseable threshold
    'not-an-object',
  ]);

  assert.deepEqual(conditions, [
    { field: 'likes', operator: 'gte', value: 1000 },
    { field: 'shares', operator: 'gte', value: 100 },
    { field: 'price', operator: 'lt', value: 50 },
    { field: 'sold', operator: 'gte', value: 1000 },
  ]);
  assert.deepEqual(invalid.map((i) => i.reason), [
    'unknown_field', 'unknown_operator', 'non_numeric_value', 'not_an_object',
  ]);
});

test('readMetric: finds a metric under whichever spelling the normalizer used', () => {
  // product_listing emits reviewCount/soldCount; product_current stores
  // current_reviews/current_sold; both must resolve to the same metric.
  assert.equal(readMetric({ reviewCount: 19570 }, 'reviews'), 19570);
  assert.equal(readMetric({ current_reviews: 19570 }, 'reviews'), 19570);
  assert.equal(readMetric({ soldCount: '160.23K' }, 'sold'), 160230);
  assert.equal(readMetric({}, 'likes'), null);
});

test('evaluateConditions: multi-condition is AND, and every rejection is explainable', () => {
  const conditions = parseConditions([
    { field: 'likes', operator: '>=', value: 1000 },
    { field: 'shares', operator: '>=', value: 100 },
  ]).conditions;

  const both = evaluateConditions({ likes: 5000, shares: 250 }, conditions);
  assert.equal(both.kept, true);
  assert.deepEqual(both.reasons, []);

  // Satisfying only one condition is not enough — this is the AND requirement.
  const onlyLikes = evaluateConditions({ likes: 5000, shares: 12 }, conditions);
  assert.equal(onlyLikes.kept, false);
  assert.equal(onlyLikes.reasons.length, 1);
  assert.match(onlyLikes.reasons[0], /shares=12 fails >= 100/);

  const neither = evaluateConditions({ likes: 3, shares: 1 }, conditions);
  assert.equal(neither.kept, false);
  assert.equal(neither.reasons.length, 2);
});

test('evaluateConditions: an unreported metric rejects, it never passes by default', () => {
  const conditions = parseConditions([{ field: 'views', operator: '>=', value: 1 }]).conditions;

  const missing = evaluateConditions({ likes: 10 }, conditions);
  assert.equal(missing.kept, false);
  assert.match(missing.reasons[0], /views is not reported/);
  assert.equal(missing.values.views, null);

  // A genuine zero is compared, not treated as missing.
  const zero = evaluateConditions({ views: 0 }, conditions);
  assert.equal(zero.kept, false);
  assert.match(zero.reasons[0], /views=0 fails >= 1/);

  // ...and a "keep the quiet ones" filter must accept that same zero.
  const quiet = parseConditions([{ field: 'views', operator: '<=', value: 10 }]).conditions;
  assert.equal(evaluateConditions({ views: 0 }, quiet).kept, true);
  assert.equal(evaluateConditions({}, quiet).kept, false); // unknown still rejects
});

test('readMetric: a negative count is a provider sentinel, not a measurement', () => {
  // Instagram returns likesCount -1 when the author hides the like count
  // (observed on run #423, post Dc-pYjViJw2). Treating it as the number -1
  // would make "likes <= 0" match a post whose likes are merely hidden.
  assert.equal(readMetric({ likes: -1 }, 'likes'), null);
  assert.equal(readMetric({ views: -1 }, 'views'), null);
  assert.equal(readMetric({ likes: 0 }, 'likes'), 0); // a real zero still reads as zero

  const atMost = parseConditions([{ field: 'likes', operator: '<=', value: 0 }]).conditions;
  assert.equal(evaluateConditions({ likes: 0 }, atMost).kept, true);
  assert.equal(evaluateConditions({ likes: -1 }, atMost).kept, false);
  assert.match(evaluateConditions({ likes: -1 }, atMost).reasons[0], /likes is not reported/);

  const atLeast = parseConditions([{ field: 'likes', operator: '>=', value: 5 }]).conditions;
  assert.equal(evaluateConditions({ likes: -1 }, atLeast).kept, false);
});

test('applyConditions: no conditions keeps every item (previous behaviour)', () => {
  const items = [{ likes: 1 }, { likes: 2 }];
  assert.deepEqual(applyConditions(items, []).kept, items);
  assert.deepEqual(applyConditions(items, []).rejected, []);
  assert.deepEqual(applyConditions(items, undefined).kept, items);
});

test('applyConditions: splits a batch and records why each item was dropped', () => {
  const conditions = parseConditions([
    { field: 'likes', operator: '>=', value: 100 },
    { field: 'comments', operator: '>=', value: 5 },
  ]).conditions;

  const { kept, rejected } = applyConditions([
    { id: 'A', likes: 500, comments: 20 },
    { id: 'B', likes: 500, comments: 1 },
    { id: 'C', likes: 2, comments: 40 },
  ], conditions);

  assert.deepEqual(kept.map((i) => i.id), ['A']);
  assert.deepEqual(rejected.map((r) => r.item.id), ['B', 'C']);
  assert.match(rejected[0].reasons[0], /comments=1 fails >= 5/);
  assert.match(rejected[1].reasons[0], /likes=2 fails >= 100/);
});

test('buildSqlFilter: whitelisted columns inline, values always bound', () => {
  const conditions = parseConditions([
    { field: 'likes', operator: '>=', value: 1000 },
    { field: 'price', operator: '<', value: 50 },
  ]).conditions;

  const { sql, params } = buildSqlFilter(conditions);
  assert.equal(sql, 'current_likes >= @mc0 AND current_price < @mc1');
  assert.deepEqual(params, { mc0: 1000, mc1: 50 });
});

test('buildSqlFilter: an injection attempt cannot survive parseConditions', () => {
  // The field never reaches SQL as text — it must match a METRICS key first.
  const { conditions, invalid } = parseConditions([
    { field: 'current_likes; DROP TABLE runs;--', operator: '>=', value: 1 },
  ]);
  assert.deepEqual(conditions, []);
  assert.equal(invalid[0].reason, 'unknown_field');
  assert.equal(buildSqlFilter(conditions).sql, '');
});

test('buildSqlOrder: ranking is whitelisted and puts unknown values last', () => {
  assert.equal(buildSqlOrder('likes', 'desc'), 'current_likes DESC NULLS LAST');
  assert.equal(buildSqlOrder('price', 'asc'), 'current_price ASC NULLS LAST');
  assert.equal(buildSqlOrder('likes', 'DESC; DROP TABLE runs'), 'current_likes DESC NULLS LAST');
  assert.equal(buildSqlOrder('nonsense', 'desc'), null);
});

test('metric groups match the two panels the UI has to render', () => {
  assert.deepEqual(metricsForGroup(ECOM).map((m) => m.name), ['price', 'rating', 'reviews', 'sold', 'likes']);
  // `saves` joined SOCIAL when TikTok video crawling landed: the provider
  // reports collectCount separately from shareCount.
  assert.deepEqual(metricsForGroup(SOCIAL).map((m) => m.name), ['likes', 'comments', 'shares', 'views', 'saves']);
});

test('saves is its own metric, not an alias of shares', () => {
  const { METRICS, buildSqlFilter, readMetric } = require('../src/filters/metric-conditions');

  // Distinct columns — folding saves into shares would report a number for
  // shares that the provider never measured.
  assert.equal(METRICS.saves.column, 'current_saves');
  assert.notEqual(METRICS.saves.column, METRICS.shares.column);

  // readMetric reads a NORMALIZED item (social-post.js has already mapped
  // shareCount -> shares and collectCount -> saves), so the two must stay
  // independent all the way through rather than collapsing into one number.
  const normalized = { shares: 4929, saves: 20238 };
  assert.equal(readMetric(normalized, 'shares'), 4929);
  assert.equal(readMetric(normalized, 'saves'), 20238);

  // A post that is shared but never saved must report 0 saves, not its shares.
  assert.equal(readMetric({ shares: 4929, saves: 0 }, 'saves'), 0);

  const { sql } = buildSqlFilter([{ field: 'saves', operator: 'gt', value: 0 }]);
  assert.match(sql, /current_saves > @mc0/);
});
