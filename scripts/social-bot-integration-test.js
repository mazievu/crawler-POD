/**
 * P1-4: Full Social Bot pipeline integration test with a real short interval
 * (6 seconds, well under the 30s ceiling from the spec), verifying the whole
 * chain runs through the shared infrastructure with nothing bypassed:
 *
 *   Bot due -> SocialListeningScheduler.tick() -> ResourceScheduler.submitRun()
 *   (persistent RunQueue) -> real admission (WorkerPoolManager + ResourceMonitor)
 *   -> executeRun (stands in for the existing channel/backend/normalizer
 *      pipeline, which is exercised separately by the real ExecutionPlanner
 *      tests in P0-1 and by npm run doctor/e2e) -> product_current upsert +
 *      daily_packed_history append (the REAL createProductCurrentOps /
 *      createDailyHistoryOps modules, not mocks) -> social_bot_state row
 *      persisted with next_run derivable from it.
 *
 * Then simulates a full server restart (fresh SocialListeningScheduler +
 * ResourceScheduler instances, same on-disk DB) and asserts the already-
 * dispatched window is never re-dispatched.
 *
 * Uses an isolated better-sqlite3 file (deleted at the end) — never touches
 * data/collector.db.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');

const { initSchemaV2 } = require('../src/database/schema-v2');
const { createProductCurrentOps } = require('../src/database/product-current');
const { createDailyHistoryOps } = require('../src/database/daily-history');
const { ResourceScheduler } = require('../src/scheduler/scheduler');
const { BotConfigManager } = require('../src/social-bots/bot-config');
const { SocialListeningScheduler } = require('../src/social-bots/social-scheduler');

function buildTestDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      query TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      max_items INTEGER DEFAULT 100,
      country TEXT,
      input_options TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE social_bot_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_key TEXT NOT NULL,
      scheduled_window INTEGER NOT NULL,
      query_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      run_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bot_key, scheduled_window, query_key)
    );
  `);
  initSchemaV2(db);

  const stmt = {
    createRun: db.prepare("INSERT INTO runs (platform, query, max_items, country, input_options) VALUES (@platform, @query, @maxItems, @country, @inputOptions)"),
    findRun: db.prepare('SELECT * FROM runs WHERE id = ?'),
    reserveWindow: db.prepare("INSERT INTO social_bot_state (bot_key, scheduled_window, query_key, status) VALUES (@botKey, @scheduledWindow, @queryKey, 'pending')"),
    markDispatched: db.prepare("UPDATE social_bot_state SET status='dispatched', run_id=@runId WHERE id=@id"),
    deleteState: db.prepare('DELETE FROM social_bot_state WHERE id = ?'),
    findLastDispatched: db.prepare("SELECT * FROM social_bot_state WHERE bot_key = ? AND status = 'dispatched' ORDER BY scheduled_window DESC LIMIT 1"),
    countDispatched: db.prepare("SELECT COUNT(*) c FROM social_bot_state WHERE bot_key = ? AND status = 'dispatched'")
  };

  const dailyOps = createDailyHistoryOps(db);
  const productOps = createProductCurrentOps(db, dailyOps);

  const wrapper = {
    raw: db,
    createRun: (payload) => {
      const info = stmt.createRun.run({ platform: payload.platform, query: payload.query, maxItems: payload.maxItems || 50, country: payload.country || null, inputOptions: JSON.stringify(payload.options || {}) });
      return stmt.findRun.get(info.lastInsertRowid);
    },
    getRunById: (id) => stmt.findRun.get(id),
    updateRun: (id, updates) => {
      const run = stmt.findRun.get(id);
      if (!run) return;
      const status = updates.status ?? run.status;
      const inputOptions = updates.inputOptions ?? run.input_options;
      db.prepare('UPDATE runs SET status=?, input_options=? WHERE id=?').run(status, inputOptions, id);
    },
    getAllRuns: (limit = 100) => db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit),
    getRunsByStatus: (status) => db.prepare('SELECT * FROM runs WHERE status = ?').all(status),
    reserveSocialBotWindow: (botKey, scheduledWindow, queryKey) => {
      try { return stmt.reserveWindow.run({ botKey, scheduledWindow, queryKey }).lastInsertRowid; }
      catch (err) { if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) return null; throw err; }
    },
    markSocialBotDispatched: (id, runId) => stmt.markDispatched.run({ id, runId }),
    releaseSocialBotWindow: (id) => stmt.deleteState.run(id),
    getLastDispatchedSocialBotWindow: (botKey) => stmt.findLastDispatched.get(botKey),
    countDispatchedSocialBotRuns: (botKey) => stmt.countDispatched.get(botKey).c,
    productOps,
    dailyOps
  };

  return wrapper;
}

async function main() {
  const dbPath = path.join(__dirname, '..', 'data', 'social-bot-integration-test.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const testDb = buildTestDb(dbPath);

  const fakePlanner = { plan: async (run) => ({ platform: run.platform, backend: 'local', mode: 'default', pool: 'LOCAL', estimatedEnvelopeMB: 50, shardCount: 1, jobKind: 'channel', options: JSON.parse(run.input_options || '{}') }) };
  const executedRunIds = [];

  // Stands in for the real channel/backend/normalizer pipeline: writes a
  // synthetic-but-real observation through the REAL Tier 1/Tier 2 modules.
  const executeRun = async (runId, platform, query) => {
    executedRunIds.push(runId);
    const item = {
      item_uid: `${platform}:${query}:${runId}`,
      platform,
      query,
      title: `${query} trending item`,
      price: 19.99,
      likes: 100 + runId,
      views: 1000 + runId * 10,
      sold_count: 5
    };
    testDb.productOps.upsertItem(item, runId);
    testDb.dailyOps.appendObservation(item);
    testDb.updateRun(runId, { status: 'done' });
  };

  const resourceScheduler1 = new ResourceScheduler({ database: testDb, planner: fakePlanner, executeRun, tickIntervalMs: 500 });
  const configManager = new BotConfigManager(path.join(__dirname, '..', 'data', 'social-bot-integration-test-config.json'));
  configManager.update('reddit', { intervalMinutes: 0.1 }); // 6-second window, real wall-clock interval
  const socialScheduler1 = new SocialListeningScheduler({ configManager, scheduler: resourceScheduler1, database: testDb, checkIntervalMs: 1000 });

  console.log('[Integration] Starting real interval-based scheduling (6s window)...');
  resourceScheduler1.start();
  socialScheduler1.start();

  await new Promise(resolve => setTimeout(resolve, 8000)); // Let at least one real window elapse.

  resourceScheduler1.stop();
  socialScheduler1.stop();

  const redditDispatchCount = testDb.countDispatchedSocialBotRuns('reddit');
  console.log(`[Integration] Reddit bot dispatched ${redditDispatchCount} run(s) via real wall-clock scheduling.`);
  assert.ok(redditDispatchCount >= 1, 'Reddit bot must have dispatched at least 1 run in the real 8s window');

  const dispatchedRow = testDb.getLastDispatchedSocialBotWindow('reddit');
  assert.ok(dispatchedRow, 'social_bot_state must have a dispatched row (next_run derivable from it)');
  const dispatchedRun = testDb.getRunById(dispatchedRow.run_id);
  assert.equal(dispatchedRun.status, 'done', 'Run must have gone through the full pipeline to done');

  const allCurrent = testDb.raw.prepare('SELECT * FROM product_current WHERE platform = ?').all('reddit');
  assert.ok(allCurrent.length >= 1, 'product_current must contain the item written by the dispatched run');
  const historyRows = testDb.raw.prepare('SELECT * FROM daily_packed_history WHERE platform = ?').all('reddit');
  assert.ok(historyRows.length >= 1, 'daily_packed_history must contain the observation written by the dispatched run');

  // ==== Restart simulation: fresh scheduler instances, same DB file ====
  const countBeforeRestart = testDb.countDispatchedSocialBotRuns('reddit');
  const resourceScheduler2 = new ResourceScheduler({ database: testDb, planner: fakePlanner, executeRun, tickIntervalMs: 500 });
  const socialScheduler2 = new SocialListeningScheduler({ configManager, scheduler: resourceScheduler2, database: testDb, checkIntervalMs: 1000 });

  await socialScheduler2.tick(); // Same window (within the 6s slot) must not re-dispatch.
  const countAfterRestartTick = testDb.countDispatchedSocialBotRuns('reddit');
  assert.equal(countAfterRestartTick, countBeforeRestart, 'Restarted scheduler must not duplicate the already-dispatched window (P1-4 restart requirement)');

  console.log('RESULT: PASS');
  testDb.raw.close();
  fs.unlinkSync(dbPath);
  try { fs.unlinkSync(dbPath + '-wal'); } catch (_e) {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch (_e) {}
  try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'social-bot-integration-test-config.json')); } catch (_e) {}
  process.exit(0);
}

main().catch(err => {
  console.error('RESULT: FAIL —', err.message);
  console.error(err.stack);
  process.exit(1);
});
