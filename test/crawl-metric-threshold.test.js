/**
 * Crawl-time minimum-value filter (`metricMin`).
 *
 * Two things have to hold and neither is provable by reading the code:
 *
 *   1. the option SURVIVES the whitelist in buildCollectionOptions(). That
 *      function copies only what it names and drops everything else in
 *      silence — an earlier feature lost `options.metrics` exactly that way and
 *      the run reported success with the filter never applied. These tests
 *      assert the emitted options object directly.
 *
 *   2. the threshold MEANS what the panel says it means: AND across every
 *      ticked metric, `>=`, and "the provider did not report this metric" is a
 *      rejection rather than a zero. That is evaluated by the same two-stage
 *      composition runs.service.js performs (applyConditions -> applySelection),
 *      which is reproduced here rather than paraphrased.
 *
 * Deliberately NO database and NO server import: collection-inputs.js only
 * pulls in filters/metric-conditions.js, so this suite is safe to run while the
 * server holds the PGlite lock.
 */
const test = require('node:test');
const assert = require('node:assert');

const { buildCollectionOptions } = require('../src/collection-inputs');
const {
  parseConditions,
  applyConditions,
  parseMetricSelection,
  applySelection,
  evaluateSelection,
} = require('../src/filters/metric-conditions');

/**
 * The crawl filter exactly as src/runs.service.js applies it: thresholds first,
 * then the ticked metrics decide presence and order. If that file's ordering
 * ever changes, this helper is the thing that has to change with it.
 */
function runCrawlFilter(items, options) {
  const { selected } = parseMetricSelection(options.metrics);
  const { conditions } = parseConditions(options.conditions);
  const afterConditions = applyConditions(items, conditions);
  const afterSelection = applySelection(afterConditions.kept, selected);
  return {
    kept: afterSelection.kept,
    rejected: afterConditions.rejected.concat(afterSelection.rejected),
  };
}

// ---------------------------------------------------------------------------
// 1. The option reaches the pipeline
// ---------------------------------------------------------------------------

test('buildCollectionOptions whitelists `metricMin` and expands it into one >= condition per ticked metric', () => {
  const options = buildCollectionOptions('tiktok_videos', {
    maxItems: 20,
    metrics: ['likes', 'views'],
    metricMin: 1000,
  });

  // The number the user typed is preserved, so the run row records the input
  // and not only what it was turned into.
  assert.equal(options.metricMin, 1000);
  assert.deepEqual(options.metrics, ['likes', 'views']);
  // ...and the conditions the crawl pipeline actually evaluates.
  assert.deepEqual(options.conditions, [
    { field: 'likes', operator: 'gte', value: 1000 },
    { field: 'views', operator: 'gte', value: 1000 },
  ]);
});

test('a single ticked metric gets a single threshold condition', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 5, metrics: ['likes'], metricMin: '2500' });
  assert.equal(options.metricMin, 2500);
  assert.deepEqual(options.conditions, [{ field: 'likes', operator: 'gte', value: 2500 }]);
});

test('`metricMin` accepts the same human formatting the metrics themselves do ("1K" === 1000)', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 5, metrics: ['views'], metricMin: '1K' });
  assert.equal(options.metricMin, 1000);
  assert.deepEqual(options.conditions, [{ field: 'views', operator: 'gte', value: 1000 }]);
});

test('zero is a real threshold, not an empty box', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 5, metrics: ['likes'], metricMin: 0 });
  assert.equal(options.metricMin, 0);
  assert.deepEqual(options.conditions, [{ field: 'likes', operator: 'gte', value: 0 }]);
});

// ---------------------------------------------------------------------------
// 2. No threshold = EXACTLY the previous behaviour (regression guard)
// ---------------------------------------------------------------------------

test('an empty minimum box leaves the options byte-identical to before this feature', () => {
  const withoutFeature = buildCollectionOptions('tiktok_videos', { maxItems: 20, metrics: ['likes', 'views'] });
  assert.equal('metricMin' in withoutFeature, false);
  assert.equal('conditions' in withoutFeature, false);

  for (const blank of [undefined, null, '', '   ']) {
    const emitted = buildCollectionOptions('tiktok_videos', { maxItems: 20, metrics: ['likes', 'views'], metricMin: blank });
    assert.deepEqual(emitted, withoutFeature, `metricMin=${JSON.stringify(blank)} must be treated as "not supplied"`);
  }
});

test('ticking nothing and typing nothing still emits no filter at all', () => {
  const options = buildCollectionOptions('etsy', { maxItems: 20 });
  assert.equal('metrics' in options, false);
  assert.equal('conditions' in options, false);
  assert.equal('metricMin' in options, false);
});

// ---------------------------------------------------------------------------
// 3. Unusable input is REFUSED, never silently dropped
// ---------------------------------------------------------------------------

test('a minimum with no ticked metric is refused rather than crawled without the limit', () => {
  assert.throws(
    () => buildCollectionOptions('tiktok_videos', { maxItems: 20, metricMin: 1000 }),
    /at least one selected metric/i,
  );
});

test('a negative minimum is refused', () => {
  assert.throws(
    () => buildCollectionOptions('tiktok_videos', { maxItems: 20, metrics: ['likes'], metricMin: -5 }),
    /must not be negative/i,
  );
});

test('a non-numeric minimum is refused', () => {
  assert.throws(
    () => buildCollectionOptions('tiktok_videos', { maxItems: 20, metrics: ['likes'], metricMin: 'nhiều' }),
    /must be a number/i,
  );
});

test('a minimum that would silently override an explicit condition on the same metric is refused', () => {
  assert.throws(
    () => buildCollectionOptions('tiktok_videos', {
      maxItems: 20,
      metrics: ['likes'],
      metricMin: 1000,
      conditions: [{ field: 'likes', operator: '<=', value: 50 }],
    }),
    /conflicts with an explicit condition/i,
  );
});

test('an unknown metric name is still refused once a minimum is in play', () => {
  assert.throws(
    () => buildCollectionOptions('tiktok_videos', { maxItems: 20, metrics: ['likes', 'karma'], metricMin: 1000 }),
    /Unknown metric/i,
  );
});

// ---------------------------------------------------------------------------
// 4. The semantics the user asked for: AND across ticks, >=, at crawl time
// ---------------------------------------------------------------------------

const VIDEOS = [
  { uid: 'a', url: 'a', likes: 5000, views: 20000 },  // both over 1000
  { uid: 'b', url: 'b', likes: 1000, views: 1000 },   // exactly 1000 on both -> ">=" keeps it
  { uid: 'c', url: 'c', likes: 999, views: 50000 },   // likes below -> AND fails
  { uid: 'd', url: 'd', likes: 8000, views: 400 },    // views below -> AND fails
  { uid: 'e', url: 'e', likes: 30000 },               // views not reported at all
  { uid: 'f', url: 'f', likes: '160.23K', views: '2.5M' }, // provider-formatted strings
];

test('ticking Likes + Views with 1000 keeps only items where BOTH are >= 1000', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 50, metrics: ['likes', 'views'], metricMin: 1000 });
  const { kept, rejected } = runCrawlFilter(VIDEOS, options);

  assert.deepEqual(kept.map((i) => i.uid), ['f', 'a', 'b']); // ranked likes desc
  assert.deepEqual(rejected.map((r) => r.item.uid).sort(), ['c', 'd', 'e']);
});

test('the boundary is inclusive — 1000 passes a minimum of 1000', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 50, metrics: ['likes'], metricMin: 1000 });
  const { kept } = runCrawlFilter([{ uid: 'x', likes: 1000 }, { uid: 'y', likes: 999 }], options);
  assert.deepEqual(kept.map((i) => i.uid), ['x']);
});

test('an unreported metric is a rejection, not a zero, and the reason names it', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 50, metrics: ['likes', 'views'], metricMin: 1000 });
  const { rejected } = runCrawlFilter(VIDEOS, options);
  const e = rejected.find((r) => r.item.uid === 'e');
  assert.ok(e, 'item e must be rejected');
  assert.match(e.reasons.join(' '), /views is not reported/i);
});

test('a rejection below the threshold says which metric and which number failed', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 50, metrics: ['likes'], metricMin: 1000 });
  const { rejected } = runCrawlFilter([{ uid: 'c', likes: 999 }], options);
  assert.match(rejected[0].reasons.join(' '), /likes=999 fails >= 1000/);
});

test('provider-formatted numbers are compared as numbers, not as text', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 50, metrics: ['likes'], metricMin: 1000 });
  const { kept } = runCrawlFilter([{ uid: 'k', likes: '160.23K' }, { uid: 'm', likes: '900' }], options);
  assert.deepEqual(kept.map((i) => i.uid), ['k']);
});

test('survivors are still ranked highest-first, so the threshold narrows but does not reorder', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 50, metrics: ['likes'], metricMin: 1000 });
  const { kept } = runCrawlFilter(VIDEOS, options);
  const likes = kept.map((i) => (typeof i.likes === 'string' ? 160230 : i.likes));
  assert.deepEqual(likes, [...likes].sort((a, b) => b - a));
});

// ---------------------------------------------------------------------------
// 5. The no-threshold path is untouched
// ---------------------------------------------------------------------------

test('without a minimum, a tick still means only "must report this metric, highest first"', () => {
  const options = buildCollectionOptions('tiktok_videos', { maxItems: 50, metrics: ['likes', 'views'] });
  const { kept, rejected } = runCrawlFilter(VIDEOS, options);

  // c and d are BELOW 1000 on one metric but report both, so with no threshold
  // they are kept — this is the behaviour the empty box must preserve.
  assert.deepEqual(kept.map((i) => i.uid).sort(), ['a', 'b', 'c', 'd', 'f']);
  assert.deepEqual(rejected.map((r) => r.item.uid), ['e']);
});

test('evaluateSelection still reports presence only, with no threshold of its own', () => {
  assert.equal(evaluateSelection({ likes: 1 }, ['likes']).kept, true);
  assert.equal(evaluateSelection({ likes: 0 }, ['likes']).kept, true);
  assert.equal(evaluateSelection({ comments: 5 }, ['likes']).kept, false);
});
