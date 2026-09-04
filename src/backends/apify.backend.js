const BaseBackend = require('./base.backend');
const apifyClient = require('../apify-client');
const { getApifyTokenPool } = require('../apify-token-pool');

class ApifyBackend extends BaseBackend {
  constructor() {
    super({ name: 'apify', kind: 'apify' });
  }

  async probe(channel, backendConfig) {
    const tokenPool = getApifyTokenPool();
    const hasTokens = tokenPool.getAvailable().length > 0 || Boolean(process.env.APIFY_TOKEN || process.env.APIFY_TOKENS);
    if (!hasTokens) {
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
    const tokenPool = getApifyTokenPool();

    return await tokenPool.withTokenFailover(async (apiClient, tokenRecord) => {
      const { runId, datasetId } = await apifyClient.startActor(backendConfig.actorId, channel.name, {
        query,
        maxItems: options.maxItems || 20,
        country: options.country
      }, apiClient);

      // Gap #4 closure (Final Gap Closure Round): the actor keeps running on
      // Apify's own infrastructure regardless of this Node process — report
      // its remote runId so RestartRecovery can check its status (never
      // blindly launch a duplicate Actor) on next boot.
      if (typeof options.reportExternalExecution === 'function' && runId) {
        options.reportExternalExecution({ executionClass: 'CLOUD_API', externalExecutionId: runId });
      }

      let status = 'RUNNING';
      let attempts = 0;
      const maxAttempts = 120; // 3000ms * 120 = 360 seconds timeout

      // Simple poll here so the router can await run() completely.
      while (attempts < maxAttempts) {
        // Gap #2 closure: stop OUR polling promptly on abort. This does not
        // stop the remote Apify actor itself (it is not this process's to
        // stop) — it only lets this execution settle so its local resources
        // (worker slot/RAM) can be released honestly.
        if (options.signal && options.signal.aborted) {
          throw new Error('ABORTED: execution cancelled while polling Apify run status');
        }
        attempts++;
        await new Promise(r => setTimeout(r, 3000));
        status = await apifyClient.getRunStatus(runId, apiClient);
        if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED') {
          break;
        }
      }

      if (status !== 'SUCCEEDED') {
        throw new Error(`Apify run ended with status: ${status}`);
      }

      let items = await apifyClient.fetchDatasetItems(datasetId, options.maxItems || 20, apiClient);

      // If pinterest, enrich items with real engagement metrics (repins/shares, comments, likes/reactions, views, author)
      if (channel.name === 'pinterest' && Array.isArray(items) && items.length > 0) {
        try {
          const { enrichPinMetrics } = require('../scrapers/pinterest');
          if (typeof enrichPinMetrics === 'function') {
            const enriched = await Promise.allSettled(
              items.map(async (item) => {
                const pinId = item.id || (item.url ? (item.url.match(/\/pin\/(\d+)/) || [])[1] : null);
                if (!pinId) return item;
                const meta = await enrichPinMetrics(pinId, options.signal);
                if (meta) {
                  return {
                    ...item,
                    title: item.title || meta.title,
                    pinnerName: meta.author || item.pinnerName || item.pinnerUsername,
                    author: meta.author || item.pinnerName || item.pinnerUsername,
                    saves: meta.shares !== undefined ? meta.shares : item.saves,
                    repinCount: meta.shares !== undefined ? meta.shares : item.saves,
                    shares: meta.shares !== undefined ? meta.shares : item.saves,
                    comments: meta.comments !== undefined ? meta.comments : 0,
                    commentCount: meta.comments !== undefined ? meta.comments : 0,
                    likes: meta.likes !== undefined ? meta.likes : 0,
                    reactions: meta.likes !== undefined ? meta.likes : 0,
                    views: meta.views !== undefined ? meta.views : 0,
                    imageUrl: meta.image || item.imageUrl,
                  };
                }
                return item;
              })
            );
            items = enriched.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
          }
        } catch (_e) {}
      }

      return {
        backend: this.name,
        backendKind: this.kind,
        backendRunId: runId,
        datasetId: datasetId,
        items: items,
        rawStatus: status,
        activeTokenId: tokenRecord ? tokenRecord.id : null,
        activeTokenMasked: tokenRecord ? tokenRecord.label : null,
        healthSnapshot: { attempts, timeout: attempts >= maxAttempts }
      };
    }, options);
  }

  getHealthHint(error) {
    if (error.message.includes('APIFY_TOKEN') || error.message.includes('APIFY_POOL')) {
      return { message: error.message, action: 'Set APIFY_TOKEN or APIFY_TOKENS in .env' };
    }
    return super.getHealthHint(error);
  }
}

module.exports = ApifyBackend;
