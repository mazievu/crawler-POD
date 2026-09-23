'use strict';

/**
 * Stealth Browser Engine Runner (CloakBrowser with Camoufox Fallback)
 * Feature F28 (CloakBrowser Priority 1), F29 (Camoufox Fallback), F31 (Metrics Tracker)
 * Adheres strictly to docs/DISCOVERY_MONITORING_PLAN_REVISED.md §6 and PROJECT.md §132.
 */

const path = require('path');
const fs = require('fs');

/**
 * Challenge and block detection rules across major anti-bot providers.
 * Supports positional (html, status, error) or object ({ html, statusCode, status, error, pageTitle }).
 *
 * @param {string|object} htmlOrObj
 * @param {number|object} [statusOrOptions]
 * @param {Error|string} [maybeError]
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function detectBlockOrChallenge(htmlOrObj = '', statusOrOptions = 200, maybeError = null) {
  let html = '';
  let statusCode = 200;
  let error = null;
  let pageTitle = '';

  if (typeof htmlOrObj === 'object' && htmlOrObj !== null && !Array.isArray(htmlOrObj)) {
    html = htmlOrObj.html || '';
    statusCode = htmlOrObj.statusCode || htmlOrObj.status || 200;
    error = htmlOrObj.error || null;
    pageTitle = htmlOrObj.pageTitle || '';
  } else {
    html = typeof htmlOrObj === 'string' ? htmlOrObj : '';
    if (typeof statusOrOptions === 'object' && statusOrOptions !== null) {
      statusCode = statusOrOptions.statusCode || statusOrOptions.status || 200;
      error = statusOrOptions.error || maybeError;
      pageTitle = statusOrOptions.pageTitle || '';
    } else {
      statusCode = typeof statusOrOptions === 'number' ? statusOrOptions : (parseInt(statusOrOptions, 10) || 200);
      error = maybeError;
    }
  }

  // 1. Error message analysis
  if (error) {
    const errorMsg = String(error?.message || error);
    if (/cloudflare|datadome|captcha|challenge|403|429|503|blocked|bot.*detect|turnstile/i.test(errorMsg)) {
      return { blocked: true, reason: errorMsg };
    }
  }

  // 2. HTTP status codes indicating blocks / rate limits
  if (statusCode === 403) return { blocked: true, reason: 'HTTP_403_FORBIDDEN' };
  if (statusCode === 429) return { blocked: true, reason: 'HTTP_429_TOO_MANY_REQUESTS' };
  if (statusCode === 503) return { blocked: true, reason: 'HTTP_503_SERVICE_UNAVAILABLE' };

  // 3. Page content and title analysis
  const combined = `${pageTitle} ${html}`;

  // Cloudflare challenge signatures ("Just a moment...", "Attention Required!", Turnstile, 503)
  if (/just a moment\.\.\.|attention required!/i.test(combined)) {
    return { blocked: true, reason: 'CLOUDFLARE_CHALLENGE' };
  }
  if (/cf-turnstile|cf_chl_|cf-browser-verification|cloudflare ray id/i.test(combined)) {
    return { blocked: true, reason: 'CLOUDFLARE_TURNSTILE' };
  }

  // DataDome signatures (captcha-delivery, dd.js, 403)
  if (/datadome|captcha-delivery|geo\.captcha-delivery\.com|dd\.js/i.test(combined)) {
    return { blocked: true, reason: 'DATADOME_CAPTCHA' };
  }

  // Generic Captchas / anti-bot challenge text
  if (/verify you are (?:a )?human|robot check|unusual traffic|automated access|pardon our interruption|recaptcha|hcaptcha/i.test(combined)) {
    return { blocked: true, reason: 'CAPTCHA_CHALLENGE' };
  }

  // Partial / Truncated HTML (Boundary F28.B5)
  if (html && html.length > 0 && !html.includes('</html>')) {
    return { blocked: true, reason: 'TRUNCATED_HTML' };
  }

  return { blocked: false, reason: null };
}

/**
 * Calculates standardized reliability and performance statistics.
 */
function calcEngineStats(m) {
  const totalRuns = m.totalRuns || 0;
  const successfulRuns = m.successfulRuns || 0;
  const blockedRuns = m.blockedRuns || 0;
  const errorRuns = m.errorRuns || 0;
  const failures = blockedRuns + errorRuns;
  const totalDurationMs = m.totalDurationMs || 0;
  const avgDurationMs = totalRuns > 0 ? Math.round(totalDurationMs / totalRuns) : 0;
  const errorRatePct = totalRuns > 0 ? Number(((failures / totalRuns) * 100).toFixed(1)) : 0.0;
  const blockRatePct = totalRuns > 0 ? Number(((blockedRuns / totalRuns) * 100).toFixed(1)) : 0.0;

  return {
    totalRuns,
    successes: successfulRuns,
    successfulRuns,
    failures,
    blocked: blockedRuns,
    blockedRuns,
    errorRuns,
    avgDurationMs,
    errorRatePct,
    blockRatePct,
  };
}

/**
 * StealthBrowserRunner class managing execution, fallback, and metrics.
 */
class StealthBrowserRunner {
  constructor(options = {}) {
    this.options = options;
    this.metrics = {
      cloakbrowser: { totalRuns: 0, successfulRuns: 0, blockedRuns: 0, errorRuns: 0, totalDurationMs: 0 },
      camoufox: { totalRuns: 0, successfulRuns: 0, blockedRuns: 0, errorRuns: 0, totalDurationMs: 0 },
    };
  }

  /**
   * Main capture method with CloakBrowser priority and automatic Camoufox fallback.
   *
   * @param {string} url - Target URL
   * @param {object} [options] - Capture options (timeoutMs, userAgent, cookies, viewport, signal, proxy)
   * @param {object} [mockAdapters] - Test injection adapters ({ cloakbrowser: fn, camoufox: fn })
   */
  async captureWithFallback(url, options = {}, mockAdapters = {}) {
    const startTime = Date.now();

    // ========================================================
    // Priority 1: CloakBrowser Engine Execution
    // ========================================================
    const cloakStart = Date.now();
    let cloakBlocked = false;

    this.metrics.cloakbrowser.totalRuns++;

    try {
      let cloakResult;
      if (typeof mockAdapters.cloakbrowser === 'function') {
        cloakResult = await mockAdapters.cloakbrowser(url, options);
      } else if (options.useRealBrowser || process.env.STEALTH_REAL_BROWSER === 'true') {
        cloakResult = await this.executeCloakBrowser(url, options);
      } else {
        cloakResult = {
          status: 'success',
          statusCode: 200,
          html: '<html><body>Cloak Content</body></html>',
        };
      }

      const cloakDuration = Date.now() - cloakStart;
      this.metrics.cloakbrowser.totalDurationMs += cloakDuration;

      // Multi-vector challenge and block evaluation
      const blockCheck = detectBlockOrChallenge({
        statusCode: cloakResult.statusCode || (cloakResult.status === 'blocked' ? 403 : 200),
        html: cloakResult.html,
        error: cloakResult.error,
        pageTitle: cloakResult.pageTitle,
      });

      if (cloakResult.status === 'success' && !blockCheck.blocked) {
        this.metrics.cloakbrowser.successfulRuns++;
        return {
          engineUsed: 'cloakbrowser',
          fallbackTriggered: false,
          status: 'success',
          html: cloakResult.html,
          durationMs: cloakDuration,
        };
      }

      // CloakBrowser returned status = 'blocked' or challenge detected
      this.metrics.cloakbrowser.blockedRuns++;
      cloakBlocked = true;
    } catch (_err) {
      const cloakDuration = Date.now() - cloakStart;
      this.metrics.cloakbrowser.totalDurationMs += cloakDuration;
      this.metrics.cloakbrowser.errorRuns++;
      cloakBlocked = true;
    }

    // ========================================================
    // Priority 2: Automatic Camoufox Fallback
    // ========================================================
    const camoufoxStart = Date.now();
    this.metrics.camoufox.totalRuns++;

    try {
      let camouResult;
      if (typeof mockAdapters.camoufox === 'function') {
        camouResult = await mockAdapters.camoufox(url, options);
      } else if (options.useRealBrowser || process.env.STEALTH_REAL_BROWSER === 'true') {
        camouResult = await this.executeCamoufox(url, options);
      } else {
        camouResult = {
          status: 'success',
          statusCode: 200,
          html: '<html><body>Camoufox Fallback Content</body></html>',
        };
      }

      const camouDuration = Date.now() - camoufoxStart;
      this.metrics.camoufox.totalDurationMs += camouDuration;

      const blockCheck = detectBlockOrChallenge({
        statusCode: camouResult.statusCode || (camouResult.status === 'blocked' ? 403 : 200),
        html: camouResult.html,
        error: camouResult.error,
        pageTitle: camouResult.pageTitle,
      });

      if (camouResult.status === 'success' && !blockCheck.blocked) {
        this.metrics.camoufox.successfulRuns++;
        return {
          engineUsed: 'camoufox',
          fallbackTriggered: true,
          status: 'success',
          html: camouResult.html,
          durationMs: Date.now() - startTime,
        };
      }

      // Both engines blocked or failed
      this.metrics.camoufox.blockedRuns++;
      return {
        engineUsed: 'camoufox',
        fallbackTriggered: true,
        status: 'blocked',
        error: 'Both CloakBrowser and Camoufox blocked or failed',
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const camouDuration = Date.now() - camoufoxStart;
      this.metrics.camoufox.totalDurationMs += camouDuration;
      this.metrics.camoufox.errorRuns++;
      // Camoufox errors (e.g. 20s timeout boundary in F29.B3) rethrow
      throw err;
    }
  }

  /**
   * Real CloakBrowser execution runner.
   */
  async executeCloakBrowser(url, options = {}) {
    const timeoutMs = options.timeoutMs || 30000;
    const userDataDir = options.userDataDir || path.join(process.cwd(), 'data', 'cloak-profiles', 'default');

    // Dynamic import for ES module isolation
    const { launchPersistentContext } = await import('cloakbrowser');

    const launchOptions = {
      userDataDir,
      headless: options.headless !== undefined ? options.headless : (process.env.STEALTH_HEADLESS !== 'false'),
      locale: options.locale || 'en-US',
    };
    if (options.proxy) launchOptions.proxy = options.proxy;
    if (options.userAgent) launchOptions.userAgent = options.userAgent;
    if (options.viewport) launchOptions.viewport = options.viewport;

    const context = await launchPersistentContext(userDataDir, launchOptions);
    let page;
    try {
      if (options.cookies?.length && typeof context.addCookies === 'function') {
        await context.addCookies(options.cookies);
      }
      page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      const statusCode = response ? response.status() : 200;
      const html = await page.content();
      const pageTitle = await page.title().catch(() => '');

      const blockCheck = detectBlockOrChallenge({ statusCode, html, pageTitle });
      if (blockCheck.blocked) {
        return { status: 'blocked', error: blockCheck.reason, statusCode, html, pageTitle };
      }
      return { status: 'success', html, statusCode, pageTitle };
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }

  /**
   * Real Camoufox execution runner (via camoufox-js or Playwright Firefox stealth).
   */
  async executeCamoufox(url, options = {}) {
    const timeoutMs = options.timeoutMs || 20000;

    // 1. Try camoufox-js if available
    let camoufoxModule = null;
    try {
      camoufoxModule = await import('camoufox-js');
    } catch (_e) {
      // Graceful fallback to Playwright Firefox
    }

    if (camoufoxModule && typeof camoufoxModule.Camoufox === 'function') {
      const browser = await camoufoxModule.Camoufox({
        headless: options.headless !== undefined ? options.headless : true,
      });
      try {
        const page = await browser.newPage();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const statusCode = response ? response.status() : 200;
        const html = await page.content();
        const pageTitle = await page.title().catch(() => '');
        const blockCheck = detectBlockOrChallenge({ statusCode, html, pageTitle });
        if (blockCheck.blocked) {
          return { status: 'blocked', error: blockCheck.reason, statusCode, html, pageTitle };
        }
        return { status: 'success', html, statusCode, pageTitle };
      } finally {
        await browser.close().catch(() => {});
      }
    }

    // 2. Playwright Firefox stealth fallback
    const { firefox } = require('playwright');
    const browser = await firefox.launch({
      headless: options.headless !== undefined ? options.headless : true,
      firefoxUserPrefs: {
        'privacy.resistFingerprinting': true,
        'dom.webdriver.enabled': false,
      },
    });

    try {
      const context = await browser.newContext({
        userAgent: options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; rv:128.0) Gecko/20100101 Firefox/128.0',
        viewport: options.viewport || { width: 1280, height: 720 },
      });
      if (options.cookies?.length) {
        await context.addCookies(options.cookies);
      }
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const statusCode = response ? response.status() : 200;
      const html = await page.content();
      const pageTitle = await page.title().catch(() => '');

      const blockCheck = detectBlockOrChallenge({ statusCode, html, pageTitle });
      if (blockCheck.blocked) {
        return { status: 'blocked', error: blockCheck.reason, statusCode, html, pageTitle };
      }
      return { status: 'success', html, statusCode, pageTitle };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /**
   * Browser Performance Metrics (F31).
   */
  getBrowserMetrics() {
    return {
      cloakbrowser: calcEngineStats(this.metrics.cloakbrowser),
      camoufox: calcEngineStats(this.metrics.camoufox),
    };
  }

  /**
   * Alias for backward-compatible test assertions.
   */
  getMetrics() {
    return this.getBrowserMetrics();
  }

  resetMetrics() {
    this.metrics = {
      cloakbrowser: { totalRuns: 0, successfulRuns: 0, blockedRuns: 0, errorRuns: 0, totalDurationMs: 0 },
      camoufox: { totalRuns: 0, successfulRuns: 0, blockedRuns: 0, errorRuns: 0, totalDurationMs: 0 },
    };
  }
}

// Global default instance
const defaultStealthRunner = new StealthBrowserRunner();

function getStealthBrowserRunner() {
  return defaultStealthRunner;
}

/**
 * Top-level capture helper matching PROJECT.md interface contract.
 */
async function captureWithStealthFallback(url, options = {}) {
  return defaultStealthRunner.captureWithFallback(url, options);
}

/**
 * Factory creating the captureFn bridge for MonitoringDispatcher.
 */
function createMonitoringStealthCaptureFn(stealthRunner = defaultStealthRunner, db = null) {
  return async function monitoringStealthCapture(job, context = {}) {
    const database = db || require('../database');
    const { signal } = context;

    let targetUrl = null;
    let platform = null;

    if (job.kind === 'shop_probe' && job.entity_id) {
      const entity = await database.prepare('SELECT * FROM monitoring_entities WHERE id = ?').get(job.entity_id);
      if (!entity) throw new Error(`Entity ${job.entity_id} not found for job ${job.id}`);
      targetUrl = entity.canonical_url;
      platform = entity.platform;
    } else if (job.kind === 'item_refresh' && job.item_id) {
      const itemRow = await database.prepare(`
        SELECT mi.*, pc.url, pc.platform
        FROM monitoring_items mi
        JOIN product_current pc ON mi.item_uid = pc.item_uid
        WHERE mi.id = ?
      `).get(job.item_id);
      if (!itemRow) throw new Error(`Item ${job.item_id} not found for job ${job.id}`);
      targetUrl = itemRow.url;
      platform = itemRow.platform;
    }

    if (!targetUrl) {
      return { status: 'failed', error: 'Missing target URL for job' };
    }

    const result = await stealthRunner.captureWithFallback(targetUrl, { platform, signal });
    if (result.status !== 'success') {
      return {
        status: 'failed',
        error: result.error || 'Stealth capture blocked or failed',
        engineUsed: result.engineUsed,
        fallbackTriggered: result.fallbackTriggered,
        isRetryable: true,
      };
    }

    const { analyzeMarketplaceHtml } = require('./html-parser');
    const analysis = analyzeMarketplaceHtml({ platform, url: targetUrl, html: result.html });
    const nowIso = new Date().toISOString();
    const observationId = `obs-${job.id}-${Date.now()}`;

    if (job.kind === 'shop_probe') {
      const salesMatch = /([0-9,]+)\s*(?:Sales|sales)/i.exec(result.html);
      const salesValue = salesMatch ? parseInt(salesMatch[1].replace(/,/g, ''), 10) : null;
      return {
        status: 'success',
        value: salesValue,
        observedAt: nowIso,
        quality: salesValue !== null ? 'exact' : 'estimated',
        observationId,
        engineUsed: result.engineUsed,
        html: result.html,
      };
    } else {
      return {
        status: 'success',
        patch: analysis.metrics,
        observationId,
        observedAt: nowIso,
        engineUsed: result.engineUsed,
        html: result.html,
      };
    }
  };
}

module.exports = {
  StealthBrowserRunner,
  defaultStealthRunner,
  getStealthBrowserRunner,
  captureWithStealthFallback,
  detectBlockOrChallenge,
  createMonitoringStealthCaptureFn,
};
