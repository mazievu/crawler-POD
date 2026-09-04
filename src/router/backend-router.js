class NoHealthyBackendError extends Error {
  constructor(message, platform, diagnostic) {
    super(message);
    this.name = 'NoHealthyBackendError';
    this.platform = platform;
    this.diagnostic = diagnostic;
  }
}

class BackendRouter {
  constructor({ registry, doctor, backends }) {
    this.registry = registry;
    this.doctor = doctor; // Optional depending on how we integrate doctor
    // instantiate backend adapters
    this.adapters = {};
    if (backends) {
      backends.forEach(B => {
        const adapter = new B();
        this.adapters[adapter.kind] = adapter;
      });
    } else {
      // Default to requiring them if not injected
      const ApifyBackend = require('../backends/apify.backend');
      const LocalScraperBackend = require('../backends/local-scraper.backend');
      const CDPBackend = require('../backends/cdp.backend');
      const MockBackend = require('../backends/mock.backend');

      const apify = new ApifyBackend();
      this.adapters[apify.kind] = apify;

      const local = new LocalScraperBackend();
      this.adapters[local.kind] = local;

      const cdp = new CDPBackend();
      this.adapters[cdp.kind] = cdp;

      const mock = new MockBackend();
      this.adapters[mock.kind] = mock;
    }
  }

  async selectBackend(channelName, options = {}) {
    const channel = this.registry.getChannel(channelName);
    if (!channel) throw new Error(`Unknown channel: ${channelName}`);
    if (channel.availability.status === 'disabled') {
      throw new Error(`Channel ${channelName} is disabled`);
    }

    let candidateBackends = channel.backends.filter(b => b.enabled !== false);
    candidateBackends.sort((a, b) => a.priority - b.priority);

    if (options.backend) {
      const explicit = candidateBackends.find(b => b.name === options.backend || b.kind === options.backend);
      if (explicit) {
        candidateBackends = [explicit];
      } else {
        throw new Error(`Requested backend ${options.backend} is not available for channel ${channelName}`);
      }
    }

    let warnBackend = null;

    for (const bConf of candidateBackends) {
      const adapter = this.adapters[bConf.kind];
      if (!adapter) continue;
      
      try {
        const probeResult = await adapter.probe(channel, bConf, options);
        if (probeResult && probeResult.status === 'ok') {
          return { adapter, config: bConf, version: probeResult.version, executionMode: probeResult.executionMode || null, probeStatus: 'ok' };
        } else if (probeResult && probeResult.status === 'warn') {
          if (!warnBackend) {
            warnBackend = { adapter, config: bConf, version: probeResult.version, executionMode: probeResult.executionMode || null, probeStatus: 'warn' };
          }
        }
      } catch (e) {
        // Probe failed, try next
      }
    }

    if (warnBackend) {
      return warnBackend;
    }

    // If we have doctor, we can attach the diagnostic for this channel
    let diagnostic = null;
    if (this.doctor) {
       try {
         const report = await this.doctor.runDoctor({ platform: channelName });
         if (report.channels && report.channels[channelName]) {
           diagnostic = report.channels[channelName];
         }
       } catch (err) {}
    }

    throw new NoHealthyBackendError(
      `No usable backend found for ${channelName}. Please run doctor.`,
      channelName,
      diagnostic
    );
  }

  async run(channelName, query, options = {}) {
    const channel = this.registry.getChannel(channelName);
    if (!channel) throw new Error(`Unknown channel: ${channelName}`);

    // If a specific backend was requested, execute it directly
    if (options.backend) {
      const { adapter, config, version } = await this.selectBackend(channelName, options);
      const result = await adapter.run(channel, config, query, options);
      return {
        channel: channelName,
        activeBackend: config.name,
        backendKind: config.kind,
        backendStatus: 'ok',
        backendVersion: version,
        backendRunId: result.backendRunId,
        datasetId: result.datasetId,
        healthSnapshot: result.healthSnapshot,
        items: result.items,
        raw: result
      };
    }

    // Otherwise, iterate through candidate backends in priority order with fallback
    let candidateBackends = channel.backends.filter(b => b.enabled !== false);
    candidateBackends.sort((a, b) => (a.priority || 100) - (b.priority || 100));

    let lastError = null;
    for (const bConf of candidateBackends) {
      const adapter = this.adapters[bConf.kind];
      if (!adapter) continue;

      try {
        const probeResult = await adapter.probe(channel, bConf, options);
        if (probeResult && (probeResult.status === 'ok' || probeResult.status === 'warn')) {
          const result = await adapter.run(channel, bConf, query, options);
          return {
            channel: channelName,
            activeBackend: bConf.name,
            backendKind: bConf.kind,
            backendStatus: 'ok',
            backendVersion: probeResult.version,
            backendRunId: result.backendRunId,
            datasetId: result.datasetId,
            healthSnapshot: result.healthSnapshot,
            items: result.items,
            raw: result
          };
        }
      } catch (err) {
        lastError = err;
        console.warn(`[BackendRouter] Backend ${bConf.name} failed for ${channelName}: ${err.message}. Trying next available backend...`);
      }
    }

    throw lastError || new NoHealthyBackendError(
      `No usable backend found for ${channelName}.`,
      channelName
    );
  }
}

module.exports = { BackendRouter, NoHealthyBackendError };
