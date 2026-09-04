const BaseBackend = require('./base.backend');
const { getLocalCapability } = require('./local-capabilities');

class LocalScraperBackend extends BaseBackend {
  constructor() {
    super({ name: 'local-scraper', kind: 'local' });
  }

  async probe(channel, backendConfig) {
    const capability = getLocalCapability(channel.name);
    if (!capability) {
      return {
        status: 'unsupported',
        warnings: [`Local scraper is not implemented for this channel (${channel.name})`],
        actions: ['Use Apify backend or implement local scraper support']
      };
    }

    // Live-Readiness Round #1: a channel with a real direct method (no SearXNG
    // involved at all on its healthy path) never depends on SearXNG's health.
    // Final Stabilization Round #6: a direct-method channel that MAY still
    // internally escalate to a real browser (reddit.js/pinterest.js call
    // launchStealth() when their non-browser path fails) must never be
    // admitted as LOCAL_HTTP — the Scheduler would then have zero BROWSER
    // pool/RAM budget reserved for a browser that can legitimately open.
    // Safety > throughput: always reserve BROWSER upfront for these channels,
    // even though the fast direct path is what actually runs most of the time.
    if (capability.hasDirectMethodWithoutSearXNG) {
      if (capability.mayUseBrowserFallback) {
        return {
          name: 'local-scraper',
          status: 'ok',
          executionMode: 'browser_fallback',
          version: '1.0.0',
          warnings: [`${channel.name} has a direct non-browser path but may internally escalate to a local browser — budgeted as BROWSER upfront`]
        };
      }
      return { name: 'local-scraper', status: 'ok', executionMode: 'direct', version: '1.0.0', warnings: [] };
    }

    const searxngUrl = process.env.SEARXNG_URL || 'http://localhost:8080';
    const timeoutMs = parseInt(process.env.DEPENDENCY_PROBE_TIMEOUT_MS || '2000', 10);

    let searxngHealthy = false;
    let probeErrorMessage = null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(searxngUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      // Round #1: a reachable endpoint returning an HTTP error is NOT healthy —
      // check res.ok, not just "the fetch didn't throw".
      searxngHealthy = res.ok;
      if (!res.ok) probeErrorMessage = `HTTP ${res.status} ${res.statusText}`;
    } catch (e) {
      probeErrorMessage = e.message;
    }

    if (searxngHealthy) {
      return { name: 'local-scraper', status: 'ok', executionMode: 'searxng', version: '1.0.0', checkedUrl: searxngUrl, warnings: [] };
    }

    if (capability.mayUseBrowserFallback) {
      return {
        name: 'local-scraper',
        status: 'warn',
        executionMode: 'browser_fallback',
        version: '1.0.0',
        checkedUrl: searxngUrl,
        missing: ['SEARXNG'],
        warnings: [`SearXNG unavailable (${probeErrorMessage || 'unhealthy'}) — falling back to browser-based execution for ${channel.name}`],
        actions: [`Start SearXNG at ${searxngUrl} for faster/cheaper discovery, or accept the slower browser fallback`]
      };
    }

    return {
      name: 'local-scraper',
      status: 'failed',
      executionMode: null,
      missing: ['SEARXNG'],
      checkedUrl: searxngUrl,
      warnings: [`SearXNG is not reachable/healthy at ${searxngUrl} (${probeErrorMessage || 'unhealthy'}) and no fallback exists for ${channel.name}`],
      actions: [`Start SearXNG on port ${new URL(searxngUrl).port} or set SEARXNG_URL`]
    };
  }

  async run(channel, backendConfig, query, options = {}) {
    // Round #3: maxItems is the canonical workload field. Scrapers historically
    // read `options.limit`; normalize it here at the adapter boundary so the
    // planner's resource calculation (based on maxItems) and the actual scraper
    // workload always agree, regardless of which field an individual scraper reads.
    const maxItems = Number(options.maxItems);
    const normalizedOptions = { ...options };
    if (Number.isFinite(maxItems) && maxItems > 0) {
      normalizedOptions.maxItems = maxItems;
      // Only tighten `limit`, never loosen it — an explicit lower limit set by
      // the caller must still win.
      const explicitLimit = Number(options.limit);
      normalizedOptions.limit = Number.isFinite(explicitLimit) && explicitLimit > 0
        ? Math.min(explicitLimit, maxItems)
        : maxItems;
    }

    let items = [];
    try {
      const scraperFactory = require('../../anti-bot/scraper-factory');
      if (typeof scraperFactory.scrapeWithRetry === 'function') {
        const result = await scraperFactory.scrapeWithRetry(channel.name, query, normalizedOptions);
        items = result.items || [];
      } else {
        throw new Error('scraperFactory.scrapeWithRetry is not defined');
      }
    } catch (e) {
      console.warn('Local scraper error for ' + channel.name + ':', e.message);
      throw e;
    }

    // Round #3 acceptance: the adapter boundary enforces the cap even if an
    // individual scraper over-returns.
    if (Number.isFinite(maxItems) && maxItems > 0 && items.length > maxItems) {
      items = items.slice(0, maxItems);
    }

    return {
      backend: this.name,
      backendKind: this.kind,
      backendRunId: null,
      datasetId: null,
      items: items,
      rawStatus: 'SUCCEEDED',
      healthSnapshot: { local: true }
    };
  }

  getHealthHint(error) {
    return super.getHealthHint(error);
  }
}

module.exports = LocalScraperBackend;
