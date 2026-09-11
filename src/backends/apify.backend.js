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

    // Some actors cap how many results a single call may return (TikTok Shop's
    // input schema declares limit.maximum = 10), so asking for 20 in one call
    // would silently come back with 10. When the request exceeds that cap the
    // run is split across consecutive pages and the results concatenated.
    const requestedItems = options.maxItems || 20;
    // The cap belongs to the ACTOR, not the platform: TikTok Shop is served by
    // two actors and only pratikdani's schema caps limit at 10.
    const pageCap = apifyClient.ACTOR_PAGE_LIMITS[backendConfig.actorId] || 0;
    if (pageCap > 0 && requestedItems > pageCap) {
      return await this.runPaged(channel, backendConfig, query, options, requestedItems, pageCap);
    }

    return await tokenPool.withTokenFailover(async (apiClient, tokenRecord) => {
      const { runId, datasetId } = await apifyClient.startActor(backendConfig.actorId, channel.name, {
        query,
        maxItems: requestedItems,
        country: options.country,
        page: options.page
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

      let items = await apifyClient.fetchDatasetItems(datasetId, requestedItems, apiClient);

      /*
       * pratikdani/tiktok-shop-search-scraper normally pushes one dataset entry
       * per product, but when its upstream returns nothing it pushes the raw
       * response envelope instead — a single {data: [], route: []} object
       * (observed on runs zNerAZPY1d1Lgn56s and pPIS9K6mxnIKRkjhp, 2026-09-07,
       * while runs BC7AYbRSmef9IeAI1/BMbYIZAQ21gSupf9f two hours earlier
       * returned flat products). Left alone that envelope counts as one
       * collected "item" and is then discarded downstream for having no image,
       * which reports an empty crawl as a successful one-item crawl.
       *
       * Unwrapping it makes an empty upstream read as what it is: zero items.
       */
      if (items.length === 1 && items[0] && !items[0].product_id && Array.isArray(items[0].data)) {
        const envelope = items[0];
        console.log(`[Apify] ${channel.name}: provider returned a response envelope with ${envelope.data.length} record(s) instead of flat items; unwrapping.`);
        items = envelope.data;
      }

      /*
       * clockworks/tiktok-scraper puts comment text in a SEPARATE dataset and
       * leaves only a pointer on each video (`commentsDatasetUrl`). Fetching it
       * here — while the Apify client is in hand — is what makes "full
       * comments" reach the pipeline at all; the normalizer and the
       * post_comments table both read `item.fullComments`.
       *
       * All videos in one run share a single comments dataset, so it is fetched
       * once and grouped by `videoWebUrl`. A failure is logged and left empty:
       * the video's own metrics are still good, and silently pretending a post
       * has no comments would be worse than saying so in the log.
       */
      if (Array.isArray(items) && items.length > 0 && items.some((it) => it && it.commentsDatasetUrl)) {
        const commentsDatasetId = String(items.find((it) => it && it.commentsDatasetUrl).commentsDatasetUrl)
          .match(/datasets\/([A-Za-z0-9]+)/)?.[1];
        if (commentsDatasetId) {
          try {
            const commentRows = await apifyClient.fetchDatasetItems(commentsDatasetId, 5000, apiClient);
            const byVideo = new Map();
            for (const row of commentRows) {
              const key = row?.videoWebUrl;
              if (!key) continue;
              if (!byVideo.has(key)) byVideo.set(key, []);
              byVideo.get(key).push(row);
            }
            let attached = 0;
            for (const item of items) {
              const rows = byVideo.get(item.webVideoUrl) || [];
              item.fullComments = rows;
              if (rows.length) attached += 1;
            }
            console.log(`[Apify] ${channel.name}: attached ${commentRows.length} comment(s) to ${attached}/${items.length} video(s) from dataset ${commentsDatasetId}.`);
          } catch (err) {
            console.warn(`[Apify] ${channel.name}: could not fetch comments dataset ${commentsDatasetId}: ${err.message}`);
            for (const item of items) if (!item.fullComments) item.fullComments = [];
          }
        }
      }

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

  /**
   * Collects more results than one actor call is allowed to return, by walking
   * consecutive pages.
   *
   * Each page is a full run() with maxItems clamped to the cap, so it keeps
   * every property of a normal run: token failover, abort handling, and the
   * polling loop. Paging stops early when a page comes back short — that is the
   * provider saying there is nothing after it, and asking for page N+1 anyway
   * would be a paid call guaranteed to return nothing.
   *
   * Duplicates across pages are dropped defensively. A runtime check on
   * 2026-09-07 found page 1 and page 2 fully disjoint, so this should never
   * trigger; it exists so a provider that starts repeating cannot inflate the
   * item count with the same product twice.
   */
  async runPaged(channel, backendConfig, query, options, requestedItems, pageCap) {
    const pages = Math.ceil(requestedItems / pageCap);
    const collected = [];
    const seen = new Set();
    let lastResult = null;
    const backendRunIds = [];

    for (let page = 1; page <= pages; page++) {
      if (options.signal && options.signal.aborted) {
        throw new Error('ABORTED: execution cancelled between pages');
      }
      const remaining = requestedItems - collected.length;
      if (remaining <= 0) break;

      const pageResult = await this.run(channel, backendConfig, query, {
        ...options,
        maxItems: Math.min(pageCap, remaining),
        page,
      });

      lastResult = pageResult;
      if (pageResult.backendRunId) backendRunIds.push(pageResult.backendRunId);

      const pageItems = Array.isArray(pageResult.items) ? pageResult.items : [];
      for (const item of pageItems) {
        const key = item?.product_id || item?.id || JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(item);
      }

      console.log(`[Apify] ${channel.name} page ${page}/${pages}: ${pageItems.length} item(s), ${collected.length}/${requestedItems} collected`);

      // Short page = end of results for this query.
      if (pageItems.length < Math.min(pageCap, remaining)) break;
    }

    return {
      ...(lastResult || { backend: this.name, backendKind: this.kind, rawStatus: 'SUCCEEDED' }),
      items: collected.slice(0, requestedItems),
      backendRunId: backendRunIds.join(','),
      pagesFetched: backendRunIds.length,
    };
  }

  getHealthHint(error) {
    if (error.message.includes('APIFY_TOKEN') || error.message.includes('APIFY_POOL')) {
      return { message: error.message, action: 'Set APIFY_TOKEN or APIFY_TOKENS in .env' };
    }
    return super.getHealthHint(error);
  }
}

module.exports = ApifyBackend;
