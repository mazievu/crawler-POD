/**
 * Server Restart & Crash Recovery Engine
 * Scans for orphaned runs left in 'running' state upon boot and recovers them cleanly.
 *
 * Uses a direct `WHERE status = 'running'` query (db.getRunsByStatus) instead of
 * getAllRuns(limit) + JS filter, so recovery is never bounded by an arbitrary row cap.
 *
 * Every re-queued run gets a fresh executionToken (see execution-lease.js). This
 * invalidates the old in-flight execution: if the original process wakes up later
 * and tries to write results, runs.service.js rejects the write because the token
 * on the run row no longer matches what that execution was given.
 *
 * Gap #4 closure (Final Gap Closure Round): a DB-only reconciliation is not
 * enough for execution classes whose real work can outlive this Node process
 * entirely — a Toidispy/CDP child process, or a remote Apify actor run. For
 * those, `runs.external_execution_json` (written by the backend adapter via
 * runs.service.js's reportExternalExecution callback) records enough identity
 * to PROBE (never blindly kill/duplicate) whether the old work is still
 * active before deciding it's safe to re-queue a fresh attempt.
 */

const { defaultRetryPolicy } = require('./retry-policy');
const { issueExecutionToken } = require('./execution-lease');

/**
 * Best-effort PID liveness probe. Does NOT prove ownership (a PID can be
 * reused by an unrelated process after the original exits) — it only answers
 * "is *something* still running under this PID", which is enough to refuse
 * an unsafe requeue; it is deliberately never used to kill anything.
 */
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false; // no such process — safe to treat as stopped
    return true; // EPERM (exists, different owner) or anything else — conservatively still alive
  }
}

const APIFY_TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']);

/** Returns a terminal status string, or 'UNKNOWN' if it cannot be determined (treated conservatively as still-running). */
async function defaultGetApifyRunStatus(actorRunId) {
  try {
    const apifyClient = require('../apify-client');
    const status = await apifyClient.getRunStatus(actorRunId);
    return status || 'UNKNOWN';
  } catch (_e) {
    return 'UNKNOWN';
  }
}

function parseExternalExecution(run) {
  if (!run.external_execution_json) return null;
  try {
    const parsed = JSON.parse(run.external_execution_json);
    return parsed && parsed.executionClass && parsed.externalExecutionId ? parsed : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Probes whether the recorded external execution is still active.
 * Returns { stillActive, checkFailed } — checkFailed means the probe itself
 * could not produce a reliable answer (e.g. Apify API unreachable), which is
 * treated the SAME as stillActive=true for safety: never requeue on an
 * inconclusive check.
 */
async function probeExternalExecution(externalExecution, { isPidAlive, getApifyRunStatus }) {
  if (externalExecution.executionClass === 'CDP') {
    const pid = Number(externalExecution.externalExecutionId);
    if (!Number.isFinite(pid) || pid <= 0) return { stillActive: true, checkFailed: true };
    try {
      return { stillActive: isPidAlive(pid), checkFailed: false };
    } catch (_e) {
      return { stillActive: true, checkFailed: true };
    }
  }
  if (externalExecution.executionClass === 'CLOUD_API') {
    try {
      const status = await getApifyRunStatus(externalExecution.externalExecutionId);
      if (status === 'UNKNOWN') return { stillActive: true, checkFailed: true };
      return { stillActive: !APIFY_TERMINAL_STATUSES.has(status), checkFailed: false };
    } catch (_e) {
      return { stillActive: true, checkFailed: true };
    }
  }
  // Unknown/unrecognized executionClass metadata — nothing to probe against;
  // do not treat this as a reason to block requeue (LOCAL_HTTP/BROWSER never
  // report external execution metadata in the first place — see Gap #4
  // report: they die with the parent process by construction).
  return { stillActive: false, checkFailed: false };
}

async function recoverOrphanedRuns(database = null, retryPolicy = defaultRetryPolicy, probeOptions = {}) {
  const db = database || require('../database');
  const isPidAlive = probeOptions.isPidAlive || defaultIsPidAlive;
  const getApifyRunStatus = probeOptions.getApifyRunStatus || defaultGetApifyRunStatus;

  const orphaned = typeof db.getRunsByStatus === 'function'
    ? db.getRunsByStatus('running')
    : (db.getAllRuns ? db.getAllRuns(100000).filter(r => r.status === 'running') : []);

  let recoveredCount = 0;
  let failedCount = 0;
  let recoveryFailedCount = 0; // Gap #4: external work confirmed-or-possibly still active — neither requeued nor marked plain 'failed'.

  for (const run of orphaned) {
    const externalExecution = parseExternalExecution(run);

    if (externalExecution) {
      const { stillActive, checkFailed } = await probeExternalExecution(externalExecution, { isPidAlive, getApifyRunStatus });
      if (stillActive || checkFailed) {
        db.updateRun(run.id, {
          status: 'stuck',
          errorMessage: `RECOVERY_FAILED: external execution (${externalExecution.executionClass} ${externalExecution.externalExecutionId}) is ${checkFailed ? 'of unconfirmed status' : 'still active'} after server restart — NOT re-queued to avoid dispatching a duplicate execution. Manual verification required.`
        });
        recoveryFailedCount++;
        continue;
      }
      // externalExecution confirmed stopped — safe to fall through to normal DB recovery below.
    }

    const options = typeof run.input_options === 'string' ? JSON.parse(run.input_options || '{}') : (run.options || {});
    const attempt = Number(options.attempt || 1);

    if (retryPolicy.shouldRetry(attempt, new Error('SERVER_RESTART'))) {
      const nextAttempt = attempt + 1;
      const updatedOptions = { ...options, attempt: nextAttempt, executionToken: issueExecutionToken(run.id, nextAttempt) };
      db.updateRun(run.id, {
        status: 'queued',
        errorMessage: `Auto-recovered after server restart (attempt ${attempt}/${retryPolicy.maxAttempts})`,
        inputOptions: JSON.stringify(updatedOptions),
        externalExecution: null
      });
      recoveredCount++;
    } else {
      db.updateRun(run.id, {
        status: 'failed',
        errorMessage: 'SERVER_RESTART_TERMINATED: Run was interrupted during unexpected server shutdown',
        externalExecution: null
      });
      failedCount++;
    }
  }

  if (orphaned.length > 0) {
    console.log(`[RestartRecovery] Found ${orphaned.length} orphaned running jobs: ${recoveredCount} re-queued, ${failedCount} marked failed, ${recoveryFailedCount} RECOVERY_FAILED (external execution active/unconfirmed).`);
  }

  return {
    totalOrphaned: orphaned.length,
    recoveredCount,
    failedCount,
    recoveryFailedCount
  };
}

module.exports = { recoverOrphanedRuns, defaultIsPidAlive, defaultGetApifyRunStatus };
