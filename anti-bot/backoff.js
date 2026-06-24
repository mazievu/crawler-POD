/**
 * Backoff Calculator
 * Chiến lược chờ thông minh giữa các lần retry
 */

/**
 * Calculate wait time before next retry attempt
 * @param {number} attempt - Attempt number (1-based)
 * @param {object} config - Backoff config from strategy
 * @returns {number} Milliseconds to wait
 */
function calculateBackoff(attempt, config = {}) {
  const {
    backoff = 'exponential',
    baseDelay = 1000,
    maxDelay = 120000,
    sequence = [],
    jitter = true,
  } = config;

  let delay;

  switch (backoff) {
    case 'linear':
      delay = baseDelay * attempt;
      break;

    case 'exponential':
      delay = baseDelay * Math.pow(2, attempt - 1);
      break;

    case 'custom':
      delay = sequence[attempt - 1] || sequence[sequence.length - 1] || baseDelay;
      break;

    case 'fixed':
      delay = baseDelay;
      break;

    default:
      delay = baseDelay * Math.pow(2, attempt - 1);
  }

  // Cap at maxDelay
  delay = Math.min(delay, maxDelay);

  // Add jitter (±20%) to avoid thundering herd
  if (jitter) {
    const jitterFactor = 0.8 + Math.random() * 0.4; // 0.8 - 1.2
    delay = Math.round(delay * jitterFactor);
  }

  return delay;
}

/**
 * Escalate strategy based on attempt count
 * Trả về action cần làm thêm ở attempt này
 */
function getEscalationStep(attempt) {
  const ladder = [
    { minAttempt: 1, action: 'basic_request',              proxy: false },
    { minAttempt: 2, action: 'swap_user_agent',             proxy: false },
    { minAttempt: 3, action: 'swap_proxy',                  proxy: true },
    { minAttempt: 4, action: 'rotate_viewport_and_headers', proxy: true },
    { minAttempt: 5, action: 'add_stealth_plugins',         proxy: true },
    { minAttempt: 6, action: 'change_fingerprint_complete', proxy: true },
    { minAttempt: 7, action: 'use_mobile_emulation',        proxy: true },
    { minAttempt: 8, action: 'change_proxy_region',         proxy: true },
    { minAttempt: 9, action: 'solve_captcha_if_needed',     proxy: true },
    { minAttempt: 10, action: 'log_failure_skip_platform',  proxy: true },
  ];

  // Find highest applicable step
  let step = ladder[0];
  for (const s of ladder) {
    if (attempt >= s.minAttempt) step = s;
  }
  return step;
}

module.exports = { calculateBackoff, getEscalationStep };
