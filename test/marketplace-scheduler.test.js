const test = require('node:test');
const assert = require('node:assert/strict');

const { createMarketplaceCaptureScheduler, normalizeScheduleInput, nextScheduleRunAt, assertClaimOwnership } = require('../src/marketplaces/capture-scheduler');
const db = require('../src/database');

// Live-Readiness Round #12 acceptance: two ticks racing to claim the same due
// schedule must result in exactly one successful claim while the first is active.
test('claimMarketplaceCaptureSchedule is atomic: a second claim attempt fails while the first is still active (#12)', async () => {
  const created = await db.createMarketplaceCaptureSchedule({ platform: 'etsy', keyword: 'claim-test-' + Date.now(), everyHours: 1 });
  try {
    const firstClaim = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.ok(firstClaim, 'First tick must successfully claim the due schedule (returns claim_token)');

    const secondClaim = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.equal(secondClaim, false, 'A second tick must NOT be able to claim the same schedule while the first is still active');

    // Simulate completion: releasing the claim allows a future tick to claim it again.
    await db.releaseMarketplaceCaptureScheduleClaim(created.id, firstClaim);
    const thirdClaim = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.ok(thirdClaim, 'After release, the schedule must be claimable again');
  } finally {
    await db.deleteMarketplaceCaptureSchedule(created.id);
  }
});

// §4/§20.F mandatory ownership-safety scenario: a stale claim holder (A) must
// never be able to renew or release a claim now held by a different token (B).
test('a stale claim holder (A) cannot renew or release a schedule claim now held by B (#4 ownership safety)', async () => {
  const created = await db.createMarketplaceCaptureSchedule({ platform: 'etsy', keyword: 'ownership-test-' + Date.now(), everyHours: 1 });
  try {
    const tokenA = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.ok(tokenA, 'A must successfully claim first');

    // A's execution is superseded (e.g. stuck-detector released it and it was
    // re-claimed) — B now holds a brand-new token for the same schedule.
    await db.releaseMarketplaceCaptureScheduleClaim(created.id, tokenA);
    const tokenB = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.ok(tokenB && tokenB !== tokenA, 'B must hold a different token than A');

    // A wakes up late and tries to act using its OLD token.
    assert.equal(await db.renewMarketplaceCaptureScheduleClaim(created.id, 60000, tokenA), false, 'Stale A must not be able to renew B\'s claim');
    await db.releaseMarketplaceCaptureScheduleClaim(created.id, tokenA); // must no-op, not release B's claim
    assert.equal(await db.renewMarketplaceCaptureScheduleClaim(created.id, 60000, tokenB), true, 'B\'s claim must still be intact and renewable after A\'s failed attempts');
  } finally {
    await db.deleteMarketplaceCaptureSchedule(created.id);
  }
});

// §4/§20.E: production runtime flow (real createMarketplaceCaptureScheduler()
// + real db claim/renew functions, not just isolated DB helper calls) proves
// claim -> renew -> release threads the SAME token end to end, and that a
// stale-token run() cannot renew a schedule a fresh claim now owns.
test('claimToken flows through the real scheduler runtime: claim -> renew -> release stay bound to one token (#4/#20.E)', async () => {
  const created = await db.createMarketplaceCaptureSchedule({ platform: 'etsy', keyword: 'runtime-token-test-' + Date.now(), everyHours: 1 });
  try {
    const claimToken = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.ok(claimToken);

    const renewCalls = [];
    const scheduler = createMarketplaceCaptureScheduler({
      discover: async () => ({ items: [{ url: 'https://www.etsy.com/listing/1/a' }] }),
      capture: async () => ({ captureStatus: { status: 'ok' } }),
      markComplete: async () => {},
      renewClaim: async (id, token) => { renewCalls.push(token); return await db.renewMarketplaceCaptureScheduleClaim(id, 60000, token); },
    });

    await scheduler.run({ id: created.id, keyword: 'runtime-token-test', max_listings: 30 }, claimToken);

    assert.ok(renewCalls.length > 0, 'run() must have called renewClaim at least once');
    assert.ok(renewCalls.every((t) => t === claimToken), 'Every renewClaim call must carry the SAME claimToken the run was started with');

    // A stale run() invoked with a DIFFERENT (superseded) token must have its
    // renewals silently rejected by the DB layer, never affecting the real claim.
    const staleRenewCalls = [];
    const staleScheduler = createMarketplaceCaptureScheduler({
      discover: async () => ({ items: [{ url: 'https://www.etsy.com/listing/2/b' }] }),
      capture: async () => ({ captureStatus: { status: 'ok' } }),
      markComplete: async () => {},
      renewClaim: async (id, token) => { const ok = await db.renewMarketplaceCaptureScheduleClaim(id, 60000, token); staleRenewCalls.push(ok); return ok; },
    });
    await staleScheduler.run({ id: created.id, keyword: 'runtime-token-test', max_listings: 30 }, 'stale-token-not-real');
    assert.ok(staleRenewCalls.every((ok) => ok === false), 'A stale token must never succeed at renewing the real claim');
  } finally {
    await db.deleteMarketplaceCaptureSchedule(created.id);
  }
});

// Final Stabilization Round #12 mandatory scenario: a short TTL claim must
// survive past its original expiry as long as the scheduler keeps renewing it
// (discovery + each capture), so a second tick cannot steal/duplicate it.
test('renewMarketplaceCaptureScheduleClaim keeps a long-running schedule claimed past its original short TTL (#12)', async () => {
  const created = await db.createMarketplaceCaptureSchedule({ platform: 'etsy', keyword: 'renew-test-' + Date.now(), everyHours: 1 });
  try {
    // Realistic shape: the lease TTL comfortably covers the gap BETWEEN
    // per-item renewals (each item is short relative to the TTL), but the
    // TOTAL job (5 items) outlives the ORIGINAL TTL — exactly the scenario
    // renewal exists for.
    const ttlMs = 150;
    const perItemMs = 35;
    const claimToken = await db.claimMarketplaceCaptureSchedule(created.id, ttlMs);
    assert.ok(claimToken, 'Initial claim must succeed (returns claim_token)');

    const scheduler = createMarketplaceCaptureScheduler({
      discover: async () => ({ items: Array.from({ length: 5 }, (_, i) => ({ url: `https://etsy.com/listing/${i}` })) }),
      capture: async () => { await new Promise((r) => setTimeout(r, perItemMs)); return { captureStatus: { status: 'ok' } }; },
      markComplete: async () => {},
      renewClaim: async (id) => await db.renewMarketplaceCaptureScheduleClaim(id, ttlMs, claimToken),
    });

    const runPromise = scheduler.run({ id: created.id, keyword: 'renew-test', max_listings: 30 });

    // Wait past the ORIGINAL ttlMs (job is still running — 5 * 35ms > 150ms)
    // and simulate a second tick trying to claim the same schedule.
    await new Promise((r) => setTimeout(r, ttlMs + 20));
    const secondTickClaim = await db.claimMarketplaceCaptureSchedule(created.id, ttlMs);
    assert.equal(secondTickClaim, false, 'A second tick must not be able to claim while the first run is still active, even past the original TTL, because it was renewed');

    await runPromise;
  } finally {
    await db.deleteMarketplaceCaptureSchedule(created.id);
  }
});

// §14.A mandatory: A owns claim AAA, B later owns claim BBB (real DB claim,
// real renewMarketplaceCaptureScheduleClaim). A's renewal must return false,
// and assertClaimOwnership() must throw immediately — stopping work — rather
// than letting the caller silently continue.
test('assertClaimOwnership stops work immediately once a real DB claim renewal fails (#14.A)', async () => {
  const created = await db.createMarketplaceCaptureSchedule({ platform: 'etsy', keyword: 'claim-a-test-' + Date.now(), everyHours: 1 });
  try {
    const tokenA = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.ok(tokenA);
    // B takes over (A's claim released, B claims fresh — same effect as A's lease expiring and being reclaimed).
    await db.releaseMarketplaceCaptureScheduleClaim(created.id, tokenA);
    const tokenB = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.ok(tokenB && tokenB !== tokenA);

    const renewClaim = async (id, token) => await db.renewMarketplaceCaptureScheduleClaim(id, 60000, token);
    await assert.rejects(
      () => assertClaimOwnership(created.id, tokenA, renewClaim),
      (err) => err.code === 'MARKETPLACE_CLAIM_LOST'
    );
  } finally {
    await db.deleteMarketplaceCaptureSchedule(created.id);
  }
});

// §14.B mandatory: a stale attempt's markComplete (via db.completeMarketplaceCaptureSchedule)
// must result in 0 DB changes — no completion history row, no next_run_at
// advance, no clearing of B's real claim.
test('a stale attempt cannot markComplete a schedule now claimed by a newer attempt (#14.B)', async () => {
  const created = await db.createMarketplaceCaptureSchedule({ platform: 'etsy', keyword: 'claim-b-test-' + Date.now(), everyHours: 1 });
  try {
    const tokenA = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    await db.releaseMarketplaceCaptureScheduleClaim(created.id, tokenA);
    const tokenB = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.ok(tokenB && tokenB !== tokenA);

    const before = await db.getMarketplaceCaptureScheduleRuns(created.id);
    assert.equal(before.length, 0);

    // A wakes up late and tries to complete using its OLD token.
    const result = await db.completeMarketplaceCaptureSchedule(created.id, { captured: 999 }, new Date(), tokenA);
    assert.equal(result, false, 'Stale A must not be able to mark the schedule complete');

    const after = await db.getMarketplaceCaptureScheduleRuns(created.id);
    assert.equal(after.length, 0, 'No completion history row must have been inserted for the stale attempt');

    const schedule = (await db.getMarketplaceCaptureSchedules()).find((s) => s.id === created.id);
    assert.equal(schedule.last_summary, null, "B's schedule state must be untouched by A's stale completion attempt");

    // B, using the real current token, CAN complete it.
    assert.equal(await db.completeMarketplaceCaptureSchedule(created.id, { captured: 5 }, new Date(), tokenB), true);
  } finally {
    await db.deleteMarketplaceCaptureSchedule(created.id);
  }
});

test('scheduler enforces valid platform, keyword, 100 listing maximum, and hourly cadence', () => {
  assert.deepEqual(normalizeScheduleInput({
    platform: 'etsy', keyword: 'press on nails', accountId: 7, everyHours: 24,
    variantMode: 'base', maxVariants: 0, maxListings: 999,
  }), {
    platform: 'etsy', keyword: 'press on nails', accountId: 7, everyMinutes: 1440,
    variantMode: 'base', maxVariants: 0, maxListings: 100, scheduleType: 'interval', dailyTime: '09:00', runAt: null,
  });
  assert.deepEqual(normalizeScheduleInput({ platform: 'amazon', keyword: 'x' }).platform, 'amazon');
  assert.throws(() => normalizeScheduleInput({ platform: '', keyword: 'x' }), /Platform is required/);
  assert.throws(() => normalizeScheduleInput({ platform: 'etsy', keyword: '' }), /Keyword/);
  assert.throws(() => normalizeScheduleInput({ platform: 'etsy', keyword: 'x', accountId: 0 }), /Account/);
  assert.deepEqual(normalizeScheduleInput({ platform: 'etsy', keyword: 'x', everyHours: 999, variantMode: 'all', maxVariants: 999 }), {
    platform: 'etsy', keyword: 'x', accountId: null, everyMinutes: 10080, variantMode: 'all', maxVariants: 250, maxListings: 30, scheduleType: 'interval', dailyTime: '09:00', runAt: null,
  });
});

// Gap #5 mandatory regression (Final Gap Closure Round): the final renew
// before completion succeeds (A still believed it owned the schedule), but
// ownership is stolen by B immediately after — before markComplete's DB write
// lands. The DB write itself was always safe; run()'s RETURNED SUMMARY must
// now also report claimLost instead of a fake success.
test('run() reports claimLost, not fake success, when ownership is stolen right before the final markComplete (#5)', async () => {
  const created = await db.createMarketplaceCaptureSchedule({ platform: 'etsy', keyword: 'gap5-race-' + Date.now(), everyHours: 1 });
  try {
    const claimToken = await db.claimMarketplaceCaptureSchedule(created.id, 60000);
    assert.ok(claimToken);

    let renewCount = 0;
    const scheduler = createMarketplaceCaptureScheduler({
      discover: async () => ({ items: [{ url: 'https://www.etsy.com/listing/1/a' }] }),
      capture: async () => ({ captureStatus: { status: 'ok' } }),
      markComplete: async (id, summary, token) => await db.completeMarketplaceCaptureSchedule(id, summary, new Date(), token),
      renewClaim: async (id, token) => {
        renewCount++;
        const ok = await db.renewMarketplaceCaptureScheduleClaim(id, 60000, token);
        // The 3rd renewClaim call (post-discovery, per-item, pre-completion —
        // exactly one of each for a single-item run) is the FINAL renewal
        // before markComplete. It succeeds (ok=true) — A still legitimately
        // owned the schedule at that instant — but B steals it immediately
        // after, before the completion write itself runs.
        if (renewCount === 3) {
          await db.releaseMarketplaceCaptureScheduleClaim(id, token);
          await db.claimMarketplaceCaptureSchedule(id, 60000);
        }
        return ok;
      }
    });

    const summary = await scheduler.run({ id: created.id, keyword: 'gap5-race', max_listings: 30 }, claimToken);

    assert.equal(summary.claimLost, true, 'run() must report claimLost instead of a fake success');
    assert.equal(summary.error, 'MARKETPLACE_CLAIM_LOST');
    const row = (await db.getMarketplaceCaptureSchedules()).find((s) => s.id === created.id);
    assert.equal(row.last_summary, null, 'No completion record may be written for the stale attempt');
  } finally {
    await db.deleteMarketplaceCaptureSchedule(created.id);
  }
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
