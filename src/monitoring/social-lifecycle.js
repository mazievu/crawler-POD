/**
 * Social Author Lifecycle Policy Engine & Lifecycle Timer (Milestone 4)
 *
 * Implements SSOT §3.3 & §4 of docs/DISCOVERY_MONITORING_PLAN_REVISED.md:
 * - Feature F18: Author Session Deadline (started_at + 30/60d UTC)
 * - Feature F19: Star Dynamic Window Extension (anchored to started_at + 60d)
 * - Feature F20: Unstar Immediate Expiration (immediate expiry on/after Day 30)
 * - Feature F21: Expired Author Star Reactivation (within 60d window; re-track post-60d)
 * - Feature F22: Tick-Based Expiry Timer (independent evaluation on every tick)
 */

const crypto = require('crypto');

const CONSTANTS = {
  // Session Durations in Days & Milliseconds (Prompt & SSOT §3.3)
  NORMAL_SESSION_DAYS: 30,
  STARRED_SESSION_DAYS: 60,
  NORMAL_SESSION_MS: 30 * 24 * 60 * 60 * 1000,    // 2,592,000,000 ms
  STARRED_SESSION_MS: 60 * 24 * 60 * 60 * 1000,   // 5,184,000,000 ms

  // Aliases for compatibility with harness and project specs
  AUTHOR_STANDARD_WINDOW_DAYS: 30,
  AUTHOR_STARRED_WINDOW_DAYS: 60,
  AUTHOR_STANDARD_WINDOW_MS: 30 * 24 * 60 * 60 * 1000,
  AUTHOR_STARRED_WINDOW_MS: 60 * 24 * 60 * 60 * 1000,
  STANDARD_SESSION_DAYS: 30,
  DEFAULT_CYCLE_INTERVAL_DAYS: 5,
  DEFAULT_CYCLE_INTERVAL_MS: 5 * 24 * 60 * 60 * 1000,

  // Entity Tracking Statuses (DB enum: active, paused, stopped, expired)
  STATUS_ACTIVE: 'active',
  STATUS_PAUSED: 'paused',
  STATUS_STOPPED: 'stopped',
  STATUS_EXPIRED: 'expired',

  // Expiration & Lifecycle Reasons
  REASON_SESSION_EXPIRED: 'session_expired',
  REASON_UNSTARRED_AFTER_STANDARD_DEADLINE: 'unstarred_after_standard_deadline',
  REASON_UNSTARRED_POST_30D: 'unstarred_after_standard_deadline',

  // Policy Action Identifiers
  ACTION_WINDOW_EXTENDED_60D: 'window_extended_to_60d',
  ACTION_STARRED_EXTENDED_60D: 'window_extended_to_60d',
  ACTION_REACTIVATED_FROM_EXPIRED: 'reactivated_from_expired',
  ACTION_REVERTED_TO_STANDARD: 'reverted_to_standard_deadline',
  ACTION_UNSTARRED_REVERTED_30D: 'reverted_to_standard_deadline',
  ACTION_EXPIRED_IMMEDIATELY: 'expired_immediately_on_unstar',
  ACTION_IMMEDIATE_EXPIRED_POST_30D: 'expired_immediately_on_unstar',
  ACTION_NEW_SESSION_STARTED: 'new_session_started',
  ACTION_ALREADY_STARRED: 'already_starred',
  ACTION_NO_CHANGE: 'no_change',
  ACTION_EXPIRED_BY_TIMER: 'expired_by_timer',
  ACTION_ACTIVE_MAINTAINED: 'active_maintained',

  // Error Codes
  ERROR_PAST_60D_WINDOW: 'PAST_60D_WINDOW_CANNOT_REACTIVATE',
  ERROR_ENTITY_EXPIRED_IN_FLIGHT: 'ENTITY_EXPIRED_IN_FLIGHT',
};

/**
 * Robust UTC millisecond parser supporting Date objects, ISO strings, and numeric epochs.
 *
 * @param {string|Date|number} input
 * @returns {number} UTC epoch milliseconds
 */
function parseEpochMs(input) {
  if (input === null || input === undefined || input === '') return Date.now();
  if (input instanceof Date) return isNaN(input.getTime()) ? Date.now() : input.getTime();
  if (typeof input === 'number') return isNaN(input) || !Number.isFinite(input) ? Date.now() : input;
  try {
    let s = String(input).trim();
    if (!s) return Date.now();
    // Numeric epoch string (e.g. "1725148800000")
    if (/^\d{10,14}$/.test(s)) {
      const n = Number(s);
      return isNaN(n) ? Date.now() : n;
    }
    // Date-only string (e.g. "2026-09-01")
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      s += 'T00:00:00.000Z';
    } else if (s.includes(' ') && !s.includes('T')) {
      s = s.replace(' ', 'T');
      if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) s += 'Z';
    } else if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) {
      s += 'Z';
    }
    const ms = Date.parse(s);
    return isNaN(ms) ? Date.now() : ms;
  } catch (_e) {
    return Date.now();
  }
}

/**
 * Normalizes input date/epoch into canonical ISO 8601 UTC string.
 *
 * @param {string|Date|number} input
 * @returns {string} ISO 8601 UTC string
 */
function normalizeIso(input) {
  const ms = parseEpochMs(input);
  return new Date(ms).toISOString();
}

/**
 * Social Author Lifecycle Policy Engine (SSOT §3.3)
 */
class SocialLifecyclePolicy {
  /**
   * Calculates session deadline: monitoring_started_at + (isStarred ? 60 : 30) days (UTC).
   *
   * @param {string|Date|number} startedAt
   * @param {boolean} [isStarred=false]
   * @returns {string} ISO 8601 UTC string
   */
  static calculateExpiresAt(startedAt, isStarred = false) {
    const startMs = parseEpochMs(startedAt);
    const durationMs = isStarred ? CONSTANTS.STARRED_SESSION_MS : CONSTANTS.NORMAL_SESSION_MS;
    return new Date(startMs + durationMs).toISOString();
  }

  /**
   * Alias for calculateExpiresAt.
   */
  static computeInitialExpiresAt(startedAt, isStarred = false) {
    return SocialLifecyclePolicy.calculateExpiresAt(startedAt, isStarred);
  }

  /**
   * Handles user Star toggle event (PATCH /api/monitoring/entities/:id with isStarred: true).
   *
   * Rules (SSOT §3.3):
   * 1. Check if now >= started_at + 60d FIRST. If so, Star cannot reactivate an expired author.
   * 2. If already starred and currently active/paused, idempotent no-op.
   * 3. If expired between Day 30 and Day 60, starring reactivates to active and extends deadline to started_at + 60d.
   * 4. If active or paused, extends deadline to started_at + 60d.
   *
   * @param {object} entity
   * @param {string|Date|number} [now=new Date()]
   * @returns {object} Updated entity state
   */
  static handleStar(entity, now = new Date()) {
    if (!entity) return { stateChanged: false, success: false };

    const nowMs = parseEpochMs(now);
    const startMs = parseEpochMs(
      entity.monitoring_started_at ?? entity.monitoringStartedAt ?? entity.startedAt ?? entity.started_at
    );
    const maxStarredDeadlineMs = startMs + CONSTANTS.STARRED_SESSION_MS;
    const isCurrentlyStarred = Boolean(entity.is_starred ?? entity.isStarred);
    const currentStatus = entity.tracking_status ?? entity.trackingStatus ?? CONSTANTS.STATUS_ACTIVE;
    const currentExpiresAt = entity.expires_at ?? entity.expiresAt ?? null;

    // 1. CRITICAL: If now >= started_at + 60d, Star CANNOT reactivate an expired author!
    if (nowMs >= maxStarredDeadlineMs) {
      return {
        ...entity,
        success: false,
        stateChanged: false,
        error: CONSTANTS.ERROR_PAST_60D_WINDOW,
        tracking_status: currentStatus,
        trackingStatus: currentStatus,
        expires_at: currentExpiresAt,
        expiresAt: currentExpiresAt,
        is_starred: isCurrentlyStarred,
        isStarred: isCurrentlyStarred,
        action: 'past_60d_window_cannot_reactivate',
      };
    }

    // 2. If already starred and currently active/paused, idempotent no-op
    if (isCurrentlyStarred && currentStatus !== CONSTANTS.STATUS_EXPIRED) {
      return {
        ...entity,
        success: true,
        stateChanged: false,
        tracking_status: currentStatus,
        trackingStatus: currentStatus,
        expires_at: currentExpiresAt,
        expiresAt: currentExpiresAt,
        is_starred: true,
        isStarred: true,
        action: 'already_starred',
      };
    }

    const newExpiresAt = new Date(maxStarredDeadlineMs).toISOString();

    // 3. If expired between Day 30 and Day 60, starring reactivates to active!
    if (currentStatus === CONSTANTS.STATUS_EXPIRED) {
      return {
        ...entity,
        success: true,
        is_starred: true,
        isStarred: true,
        tracking_status: CONSTANTS.STATUS_ACTIVE,
        trackingStatus: CONSTANTS.STATUS_ACTIVE,
        reason: null,
        expires_at: newExpiresAt,
        expiresAt: newExpiresAt,
        stateChanged: true,
        action: CONSTANTS.ACTION_REACTIVATED_FROM_EXPIRED,
      };
    }

    // 4. If active or paused, extends deadline to started_at + 60d
    return {
      ...entity,
      success: true,
      is_starred: true,
      isStarred: true,
      expires_at: newExpiresAt,
      expiresAt: newExpiresAt,
      tracking_status: currentStatus,
      trackingStatus: currentStatus,
      stateChanged: true,
      action: CONSTANTS.ACTION_WINDOW_EXTENDED_60D,
    };
  }

  /**
   * Handles user Unstar toggle event (PATCH /api/monitoring/entities/:id with isStarred: false).
   *
   * Rules (SSOT §3.3):
   * 1. If already unstarred, idempotent no-op.
   * 2. If now >= started_at + 30d (e.g. Day 40), unstar causes immediate expiration.
   * 3. If now < started_at + 30d (e.g. Day 20), reverts expires_at to started_at + 30d.
   *
   * @param {object} entity
   * @param {string|Date|number} [now=new Date()]
   * @returns {object} Updated entity state
   */
  static handleUnstar(entity, now = new Date()) {
    if (!entity) return { stateChanged: false, success: false };

    const nowMs = parseEpochMs(now);
    const startMs = parseEpochMs(
      entity.monitoring_started_at ?? entity.monitoringStartedAt ?? entity.startedAt ?? entity.started_at
    );
    const isCurrentlyStarred = Boolean(entity.is_starred ?? entity.isStarred);
    const currentStatus = entity.tracking_status ?? entity.trackingStatus ?? CONSTANTS.STATUS_ACTIVE;
    const currentExpiresAt = entity.expires_at ?? entity.expiresAt ?? null;

    // 1. If not starred, idempotent no-op
    if (!isCurrentlyStarred) {
      return {
        ...entity,
        success: true,
        stateChanged: false,
        tracking_status: currentStatus,
        trackingStatus: currentStatus,
        expires_at: currentExpiresAt,
        expiresAt: currentExpiresAt,
        is_starred: false,
        isStarred: false,
        action: 'already_unstarred',
      };
    }

    const standardDeadlineMs = startMs + CONSTANTS.NORMAL_SESSION_MS;
    const newExpiresAt = new Date(standardDeadlineMs).toISOString();

    // 2. If now >= started_at + 30d (e.g. Day 40), unstar causes immediate expiration!
    if (nowMs >= standardDeadlineMs) {
      return {
        ...entity,
        success: true,
        is_starred: false,
        isStarred: false,
        tracking_status: CONSTANTS.STATUS_EXPIRED,
        trackingStatus: CONSTANTS.STATUS_EXPIRED,
        reason: CONSTANTS.REASON_UNSTARRED_AFTER_STANDARD_DEADLINE,
        expires_at: newExpiresAt,
        expiresAt: newExpiresAt,
        stateChanged: true,
        action: CONSTANTS.ACTION_EXPIRED_IMMEDIATELY,
        immediate_expired_post_30d: true,
      };
    }

    // 3. If now < started_at + 30d (e.g. Day 20), reverts expires_at to started_at + 30d
    const targetStatus = currentStatus === CONSTANTS.STATUS_EXPIRED ? CONSTANTS.STATUS_EXPIRED : currentStatus;
    return {
      ...entity,
      success: true,
      is_starred: false,
      isStarred: false,
      tracking_status: targetStatus,
      trackingStatus: targetStatus,
      expires_at: newExpiresAt,
      expiresAt: newExpiresAt,
      stateChanged: true,
      action: CONSTANTS.ACTION_REVERTED_TO_STANDARD,
    };
  }

  /**
   * Unified star setter implementing Objective 1 specification.
   *
   * @param {object} entity
   * @param {boolean} isStarred
   * @param {string|Date|number} [now=new Date()]
   * @returns {object} Evaluated entity state with isExpired flag
   */
  static setStarred(entity, isStarred, now = new Date()) {
    const res = isStarred
      ? SocialLifecyclePolicy.handleStar(entity, now)
      : SocialLifecyclePolicy.handleUnstar(entity, now);
    return {
      ...res,
      isExpired: (res.tracking_status ?? res.trackingStatus) === CONSTANTS.STATUS_EXPIRED,
    };
  }

  /**
   * Standalone expiration checker.
   *
   * @param {object} entity
   * @param {string|Date|number} [now=new Date()]
   * @returns {{ isExpired: boolean, newStatus: string, reason: string|null, stateChanged: boolean }}
   */
  static checkExpiration(entity, now = new Date()) {
    if (!entity) {
      return { isExpired: false, newStatus: CONSTANTS.STATUS_ACTIVE, reason: null, stateChanged: false };
    }
    const nowMs = parseEpochMs(now);
    const expiresMs = parseEpochMs(entity.expires_at ?? entity.expiresAt);
    const currentStatus = entity.tracking_status ?? entity.trackingStatus ?? CONSTANTS.STATUS_ACTIVE;

    if (currentStatus === CONSTANTS.STATUS_ACTIVE && expiresMs != null && nowMs >= expiresMs) {
      return {
        isExpired: true,
        newStatus: CONSTANTS.STATUS_EXPIRED,
        reason: CONSTANTS.REASON_SESSION_EXPIRED,
        stateChanged: true,
      };
    }

    return {
      isExpired: currentStatus === CONSTANTS.STATUS_EXPIRED,
      newStatus: currentStatus,
      reason: entity.reason || null,
      stateChanged: false,
    };
  }

  /**
   * Evaluates timer tick for dispatcher (Feature F22).
   * Transitions active author to expired if now >= expires_at.
   *
   * @param {object} entity
   * @param {string|Date|number} [now=new Date()]
   * @returns {object} Evaluated entity state
   */
  static evaluateTickExpiry(entity, now = new Date()) {
    if (!entity) return { stateChanged: false };
    const expiresAt = entity.expires_at ?? entity.expiresAt;
    if (!expiresAt) return { ...entity, stateChanged: false };

    const nowMs = parseEpochMs(now);
    const expiresMs = parseEpochMs(expiresAt);
    const currentStatus = entity.tracking_status ?? entity.trackingStatus ?? CONSTANTS.STATUS_ACTIVE;

    if (currentStatus === CONSTANTS.STATUS_ACTIVE && nowMs >= expiresMs) {
      return {
        ...entity,
        tracking_status: CONSTANTS.STATUS_EXPIRED,
        trackingStatus: CONSTANTS.STATUS_EXPIRED,
        reason: CONSTANTS.REASON_SESSION_EXPIRED,
        stateChanged: true,
        action: 'expired_by_timer',
      };
    }

    return {
      ...entity,
      tracking_status: currentStatus,
      trackingStatus: currentStatus,
      reason: entity.reason || null,
      stateChanged: false,
      action: 'active_maintained',
    };
  }

  /**
   * Explicit "Theo dõi lại" (Re-track) action starting a brand new session (SSOT §3.3, §3.4, F21.4, F21.5).
   * Generates new session_id, resets monitoring_started_at = now, expires_at = now + (isStarred ? 60 : 30)d,
   * tracking_status = 'active'. Preserves past observation history.
   *
   * Under SSOT §3.3, star extensions are session-bound; a brand-new session ("Theo dõi lại")
   * starts as standard 30-day unstarred tracking unless explicitly requested in options.isStarred.
   *
   * @param {object} entity
   * @param {string|Date|number} [now=new Date()]
   * @param {object} [options={}]
   * @returns {object} New session state
   */
  static handleRetrack(entity, now = new Date(), options = {}) {
    if (!entity) return { stateChanged: false };
    const nowIso = normalizeIso(now);
    const isStarred = options.isStarred !== undefined ? Boolean(options.isStarred) : false;
    const newSessionId = options.sessionId || crypto.randomUUID();
    const newExpiresAt = SocialLifecyclePolicy.calculateExpiresAt(nowIso, isStarred);

    return {
      ...entity,
      session_id: newSessionId,
      sessionId: newSessionId,
      monitoring_started_at: nowIso,
      monitoringStartedAt: nowIso,
      expires_at: newExpiresAt,
      expiresAt: newExpiresAt,
      is_starred: isStarred,
      isStarred: isStarred,
      tracking_status: CONSTANTS.STATUS_ACTIVE,
      trackingStatus: CONSTANTS.STATUS_ACTIVE,
      reason: null,
      error: null,
      stateChanged: true,
      action: CONSTANTS.ACTION_NEW_SESSION_STARTED,
    };
  }

  /**
   * Alias for handleRetrack.
   */
  static retrack(entity, now = new Date(), options = {}) {
    return SocialLifecyclePolicy.handleRetrack(entity, now, options);
  }

  /**
   * Pre-dispatch gate (Feature F22.4): prevents queued job execution for expired authors.
   *
   * @param {object} entityState
   * @param {string|Date|number} [now=new Date()]
   * @returns {boolean} True if job may be dispatched
   */
  static canDispatchJob(entityState, now = new Date()) {
    if (!entityState) return false;
    const status = entityState.tracking_status ?? entityState.trackingStatus;
    if (status === CONSTANTS.STATUS_EXPIRED) return false;
    const expiresAt = entityState.expires_at ?? entityState.expiresAt;
    if (expiresAt) {
      const nowMs = parseEpochMs(now);
      const expMs = parseEpochMs(expiresAt);
      if (nowMs >= expMs) return false;
    }
    return status === CONSTANTS.STATUS_ACTIVE;
  }

  /**
   * Pre-commit gate (Feature F22.5): rejects writes if author expired during crawl execution.
   *
   * @param {object} entityState
   * @param {string|Date|number} [now=new Date()]
   * @returns {{ allowed: boolean, error?: string }}
   */
  static canCommitResult(entityState, now = new Date()) {
    if (!entityState) {
      return { allowed: false, error: CONSTANTS.ERROR_ENTITY_EXPIRED_IN_FLIGHT };
    }
    const status = entityState.tracking_status ?? entityState.trackingStatus;
    if (status === CONSTANTS.STATUS_EXPIRED) {
      return { allowed: false, error: CONSTANTS.ERROR_ENTITY_EXPIRED_IN_FLIGHT };
    }
    const expiresAt = entityState.expires_at ?? entityState.expiresAt;
    if (expiresAt) {
      const nowMs = parseEpochMs(now);
      const expMs = parseEpochMs(expiresAt);
      if (nowMs >= expMs) {
        return { allowed: false, error: CONSTANTS.ERROR_ENTITY_EXPIRED_IN_FLIGHT };
      }
    }
    return { allowed: true };
  }
}

/**
 * Evaluates and applies star toggle inside database transaction.
 */
async function evaluateAndApplyAuthorStar(db, entityId, isStarred, now, options = {}) {
  const { toggleEntityStar } = require('../database/monitoring');
  return await toggleEntityStar(db, entityId, isStarred !== undefined ? isStarred : true, { ...options, now });
}

/**
 * Evaluates and applies unstar toggle inside database transaction.
 */
async function evaluateAndApplyAuthorUnstar(db, entityId, now, options = {}) {
  const { toggleEntityStar } = require('../database/monitoring');
  return await toggleEntityStar(db, entityId, false, { ...options, now });
}

/**
 * Evaluates and applies tick expiry inside database transaction.
 */
async function evaluateAndApplyTickExpiry(db, now, options = {}) {
  const { expireDueEntities } = require('../database/monitoring');
  return await expireDueEntities(db, { ...options, now });
}

/**
 * Evaluates and applies re-track action inside database transaction.
 */
async function evaluateAndApplyAuthorRetrack(db, entityId, now, options = {}) {
  const { retrackEntity } = require('../database/monitoring');
  return await retrackEntity(db, entityId, { ...options, now });
}

module.exports = {
  CONSTANTS,
  SOCIAL_CONSTANTS: CONSTANTS,
  SocialLifecyclePolicy,
  normalizeIso,
  parseEpochMs,
  calculateExpiresAt: SocialLifecyclePolicy.calculateExpiresAt,
  computeInitialExpiresAt: SocialLifecyclePolicy.computeInitialExpiresAt,
  handleStar: SocialLifecyclePolicy.handleStar,
  handleUnstar: SocialLifecyclePolicy.handleUnstar,
  setStarred: SocialLifecyclePolicy.setStarred,
  checkExpiration: SocialLifecyclePolicy.checkExpiration,
  evaluateTickExpiry: SocialLifecyclePolicy.evaluateTickExpiry,
  handleRetrack: SocialLifecyclePolicy.handleRetrack,
  retrack: SocialLifecyclePolicy.retrack,
  canDispatchJob: SocialLifecyclePolicy.canDispatchJob,
  canCommitResult: SocialLifecyclePolicy.canCommitResult,
  evaluateAndApplyAuthorStar,
  evaluateAndApplyAuthorUnstar,
  evaluateAndApplyTickExpiry,
  evaluateAndApplyAuthorRetrack,
};
