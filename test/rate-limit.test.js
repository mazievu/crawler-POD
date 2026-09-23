'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SlidingWindowMemoryStore,
  createLoginKeyGenerator,
  createRunKeyGenerator,
  createLoginRateLimiter,
  createRunRateLimiter,
} = require('../src/security/rate-limit.middleware');

test('RateLimit: SlidingWindowMemoryStore core behavior', async (t) => {
  await t.test('clean store allows requests and tracks counts', () => {
    let mockTime = 1000000;
    const store = new SlidingWindowMemoryStore({
      windowMs: 60000,
      maxEntries: 5,
      nowProvider: () => mockTime,
    });

    const status1 = store.check('key-1');
    assert.strictEqual(status1.allowed, true);
    assert.strictEqual(status1.remaining, 5);
    assert.strictEqual(status1.total, 0);

    // Consume 3 times
    assert.strictEqual(store.consume('key-1').allowed, true);
    assert.strictEqual(store.consume('key-1').allowed, true);
    const c3 = store.consume('key-1');
    assert.strictEqual(c3.allowed, true);
    assert.strictEqual(c3.remaining, 2);
    assert.strictEqual(c3.total, 3);

    // Consume 2 more to hit cap of 5
    assert.strictEqual(store.consume('key-1').allowed, true);
    const c5 = store.consume('key-1');
    assert.strictEqual(c5.allowed, true);
    assert.strictEqual(c5.remaining, 0);
    assert.strictEqual(c5.total, 5);

    // 6th consume must be rejected
    const c6 = store.consume('key-1');
    assert.strictEqual(c6.allowed, false);
    assert.strictEqual(c6.remaining, 0);
    assert.strictEqual(c6.total, 5);
    assert.ok(c6.retryAfterSeconds > 0);

    store.destroy();
  });

  await t.test('sliding window prunes expired entries deterministically', () => {
    let mockTime = 1000000;
    const store = new SlidingWindowMemoryStore({
      windowMs: 60000, // 60s
      maxEntries: 2,
      nowProvider: () => mockTime,
    });

    assert.strictEqual(store.consume('k').allowed, true); // at t = 1000000
    mockTime += 10000; // t = 1000010
    assert.strictEqual(store.consume('k').allowed, true);
    assert.strictEqual(store.consume('k').allowed, false); // full

    // Advance mock time past the 1st hit (60s + 1ms from 1000000)
    mockTime = 1000000 + 60001; // t = 1060001
    // 1st hit expired, 2nd hit still valid (expires at 1060010)
    const check1 = store.check('k');
    assert.strictEqual(check1.allowed, true);
    assert.strictEqual(check1.total, 1);
    assert.strictEqual(check1.remaining, 1);

    // We can consume 1 more
    assert.strictEqual(store.consume('k').allowed, true);
    // Now full again
    assert.strictEqual(store.consume('k').allowed, false);

    // Advance past 2nd hit (which was at t = 1010000)
    mockTime = 1010000 + 60001;
    const check2 = store.check('k');
    // Only the 3rd hit remains
    assert.strictEqual(check2.total, 1);

    store.destroy();
  });

  await t.test('LRU capacity cap bounds memory to maxKeys', () => {
    const store = new SlidingWindowMemoryStore({
      windowMs: 60000,
      maxEntries: 5,
      maxKeys: 3,
    });

    store.record('k1');
    store.record('k2');
    store.record('k3');
    assert.strictEqual(store.hits.size, 3);

    // Adding 4th key evicts k1 (the oldest)
    store.record('k4');
    assert.strictEqual(store.hits.size, 3);
    assert.strictEqual(store.hits.has('k1'), false);
    assert.strictEqual(store.hits.has('k2'), true);
    assert.strictEqual(store.hits.has('k3'), true);
    assert.strictEqual(store.hits.has('k4'), true);

    store.destroy();
  });

  await t.test('reset and resetAll work cleanly', () => {
    const store = new SlidingWindowMemoryStore({ windowMs: 60000, maxEntries: 5 });
    store.record('a');
    store.record('b');
    assert.strictEqual(store.hits.size, 2);

    store.reset('a');
    assert.strictEqual(store.hits.has('a'), false);
    assert.strictEqual(store.hits.has('b'), true);

    store.resetAll();
    assert.strictEqual(store.hits.size, 0);

    store.destroy();
  });
});

test('RateLimit: Key Generators', async (t) => {
  await t.test('Login key generator normalizes IP and email', () => {
    const keyGen = createLoginKeyGenerator();
    const req1 = { ip: '1.2.3.4', body: { email: '  User@Example.COM  ' } };
    assert.strictEqual(keyGen(req1), '1.2.3.4:user@example.com');

    const req2 = { ip: '1.2.3.4', body: {} };
    assert.strictEqual(keyGen(req2), '1.2.3.4:__anonymous__');
  });

  await t.test('Run key generator follows priority hierarchy', () => {
    const keyGen = createRunKeyGenerator();

    // 1. ApiKey priority
    const r1 = { apiKey: { id: 42 }, user: { id: 99 }, ip: '10.0.0.1' };
    assert.strictEqual(keyGen(r1), 'apikey:42');

    // 2. User priority (without apiKey)
    const r2 = { user: { id: 99 }, session: { sessionToken: 'tok123' }, ip: '10.0.0.1' };
    assert.strictEqual(keyGen(r2), 'user:99');

    // 3. Session priority
    const r3 = { session: { sessionToken: 'tok123' }, ip: '10.0.0.1' };
    assert.strictEqual(keyGen(r3), 'session:tok123');

    // 4. IP fallback
    const r4 = { ip: '10.0.0.1' };
    assert.strictEqual(keyGen(r4), 'ip:10.0.0.1');
  });
});

test('RateLimit: Feature 9 Login Brute Force Throttler', async (t) => {
  await t.test('blocks after 5 failed logins and returns HTTP 429 with Retry-After header', () => {
    let mockTime = 1000000;
    const limiter = createLoginRateLimiter({
      windowMs: 15 * 60 * 1000,
      maxFailures: 5,
      nowProvider: () => mockTime,
    });

    const fakeReq = { ip: '127.0.0.1', body: { email: 'target@system.local' } };

    // Simulate 5 failed login attempts (status 401)
    for (let i = 1; i <= 5; i++) {
      let nextCalled = false;
      const listeners = {};
      const fakeRes = {
        statusCode: 401,
        setHeader() {},
        status() { return this; },
        json() { return this; },
        on(event, fn) { listeners[event] = fn; },
      };

      limiter(fakeReq, fakeRes, () => { nextCalled = true; });
      assert.strictEqual(nextCalled, true, `Attempt ${i} should call next()`);
      listeners['finish'](); // Fire finish event to record failure
    }

    // 6th attempt should be blocked immediately (429) without calling next()
    let sixthNextCalled = false;
    let responseStatus = null;
    let responseBody = null;
    const headersSet = {};

    const sixthRes = {
      statusCode: 200,
      setHeader(name, val) { headersSet[name] = val; },
      status(code) { responseStatus = code; return this; },
      json(payload) { responseBody = payload; return this; },
      on() {},
    };

    limiter(fakeReq, sixthRes, () => { sixthNextCalled = true; });

    assert.strictEqual(sixthNextCalled, false, '6th attempt must not call next()');
    assert.strictEqual(responseStatus, 429);
    assert.strictEqual(responseBody.error, 'TOO_MANY_REQUESTS');
    assert.ok(responseBody.retryAfterSeconds > 0);
    assert.ok(headersSet['Retry-After']);

    limiter.destroy();
  });

  await t.test('successful login (2xx status) resets the failure counter', () => {
    const limiter = createLoginRateLimiter({ windowMs: 900000, maxFailures: 5 });
    const req = { ip: '127.0.0.1', body: { email: 'user@system.local' } };

    // Simulate 3 failures
    for (let i = 0; i < 3; i++) {
      const listeners = {};
      const res = { statusCode: 401, on(ev, fn) { listeners[ev] = fn; } };
      limiter(req, res, () => {});
      listeners['finish']();
    }
    assert.strictEqual(limiter.getState('127.0.0.1:user@system.local').count, 3);

    // 4th attempt succeeds (200 OK)
    const successListeners = {};
    const successRes = { statusCode: 200, on(ev, fn) { successListeners[ev] = fn; } };
    limiter(req, successRes, () => {});
    successListeners['finish']();

    // Failure counter is reset
    assert.strictEqual(limiter.getState('127.0.0.1:user@system.local').count, 0);

    limiter.destroy();
  });

  await t.test('400 Bad Request does not increment failure count', () => {
    const limiter = createLoginRateLimiter({ windowMs: 900000, maxFailures: 5 });
    const req = { ip: '127.0.0.1', body: { email: 'user@system.local' } };

    const listeners = {};
    const res = { statusCode: 400, on(ev, fn) { listeners[ev] = fn; } };
    limiter(req, res, () => {});
    listeners['finish']();

    assert.strictEqual(limiter.getState('127.0.0.1:user@system.local').count, 0);
    limiter.destroy();
  });
});

test('RateLimit: Feature 10 Run Creation Rate Limiter', async (t) => {
  await t.test('allows up to 10 requests per minute and blocks the 11th with 429', () => {
    let mockTime = 5000000;
    const limiter = createRunRateLimiter({
      windowMs: 60000,
      maxRequests: 10,
      nowProvider: () => mockTime,
    });

    const req = { user: { id: 101 }, ip: '127.0.0.1' };

    // Make 10 successful requests
    for (let i = 1; i <= 10; i++) {
      let nextCalled = false;
      const headers = {};
      const res = {
        setHeader(k, v) { headers[k] = v; },
        status() { return this; },
        json() { return this; },
      };
      limiter(req, res, () => { nextCalled = true; });
      assert.strictEqual(nextCalled, true);
      assert.strictEqual(headers['RateLimit-Limit'], '10');
      assert.strictEqual(headers['RateLimit-Remaining'], String(10 - i));
    }

    // 11th request must be rejected with 429
    let rejectedNextCalled = false;
    let statusCode = null;
    let jsonBody = null;
    const headers = {};
    const res = {
      setHeader(k, v) { headers[k] = v; },
      status(c) { statusCode = c; return this; },
      json(j) { jsonBody = j; return this; },
    };

    limiter(req, res, () => { rejectedNextCalled = true; });
    assert.strictEqual(rejectedNextCalled, false);
    assert.strictEqual(statusCode, 429);
    assert.strictEqual(jsonBody.error, 'TOO_MANY_REQUESTS');
    assert.ok(headers['Retry-After']);

    // Advance clock by 61 seconds -> window rolls over and user can create runs again
    mockTime += 61000;
    let allowedAfterWindow = false;
    limiter(req, res, () => { allowedAfterWindow = true; });
    assert.strictEqual(allowedAfterWindow, true);

    limiter.destroy();
  });

  await t.test('different users have isolated rate limit quotas', () => {
    const limiter = createRunRateLimiter({ windowMs: 60000, maxRequests: 2 });
    const u1Req = { user: { id: 1 } };
    const u2Req = { user: { id: 2 } };

    const dummyRes = { setHeader() {}, status() { return this; }, json() { return this; } };

    // U1 consumes 2
    limiter(u1Req, dummyRes, () => {});
    limiter(u1Req, dummyRes, () => {});
    assert.strictEqual(limiter.isBlocked('user:1'), true);

    // U2 is not blocked
    assert.strictEqual(limiter.isBlocked('user:2'), false);
    let u2Called = false;
    limiter(u2Req, dummyRes, () => { u2Called = true; });
    assert.strictEqual(u2Called, true);

    limiter.destroy();
  });
});
