const test = require('node:test');
const assert = require('node:assert/strict');

const { createMarketplaceCaptureScheduler, normalizeScheduleInput, nextScheduleRunAt } = require('../src/marketplaces/capture-scheduler');

test('scheduler enforces Etsy, a keyword, 30 listing default/200 maximum, and an hourly cadence', () => {
  assert.deepEqual(normalizeScheduleInput({
    platform: 'etsy', keyword: 'press on nails', accountId: 7, everyHours: 24,
    variantMode: 'base', maxVariants: 0, maxListings: 999,
  }), {
    platform: 'etsy', keyword: 'press on nails', accountId: 7, everyMinutes: 1440,
    variantMode: 'base', maxVariants: 0, maxListings: 200, scheduleType: 'interval', dailyTime: '09:00', runAt: null,
  });
  assert.throws(() => normalizeScheduleInput({ platform: 'amazon', keyword: 'x' }), /Etsy only/);
  assert.throws(() => normalizeScheduleInput({ platform: 'etsy', keyword: '' }), /Keyword/);
  assert.throws(() => normalizeScheduleInput({ platform: 'etsy', keyword: 'x', accountId: 0 }), /Account/);
  assert.deepEqual(normalizeScheduleInput({ platform: 'etsy', keyword: 'x', everyHours: 999, variantMode: 'all', maxVariants: 999 }), {
    platform: 'etsy', keyword: 'x', accountId: null, everyMinutes: 10080, variantMode: 'all', maxVariants: 250, maxListings: 30, scheduleType: 'interval', dailyTime: '09:00', runAt: null,
  });
});



test('due schedule discovers up to 30 Etsy URLs and captures them sequentially', async () => {
  const calls = [];
  let discoveryOptions;
  const scheduler = createMarketplaceCaptureScheduler({
    discover: async (_keyword, options) => { discoveryOptions = options; return { items: Array.from({ length: 32 }, (_, index) => ({ url: `https://www.etsy.com/listing/${index + 1}/item` })) }; },
    capture: async (request) => { calls.push(request.url); return { cached: false, captureStatus: { status: 'ok' } }; },
    markComplete: async () => {},
  });

  const result = await scheduler.run({ id: 1, platform: 'etsy', keyword: 'nails', account_id: 3, every_minutes: 60, variant_mode: 'base', max_variants: 0, max_listings: 30 });
  assert.deepEqual(result, { discovered: 30, captured: 30, blocked: 0, failed: 0 });
  assert.equal(calls.length, 30);
  assert.equal(calls[0], 'https://www.etsy.com/listing/1/item');
  assert.equal(discoveryOptions.accountId, 3);
});

test('scheduler records blocked and failed listings without stopping the remaining work', async () => {
  let attempt = 0;
  let completed;
  const scheduler = createMarketplaceCaptureScheduler({
    discover: async () => ({ items: [{ url: 'https://www.etsy.com/listing/1/a' }, { url: 'https://www.etsy.com/listing/2/b' }, { url: 'https://www.etsy.com/listing/3/c' }] }),
    capture: async () => {
      attempt++;
      if (attempt === 1) return { captureStatus: { status: 'blocked' } };
      if (attempt === 2) throw new Error('capture failed');
      return { captureStatus: { status: 'ok' } };
    },
    markComplete: async (_id, summary) => { completed = summary; },
  });
  const summary = await scheduler.run({ id: 2, keyword: 'nails', account_id: null, variant_mode: 'base', max_variants: 0, max_listings: 3 });
  assert.deepEqual(summary, { discovered: 3, captured: 1, blocked: 1, failed: 1 });
  assert.deepEqual(completed, summary);
});

test('scheduler records a failed discovery attempt so the schedule does not remain silently due', async () => {
  let completed;
  const scheduler = createMarketplaceCaptureScheduler({
    discover: async () => { throw new Error('SearXNG error: 403'); },
    capture: async () => { throw new Error('capture should not run'); },
    markComplete: async (_id, summary) => { completed = summary; },
  });

  const summary = await scheduler.run({ id: 3, keyword: 'nails', max_listings: 30 });
  assert.deepEqual(summary, { discovered: 0, captured: 0, blocked: 0, failed: 1, error: 'Discovery failed: SearXNG error: 403' });
  assert.deepEqual(completed, summary);
});

test('daily schedules accept a selected Vietnam time and calculate the next occurrence', () => {
  assert.deepEqual(normalizeScheduleInput({ platform: 'etsy', keyword: 'nails', scheduleType: 'daily', dailyTime: '08:30' }), {
    platform: 'etsy', keyword: 'nails', accountId: null, everyMinutes: 1440, variantMode: 'base', maxVariants: 0, maxListings: 30,
    scheduleType: 'daily', dailyTime: '08:30', runAt: null,
  });
  assert.equal(nextScheduleRunAt({ schedule_type: 'daily', daily_time: '08:30' }, new Date('2026-07-22T00:00:00.000Z')).toISOString(), '2026-07-22T01:30:00.000Z');
});

test('one-time schedules accept an exact Vietnam date and time', () => {
  const schedule = normalizeScheduleInput({
    platform: 'etsy', keyword: 'nails', scheduleType: 'once', runAt: '2026-08-15T14:45',
  });
  assert.equal(schedule.scheduleType, 'once');
  assert.equal(schedule.runAt, '2026-08-15T14:45');
  assert.equal(
    nextScheduleRunAt({ schedule_type: 'once', run_at: schedule.runAt }, new Date('2026-07-22T00:00:00.000Z')).toISOString(),
    '2026-08-15T07:45:00.000Z',
  );
  assert.throws(() => normalizeScheduleInput({
    platform: 'etsy', keyword: 'nails', scheduleType: 'once', runAt: '2026-02-30T14:45',
  }), /valid date and time/);
  assert.throws(() => normalizeScheduleInput({
    platform: 'etsy', keyword: 'nails', scheduleType: 'once', runAt: '',
  }), /valid date and time/);
});
