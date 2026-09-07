const test = require('node:test');
const assert = require('node:assert/strict');

// §16/§20.M: Reddit's tier-escalation classification must distinguish
// endpoint failures (403/404/BLOCKED_IP — escalate immediately) from
// rate-limit/server-transient failures (429/5xx — bounded retry via the
// OUTER scrapeWithRetry loop first, only escalating tiers once that budget
// is exhausted). global.fetch is monkey-patched per test (reddit.js uses the
// native global fetch when no proxy is configured) and always restored.
function withMockFetch(handler, run) {
  const original = global.fetch;
  global.fetch = handler;
  return run().finally(() => { global.fetch = original; });
}

function successResponse(itemId) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: { children: itemId ? [{ kind: 't3', data: { id: itemId, title: 'Title ' + itemId, permalink: `/r/x/comments/${itemId}/t`, ups: 1 } }] : [] } })
  };
}

function failResponse(status, statusText) {
  return { ok: false, status, statusText, json: async () => ({}) };
}

test('Reddit 404 on the primary API escalates to the old.reddit tier immediately, regardless of outer attempt budget (#16)', async () => {
  await withMockFetch(async (url) => (String(url).includes('old.reddit.com') ? successResponse('abc') : failResponse(404, 'Not Found')), async () => {
    const { scrape } = require('../src/scrapers/reddit');
    const result = await scrape('test query', { attempt: 1, maxAttempts: 5 });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, 'abc');
  });
});

test('Reddit 429 does NOT escalate tiers while outer retry budget remains — bounded retry first (#16)', async () => {
  let oldRedditCalled = false;
  await withMockFetch(async (url) => {
    if (String(url).includes('old.reddit.com')) { oldRedditCalled = true; return successResponse('x'); }
    return failResponse(429, 'Too Many Requests');
  }, async () => {
    const { scrape } = require('../src/scrapers/reddit');
    await assert.rejects(() => scrape('test query', { attempt: 1, maxAttempts: 3 }), /HTTP 429/);
    assert.equal(oldRedditCalled, false, 'old.reddit must not be tried while the outer bounded-retry budget still has attempts left');
  });
});

test('Reddit 503 gets bounded transient retry, not immediate tier escalation (#16)', async () => {
  let oldRedditCalled = false;
  await withMockFetch(async (url) => {
    if (String(url).includes('old.reddit.com')) { oldRedditCalled = true; return successResponse('x'); }
    return failResponse(503, 'Service Unavailable');
  }, async () => {
    const { scrape } = require('../src/scrapers/reddit');
    await assert.rejects(() => scrape('test query', { attempt: 1, maxAttempts: 3 }), /HTTP 503/);
    assert.equal(oldRedditCalled, false, 'old.reddit must not be tried on the first attempt of a 503 (bounded retry first)');
  });
});

test('Reddit 429 escalates to the next tier once the outer retry budget is exhausted (#16)', async () => {
  await withMockFetch(async (url) => (String(url).includes('old.reddit.com') ? successResponse('z') : failResponse(429, 'Too Many Requests')), async () => {
    const { scrape } = require('../src/scrapers/reddit');
    const result = await scrape('test query', { attempt: 3, maxAttempts: 3 }); // last attempt
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, 'z');
  });
});

test('Reddit source tagging identifies which tier actually served the result (#3)', async () => {
  await withMockFetch(async () => successResponse('direct1'), async () => {
    const { scrape } = require('../src/scrapers/reddit');
    const result = await scrape('test query', { attempt: 1, maxAttempts: 1 });
    assert.equal(result.source, 'reddit_api');
  });

  await withMockFetch(async (url) => (String(url).includes('old.reddit.com') ? successResponse('legacy1') : failResponse(404, 'Not Found')), async () => {
    const { scrape } = require('../src/scrapers/reddit');
    const result = await scrape('test query', { attempt: 1, maxAttempts: 1 });
    assert.equal(result.source, 'reddit_api_old');
  });
});
