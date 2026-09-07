const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const { InternalTaskPool, computeInternalConcurrency, DEFAULT_TASK_COST_MB } = require('../src/scheduler/internal-task-pool');

// ==================== InternalTaskPool ====================

test('sequential (concurrency=1) processes all items in order', async () => {
  const pool = new InternalTaskPool({ concurrency: 1 });
  const order = [];
  const results = await pool.run([10, 20, 30], async (item, idx) => {
    order.push(idx);
    return item * 2;
  });
  assert.deepStrictEqual(order, [0, 1, 2]);
  assert.deepStrictEqual(results, [
    { status: 'fulfilled', value: 20 },
    { status: 'fulfilled', value: 40 },
    { status: 'fulfilled', value: 60 }
  ]);
});

test('parallel (concurrency=3) processes all items', async () => {
  const pool = new InternalTaskPool({ concurrency: 3 });
  const results = await pool.run([1, 2, 3, 4, 5], async (item) => item * 10);
  assert.equal(results.length, 5);
  assert.deepStrictEqual(results.map(r => r.value), [10, 20, 30, 40, 50]);
});

test('dynamic refill: worker picks next task immediately (not batch-wait)', async () => {
  const pool = new InternalTaskPool({ concurrency: 2 });
  const timeline = [];
  await pool.run(['fast', 'slow', 'fast2'], async (item, idx) => {
    const delay = item === 'slow' ? 100 : 10;
    await new Promise(r => setTimeout(r, delay));
    timeline.push({ idx, item, time: Date.now() });
    return item;
  });
  // 'fast' (idx=0) finishes before 'slow' (idx=1), then 'fast2' (idx=2) fills immediately
  // So fast2 should start before slow finishes
  assert.equal(timeline.length, 3);
  // fast2 should finish before or around the same time as slow
  assert.ok(timeline[2].idx === 1 || timeline[1].idx === 2,
    'fast2 should execute before slow finishes due to dynamic refill');
});

test('failure isolation: one task failing does not abort others', async () => {
  const pool = new InternalTaskPool({ concurrency: 2 });
  const results = await pool.run([1, 2, 3], async (item) => {
    if (item === 2) throw new Error('boom');
    return item;
  });
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value, 1);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.message, 'boom');
  assert.equal(results[2].status, 'fulfilled');
  assert.equal(results[2].value, 3);
});

test('STALE_EXECUTION error propagates (not isolated)', async () => {
  const pool = new InternalTaskPool({ concurrency: 2 });
  await assert.rejects(
    () => pool.run([1, 2, 3], async (item) => {
      if (item === 2) throw new Error('STALE_EXECUTION: lease revoked');
      return item;
    }),
    /STALE_EXECUTION/
  );
});

test('AbortSignal stops accepting new tasks', async () => {
  const ac = new AbortController();
  const pool = new InternalTaskPool({ concurrency: 1, signal: ac.signal });
  const results = await pool.run([1, 2, 3, 4, 5], async (item, idx) => {
    if (idx === 1) ac.abort();
    return item;
  });
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const aborted = results.filter(r => r.reason?.message === 'ABORTED');
  assert.ok(fulfilled.length >= 2, 'at least items 0 and 1 should complete');
  assert.ok(aborted.length > 0, 'some items should be aborted');
});

test('empty items returns empty array', async () => {
  const pool = new InternalTaskPool({ concurrency: 4 });
  const results = await pool.run([], async () => 'nope');
  assert.deepStrictEqual(results, []);
});

test('onTaskComplete and onTaskError callbacks fire', async () => {
  const completed = [];
  const errors = [];
  const pool = new InternalTaskPool({
    concurrency: 2,
    onTaskComplete: (idx, val) => completed.push({ idx, val }),
    onTaskError: (idx, err) => errors.push({ idx, msg: err.message })
  });
  await pool.run([1, 2, 3], async (item) => {
    if (item === 2) throw new Error('fail');
    return item * 10;
  });
  assert.deepStrictEqual(completed, [{ idx: 0, val: 10 }, { idx: 2, val: 30 }]);
  assert.deepStrictEqual(errors, [{ idx: 1, msg: 'fail' }]);
});

test('runCollect returns only fulfilled values', async () => {
  const pool = new InternalTaskPool({ concurrency: 2 });
  const values = await pool.runCollect([1, 2, 3], async (item) => {
    if (item === 2) throw new Error('skip');
    return item * 10;
  });
  assert.deepStrictEqual(values, [10, 30]);
});

test('summarize counts correctly', () => {
  const results = [
    { status: 'fulfilled', value: 1 },
    { status: 'rejected', reason: new Error('boom') },
    { status: 'fulfilled', value: 3 },
    { status: 'rejected', reason: new Error('ABORTED') }
  ];
  const summary = InternalTaskPool.summarize(results);
  assert.deepStrictEqual(summary, { total: 4, fulfilled: 2, rejected: 1, aborted: 1 });
});

test('concurrency actually limits parallel execution', async () => {
  let activeConcurrent = 0;
  let maxConcurrent = 0;
  const pool = new InternalTaskPool({ concurrency: 3 });

  await pool.run(new Array(10).fill(null), async () => {
    activeConcurrent++;
    if (activeConcurrent > maxConcurrent) maxConcurrent = activeConcurrent;
    await new Promise(r => setTimeout(r, 20));
    activeConcurrent--;
  });

  assert.ok(maxConcurrent <= 3, `max concurrent should be <=3, got ${maxConcurrent}`);
  assert.ok(maxConcurrent >= 2, `should use at least 2 concurrent slots, got ${maxConcurrent}`);
});

// ==================== computeInternalConcurrency ====================

test('computeInternalConcurrency: BROWSER with ample RAM', () => {
  const result = computeInternalConcurrency({
    executionClass: 'BROWSER',
    runBaseCostMB: 450,
    effectiveHeadroomMB: 2000,
    maxConcurrency: 4
  });
  // (2000 - 450) / 100 = 15.5 → clamped to 4
  assert.equal(result.concurrency, 4);
  assert.equal(result.taskCostMB, DEFAULT_TASK_COST_MB.BROWSER);
  assert.equal(result.totalEnvelopeMB, 450 + (100 * 4));
});

test('computeInternalConcurrency: BROWSER with tight RAM', () => {
  const result = computeInternalConcurrency({
    executionClass: 'BROWSER',
    runBaseCostMB: 450,
    effectiveHeadroomMB: 600,
    maxConcurrency: 4
  });
  // (600 - 450) / 100 = 1.5 → floor = 1
  assert.equal(result.concurrency, 1);
});

test('computeInternalConcurrency: CDP always returns 1', () => {
  const result = computeInternalConcurrency({
    executionClass: 'CDP',
    runBaseCostMB: 400,
    effectiveHeadroomMB: 5000,
    maxConcurrency: 8
  });
  assert.equal(result.concurrency, 1);
});

test('computeInternalConcurrency: CLOUD_API always returns 1', () => {
  const result = computeInternalConcurrency({
    executionClass: 'CLOUD_API',
    runBaseCostMB: 60,
    effectiveHeadroomMB: 5000,
    maxConcurrency: 8
  });
  assert.equal(result.concurrency, 1);
});

test('computeInternalConcurrency: LOCAL_HTTP with plenty of RAM', () => {
  const result = computeInternalConcurrency({
    executionClass: 'LOCAL_HTTP',
    runBaseCostMB: 150,
    effectiveHeadroomMB: 2000,
    maxConcurrency: 8
  });
  // (2000 - 150) / 8 = 231 → clamped to 8
  assert.equal(result.concurrency, 8);
  assert.equal(result.taskCostMB, DEFAULT_TASK_COST_MB.LOCAL_HTTP);
});

test('computeInternalConcurrency: zero headroom returns 1', () => {
  const result = computeInternalConcurrency({
    executionClass: 'BROWSER',
    runBaseCostMB: 450,
    effectiveHeadroomMB: 100, // less than runBaseCost
    maxConcurrency: 4
  });
  assert.equal(result.concurrency, 1);
});
