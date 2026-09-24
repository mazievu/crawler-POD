/**
 * Monitoring Dispatcher (Milestone 5 - Feature F23 to F27)
 *
 * Coordinates monitoring job lifecycle, admission gating via ResourceScheduler,
 * global concurrency limiting via MonitoringLimiter, and graceful shutdown.
 * Adheres strictly to docs/DISCOVERY_MONITORING_PLAN_REVISED.md §6, §8, §10.
 */

const crypto = require('crypto');
const { MonitoringLimiter } = require('./limiter');

/**
 * Races a capture promise against an AbortSignal so that a capture which
 * ignores the signal (e.g. a hung browser) can never keep executeJob — and
 * with it the heartbeat interval and the process — alive after shutdown.
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new Error(`Capture aborted: ${signal.reason || 'aborted'}`));
  }
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(new Error(`Capture aborted: ${signal.reason || 'aborted'}`));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

function parseMonitoringFlag(val) {
  if (val === undefined || val === null) return false;
  const str = String(val).trim().toLowerCase();
  return str === 'true' || str === '1';
}

class MonitoringDispatcher {
  /**
   * @param {object} [options]
   * @param {object} [options.db] - Database handle
   * @param {object} [options.scheduler] - ResourceScheduler instance
   * @param {MonitoringLimiter} [options.limiter] - Limiter instance
   * @param {boolean|string} [options.enabled] - Feature flag override
   * @param {number} [options.tickIntervalMs=300000] - Ticker interval (default 5 min)
   * @param {number} [options.drainTimeoutMs=10000] - Graceful shutdown drain timeout
   * @param {Function} [options.captureFn] - Pluggable capture function
   */
  constructor(options = {}) {
    this.db = options.db || options.database || require('../database');
    this.scheduler = options.scheduler || null;
    this.limiter = options.limiter || new MonitoringLimiter(this.db);
    this.enabled = this.parseEnabled(options.enabled !== undefined ? options.enabled : process.env.MONITORING_ENABLED);
    this.tickIntervalMs = Number(options.tickIntervalMs) || 300000;
    this.drainTimeoutMs = Number(options.drainTimeoutMs) || 10000;
    this.captureFn = options.captureFn || null;

    this.timer = null;
    this.isTicking = false;
    this.isShuttingDown = false;
    this.activeWorkerToken = null;
    this.activeCapturePromise = null;
    this.activeAbortController = null;
    this.waitTicksByJobId = new Map();
    this.signalHandlersRegistered = false;
  }

  /**
   * Safely parses feature flag boolean value (F27).
   */
  parseEnabled(val) {
    return parseMonitoringFlag(val);
  }

  /**
   * Returns true if dispatcher is enabled and not shutting down.
   */
  canDispatch() {
    return Boolean(this.enabled && !this.isShuttingDown);
  }

  /**
   * Starts periodic tick timer.
   */
  start() {
    if (!this.enabled) {
      console.log('[MonitoringDispatcher] Dormant (MONITORING_ENABLED=false)');
      return;
    }
    if (this.timer) return;
    this.registerSignalHandlers();
    this.timer = setInterval(() => {
      void this.tick().catch(err => {
        console.error('[MonitoringDispatcher] Tick error:', err.message);
      });
    }, this.tickIntervalMs);
    this.timer.unref();
    console.log(`[MonitoringDispatcher] Started periodic ticker (${this.tickIntervalMs}ms)`);
  }

  /**
   * Stops periodic tick timer.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  registerSignalHandlers() {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;
    const onSig = (sig) => {
      void this.shutdown(sig).catch(console.error);
    };
    process.once('SIGINT', () => onSig('SIGINT'));
    process.once('SIGTERM', () => onSig('SIGTERM'));
  }

  /**
   * Main dispatch tick:
   * 1. Run expiry check (expireDueEntities).
   * 2. Check limiter.canExecuteNext(). If false, return.
   * 3. Claim next job via claimNextDueMonitoringJob.
   * 4. Acquire limiter lease via limiter.tryAcquireLease.
   * 5. Check scheduler admission via scheduler.canAdmitMonitoringCapture().
   * 6. Execute capture, immediately release browser slot, apply observation, complete job.
   * 7. Release limiter lease with 20000ms cooldown.
   */
  async tick() {
    if (!this.canDispatch() || this.isTicking) return;
    this.isTicking = true;

    try {
      const {
        expireDueEntities,
        recoverExpiredMonitoringJobs,
        claimNextDueMonitoringJob,
      } = require('../database/monitoring');

      // 1. Expiry check sweep
      try {
        await expireDueEntities(this.db);
      } catch (err) {
        console.warn('[MonitoringDispatcher] Expiry check warning:', err.message);
      }

      // Also sweep orphaned expired worker claims
      try {
        await recoverExpiredMonitoringJobs(this.db);
      } catch (_e) {}

      // 2. Check global limiter availability and cooldown
      const canExec = await this.limiter.canExecuteNext();
      if (!canExec) return;

      // 3. Claim next ready monitoring job
      const workerToken = `mon-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
      const job = await claimNextDueMonitoringJob(this.db, { workerToken, leaseDurationMs: 60000 });
      if (!job) return;

      // 4. Atomically acquire global limiter lease
      const lease = await this.limiter.tryAcquireLease(workerToken, 60000);
      if (!lease) {
        // Yield job back to queued state
        await this.db.query(
          "UPDATE monitoring_jobs SET status = 'queued', claim_token = NULL, claimed_until = NULL WHERE id = $1 AND claim_token = $2",
          [job.id, workerToken]
        );
        return;
      }

      // 5. Evaluate scheduler admission gate (RAM, Discovery priority & starvation fairness)
      const waitTicks = this.waitTicksByJobId.get(job.id) || 0;
      if (this.scheduler && typeof this.scheduler.canAdmitMonitoringCapture === 'function') {
        const admission = await this.scheduler.canAdmitMonitoringCapture(waitTicks);
        if (!admission.allowed) {
          // Increment waitTicks for starvation fairness aging (F23.B5)
          this.waitTicksByJobId.set(job.id, waitTicks + 1);
          // Release limiter lease with 0 cooldown so we don't stall other processes
          await this.limiter.releaseLease(workerToken, 0);
          // Yield job back to queued
          await this.db.query(
            "UPDATE monitoring_jobs SET status = 'queued', claim_token = NULL, claimed_until = NULL WHERE id = $1 AND claim_token = $2",
            [job.id, workerToken]
          );
          return;
        }
      }
      this.waitTicksByJobId.delete(job.id);

      // 6. Execute capture with resource isolation & immediate slot release
      this.activeWorkerToken = workerToken;
      this.activeAbortController = new AbortController();
      this.activeCapturePromise = this.executeJob(job, workerToken, this.activeAbortController.signal);
      await this.activeCapturePromise;

    } catch (err) {
      console.error('[MonitoringDispatcher] Tick error:', err.message);
    } finally {
      this.activeWorkerToken = null;
      this.activeCapturePromise = null;
      this.activeAbortController = null;
      this.isTicking = false;
    }
  }

  /**
   * Executes capture for a single claimed job.
   */
  async executeJob(job, workerToken, signal) {
    const {
      completeMonitoringJob,
      failMonitoringJob,
      applyShopObservation,
      applyMonitoringObservation,
      createMonitoringOps,
    } = require('../database/monitoring');

    const monitoringOps = createMonitoringOps(this.db);

    let browserSlotAcquired = false;
    let captureSuccess = false;
    let captureResult = null;
    let captureError = null;

    // Heartbeat renewal interval for slow captures
    const heartbeat = setInterval(() => {
      this.limiter.renewLease(workerToken, 60000).catch(() => {});
      if (monitoringOps.renewJobLease) {
        monitoringOps.renewJobLease(job.id, workerToken, 60000).catch(() => {});
      }
    }, 15000);
    // The heartbeat must never be the only thing keeping the process alive.
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      // Acquire browser pool slot if scheduler pools are available
      if (this.scheduler && this.scheduler.pools && typeof this.scheduler.pools.acquireSlot === 'function') {
        browserSlotAcquired = this.scheduler.pools.acquireSlot('BROWSER', workerToken);
      }

      // Execute capture via pluggable runner or default fallback
      try {
        const capturePromise = typeof this.captureFn === 'function'
          ? Promise.resolve().then(() => this.captureFn(job, { signal, workerToken }))
          : Promise.resolve().then(() => this.defaultCapture(job, { signal }));
        captureResult = await raceAbort(capturePromise, signal);
        captureSuccess = Boolean(captureResult && captureResult.status !== 'failed');
      } catch (err) {
        captureSuccess = false;
        captureError = err;
      }

    } finally {
      // Stop heartbeat
      clearInterval(heartbeat);

      // F24.5: Release browser slot IMMEDIATELY upon capture completion,
      // without waiting through observation application or the 20s cooldown delay!
      if (browserSlotAcquired && this.scheduler && this.scheduler.pools) {
        try {
          this.scheduler.pools.releaseSlot('BROWSER', workerToken);
        } catch (_e) {}
        browserSlotAcquired = false;
      }
    }

    try {
      if (captureSuccess) {
        // Verify lease still valid before writing
        if (monitoringOps.verifyJobClaim) {
          const jobStillMine = await monitoringOps.verifyJobClaim(job.id, workerToken);
          if (!jobStillMine) {
            console.warn(`[MonitoringDispatcher] Lost lease on job ${job.id}, aborting write`);
            return; // Don't write, don't complete, don't fail — lease was revoked
          }
        }

        try {
          // Apply observation if payload exists
          if (job.kind === 'shop_probe' && job.entity_id && captureResult?.value !== undefined && captureResult?.value !== null) {
            await applyShopObservation(this.db, job.entity_id, {
              value: captureResult.value,
              observedAt: captureResult.observedAt || new Date().toISOString(),
              quality: captureResult.quality || 'exact',
            });
          } else if (job.kind === 'item_refresh' && job.item_id && captureResult?.patch) {
            const item = await monitoringOps.getMonitoringItemById(job.item_id);
            if (item && item.item_uid) {
              const obsId = captureResult.observationId || `obs-${job.id}-${Date.now()}`;
              await applyMonitoringObservation(this.db, {
                itemUid: item.item_uid,
                patch: captureResult.patch,
                metadata: { observationId: obsId },
              });
            }
          }

          const observationId = captureResult?.observationId || `obs-completed-${job.id}-${Date.now()}`;
          await completeMonitoringJob(this.db, {
            jobId: job.id,
            claimToken: workerToken,
            observationId,
          });

        } catch (e) {
          console.warn('[MonitoringDispatcher] Observation write error:', e.message);
          await failMonitoringJob(this.db, {
            jobId: job.id,
            claimToken: workerToken,
            error: e,
            isRetryable: true,
          });
        }
      } else {
        const error = captureError || new Error(captureResult?.error || 'Capture returned failure');
        const isRetryable = captureResult?.isRetryable !== false;
        await failMonitoringJob(this.db, {
          jobId: job.id,
          claimToken: workerToken,
          error,
          isRetryable,
        });
      }
    } finally {
      // Release limiter lease with 20000ms cooldown (or 0 cooldown if shutting down)
      try {
        const cooldown = this.isShuttingDown ? 0 : 20000;
        await this.limiter.releaseLease(workerToken, cooldown);
      } catch (_e) {}
    }
  }

  /**
   * Default capture implementation when no external runner is supplied.
   */
  async defaultCapture(_job, _ctx) {
    return {
      status: 'success',
      observedAt: new Date().toISOString(),
      value: null,
      quality: 'exact',
    };
  }

  /**
   * Graceful shutdown protocol (Feature F26):
   * 1. Intercept signal, set isShuttingDown = true, stop timers.
   * 2. Bounded drain on active capture promise up to timeoutMs.
   * 3. Cleanly release limiter lease with cooldownMs = 0.
   */
  async shutdown(signal = 'SIGINT', timeoutMs = this.drainTimeoutMs) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.stop();

    const actualTimeout = Number(timeoutMs) || this.drainTimeoutMs;
    console.log(`[MonitoringDispatcher] Graceful shutdown on ${signal} (drain timeout: ${actualTimeout}ms)...`);

    const workerTokenToRelease = this.activeWorkerToken;

    if (this.activeCapturePromise) {
      let timer;
      const drainPromise = new Promise((resolve) => {
        timer = setTimeout(resolve, actualTimeout);
      });
      await Promise.race([this.activeCapturePromise, drainPromise]);
      if (timer) clearTimeout(timer);

      if (this.activeAbortController) {
        try {
          this.activeAbortController.abort(`Shutdown on ${signal}`);
        } catch (_e) {}
      }
    }

    const tokenToClean = this.activeWorkerToken || workerTokenToRelease;
    if (tokenToClean) {
      try {
        await this.limiter.releaseLease(tokenToClean, 0);
        console.log('[MonitoringDispatcher] Limiter lease cleanly released with 0 cooldown.');
      } catch (err) {
        console.error('[MonitoringDispatcher] Error releasing limiter lease on shutdown:', err.message);
      }
    }

    console.log(`[MonitoringDispatcher] Graceful shutdown completed.`);
  }
}

module.exports = {
  MonitoringDispatcher,
  parseMonitoringFlag,
};
