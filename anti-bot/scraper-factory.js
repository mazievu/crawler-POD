/**
 * Scraper Factory — Strategy Pattern
 * auto-retry loop: attempt -> diagnose -> fix -> retry
 */

const fs = require('fs');
const path = require('path');
const { diagnose, getFixHint } = require('./error-diagnose');
const { calculateBackoff, getEscalationStep } = require('./backoff');
const { ProxyPool } = require('./proxy-pool');

const STRATEGIES_PATH = path.join(__dirname, 'strategies.json');
const STRATEGIES = JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf-8'));

let proxyPool = null;

function setProxies(proxies) {
  proxyPool = new ProxyPool(proxies);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

      if (attempt < maxAttempts) {
        console.log('  Waiting ' + backoffDelay + 'ms before retry...');
        await sleep(backoffDelay);
      }
    }
  }

  const error = lastError || new Error('All attempts failed');
  console.error('[' + platform + '] FAILED after ' + maxAttempts + ' attempts');
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
