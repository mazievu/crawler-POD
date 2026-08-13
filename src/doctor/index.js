const registry = require('../channels/registry');
const ApifyBackend = require('../backends/apify.backend');
const LocalScraperBackend = require('../backends/local-scraper.backend');
const CDPBackend = require('../backends/cdp.backend');
const MockBackend = require('../backends/mock.backend');

const adapters = {
  apify: new ApifyBackend(),
  local: new LocalScraperBackend(),
  cdp: new CDPBackend(),
  mock: new MockBackend()
};

async function runDoctor(options = {}) {
  const report = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    channels: {}
  };

  let channelsToProbe = registry.getAllChannels();
  if (options.platform) {
    channelsToProbe = channelsToProbe.filter(c => c.name === options.platform);
  }

  for (const channel of channelsToProbe) {
    const channelReport = {
      status: 'disabled',
      activeBackend: null,
      backends: []
    };

    if (channel.availability.status === 'disabled') {
      report.channels[channel.name] = channelReport;
      continue;
    }

    let candidateBackends = channel.backends.filter(b => b.enabled !== false);
    if (options.backend) {
      candidateBackends = candidateBackends.filter(b => b.name === options.backend || b.kind === options.backend);
    }

    candidateBackends.sort((a, b) => a.priority - b.priority);

    let hasOkBackend = false;
    let hasFallback = false;

    for (const bConf of candidateBackends) {
      const adapter = adapters[bConf.kind];
      const backendReport = {
        name: bConf.name,
        status: 'failed',
        missing: [],
        warnings: []
      };

      if (!adapter) {
        backendReport.warnings.push(`Adapter for kind ${bConf.kind} not found`);
        channelReport.backends.push(backendReport);
        continue;
      }

      try {
        const probeResult = await adapter.probe(channel, bConf);
        backendReport.status = probeResult.status || 'ok';
        
        if (probeResult.missing) {
          backendReport.missing.push(...probeResult.missing);
        }
        if (probeResult.warnings) {
          backendReport.warnings.push(...probeResult.warnings);
        }
        if (probeResult.actions) {
          if (!backendReport.actions) backendReport.actions = [];
          backendReport.actions.push(...probeResult.actions);
        }

        if (backendReport.status === 'ok') {
          hasOkBackend = true;
          if (!channelReport.activeBackend) {
            channelReport.activeBackend = bConf.name; // Highest priority ok backend
          } else {
            hasFallback = true;
          }
        }
      } catch (err) {
        backendReport.status = 'warn'; // Might be missing requirements
        const hint = adapter.getHealthHint(err);
        backendReport.missing.push(hint.message);
        backendReport.warnings.push(hint.action);
      }
      channelReport.backends.push(backendReport);
    }

    let hasWarnBackend = false;
    for (const bConf of channelReport.backends) {
      if (bConf.status === 'warn') hasWarnBackend = true;
    }

    if (hasOkBackend) {
      channelReport.status = hasFallback || candidateBackends.length === 1 ? 'ok' : 'warn';
    } else if (hasWarnBackend) {
      channelReport.status = 'warn';
    } else {
      channelReport.status = 'failed';
    }

    report.channels[channel.name] = channelReport;
  }

  // Aggregate global status
  let allOk = true;
  let anyFailed = false;
  for (const c of Object.values(report.channels)) {
    if (c.status === 'failed') anyFailed = true;
    if (c.status !== 'ok' && c.status !== 'disabled') allOk = false;
  }
  
  if (anyFailed) report.status = 'failed';
  else if (!allOk) report.status = 'warn';

  return report;
}

module.exports = { runDoctor };
