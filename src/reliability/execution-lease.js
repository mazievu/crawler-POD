/**
 * Execution Lease / Ownership Token
 *
 * Problem: when the stuck-detector or restart-recovery re-queues a run, the OLD
 * execution (the hung scraper/browser call) may still be alive and may eventually
 * try to write `done`/results to the run row, racing with the NEW attempt.
 *
 * Fix: every attempt gets a unique executionToken embedded in run.input_options.
 * Before writing any status-changing update, runs.service.js re-reads the run row
 * and checks its own token still matches. If a newer token has been issued (by
 * stuck-detector or restart-recovery), the stale execution's write is rejected —
 * it cannot mark the run done/failed, and it cannot overwrite Current State.
 */

function issueExecutionToken(runId, attempt) {
  return `run${runId}-a${attempt}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getRunToken(run) {
  if (!run) return null;
  try {
    const options = typeof run.input_options === 'string' ? JSON.parse(run.input_options || '{}') : (run.options || {});
    return options.executionToken || null;
  } catch (_e) {
    return null;
  }
}

/**
 * Returns true if `token` is still the current owner of runId according to the DB.
 * A run with no token recorded yet (legacy/never-leased) is treated as owned by
 * whichever execution asks first (returns true), so this stays backward compatible
 * with runs submitted before the lease system existed.
 */
async function isCurrentOwner(db, runId, token) {
  if (!token) return true; // No lease requested: legacy behavior, always allowed.
  const fresh = await db.getRunById(runId);
  const freshToken = getRunToken(fresh);
  if (!freshToken) return true; // Nothing has claimed a newer lease yet.
  return freshToken === token;
}

module.exports = { issueExecutionToken, getRunToken, isCurrentOwner };
