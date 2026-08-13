const BaseBackend = require('./base.backend');

class LocalScraperBackend extends BaseBackend {
  constructor() {
    super({ name: 'local-scraper', kind: 'local' });
  }

  async probe(channel, backendConfig) {
    // Only these channels currently have some local scraper support in theory
    const supportedLocal = ['reddit', 'etsy', 'ebay', 'shopify', 'pinterest', 'google_shopping'];
    if (!supportedLocal.includes(channel.name)) {
      return {
        status: 'unsupported',
        warnings: [`Local scraper is not implemented for this channel (${channel.name})`],
        actions: ['Use Apify backend or implement local scraper support']
      };
    }

    const requiresSearXng = channel.name !== 'reddit';

    if (requiresSearXng) {
      const searxngUrl = process.env.SEARXNG_URL || 'http://localhost:8080';
      const timeoutMs = parseInt(process.env.DEPENDENCY_PROBE_TIMEOUT_MS || '2000', 10);
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(searxngUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
      } catch (e) {
        return {
          name: 'local-scraper',
          status: 'failed',
          missing: ['SEARXNG'],
          checkedUrl: searxngUrl,
          warnings: [`SearXNG is not reachable at ${searxngUrl}`],
          actions: [`Start SearXNG on port ${new URL(searxngUrl).port} or set SEARXNG_URL`]
        };
      }
      return { name: 'local-scraper', status: 'ok', version: '1.0.0', checkedUrl: searxngUrl, warnings: [] };
    }

    return { name: 'local-scraper', status: 'ok', version: '1.0.0', warnings: [] };
  }

  async run(channel, backendConfig, query, options = {}) {
    // Assuming anti-bot/scraper-factory.js exposes scrapeWithRetry or similar.
    // Wrap whatever is there or mock if not fully implemented.
    let items = [];
    try {
      const scraperFactory = require('../../anti-bot/scraper-factory');
      if (typeof scraperFactory.scrapeWithRetry === 'function') {
        const result = await scraperFactory.scrapeWithRetry(channel.name, query, options);
        items = result.items || [];
      } else {
        throw new Error('scraperFactory.scrapeWithRetry is not defined');
      }
    } catch (e) {
      console.warn('Local scraper error, using mock fallback for ' + channel.name, e.message);
      // Fallback or re-throw based on implementation. Here we just throw.
      throw e;
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
