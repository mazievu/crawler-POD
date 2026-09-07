/**
 * Stuck Run Detector Daemon (Final Implementation Closure §1: two-signal supervision)
 *
 * Two independent signals, checked separately:
 *  - HEARTBEAT (liveness): "is this execution's process still alive?" Ticks on
 *    a fixed interval regardless of work progress. If heartbeat goes stale
 *    beyond a liveness threshold (default derived from missing ~3 beats), the
 *    execution is presumed DEAD — the process itself may have crashed/hung at
 *    the event-loop level, wedged, or been killed.
 *  - PROGRESS (forward movement): "is the work actually advancing?" A process
 *    can be perfectly alive (heartbeat ticking) while legitimately sitting in
 *    one stage for a while (e.g. polling an Apify job every few seconds
 *    without a local stage change) — that is NOT stuck. Progress staleness
 *    uses a class-specific timeout (LOCAL_HTTP vs BROWSER vs CLOUD_API, etc.)
 *    since a healthy Apify poll loop can legitimately take minutes longer than
 *    a healthy LOCAL_HTTP scrape.
 *
 * heartbeat fresh + progress fresh   -> HEALTHY
 * heartbeat stale beyond liveness    -> EXECUTION_LOST (dead process)
 * heartbeat fresh, progress stale    -> EXECUTION_STALLED (hung but alive)
 *
 * A fresh heartbeat is NOT proof the business work isn't stuck — both signals
 * are checked independently, every tick.
 */

const { getActiveHeartbeats, removeTracker } = require('./heartbeat');
const { defaultRetryPolicy } = require('./retry-policy');
const { issueExecutionToken } = require('./execution-lease');
const { abortExecution, waitForSettled } = require('./execution-control');

const APIFY_TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']);

async function defaultGetApifyRunStatus(actorRunId) {
  try {
    const apifyClient = require('../apify-client');
    const status = await apifyClient.getRunStatus(actorRunId);
    return status || 'UNKNOWN';
  } catch (_e) {
    return 'UNKNOWN';
  }
}

const DEFAULT_STUCK_TIMEOUTS_MS = {
  LOCAL_HTTP: Number(process.env.STUCK_TIMEOUT_LOCAL_HTTP_MS) || 120000,   // 2 min
  CLOUD_API: Number(process.env.STUCK_TIMEOUT_CLOUD_API_MS) || 420000,     // 7 min — Apify jobs poll for a while
  BROWSER: Number(process.env.STUCK_TIMEOUT_BROWSER_MS) || 180000,        // 3 min
  CDP: Number(process.env.STUCK_TIMEOUT_CDP_MS) || 180000,                // 3 min
  default: Number(process.env.STUCK_TIMEOUT_DEFAULT_MS) || 120000
};

// §1D: liveness timeout should tolerate a few missed beats, not kill an
// execution the moment one beat is late (heartbeat interval jitter, a GC
// pause, a brief event-loop block are all normal). Default: 3 missed beats.
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 30000;
const DEFAULT_HEARTBEAT_DEAD_AFTER_MS = Number(process.env.HEARTBEAT_DEAD_AFTER_MS) || (3 * HEARTBEAT_INTERVAL_MS);

class StuckDetector {
  constructor(options = {}) {
    this.db = options.database || require('../database');
    this.queue = options.queue;
    this.retryPolicy = options.retryPolicy || defaultRetryPolicy;
    this.getApifyRunStatus = options.getApifyRunStatus || null;
    this.timeoutsByClass = { ...DEFAULT_STUCK_TIMEOUTS_MS, ...(options.timeoutsByClass || {}) };
    this.heartbeatDeadAfterMs = options.heartbeatDeadAfterMs || DEFAULT_HEARTBEAT_DEAD_AFTER_MS;
    this.checkIntervalMs = options.checkIntervalMs || 15000; // 15 seconds
    // §1.3: bounded wait for abortExecution()'s cleanup + the real workFn to
    // settle before this detector finalizes recovery bookkeeping.
    this.cleanupGraceMs = options.cleanupGraceMs || Number(process.env.STUCK_CLEANUP_GRACE_MS) || 5000;
    this.timer = null;
  }

  timeoutFor(executionClass) {
    return this.timeoutsByClass[executionClass] || this.timeoutsByClass.default;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkStuckRuns().catch(err => {
        console.error('[StuckDetector] Error checking stuck runs:', err.message);
      });
    }, this.checkIntervalMs);
    this.timer.unref();
    console.log('[StuckDetector] Started stuck run detector');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Recovers one abnormal execution: revokes its tracker/lease, retries with a
   * fresh executionToken if the policy allows, otherwise marks the Run 'stuck'.
   * Shared by both the EXECUTION_LOST and EXECUTION_STALLED paths — the
   * ownership-revocation mechanics are identical, only the log reason differs.
   */
  async recoverExecution(hb, reasonCode, reasonMessage) {
    console.warn(`[StuckDetector] Run #${hb.runId} ${reasonCode}: ${reasonMessage}`);

    const run = await this.db.getRunById(hb.runId);
    const options = typeof run?.input_options === 'string' ? JSON.parse(run.input_options || '{}') : (run?.options || {});
    const attempt = Number(options.attempt || 1);

    // Live-Readiness Round #10: remove ONLY this attempt's tracker, keyed
    // by its executionToken — a sibling attempt for the same runId (should
    // one somehow already exist) is untouched.
    removeTracker(hb.executionToken);

    // Gap #1 closure (Final Small-Gap Closure Round): revoke A's business-write
    // ownership IMMEDIATELY, before abort/settle — not after. abortExecution()/
    // waitForSettled() below can take up to cleanupGraceMs; during that whole
    // window, A's old token must already fail isCurrentOwner(), otherwise a
    // still-alive A could persist data or mark the Run done WHILE recovery is
    // still in flight, before this function ever gets to write a new status.
    // Reuses the existing execution-lease token model — no new framework: a
    // tombstoned token can never equal a real token, so isCurrentOwner()
    // rejects it exactly like any other superseded token.
    const revokedOptions = { ...options, executionToken: `REVOKED:${hb.executionToken}` };
    await this.db.updateRun(hb.runId, { inputOptions: JSON.stringify(revokedOptions) });

    // §1.3: detecting stuck is not the same as recovering it — actually try
    // to stop A's real work (abort signal + registered cleanup, e.g. closing
    // a browser it owns) instead of only flipping DB ownership while the
    // real work keeps running unattended. Bounded wait for confirmation;
    // the Resource Scheduler's own release (dispatchRun) independently waits
    // on the same registry signal before freeing worker slot/RAM/lock, so a
    // new Attempt B still cannot double-allocate a resource A genuinely
    // still holds even if this particular wait times out.
    await abortExecution(hb.executionToken, reasonCode);
    const settledInTime = await waitForSettled(hb.executionToken, this.cleanupGraceMs);
    if (!settledInTime) {
      // Gap #1 closure (Final Gap Closure Round), Layer 1: settlement is not
      // merely a diagnostic signal — it GATES retry. Re-queuing here while A's
      // real work is unconfirmed would let the Scheduler admit Attempt B into
      // ANY free slot in the same pool (canAdmit() has no concept of runId),
      // producing two simultaneous live attempts for the same Run. Do NOT
      // queue, do NOT issue a new token; record the honest terminal state
      // instead. The Scheduler's own dispatchRun() keeps polling
      // waitForSettled() independently and will release A's resources
      // whenever it actually does settle (however late) — this function has
      // no further role once it reports the failure honestly.
      console.error(`[StuckDetector] Run #${hb.runId} (token ${hb.executionToken}) did not confirm cleanup within ${this.cleanupGraceMs}ms of abort — RECOVERY_CLEANUP_FAILED. NOT queuing a retry: Attempt A's real work is not confirmed stopped.`);
      await this.db.updateRun(hb.runId, {
        status: 'stuck',
        errorMessage: `RECOVERY_CLEANUP_FAILED (${reasonCode}): ${reasonMessage} — old attempt did not confirm settlement within ${this.cleanupGraceMs}ms; retry withheld to avoid a concurrent duplicate execution`
      });
      return;
    }

    // Gap #4 closure (Final Small-Gap Closure Round): block Apify retry while old remote actor is still active.
    let externalExecution = null;
    try {
      externalExecution = typeof run?.external_execution_json === 'string'
        ? JSON.parse(run.external_execution_json)
        : run?.external_execution_json;
    } catch (_e) {}

    if (externalExecution && externalExecution.executionClass === 'CLOUD_API' && externalExecution.externalExecutionId) {
      const getStatusFn = this.getApifyRunStatus || defaultGetApifyRunStatus;
      const status = await getStatusFn(externalExecution.externalExecutionId);
      if (!APIFY_TERMINAL_STATUSES.has(status)) {
        console.error(`[StuckDetector] Run #${hb.runId} remote Apify actor (${externalExecution.externalExecutionId}) status is ${status} — RECOVERY_FAILED. Retry withheld.`);
        await this.db.updateRun(hb.runId, {
          status: 'stuck',
          errorMessage: `RECOVERY_FAILED (${reasonCode}): remote Apify actor (${externalExecution.externalExecutionId}) is still active (${status}) — retry withheld until old actor is confirmed terminal.`
        });
        return;
      }
    }

    if (this.retryPolicy.shouldRetry(attempt, new Error(reasonCode))) {
      const nextAttempt = attempt + 1;
      // A fresh executionToken revokes the stuck attempt's ownership: if it
      // wakes up later, isCurrentOwner() will reject its writes (P0-8/#11).
      const updatedOptions = { ...options, attempt: nextAttempt, executionToken: issueExecutionToken(hb.runId, nextAttempt) };
      await this.db.updateRun(hb.runId, {
        status: 'queued',
        errorMessage: `Recovered from ${reasonCode} (attempt ${attempt}/${this.retryPolicy.maxAttempts}): ${reasonMessage}`,
        inputOptions: JSON.stringify(updatedOptions)
      });
    } else {
      await this.db.updateRun(hb.runId, {
        status: 'stuck',
        errorMessage: `${reasonCode}: ${reasonMessage}`
      });
    }
  }

  async checkStuckRuns() {
    // §1C: reads the in-memory heartbeat registry directly — never the DB —
    // so DB flush throttling (§2) cannot delay stuck detection.
    const active = getActiveHeartbeats();
    const stuckFound = [];

    for (const hb of active) {
      if (hb.idleSinceHeartbeatMs > this.heartbeatDeadAfterMs) {
        // Heartbeat itself has gone stale beyond the liveness threshold — the
        // execution is presumed dead regardless of what progressAge shows
        // (a dead process cannot be "still progressing").
        stuckFound.push(hb);
        await this.recoverExecution(
          hb,
          'EXECUTION_LOST',
          `No heartbeat for ${Math.round(hb.idleSinceHeartbeatMs / 1000)}s (liveness limit=${Math.round(this.heartbeatDeadAfterMs / 1000)}s, class=${hb.executionClass || 'default'})`
        );
        continue;
      }

      const progressTimeoutMs = this.timeoutFor(hb.executionClass);
      if (hb.idleSinceProgressMs > progressTimeoutMs) {
        // Heartbeat is fresh (process alive) but work hasn't advanced within
        // its class-specific allowance — alive but hung.
        stuckFound.push(hb);
        await this.recoverExecution(
          hb,
          'EXECUTION_STALLED',
          `No progress in stage ${hb.stage} for ${Math.round(hb.idleSinceProgressMs / 1000)}s (limit=${Math.round(progressTimeoutMs / 1000)}s, class=${hb.executionClass || 'default'})`
        );
      }
    }

    return stuckFound;
  }
}

let globalStuckDetector = null;

function getStuckDetector(options = {}) {
  if (!globalStuckDetector) {
    globalStuckDetector = new StuckDetector(options);
  }
  return globalStuckDetector;
}

module.exports = {
  StuckDetector,
  getStuckDetector,
  DEFAULT_STUCK_TIMEOUTS_MS,
  DEFAULT_HEARTBEAT_DEAD_AFTER_MS
};
