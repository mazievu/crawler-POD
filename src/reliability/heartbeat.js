/**
 * Heartbeat & Run Progress Tracker
 *
 * Two distinct signals, tracked separately (Simplification Round #10):
 *  - lastHeartbeatAt: the execution process is still alive. Ticks on a real
 *    periodic timer (default 30s) REGARDLESS of whether the stage/progress
 *    changed — a backend can legitimately sit in one stage (e.g. polling an
 *    Apify job) for minutes without that being a sign of death.
 *  - lastProgressAt: the work actually advanced (setStage/progress call).
 *
 * Both signals live IN MEMORY on every beat/progress call — StuckDetector
 * reads them via getActiveHeartbeats(), never via the DB (Final Implementation
 * Closure §1). DB persistence (health_snapshot on the `runs` row) is a much
 * slower, THROTTLED side effect (§2): every beat()/progress() used to call
 * db.updateRun() (SQLite write + WAL activity) on every tick, which is far
 * more DB traffic than the diagnostic value it provides. Now:
 *   - beat()/progress() update memory immediately, and flush to DB only when
 *     HEARTBEAT_DB_FLUSH_MS (default 10 min) has elapsed since the last flush;
 *   - setStage() (stage transitions, including terminal COMPLETED/FAILED)
 *     always force-flushes immediately — those are the moments worth seeing
 *     in the DB right away;
 *   - forceFlush() is available for an explicit diagnostic flush.
 */

const { isCurrentOwner } = require('./execution-lease');

const STAGES = {
  INIT: 'INIT',
  ROUTING: 'ROUTING',
  SCRAPING: 'SCRAPING',
  NORMALIZING: 'NORMALIZING',
  PERSISTING: 'PERSISTING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
};

class HeartbeatTracker {
  constructor(runId, database = null, options = {}) {
    this.runId = runId;
    // Live-Readiness Round #10: identity carried alongside runId so a stale
    // attempt A can never be confused with a newer attempt B for the same run.
    this.executionToken = options.executionToken || null;
    this.attempt = options.attempt || 1;
    this.db = database || require('../database');
    this.startedAt = Date.now();
    this.lastProgressAt = Date.now();
    this.lastHeartbeatAt = Date.now();
    this.lastDbFlushAt = 0; // forces the very first persist() call to actually write
    this.stage = STAGES.INIT;
    this.itemsCollected = 0;
    this.metadata = {};
    this.executionClass = options.executionClass || null;

    const intervalMs = options.heartbeatIntervalMs || Number(process.env.HEARTBEAT_INTERVAL_MS) || 30000;
    this.dbFlushIntervalMs = options.dbFlushIntervalMs || Number(process.env.HEARTBEAT_DB_FLUSH_MS) || 600000;
    this.timer = setInterval(() => this.beat(), intervalMs);
    this.timer.unref();
  }

  /** Proves the process is still alive, independent of whether work progressed. Memory-only unless the DB flush interval is due. */
  beat() {
    this.lastHeartbeatAt = Date.now();
    this.maybeFlush();
  }

  /** Stage transitions (including terminal COMPLETED/FAILED) always force an immediate DB write. */
  setStage(stage, extra = {}) {
    this.stage = stage;
    this.lastProgressAt = Date.now();
    this.lastHeartbeatAt = Date.now();
    this.metadata = { ...this.metadata, ...extra };
    this.persist();
  }

  /** Forward-progress signal. Memory-only unless the DB flush interval is due — do not write SQLite once per item. */
  progress(itemCount = null, extra = {}) {
    this.lastProgressAt = Date.now();
    this.lastHeartbeatAt = Date.now();
    if (typeof itemCount === 'number') this.itemsCollected = itemCount;
    this.metadata = { ...this.metadata, ...extra };
    this.maybeFlush();
  }

  maybeFlush() {
    if (Date.now() - this.lastDbFlushAt >= this.dbFlushIntervalMs) {
      // Claim the flush window BEFORE persisting. persist() is asynchronous
      // since the PostgreSQL cutover, so it can no longer stamp lastDbFlushAt
      // itself in time: every progress() arriving before the first write
      // resolved would still see the old timestamp and start another write,
      // defeating the throttle and hammering the database.
      this.lastDbFlushAt = Date.now();
      this.persist();
    }
  }

  /** Explicit forced diagnostic flush, bypassing the throttle interval. */
  forceFlush() {
    this.persist();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot() {
    const now = Date.now();
    return {
      runId: this.runId,
      executionToken: this.executionToken,
      attempt: this.attempt,
      stage: this.stage,
      executionClass: this.executionClass,
      startedAt: new Date(this.startedAt).toISOString(),
      lastProgressAt: new Date(this.lastProgressAt).toISOString(),
      lastHeartbeatAt: new Date(this.lastHeartbeatAt).toISOString(),
      elapsedMs: now - this.startedAt,
      idleSinceProgressMs: now - this.lastProgressAt,
      idleSinceHeartbeatMs: now - this.lastHeartbeatAt,
      itemsCollected: this.itemsCollected,
      metadata: this.metadata
    };
  }

  async persist() {
    try {
      if (!this.db || typeof this.db.updateRun !== 'function') return;
      // Final Stabilization Round #10: a stale attempt A (superseded by a
      // newer attempt B for the same runId, e.g. after stuck-detector
      // recovery) must never overwrite B's live health_snapshot with its own
      // outdated one. Same ownership check the execution-lease write path
      // already uses for business writes.
      // isCurrentOwner is async now that the database is PostgreSQL-backed.
      // Without the await, `!Promise` is always false and this guard silently
      // stops blocking — a stale attempt would overwrite the current owner's
      // health_snapshot.
      if (this.executionToken && !(await isCurrentOwner(this.db, this.runId, this.executionToken))) {
        this.stop();
        return;
      }
      await this.db.updateRun(this.runId, {
        healthSnapshot: JSON.stringify(this.getSnapshot())
      });
      this.lastDbFlushAt = Date.now();
    } catch (_e) {}
  }
}

// Live-Readiness Round #10: keyed by executionToken, NOT runId. Two attempts
// of the same run (retry, stuck-recovery) get distinct tokens and therefore
// coexist as fully separate tracker entries — a stale attempt A finishing
// late calls removeTracker(A's token), which cannot touch B's entry.
const activeTrackers = new Map();

function trackerKey(executionToken, runId) {
  // Fall back to runId only for legacy callers that never got a lease token
  // (keeps backward compatibility instead of silently losing the heartbeat).
  return executionToken || `legacy-run-${runId}`;
}

function getOrCreateTracker(runId, database = null, options = {}) {
  const key = trackerKey(options.executionToken, runId);
  if (!activeTrackers.has(key)) {
    activeTrackers.set(key, new HeartbeatTracker(runId, database, options));
  }
  return activeTrackers.get(key);
}

/** Removes exactly the tracker owned by this executionToken. Never affects a sibling attempt of the same runId. */
function removeTracker(executionToken) {
  const tracker = activeTrackers.get(executionToken);
  if (tracker) tracker.stop();
  activeTrackers.delete(executionToken);
}

/** Final Implementation Closure §1C: StuckDetector reads THIS in-memory registry, never the DB — DB flush throttling must never affect detection freshness. */
function getActiveHeartbeats() {
  return Array.from(activeTrackers.values()).map(t => t.getSnapshot());
}

module.exports = {
  STAGES,
  HeartbeatTracker,
  getOrCreateTracker,
  removeTracker,
  getActiveHeartbeats,
  trackerKey
};
