/**
 * Backend/Planning Failure Reason Classification (Final Stabilization Round #15)
 *
 * A NoHealthyBackendError (or any planning/execution failure) is not one
 * uniform thing. Treating every failure as either "retry forever" or "retry
 * 5x then give up" causes two real problems this round fixes:
 *   - a missing APIFY_TOKEN gets retried/re-enqueued exactly like a flaky
 *     network blip, spamming failed Runs that can never succeed;
 *   - a genuinely transient dependency outage (SearXNG restarting) gets
 *     treated as permanently misconfigured and stops retrying too early.
 *
 * Four reason codes, in order of "how permanent is this right now":
 *   BLOCKED_CONFIGURATION — a setting is missing/wrong (token, actorId,
 *     unknown channel, explicit unsupported backend). Will not change until
 *     a human edits configuration. No retry spam.
 *   UNSUPPORTED — the platform/channel intentionally has no real backend
 *     (e.g. TikTok social listening). No retry spam.
 *   DEPENDENCY_DOWN — a real external dependency (SearXNG, CDP/Chrome,
 *     Apify) is unreachable right now but could come back. Bounded
 *     retry/backoff is useful.
 *   TRANSIENT_BACKEND_FAILURE — a one-off network/HTTP blip during an
 *     otherwise healthy execution. Bounded retry/backoff.
 */

const { defaultRetryPolicy } = require('./retry-policy');

const REASON_CODES = {
  BLOCKED_CONFIGURATION: 'BLOCKED_CONFIGURATION',
  UNSUPPORTED: 'UNSUPPORTED',
  DEPENDENCY_DOWN: 'DEPENDENCY_DOWN',
  TRANSIENT_BACKEND_FAILURE: 'TRANSIENT_BACKEND_FAILURE',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED'
};

/** Reason codes that must never be retried (spamming would never succeed). */
const NO_RETRY_REASON_CODES = new Set([REASON_CODES.BLOCKED_CONFIGURATION, REASON_CODES.UNSUPPORTED, REASON_CODES.LOGIN_REQUIRED]);

/**
 * NoHealthyBackendError's top-level .message is a generic "No usable backend
 * found for X" — the actually-useful reason (missing APIFY_TOKEN vs SearXNG
 * unreachable vs CDP down) lives in the per-backend probe diagnostic
 * (err.diagnostic.backends[].missing/warnings, see src/doctor/index.js).
 * Fold both into one lowercase haystack so classification can tell them apart.
 */
function diagnosticText(err) {
  const parts = [String(err.message || '')];
  const backends = err?.diagnostic?.backends;
  if (Array.isArray(backends)) {
    for (const b of backends) {
      if (Array.isArray(b.missing)) parts.push(...b.missing);
      if (Array.isArray(b.warnings)) parts.push(...b.warnings);
    }
  }
  return parts.join(' ').toLowerCase();
}

function classifyFailureReason(err) {
  if (!err) return REASON_CODES.TRANSIENT_BACKEND_FAILURE;
  const text = diagnosticText(err);

  // Intentionally-absent capability (channel disabled, no real backend mapped).
  if (/disabled|unsupported|no real channel|not implemented|no tiktok/.test(text)) {
    return REASON_CODES.UNSUPPORTED;
  }

  // Missing/invalid configuration — a human needs to fix a setting. Checked
  // before the generic "dependency unreachable" patterns below because a
  // missing token/actorId is a config problem even when phrased near "missing".
  if (/apify_token|token is missing|actorid|entitlement unverified|unknown channel|requested backend .* is not available|invalid input/.test(text)) {
    return REASON_CODES.BLOCKED_CONFIGURATION;
  }

  // A real external dependency is reachable-but-unhealthy or unreachable right
  // now (SearXNG, CDP/Chrome) — could come back on its own.
  if (/searxng|cdp_browser|not reachable|unreachable|econnrefused/.test(text)) {
    return REASON_CODES.DEPENDENCY_DOWN;
  }

  // §9/§11: CDP browser is reachable but the session (Toidispy, Facebook) is
  // expired — a human must re-authenticate before crawls can succeed.
  if (/login_required|toidispy_login|session.expired|login page|not authenticated|checkpoint/i.test(text)) {
    return REASON_CODES.LOGIN_REQUIRED;
  }

  if (defaultRetryPolicy.isRetryable(err)) {
    return REASON_CODES.TRANSIENT_BACKEND_FAILURE;
  }

  // NoHealthyBackendError not otherwise classified above (e.g. doctor
  // diagnostic unavailable) defaults to DEPENDENCY_DOWN rather than silently
  // giving up — an unclassified backend outage should still get bounded retry.
  if (err.name === 'NoHealthyBackendError') {
    return REASON_CODES.DEPENDENCY_DOWN;
  }

  return REASON_CODES.DEPENDENCY_DOWN;
}

module.exports = { REASON_CODES, NO_RETRY_REASON_CODES, classifyFailureReason };
