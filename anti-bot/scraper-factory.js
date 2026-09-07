/**
 * Scraper Factory — Strategy Pattern
 * auto-retry loop: attempt -> diagnose -> fix -> retry
 */

const fs = require('fs');
const path = require('path');
const { diagnose, getFixHint } = require('./error-diagnose');
const { calculateBackoff, getEscalationStep } = require('./backoff');
const { ProxyPool } = require('./proxy-pool');
const { defaultRetryPolicy } = require('../src/reliability/retry-policy');

const STRATEGIES_PATH = path.join(__dirname, 'strategies.json');
const STRATEGIES = JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf-8'));

let proxyPool = null;

function setProxies(proxies) {
  proxyPool = new ProxyPool(proxies);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Gap #2 closure (Final Gap Closure Round): an abortable backoff wait — a
// stuck LOCAL_HTTP execution previously could not be forcibly stopped between
// retry attempts; the loop would blindly sleep out the full backoff delay and
// start a NEW attempt regardless of any abort signal. This does not make an
// in-flight fetch itself instantly cancellable (that remains per-scraper),
// but it bounds how long a cancelled execution can keep retrying.
const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(new Error('ABORTED: execution cancelled during backoff')); return; }
  const timer = setTimeout(resolve, ms);
  if (signal) {
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('ABORTED: execution cancelled during backoff'));
    }, { once: true });
  }
});

function validateResult(platform, data) {
  if (!data) return false;
  const items = Array.isArray(data) ? data : data.items || data.results || [];
  if (items.length === 0) return false;
  const valid = items.filter(i => i.title || i.url || i.name);
  return valid.length > 0;
}

async function scrapeWithRetry(platform, query, options) {
  options = options || {};
  const strategy = STRATEGIES[platform];
  if (!strategy) throw new Error('No strategy for platform: ' + platform);

  const maxAttempts = options.maxAttempts || strategy.retry?.maxAttempts || 5;
  const logs = [];
  let lastError = null;
  let lastAttemptNumber = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal && options.signal.aborted) {
      console.log('  Aborted before attempt ' + attempt + ' — stopping retries');
      throw new Error('ABORTED: execution cancelled');
    }
    lastAttemptNumber = attempt;
    const escalation = getEscalationStep(attempt);
    const backoffDelay = calculateBackoff(attempt, strategy.retry);
    const needsProxy = strategy.proxy?.required || escalation.proxy;
    const usePooledProxy = !options.proxyUrl && needsProxy && proxyPool?.isUsable();
    const proxyUrl = options.proxyUrl || (usePooledProxy ? proxyPool.next() : null);

    console.log('[' + platform + '] Attempt ' + attempt + '/' + maxAttempts + ' -- ' + escalation.action + (proxyUrl ? ' (proxy)' : ''));

    try {
      const scraperPath = path.join(__dirname, '..', 'src', 'scrapers', platform + '.js');
      if (!fs.existsSync(scraperPath)) {
        throw new Error('Scraper not implemented: src/scrapers/' + platform + '.js');
      }
      const scraper = require(scraperPath);

      const data = await scraper.scrape(query, {
        ...strategy,
        ...options,
        attempt,
        proxyUrl,
        maxAttempts,
      });

      if (!validateResult(platform, data)) {
        throw new Error('VALIDATION_FAILED: empty or invalid data');
      }

      if (usePooledProxy && proxyUrl && proxyPool) proxyPool.markGood(proxyUrl);

      const items = Array.isArray(data) ? data : data.items || data.results || [];
      console.log('  Success: ' + items.length + ' items in ' + attempt + ' attempt(s)');

      return { items, platform, query, attempts: attempt, logs, strategy: strategy.method };

    } catch (err) {
      lastError = err;
      const d = diagnose(err);
      logs.push({ attempt, error: err.message.slice(0, 200), diagnosis: d.reason });

      console.log('  ' + d.reason + ': ' + err.message.slice(0, 120));
      console.log('  Fix: ' + getFixHint(d.reason));

      if (usePooledProxy && proxyUrl && proxyPool) proxyPool.markBad(proxyUrl);

      if (d.reason === 'AUTH_REQUIRED') {
        console.log('  Fatal: auth required, stopping retries');
        break;
      }

      // Unified retry classification (Simplification Round #22): this loop
      // previously retried EVERY error up to maxAttempts (including HTTP 404,
      // invalid platform/schema), diverging from src/reliability/retry-policy.js
      // which correctly treats those as non-retryable. A 404 no longer burns
      // through 5 attempts before surfacing.
      if (!defaultRetryPolicy.isRetryable(err)) {
        console.log('  Fatal: non-retryable per unified retry policy, stopping retries');
        break;
      }

      if (attempt < maxAttempts) {
        console.log('  Waiting ' + backoffDelay + 'ms before retry...');
        await abortableSleep(backoffDelay, options.signal);
      }
    }
  }

  const error = lastError || new Error('All attempts failed');
  console.error('[' + platform + '] FAILED after ' + lastAttemptNumber + '/' + maxAttempts + ' attempt(s)' + (lastAttemptNumber < maxAttempts ? ' (stopped early: non-retryable)' : ''));
  throw error;
}

function getStrategies() {
  return STRATEGIES;
}

function getPlatformsByTier() {
  return {
    api: Object.entries(STRATEGIES).filter(function(e) { return e[1].method === 'api'; }).map(function(e) { return e[0]; }),
    playwright: Object.entries(STRATEGIES).filter(function(e) { return e[1].method === 'playwright'; }).map(function(e) { return e[0]; }),
    cdp: Object.entries(STRATEGIES).filter(function(e) { return e[1].method === 'cdp'; }).map(function(e) { return e[0]; }),
  };
}

module.exports = { scrapeWithRetry, setProxies, getStrategies, getPlatformsByTier };
