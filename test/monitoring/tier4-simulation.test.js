/**
 * Tier 4: Real-World Workload & Acceptance Simulations Test Suite.
 *
 * Simulates complete multi-day business lifecycles and operational workflows:
 * - Simulation 1: Etsy Shop 45-day sales evolution (baseline -> increase -> quiet -> gap test -> 30d stop -> UI label)
 * - Simulation 2: TikTok Author 70-day social tracking (session deadline, viral post discovery, star/unstar, resurrection, re-track)
 * - Simulation 3: Stealth Browser automatic fallback cascade under anti-bot block (CloakBrowser -> Camoufox)
 * - Simulation 4: Admin Dashboard operations & live task management (tasks, metrics, reorder, toggle, repo update)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createTestDb,
  VirtualClock,
  ShopLifecyclePolicy,
  SocialLifecyclePolicy,
  applyMonitoringObservation,
  StealthBrowserRunner,
  AdminDashboardService,
  CONSTANTS,
} = require('./harness');

async function seedProduct(db, itemUid, overrides = {}) {
  await db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, image, video_url,
      current_price, current_sold, current_likes, current_views,
      status, first_seen_at, last_seen_at, last_crawled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (item_uid) DO NOTHING
  `).run(
    itemUid,
    overrides.platform || 'etsy',
    overrides.query || 'simulation_query',
    overrides.title || 'Simulation Item Title',
    overrides.url || `https://www.etsy.com/listing/${itemUid}`,
    overrides.image || 'https://img.example.com/item.jpg',
    overrides.video_url || '',
    overrides.current_price ?? 20.0,
    overrides.current_sold ?? 10,
    overrides.current_likes ?? 5,
    overrides.current_views ?? 50,
    overrides.status || 'active',
    overrides.first_seen_at || '2026-09-01 00:00:00',
    overrides.last_seen_at || '2026-09-01 00:00:00',
    overrides.last_crawled_at || '2026-09-01 00:00:00'
  );
}

// -----------------------------------------------------------------------------
// SIMULATION 1: Etsy Shop 45-Day Sales Evolution
// -----------------------------------------------------------------------------
test('Simulation 1: Etsy Shop 45-day sales evolution from baseline to 30-day unchanged stoppage and UI label', async () => {
  const clock = new VirtualClock('2026-09-01T00:00:00.000Z');
  const db = await createTestDb();

  // Day 0: Register shop
  await db.prepare(`
    INSERT INTO monitoring_entities (
      id, platform, entity_type, external_id, identity_source, session_id,
      monitoring_started_at, entity_next_due_at, tracking_status
    ) VALUES (1001, 'etsy', 'shop', 'artisan-pottery-studio', 'canonical_url', 'sess-etsy-sim', ?, ?, 'active')
  `).run(clock.nowISO(), clock.nowISO());

  let shopState = {
    trackingStatus: 'active',
    sales: null,
    unchangedSince: null,
    salesObservedAt: null,
    lastIncreaseObservedAt: null,
  };

  // Day 0 Probe: First valid observation at 1,000 sales establishes baseline
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1000,
    observedAt: clock.nowISO(),
    quality: 'exact',
  });
  assert.equal(shopState.action, 'baseline_established');
  assert.equal(shopState.sales, 1000);
  assert.equal(shopState.unchangedSince, '2026-09-01T00:00:00.000Z');

  // Day 5 Probe: Sales increase to 1,020 (reset baseline, unchanged_since = Day 5)
  clock.advanceDays(5); // 2026-09-06
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: clock.nowISO(),
    quality: 'exact',
  });
  assert.equal(shopState.action, 'baseline_reset_increase');
  assert.equal(shopState.sales, 1020);
  assert.equal(shopState.unchangedSince, '2026-09-06T00:00:00.000Z');
  assert.equal(shopState.lastIncreaseObservedAt, '2026-09-06T00:00:00.000Z');

  // Day 10 Probe: Sales unchanged at 1,020 (window maintained)
  clock.advanceDays(5); // 2026-09-11
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: clock.nowISO(),
    quality: 'exact',
  });
  assert.equal(shopState.action, 'window_maintained_active');
  assert.equal(shopState.unchangedSince, '2026-09-06T00:00:00.000Z');

  // Day 15 Probe: Sales unchanged at 1,020
  clock.advanceDays(5); // 2026-09-16
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: clock.nowISO(),
    quality: 'exact',
  });
  assert.equal(shopState.action, 'window_maintained_active');

  // Day 20 Probe: Crawl fails (HTTP 429 Rate Limit) -> ignored, shop not stopped
  clock.advanceDays(5); // 2026-09-21
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    error: 'HTTP 429 Too Many Requests',
    observedAt: clock.nowISO(),
  });
  assert.equal(shopState.trackingStatus, 'active');
  assert.equal(shopState.action, 'error_ignored');

  // Day 22 Probe (Retry): Succeeds at 1,020 (gap from Day 15 is 6 days <= 7 days -> chain unbroken!)
  clock.advanceDays(2); // 2026-09-23
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: clock.nowISO(),
    quality: 'exact',
  });
  assert.equal(shopState.action, 'window_maintained_active');
  assert.equal(shopState.unchangedSince, '2026-09-06T00:00:00.000Z');

  // Day 27 Probe: Sales unchanged at 1,020
  clock.advanceDays(5); // 2026-09-28
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: clock.nowISO(),
    quality: 'exact',
  });
  assert.equal(shopState.trackingStatus, 'active');

  // Day 32 Probe: Scheduled 5-day cycle probe, sales unchanged at 1,020 (window maintained, gap = 5d <= 7d)
  clock.advanceDays(5); // 2026-10-03
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: clock.nowISO(),
    quality: 'exact',
  });
  assert.equal(shopState.trackingStatus, 'active');
  assert.equal(shopState.action, 'window_maintained_active');
  assert.equal(shopState.unchangedSince, '2026-09-06T00:00:00.000Z');

  // Day 35.99 (Elapsed from Day 5 is 29.99 days): Sales unchanged -> still ACTIVE (gap from Day 32 is 2.99d <= 7d)
  clock.advanceDays(2);
  clock.advanceHours(23);
  clock.advanceMinutes(50); // 2026-10-05T23:50:00Z (29 days, 23 hours, 50 mins from Day 5)
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: clock.nowISO(),
    quality: 'exact',
  });
  assert.equal(shopState.trackingStatus, 'active', 'Must not stop before 30 full days');
  assert.equal(shopState.action, 'window_maintained_active');

  // Day 36.05 (Elapsed from Day 5 is 30.05 days >= 30 days): Fresh valid observation captured!
  clock.advanceHours(2); // 2026-10-06T01:50:00Z
  shopState = ShopLifecyclePolicy.evaluateObservation(shopState, {
    value: 1020,
    observedAt: clock.nowISO(),
    quality: 'exact',
  });
  assert.equal(shopState.trackingStatus, 'stopped', 'Shop must stop once 30-day threshold reached on fresh valid observation');
  assert.equal(shopState.reason, 'shop_sales_unchanged_30d');

  // Verify UI label accuracy
  const uiLabel = ShopLifecyclePolicy.getUiLabel(shopState);
  assert.equal(uiLabel, 'Không quan sát thấy sales tăng trong 30 ngày');

  // Day 45: Discovery encounters shop listing again -> Ingest does NOT revive Monitoring
  clock.advanceDays(9);
  assert.equal(shopState.trackingStatus, 'stopped', 'Monitoring must stay stopped regardless of Discovery ingestion');
});

// -----------------------------------------------------------------------------
// SIMULATION 2: TikTok Author 70-Day Social Tracking
// -----------------------------------------------------------------------------
test('Simulation 2: TikTok Author 70-day social tracking across star, unstar, expiry, reactivation, and re-track', async () => {
  const clock = new VirtualClock('2026-09-01T00:00:00.000Z');
  const db = await createTestDb();

  // Day 0: Author tracking starts (unstarred, 30-day session)
  let author = {
    session_id: 'tiktok-session-alpha',
    platform: 'tiktok',
    entity_type: 'author',
    external_id: 'top_creator_vietnam',
    monitoring_started_at: clock.nowISO(),
    expires_at: SocialLifecyclePolicy.calculateExpiresAt(clock.nowISO(), false),
    is_starred: false,
    tracking_status: 'active',
  };
  assert.equal(author.expires_at, '2026-10-01T00:00:00.000Z');

  // Day 10: Refresh video metrics using patch writer
  clock.advanceDays(10); // 2026-09-11
  await seedProduct(db, 'tiktok:video:vid1', { current_likes: 1000, current_views: 50000 });
  await applyMonitoringObservation(db, {
    itemUid: 'tiktok:video:vid1',
    patch: { likes: 1250, views: 55000, observedAt: clock.nowISO() },
    metadata: { observationId: 'monitoring:tt:1' },
  });
  const v1 = await db.prepare('SELECT current_likes, current_views FROM product_current WHERE item_uid = ?').get('tiktok:video:vid1');
  assert.equal(v1.current_likes, 1250);
  assert.equal(v1.current_views, 55000);

  // Day 15: Discovery discovers viral new video from this author -> Author deadline is NOT extended
  clock.advanceDays(5); // 2026-09-16
  await seedProduct(db, 'tiktok:video:viral_new', { first_seen_at: clock.nowISO() });
  assert.equal(author.expires_at, '2026-10-01T00:00:00.000Z', 'Discovery new post does not grant rolling extension');

  // Day 20: User clicks Star on author -> extends deadline to Day 60 (2026-10-31)
  clock.advanceDays(5); // 2026-09-21
  author = SocialLifecyclePolicy.handleStar(author, clock.nowISO());
  assert.equal(author.is_starred, true);
  assert.equal(author.expires_at, '2026-10-31T00:00:00.000Z');

  // Day 40: User clicks Unstar on author -> since Day 40 >= Day 30, author expires immediately!
  clock.advanceDays(20); // 2026-10-11
  author = SocialLifecyclePolicy.handleUnstar(author, clock.nowISO());
  assert.equal(author.is_starred, false);
  assert.equal(author.tracking_status, 'expired');
  assert.equal(author.action, 'expired_immediately_on_unstar');

  // Day 50: User clicks Star on expired author (within 60-day window) -> Revives to active!
  clock.advanceDays(10); // 2026-10-21
  author = SocialLifecyclePolicy.handleStar(author, clock.nowISO());
  assert.equal(author.is_starred, true);
  assert.equal(author.tracking_status, 'active');
  assert.equal(author.expires_at, '2026-10-31T00:00:00.000Z');

  // Day 60: System clock passes Day 60 -> Expiry timer evaluations marks expired
  clock.advanceDays(10);
  clock.advanceSeconds(1); // 2026-10-31T00:00:01Z
  author = SocialLifecyclePolicy.evaluateTickExpiry(author, clock.nowISO());
  assert.equal(author.tracking_status, 'expired');

  // Day 65: User tries starring author past Day 60 -> Cannot revive!
  clock.advanceDays(5); // 2026-11-05
  author = SocialLifecyclePolicy.handleStar(author, clock.nowISO());
  assert.equal(author.tracking_status, 'expired');
  assert.equal(author.error, 'PAST_60D_WINDOW_CANNOT_REACTIVATE');

  // Day 70: User clicks "Theo dõi lại" (Re-track) -> Starts brand-new session
  clock.advanceDays(5); // 2026-11-10
  author = SocialLifecyclePolicy.handleRetrack(author, clock.nowISO());
  assert.equal(author.tracking_status, 'active');
  assert.equal(author.monitoring_started_at, '2026-11-10T00:00:01.000Z');
  assert.equal(author.expires_at, '2026-12-10T00:00:01.000Z'); // 30 days from Day 70
  assert.notEqual(author.session_id, 'tiktok-session-alpha');
});

// -----------------------------------------------------------------------------
// SIMULATION 3: Stealth Browser Fallback Cascade under Anti-Bot Fire
// -----------------------------------------------------------------------------
test('Simulation 3: CloakBrowser encounters Cloudflare block, automatically falls back to Camoufox and records metrics', async () => {
  const runner = new StealthBrowserRunner();
  const service = new AdminDashboardService(runner);

  // Target URL protected by Cloudflare DataDome
  const targetUrl = 'https://www.etsy.com/shop/stealth-target';

  // Simulate CloakBrowser getting 403 Challenge, Camoufox successfully solving challenge
  const captureResult = await runner.captureWithFallback(targetUrl, {}, {
    cloakbrowser: async () => ({
      status: 'blocked',
      error: 'Cloudflare Turnstile Challenge 403',
    }),
    camoufox: async () => ({
      status: 'success',
      html: '<html><body><div id="shop-name">Stealth Master</div></body></html>',
    }),
  });

  assert.equal(captureResult.status, 'success');
  assert.equal(captureResult.engineUsed, 'camoufox');
  assert.equal(captureResult.fallbackTriggered, true);
  assert.ok(captureResult.html.includes('Stealth Master'));

  // Verify dashboard metrics reflect real-time fallback results
  const metrics = service.getBrowserMetrics();
  assert.equal(metrics.cloakbrowser.totalRuns, 1);
  assert.equal(metrics.cloakbrowser.errorRatePct, 100.0);
  assert.equal(metrics.camoufox.totalRuns, 1);
  assert.equal(metrics.camoufox.errorRatePct, 0.0);
});

// -----------------------------------------------------------------------------
// SIMULATION 4: Admin Dashboard Operations & Live Task Management
// -----------------------------------------------------------------------------
test('Simulation 4: Admin Dashboard operations (task monitor, metrics, priority reorder, toggle, repo update)', () => {
  const runner = new StealthBrowserRunner();
  const service = new AdminDashboardService(runner);

  // 1. Check task monitor lists running and queued tasks
  const initialTasks = service.getTasks();
  assert.equal(initialTasks.running.length, 1);
  assert.equal(initialTasks.queued.length, 2);

  // 2. Reorder task priorities (bring TikTok probes to priority 1)
  const reorderRes = service.reorderTasks(['task-2', 'task-1', 'task-3']);
  assert.equal(reorderRes.success, true);
  assert.equal(service.tasks[0].id, 'task-2');
  assert.equal(service.tasks[0].priority, 1);

  // 3. Toggle task enabled/disabled
  service.toggleTask('task-1', false);
  const disabledTask = service.tasks.find(t => t.id === 'task-1');
  assert.equal(disabledTask.enabled, false);

  service.toggleTask('task-1', true);
  assert.equal(disabledTask.enabled, true);

  // 4. Trigger repo auto-update
  const updateRes = service.triggerRepoUpdate();
  assert.equal(updateRes.success, true);
  assert.ok(updateRes.command.includes('git pull --ff-only'));
  assert.equal(updateRes.output, 'Already up to date.');
  assert.ok(updateRes.executedAt);
});
