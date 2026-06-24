/**
 * Error Diagnosis Engine
 * Phân tích lỗi scraping → xác định lý do + hành động khắc phục
 */

const PATTERNS = [
  // HTTP Status Codes
  { match: /403/,            reason: 'BLOCKED_IP',         action: 'swap_proxy' },
  { match: /429/,            reason: 'RATE_LIMITED',       action: 'increase_delay' },
  { match: /503/,            reason: 'TEMP_BLOCK',         action: 'wait_longer' },
  { match: /401/,            reason: 'AUTH_REQUIRED',      action: 'renew_token' },
  { match: /too many requests/i, reason: 'RATE_LIMITED',  action: 'increase_delay' },

  // Captcha / Challenge
  { match: /captcha/i,       reason: 'CAPTCHA',            action: 'solve_captcha' },
  { match: /challenge/i,     reason: 'CHALLENGE',          action: 'solve_captcha' },
  { match: /cf-/i,           reason: 'CLOUDFLARE',         action: 'use_playwright' },
  { match: /cloudflare/i,    reason: 'CLOUDFLARE',         action: 'use_playwright' },

  // Amazon specific
  { match: /robodog/i,       reason: 'AMAZON_BOT_DETECT',  action: 'rotate_fingerprint' },
  { match: /sorry.*robot/i,  reason: 'AMAZON_BLOCK',       action: 'swap_proxy+delay' },
  { match: /enter the characters/i, reason: 'AMAZON_CAPTCHA', action: 'solve_captcha' },

  // Playwright specific
  { match: /TimeoutError/i,  reason: 'TIMEOUT',            action: 'increase_timeout' },
  { match: /Target closed/i, reason: 'BROWSER_CRASH',      action: 'restart_browser' },
  { match: /detected/i,      reason: 'PLAYWRIGHT_DETECT',  action: 'rotate_fingerprint' },
  { match: /blocked/i,       reason: 'BLOCKED',            action: 'swap_proxy+ua' },
  { match: /page crashed/i,  reason: 'BROWSER_CRASH',      action: 'restart_browser' },

  // Network
  { match: /ECONNRESET/i,    reason: 'CONNECTION_RESET',   action: 'retry_different_proxy' },
  { match: /ETIMEDOUT/i,     reason: 'TIMEOUT',            action: 'increase_timeout' },
  { match: /ENOTFOUND/i,     reason: 'DNS_FAIL',           action: 'change_dns' },
  { match: /ECONNREFUSED/i,  reason: 'CONNECTION_REFUSED', action: 'retry_different_proxy' },
  { match: /socket hang up/i, reason: 'CONNECTION_RESET',  action: 'retry_different_proxy' },

  // Validation
  { match: /empty/i,         reason: 'EMPTY_RESULT',       action: 'change_query' },
  { match: /unexpected token/i, reason: 'INVALID_RESPONSE', action: 'validate_html' },
];

/**
 * Diagnose what went wrong from an error.
 * @param {Error|string} err
 * @returns {{ reason: string, action: string }}
 */
function diagnose(err) {
  const msg = (err?.message || err || '').toString();

  for (const p of PATTERNS) {
    if (p.match.test(msg)) return { reason: p.reason, action: p.action };
  }

  return { reason: 'UNKNOWN', action: 'escalate_to_human' };
}

/**
 * Get a human-readable fix hint
 */
function getFixHint(reason) {
  const hints = {
    BLOCKED_IP:        '→ Swap proxy IP',
    RATE_LIMITED:      '→ Increase delay between requests',
    TEMP_BLOCK:        '→ Wait 30-60s then retry',
    AUTH_REQUIRED:     '→ Renew API token',
    CAPTCHA:           '→ Solve captcha or use different IP',
    CHALLENGE:         '→ Solve challenge or switch to browser',
    CLOUDFLARE:        '→ Use Playwright instead of HTTP client',
    AMAZON_BOT_DETECT: '→ Rotate fingerprint + proxy',
    AMAZON_BLOCK:      '→ Swap proxy and increase delay',
    TIMEOUT:           '→ Increase timeout or better proxy',
    BROWSER_CRASH:     '→ Restart browser',
    PLAYWRIGHT_DETECT: '→ Change fingerprint: UA, viewport, locale',
    BLOCKED:           '→ Swap proxy + rotate UA',
    CONNECTION_RESET:  '→ Use different proxy',
    DNS_FAIL:          '→ Change DNS or use different proxy',
    EMPTY_RESULT:      '→ Change search query',
    INVALID_RESPONSE:  '→ Response format changed, check HTML',
    UNKNOWN:           '→ Manual inspection needed',
  };
  return hints[reason] || '';
}

module.exports = { diagnose, getFixHint };
