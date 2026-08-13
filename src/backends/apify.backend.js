const BaseBackend = require('./base.backend');
const apifyClient = require('../apify-client');

class ApifyBackend extends BaseBackend {
  constructor() {
    super({ name: 'apify', kind: 'apify' });
  }

  async probe(channel, backendConfig) {
    if (!process.env.APIFY_TOKEN) {
      throw new Error('APIFY_TOKEN is missing');
    }
    if (!backendConfig.actorId) {
      throw new Error('Apify backend requires an actorId in channel config');
    }
    
    if (backendConfig.actorEntitlement === 'unverified') {
      return { 
        status: 'warn', 
        version: '2.9.0',
        warnings: ['APIFY_TOKEN is configured, but paid actor entitlement is unverified'],
        actions: ['Rent/enable the actor in Apify or run a real backend verification']
      };
    }
    
    return { status: 'ok', version: '2.9.0' }; // apify-client version approx
  }

  async run(channel, backendConfig, query, options = {}) {
    const { runId, datasetId } = await apifyClient.startActor(backendConfig.actorId, channel.name, {
      query,
      maxItems: options.maxItems || 20,
      country: options.country
    });

    let status = 'RUNNING';
    let attempts = 0;
    const maxAttempts = 120; // 3000ms * 120 = 360 seconds timeout

    // Simple poll here so the router can await run() completely.
    while (attempts < maxAttempts) {
      attempts++;
      await new Promise(r => setTimeout(r, 3000));
      status = await apifyClient.getRunStatus(runId);
      if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED') {
        break;
      }
    }

    if (status !== 'SUCCEEDED') {
      throw new Error(`Apify run ended with status: ${status}`);
    }

    const items = await apifyClient.fetchDatasetItems(datasetId, options.maxItems || 20);

    return {
      backend: this.name,
      backendKind: this.kind,
      backendRunId: runId,
      datasetId: datasetId,
      items: items,
      rawStatus: status,
      healthSnapshot: { attempts, timeout: attempts >= maxAttempts }
    };
  }

  getHealthHint(error) {
    if (error.message.includes('APIFY_TOKEN')) {
      return { message: error.message, action: 'Set APIFY_TOKEN in .env' };
    }
    return super.getHealthHint(error);
  }
}

module.exports = ApifyBackend;
