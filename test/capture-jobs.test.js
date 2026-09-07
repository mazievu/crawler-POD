const test = require('node:test');
const assert = require('node:assert/strict');

const { createCaptureJobQueue } = require('../src/marketplaces/capture-jobs');

test('long-running capture jobs acknowledge immediately and expose their final result', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const queue = createCaptureJobQueue({ runCapture: async () => { await wait; return { capture: { id: 42 }, metrics: { price: 826171 } }; } });

  const job = await queue.enqueue({ platform: 'etsy' });
  assert.deepEqual(queue.get(job.id), { id: job.id, status: 'running', result: null, error: null });

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.get(job.id), { id: job.id, status: 'completed', result: { capture: { id: 42 }, metrics: { price: 826171 } }, error: null });
});

test('capture jobs expose safe failure state instead of leaving clients waiting', async () => {
  const queue = createCaptureJobQueue({ runCapture: async () => { throw new Error('host unavailable'); } });
  const job = await queue.enqueue({ platform: 'etsy' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.get(job.id), { id: job.id, status: 'failed', result: null, error: 'host unavailable' });
});

test('capture jobs return null for an unknown id', () => {
  const queue = createCaptureJobQueue({ runCapture: async () => ({}) });
  assert.equal(queue.get('does-not-exist'), null);
});
