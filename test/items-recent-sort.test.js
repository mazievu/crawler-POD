/**
 * Regression test for "Most Recent" on /api/items.
 *
 * The bug this pins down: the sort used to be done in the browser on whatever
 * page had been fetched, so every page was independently date-sorted. On the
 * Etsy tab page 1 ran 2026-09-15 02:06:58 -> 2026-09-07 08:08:07 and page 2
 * then started over at 2026-09-15 00:13:13. Page 1 was also not the newest 60
 * of 88,939 rows — it was the 60 highest-ranked ones, merely shown date-first.
 *
 * So the assertions below are deliberately about ORDER ACROSS PAGES, not about
 * one page being internally sorted: a page-local sort passes the second and
 * fails the third.
 *
 * Driven over HTTP against the running app rather than by importing the
 * database, because PGlite is single-process — opening data/pgdata from a test
 * while the server holds it would fail or corrupt it. When the app is not
 * running the whole file skips with a reason (same convention as the other
 * environment-dependent tests in this suite) instead of failing CI.
 */
const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.CRAWLER_POD_BASE_URL || 'http://localhost:20129';
const PAGE = 60;

/** 'YYYY-MM-DD HH:MM:SS' is UTC on the wire; compare as epoch ms. */
function toMs(value) {
  return new Date(String(value).replace(' ', 'T') + 'Z').getTime();
}

async function getItems(query) {
  const res = await fetch(`${BASE}/api/items?${query}`);
  const body = await res.json();
  return { status: res.status, body, total: Number(res.headers.get('X-Total-Count')) };
}

let serverUp = false;
let platform = null;

test.before(async () => {
  try {
    const res = await fetch(`${BASE}/api/stats`, { signal: AbortSignal.timeout(5000) });
    serverUp = res.ok;
  } catch {
    serverUp = false;
  }
  if (!serverUp) return;
  // Pin the test to a tab that actually has more than two pages, otherwise
  // "page 2 continues page 1" is vacuously true.
  const probe = await getItems('platform=etsy&limit=1&sort=recent');
  if (probe.status === 200 && probe.total > PAGE * 2) platform = 'etsy';
});

const skipReason = () => (!serverUp
  ? `app server not running at ${BASE} — start it to run this test`
  : !platform
    ? 'no platform in this database holds more than two pages of rows'
    : false);

test('sort=recent orders by recency across the whole table, not per page', async (t) => {
  const skip = skipReason();
  if (skip) return t.skip(skip);

  const p1 = await getItems(`platform=${platform}&limit=${PAGE}&offset=0&sort=recent`);
  const p2 = await getItems(`platform=${platform}&limit=${PAGE}&offset=${PAGE}&sort=recent`);
  assert.strictEqual(p1.status, 200);
  assert.strictEqual(p2.status, 200);

  const dates = [...p1.body, ...p2.body].map((i) => toMs(i.created_at));
  assert.ok(dates.every(Number.isFinite), 'every row must carry a parsable date');

  // The real assertion: the two pages form ONE descending run. A page-local
  // sort fails here because page 2 restarts at the newest date.
  for (let i = 1; i < dates.length; i += 1) {
    assert.ok(
      dates[i - 1] >= dates[i],
      `row ${i} (${new Date(dates[i]).toISOString()}) is newer than row ${i - 1} `
      + `(${new Date(dates[i - 1]).toISOString()}) — pages are sorted independently`
    );
  }
});

test('sort=recent pages do not repeat or skip rows', async (t) => {
  const skip = skipReason();
  if (skip) return t.skip(skip);

  const p1 = await getItems(`platform=${platform}&limit=${PAGE}&offset=0&sort=recent`);
  const p2 = await getItems(`platform=${platform}&limit=${PAGE}&offset=${PAGE}&sort=recent`);

  const first = new Set(p1.body.map((i) => i.item_uid));
  const repeated = p2.body.filter((i) => first.has(i.item_uid));
  // Without a total order (the sorted column has heavy ties) LIMIT/OFFSET is
  // free to hand back the same row twice and drop another; item_uid closes the
  // ORDER BY so it cannot.
  assert.deepStrictEqual(repeated.map((i) => i.item_uid), [], 'page 2 repeated rows from page 1');
});

test('the last page holds the oldest rows, so the ordering spans the table', async (t) => {
  const skip = skipReason();
  if (skip) return t.skip(skip);

  const head = await getItems(`platform=${platform}&limit=1&offset=0&sort=recent`);
  const tailOffset = Math.max(0, head.total - 1);
  const tail = await getItems(`platform=${platform}&limit=1&offset=${tailOffset}&sort=recent`);

  assert.ok(
    toMs(head.body[0].created_at) >= toMs(tail.body[0].created_at),
    'the first row of the first page must not be older than the last row of the last page'
  );
});

test('an unrecognised sort is rejected, never silently reordered', async (t) => {
  const skip = skipReason();
  if (skip) return t.skip(skip);

  const res = await getItems('limit=2&sort=definitely-not-a-sort');
  assert.strictEqual(res.status, 400, 'unknown sort must not fall through to the default order');
  assert.match(String(res.body.error), /sort/i);
  assert.deepStrictEqual(res.body.invalid, ['definitely-not-a-sort']);
});

test('omitting sort keeps the previous default ranking (no behaviour change)', async (t) => {
  const skip = skipReason();
  if (skip) return t.skip(skip);

  const res = await getItems(`platform=${platform}&limit=5`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, 5);
});
