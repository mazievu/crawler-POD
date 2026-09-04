/**
 * Execution Control Registry (Final Blocker Fix Round §1)
 *
 * Problem: StuckDetector can DETECT a dead/stalled execution (via heartbeat)
 * and revoke its DB ownership (executionToken), but it has no way to actually
 * reach into that execution and stop it — it only ever touched the `runs`
 * table and the in-memory heartbeat map. The real workFn (a fetch, a
 * page.goto(), a CDP child process) kept running, possibly still holding a
 * worker slot / RAM reservation / exclusive lock, because the Resource
 * Scheduler only releases those in the ORIGINAL dispatch promise's
 * `.finally()` — which doesn't fire until that promise actually settles.
 *
 * This module is the bridge: whoever OWNS an execution (ManagedExecution)
 * registers its abortController and any cleanup callbacks under its
 * executionToken; whoever wants to STOP an execution from the outside
 * (StuckDetector) calls abortExecution(token) and can wait (bounded) for
 * markExecutionSettled(token) to know cleanup actually finished before
 * treating the resource as free to reallocate.
 *
 * Deliberately minimal — no framework, just a Map keyed by executionToken.
 */

const registry = new Map();

function registerExecution(token, abortController) {
  if (!token) return null;
  const entry = {
    abortController,
    cleanupCallbacks: [],
    settled: false,
    settledWaiters: []
  };
  registry.set(token, entry);
  return entry;
}

function registerCleanup(token, fn) {
  const entry = registry.get(token);
  if (entry && typeof fn === 'function') entry.cleanupCallbacks.push(fn);
}

/**
 * Aborts the execution's signal and runs every registered cleanup callback
 * (best-effort, all in parallel, errors logged not thrown — one cleanup
 * failing must not prevent the others from running). Does NOT itself wait
 * for the execution's owner to finish unwinding its workFn — call
 * waitForSettled() separately for that.
 */
async function abortExecution(token, reason) {
  const entry = registry.get(token);
  if (!entry) return;
  try {
    entry.abortController.abort(reason);
  } catch (_e) { /* already aborted */ }
  await Promise.allSettled(
    entry.cleanupCallbacks.map((fn) =>
      Promise.resolve().then(() => fn(reason)).catch((err) => {
        console.warn(`[ExecutionControl] Cleanup callback failed for ${token}:`, err.message);
      })
    )
  );
}

/** Called by the execution's owner (ManagedExecution) once its workFn has actually finished unwinding. */
function markExecutionSettled(token) {
  const entry = registry.get(token);
  if (!entry) return;
  entry.settled = true;
  const waiters = entry.settledWaiters.splice(0);
  for (const resolve of waiters) resolve(true);
}

function isExecutionSettled(token) {
  const entry = registry.get(token);
  return entry ? entry.settled : true; // unknown/unregistered token: nothing to wait for
}

/**
 * Bounded wait for the execution to report itself settled. Resolves `true`
 * if it settled within timeoutMs, `false` if the grace period elapsed first
 * (the execution may still be physically unresponsive — the caller must not
 * pretend this means it's safe, only that further waiting isn't useful).
 */
function waitForSettled(token, timeoutMs = 5000) {
  const entry = registry.get(token);
  if (!entry || entry.settled) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    entry.settledWaiters.push(finish);
    // Gap #2 closure (Final Small-Gap Closure Round): this timer is what
    // SETTLES the Promise an active `await waitForSettled(...)` depends on —
    // unref()'ing it lets Node consider the event loop empty and exit (or,
    // in a test runner, let the test be reported "cancelled") before the
    // timeout ever fires, leaving the awaited Promise permanently pending.
    // Do NOT unref a timer an active await depends on for correctness (same
    // principle already applied to managed-execution.js's own timeoutPromise).
    setTimeout(() => finish(false), timeoutMs);
  });
}

function unregisterExecution(token) {
  registry.delete(token);
}

function getRegisteredExecutionCount() {
  return registry.size;
}

module.exports = {
  registerExecution,
  registerCleanup,
  abortExecution,
  markExecutionSettled,
  isExecutionSettled,
  waitForSettled,
  unregisterExecution,
  getRegisteredExecutionCount
};
