/**
 * Worker Pool & Resource Locking Engine
 * Separates execution pipelines by resource footprint (Local, Cloud, Browser, CDP)
 * and guarantees exclusive locks for single-tenant assets (e.g. CDP port 9222, login sessions).
 *
 * Simplification Round: ownership is keyed by executionToken (one per attempt),
 * NOT by runId. A run that is retried (#50 attempt A, then attempt B) produces
 * two distinct tokens; attempt A finishing late must only release its own slot/
 * lock, never attempt B's, even though both share the same runId.
 */

class WorkerPoolManager {
  constructor(options = {}) {
    this.capacities = {
      LOCAL: options.localConcurrency !== undefined
        ? options.localConcurrency
        : (process.env.LOCAL_POOL_CONCURRENCY ? parseInt(process.env.LOCAL_POOL_CONCURRENCY, 10) : 4),
      CLOUD: options.cloudConcurrency !== undefined
        ? options.cloudConcurrency
        : (process.env.CLOUD_POOL_CONCURRENCY ? parseInt(process.env.CLOUD_POOL_CONCURRENCY, 10) : 8),
      BROWSER: options.browserConcurrency !== undefined
        ? options.browserConcurrency
        : (process.env.BROWSER_POOL_CONCURRENCY ? parseInt(process.env.BROWSER_POOL_CONCURRENCY, 10) : 2),
      CDP: options.cdpConcurrency !== undefined
        ? options.cdpConcurrency
        : (process.env.CDP_POOL_CONCURRENCY ? parseInt(process.env.CDP_POOL_CONCURRENCY, 10) : 1)
    };

    // Elastic pools: LOCAL and BROWSER can burst beyond safe baseline when RAM headroom permits.
    // CDP (1, exclusive lock) and CLOUD (8, cloud actor bound) maintain strict limits.
    const defaultElastic = ['LOCAL', 'BROWSER'];
    this.elasticPools = new Set(
      Array.isArray(options.elasticPools)
        ? options.elasticPools.map(p => String(p).toUpperCase())
        : (process.env.ELASTIC_POOLS !== undefined
            ? process.env.ELASTIC_POOLS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
            : defaultElastic)
    );

    this.activeWorkers = {
      LOCAL: new Set(),
      CLOUD: new Set(),
      BROWSER: new Set(),
      CDP: new Set()
    };

    this.locks = new Map(); // lockKey -> executionToken
  }

  normalizePool(poolName) {
    const p = String(poolName || 'LOCAL').toUpperCase();
    return this.capacities[p] !== undefined ? p : 'LOCAL';
  }

  isElastic(poolName) {
    const p = this.normalizePool(poolName);
    return this.elasticPools.has(p);
  }

  getCapacity(poolName) {
    return this.capacities[this.normalizePool(poolName)] || 1;
  }

  getRunningCount(poolName) {
    const p = this.normalizePool(poolName);
    return this.activeWorkers[p].size;
  }

  hasSlot(poolName, allowElastic = false) {
    const p = this.normalizePool(poolName);
    if (allowElastic && this.isElastic(p)) {
      return true; // Elastic pool allows bursting beyond baseline; RAM headroom governs admission.
    }
    return this.activeWorkers[p].size < this.capacities[p];
  }

  acquireSlot(poolName, executionToken, allowElastic = false) {
    const p = this.normalizePool(poolName);
    if (!this.hasSlot(p, allowElastic)) return false;
    this.activeWorkers[p].add(executionToken);
    return true;
  }

  releaseSlot(poolName, executionToken) {
    const p = this.normalizePool(poolName);
    this.activeWorkers[p].delete(executionToken);
  }

  // ==================== Resource Locks ====================

  acquireLock(lockKey, executionToken) {
    if (!lockKey) return true;
    const currentOwner = this.locks.get(lockKey);
    if (currentOwner && currentOwner !== executionToken) {
      return false; // Locked by a different attempt.
    }
    this.locks.set(lockKey, executionToken);
    return true;
  }

  releaseLock(lockKey, executionToken) {
    if (!lockKey) return;
    if (this.locks.get(lockKey) === executionToken) {
      this.locks.delete(lockKey);
    }
  }

  /** Releases every slot/lock owned by this exact executionToken (attempt), never a sibling attempt of the same run. */
  releaseAllForToken(executionToken) {
    for (const set of Object.values(this.activeWorkers)) {
      set.delete(executionToken);
    }
    for (const [lockKey, owner] of Array.from(this.locks.entries())) {
      if (owner === executionToken) {
        this.locks.delete(lockKey);
      }
    }
  }

  canAdmit(poolName, requiredLocks = [], executionToken = null, allowElastic = false) {
    const p = this.normalizePool(poolName);
    if (!this.hasSlot(p, allowElastic)) {
      return { allowed: false, reason: 'POOL_CAPACITY_EXHAUSTED', pool: p, running: this.activeWorkers[p].size, capacity: this.capacities[p] };
    }

    for (const lockKey of requiredLocks) {
      if (lockKey && this.locks.has(lockKey) && this.locks.get(lockKey) !== executionToken) {
        return { allowed: false, reason: 'RESOURCE_LOCKED', lockKey, ownerToken: this.locks.get(lockKey) };
      }
    }

    return { allowed: true, pool: p };
  }

  getStatus() {
    return {
      pools: {
        LOCAL: { running: this.activeWorkers.LOCAL.size, capacity: this.capacities.LOCAL, baseline: this.capacities.LOCAL, elastic: this.isElastic('LOCAL') },
        CLOUD: { running: this.activeWorkers.CLOUD.size, capacity: this.capacities.CLOUD, baseline: this.capacities.CLOUD, elastic: this.isElastic('CLOUD') },
        BROWSER: { running: this.activeWorkers.BROWSER.size, capacity: this.capacities.BROWSER, baseline: this.capacities.BROWSER, elastic: this.isElastic('BROWSER') },
        CDP: { running: this.activeWorkers.CDP.size, capacity: this.capacities.CDP, baseline: this.capacities.CDP, elastic: this.isElastic('CDP') }
      },
      activeLocks: Array.from(this.locks.entries()).map(([key, owner]) => ({ key, owner }))
    };
  }
}

module.exports = { WorkerPoolManager };
