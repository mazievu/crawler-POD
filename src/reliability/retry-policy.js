/**
 * Retry Policy & Error Classification
 * Differentiates transient retryable faults from fatal unrecoverable errors.
 */

const RETRYABLE_ERROR_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
  // §16: SERVER_TRANSIENT covers 500 too, not just 502/503/504 — a plain 500
  // was previously falling through to no match (non-retryable by omission).
  'RATE_LIMITED', '429', '500', '502', '503', '504', 'SOCKET_TIMEOUT',
  'PLAYWRIGHT_TIMEOUT', 'CDP_DISCONNECTED', 'STUCK_TIMEOUT',
  // Final Implementation Closure §1: StuckDetector's two-signal model reports
  // EXECUTION_LOST (dead heartbeat) / EXECUTION_STALLED (alive but no
  // progress) instead of one flat STUCK_TIMEOUT — both must stay retryable,
  // same as STUCK_TIMEOUT was.
  'EXECUTION_LOST', 'EXECUTION_STALLED',
  'SERVER_RESTART', 'SOCKET HANG UP', 'HANG UP', 'NETWORK_ERROR'
]);

const NON_RETRYABLE_ERROR_CODES = new Set([
  'INVALID_INPUT', '400', '401', '403', '404', 'AUTH_REQUIRED',
  'TOIDISPY_LOGIN_REQUIRED', 'LOGIN_REQUIRED', 'UNKNOWN_PLATFORM', 'NO_HEALTHY_BACKEND',
  'INVALID_SCHEMA', 'VALIDATION_FAILED',
  'ALL_SOURCES_FAILED', 'EBAY_ALL_SOURCES_FAILED', 'ETSY_ALL_SOURCES_FAILED',
  'APIFY_ENTITLEMENT_ERROR', 'BLOCKED_BY_SITE', 'BLOCKED_IP'
]);

class RetryPolicy {
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts || 3;
    this.baseDelayMs = options.baseDelayMs || 2000;
    this.maxDelayMs = options.maxDelayMs || 30000;
  }

  isRetryable(error) {
    if (!error) return false;
    const msg = String(error.message || error).toUpperCase();
    const code = String(error.code || error.name || '').toUpperCase();

    // Check explicit non-retryable first
    for (const nonRetry of NON_RETRYABLE_ERROR_CODES) {
      if (code.includes(nonRetry) || msg.includes(nonRetry)) {
        return false;
      }
    }

    // Check explicit retryable
    for (const retry of RETRYABLE_ERROR_CODES) {
      if (code.includes(retry) || msg.includes(retry)) {
        return true;
      }
    }

    // Common network or browser disconnection phrases
    if (
      msg.includes('TIMEOUT') ||
      msg.includes('RESET') ||
      msg.includes('DISCONNECTED') ||
      msg.includes('CLOSED') ||
      msg.includes('RATE LIMIT') ||
      msg.includes('TOO MANY REQUESTS') ||
      msg.includes('BUSY')
    ) {
      return true;
    }

    return false;
  }

  calculateBackoff(attempt = 1) {
    const exponent = Math.max(0, attempt - 1);
    const exponential = this.baseDelayMs * Math.pow(2, exponent);
    const jitter = Math.floor(Math.random() * 1000);
    return Math.min(this.maxDelayMs, exponential + jitter);
  }

  shouldRetry(attempt, error) {
    if (attempt >= this.maxAttempts) return false;
    return this.isRetryable(error);
  }
}

const defaultRetryPolicy = new RetryPolicy();

module.exports = {
  RetryPolicy,
  defaultRetryPolicy,
  RETRYABLE_ERROR_CODES,
  NON_RETRYABLE_ERROR_CODES
};
