/**
 * No-Orphan Invariant Checker (Final Architecture Closure Round §13)
 *
 * Small, non-framework diagnostic over the ResourceScheduler's OWN in-memory
 * bookkeeping — for tests/diagnostics, not a runtime guard. Every worker-pool
 * slot, exclusive lock, and RAM reservation is keyed by executionToken; this
 * asserts each such token is accounted for by something the Scheduler still
 * believes is active (activeRunMetrics) or is honestly holding pending
 * confirmed settlement (cleanupFailedTokens, see §5/dispatchRun). A token
 * present in the pools/monitor but in NEITHER map is an orphan: a resource
 * nobody is tracking, which no future release() call would ever free.
 */
function assertSystemInvariants(scheduler) {
  const violations = [];
  const known = new Set([
    ...scheduler.activeRunMetrics.keys(),
    ...scheduler.cleanupFailedTokens.keys()
  ]);

  for (const [poolName, set] of Object.entries(scheduler.pools.activeWorkers)) {
    for (const token of set) {
      if (!known.has(token)) {
        violations.push(`Orphan worker slot in pool ${poolName}: token ${token} is not tracked by activeRunMetrics or cleanupFailedTokens`);
      }
    }
  }

  for (const [lockKey, owner] of scheduler.pools.locks.entries()) {
    if (!known.has(owner)) {
      violations.push(`Orphan lock ${lockKey}: owner token ${owner} is not tracked`);
    }
  }

  for (const token of scheduler.monitor.reservations.keys()) {
    if (!known.has(token)) {
      violations.push(`Orphan RAM reservation: token ${token} is not tracked`);
    }
  }

  return { ok: violations.length === 0, violations };
}

module.exports = { assertSystemInvariants };
