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

    // A requested backend is a PREFERENCE, not a pin. The Scheduler sets
    // options.backend on EVERY dispatch (scheduler.js dispatchOptions), so this
    // branch used to mean the priority-ordered fallback loop below never ran for
    // any scheduled crawl: a channel whose second backend was perfectly healthy
    // still failed outright when its first one did. Reddit exposed it - its local
    // tier is dead on a host whose DNS resolves www.reddit.com to 127.0.0.1, and
    // its Apify tier was never attempted.
    //
    // Fallback here is deliberately ONE-DIRECTIONAL. The Scheduler has already
    // reserved RAM for the PLANNED execution class, so falling back to a heavier
    // class would run work the resource accounting never budgeted for. Only a
    // same-kind backend (same class, same reservation) or an apify/cloud backend
    // (whose local cost is one HTTP request) is eligible - both are
    // same-or-lighter than whatever was planned.
    if (options.backend) {
      const { adapter, config, version } = await this.selectBackend(channelName, options);
      try {
        const result = await adapter.run(channel, config, query, options);
        const hasData = result && Array.isArray(result.items) && result.items.length > 0;
        const isSocialChannel = ['reddit', 'facebook_posts'].includes(channelName);
        const lacksSocialData = isSocialChannel && hasData && config.kind === 'local' && !result.items.some(it => (it.image && it.image.length > 10) || (it.likes > 0 || it.comments > 0 || it.ups > 0));

        if (!hasData || lacksSocialData) {
          const reason = !hasData ? '0 items returned' : 'no images or metrics found in local items';
          const lighterFallbacks = channel.backends
            .filter((b) => b.enabled !== false && b.name !== config.name)
            .filter((b) => b.kind === config.kind || b.kind === 'apify')
            .sort((x, y) => (x.priority || 100) - (y.priority || 100));

          if (lighterFallbacks.length > 0) {
            console.warn(`[BackendRouter] Preferred backend ${config.name} for ${channelName} yielded insufficient data (${reason}). Trying fallback backend(s)...`);
            throw new Error(`INSUFFICIENT_DATA: ${config.name} (${reason})`);
          }
        }

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
      } catch (preferredError) {
        const lighterFallbacks = channel.backends
          .filter((b) => b.enabled !== false && b.name !== config.name)
          .filter((b) => b.kind === config.kind || b.kind === 'apify')
          .sort((x, y) => (x.priority || 100) - (y.priority || 100));

        if (lighterFallbacks.length === 0) throw preferredError;
        console.warn(`[BackendRouter] Preferred backend ${config.name} failed for ${channelName}: ${preferredError.message}. Trying ${lighterFallbacks.length} same-or-lighter backend(s)...`);

        for (const bConf of lighterFallbacks) {
          const fbAdapter = this.adapters[bConf.kind];
          if (!fbAdapter) continue;
          try {
            const probeResult = await fbAdapter.probe(channel, bConf, options);
            if (!probeResult || (probeResult.status !== 'ok' && probeResult.status !== 'warn')) continue;
            const result = await fbAdapter.run(channel, bConf, query, options);
            console.warn(`[BackendRouter] ${channelName} recovered on fallback backend ${bConf.name}.`);
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
          } catch (fbError) {
            console.warn(`[BackendRouter] Fallback backend ${bConf.name} also failed for ${channelName}: ${fbError.message}`);
          }
        }
        throw preferredError;
      }
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
          const hasData = result && Array.isArray(result.items) && result.items.length > 0;
          const isSocialChannel = ['reddit', 'facebook_posts'].includes(channelName);
          const lacksSocialData = isSocialChannel && hasData && bConf.kind === 'local' && !result.items.some(it => (it.image && it.image.length > 10) || (it.likes > 0 || it.comments > 0 || it.ups > 0));

          if (!hasData || lacksSocialData) {
            const reason = !hasData ? '0 items returned' : 'no images or metrics found in local items';
            console.warn(`[BackendRouter] Backend ${bConf.name} yielded insufficient data (${reason}). Trying next available backend...`);
            continue;
          }

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
