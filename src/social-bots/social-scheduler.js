/**
 * Social Listening Scheduler Daemon
 *
 * P0-7: dedupe/schedule state lives in SQLite (social_bot_state), not in-memory
 * Map/Set. A server restart cannot cause duplicate dispatch or a lost window,
 * because "has this window been dispatched" is answered by a query, not by
 * process memory. The query rotation (which seed query to use this window) is
 * derived deterministically from the window slot number (`windowSlot % queries.length`)
 * instead of a separate in-memory pointer, so it is also restart-safe for free.
 *
 * Idempotency is enforced by the UNIQUE(bot_key, scheduled_window, query_key)
 * constraint in social_bot_state (see database.js reserveSocialBotWindow): only
 * one row can ever exist for a given window, so only one Run can ever be created
 * for it. If enqueuing the Run fails after the window was reserved, the reservation
 * is released so the window can be retried on the next tick instead of being
 * silently lost forever.
 */

const { BotConfigManager } = require('./bot-config');
const { BackendRouter } = require('../router/backend-router');
const { classifyFailureReason } = require('../reliability/failure-reason');

class SocialListeningScheduler {
  constructor(options = {}) {
    this.configManager = options.configManager || new BotConfigManager(options.configPath);
    this.scheduler = options.scheduler; // ResourceScheduler instance
    this.db = options.database || require('../database');
    this.checkIntervalMs = options.checkIntervalMs || 60000;
    this.timer = null;
    // Final Stabilization Round #14: a dependency preflight (does this bot's
    // channel currently have a usable backend?) runs before every automatic
    // tick's enqueue attempt, so a bot missing APIFY_TOKEN never creates one
    // doomed-to-fail Run per interval. Reused/injectable so tests can mock it.
    this.router = options.router || new BackendRouter({ registry: require('../channels/registry'), doctor: require('../doctor') });
    this.dependencyState = new Map(); // botKey -> { blocked, reasonCode, message, checkedAt }
  }

  /**
   * Probes whether `bot.platform`'s channel currently has a usable backend.
   * Never throws — a probe failure IS the answer (blocked=true), classified
   * into the same reason codes the Resource Scheduler uses for planning
   * failures (BLOCKED_CONFIGURATION/UNSUPPORTED never retried; DEPENDENCY_DOWN/
   * TRANSIENT_BACKEND_FAILURE left to the bot's own interval as natural backoff).
   */
  async preflightDependency(bot) {
    const checkedAt = new Date().toISOString();
    if (!bot.platform) {
      const state = { blocked: true, reasonCode: 'UNSUPPORTED', message: bot.unsupportedReason || 'No channel mapped', checkedAt };
      this.dependencyState.set(bot.key, state);
      return state;
    }
    try {
      await this.router.selectBackend(bot.platform, {});
      const state = { blocked: false, reasonCode: null, message: null, checkedAt };
      this.dependencyState.set(bot.key, state);
      return state;
    } catch (err) {
      const state = { blocked: true, reasonCode: classifyFailureReason(err), message: err.message, checkedAt };
      this.dependencyState.set(bot.key, state);
      return state;
    }
  }

  setScheduler(scheduler) {
    this.scheduler = scheduler;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(err => {
        console.error('[SocialScheduler] Tick error:', err.message);
      });
    }, this.checkIntervalMs);
    this.timer.unref();
    console.log('[SocialScheduler] Started social listening scheduler');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  windowSlotFor(bot, atMs = Date.now()) {
    const intervalMs = Math.max(5, bot.intervalMinutes || 60) * 60000;
    return Math.floor(atMs / intervalMs);
  }

  queryForWindow(bot, windowSlot) {
    const queries = Array.isArray(bot.queries) && bot.queries.length ? bot.queries : ['trending'];
    return queries[((windowSlot % queries.length) + queries.length) % queries.length];
  }

  /**
   * Reserves (bot.key, windowSlot, queryKey) and, if this process won the
   * reservation, submits the Run through the shared Resource Scheduler (never a
   * direct/unmanaged crawl). `queryKey` is the dedupe identity; `queryText` is
   * what actually gets sent as the search query (they are the same value for
   * normal scheduled ticks, but manual triggers use a unique queryKey so they
   * never collide with — or get silently absorbed by — the automatic slot).
   * Returns null if the window/queryKey was already dispatched.
   */
  async dispatchWindow(bot, queryText, windowSlot, queryKey = queryText) {
    if (!bot.platform) {
      throw new Error(`Bot '${bot.key}' has no mapped channel (${bot.unsupportedReason || 'unsupported'})`);
    }
    if (!this.scheduler) {
      throw new Error('ResourceScheduler is not configured');
    }

    const stateId = await this.db.reserveSocialBotWindow(bot.key, windowSlot, queryKey);
    if (stateId === null) {
      return null; // Already reserved/dispatched - restart-safe idempotency.
    }

    try {
      const run = await this.scheduler.submitRun({
        platform: bot.platform,
        query: queryText,
        maxItems: bot.maxItems || 30,
        options: {
          ...(bot.filters || {}),
          botKey: bot.key,
          source: 'social_listening'
        }
      });
      await this.db.markSocialBotDispatched(stateId, run.id);
      return run;
    } catch (err) {
      // Enqueue failed after the window was reserved: release the reservation so
      // this exact window is retried on the next tick instead of being lost.
      await this.db.releaseSocialBotWindow(stateId);
      throw err;
    }
  }

  async triggerBot(botKey, customQuery = null) {
    const bot = this.configManager.get(botKey);
    if (!bot) throw new Error(`Bot key not found: ${botKey}`);
    // Manual trigger must surface the dependency problem explicitly rather
    // than silently doing nothing or creating a doomed Run (#14).
    const preflight = await this.preflightDependency({ ...bot, key: botKey });
    if (preflight.blocked) {
      const err = new Error(`${preflight.reasonCode}: ${preflight.message}`);
      err.code = preflight.reasonCode;
      throw err;
    }
    const windowSlot = this.windowSlotFor(bot);
    const query = customQuery || this.queryForWindow(bot, windowSlot);
    const manualQueryKey = `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const run = await this.dispatchWindow({ ...bot, key: botKey }, query, windowSlot, manualQueryKey);
    return { success: run !== null, botKey, run };
  }

  async tick() {
    if (!this.scheduler) return;
    // Crash-safety sweep (#20): a process that died between reserving a window
    // and confirming dispatch would otherwise leave that window permanently
    // stuck as 'pending', blocked from ever being retried by the UNIQUE
    // constraint. Clear anything abandoned before evaluating due bots.
    if (typeof this.db.recoverStalePendingSocialBotWindows === 'function') {
      await this.db.recoverStalePendingSocialBotWindows();
    }
    const now = Date.now();
    const bots = this.configManager.getAll();

    // Parallel bot dispatch: each bot's preflight + dispatch is independent.
    // Dispatch just enqueues a run to the scheduler (lightweight).
    const { InternalTaskPool } = require('../scheduler/internal-task-pool');
    const activeBots = bots.filter(b => b.enabled && b.platform);
    const dispatchPool = new InternalTaskPool({
      concurrency: Math.min(4, activeBots.length),
      onTaskError: (idx, err) => {
        console.error(`[SocialScheduler] Failed to submit run for ${activeBots[idx].key}:`, err.message);
      }
    });

    await dispatchPool.run(activeBots, async (bot) => {
      const preflight = await this.preflightDependency(bot);
      if (preflight.blocked) {
        console.warn(`[SocialScheduler] ${bot.key} skipped (${preflight.reasonCode}): ${preflight.message}`);
        return; // skip — not an error
      }

      const windowSlot = this.windowSlotFor(bot, now);
      const query = this.queryForWindow(bot, windowSlot);
      await this.dispatchWindow(bot, query, windowSlot);
    });
  }

  async getStatus() {
    const bots = this.configManager.getAll();
    const now = Date.now();

    // Each row needs two Postgres reads (last dispatch, dispatch count). Under
    // better-sqlite3 those were synchronous inside a plain map(); now they are
    // awaited per bot, so the map produces promises resolved together here.
    return Promise.all(bots.map(async b => {
      const windowSlot = this.windowSlotFor(b, now);
      const intervalMs = Math.max(5, b.intervalMinutes || 60) * 60000;
      const nextRunAt = new Date((windowSlot + 1) * intervalMs).toISOString();
      const last = b.platform ? await this.db.getLastDispatchedSocialBotWindow(b.key) : null;
      const dependency = this.dependencyState.get(b.key) || null;

      return {
        key: b.key,
        platform: b.platform,
        displayName: b.displayName,
        enabled: b.enabled,
        unsupportedReason: b.unsupportedReason || null,
        intervalMinutes: b.intervalMinutes,
        queries: b.queries,
        filters: b.filters,
        lastRunAt: last ? last.created_at : null,
        nextRunAt,
        totalDispatched: b.platform ? await this.db.countDispatchedSocialBotRuns(b.key) : 0,
        // #14: surfaces why an enabled bot with a real channel isn't actually
        // dispatching (e.g. BLOCKED_CONFIGURATION for a missing APIFY_TOKEN)
        // without requiring the user to dig through server logs.
        blockedReason: dependency && dependency.blocked ? `${dependency.reasonCode}: ${dependency.message}` : null,
        lastDependencyCheckAt: dependency ? dependency.checkedAt : null
      };
    }));
  }
}

let globalSocialScheduler = null;

function getSocialScheduler(options = {}) {
  if (!globalSocialScheduler) {
    globalSocialScheduler = new SocialListeningScheduler(options);
  }
  return globalSocialScheduler;
}

module.exports = {
  SocialListeningScheduler,
  getSocialScheduler
};
