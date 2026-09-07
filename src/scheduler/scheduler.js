/**
 * Unified Resource Scheduler — Simplification Round
 *
 * Flow: Run queued -> ExecutionPlanner (request-specific ResourcePlan, no
 * historical RAM learning) -> LargeJobSharder (splits oversized requests into
 * bounded shard runs) -> pool/lock admission -> RAM admission (physical
 * headroom minus everything already reserved) -> reserve RAM under this
 * attempt's executionToken -> dispatch -> release RAM + pool slot/locks for
 * that exact token in `finally`, regardless of success/failure.
 *
 * Ownership is keyed by executionToken, NOT runId — a retried run's old
 * attempt cannot release (or be confused with) the new attempt's resources.
 */

const { ResourceMonitor } = require('./resource-monitor');
const { WorkerPoolManager } = require('./worker-pool');
const { RunQueue } = require('./run-queue');
const { ExecutionPlanner } = require('./execution-planner');
const { needsSharding, planShards, aggregateShardResults, allShardsTerminal } = require('./job-sharder');
const { issueExecutionToken } = require('../reliability/execution-lease');
const { classifyFailureReason, NO_RETRY_REASON_CODES } = require('../reliability/failure-reason');
const { waitForSettled } = require('../reliability/execution-control');

const APIFY_TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']);

class ResourceScheduler {
  constructor(options = {}) {
    this.monitor = options.monitor || new ResourceMonitor(options.monitorOptions || {});
    this.pools = options.pools || new WorkerPoolManager(options.poolOptions || {});
    this.proxyPool = options.proxyPool || require('../proxy').getProxyPool();
    this.database = options.database || require('../database');
    this.queue = options.queue || new RunQueue(this.database);
    this.planner = options.planner || new ExecutionPlanner(options.plannerOptions || {});
    this.executeRunFn = options.executeRun;
    this.getApifyRunStatus = options.getApifyRunStatus || null;
    // Pluggable executors for non-channel job kinds (user_journey, marketplace_capture, ...).
    // 'channel' defaults to the registry/BackendRouter pipeline in runs.service.js.
    this.executors = { ...(options.executors || {}) };

    this.tickIntervalMs = options.tickIntervalMs || 2000;
    this.timer = null;
    this.isTicking = false;
    this.activeRunMetrics = new Map(); // executionToken -> { runId, startTime, plan, poolName }
    // §5 (Final Architecture Closure Round): tokens whose real work did NOT
    // confirm settlement within the grace period. Their slot/RAM/lock are
    // deliberately NOT released — see dispatchRun() — so a retried Attempt B
    // can never be double-admitted onto a resource A may still physically
    // hold. Exposed via getStatus() as honest, visible resource accounting.
    this.cleanupFailedTokens = new Map(); // executionToken -> { runId, poolName, since }
    this.planFailureCounts = new Map(); // runId -> consecutive planning failures
    this.maxPlanFailures = options.maxPlanFailures || 5;
    // §1.3 (Final Blocker Fix Round): bounded wait for the Execution Control
    // Registry to confirm an attempt's REAL work has settled before this
    // Scheduler releases its worker slot/RAM/lock — see dispatchRun(). Only
    // matters for executions that go through runManaged() (which registers
    // itself); channel-based runs resolve this wait instantly (unregistered
    // tokens are treated as already-settled), so this never slows the common path.
    this.resourceReleaseGraceMs = options.resourceReleaseGraceMs || Number(process.env.RESOURCE_RELEASE_GRACE_MS) || 5000;
  }

  async isApifyActorTerminal(actorRunId) {
    if (typeof this.getApifyRunStatus === 'function') {
      try {
        const status = await this.getApifyRunStatus(actorRunId);
        return APIFY_TERMINAL_STATUSES.has(status);
      } catch (_e) {
        return false;
      }
    }
    try {
      const apifyClient = require('../apify-client');
      const status = await apifyClient.getRunStatus(actorRunId);
      return APIFY_TERMINAL_STATUSES.has(status);
    } catch (_e) {
      return false;
    }
  }

  setExecuteRun(fn) {
    this.executeRunFn = fn;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(err => {
        console.error('[Scheduler] Tick error:', err.message);
      });
    }, this.tickIntervalMs);
    this.timer.unref();
    console.log('[Scheduler] Started resource-aware scheduler ticker');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  determineLocks(plan) {
    const locks = [];
    const options = plan.options || {};
    if (plan.backend === 'cdp') {
      locks.push('cdp:9222');
    }
    if (options.accountId) {
      locks.push(`account:${options.accountId}`);
    }
    return locks;
  }

  async submitRun(runPayload) {
    const queuedRun = this.queue.enqueue(runPayload);
    setImmediate(() => {
      void this.tick().catch(console.error);
    });
    return queuedRun;
  }

  /** Polls until a run (or shard parent) reaches a terminal state — for callers needing a synchronous-looking response. */
  async waitForCompletion(runId, { pollMs = 500, timeoutMs = 300000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = this.queue.getById(runId);
      if (run && ['done', 'failed', 'stuck'].includes(run.status)) return run;
      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms`);
  }

  /**
   * Live-Readiness Round #9 / Final Stabilization Round #15: a planning
   * failure caused by missing/invalid CONFIGURATION (no token, unsupported
   * platform, disabled channel, invalid backend) is deterministic — retrying
   * it 5 times every 2 seconds cannot ever succeed and is just busy-retry
   * spam. classifyFailureReason() distinguishes that from a genuinely
   * transient/dependency-down failure, which still gets bounded retry/backoff.
   */
  isDeterministicConfigFailure(err) {
    return NO_RETRY_REASON_CODES.has(classifyFailureReason(err));
  }

  handlePlanningFailure(run, err) {
    const reasonCode = classifyFailureReason(err);

    if (NO_RETRY_REASON_CODES.has(reasonCode)) {
      console.warn(`[Scheduler] Run #${run.id} (${run.platform}) ${reasonCode} (no retry spam): ${err.message}`);
      this.queue.markFailed(run.id, `${reasonCode}: ${err.message}`);
      this.planFailureCounts.delete(run.id);
      return;
    }

    // DEPENDENCY_DOWN / TRANSIENT_BACKEND_FAILURE: bounded retry/backoff — the
    // dependency (SearXNG/CDP/network) may come back within a few ticks.
    const failures = (this.planFailureCounts.get(run.id) || 0) + 1;
    this.planFailureCounts.set(run.id, failures);

    if (failures >= this.maxPlanFailures) {
      console.error(`[Scheduler] Run #${run.id} (${run.platform}) failed planning ${failures} times (${reasonCode}), marking failed:`, err.message);
      this.queue.markFailed(run.id, `${reasonCode}: ${err.message}`);
      this.planFailureCounts.delete(run.id);
    } else {
      console.warn(`[Scheduler] ${reasonCode} planning failure for run #${run.id} (${run.platform}), attempt ${failures}/${this.maxPlanFailures}: ${err.message}`);
    }
  }

  /** Splits an oversized run into child shard runs and parks the parent as 'sharded'. Returns true if sharding happened. */
  shardIfNeeded(run, plan) {
    if (!needsSharding(plan)) return false;

    const shards = planShards(run, plan);
    for (const shard of shards) {
      this.database.createRun({
        platform: run.platform,
        query: run.query,
        maxItems: shard.maxItems,
        options: { ...plan.options, jobKind: plan.jobKind, maxItems: shard.maxItems, offset: shard.offset, shardIndex: shard.shardIndex, shardCount: shard.shardCount },
        parentRunId: run.id
      });
    }
    this.database.updateRun(run.id, { status: 'sharded' });
    console.log(`[Scheduler] Run #${run.id} (${run.platform}) split into ${shards.length} shards (shardSize=${plan.shardSize})`);
    return true;
  }

  /** Aggregates any parent runs whose shards have all finished. Called every tick. */
  reconcileShardedParents() {
    const parents = this.database.getRunsByStatus ? this.database.getRunsByStatus('sharded') : [];
    for (const parent of parents) {
      const children = this.database.getChildRuns ? this.database.getChildRuns(parent.id) : [];
      if (!allShardsTerminal(children)) continue;
      const summary = aggregateShardResults(children);
      const finalStatus = summary.doneShards > 0 ? 'done' : 'failed';
      this.database.updateRun(parent.id, {
        status: finalStatus,
        itemsCount: summary.itemsCount,
        newCount: summary.newCount,
        activeCount: summary.activeCount,
        droppedCount: summary.droppedCount,
        errorMessage: finalStatus === 'failed' ? `All ${summary.totalShards} shards failed` : null
      });
    }
  }

  async tick() {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      this.reconcileShardedParents();

      const ramSnapshot = this.monitor.getSnapshot();
      if (ramSnapshot.state === 'RED') {
        return; // Strict admission block under critical memory pressure.
      }

      const candidates = this.queue.peek(20);
      if (!candidates || candidates.length === 0) return;

      for (const run of candidates) {
        let plan;
        try {
          plan = await this.planner.plan(run);
        } catch (err) {
          this.handlePlanningFailure(run, err);
          continue;
        }
        this.planFailureCounts.delete(run.id);

        if (this.shardIfNeeded(run, plan)) {
          continue; // Parent parked as 'sharded'; its children will be admitted on their own in subsequent ticks.
        }

        // Gap #1 closure, Layer 2 (defense-in-depth): WorkerPoolManager.canAdmit()
        // only checks pool-level capacity/locks — it has no concept of runId,
        // so it cannot by itself stop a retry from landing in a DIFFERENT free
        // slot in the same pool while an earlier, unsettled attempt for this
        // exact runId still occupies another slot. activeRunMetrics/
        // cleanupFailedTokens are only cleared once a token's resources are
        // actually released (post-confirmed-settlement — see dispatchRun()),
        // so checking them by runId here is authoritative regardless of pool
        // concurrency, independent of whatever gated (or failed to gate) the
        // Run's DB status becoming 'queued' in the first place.
        const hasLiveAttempt = Array.from(this.activeRunMetrics.values()).some((m) => m.runId === run.id)
          || Array.from(this.cleanupFailedTokens.values()).some((m) => m.runId === run.id);
        if (hasLiveAttempt) {
          continue; // Hold in queue: an unsettled attempt for this runId already exists somewhere in the pool.
        }

        // Gap #4 closure (Final Small-Gap Closure Round): block Apify retry
        // while an old remote Actor run is still active. If an earlier attempt
        // launched an Apify actor, do NOT start Actor B until Actor A is
        // confirmed terminal (SUCCEEDED, FAILED, ABORTED, TIMED-OUT).
        let externalExecution = null;
        try {
          externalExecution = typeof run.external_execution_json === 'string'
            ? JSON.parse(run.external_execution_json)
            : run.external_execution_json;
        } catch (_e) {}

        if (externalExecution && externalExecution.executionClass === 'CLOUD_API' && externalExecution.externalExecutionId) {
          const isTerminal = await this.isApifyActorTerminal(externalExecution.externalExecutionId);
          if (!isTerminal) {
            continue; // Hold in queue: previous remote Apify actor is still active or unconfirmed
          }
        }

        const poolName = plan.pool;
        const requiredLocks = this.determineLocks(plan);
        const attempt = Number(plan.options.attempt || 1);
        const executionToken = issueExecutionToken(run.id, attempt);
        const isElastic = this.pools.isElastic(poolName);

        const poolCheck = this.pools.canAdmit(poolName, requiredLocks, executionToken, isElastic);
        if (!poolCheck.allowed) {
          continue; // Slot or lock unavailable, hold in queue.
        }

        const ramCheck = this.monitor.canAdmit(plan.estimatedEnvelopeMB);
        if (!ramCheck.allowed) {
          if (ramCheck.reason === 'SYSTEM_MEMORY_CRITICAL_RED') break;
          if (ramCheck.reason === 'RAM_HEADROOM_EXHAUSTED_YELLOW') continue; // YELLOW: no new admissions, but other pools' candidates still get evaluated.
          break; // Insufficient headroom for this specific request.
        }

        const slotAcquired = this.pools.acquireSlot(poolName, executionToken, isElastic);
        if (!slotAcquired) continue;

        let allLocksAcquired = true;
        for (const lk of requiredLocks) {
          if (!this.pools.acquireLock(lk, executionToken)) {
            allLocksAcquired = false;
            break;
          }
        }

        if (!allLocksAcquired) {
          this.pools.releaseAllForToken(executionToken);
          continue;
        }

        this.monitor.reserve(executionToken, plan.estimatedEnvelopeMB);
        this.dispatchRun(run, plan, poolName, executionToken, attempt);
      }
    } finally {
      this.isTicking = false;
    }
  }

  dispatchRun(run, plan, poolName, executionToken, attempt) {
    const startTime = Date.now();
    const dispatchOptions = { ...plan.options, backend: plan.backend, mode: plan.mode, executionClass: plan.executionClass, attempt, executionToken };

    this.activeRunMetrics.set(executionToken, {
      runId: run.id,
      startTime,
      platform: plan.platform,
      backend: plan.backend,
      executionClass: plan.executionClass,
      poolName,
      estimatedEnvelopeMB: plan.estimatedEnvelopeMB
    });

    this.queue.markRunning(run.id, {
      activeBackend: plan.backend,
      inputOptions: JSON.stringify(dispatchOptions)
    });

    const executeFn = this.executors[plan.jobKind] || this.executeRunFn || require('../runs.service').executeRun;

    Promise.resolve(executeFn(run.id, plan.platform, run.query, dispatchOptions))
      .catch((err) => {
        console.error(`[Scheduler] Run #${run.id} (${plan.platform}) failed in execution:`, err.message);
      })
      .finally(async () => {
        // §13 (Final Architecture Closure Round): activeRunMetrics must not
        // be cleared until the resource is ACTUALLY about to be released
        // (below) — clearing it here, before settlement is confirmed, would
        // make getStatus()/assertSystemInvariants() report this token as
        // "not active" while its slot/RAM/lock are still genuinely held,
        // an orphan by omission even during the normal happy path.
        // §1.3: executeFn's promise settling (e.g. a ManagedExecution timeout
        // rejecting at ~timeoutMs) is NOT proof the real underlying work
        // (browser/network call) has actually stopped — releasing the
        // slot/RAM/lock here immediately would let a new Attempt B be
        // admitted into the same resource while A might still be using it.
        // Wait (bounded) for the Execution Control Registry to confirm real
        // settlement first. A no-op for channel-based runs (unregistered
        // tokens resolve instantly).
        let settled = await waitForSettled(executionToken, this.resourceReleaseGraceMs);
        if (!settled) {
          // §5 CRITICAL: the grace period elapsed with no confirmation that
          // A's real work actually stopped. Releasing the slot/RAM/lock here
          // would let a retried Attempt B be admitted onto a resource A may
          // still physically hold (browser/CDP process, in-flight fetch).
          // Keep the reservation, record the failure honestly, and keep
          // waiting (unbounded — this is a diagnostic hold, not a deadlock:
          // the tick loop and every other token are unaffected) until real
          // settlement is confirmed.
          console.error(`[Scheduler] RECOVERY_CLEANUP_FAILED: execution ${executionToken} (run #${run.id}, pool ${poolName}) did not confirm settlement within ${this.resourceReleaseGraceMs}ms. Resource retained — no release, no re-admission until settlement is confirmed.`);
          this.cleanupFailedTokens.set(executionToken, { runId: run.id, poolName, since: Date.now() });
          while (!settled) {
            settled = await waitForSettled(executionToken, this.resourceReleaseGraceMs);
          }
          this.cleanupFailedTokens.delete(executionToken);
          console.warn(`[Scheduler] Execution ${executionToken} (run #${run.id}) confirmed settled late — releasing its resources now.`);
        }
        // Release ONLY this attempt's resources. If a newer attempt for the
        // same runId is already running under a different executionToken, its
        // slot/lock/RAM reservation is untouched.
        this.activeRunMetrics.delete(executionToken);
        this.pools.releaseAllForToken(executionToken);
        this.monitor.release(executionToken);
        if (this.proxyPool && typeof this.proxyPool.release === 'function') {
          this.proxyPool.release(executionToken);
        }
        setImmediate(() => {
          void this.tick().catch(console.error);
        });
      });
  }

  getStatus() {
    return {
      scheduler: {
        activeTicker: this.timer !== null,
        tickIntervalMs: this.tickIntervalMs
      },
      ram: this.monitor.getSnapshot(),
      queue: this.queue.countByStatus(),
      pools: this.pools.getStatus(),
      proxies: this.proxyPool ? this.proxyPool.getStatus() : null,
      cleanupFailed: Array.from(this.cleanupFailedTokens.entries()).map(([token, meta]) => ({
        executionToken: token,
        ...meta,
        heldForMs: Date.now() - meta.since
      })),
      activeExecutions: Array.from(this.activeRunMetrics.entries()).map(([token, meta]) => ({
        executionToken: token,
        ...meta,
        elapsedMs: Date.now() - meta.startTime
      }))
    };
  }
}

let globalScheduler = null;

function getScheduler(options = {}) {
  if (!globalScheduler) {
    globalScheduler = new ResourceScheduler(options);
  }
  return globalScheduler;
}

module.exports = { ResourceScheduler, getScheduler };
