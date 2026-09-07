/**
 * Managed Execution Wrapper (Live-Readiness Round #11)
 *
 * Channel-based crawls already get the full reliability lifecycle via
 * runs.service.js's executeRun(): heartbeat, execution-lease ownership checks,
 * retry classification, cleanup. Non-channel executors (user_journey,
 * marketplace_capture, marketplace_discovery) went through the Resource
 * Scheduler for admission but had none of that lifecycle — each one would
 * otherwise have to hand-roll its own heartbeat/lease/retry/cleanup code.
 *
 * `runManaged(runId, options, workFn)` provides, once, for every non-channel
 * workload:
 *   - executionToken ownership checks before starting and before persisting
 *     the final result (stale-attempt protection)
 *   - a periodic heartbeat (via the same HeartbeatTracker used by channels)
 *   - a progress-reporting handle passed into workFn
 *   - an execution timeout with an AbortSignal handed to workFn
 *   - retry classification via the shared RetryPolicy on failure
 *   - guaranteed tracker cleanup (finally)
 *   - registration with the Execution Control Registry (Final Blocker Fix
 *     Round §1), so an external monitor (StuckDetector) can abort THIS
 *     specific execution and know when its cleanup has actually finished —
 *     not just revoke its DB ownership while the real work keeps running.
 *
 * workFn signature: async ({ tracker, signal, reportProgress }) => result
 */

const { getOrCreateTracker, removeTracker, STAGES } = require('./heartbeat');
const { isCurrentOwner, issueExecutionToken } = require('./execution-lease');
const { defaultRetryPolicy } = require('./retry-policy');
const { registerExecution, registerCleanup, abortExecution, markExecutionSettled, unregisterExecution } = require('./execution-control');

async function runManaged(runId, options, workFn) {
  const db = options.database || require('../database');
  const executionToken = options.executionToken || null;
  const executionClass = options.executionClass || null;
  const attempt = Number(options.attempt || 1);
  const timeoutMs = options.timeoutMs || Number(process.env.MANAGED_EXECUTION_TIMEOUT_MS) || 300000;

  const tracker = getOrCreateTracker(runId, db, { executionClass, executionToken, attempt });

  const assertOwner = (stageLabel) => {
    if (timedOut) {
      throw new Error(`STALE_EXECUTION: token ${executionToken} was superseded before "${stageLabel}" (timed out)`);
    }
    if (!isCurrentOwner(db, runId, executionToken)) {
      throw new Error(`STALE_EXECUTION: token ${executionToken} was superseded before "${stageLabel}"`);
    }
  };

  const abortController = new AbortController();
  // Registry lookups need a real key even for callers that didn't supply an
  // executionToken — a null/undefined key would make registerExecution() a
  // silent no-op, and abortExecution() would then never call abort() at all
  // (a regression from the previous unconditional abortController.abort()).
  const registryKey = executionToken || Symbol(`anonymous-execution-run${runId}`);
  registerExecution(registryKey, abortController);
  // The SAME cleanup path is used whether the timeout fires internally
  // (below) or an external monitor calls abortExecution(executionToken) —
  // e.g. StuckDetector, which has no other way to reach a live execution.
  if (options.onTimeout) {
    registerCleanup(registryKey, () => options.onTimeout(abortController));
  }

  let timedOut = false;
  let timer = null;
  let workPromiseCreated = false;
  // Final Stabilization Round #7: a workFn that ignores AbortSignal must not be
  // able to hang runManaged() forever. abort() alone only *requests*
  // cancellation; if the callee never checks signal.aborted, the awaited
  // promise never settles. Racing workPromise against a real timeoutPromise
  // guarantees this function rejects at ~timeoutMs regardless of whether the
  // callee cooperates, matching the wall-clock requirement.
  const TIMEOUT_SENTINEL = Symbol('TIMEOUT_SENTINEL');
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(TIMEOUT_SENTINEL);
    }, timeoutMs);
    // §7 (Final Blocker Fix Round): this timer's firing is what SETTLES the
    // Promise the caller is actively awaiting (via Promise.race below) — it
    // is a required timer, not a daemon/background one. unref() lets Node
    // exit the event loop before this timer fires if nothing else is
    // pending, silently abandoning the timeout guarantee (the awaited
    // promise then never settles). Do NOT unref a timer an active await
    // depends on for correctness.
  });

  try {
    assertOwner('START');
    tracker.setStage(STAGES.SCRAPING);

    const workPromise = workFn({
      tracker,
      signal: abortController.signal,
      reportProgress: (count, extra) => tracker.progress(count, extra),
      assertOwner
    });
    workPromiseCreated = true;
    // §1.3: the registry's "settled" signal must reflect when the REAL work
    // finishes, not when runManaged() itself resolves/rejects — those are
    // different moments once a timeout can make runManaged() reject early
    // while workPromise keeps running in the background. Whoever actually
    // owns the worker slot/RAM/lock (the Resource Scheduler) awaits this
    // signal — bounded — before releasing them, so a new Attempt B cannot be
    // dispatched while A's real work might still be using the same resource.
    workPromise
      .catch(() => {}) // eventual rejection here must never surface as unhandled
      .finally(() => {
        markExecutionSettled(registryKey);
        unregisterExecution(registryKey);
      });

    const result = await Promise.race([workPromise, timeoutPromise]);

    if (result === TIMEOUT_SENTINEL) {
      // Trigger abort + registered cleanup (e.g. onTimeout closing the
      // browser this execution owns) without blocking this function's own
      // rejection on the FULL workPromise unwinding — that wait happens at
      // the Scheduler layer via waitForSettled(), not here.
      await abortExecution(registryKey, 'MANAGED_EXECUTION_TIMEOUT');
      throw new Error(`MANAGED_EXECUTION_TIMEOUT: exceeded ${timeoutMs}ms`);
    }

    // Re-check ownership right before persisting the final result — the work
    // itself may have taken a long time (browser automation, HTML capture).
    assertOwner('PRE_PERSIST');

    tracker.setStage(STAGES.COMPLETED);
    db.updateRun(runId, { status: 'done', healthSnapshot: JSON.stringify({ result, ...tracker.getSnapshot() }) });
    return result;
  } catch (err) {
    const effectiveErr = timedOut ? new Error(`MANAGED_EXECUTION_TIMEOUT: exceeded ${timeoutMs}ms`) : err;
    tracker.setStage(STAGES.FAILED, { error: effectiveErr.message });

    if (!isCurrentOwner(db, runId, executionToken)) {
      // Stale execution: do not touch the run's status, a newer attempt owns it.
      throw effectiveErr;
    }

    if (defaultRetryPolicy.shouldRetry(attempt, effectiveErr)) {
      const nextAttempt = attempt + 1;
      const updatedOptions = { ...options, attempt: nextAttempt, executionToken: issueExecutionToken(runId, nextAttempt) };
      delete updatedOptions.database;
      db.updateRun(runId, {
        status: 'queued',
        errorMessage: `Transient error, retrying (${attempt}/${defaultRetryPolicy.maxAttempts}): ${effectiveErr.message}`,
        inputOptions: JSON.stringify(updatedOptions)
      });
    } else {
      db.updateRun(runId, { status: 'failed', errorMessage: effectiveErr.message });
    }
    throw effectiveErr;
  } finally {
    clearTimeout(timer);
    removeTracker(executionToken);
    // Only a fallback for the case workFn() was never even invoked
    // (assertOwner('START') threw immediately) — otherwise this registry
    // entry's settled signal is owned by workPromise's own .finally() above,
    // which must fire only when the REAL work actually finishes, not when
    // this function exits (those can happen at very different times once a
    // timeout makes this function reject early). Calling these twice is
    // harmless (idempotent), but calling them here UNCONDITIONALLY would
    // prematurely mark a still-running execution as settled.
    if (!workPromiseCreated) {
      markExecutionSettled(registryKey);
      unregisterExecution(registryKey);
    }
  }
}

module.exports = { runManaged };
