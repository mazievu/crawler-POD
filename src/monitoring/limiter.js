/**
 * Global Monitoring Limiter (Milestone 5 - Feature F24, F25)
 * Enforces cluster-wide concurrency = 1 and 20s inter-capture cooldown delay
 * backed by persistent PostgreSQL table `monitoring_limiter`.
 *
 * Adheres strictly to docs/DISCOVERY_MONITORING_PLAN_REVISED.md §4, §6, §10.
 */

const DEFAULT_LIMITER_KEY = 'global_monitoring_capture';
const DEFAULT_COOLDOWN_MS = 20000;
const DEFAULT_LEASE_DURATION_MS = 60000;

class MonitoringLimiter {
  /**
   * @param {object} db - Database handle (pg-client / PgDatabase instance)
   * @param {string} [key='global_monitoring_capture'] - Limiter singleton row key
   * @param {number} [cooldownMs=20000] - Inter-capture cooldown in milliseconds
   */
  constructor(db, key = DEFAULT_LIMITER_KEY, cooldownMs = DEFAULT_COOLDOWN_MS) {
    if (!db) throw new Error('MonitoringLimiter requires a valid database instance');
    this.db = db;
    this.key = key;
    this.cooldownMs = Number(cooldownMs) || DEFAULT_COOLDOWN_MS;
  }

  /**
   * Initializes the singleton limiter row idempotently.
   */
  async init() {
    await this.db.prepare(`
      INSERT INTO monitoring_limiter (key, owner_token, leased_until, next_allowed_at)
      VALUES (?, NULL, NULL, now())
      ON CONFLICT (key) DO NOTHING
    `).run(this.key);
  }

  /**
   * Attempts to atomically acquire the capture lease.
   * Succeeds only if no active unexpired lease exists AND next_allowed_at <= now().
   *
   * Acquiring does NOT move next_allowed_at. SSOT §6 defines the 20s cooldown
   * (MONITOR_ITEM_DELAY_MS) as the gap from the END of a capture to the next
   * start, so only releaseLease() starts it. Arming it here as well measured
   * the cooldown from the previous START, which made an expired (crashed or
   * stolen) lease unrecoverable until start + cooldown even after
   * leased_until had passed.
   *
   * @param {string} ownerToken - Unique worker identity (e.g. `mon-${pid}-${uuid}`)
   * @param {number} [leaseDurationMs=60000] - TTL in milliseconds
   * @returns {Promise<object|null>} Lease row if acquired, null if denied
   */
  async tryAcquireLease(ownerToken, leaseDurationMs = DEFAULT_LEASE_DURATION_MS) {
    if (!ownerToken) throw new Error('tryAcquireLease requires ownerToken');

    const duration = Number(leaseDurationMs) || DEFAULT_LEASE_DURATION_MS;
    const res = await this.db.query(`
      UPDATE monitoring_limiter
      SET owner_token = $1,
          leased_until = now() + ($2 || ' milliseconds')::interval
      WHERE key = $3
        AND (leased_until IS NULL OR leased_until < now())
        AND next_allowed_at <= now()
      RETURNING key, owner_token, leased_until, next_allowed_at
    `, [ownerToken, `${duration}`, this.key]);

    return res.rows && res.rows.length > 0 ? res.rows[0] : null;
  }

  /**
   * Extends the lease duration for an active capture (heartbeat).
   *
   * @param {string} ownerToken - Worker identity holding current lease
   * @param {number} [leaseDurationMs=60000] - New TTL from now()
   * @returns {Promise<object|null>} Updated lease row or null if lost
   */
  async renewLease(ownerToken, leaseDurationMs = DEFAULT_LEASE_DURATION_MS) {
    if (!ownerToken) throw new Error('renewLease requires ownerToken');

    const duration = Number(leaseDurationMs) || DEFAULT_LEASE_DURATION_MS;
    const res = await this.db.query(`
      UPDATE monitoring_limiter
      SET leased_until = now() + ($1 || ' milliseconds')::interval
      WHERE key = $2
        AND owner_token = $3
        AND leased_until >= now()
      RETURNING key, owner_token, leased_until
    `, [`${duration}`, this.key, ownerToken]);

    return res.rows && res.rows.length > 0 ? res.rows[0] : null;
  }

  /**
   * Releases the lease and sets the cooldown period.
   *
   * @param {string} ownerToken - Worker identity holding current lease
   * @param {number} [cooldownMs=this.cooldownMs] - Cooldown delay (0 for shutdown)
   * @returns {Promise<boolean>} True if released, false if token mismatched
   */
  async releaseLease(ownerToken, cooldownMs = this.cooldownMs) {
    if (!ownerToken) return false;

    const numCooldown = Number(cooldownMs);
    const actualCooldown = (Number.isFinite(numCooldown) && numCooldown >= 0)
      ? Math.trunc(numCooldown)
      : this.cooldownMs;

    const res = await this.db.query(`
      UPDATE monitoring_limiter
      SET owner_token = NULL,
          leased_until = NULL,
          next_allowed_at = now() + ($1 || ' milliseconds')::interval
      WHERE key = $2
        AND owner_token = $3
      RETURNING key, next_allowed_at
    `, [`${actualCooldown}`, this.key, ownerToken]);

    return Boolean(res.rows && res.rows.length > 0);
  }

  /**
   * Checks whether the cooldown has expired and no active unexpired lease exists.
   *
   * @returns {Promise<boolean>} True if eligible to execute
   */
  async canExecuteNext() {
    const res = await this.db.query(`
      SELECT (next_allowed_at <= now() AND (leased_until IS NULL OR leased_until < now())) AS can_execute
      FROM monitoring_limiter
      WHERE key = $1
    `, [this.key]);

    return Boolean(res.rows && res.rows.length > 0 && res.rows[0].can_execute);
  }

  /**
   * Retrieves diagnostic limiter state for telemetry and /admindashboard.
   */
  async getStatus() {
    const res = await this.db.query(`
      SELECT key, owner_token, leased_until, next_allowed_at,
             GREATEST(0, EXTRACT(EPOCH FROM (next_allowed_at - now())) * 1000)::bigint AS cooldown_remaining_ms,
             (leased_until IS NOT NULL AND leased_until >= now()) AS is_leased
      FROM monitoring_limiter
      WHERE key = $1
    `, [this.key]);

    if (!res.rows || res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      key: row.key,
      ownerToken: row.owner_token,
      leasedUntil: row.leased_until,
      nextAllowedAt: row.next_allowed_at,
      cooldownRemainingMs: Number(row.cooldown_remaining_ms || 0),
      isLeased: Boolean(row.is_leased),
    };
  }
}

/**
 * Standalone functional helper to acquire monitoring lease.
 */
async function acquireMonitoringLease(db, ownerToken, leaseDurationMs = DEFAULT_LEASE_DURATION_MS) {
  const limiter = new MonitoringLimiter(db);
  return limiter.tryAcquireLease(ownerToken, leaseDurationMs);
}

/**
 * Standalone functional helper to release monitoring lease.
 */
async function releaseMonitoringLease(db, ownerToken, cooldownMs = DEFAULT_COOLDOWN_MS) {
  const limiter = new MonitoringLimiter(db);
  return limiter.releaseLease(ownerToken, cooldownMs);
}

module.exports = {
  MonitoringLimiter,
  acquireMonitoringLease,
  releaseMonitoringLease,
  DEFAULT_LIMITER_KEY,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_LEASE_DURATION_MS,
};
