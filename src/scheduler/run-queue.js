const db = require('../database');

class RunQueue {
  constructor(database = db) {
    this.db = database;
  }

  enqueue(runPayload) {
    if (!runPayload || !runPayload.platform) {
      throw new Error('Run payload with platform is required');
    }

    let runId = runPayload.id;
    if (!runId) {
      const newRun = this.db.createRun({
        platform: runPayload.platform,
        query: runPayload.query || 'search',
        maxItems: runPayload.maxItems || 50,
        country: runPayload.country || null,
        options: runPayload.options || {}
      });
      runId = newRun.id;
    }

    this.db.updateRun(runId, {
      status: 'queued'
    });

    return this.getById(runId);
  }

  peek(limit = 10) {
    if (typeof this.db.getQueuedRuns === 'function') {
      return this.db.getQueuedRuns(limit);
    }
    return this._fallbackPeek(limit);
  }

  _fallbackPeek(limit = 10) {
    const rows = this.db.getAllRuns ? this.db.getAllRuns(100) : [];
    if (Array.isArray(rows)) {
      return rows
        .filter(r => r.status === 'queued' || r.status === 'pending')
        .slice(0, limit);
    }
    return [];
  }

  getById(id) {
    return this.db.getRunById(id);
  }

  markRunning(id, metadata = {}) {
    this.db.updateRun(id, {
      status: 'running',
      ...metadata
    });
    return this.getById(id);
  }

  markDone(id, result = {}) {
    this.db.updateRun(id, {
      status: 'done',
      ...result
    });
    return this.getById(id);
  }

  markFailed(id, errorMessage, metadata = {}) {
    this.db.updateRun(id, {
      status: 'failed',
      errorMessage: String(errorMessage || 'Unknown error'),
      ...metadata
    });
    return this.getById(id);
  }

  markStuck(id, errorMessage) {
    this.db.updateRun(id, {
      status: 'stuck',
      errorMessage: String(errorMessage || 'Run timeout exceeded without progress')
    });
    return this.getById(id);
  }

  countByStatus() {
    const runs = this.db.getAllRuns ? this.db.getAllRuns(200) : [];
    const counts = { queued: 0, pending: 0, running: 0, done: 0, failed: 0, stuck: 0, sharded: 0 };
    for (const r of runs) {
      if (counts[r.status] !== undefined) {
        counts[r.status]++;
      }
    }
    return counts;
  }
}

module.exports = { RunQueue };
