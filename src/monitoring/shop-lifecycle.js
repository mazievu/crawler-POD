/**
 * Shop Lifecycle Policy & Baseline Signal Engine (Milestone 3)
 *
 * Implements SSOT §3.2 of docs/DISCOVERY_MONITORING_PLAN_REVISED.md:
 * - Feature F11: 5-Day Cycle Scheduling & Probe Hierarchy
 * - Feature F12: Shop Total Sales Metric Scope (monitoring_entities.sales)
 * - Feature F13: Sales Baseline Establishment
 * - Feature F14: Sales Baseline Reset on Increase
 * - Feature F15: 7-Day Gap Limit Verification (MAX_VALID_OBSERVATION_GAP)
 * - Feature F16: 30-Day Sales Unchanged Stoppage (SHOP_STOPPAGE_THRESHOLD)
 * - Feature F17: UI Label Accuracy ("Không quan sát thấy sales tăng trong 30 ngày")
 *
 * Strictly decoupled from Discovery: never mutates product_current.status.
 */

const CONSTANTS = {
  MAX_VALID_OBSERVATION_GAP_MS: 7 * 24 * 60 * 60 * 1000, // 7 days in ms (604,800,000 ms)
  SHOP_STOPPAGE_THRESHOLD_MS: 30 * 24 * 60 * 60 * 1000,  // 30 days in ms (2,592,000,000 ms)
  DEFAULT_CYCLE_INTERVAL_DAYS: 5,
  DEFAULT_CYCLE_INTERVAL_MS: 5 * 24 * 60 * 60 * 1000,     // 5 days in ms (432,000,000 ms)
  DEFAULT_MAX_JITTER_HOURS: 6,
  MAX_BACKOFF_RETRY_MS: 24 * 60 * 60 * 1000,             // 24 hours in ms
  UI_LABEL_UNCHANGED_30D: 'Không quan sát thấy sales tăng trong 30 ngày',
  VALID_QUALITIES: ['exact', 'rounded', 'estimated', 'unreliable', 'recalibrated'],
};

/** ISO 8601 UTC timestamps ('YYYY-MM-DDTHH:MM:SS[.sss]Z') are already canonical. */
const CANONICAL_UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Normalizes input date/string/timestamp into an ISO 8601 UTC string.
 *
 * A caller-supplied string that is already a valid ISO 8601 UTC timestamp is
 * returned verbatim (SSOT §3.2: unchanged_since / sales_observed_at /
 * last_increase_observed_at are "set to observed_at"), so the policy output
 * round-trips the observation's own timestamp instead of re-serialising it
 * with added milliseconds. Every other shape (Date, epoch ms, numeric string,
 * space-separated SQLite text, date-only, offsets) is converted to
 * Date#toISOString().
 */
function normalizeIso(dateInput) {
  if (dateInput === null || dateInput === undefined || dateInput === '') return null;
  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    if (CANONICAL_UTC_ISO_RE.test(trimmed) && !isNaN(Date.parse(trimmed))) return trimmed;
  }
  if (dateInput instanceof Date) {
    return isNaN(dateInput.getTime()) ? null : dateInput.toISOString();
  }
  if (typeof dateInput === 'number') {
    if (isNaN(dateInput) || !Number.isFinite(dateInput)) return null;
    const d = new Date(dateInput);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  try {
    let s = String(dateInput).trim();
    if (!s) return null;
    // Pure numeric epoch string (e.g. "1725148800000")
    if (/^\d{10,14}$/.test(s)) {
      const num = Number(s);
      const d = new Date(num);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    // Date-only string (e.g. "2026-09-01")
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      s += 'T00:00:00.000Z';
    } else if (s.includes(' ') && !s.includes('T')) {
      s = s.replace(' ', 'T');
      if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) {
        s += 'Z';
      }
    } else if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) {
      s += 'Z';
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch (_e) {
    return null;
  }
}

/**
 * Parses input date/string/timestamp into UTC epoch milliseconds.
 */
function parseEpochMs(dateInput) {
  if (dateInput === null || dateInput === undefined || dateInput === '') return null;
  if (dateInput instanceof Date) {
    const t = dateInput.getTime();
    return isNaN(t) ? null : t;
  }
  if (typeof dateInput === 'number') {
    if (isNaN(dateInput) || !Number.isFinite(dateInput)) return null;
    return dateInput;
  }
  try {
    let s = String(dateInput).trim();
    if (!s) return null;
    // Pure numeric epoch string (e.g. "1725148800000")
    if (/^\d{10,14}$/.test(s)) {
      const num = Number(s);
      return isNaN(num) ? null : num;
    }
    // Date-only string (e.g. "2026-09-01")
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      s += 'T00:00:00.000Z';
    } else if (s.includes(' ') && !s.includes('T')) {
      s = s.replace(' ', 'T');
      if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) {
        s += 'Z';
      }
    } else if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) {
      s += 'Z';
    }
    const ms = Date.parse(s);
    return isNaN(ms) ? null : ms;
  } catch (_e) {
    return null;
  }
}

/**
 * Computes next scheduled probe due time: observed_at + 5 days + non-negative jitter.
 *
 * @param {string|Date|number} observedAt - Probe timestamp.
 * @param {object|number} [options] - Options object or explicit jitter in hours.
 * @returns {Date} Scheduled next due Date object.
 */
function computeNextDueAt(observedAt, options = {}) {
  const baseMs = parseEpochMs(observedAt) || Date.now();
  let jitterMs = 0;

  if (typeof options === 'number') {
    jitterMs = Math.max(0, options * 3600 * 1000);
  } else if (typeof options.jitterHours === 'number') {
    jitterMs = Math.max(0, options.jitterHours * 3600 * 1000);
  } else if (typeof options.jitterMs === 'number') {
    jitterMs = Math.max(0, options.jitterMs);
  } else if (options.maxJitterHours) {
    const maxJitterMs = Math.max(0, (options.maxJitterHours ?? CONSTANTS.DEFAULT_MAX_JITTER_HOURS) * 3600 * 1000);
    jitterMs = Math.floor(Math.random() * (maxJitterMs + 1));
  }

  return new Date(baseMs + CONSTANTS.DEFAULT_CYCLE_INTERVAL_MS + jitterMs);
}

/**
 * Computes next due timestamp string with optional non-negative jitter (0-6 hours).
 *
 * @param {string|Date|number} observedAt
 * @param {number} [jitterHours=0]
 * @returns {string} ISO timestamp string
 */
function computeNextDue(observedAt, jitterHours = 0) {
  const next = computeNextDueAt(observedAt, { jitterHours });
  return next.toISOString();
}

/**
 * Computes retry timestamp with exponential backoff + jitter on failed probe.
 *
 * @param {number} attemptCount - Number of previous failed attempts.
 * @param {object} [options]
 * @param {number} [options.baseMs=1000]
 * @param {number} [options.maxMs=86400000]
 * @returns {Date}
 */
function computeBackoffRetryAt(attemptCount, options = {}) {
  const baseMs = options.baseMs || 1000;
  const maxMs = options.maxMs || CONSTANTS.MAX_BACKOFF_RETRY_MS;
  const expBackoff = Math.min(maxMs, baseMs * Math.pow(2, attemptCount));
  const jitterMs = options.jitterMs !== undefined
    ? Math.max(0, Number(options.jitterMs))
    : Math.floor(Math.random() * (expBackoff * 0.2 + 1));
  return new Date(Date.now() + expBackoff + jitterMs);
}

/**
 * Checks whether the observation gap between previous and current observation exceeds 7 days.
 *
 * @param {string|Date|number} prevObservedAt
 * @param {string|Date|number} currentObservedAt
 * @returns {boolean} True if gap > 7 days (chain is broken).
 */
function isGapBroken(prevObservedAt, currentObservedAt) {
  if (!prevObservedAt) return false;
  const prevMs = parseEpochMs(prevObservedAt);
  const currMs = parseEpochMs(currentObservedAt);
  if (prevMs == null || currMs == null) return false;
  return (currMs - prevMs) > CONSTANTS.MAX_VALID_OBSERVATION_GAP_MS;
}

/**
 * Calculates total elapsed time from unchangedSince anchor in milliseconds.
 *
 * @param {string|Date|number} unchangedSince
 * @param {string|Date|number} currentObservedAt
 * @returns {number}
 */
function calculateElapsedWindow(unchangedSince, currentObservedAt) {
  if (!unchangedSince) return 0;
  const startMs = parseEpochMs(unchangedSince);
  const currMs = parseEpochMs(currentObservedAt);
  if (startMs == null || currMs == null) return 0;
  return Math.max(0, currMs - startMs);
}

/**
 * Shop Lifecycle Policy Engine (SSOT §3.2)
 */
class ShopLifecyclePolicy {
  /**
   * Evaluates a shop sales observation against current shop entity state.
   *
   * @param {object} currentState
   * @param {number|null} currentState.sales - Current baseline sales count.
   * @param {string|Date|null} currentState.unchangedSince - Timestamp when sales baseline was established or reset.
   * @param {string|Date|null} currentState.salesObservedAt - Timestamp of last valid sales observation.
   * @param {string|Date|null} currentState.lastIncreaseObservedAt - Timestamp of last confirmed sales increase.
   * @param {string} [currentState.trackingStatus='active'] - 'active' | 'paused' | 'stopped' | 'expired'.
   * @param {string|null} [currentState.reason]
   *
   * @param {object} observation
   * @param {number|null} observation.value - Observed total shop sales count.
   * @param {string|Date} observation.observedAt - Observation timestamp.
   * @param {'exact'|'rounded'|'estimated'|'unreliable'|'recalibrated'} [observation.quality='exact']
   * @param {any|null} [observation.error=null] - Crawl error or block indicator.
   *
   * @returns {object} Next evaluated state:
   *   {
   *     stateChanged: boolean,
   *     trackingStatus: string,
   *     reason: string|null,
   *     sales: number|null,
   *     unchangedSince: string|null,
   *     salesObservedAt: string|null,
   *     lastIncreaseObservedAt: string|null,
   *     action: string
   *   }
   */
  static evaluateObservation(currentState, observation) {
    const state = currentState || {};
    const obs = observation || {};

    const baseline = (state.sales != null && typeof state.sales === 'number' && !isNaN(state.sales))
      ? state.sales
      : (state.sales != null && !isNaN(Number(state.sales)) ? Number(state.sales) : null);

    const unchangedSince = state.unchangedSince || state.unchanged_since || null;
    const salesObservedAt = state.salesObservedAt || state.sales_observed_at || null;
    const lastIncreaseObservedAt = state.lastIncreaseObservedAt || state.last_increase_observed_at || null;
    const trackingStatus = state.trackingStatus || state.tracking_status || 'active';
    const reason = state.reason || null;

    const rawSales = obs.value !== undefined
      ? obs.value
      : (obs.sales !== undefined ? obs.sales : (obs.metricValue ?? obs.metric_value));
    const observedAt = obs.observedAt || obs.observed_at;
    const quality = obs.quality || 'exact';
    const error = obs.error || null;

    const obsTime = parseEpochMs(observedAt);
    const prevObsTime = parseEpochMs(salesObservedAt);
    const unchangedSinceTime = parseEpochMs(unchangedSince);

    const observedAtFormatted = normalizeIso(observedAt);

    // -------------------------------------------------------------------------
    // Rule 5 (SSOT §3.2): Errors, CAPTCHAs, bot blocks, invalid values do NOT alter state
    // -------------------------------------------------------------------------
    if (
      error != null ||
      rawSales == null ||
      typeof rawSales !== 'number' ||
      isNaN(rawSales) ||
      rawSales < 0 ||
      obsTime == null
    ) {
      return {
        stateChanged: false,
        trackingStatus,
        reason,
        sales: baseline,
        unchangedSince: unchangedSince instanceof Date ? unchangedSince.toISOString() : unchangedSince,
        salesObservedAt: salesObservedAt instanceof Date ? salesObservedAt.toISOString() : salesObservedAt,
        lastIncreaseObservedAt: lastIncreaseObservedAt instanceof Date ? lastIncreaseObservedAt.toISOString() : lastIncreaseObservedAt,
        action: 'error_ignored',
      };
    }

    const newSales = rawSales;

    // -------------------------------------------------------------------------
    // Rule 1 (SSOT §3.2, F13): First valid observation establishes initial baseline
    // -------------------------------------------------------------------------
    if (baseline == null || unchangedSince == null) {
      return {
        stateChanged: true,
        trackingStatus: 'active',
        reason: null,
        sales: newSales,
        unchangedSince: observedAtFormatted,
        salesObservedAt: observedAtFormatted,
        lastIncreaseObservedAt: observedAtFormatted,
        action: 'baseline_established',
      };
    }

    // -------------------------------------------------------------------------
    // Rule 2 (SSOT §3.2, F14): Sales increase resets baseline and updates last_increase
    // -------------------------------------------------------------------------
    if (newSales > baseline) {
      return {
        stateChanged: true,
        trackingStatus: 'active',
        reason: null,
        sales: newSales,
        unchangedSince: observedAtFormatted,
        salesObservedAt: observedAtFormatted,
        lastIncreaseObservedAt: observedAtFormatted,
        action: 'baseline_reset_increase',
      };
    }

    // -------------------------------------------------------------------------
    // Rule 4 (SSOT §3.2): Sales decrease is recalibration; resets window, does NOT stop shop
    // -------------------------------------------------------------------------
    if (newSales < baseline) {
      return {
        stateChanged: true,
        trackingStatus: 'active',
        reason: null,
        sales: newSales,
        unchangedSince: observedAtFormatted,
        salesObservedAt: observedAtFormatted,
        lastIncreaseObservedAt: lastIncreaseObservedAt instanceof Date ? lastIncreaseObservedAt.toISOString() : lastIncreaseObservedAt,
        action: 'baseline_recalibrated_decrease',
      };
    }

    // -------------------------------------------------------------------------
    // Rule 3 (SSOT §3.2, F15, F16): Sales unchanged (newSales === baseline)
    // -------------------------------------------------------------------------

    // 3a. Quality Gating: only 'exact' quality counts towards 30-day stoppage
    if (quality !== 'exact') {
      return {
        stateChanged: false,
        trackingStatus: 'active',
        reason: null,
        sales: baseline,
        unchangedSince: unchangedSince instanceof Date ? unchangedSince.toISOString() : unchangedSince,
        salesObservedAt: observedAtFormatted,
        lastIncreaseObservedAt: lastIncreaseObservedAt instanceof Date ? lastIncreaseObservedAt.toISOString() : lastIncreaseObservedAt,
        action: 'quality_ineligible_for_stop',
      };
    }

    // 3b. 7-Day Gap Limit Check (F15)
    const gapMs = prevObsTime != null ? (obsTime - prevObsTime) : 0;
    if (gapMs > CONSTANTS.MAX_VALID_OBSERVATION_GAP_MS) {
      // Gap > 7 days breaks the chain! Window resets to current observation
      return {
        stateChanged: true,
        trackingStatus: 'active',
        reason: null,
        sales: baseline,
        unchangedSince: observedAtFormatted, // Window resets!
        salesObservedAt: observedAtFormatted,
        lastIncreaseObservedAt: lastIncreaseObservedAt instanceof Date ? lastIncreaseObservedAt.toISOString() : lastIncreaseObservedAt,
        action: 'gap_broken_window_reset',
      };
    }

    // 3c. 30-Day Stoppage Check (F16)
    const totalElapsedMs = unchangedSinceTime != null ? (obsTime - unchangedSinceTime) : 0;

    if (totalElapsedMs >= CONSTANTS.SHOP_STOPPAGE_THRESHOLD_MS) {
      return {
        stateChanged: true,
        trackingStatus: 'stopped',
        reason: 'shop_sales_unchanged_30d',
        sales: baseline,
        unchangedSince: unchangedSince instanceof Date ? unchangedSince.toISOString() : unchangedSince,
        salesObservedAt: observedAtFormatted,
        lastIncreaseObservedAt: lastIncreaseObservedAt instanceof Date ? lastIncreaseObservedAt.toISOString() : lastIncreaseObservedAt,
        action: 'shop_stopped_30d_unchanged',
      };
    }

    // 3d. Elapsed < 30 days: shop remains active, window maintained
    return {
      stateChanged: false,
      trackingStatus: 'active',
      reason: null,
      sales: baseline,
      unchangedSince: unchangedSince instanceof Date ? unchangedSince.toISOString() : unchangedSince,
      salesObservedAt: observedAtFormatted,
      lastIncreaseObservedAt: lastIncreaseObservedAt instanceof Date ? lastIncreaseObservedAt.toISOString() : lastIncreaseObservedAt,
      action: 'window_maintained_active',
    };
  }

  /**
   * Computes next due timestamp with optional non-negative jitter (0-6 hours).
   */
  static computeNextDue(observedAt, jitterHours = 0) {
    return computeNextDue(observedAt, jitterHours);
  }

  /**
   * Computes next scheduled probe due Date object.
   */
  static computeNextDueAt(observedAt, options = {}) {
    return computeNextDueAt(observedAt, options);
  }

  /**
   * Returns exact user-facing UI label for shop status (SSOT §3.2, F17).
   *
   * @param {object} state
   * @returns {string|null} Exact string "Không quan sát thấy sales tăng trong 30 ngày" or null.
   */
  static getUiLabel(state) {
    if (!state) return null;
    const status = state.trackingStatus || state.tracking_status;
    const reason = state.reason;
    if (status === 'stopped' && reason === 'shop_sales_unchanged_30d') {
      return CONSTANTS.UI_LABEL_UNCHANGED_30D;
    }
    return null;
  }
}

/**
 * Production Database Transaction Helper:
 * Evaluates a shop probe observation, updates monitoring_entities, appends to
 * monitoring_entity_observations, and cascades stoppage to child monitoring_items.
 *
 * @param {object} db - Database connection / client
 * @param {number} entityId - ID of the shop monitoring_entity
 * @param {object} probeResult
 * @param {object} [options]
 * @returns {Promise<object>} Result of probe processing
 */
async function evaluateAndApplyShopProbe(db, entityId, probeResult, options = {}) {
  const { createMonitoringOps } = require('../database/monitoring');
  const ops = createMonitoringOps(db, options);

  const rawSales = probeResult.sales !== undefined ? probeResult.sales : probeResult.value;
  const result = await ops.applyShopObservation(entityId, {
    value: rawSales,
    observedAt: probeResult.observedAt,
    quality: probeResult.quality || 'exact',
    error: probeResult.error || null,
    source: probeResult.source || 'shop_probe',
    rawRef: probeResult.rawRef || null,
    observationId: probeResult.observationId || null,
  }, options);

  return {
    entityId: Number(entityId),
    previousState: options.previousState || null,
    nextState: result.evaluation,
    action: result.action,
    uiLabel: ShopLifecyclePolicy.getUiLabel(result.evaluation),
    entity: result.entity,
    observation: result.observation,
  };
}

module.exports = {
  CONSTANTS,
  SHOP_CONSTANTS: CONSTANTS,
  ShopLifecyclePolicy,
  computeNextDue,
  computeNextDueAt,
  computeBackoffRetryAt,
  isGapBroken,
  calculateElapsedWindow,
  evaluateAndApplyShopProbe,
};
