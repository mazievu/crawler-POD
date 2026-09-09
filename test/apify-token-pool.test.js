const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ApifyTokenPoolManager,
  maskToken,
  parseTokenSignal
} = require('../src/apify-token-pool');

test('ApifyTokenPool: maskToken masks sensitive characters properly', () => {
  assert.equal(maskToken(''), '');
  assert.equal(maskToken('short'), '****');
  assert.equal(maskToken('apify_api_1234567890abcdef'), 'apify_a...cdef');
});

test('ApifyTokenPool: parseTokenSignal detects 401, 402, 429 error signals', () => {
  // 401 / Invalid
  assert.deepEqual(parseTokenSignal(401), { isError: true, type: 'INVALID', reason: 'HTTP 401 Unauthorized' });
  assert.equal(parseTokenSignal(new Error('Invalid token provided')).type, 'INVALID');

  // 402 / Quota / Out of Credit
  assert.deepEqual(parseTokenSignal(402), { isError: true, type: 'EXHAUSTED', reason: 'HTTP 402 Payment Required / Out of Credit' });
  assert.equal(parseTokenSignal(new Error('Usage limit exceeded for this month')).type, 'EXHAUSTED');
  assert.equal(parseTokenSignal(new Error('Account out of credit')).type, 'EXHAUSTED');

  // 429 / Rate limit
  assert.deepEqual(parseTokenSignal(429), { isError: true, type: 'RATE_LIMITED', reason: 'HTTP 429 Too Many Requests' });
  assert.equal(parseTokenSignal(new Error('Rate limit exceeded, try again later')).type, 'RATE_LIMITED');

  // Normal / Non-token error
  assert.equal(parseTokenSignal(new Error('Actor not found')).isError, false);
});

test('ApifyTokenPool: an account over its monthly hard limit is EXHAUSTED, not a success', () => {
  // Regression: the message Apify actually returns once an account crosses
  // maxMonthlyUsageUsd. Run #100 (tiktok_shop, 2026-09-07) failed with exactly
  // this string while /v2/users/me/limits reported monthlyUsageUsd 5.0150
  // against a limit of 5. Because "hard" sits between "usage" and "limit",
  // /monthly usage limit/ and /usage limit exceeded/ both missed it, so the
  // classifier returned isError:false — the pool recorded the drained token as
  // successful, never quarantined it, and kept selecting it while two sibling
  // tokens still had budget.
  assert.equal(parseTokenSignal(new Error('Monthly usage hard limit exceeded')).type, 'EXHAUSTED');
  assert.equal(parseTokenSignal({ message: 'Monthly usage hard limit exceeded' }).isError, true);

  // Wording drift around the same condition must classify the same way.
  assert.equal(parseTokenSignal(new Error('Monthly usage soft limit exceeded')).type, 'EXHAUSTED');

  // ...without swallowing unrelated failures into the quota bucket, which
  // would quarantine a healthy token on any actor crash.
  assert.equal(parseTokenSignal(new Error('Actor run failed: page timed out')).isError, false);
  assert.equal(parseTokenSignal(new Error('Monthly report generated')).isError, false);
});

test('ApifyTokenPool: initializes tokens from list and supports round-robin', () => {
  const pool = new ApifyTokenPoolManager({
    tokens: ['token_aaa_11111111', 'token_bbb_22222222', 'token_ccc_33333333']
  });

  const status = pool.getStatus();
  assert.equal(status.total, 3);
  assert.equal(status.healthyCount, 3);

  const t1 = pool.acquire();
  const t2 = pool.acquire();
  const t3 = pool.acquire();
  const t4 = pool.acquire();

  assert.equal(t1.tokenId, 'token-1');
  assert.equal(t2.tokenId, 'token-2');
  assert.equal(t3.tokenId, 'token-3');
  assert.equal(t4.tokenId, 'token-1'); // Round-robin back to first
});

test('ApifyTokenPool: withTokenFailover rotates to next token when 402 out of credit occurs', async () => {
  const pool = new ApifyTokenPoolManager({
    tokens: ['token_dead_quota', 'token_healthy_live'],
    maxTokenRotations: 3
  });

  let callCount = 0;
  const usedTokens = [];

  const result = await pool.withTokenFailover(async (client, tokenRecord, admission) => {
    callCount++;
    usedTokens.push(tokenRecord.id);

    if (tokenRecord.id === 'token-1') {
      const err = new Error('Monthly usage limit reached (402 Payment Required)');
      err.status = 402;
      throw err;
    }

    return { success: true, from: tokenRecord.id };
  });

  assert.equal(callCount, 2);
  assert.deepEqual(usedTokens, ['token-1', 'token-2']);
  assert.deepEqual(result, { success: true, from: 'token-2' });

  // Verify token-1 is marked EXHAUSTED
  const status = pool.getStatus();
  assert.equal(status.healthyCount, 1);
  assert.equal(status.exhaustedCount, 1);
  const t1 = status.tokens.find(t => t.id === 'token-1');
  assert.equal(t1.state, 'EXHAUSTED');
});

test('ApifyTokenPool: withTokenFailover rotates to next token when 401 invalid token occurs', async () => {
  const pool = new ApifyTokenPoolManager({
    tokens: ['token_bad_auth', 'token_good_auth'],
    maxTokenRotations: 3
  });

  const usedTokens = [];
  const result = await pool.withTokenFailover(async (client, tokenRecord) => {
    usedTokens.push(tokenRecord.id);

    if (tokenRecord.id === 'token-1') {
      const err = new Error('Authentication failed: invalid token (401)');
      err.status = 401;
      throw err;
    }

    return { success: true, from: tokenRecord.id };
  });

  assert.deepEqual(usedTokens, ['token-1', 'token-2']);
  assert.equal(result.success, true);

  const status = pool.getStatus();
  const t1 = status.tokens.find(t => t.id === 'token-1');
  assert.equal(t1.state, 'INVALID');
});

test('ApifyTokenPool: throws APIFY_POOL_EXHAUSTED when all tokens in pool fail', async () => {
  const pool = new ApifyTokenPoolManager({
    tokens: ['token_fail_1', 'token_fail_2'],
    maxTokenRotations: 3
  });

  await assert.rejects(
    async () => {
      await pool.withTokenFailover(async (client, tokenRecord) => {
        const err = new Error('Payment required: out of credit');
        err.status = 402;
        throw err;
      });
    },
    (err) => {
      assert.equal(err.code, 'APIFY_POOL_EXHAUSTED');
      return true;
    }
  );

  const status = pool.getStatus();
  assert.equal(status.healthyCount, 0);
  assert.equal(status.exhaustedCount, 2);
});

test('ApifyTokenPool: non-token errors do not exhaust the token', async () => {
  const pool = new ApifyTokenPoolManager({
    tokens: ['token_healthy_1']
  });

  await assert.rejects(
    async () => {
      await pool.withTokenFailover(async () => {
        throw new Error('Some random network socket hangup error');
      });
    },
    /network socket hangup/
  );

  const status = pool.getStatus();
  assert.equal(status.healthyCount, 1); // Token remains healthy
});
