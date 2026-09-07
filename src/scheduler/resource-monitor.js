const os = require('os');

class ResourceMonitor {
  constructor(options = {}) {
    this.reservePercent = options.reservePercent !== undefined
      ? options.reservePercent
      : (process.env.MANDATORY_RAM_RESERVE_PERCENT ? parseFloat(process.env.MANDATORY_RAM_RESERVE_PERCENT) : 20);
    this.reserveMB = options.reserveMB !== undefined
      ? options.reserveMB
      : (process.env.MANDATORY_RAM_RESERVE_MB ? parseFloat(process.env.MANDATORY_RAM_RESERVE_MB) : null);
    this.criticalPercent = options.criticalPercent !== undefined
      ? options.criticalPercent
      : 90;

    // Deterministic override for tests: bypasses os.totalmem()/os.freemem() so
    // admission tests do not depend on the RAM of the machine running them.
    this._fixedPhysicalSnapshot = options.fixedPhysicalSnapshot || null;

    // Committed/reserved RAM: estimatedMB of every run admitted but not yet
    // finished (released). Multiple runs admitted within the same scheduler
    // tick would otherwise all see the same stale physical headroom and
    // over-commit before the OS-reported free memory actually drops.
    this.reservations = new Map(); // runId -> estimatedMB
  }

  getPhysicalSnapshot() {
    if (this._fixedPhysicalSnapshot) {
      return { ...this._fixedPhysicalSnapshot };
    }

    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    const procMem = process.memoryUsage();

    const totalMB = Math.round(totalBytes / (1024 * 1024));
    const freeMB = Math.round(freeBytes / (1024 * 1024));
    const usedMB = Math.round(usedBytes / (1024 * 1024));
    const procRssMB = Math.round(procMem.rss / (1024 * 1024));
    const procHeapUsedMB = Math.round(procMem.heapUsed / (1024 * 1024));

    let mandatoryReserveMB;
    if (this.reserveMB !== null && !isNaN(this.reserveMB) && this.reserveMB > 0) {
      mandatoryReserveMB = Math.round(this.reserveMB);
    } else {
      mandatoryReserveMB = Math.round((totalMB * this.reservePercent) / 100);
    }

    const usableHeadroomMB = Math.max(0, freeMB - mandatoryReserveMB);
    const usedPercent = Number(((usedMB / totalMB) * 100).toFixed(1));

    let state = 'GREEN';
    if (usedPercent >= this.criticalPercent || freeMB <= Math.round(mandatoryReserveMB * 0.5)) {
      state = 'RED';
    } else if (usableHeadroomMB <= 0 || usedPercent >= (100 - this.reservePercent)) {
      state = 'YELLOW';
    }

    return {
      timestamp: new Date().toISOString(),
      state,
      totalMB,
      usedMB,
      freeMB,
      usedPercent,
      mandatoryReserveMB,
      usableHeadroomMB,
      process: {
        rssMB: procRssMB,
        heapUsedMB: procHeapUsedMB
      }
    };
  }

  getReservedTotalMB() {
    let sum = 0;
    for (const mb of this.reservations.values()) sum += mb;
    return sum;
  }

  /** Commit estimatedMB against headroom for a run that has just been admitted. */
  reserve(runId, estimatedMB) {
    this.reservations.set(runId, Math.max(0, Math.round(estimatedMB || 0)));
  }

  /** Release a run's reservation. Must be called in a `finally` on run completion/failure/cancel. */
  release(runId) {
    this.reservations.delete(runId);
  }

  getSnapshot() {
    const physical = this.getPhysicalSnapshot();
    const reservedMB = this.getReservedTotalMB();
    const effectiveHeadroomMB = Math.max(0, physical.usableHeadroomMB - reservedMB);
    return { ...physical, reservedMB, effectiveHeadroomMB };
  }

  /**
   * Admission check. GREEN + enough *effective* headroom (physical headroom minus
   * everything already reserved this tick/session) required. YELLOW never admits
   * new runs but does not touch runs already in flight. RED blocks unconditionally.
   */
  canAdmit(estimatedMB = 100) {
    const snapshot = this.getSnapshot();
    if (snapshot.state === 'RED') {
      return { allowed: false, reason: 'SYSTEM_MEMORY_CRITICAL_RED', snapshot };
    }
    if (snapshot.state === 'YELLOW') {
      return { allowed: false, reason: 'RAM_HEADROOM_EXHAUSTED_YELLOW', snapshot };
    }
    if (estimatedMB > snapshot.effectiveHeadroomMB) {
      return { allowed: false, reason: 'INSUFFICIENT_RAM_HEADROOM', estimatedMB, effectiveHeadroomMB: snapshot.effectiveHeadroomMB, snapshot };
    }
    return { allowed: true, snapshot };
  }
}

module.exports = { ResourceMonitor };
