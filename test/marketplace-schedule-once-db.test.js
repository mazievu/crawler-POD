const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString('base64');

const db = require('../src/database');

test('a one-time schedule stores its Vietnam date and disables itself after completion', async () => {
  const keyword = `one-time-${Date.now()}`;
  const schedule = await db.createMarketplaceCaptureSchedule({
    platform: 'etsy', keyword, scheduleType: 'once', runAt: '2099-12-31T23:45',
  });

  try {
    assert.equal(schedule.schedule_type, 'once');
    assert.equal(schedule.run_at, '2099-12-31T23:45');
    assert.equal(schedule.next_run_at, '2099-12-31T16:45:00.000Z');

    assert.equal(await db.completeMarketplaceCaptureSchedule(schedule.id, { captured: 30 }, new Date('2099-12-31T16:46:00.000Z')), true);
    const completed = (await db.getMarketplaceCaptureSchedules()).find((candidate) => candidate.id === schedule.id);
    assert.equal(completed.enabled, 0);
    assert.deepEqual(completed.last_summary, { captured: 30 });
    const runs = await db.getMarketplaceCaptureScheduleRuns(schedule.id);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].summary, { captured: 30 });
  } finally {
    await db.deleteMarketplaceCaptureSchedule(schedule.id);
  }
});
