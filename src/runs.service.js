const db = require('./database');
const registry = require('./channels/registry');
const { BackendRouter } = require('./router/backend-router');
const { normalizeItems } = require('./normalize');
const doctorModule = require('./doctor');
const { getOrCreateTracker, removeTracker, STAGES } = require('./reliability/heartbeat');
const { defaultRetryPolicy } = require('./reliability/retry-policy');
const { isCurrentOwner } = require('./reliability/execution-lease');
const { registerExecution, markExecutionSettled, unregisterExecution } = require('./reliability/execution-control');

const router = new BackendRouter({ registry, doctor: doctorModule });

/**
 * Execution lease guard (Simplification Round #11): checked before EVERY
 * write to shared/business state, not just the final done/failed transition.
 * A run's `router.run()` step can take minutes; if a stuck-detector or restart
 * recovery pass revokes this execution's token while it's in flight, every
 * subsequent write in this function — backend metadata, legacy snapshots,
 * Current State, Daily History, final status — must be refused, not just the
 * last one.
 */
// Async since the PostgreSQL cutover: isCurrentOwner() reads the run row, so
// without the await `!Promise` is always false and this guard silently stops
// refusing stale writes.
async function assertStillOwner(db, runId, executionToken, stageLabel) {
  if (!(await isCurrentOwner(db, runId, executionToken))) {
    console.warn(`Run ${runId}: stale execution (token ${executionToken}) attempted to write at stage "${stageLabel}" after being superseded; discarding.`);
    return false;
  }
  return true;
}

async function executeRun(runId, platform, query, options = {}) {
  const executionToken = options.executionToken || null;
  const executionClass = options.executionClass || null;
  const attempt = Number(options.attempt || 1);
  // Live-Readiness Round #10: tracker keyed by executionToken, not runId — a
  // retried attempt gets its OWN tracker, never overwriting/removing a sibling.
  const tracker = getOrCreateTracker(runId, db, { executionClass, executionToken, attempt });
  // Gap #2 closure (Final Gap Closure Round): channel-based crawls previously
  // never registered with the ExecutionControlRegistry — abortExecution()
  // was a silent no-op and waitForSettled() resolved instantly-true for this
  // path regardless of whether router.run()'s real backend work had actually
  // stopped. registryKey mirrors managed-execution.js's own pattern: a real
  // key even when no executionToken was supplied (legacy/never-leased callers).
  const abortController = new AbortController();
  const registryKey = executionToken || Symbol(`anonymous-channel-execution-run${runId}`);
  registerExecution(registryKey, abortController);

  try {
    tracker.setStage(STAGES.INIT);
    await db.updateRun(runId, { status: 'running' });

    const channel = registry.getChannel(platform);
    if (!channel) throw new Error(`Unknown channel: ${platform}`);

    // Route and Run
    tracker.setStage(STAGES.ROUTING);
    tracker.setStage(STAGES.SCRAPING);
    // The SAME signal threads through BackendRouter.run() -> adapter.run() ->
    // the actual crawler (e.g. anti-bot/scraper-factory's retry loop,
    // cdp.backend.js's spawned child) — see those files for how each
    // execution class honors it.
    // Gap #4 closure (Final Gap Closure Round): lets a backend adapter report
    // an external execution (a spawned child process, a remote Apify actor
    // run) that can outlive THIS Node process, so RestartRecovery can
    // reconcile it on next boot instead of blindly dispatching a duplicate.
    const reportExternalExecution = async (info) => {
      await db.updateRun(runId, { externalExecution: { ...info, executionToken, startedAt: info.startedAt || Date.now() } });
    };
    const result = await router.run(platform, query, { ...options, signal: abortController.signal, reportExternalExecution })
      .finally(() => {
        // Settlement fires the moment the REAL backend work resolves/rejects
        // — not whenever this outer function eventually returns. Persistence
        // below is fast/local and not what an abort signal is protecting
        // against; this matches managed-execution.js's own workPromise
        // settlement semantics exactly.
        markExecutionSettled(registryKey);
        unregisterExecution(registryKey);
      });

    // router.run() can take minutes; re-check ownership before the FIRST write
    // that happens after it returns.
    if (!(await assertStillOwner(db, runId, executionToken, 'POST_BACKEND_RUN'))) {
      removeTracker(executionToken);
      return { success: false, runId, discarded: true, reason: 'STALE_EXECUTION' };
    }

    // Save metadata early in case of normalization failure
    await db.updateRun(runId, {
      activeBackend: result.activeBackend,
      backendKind: result.backendKind,
      backendStatus: result.backendStatus,
      backendVersion: result.backendVersion,
      backendRunId: result.backendRunId,
      apifyDatasetId: result.datasetId, // Map for backward compatibility
      healthSnapshot: JSON.stringify(tracker.getSnapshot())
    });

    if (result.raw.rawStatus !== 'SUCCEEDED') {
      throw new Error(`Backend run failed with status: ${result.raw.rawStatus}`);
    }

    // Normalize items based on channel's primary intelligence type or configured normalizer
    tracker.setStage(STAGES.NORMALIZING);
    const normalizerName = channel.normalizer;
    const normalizedItems = normalizeItems(normalizerName, result.items || [], { platform, query });
    // Image-only collection is intentional: every stored post/listing must
    // have a visual asset that can be shown in the product intelligence UI.
    const itemsWithImages = normalizedItems.filter((item) => item.image);
    const skippedWithoutImages = normalizedItems.length - itemsWithImages.length;
    tracker.progress(itemsWithImages.length);

    // Guard again immediately before the PERSISTING stage: this is where legacy
    // snapshots, product_current, and daily_packed_history all get written.
    if (!(await assertStillOwner(db, runId, executionToken, 'PRE_PERSIST'))) {
      removeTracker(executionToken);
      return { success: false, runId, discarded: true, reason: 'STALE_EXECUTION' };
    }

    // Save to DB
    tracker.setStage(STAGES.PERSISTING);
    const dbCounts = await db.insertSnapshots(runId, platform, query, itemsWithImages);

    tracker.setStage(STAGES.COMPLETED);
    await db.updateRun(runId, {
      status: 'done',
      ...dbCounts
    });

    console.log(`Run ${runId} completed via ${result.activeBackend}: ${itemsWithImages.length} items with images (${skippedWithoutImages} skipped, ${dbCounts.newItems} new)`);
    removeTracker(executionToken);
    return { success: true, runId, dbCounts };
  } catch (err) {
    tracker.setStage(STAGES.FAILED, { error: err.message });
    console.error(`Run ${runId} failed:`, err.message);

    if (!(await isCurrentOwner(db, runId, executionToken))) {
      console.warn(`Run ${runId}: stale execution (token ${executionToken}) errored after being superseded; not touching run status.`);
      removeTracker(executionToken);
      throw err;
    }

    if (defaultRetryPolicy.shouldRetry(attempt, err)) {
      const nextAttempt = attempt + 1;
      const updatedOptions = { ...options, attempt: nextAttempt };
      await db.updateRun(runId, {
        status: 'queued',
        errorMessage: `Transient error, retrying (${attempt}/${defaultRetryPolicy.maxAttempts}): ${err.message}`,
        inputOptions: JSON.stringify(updatedOptions)
      });
    } else {
      await db.updateRun(runId, { status: 'failed', errorMessage: err.message });
    }
    removeTracker(executionToken);
    throw err;
  }
}

module.exports = { executeRun, router };
