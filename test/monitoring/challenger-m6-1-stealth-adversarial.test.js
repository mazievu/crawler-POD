'use strict';

/**
 * Challenger 1 Adversarial Test Suite for Milestone 6:
 * Stealth Browser Engine Runner (CloakBrowser with Camoufox Fallback).
 *
 * Verifies all 6 mandatory criteria:
 * 1. Priority 1 CloakBrowser verification: Cloak is invoked first on every capture.
 * 2. Challenge/Block detection: Cloudflare Turnstile, "Just a moment...", DataDome 403,
 *    HTTP 429/503, bot captchas, incomplete HTML without </html>.
 * 3. Automatic Camoufox fallback: bot block in Cloak immediately triggers Camoufox without
 *    throwing, succeeds if Camoufox succeeds (fallbackTriggered: true).
 * 4. Double-failure handling: when both Cloak and Camoufox fail, returns clean
 *    { status: 'blocked', fallbackTriggered: true } without unhandled exceptions.
 * 5. Metrics calculation: getBrowserMetrics() correctly updates totalRuns, avgDurationMs,
 *    and errorRatePct for both engines.
 * 6. Simulation 3: CloakBrowser Challenge Recovery with Camoufox Fallback.
 *
 * Plus adversarial edge case stress testing:
 * - Case sensitivity of closing tags (</HTML> vs </html>)
 * - String vs number status codes in block detection
 * - Engine execution sequence tracking
 * - High-concurrency metric accounting
 * - Outlier duration averaging
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  StealthBrowserRunner,
  detectBlockOrChallenge,
  captureWithStealthFallback,
} = require('../../src/marketplaces/stealth-browser');
const { AdminDashboardService } = require('../../src/admin/dashboard');

// =============================================================================
// 1. PRIORITY 1 CLOAKBROWSER VERIFICATION
// =============================================================================
test('Challenger 1.1: CloakBrowser is strictly invoked first before Camoufox', async () => {
  const runner = new StealthBrowserRunner();
  const callOrder = [];

  const res = await runner.captureWithFallback('https://etsy.com/shop/test1', {}, {
    cloakbrowser: async () => {
      callOrder.push('cloakbrowser');
      return { status: 'success', html: '<html><body>Cloak Shop</body></html>' };
    },
    camoufox: async () => {
      callOrder.push('camoufox');
      return { status: 'success', html: '<html><body>Camoufox Shop</body></html>' };
    },
  });

  assert.deepEqual(callOrder, ['cloakbrowser'], 'CloakBrowser must be executed first and Camoufox must not be called on success');
  assert.equal(res.engineUsed, 'cloakbrowser');
  assert.equal(res.fallbackTriggered, false);
  assert.equal(res.status, 'success');
});

test('Challenger 1.2: CloakBrowser success does NOT increment Camoufox metrics', async () => {
  const runner = new StealthBrowserRunner();

  await runner.captureWithFallback('https://etsy.com/shop/test2', {}, {
    cloakbrowser: async () => ({ status: 'success', html: '<html><body>OK</body></html>' }),
    camoufox: async () => ({ status: 'success', html: '<html><body>Should not run</body></html>' }),
  });

  const m = runner.getBrowserMetrics();
  assert.equal(m.cloakbrowser.totalRuns, 1);
  assert.equal(m.cloakbrowser.successes, 1);
  assert.equal(m.cloakbrowser.failures, 0);
  assert.equal(m.camoufox.totalRuns, 0);
  assert.equal(m.camoufox.successes, 0);
});

test('Challenger 1.3: Default offline capture defaults to CloakBrowser priority', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://etsy.com/shop/default-offline');

  assert.equal(res.engineUsed, 'cloakbrowser');
  assert.equal(res.fallbackTriggered, false);
  assert.equal(res.status, 'success');
  assert.ok(res.html.includes('Cloak Content'));
  assert.ok(res.durationMs >= 0);
});

test('Challenger 1.4: Options (cookies, headers, UA) are passed cleanly to CloakBrowser', async () => {
  const runner = new StealthBrowserRunner();
  let receivedOptions = null;

  await runner.captureWithFallback('https://etsy.com/shop/opts', {
    userAgent: 'AdversarialBot/2.0',
    cookies: [{ name: 'sess', value: 'xyz' }],
    timeoutMs: 15000,
  }, {
    cloakbrowser: async (url, opts) => {
      receivedOptions = opts;
      return { status: 'success', html: '<html><body>Opts OK</body></html>' };
    },
  });

  assert.ok(receivedOptions);
  assert.equal(receivedOptions.userAgent, 'AdversarialBot/2.0');
  assert.equal(receivedOptions.timeoutMs, 15000);
  assert.equal(receivedOptions.cookies[0].name, 'sess');
});

// =============================================================================
// 2. CHALLENGE & BLOCK DETECTION
// =============================================================================
test('Challenger 2.1: Cloudflare Turnstile detection in HTML and error', () => {
  // Test via HTML signatures
  const res1 = detectBlockOrChallenge({
    html: '<html><body><div class="cf-turnstile" data-sitekey="0x4AAAAAA"></div></body></html>',
    statusCode: 200,
  });
  assert.equal(res1.blocked, true);
  assert.equal(res1.reason, 'CLOUDFLARE_TURNSTILE');

  const res2 = detectBlockOrChallenge({
    html: '<html><body>cf_chl_opt = { cType: "non-interactive" };</body></html>',
    statusCode: 200,
  });
  assert.equal(res2.blocked, true);
  assert.equal(res2.reason, 'CLOUDFLARE_TURNSTILE');

  const res3 = detectBlockOrChallenge({
    html: '<html><body><span id="cf-browser-verification">Verifying</span></body></html>',
    statusCode: 200,
  });
  assert.equal(res3.blocked, true);
  assert.equal(res3.reason, 'CLOUDFLARE_TURNSTILE');

  // Test via error message
  const res4 = detectBlockOrChallenge({
    html: '<html><body>Nothing</body></html>',
    statusCode: 200,
    error: 'Cloudflare Turnstile challenge encountered',
  });
  assert.equal(res4.blocked, true);
  assert.ok(res4.reason.includes('Cloudflare Turnstile'));
});

test('Challenger 2.2: Cloudflare "Just a moment..." and "Attention Required!" detection', () => {
  const res1 = detectBlockOrChallenge({
    html: '<html><head><title>Just a moment...</title></head><body>Checking browser</body></html>',
    statusCode: 200,
  });
  assert.equal(res1.blocked, true);
  assert.equal(res1.reason, 'CLOUDFLARE_CHALLENGE');

  const res2 = detectBlockOrChallenge({
    pageTitle: 'Attention Required! | Cloudflare',
    html: '<html><body>DDoS protection</body></html>',
    statusCode: 200,
  });
  assert.equal(res2.blocked, true);
  assert.equal(res2.reason, 'CLOUDFLARE_CHALLENGE');
});

test('Challenger 2.3: DataDome 403 and script signatures detection', () => {
  // DataDome 403 HTTP status
  const res1 = detectBlockOrChallenge({ statusCode: 403, html: '<html><body>Access Denied</body></html>' });
  assert.equal(res1.blocked, true);
  assert.equal(res1.reason, 'HTTP_403_FORBIDDEN');

  // DataDome script in 200 page
  const res2 = detectBlockOrChallenge({
    statusCode: 200,
    html: '<html><script src="https://geo.captcha-delivery.com/captcha/dd.js"></script></html>',
  });
  assert.equal(res2.blocked, true);
  assert.equal(res2.reason, 'DATADOME_CAPTCHA');

  // DataDome error
  const res3 = detectBlockOrChallenge({
    statusCode: 200,
    html: '<html><body>OK</body></html>',
    error: 'DataDome intercepted request with captcha',
  });
  assert.equal(res3.blocked, true);
  assert.ok(res3.reason.includes('DataDome'));
});

test('Challenger 2.4: HTTP 429 and HTTP 503 block detection', () => {
  const res429 = detectBlockOrChallenge({ statusCode: 429, html: '<html><body>Too many requests</body></html>' });
  assert.equal(res429.blocked, true);
  assert.equal(res429.reason, 'HTTP_429_TOO_MANY_REQUESTS');

  const res503 = detectBlockOrChallenge({ statusCode: 503, html: '<html><body>Service temporarily unavailable</body></html>' });
  assert.equal(res503.blocked, true);
  assert.equal(res503.reason, 'HTTP_503_SERVICE_UNAVAILABLE');
});

test('Challenger 2.5: Bot captcha challenges across multiple variants', () => {
  const variants = [
    { html: '<div>Please verify you are human to continue</div>', expected: 'CAPTCHA_CHALLENGE' },
    { html: '<div>Verify you are a human</div>', expected: 'CAPTCHA_CHALLENGE' },
    { html: '<title>Robot Check</title><body>Amazon Robot Check</body>', expected: 'CAPTCHA_CHALLENGE' },
    { html: '<p>Our systems have detected unusual traffic from your computer network</p>', expected: 'CAPTCHA_CHALLENGE' },
    { html: '<p>Pardon our interruption while we verify your account</p>', expected: 'CAPTCHA_CHALLENGE' },
    { html: '<div>automated access detected</div>', expected: 'CAPTCHA_CHALLENGE' },
    { html: '<div class="g-recaptcha" data-sitekey="xyz"></div>', expected: 'CAPTCHA_CHALLENGE' },
    { html: '<div class="h-captcha" data-sitekey="abc"></div>', expected: 'CAPTCHA_CHALLENGE' },
  ];

  for (const v of variants) {
    const res = detectBlockOrChallenge({ html: `<html><body>${v.html}</body></html>`, statusCode: 200 });
    assert.equal(res.blocked, true, `Variant "${v.html}" must be detected as blocked`);
    assert.equal(res.reason, v.expected);
  }
});

test('Challenger 2.6: Incomplete HTML without </html> detection', () => {
  const incomplete = '<html><head><title>Etsy</title></head><body><div id="listing">Partial listing content that dropped conn';
  const res = detectBlockOrChallenge({ html: incomplete, statusCode: 200 });
  assert.equal(res.blocked, true);
  assert.equal(res.reason, 'TRUNCATED_HTML');

  // Complete HTML should pass
  const complete = '<html><head><title>Etsy</title></head><body><div>Complete</div></body></html>';
  const resComplete = detectBlockOrChallenge({ html: complete, statusCode: 200 });
  assert.equal(resComplete.blocked, false);
  assert.equal(resComplete.reason, null);
});

test('Challenger 2.7: Positional argument compatibility for detectBlockOrChallenge', () => {
  const resPos403 = detectBlockOrChallenge('<html><body>Err</body></html>', 403);
  assert.equal(resPos403.blocked, true);
  assert.equal(resPos403.reason, 'HTTP_403_FORBIDDEN');

  const resPosErr = detectBlockOrChallenge('<html><body>Ok</body></html>', 200, new Error('Cloudflare turnstile'));
  assert.equal(resPosErr.blocked, true);

  const resPosClean = detectBlockOrChallenge('<html><body>Valid</body></html>', 200);
  assert.equal(resPosClean.blocked, false);
});

// =============================================================================
// 3. AUTOMATIC CAMOUFOX FALLBACK
// =============================================================================
test('Challenger 3.1: Cloak bot block triggers Camoufox without throwing and returns fallbackTriggered = true', async () => {
  const runner = new StealthBrowserRunner();
  let camoufoxInvoked = false;

  const res = await runner.captureWithFallback('https://etsy.com/listing/cf-block', {}, {
    cloakbrowser: async () => ({
      status: 'blocked',
      error: 'Cloudflare Turnstile Challenge',
      html: '<html><body>Just a moment...</body></html>',
    }),
    camoufox: async () => {
      camoufoxInvoked = true;
      return {
        status: 'success',
        html: '<html><body><div class="shop">Camoufox Recovered Shop</div></body></html>',
      };
    },
  });

  assert.equal(camoufoxInvoked, true, 'Camoufox must be invoked on Cloak block');
  assert.equal(res.status, 'success');
  assert.equal(res.engineUsed, 'camoufox');
  assert.equal(res.fallbackTriggered, true);
  assert.ok(res.html.includes('Camoufox Recovered Shop'));
});

test('Challenger 3.2: Cloak unhandled crash / exception triggers Camoufox without bubbling exception', async () => {
  const runner = new StealthBrowserRunner();
  let camoufoxInvoked = false;

  const res = await runner.captureWithFallback('https://etsy.com/shop/crash', {}, {
    cloakbrowser: async () => {
      throw new Error('CloakBrowser browser crashed (SIGSEGV)');
    },
    camoufox: async () => {
      camoufoxInvoked = true;
      return { status: 'success', html: '<html><body>Camoufox Handled Crash</body></html>' };
    },
  });

  assert.equal(camoufoxInvoked, true);
  assert.equal(res.status, 'success');
  assert.equal(res.engineUsed, 'camoufox');
  assert.equal(res.fallbackTriggered, true);
});

test('Challenger 3.3: Cloak returns status=success but content is Cloudflare challenge -> triggers Camoufox', async () => {
  const runner = new StealthBrowserRunner();
  let camoufoxInvoked = false;

  // Sneaky server returning 200 OK with "Just a moment..." challenge
  const res = await runner.captureWithFallback('https://etsy.com/shop/sneaky', {}, {
    cloakbrowser: async () => ({
      status: 'success',
      statusCode: 200,
      pageTitle: 'Just a moment...',
      html: '<html><body>Checking your browser before accessing etsy.com</body></html>',
    }),
    camoufox: async () => {
      camoufoxInvoked = true;
      return { status: 'success', html: '<html><body>Real Shop Content</body></html>' };
    },
  });

  assert.equal(camoufoxInvoked, true, 'Challenge interstitial must be caught even if Cloak reported status: success');
  assert.equal(res.engineUsed, 'camoufox');
  assert.equal(res.fallbackTriggered, true);
  assert.equal(res.status, 'success');
  assert.ok(res.html.includes('Real Shop Content'));
});

// =============================================================================
// 4. DOUBLE-FAILURE HANDLING
// =============================================================================
test('Challenger 4.1: Clean double-failure handling when both Cloak and Camoufox are blocked', async () => {
  const runner = new StealthBrowserRunner();

  const res = await runner.captureWithFallback('https://etsy.com/shop/fortress', {}, {
    cloakbrowser: async () => ({ status: 'blocked', error: 'DataDome 403' }),
    camoufox: async () => ({ status: 'blocked', error: 'DataDome 403 Captcha' }),
  });

  assert.equal(res.status, 'blocked');
  assert.equal(res.engineUsed, 'camoufox');
  assert.equal(res.fallbackTriggered, true);
  assert.equal(res.error, 'Both CloakBrowser and Camoufox blocked or failed');
  assert.ok(res.durationMs >= 0);
});

test('Challenger 4.2: Cloak throws crash, Camoufox is blocked -> clean blocked result without unhandled exception', async () => {
  const runner = new StealthBrowserRunner();

  const res = await runner.captureWithFallback('https://etsy.com/shop/double-fail-mix', {}, {
    cloakbrowser: async () => { throw new Error('Cloak connection timeout'); },
    camoufox: async () => ({ status: 'blocked', error: 'HTTP 429 Too Many Requests' }),
  });

  assert.equal(res.status, 'blocked');
  assert.equal(res.fallbackTriggered, true);
  assert.equal(res.engineUsed, 'camoufox');
  assert.ok(res.error.includes('Both CloakBrowser and Camoufox blocked or failed'));
});

test('Challenger 4.3: Camoufox timeout error bubbles up for scheduler backoff handling', async () => {
  const runner = new StealthBrowserRunner();

  await assert.rejects(async () => {
    await runner.captureWithFallback('https://etsy.com/shop/camou-timeout', {}, {
      cloakbrowser: async () => ({ status: 'blocked' }),
      camoufox: async () => { throw new Error('Camoufox Navigation Timeout 20000ms'); },
    });
  }, /timeout/i);
});

// =============================================================================
// 5. METRICS CALCULATION INTEGRITY
// =============================================================================
test('Challenger 5.1: Zero state metrics integrity', () => {
  const runner = new StealthBrowserRunner();
  const m = runner.getBrowserMetrics();

  assert.equal(m.cloakbrowser.totalRuns, 0);
  assert.equal(m.cloakbrowser.successfulRuns, 0);
  assert.equal(m.cloakbrowser.blockedRuns, 0);
  assert.equal(m.cloakbrowser.errorRuns, 0);
  assert.equal(m.cloakbrowser.failures, 0);
  assert.equal(m.cloakbrowser.avgDurationMs, 0);
  assert.equal(m.cloakbrowser.errorRatePct, 0.0);
  assert.equal(m.cloakbrowser.blockRatePct, 0.0);

  assert.equal(m.camoufox.totalRuns, 0);
  assert.equal(m.camoufox.successfulRuns, 0);
  assert.equal(m.camoufox.blockedRuns, 0);
  assert.equal(m.camoufox.errorRuns, 0);
  assert.equal(m.camoufox.failures, 0);
  assert.equal(m.camoufox.avgDurationMs, 0);
  assert.equal(m.camoufox.errorRatePct, 0.0);
  assert.equal(m.camoufox.blockRatePct, 0.0);
});

test('Challenger 5.2: Cloak success metrics update correctly', async () => {
  const runner = new StealthBrowserRunner();

  await runner.captureWithFallback('https://etsy.com/s1', {}, {
    cloakbrowser: async () => {
      await new Promise(r => setTimeout(r, 10));
      return { status: 'success', html: '<html>OK</html>' };
    },
  });

  const m = runner.getBrowserMetrics();
  assert.equal(m.cloakbrowser.totalRuns, 1);
  assert.equal(m.cloakbrowser.successfulRuns, 1);
  assert.equal(m.cloakbrowser.errorRatePct, 0.0);
  assert.ok(m.cloakbrowser.avgDurationMs >= 10);
  assert.equal(m.camoufox.totalRuns, 0);
});

test('Challenger 5.3: Fallback success metrics update both Cloak (failure) and Camoufox (success)', async () => {
  const runner = new StealthBrowserRunner();

  await runner.captureWithFallback('https://etsy.com/fallback-metric', {}, {
    cloakbrowser: async () => ({ status: 'blocked', error: 'Cloudflare 403' }),
    camoufox: async () => ({ status: 'success', html: '<html>OK</html>' }),
  });

  const m = runner.getBrowserMetrics();
  // Cloak: 1 run, 1 failure -> 100% error rate
  assert.equal(m.cloakbrowser.totalRuns, 1);
  assert.equal(m.cloakbrowser.blockedRuns, 1);
  assert.equal(m.cloakbrowser.errorRatePct, 100.0);

  // Camoufox: 1 run, 1 success -> 0% error rate
  assert.equal(m.camoufox.totalRuns, 1);
  assert.equal(m.camoufox.successfulRuns, 1);
  assert.equal(m.camoufox.errorRatePct, 0.0);
});

test('Challenger 5.4: Double failure metrics update both engines with 100% error rate', async () => {
  const runner = new StealthBrowserRunner();

  await runner.captureWithFallback('https://etsy.com/both-fail', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'blocked' }),
  });

  const m = runner.getBrowserMetrics();
  assert.equal(m.cloakbrowser.totalRuns, 1);
  assert.equal(m.cloakbrowser.errorRatePct, 100.0);
  assert.equal(m.camoufox.totalRuns, 1);
  assert.equal(m.camoufox.errorRatePct, 100.0);
});

test('Challenger 5.5: Ratio calculations with 1 decimal place precision', async () => {
  const runner = new StealthBrowserRunner();

  // 1 failure, 2 successes in Cloak
  await runner.captureWithFallback('https://etsy.com/1', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'success', html: 'ok' }),
  });
  await runner.captureWithFallback('https://etsy.com/2', {}, {
    cloakbrowser: async () => ({ status: 'success', html: '<html>ok</html>' }),
  });
  await runner.captureWithFallback('https://etsy.com/3', {}, {
    cloakbrowser: async () => ({ status: 'success', html: '<html>ok</html>' }),
  });

  const m = runner.getBrowserMetrics();
  assert.equal(m.cloakbrowser.totalRuns, 3);
  assert.equal(m.cloakbrowser.successfulRuns, 2);
  assert.equal(m.cloakbrowser.failures, 1);
  assert.equal(m.cloakbrowser.errorRatePct, 33.3);

  assert.equal(m.camoufox.totalRuns, 1);
  assert.equal(m.camoufox.successfulRuns, 1);
  assert.equal(m.camoufox.errorRatePct, 0.0);
});

test('Challenger 5.6: resetMetrics clears all metrics', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://etsy.com/r1');
  assert.equal(runner.getBrowserMetrics().cloakbrowser.totalRuns, 1);

  runner.resetMetrics();
  const reset = runner.getBrowserMetrics();
  assert.equal(reset.cloakbrowser.totalRuns, 0);
  assert.equal(reset.camoufox.totalRuns, 0);
});

// =============================================================================
// 6. SIMULATION 3 VERIFICATION
// =============================================================================
test('Challenger 6.1: Full Simulation 3 CloakBrowser Challenge Recovery with Camoufox Fallback', async () => {
  const runner = new StealthBrowserRunner();
  const service = new AdminDashboardService(runner);

  const targetUrl = 'https://www.etsy.com/shop/stealth-target';

  const captureResult = await runner.captureWithFallback(targetUrl, {}, {
    cloakbrowser: async () => ({
      status: 'blocked',
      error: 'Cloudflare Turnstile Challenge 403',
    }),
    camoufox: async () => ({
      status: 'success',
      html: '<html><body><div id="shop-name">Stealth Master</div></body></html>',
    }),
  });

  // Verify result invariants
  assert.equal(captureResult.status, 'success');
  assert.equal(captureResult.engineUsed, 'camoufox');
  assert.equal(captureResult.fallbackTriggered, true);
  assert.ok(captureResult.html.includes('Stealth Master'));

  // Verify AdminDashboardService metrics bridge
  const metrics = service.getBrowserMetrics();
  assert.equal(metrics.cloakbrowser.totalRuns, 1);
  assert.equal(metrics.cloakbrowser.errorRatePct, 100.0);
  assert.equal(metrics.camoufox.totalRuns, 1);
  assert.equal(metrics.camoufox.errorRatePct, 0.0);
});

// =============================================================================
// 7. ADVERSARIAL STRESS TESTS (High Concurrency & Boundary Conditions)
// =============================================================================
test('Challenger 7.1: High concurrent calls thread-safety', async () => {
  const runner = new StealthBrowserRunner();
  const count = 50;

  const tasks = Array.from({ length: count }, (_, i) => {
    if (i % 2 === 0) {
      // Success on Cloak
      return runner.captureWithFallback(`https://etsy.com/parallel-${i}`, {}, {
        cloakbrowser: async () => ({ status: 'success', html: '<html><body>ok</body></html>' }),
      });
    } else {
      // Blocked on Cloak, success on Camoufox
      return runner.captureWithFallback(`https://etsy.com/parallel-${i}`, {}, {
        cloakbrowser: async () => ({ status: 'blocked', error: 'Turnstile' }),
        camoufox: async () => ({ status: 'success', html: '<html><body>bypassed</body></html>' }),
      });
    }
  });

  const results = await Promise.all(tasks);
  assert.equal(results.length, 50);

  const m = runner.getBrowserMetrics();
  assert.equal(m.cloakbrowser.totalRuns, 50);
  assert.equal(m.cloakbrowser.successfulRuns, 25);
  assert.equal(m.cloakbrowser.blockedRuns, 25);
  assert.equal(m.cloakbrowser.errorRatePct, 50.0);

  assert.equal(m.camoufox.totalRuns, 25);
  assert.equal(m.camoufox.successfulRuns, 25);
  assert.equal(m.camoufox.errorRatePct, 0.0);
});

test('Challenger 7.2: Adversarial check on uppercase </HTML> tag handling', () => {
  // Website returns valid uppercase HTML
  const uppercaseHtml = '<!DOCTYPE HTML><HTML><HEAD><TITLE>OK</TITLE></HEAD><BODY>VALID HTML</BODY></HTML>';
  const res = detectBlockOrChallenge({ html: uppercaseHtml, statusCode: 200 });

  // HTML tag names are case-insensitive: a complete uppercase document must not
  // be misclassified as TRUNCATED_HTML (which would force a needless fallback).
  assert.equal(res.blocked, false);
  assert.equal(res.reason, null);
});

test('Challenger 7.3: Adversarial check on string vs numeric statusCode in object input', () => {
  // Numeric statusCode 403
  const resNumeric = detectBlockOrChallenge({ statusCode: 403 });
  assert.equal(resNumeric.blocked, true);
  assert.equal(resNumeric.reason, 'HTTP_403_FORBIDDEN');

  // Positional string "403" gets parsed via parseInt(statusOrOptions, 10)
  const resPositional = detectBlockOrChallenge('<html></html>', '403');
  assert.equal(resPositional.blocked, true);
  assert.equal(resPositional.reason, 'HTTP_403_FORBIDDEN');
});

test('Challenger 7.4: Multi-vector mixed error cascade sequence', async () => {
  const runner = new StealthBrowserRunner();

  // Sequence of 4 diverse calls
  // 1. Cloak 503 -> Camoufox 200
  const r1 = await runner.captureWithFallback('https://etsy.com/seq1', {}, {
    cloakbrowser: async () => ({ statusCode: 503, html: '<html>503 Service Unavailable</html>' }),
    camoufox: async () => ({ status: 'success', html: '<html><body>Recovered 1</body></html>' }),
  });
  assert.equal(r1.fallbackTriggered, true);
  assert.equal(r1.engineUsed, 'camoufox');

  // 2. Cloak Turnstile -> Camoufox 200
  const r2 = await runner.captureWithFallback('https://etsy.com/seq2', {}, {
    cloakbrowser: async () => ({ html: '<html><div class="cf-turnstile"></div></html>' }),
    camoufox: async () => ({ status: 'success', html: '<html><body>Recovered 2</body></html>' }),
  });
  assert.equal(r2.fallbackTriggered, true);

  // 3. Cloak Success -> Camoufox untouched
  const r3 = await runner.captureWithFallback('https://etsy.com/seq3', {}, {
    cloakbrowser: async () => ({ status: 'success', html: '<html><body>Clean Cloak</body></html>' }),
    camoufox: async () => { throw new Error('Must not be called'); },
  });
  assert.equal(r3.fallbackTriggered, false);
  assert.equal(r3.engineUsed, 'cloakbrowser');

  // 4. Cloak 429 -> Camoufox 403 DataDome (Double failure)
  const r4 = await runner.captureWithFallback('https://etsy.com/seq4', {}, {
    cloakbrowser: async () => ({ statusCode: 429, html: '<html>Too Many Requests</html>' }),
    camoufox: async () => ({ statusCode: 403, html: '<html>DataDome Block</html>' }),
  });
  assert.equal(r4.fallbackTriggered, true);
  assert.equal(r4.status, 'blocked');

  // Check cumulative metrics
  const m = runner.getBrowserMetrics();
  // Cloak: 4 runs, 1 success (seq3), 3 blocks (seq1, seq2, seq4) -> 75% error rate
  assert.equal(m.cloakbrowser.totalRuns, 4);
  assert.equal(m.cloakbrowser.successfulRuns, 1);
  assert.equal(m.cloakbrowser.blockedRuns, 3);
  assert.equal(m.cloakbrowser.errorRatePct, 75.0);

  // Camoufox: 3 runs (seq1, seq2, seq4), 2 successes, 1 block -> 33.3% error rate
  assert.equal(m.camoufox.totalRuns, 3);
  assert.equal(m.camoufox.successfulRuns, 2);
  assert.equal(m.camoufox.blockedRuns, 1);
  assert.equal(m.camoufox.errorRatePct, 33.3);
});

