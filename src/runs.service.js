const db = require('./database');
const registry = require('./channels/registry');
const { BackendRouter } = require('./router/backend-router');
const { normalizeItems } = require('./normalize');
const { parseConditions, applyConditions, parseMetricSelection, applySelection, OPERATOR_SQL } = require('./filters/metric-conditions');
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

/**
 * input_options is round-tripped through JSON, and two members of the dispatch
 * options cannot survive that: an AbortSignal becomes `{}` and a callback
 * disappears. Everything else — executionToken included — is kept, because
 * execution-lease.js reads the token back out of this column.
 */
function serializableOptions(options) {
  const { signal, reportExternalExecution, ...rest } = options || {};
  return rest;
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

    // Task 3: metric conditions are evaluated HERE — after normalization, so
    // each provider's formatting ("160.23K") is already a number, and before
    // persistence, so a rejected item never reaches product_current or
    // daily_packed_history at all. Filtering in the UI instead would still
    // store everything, and would only ever filter the page the client
    // happened to fetch.
    //
    // With no conditions supplied applyConditions() returns its input
    // untouched, which is the pre-existing behaviour exactly.
    // Ticked-metric crawl filter (options.metrics = ['likes','comments']).
    // "Highest by this metric" needs no operator and no threshold, so a tick
    // becomes: the item must REPORT the metric, and what survives is ordered
    // highest-first. Two ticks means it must report both.
    const { selected: selectedMetrics, invalid: invalidMetrics } = parseMetricSelection(options.metrics);
    if (invalidMetrics.length > 0) {
      console.warn(`Run ${runId}: ignoring ${invalidMetrics.length} unknown metric(s): ${invalidMetrics.join(', ')}`);
    }

    const { conditions: metricConditions, invalid: invalidConditions } = parseConditions(options.conditions);
    if (invalidConditions.length > 0) {
      console.warn(`Run ${runId}: ignoring ${invalidConditions.length} unusable filter condition(s): ${invalidConditions.map((i) => i.reason).join(', ')}`);
    }
    // Thresholds first (if any), then the ticked metrics decide presence and
    // order. Both are AND: an item has to survive each stage.
    const afterConditions = applyConditions(itemsWithImages, metricConditions);
    const afterSelection = applySelection(afterConditions.kept, selectedMetrics);
    const keptItems = afterSelection.kept;
    const rejectedItems = afterConditions.rejected.concat(afterSelection.rejected);

    if (selectedMetrics.length > 0) {
      console.log(`Run ${runId}: crawl filter [highest ${selectedMetrics.join(' + ')}] -> fetched ${itemsWithImages.length}, kept ${keptItems.length}, rejected ${rejectedItems.length}`);
    }

    if (metricConditions.length > 0) {
      const summary = metricConditions.map((c) => `${c.field} ${OPERATOR_SQL[c.operator]} ${c.value}`).join(' AND ');
      console.log(`Run ${runId}: crawl filter [${summary}] -> fetched ${itemsWithImages.length}, kept ${keptItems.length}, rejected ${rejectedItems.length}`);
      for (const rejection of rejectedItems) {
        console.log(`Run ${runId}:   REJECT ${rejection.item.url || rejection.item.uid} — ${rejection.reasons.join('; ')}`);
      }
    }

    tracker.progress(keptItems.length);

    // Guard again immediately before the PERSISTING stage: this is where legacy
    // snapshots, product_current, and daily_packed_history all get written.
    if (!(await assertStillOwner(db, runId, executionToken, 'PRE_PERSIST'))) {
      removeTracker(executionToken);
      return { success: false, runId, discarded: true, reason: 'STALE_EXECUTION' };
    }

    // Save to DB
    tracker.setStage(STAGES.PERSISTING);
    const dbCounts = await db.insertSnapshots(runId, platform, query, keptItems);

    tracker.setStage(STAGES.COMPLETED);
    // The filter outcome is persisted alongside the run so "why did this run
    // store 2 of 5 items" is answerable later from the DB, not only from logs.
    const crawlFilter = (metricConditions.length > 0 || selectedMetrics.length > 0)
      ? {
          conditions: metricConditions,
          metrics: selectedMetrics,
          fetched: itemsWithImages.length,
          kept: keptItems.length,
          rejected: rejectedItems.length,
          rejectedReasons: rejectedItems.map((r) => ({ url: r.item.url || r.item.uid, reasons: r.reasons, values: r.values })),
        }
      : null;

    await db.updateRun(runId, {
      status: 'done',
      ...dbCounts,
      // executionToken MUST survive this write: execution-lease.getRunToken()
      // reads it back out of input_options, and dropping it would make
      // isCurrentOwner() fall through to "nothing has claimed a lease" for
      // every later stale-write check. Only the two non-serializable members
      // are removed (an AbortSignal stringifies to {}, a callback vanishes).
      ...(crawlFilter ? { inputOptions: JSON.stringify({ ...serializableOptions(options), crawlFilter }) } : {}),
    });

    console.log(`Run ${runId} completed via ${result.activeBackend}: ${keptItems.length} items stored (${skippedWithoutImages} skipped for no image, ${rejectedItems.length} rejected by filter, ${dbCounts.newItems} new)`);
    removeTracker(executionToken);
    return { success: true, runId, dbCounts, crawlFilter };
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
