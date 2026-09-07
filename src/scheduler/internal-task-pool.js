/**
 * InternalTaskPool — Bounded concurrent worker queue for processing
 * independent tasks within a single Run.
 *
 * Pattern: worker-queue with dynamic refill (NOT batch-wait).
 *   N slots → each slot pulls the next task as soon as it finishes.
 *   P1 done → P5 fills immediately, no waiting for P2/P3/P4.
 *
 * Failure isolation: uses Promise.allSettled semantics — one task
 * failing does not abort siblings. Caller receives full results
 * with { status: 'fulfilled', value } or { status: 'rejected', reason }.
 *
 * Usage:
 *   const pool = new InternalTaskPool({ concurrency: 4, signal });
 *   const results = await pool.run(productUrls, async (url, index) => {
 *     return await processProduct(url);
 *   });
 *   // results = [{ status, value/reason }, ...]
 */

class InternalTaskPool {
  /**
   * @param {object} options
   * @param {number} options.concurrency — max simultaneous tasks (default 1 = sequential)
   * @param {AbortSignal} [options.signal] — abort signal to stop accepting new tasks
   * @param {function} [options.onTaskComplete] — callback(index, value) on each success
   * @param {function} [options.onTaskError] — callback(index, error) on each failure
   */
  constructor({
    concurrency = 1,
    signal = null,
    onTaskComplete = null,
    onTaskError = null
  } = {}) {
    this.concurrency = Math.max(1, Math.round(concurrency));
    this.signal = signal;
    this.onTaskComplete = onTaskComplete;
    this.onTaskError = onTaskError;
  }

  /**
   * Execute `fn(item, index)` for every item in `items`, with at most
   * `this.concurrency` tasks running simultaneously.
   *
   * Returns an array parallel to `items` with settled results:
   *   [{ status: 'fulfilled', value }, { status: 'rejected', reason }, ...]
   *
   * @param {Array} items — work items to process
   * @param {function} fn — async (item, index) => result
   * @returns {Promise<Array<{status: string, value?: any, reason?: any}>>}
   */
  async run(items, fn) {
    if (!items || items.length === 0) return [];

    const results = new Array(items.length);
    let nextIndex = 0;

    let fatalError = null; // STALE_EXECUTION — must propagate to caller

    const runWorker = async () => {
      while (nextIndex < items.length) {
        if (this.signal?.aborted || fatalError) break;

        const idx = nextIndex++;
        const item = items[idx];

        try {
          const value = await fn(item, idx);
          results[idx] = { status: 'fulfilled', value };
          if (this.onTaskComplete) {
            try { this.onTaskComplete(idx, value); } catch (_) { /* callback error ignored */ }
          }
        } catch (err) {
          // STALE_EXECUTION must propagate — it means the run's lease was
          // revoked and no further work should happen at all.
          if (/STALE_EXECUTION/.test(err.message || '')) {
            fatalError = err;
            break; // stop this worker; other workers check fatalError next iteration
          }

          results[idx] = { status: 'rejected', reason: err };
          if (this.onTaskError) {
            try { this.onTaskError(idx, err); } catch (_) { /* callback error ignored */ }
          }
        }
      }
    };

    // Launch N workers — each pulls tasks from the shared index counter.
    // Dynamic refill: a worker that finishes task P1 immediately grabs
    // the next available task (P5), no batch-wait.
    const workers = [];
    const workerCount = Math.min(this.concurrency, items.length);
    for (let w = 0; w < workerCount; w++) {
      workers.push(runWorker());
    }

    await Promise.allSettled(workers);

    // STALE_EXECUTION: re-throw after all workers have settled
    if (fatalError) throw fatalError;

    // Fill any indices that were skipped due to abort
    for (let i = 0; i < results.length; i++) {
      if (!results[i]) {
        results[i] = { status: 'rejected', reason: new Error('ABORTED') };
      }
    }

    return results;
  }

  /**
   * Convenience: run() but return only fulfilled values, filtering out failures.
   * @param {Array} items
   * @param {function} fn
   * @returns {Promise<Array>} — only successful results (order not guaranteed to match input)
   */
  async runCollect(items, fn) {
    const results = await this.run(items, fn);
    return results
      .filter(r => r.status === 'fulfilled' && r.value != null)
      .map(r => r.value);
  }

  /**
   * Summary stats from a settled results array.
   * @param {Array} results — from run()
   * @returns {{ total: number, fulfilled: number, rejected: number, aborted: number }}
   */
  static summarize(results) {
    let fulfilled = 0, rejected = 0, aborted = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') fulfilled++;
      else if (r.reason?.message === 'ABORTED') aborted++;
      else rejected++;
    }
    return { total: results.length, fulfilled, rejected, aborted };
  }
}

// ==================== Dynamic Concurrency Computation ====================

/**
 * Per-task cost estimates (MB) by execution class.
 * Browser page ≈ 80-120MB, HTTP request ≈ 5-10MB, pure compute ≈ ~0.
 *
 * Configurable via environment variables.
 */
const DEFAULT_TASK_COST_MB = {
  BROWSER: Number(process.env.TASK_COST_BROWSER_MB) || 100,
  CDP:     Number(process.env.TASK_COST_CDP_MB)     || 100,
  LOCAL_HTTP: Number(process.env.TASK_COST_LOCAL_MB) || 8,
  CLOUD_API:  Number(process.env.TASK_COST_CLOUD_MB) || 5
};

const MAX_INTERNAL_CONCURRENCY = Number(process.env.MAX_INTERNAL_CONCURRENCY) || 4;

/**
 * Compute the optimal internal concurrency for a run, based on:
 *   - Available RAM headroom (from ResourceMonitor snapshot)
 *   - The run's base envelope cost
 *   - Per-task cost for the execution class
 *   - A configurable hard cap (MAX_INTERNAL_CONCURRENCY)
 *
 * @param {object} params
 * @param {string} params.executionClass — BROWSER, CDP, LOCAL_HTTP, CLOUD_API
 * @param {number} params.runBaseCostMB — base envelope for the run (no internal scaling)
 * @param {number} params.effectiveHeadroomMB — from ResourceMonitor.getSnapshot()
 * @param {number} [params.maxConcurrency] — hard cap override
 * @returns {{ concurrency: number, taskCostMB: number, totalEnvelopeMB: number }}
 */
function computeInternalConcurrency({
  executionClass,
  runBaseCostMB,
  effectiveHeadroomMB,
  maxConcurrency = MAX_INTERNAL_CONCURRENCY
}) {
  const taskCostMB = DEFAULT_TASK_COST_MB[executionClass] || DEFAULT_TASK_COST_MB.LOCAL_HTTP;

  // CDP is exclusive (1 port) — never parallelize internally
  if (executionClass === 'CDP') {
    return { concurrency: 1, taskCostMB, totalEnvelopeMB: runBaseCostMB };
  }

  // CLOUD_API — remote actor manages its own concurrency
  if (executionClass === 'CLOUD_API') {
    return { concurrency: 1, taskCostMB, totalEnvelopeMB: runBaseCostMB };
  }

  // How many additional tasks can we fit after the base run cost?
  const availableForTasks = Math.max(0, effectiveHeadroomMB - runBaseCostMB);
  const maxFromRAM = Math.max(1, Math.floor(availableForTasks / taskCostMB));

  const concurrency = Math.min(maxFromRAM, Math.max(1, maxConcurrency));
  const totalEnvelopeMB = runBaseCostMB + (taskCostMB * concurrency);

  return { concurrency, taskCostMB, totalEnvelopeMB };
}

module.exports = { InternalTaskPool, computeInternalConcurrency, DEFAULT_TASK_COST_MB, MAX_INTERNAL_CONCURRENCY };
