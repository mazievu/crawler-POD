const { normalizeMaxVariants, normalizeVariantMode } = require('./variant-pricing');

function vietnamDateTimeToUtc(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!match) throw new Error('Choose a valid date and time');
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute) - 7 * 60 * 60000);
  const vietnam = new Date(utc.getTime() + 7 * 60 * 60000);
  if (
    vietnam.getUTCFullYear() !== year || vietnam.getUTCMonth() !== month - 1 || vietnam.getUTCDate() !== day
    || vietnam.getUTCHours() !== hour || vietnam.getUTCMinutes() !== minute
  ) throw new Error('Choose a valid date and time');
  return utc;
}

function normalizeScheduleInput(input = {}) {
  const platform = String(input.platform || '').toLowerCase();
  if (platform !== 'etsy') throw new Error('Scheduled keyword capture currently supports Etsy only');
  const keyword = String(input.keyword || '').trim();
  if (!keyword || keyword.length > 200) throw new Error('Keyword must be between 1 and 200 characters');
  const everyHours = Math.min(Math.max(Number(input.everyHours) || 24, 1), 168);
  const accountId = input.accountId == null || input.accountId === '' ? null : Number(input.accountId);
  if (accountId != null && (!Number.isInteger(accountId) || accountId < 1)) throw new Error('Account is invalid');
  const variantMode = normalizeVariantMode(input.variantMode);
  const scheduleType = ['daily', 'once'].includes(input.scheduleType) ? input.scheduleType : 'interval';
  const dailyTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.dailyTime || '')) ? String(input.dailyTime) : '09:00';
  const runAt = scheduleType === 'once' ? String(input.runAt || '') : null;
  if (runAt) vietnamDateTimeToUtc(runAt);
  if (scheduleType === 'once' && !runAt) throw new Error('Choose a valid date and time');
  return {
    platform, keyword, accountId, everyMinutes: everyHours * 60,
    variantMode, maxVariants: variantMode === 'all' ? normalizeMaxVariants(input.maxVariants) : 0,
    maxListings: Math.min(Math.max(Number(input.maxListings) || 30, 1), 200),
    scheduleType, dailyTime, runAt,
  };
}

function nextScheduleRunAt(schedule, now = new Date()) {
  if (schedule.schedule_type === 'once') return vietnamDateTimeToUtc(schedule.run_at);
  if (schedule.schedule_type !== 'daily') return new Date(now.getTime() + Number(schedule.every_minutes || 1440) * 60000);
  const [hours, minutes] = String(schedule.daily_time || '09:00').split(':').map(Number);
  const vietnamNow = new Date(now.getTime() + 7 * 60 * 60000);
  let next = new Date(Date.UTC(vietnamNow.getUTCFullYear(), vietnamNow.getUTCMonth(), vietnamNow.getUTCDate(), hours, minutes) - 7 * 60 * 60000);
  if (next <= now) next = new Date(next.getTime() + 24 * 60 * 60000);
  return next;
}

function createMarketplaceCaptureScheduler({ discover, capture, markComplete = async () => {} }) {
  if (typeof discover !== 'function' || typeof capture !== 'function') throw new Error('Scheduler requires discovery and capture functions');
  async function run(schedule) {
    let result;
    try {
      result = await discover(schedule.keyword, {
        limit: Math.min(Number(schedule.max_listings) || 30, 200),
        accountId: schedule.account_id == null ? null : Number(schedule.account_id),
      });
    } catch (error) {
      const summary = { discovered: 0, captured: 0, blocked: 0, failed: 1, error: `Discovery failed: ${error.message}` };
      await markComplete(schedule.id, summary);
      return summary;
    }
    const items = (result.items || []).filter((item) => item?.url).slice(0, Math.min(Number(schedule.max_listings) || 30, 200));

    const summary = { discovered: items.length, captured: 0, blocked: 0, failed: 0 };
    for (const item of items) {
      try {
        const captured = await capture({ platform: 'etsy', url: item.url, accountId: schedule.account_id, variantMode: schedule.variant_mode, maxVariants: schedule.max_variants });
        if (captured.captureStatus?.status === 'blocked') summary.blocked++;
        else summary.captured++;
      } catch { summary.failed++; }
    }
    await markComplete(schedule.id, summary);
    return summary;
  }
  return { run };
}

module.exports = { createMarketplaceCaptureScheduler, normalizeScheduleInput, nextScheduleRunAt, vietnamDateTimeToUtc };
