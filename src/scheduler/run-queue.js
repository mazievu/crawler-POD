const db = require('../database');

class RunQueue {
  constructor(database = db) {
    this.db = database;
  }

  async enqueue(runPayload) {
    if (!runPayload || !runPayload.platform) {
      throw new Error('Run payload with platform is required');
    }

    let runId = runPayload.id;
    if (!runId) {
      const newRun = await this.db.createRun({
        platform: runPayload.platform,
        query: runPayload.query || 'search',
        maxItems: runPayload.maxItems || 50,
        country: runPayload.country || null,
        options: runPayload.options || {}
      });
      runId = newRun.id;
    }

    await this.db.updateRun(runId, {
      status: 'queued'
    });

    return this.getById(runId);
  }

  async peek(limit = 10) {
    if (typeof this.db.getQueuedRuns === 'function') {
      return await this.db.getQueuedRuns(limit);
    }
    return this._fallbackPeek(limit);
  }

  async _fallbackPeek(limit = 10) {
    const rows = this.db.getAllRuns ? await this.db.getAllRuns(100) : [];
    if (Array.isArray(rows)) {
      return rows
        .filter(r => r.status === 'queued' || r.status === 'pending')
        .slice(0, limit);
    }
    return [];
  }

  async getById(id) {
    return await this.db.getRunById(id);
  }

  async markRunning(id, metadata = {}) {
    await this.db.updateRun(id, {
      status: 'running',
      ...metadata
    });
    return this.getById(id);
  }

  async markDone(id, result = {}) {
    await this.db.updateRun(id, {
      status: 'done',
      ...result
    });
    return this.getById(id);
  }

  async markFailed(id, errorMessage, metadata = {}) {
    await this.db.updateRun(id, {
      status: 'failed',
      errorMessage: String(errorMessage || 'Unknown error'),
      ...metadata
    });
    return this.getById(id);
  }

  async markStuck(id, errorMessage) {
    await this.db.updateRun(id, {
      status: 'stuck',
      errorMessage: String(errorMessage || 'Run timeout exceeded without progress')
    });
    return this.getById(id);
  }

  async countByStatus() {
    const runs = this.db.getAllRuns ? await this.db.getAllRuns(200) : [];
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
