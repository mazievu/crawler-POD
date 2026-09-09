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
  const platform = String(input.platform == null ? 'etsy' : input.platform).trim().toLowerCase();
  if (!platform) throw new Error('Platform is required');
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
  const maxListings = Math.min(Math.max(Number(input.maxListings || input.maxItems) || 30, 1), 100);
  // Task 5.2: market selector. Kept as a plain 2-letter code so it can be
  // handed straight to a provider that requires one (TikTok Shop's actor takes
  // country_code); empty means "whatever the platform's own default is".
  const country = String(input.country || '').trim().toUpperCase().slice(0, 2);
  return {
    platform, keyword, accountId, everyMinutes: everyHours * 60, country,
    variantMode, maxVariants: variantMode === 'all' ? normalizeMaxVariants(input.maxVariants) : 0,
    maxListings,
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

/**
 * §2 (Final Blocker Fix Round): every renewal must be ASSERTED, not just
 * awaited. renewClaim() returning false means a stale attempt is still
 * running this function after its claim was already lost/reclaimed —
 * previously the loop below kept capturing regardless. Throwing here stops
 * the work immediately, exactly at the point ownership was confirmed lost.
 */
async function assertClaimOwnership(scheduleId, claimToken, renewClaim) {
  const ok = await renewClaim(scheduleId, claimToken);
  if (!ok) {
    const err = new Error('MARKETPLACE_CLAIM_LOST');
    err.code = 'MARKETPLACE_CLAIM_LOST';
    throw err;
  }
}

// A caller that supplies no renewClaim isn't using the claim system at all —
// that must never be indistinguishable from "claim lost" (assertClaimOwnership
// treats any falsy result as loss; `async () => {}` would resolve `undefined`).
function createMarketplaceCaptureScheduler({ discover, capture, markComplete = async () => {}, renewClaim = async () => true }) {
  if (typeof discover !== 'function' || typeof capture !== 'function') throw new Error('Scheduler requires discovery and capture functions');
  // §4: claimToken must be threaded through the ENTIRE scheduled execution —
  // renewClaim(scheduleId, claimToken) is called with the SAME token this
  // specific run() call was handed, never a dropped/omitted one. If a stale
  // Attempt A (holding an old/superseded token) is still running this
  // function, its renewClaim calls below will correctly no-op (the DB's
  // claim_token no longer matches A's), never stealing B's claim.
  async function run(schedule, claimToken = null) {
    let result;
    try {
      result = await discover(schedule.keyword, {
        limit: Math.min(Number(schedule.max_listings) || 30, 30),
        accountId: schedule.account_id == null ? null : Number(schedule.account_id),
      });
    } catch (error) {
      const summary = { discovered: 0, captured: 0, blocked: 0, failed: 1, error: `Discovery failed: ${error.message}` };
      // §3: claim_token-protected — a stale attempt cannot mark this
      // complete or clear a newer claim even on this early-exit path.
      await markComplete(schedule.id, summary, claimToken);
      return summary;
    }

    // §2: discovery alone can take a while (now routed through the Resource
    // Scheduler, §13 of the prior round); confirm the claim is still ours
    // before starting the capture loop — if it isn't, STOP immediately, do
    // not spend a single browser capture under a lease that's already gone.
    try {
      await assertClaimOwnership(schedule.id, claimToken, renewClaim);
    } catch (claimErr) {
      console.warn(`[MarketplaceCaptureScheduler] Schedule #${schedule.id}: ${claimErr.message} after discovery — stopping before any capture.`);
      return { discovered: (result.items || []).length, captured: 0, blocked: 0, failed: 0, error: claimErr.message, claimLost: true };
    }

    const items = (result.items || []).filter((item) => item?.url).slice(0, Math.min(Number(schedule.max_listings) || 30, 30));
    const summary = { discovered: items.length, captured: 0, blocked: 0, failed: 0 };

    // Parallel capture: each capture() submits through the scheduler (BROWSER
    // pool), so actual browser concurrency is still governed by pool capacity.
    // InternalTaskPool controls how many we SUBMIT concurrently.
    const { InternalTaskPool } = require('../scheduler/internal-task-pool');
    const concurrency = Math.min(4, items.length); // bounded: capture submits are lightweight
    const taskPool = new InternalTaskPool({ concurrency });

    await taskPool.run(items, async (item) => {
      // §2: assert BEFORE starting each item
      await assertClaimOwnership(schedule.id, claimToken, renewClaim);
      const captured = await capture({ platform: 'etsy', url: item.url, accountId: schedule.account_id, variantMode: schedule.variant_mode, maxVariants: schedule.max_variants });
      if (captured.captureStatus?.status === 'blocked') summary.blocked++;
      else summary.captured++;
    });

    // Count failures from settled results
    // (taskPool.run uses allSettled — failed tasks don't throw)
    summary.failed = items.length - summary.captured - summary.blocked;

    // Final assertion before completion, so a slow markComplete()/summary
    // write below still runs under a claim we've just confirmed is ours.
    try {
      await assertClaimOwnership(schedule.id, claimToken, renewClaim);
    } catch (claimErr) {
      console.warn(`[MarketplaceCaptureScheduler] Schedule #${schedule.id}: ${claimErr.message} before completion — not marking complete.`);
      summary.error = claimErr.message;
      summary.claimLost = true;
      return summary;
    }
    // §3: claim_token-protected at the DB layer too — belt and suspenders.
    // Gap #5 closure (Final Gap Closure Round): the DB write itself was
    // already safe (a stale claim_token makes it a no-op), but this return
    // value was never inspected — a caller whose ownership was stolen in the
    // narrow window between the assertClaimOwnership() check above and this
    // exact write would silently receive a summary indistinguishable from a
    // real, current-owner success. No fake success, no schedule mutation.
    const completed = await markComplete(schedule.id, summary, claimToken);
    if (completed === false) {
      console.warn(`[MarketplaceCaptureScheduler] Schedule #${schedule.id}: MARKETPLACE_CLAIM_LOST at final completion — ownership was lost between the last renewal and this write; not reporting success.`);
      summary.error = 'MARKETPLACE_CLAIM_LOST';
      summary.claimLost = true;
    }
    return summary;
  }
  return { run };
}

module.exports = { createMarketplaceCaptureScheduler, normalizeScheduleInput, nextScheduleRunAt, vietnamDateTimeToUtc, assertClaimOwnership };
