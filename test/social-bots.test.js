const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { BotConfigManager } = require('../src/social-bots/bot-config');
const { SocialListeningScheduler } = require('../src/social-bots/social-scheduler');

function makeSocialBotDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE social_bot_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_key TEXT NOT NULL,
      scheduled_window INTEGER NOT NULL,
      query_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      run_id INTEGER,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bot_key, scheduled_window, query_key)
    )
  `);
  const stmt = {
    reserveWindow: db.prepare("INSERT INTO social_bot_state (bot_key, scheduled_window, query_key, status) VALUES (@botKey, @scheduledWindow, @queryKey, 'pending')"),
    markDispatched: db.prepare('UPDATE social_bot_state SET status=\'dispatched\', run_id=@runId WHERE id=@id'),
    deleteById: db.prepare('DELETE FROM social_bot_state WHERE id = ?'),
    findLast: db.prepare("SELECT * FROM social_bot_state WHERE bot_key = ? AND status = 'dispatched' ORDER BY scheduled_window DESC LIMIT 1"),
    countDispatched: db.prepare("SELECT COUNT(*) c FROM social_bot_state WHERE bot_key = ? AND status = 'dispatched'")
  };
  return {
    raw: db,
    reserveSocialBotWindow: (botKey, scheduledWindow, queryKey) => {
      try {
        return stmt.reserveWindow.run({ botKey, scheduledWindow, queryKey }).lastInsertRowid;
      } catch (err) {
        if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) return null;
        throw err;
      }
    },
    markSocialBotDispatched: (id, runId) => stmt.markDispatched.run({ id, runId }),
    releaseSocialBotWindow: (id) => stmt.deleteById.run(id),
    getLastDispatchedSocialBotWindow: (botKey) => stmt.findLast.get(botKey),
    countDispatchedSocialBotRuns: (botKey) => stmt.countDispatched.get(botKey).c
  };
}

test('BotConfigManager initializes bots, keeps TikTok disabled with an unsupported reason (P0-6), and blocks enabling fake platforms', () => {
  const testConfigPath = './data/test-social-bots-' + Date.now() + '.json';
  const manager = new BotConfigManager(testConfigPath);

  const all = manager.getAll();
  const platforms = new Map(all.map(b => [b.key, b]));
  assert.ok(platforms.has('facebook'));
  assert.ok(platforms.has('tiktok'));
  assert.ok(platforms.has('reddit'));
  assert.ok(platforms.has('instagram'));
  assert.ok(platforms.has('twitter'));

  const tiktok = platforms.get('tiktok');
  assert.equal(tiktok.enabled, false, 'TikTok must stay disabled: no real hashtag/video channel exists');
  assert.equal(tiktok.platform, null);
  assert.ok(tiktok.unsupportedReason && tiktok.unsupportedReason.length > 0);

  assert.throws(() => manager.update('tiktok', { enabled: true }), /Cannot enable bot/);

  const updated = manager.update('reddit', { intervalMinutes: 45, queries: ['gift idea', 'trendy shirt'] });
  assert.equal(updated.intervalMinutes, 45);

  try { require('fs').unlinkSync(testConfigPath); } catch (_e) {}
});

test('SocialListeningScheduler dispatches due bots through the shared scheduler exactly once per window, never duplicating (P0-7)', async () => {
  const submittedRuns = [];
  let nextRunId = 1;
  const mockScheduler = {
    submitRun: async (payload) => {
      const run = { id: nextRunId++, ...payload, status: 'queued' };
      submittedRuns.push(run);
      return run;
    }
  };

  const testConfigPath = './data/test-social-bots-sched-' + Date.now() + '.json';
  const manager = new BotConfigManager(testConfigPath);
  for (const b of manager.getAll()) {
    if (b.platform) manager.update(b.key, { enabled: true });
  }
  const socialDb = makeSocialBotDb();
  const fixedNow = new Date('2026-08-24T10:00:00Z').getTime();

  const scheduler1 = new SocialListeningScheduler({ configManager: manager, scheduler: mockScheduler, database: socialDb });
  scheduler1.windowSlotFor = function (bot) { return Math.floor(fixedNow / (Math.max(5, bot.intervalMinutes || 60) * 60000)); };

  await scheduler1.tick();
  const countAfterFirstTick = submittedRuns.length;
  assert.ok(countAfterFirstTick >= 1, 'Should dispatch enabled bots with a real channel');
  assert.ok(!submittedRuns.some(r => r.platform === null), 'Disabled/unmapped bots (tiktok) must never be submitted');

  // Same window, ticked again immediately - must NOT duplicate.
  await scheduler1.tick();
  assert.equal(submittedRuns.length, countAfterFirstTick, 'Repeated tick within the same window must not re-dispatch');

  // Simulate a full server restart: brand-new scheduler instance, same DB.
  const scheduler2 = new SocialListeningScheduler({ configManager: manager, scheduler: mockScheduler, database: socialDb });
  scheduler2.windowSlotFor = function (bot) { return Math.floor(fixedNow / (Math.max(5, bot.intervalMinutes || 60) * 60000)); };
  await scheduler2.tick();
  assert.equal(submittedRuns.length, countAfterFirstTick, 'A restarted scheduler must not re-dispatch an already-dispatched window (P0-7 restart test)');

  // Manual trigger works immediately and is not blocked by the automatic window.
  const triggerRes = await scheduler1.triggerBot('reddit', 'handmade mug');
  assert.equal(triggerRes.success, true);
  assert.equal(submittedRuns[submittedRuns.length - 1].query, 'handmade mug');

  try { require('fs').unlinkSync(testConfigPath); } catch (_e) {}
});

// Final Stabilization Round #14 mandatory scenario: a bot whose channel is
// missing required configuration (e.g. APIFY_TOKEN) must not create one
// failed Run per automatic tick, and the block reason must be inspectable.
test('SocialListeningScheduler skips automatic dispatch for a BLOCKED_CONFIGURATION dependency without spamming failed Runs (#14)', async () => {
  const submittedRuns = [];
  const mockScheduler = {
    submitRun: async (payload) => { submittedRuns.push(payload); return { id: submittedRuns.length, ...payload }; }
  };
  const blockedErr = new Error('No usable backend found for facebook_posts. Please run doctor.');
  blockedErr.name = 'NoHealthyBackendError';
  blockedErr.diagnostic = { backends: [{ name: 'apify', missing: ['APIFY_TOKEN is missing'], warnings: [] }] };
  const mockRouter = { selectBackend: async (platform) => { if (platform === 'facebook_posts') throw blockedErr; return { config: {}, executionMode: null }; } };

  const testConfigPath = './data/test-social-bots-blocked-' + Date.now() + '.json';
  const manager = new BotConfigManager(testConfigPath);
  manager.update('facebook', { enabled: true });
  const socialDb = makeSocialBotDb();
  const fixedNow = new Date('2026-08-24T10:00:00Z').getTime();

  const scheduler = new SocialListeningScheduler({ configManager: manager, scheduler: mockScheduler, database: socialDb, router: mockRouter });
  scheduler.windowSlotFor = function (bot) { return Math.floor(fixedNow / (Math.max(5, bot.intervalMinutes || 60) * 60000)); };

  await scheduler.tick();
  assert.ok(!submittedRuns.some(r => r.platform === 'facebook_posts'), 'Facebook must not be dispatched while its dependency is blocked');

  const status = (await scheduler.getStatus()).find(b => b.key === 'facebook');
  assert.ok(status.blockedReason && status.blockedReason.startsWith('BLOCKED_CONFIGURATION'), `Expected BLOCKED_CONFIGURATION, got: ${status.blockedReason}`);
  assert.ok(status.lastDependencyCheckAt, 'lastDependencyCheckAt must be recorded');

  // Manual trigger must surface the same block explicitly, not silently no-op.
  await assert.rejects(() => scheduler.triggerBot('facebook'), /BLOCKED_CONFIGURATION/);

  try { require('fs').unlinkSync(testConfigPath); } catch (_e) {}
});

test('SocialListeningScheduler releases the window reservation if enqueue fails, allowing retry', async () => {
  let attempts = 0;
  const failingScheduler = {
    submitRun: async () => {
      attempts++;
      throw new Error('SCHEDULER_UNAVAILABLE');
    }
  };

  const testConfigPath = './data/test-social-bots-retry-' + Date.now() + '.json';
  const manager = new BotConfigManager(testConfigPath);
  const socialDb = makeSocialBotDb();
  const scheduler = new SocialListeningScheduler({ configManager: manager, scheduler: failingScheduler, database: socialDb });

  const bot = manager.get('reddit');
  const windowSlot = 12345;

  await assert.rejects(() => scheduler.dispatchWindow({ ...bot, key: 'reddit' }, 'gift idea', windowSlot), /SCHEDULER_UNAVAILABLE/);
  assert.equal(attempts, 1);

  // Reservation must have been released - retrying the same window must attempt again, not silently no-op.
  await assert.rejects(() => scheduler.dispatchWindow({ ...bot, key: 'reddit' }, 'gift idea', windowSlot), /SCHEDULER_UNAVAILABLE/);
  assert.equal(attempts, 2, 'Failed enqueue must release the window so it can be retried, not lost forever');

  try { require('fs').unlinkSync(testConfigPath); } catch (_e) {}
});
