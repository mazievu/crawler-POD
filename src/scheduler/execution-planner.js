/**
 * Execution Planner (Preflight) — Simplification Round
 *
 * Produces a request-specific ResourcePlan for EVERY run, computed fresh from
 * that request's own characteristics. It NEVER consults a persisted history of
 * prior runs' RAM usage (see the removed resource-profile.js dependency) —
 * two requests to the same platform+backend can have wildly different cost
 * (maxItems=20 vs maxItems=1000, image enrichment on/off, browser fallback
 * possible or not), so "last time etsy+local used 95MB" tells you nothing
 * about whether THIS request needs 95MB or 900MB.
 *
 * `estimatedEnvelopeMB` is a conservative safety envelope for admission control,
 * not a claim of exact RAM usage. It is a static per-execution-class baseline
 * (configurable) adjusted by this request's own concurrency/shard/enrichment
 * flags — never by what a previous run measured.
 */

const registry = require('../channels/registry');
const doctorModule = require('../doctor');
const { BackendRouter } = require('../router/backend-router');
const { getLocalCapability } = require('../backends/local-capabilities');

// Only kinds that actually exist as backend adapters (src/backends/*.backend.js).
const KIND_TO_CLASS = {
  apify: 'CLOUD_API',
  cloud: 'CLOUD_API',
  local: 'LOCAL_HTTP',
  mock: 'LOCAL_HTTP',
  cdp: 'CDP',
  browser: 'BROWSER',
  'user-journey': 'BROWSER'
};

const CLASS_TO_POOL = {
  LOCAL_HTTP: 'LOCAL',
  CLOUD_API: 'CLOUD',
  BROWSER: 'BROWSER',
  CDP: 'CDP'
};

// Conservative static envelopes (MB) per execution class. Configurable via env
// or constructor options — never derived from a prior run's measured usage.
const DEFAULT_CLASS_ENVELOPES_MB = {
  LOCAL_HTTP: Number(process.env.ENVELOPE_LOCAL_HTTP_MB) || 150,
  CLOUD_API: Number(process.env.ENVELOPE_CLOUD_API_MB) || 60,
  BROWSER: Number(process.env.ENVELOPE_BROWSER_MB) || 450,
  CDP: Number(process.env.ENVELOPE_CDP_MB) || 400
};

const { DEFAULT_TASK_COST_MB } = require('./internal-task-pool');

// Default shard sizes per execution class — bounds how much of a large request
// runs as a single unit of work. Configurable, not hard-coded business rules.
const DEFAULT_SHARD_SIZES = {
  LOCAL_HTTP: Number(process.env.SHARD_SIZE_LOCAL_HTTP) || 100,
  CLOUD_API: Number(process.env.SHARD_SIZE_CLOUD_API) || 200,
  BROWSER: Number(process.env.SHARD_SIZE_BROWSER) || 10,
  CDP: Number(process.env.SHARD_SIZE_CDP) || 20
};

// Non-channel job kinds (browser-automation flows with no BackendRouter/channel
// entry) get a fixed static plan instead of going through selectBackend().
const NON_CHANNEL_JOB_PLANS = {
  user_journey: { executionClass: 'BROWSER', backend: 'browser', backendName: 'user-journey-runner' },
  marketplace_capture: { executionClass: 'BROWSER', backend: 'browser', backendName: 'marketplace-html-capture' },
  marketplace_discovery: { executionClass: 'LOCAL_HTTP', backend: 'local', backendName: 'marketplace-discovery' }
};

class ExecutionPlanner {
  constructor(options = {}) {
    this.router = options.router || new BackendRouter({ registry, doctor: doctorModule });
    this.classEnvelopes = { ...DEFAULT_CLASS_ENVELOPES_MB, ...(options.classEnvelopes || {}) };
    this.shardSizes = { ...DEFAULT_SHARD_SIZES, ...(options.shardSizes || {}) };
  }

  parseOptions(run) {
    try {
      return typeof run.input_options === 'string' ? JSON.parse(run.input_options || '{}') : (run.options || {});
    } catch (_e) {
      return {};
    }
  }

  /** Computes the safety envelope for THIS request from its own declared shape — never from history. */
  computeEnvelope(executionClass, options) {
    const baseMB = this.classEnvelopes[executionClass] || this.classEnvelopes.LOCAL_HTTP;
    const concurrency = Math.max(1, Number(options.internalConcurrency || 1));
    let envelope = baseMB * concurrency;

    // §10/§17 Request-specific sizing: a maxItems=5 shopify request does not
    // need the same envelope as maxItems=1000. Workload bands scale the
    // static per-class baseline without consulting any historical RAM
    // measurement. SMALL (<=20, the typical production request) is the safe
    // baseline at 1.0x, never a fraction of it — a 0.5x SMALL band would let
    // the Scheduler under-budget the majority of real-world requests.
    const maxItems = Number(options.maxItems || 100);
    if (maxItems <= 20) { /* SMALL: 1.0x baseline, the safety floor */ }
    else if (maxItems <= 100) envelope *= 1.25; // MEDIUM
    else if (maxItems <= 500) envelope *= 1.5;  // LARGE
    else envelope *= 2;                          // VERY_LARGE

    if (options.imageEnrichment) envelope *= 1.4;
    if (options.variantCrawling) envelope *= 1.3;
    if (options.heavyRawHtml) envelope *= 1.2;
    if (options.parallelTabs) envelope *= Math.max(1, Number(options.parallelTabs));

    // browserFallbackPossible: reserve the worst case (BROWSER envelope) up
    // front so no module can silently escalate to a browser mid-execution
    // without the scheduler already having budgeted for it.
    if (options.browserFallbackPossible && executionClass !== 'BROWSER') {
      envelope = Math.max(envelope, this.classEnvelopes.BROWSER);
    }

    return Math.round(envelope);
  }

  /**
   * Live-Readiness Round #4: sharding is only safe if the selected execution
   * has a REAL partition strategy (offset/page/cursor/url_list/item_id_list).
   * Default is false for every channel. Toidispy, for example, does not
   * consume offset/maxItems as a partition today, so a maxItems=100 Toidispy
   * run must execute as exactly one CDP execution, not five identical
   * "shards" that would just re-run the same search five times.
   */
  channelSupportsSharding(platform) {
    const localCap = getLocalCapability(platform);
    if (localCap) return Boolean(localCap.supportsSharding && localCap.partitionStrategy);
    // No non-local (apify/cdp) channel has a real partition strategy implemented today.
    return false;
  }

  computeShardPlan(executionClass, maxItems, options, platform) {
    if (!this.channelSupportsSharding(platform)) {
      return { shardSize: Number(maxItems || 1), shardCount: 1 };
    }
    const shardSize = Number(options.shardSize) > 0 ? Number(options.shardSize) : (this.shardSizes[executionClass] || maxItems);
    const shardCount = Math.max(1, Math.ceil(Number(maxItems || 1) / shardSize));
    return { shardSize, shardCount };
  }

  buildPlan({ platform, backend, backendName, executionClass, run, options }) {
    const maxItems = Number(options.maxItems || run.max_items || 100);
    const { shardSize, shardCount } = this.computeShardPlan(executionClass, maxItems, options, platform);
    const estimatedEnvelopeMB = this.computeEnvelope(executionClass, options);
    const pool = CLASS_TO_POOL[executionClass] || 'LOCAL';
    const taskCostMB = DEFAULT_TASK_COST_MB[executionClass] || DEFAULT_TASK_COST_MB.LOCAL_HTTP;

    return {
      platform,
      backend,
      backendName,
      executionClass,
      mode: options.mode || 'default',
      maxItems,
      shardSize,
      shardCount,
      internalConcurrency: Math.max(1, Number(options.internalConcurrency || 1)),
      browserRequired: executionClass === 'BROWSER',
      browserFallbackPossible: Boolean(options.browserFallbackPossible),
      estimatedEnvelopeMB,
      taskCostMB,
      confidence: 'STATIC_ENVELOPE', // Never "learned" — always this request's own shape.
      pool,
      jobKind: options.jobKind || 'channel',
      options
    };
  }

  /**
   * Resolves the real backend for a queued run before admission. Throws
   * NoHealthyBackendError / "Unknown channel" style errors from the router
   * unchanged — the scheduler decides what to do with a planning failure.
   */
  async plan(run) {
    const options = this.parseOptions(run);
    const jobKind = options.jobKind || 'channel';

    if (jobKind !== 'channel') {
      const staticPlan = NON_CHANNEL_JOB_PLANS[jobKind];
      if (!staticPlan) throw new Error(`Unknown non-channel jobKind: ${jobKind}`);
      return this.buildPlan({ platform: run.platform, backend: staticPlan.backend, backendName: staticPlan.backendName, executionClass: staticPlan.executionClass, run, options });
    }

    const { config, executionMode } = await this.router.selectBackend(run.platform, options);
    const kind = config.kind;
    // Live-Readiness Round #6: a local backend that will actually execute via
    // browser_fallback (SearXNG down, real Playwright/launchStealth fallback
    // selected) MUST be admitted/budgeted as BROWSER, not LOCAL_HTTP — the
    // Scheduler must never let a browser open under a LOCAL_HTTP resource plan.
    const executionClass = executionMode === 'browser_fallback' ? 'BROWSER' : (KIND_TO_CLASS[kind] || 'LOCAL_HTTP');
    const enrichedOptions = executionMode === 'browser_fallback' ? { ...options, browserFallbackPossible: true } : options;
    return this.buildPlan({ platform: run.platform, backend: kind, backendName: config.name, executionClass, run, options: enrichedOptions });
  }
}

module.exports = { ExecutionPlanner, KIND_TO_CLASS, CLASS_TO_POOL, DEFAULT_CLASS_ENVELOPES_MB, DEFAULT_SHARD_SIZES };
