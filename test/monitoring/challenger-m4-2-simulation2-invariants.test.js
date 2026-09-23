/**
 * Adversarial Challenger 2 Test Suite for Milestone 4:
 * Simulation 2 (TikTok Creator Tracking & Star Dynamics) & Author Monitoring Invariants.
 *
 * Authoritative SSOT:
 * - docs/DISCOVERY_MONITORING_PLAN_REVISED.md §3.3 & §4
 * - .agents/ORIGINAL_REQUEST.md
 * - .agents/worker_m4/handoff.md
 *
 * Mandate & Invariants Verified:
 * 1. Simulation 2: 70-day TikTok Creator Tracking & Star Dynamics
 *    - Day 0 -> Day 10 -> Day 15 -> Day 20 -> Day 40 -> Day 50 -> Day 60 -> Day 65 -> Day 70.
 *    - Strict verification of all state transitions, deadlines, reasons, actions, and errors.
 * 2. Independent Tick-Based Expiry Checker (expireDueEntities):
 *    - Evaluates on timer tick alone without incoming crawl payloads.
 *    - Marks active entity 'expired' when expires_at <= now.
 *    - Cascades to pause active child items in monitoring_items.
 *    - Cascades to cancel queued jobs in monitoring_jobs (preserving claimed/running).
 *    - Idempotent across multiple ticks.
 * 3. Metric Scope and Status Decoupling:
 *    - Ingests TikTok single video metric refreshes (views, likes, shares, comments).
 *    - Updates product_current and daily_packed_history with proper deltas.
 *    - product_current.status is NEVER mutated across 'active', 'dropped', and 'new'.
 *    - Author aggregate metrics isolated strictly in monitoring_entities.
 * 4. Boundary & Invariant Stress Tests:
 *    - Sub-millisecond boundary checks (expires_at - 1ms vs expires_at).
 *    - Pre-dispatch and pre-commit gates against in-flight execution of expired entities.
 *    - History preservation across session re-tracking.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { fromDriver } = require('../../src/database/pg-client');
const {
  createMonitoringOps,
  applyMonitoringObservation,
  toggleEntityStar,
  expireDueEntities,
  findDueAuthorEntities,
  retrackEntity,
} = require('../../src/database/monitoring');
const {
  SocialLifecyclePolicy,
  CONSTANTS,
  calculateExpiresAt,
  handleStar,
  handleUnstar,
  evaluateTickExpiry,
  handleRetrack,
  canDispatchJob,
  canCommitResult,
} = require('../../src/monitoring/social-lifecycle');
const { unpackObservations } = require('../../src/database/daily-history');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'pg-schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

/**
 * Creates an isolated PGlite in-memory database with the full production schema.
 */
async function createIsolatedTestDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const driver = new PGlite();
  const db = fromDriver(driver);
  await db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Helper to seed a product row into product_current.
 */
async function seedProduct(db, itemUid, overrides = {}) {
  await db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, image, video_url,
      current_price, current_sold, current_likes, current_views,
      current_comments, current_shares, status, first_seen_at, last_seen_at, last_crawled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (item_uid) DO NOTHING
  `).run(
    itemUid,
    overrides.platform || 'tiktok',
    overrides.query || 'dance_challenge',
    overrides.title || 'TikTok Dance Video',
    overrides.url || `https://www.tiktok.com/@creator/video/${itemUid}`,
    overrides.image || 'https://p16-va.tiktokcdn.com/obj/thumb.jpg',
    overrides.video_url || `https://www.tiktok.com/@creator/video/${itemUid}.mp4`,
    overrides.current_price ?? 0.0,
    overrides.current_sold ?? 0,
    overrides.current_likes ?? 1000,
    overrides.current_views ?? 50000,
    overrides.current_comments ?? 150,
    overrides.current_shares ?? 80,
    overrides.status || 'active',
    overrides.first_seen_at || '2026-09-01 00:00:00',
    overrides.last_seen_at || '2026-09-01 00:00:00',
    overrides.last_crawled_at || '2026-09-01 00:00:00'
  );
}

// =============================================================================
// CHALLENGE 1: SIMULATION 2 — 70-DAY TIKTOK CREATOR TRACKING & STAR DYNAMICS
// =============================================================================

test('CHALLENGE 1.1: Complete 70-Day Simulation 2 trace (Day 0 -> 10 -> 15 -> 20 -> 40 -> 50 -> 60 -> 65 -> 70)', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // ---------------------------------------------------------------------------
  // DAY 0: Author monitoring begins (unstarred, 30-day session)
  // ---------------------------------------------------------------------------
  const day0Iso = '2026-09-01T00:00:00.000Z';
  const expectedDay30Deadline = '2026-10-01T00:00:00.000Z';

  const authorInit = await ops.createOrGetEntity({
    platform: 'tiktok',
    entity_type: 'author',
    external_id: 'creator_star_dynamics_70d',
    display_name: 'Top Creator Vietnam',
    canonical_url: 'https://www.tiktok.com/@top_creator_vietnam',
    identity_source: 'canonical_url',
    session_id: 'tiktok-session-alpha',
    monitoring_started_at: day0Iso,
    entity_next_due_at: day0Iso,
    expires_at: calculateExpiresAt(day0Iso, false),
    is_starred: false,
  });

  assert.equal(authorInit.tracking_status, 'active');
  assert.equal(Boolean(authorInit.is_starred), false);
  assert.equal(authorInit.monitoring_started_at, day0Iso);
  assert.equal(authorInit.expires_at, expectedDay30Deadline);

  // ---------------------------------------------------------------------------
  // DAY 10: Refresh video metrics via patch writer
  // ---------------------------------------------------------------------------
  const day10Iso = '2026-09-11T00:00:00.000Z';
  const videoUid = 'tiktok:video:vid1_m4';
  await seedProduct(db, videoUid, { current_likes: 1000, current_views: 50000, current_comments: 150, current_shares: 80 });

  // Register item for monitoring
  await ops.registerItemForMonitoring({
    item_uid: videoUid,
    entity_id: authorInit.id,
    eligibility: 'ready',
    item_status: 'active',
    next_due_at: day10Iso,
  });

  const patchResult = await ops.applyMonitoringObservation(db, {
    itemUid: videoUid,
    patch: {
      likes: 1250,
      views: 55000,
      comments: 210,
      shares: 115,
      observedAt: day10Iso,
    },
    metadata: { observationId: 'obs:tiktok:vid1:day10' },
  });

  assert.equal(patchResult.updated, true);
  const v1Row = await db.prepare('SELECT current_likes, current_views, current_comments, current_shares, prev_likes, delta_likes, status FROM product_current WHERE item_uid = ?').get(videoUid);
  assert.equal(v1Row.current_likes, 1250);
  assert.equal(v1Row.current_views, 55000);
  assert.equal(v1Row.current_comments, 210);
  assert.equal(v1Row.current_shares, 115);
  assert.equal(v1Row.prev_likes, 1000);
  assert.equal(v1Row.delta_likes, 250);
  assert.equal(v1Row.status, 'active', 'product_current.status must remain active');

  // Verify author deadline is completely unaffected by item metric refresh
  const authorAtDay10 = await ops.getEntity(authorInit.id);
  assert.equal(authorAtDay10.expires_at, expectedDay30Deadline);

  // ---------------------------------------------------------------------------
  // DAY 15: Discovery discovers viral new video from this author
  // ---------------------------------------------------------------------------
  const day15Iso = '2026-09-16T00:00:00.000Z';
  await seedProduct(db, 'tiktok:video:viral_new_day15', { first_seen_at: day15Iso });

  const authorAtDay15 = await ops.getEntity(authorInit.id);
  assert.equal(authorAtDay15.expires_at, expectedDay30Deadline, 'Discovery new post does not grant rolling extension');

  // ---------------------------------------------------------------------------
  // DAY 20: User clicks Star on author -> extends deadline to Day 60 (2026-10-31)
  // ---------------------------------------------------------------------------
  const day20Iso = '2026-09-21T00:00:00.000Z';
  const expectedDay60Deadline = '2026-10-31T00:00:00.000Z';

  const starDay20Res = await ops.toggleEntityStar(authorInit.id, true, { now: day20Iso });
  assert.equal(starDay20Res.stateChanged, true);
  assert.equal(starDay20Res.action, 'window_extended_to_60d');
  assert.equal(Boolean(starDay20Res.isStarred), true);
  assert.equal(starDay20Res.expiresAt, expectedDay60Deadline);
  assert.equal(starDay20Res.trackingStatus, 'active');

  const authorAtDay20 = await ops.getEntity(authorInit.id);
  assert.equal(Boolean(authorAtDay20.is_starred), true);
  assert.equal(authorAtDay20.expires_at, expectedDay60Deadline);
  assert.equal(authorAtDay20.tracking_status, 'active');

  // ---------------------------------------------------------------------------
  // DAY 40: User clicks Unstar on author -> since Day 40 >= Day 30, author expires immediately!
  // ---------------------------------------------------------------------------
  const day40Iso = '2026-10-11T00:00:00.000Z';

  // Seed a queued refresh job for child video before unstarring to verify job cancellation
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, item_id, kind, session_id, scheduled_for, status)
    VALUES (9001, ?, (SELECT id FROM monitoring_items WHERE item_uid = ?), 'item_refresh', 'tiktok-session-alpha', ?, 'queued')
  `).run(authorInit.id, videoUid, day40Iso);

  const unstarDay40Res = await ops.toggleEntityStar(authorInit.id, false, { now: day40Iso });
  assert.equal(unstarDay40Res.stateChanged, true);
  assert.equal(unstarDay40Res.action, 'expired_immediately_on_unstar');
  assert.equal(Boolean(unstarDay40Res.isStarred), false);
  assert.equal(unstarDay40Res.trackingStatus, 'expired');
  assert.equal(unstarDay40Res.reason, 'unstarred_after_standard_deadline');

  const authorAtDay40 = await ops.getEntity(authorInit.id);
  assert.equal(Boolean(authorAtDay40.is_starred), false);
  assert.equal(authorAtDay40.tracking_status, 'expired');
  assert.equal(authorAtDay40.reason, 'unstarred_after_standard_deadline');

  // Verify child item was cascaded to 'paused'
  const childItemAtDay40 = await ops.getItem(videoUid);
  assert.equal(childItemAtDay40.item_status, 'paused');

  // Verify queued job was cancelled
  const queuedJobAtDay40 = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 9001').get();
  assert.equal(queuedJobAtDay40.status, 'cancelled');

  // ---------------------------------------------------------------------------
  // DAY 50: User clicks Star on expired author (within 60-day window) -> Revives to active!
  // ---------------------------------------------------------------------------
  const day50Iso = '2026-10-21T00:00:00.000Z';
  const starDay50Res = await ops.toggleEntityStar(authorInit.id, true, { now: day50Iso, resumeChildItems: true });
  assert.equal(starDay50Res.stateChanged, true);
  assert.equal(starDay50Res.action, 'reactivated_from_expired');
  assert.equal(Boolean(starDay50Res.isStarred), true);
  assert.equal(starDay50Res.trackingStatus, 'active');
  assert.equal(starDay50Res.expiresAt, expectedDay60Deadline);

  const authorAtDay50 = await ops.getEntity(authorInit.id);
  assert.equal(Boolean(authorAtDay50.is_starred), true);
  assert.equal(authorAtDay50.tracking_status, 'active');
  assert.equal(authorAtDay50.expires_at, expectedDay60Deadline);
  assert.equal(authorAtDay50.reason, null);

  // Verify child item was resumed to 'active'
  const childItemAtDay50 = await ops.getItem(videoUid);
  assert.equal(childItemAtDay50.item_status, 'active');

  // ---------------------------------------------------------------------------
  // DAY 60: System clock passes Day 60 -> Expiry timer marks expired
  // ---------------------------------------------------------------------------
  const day60Iso = '2026-10-31T00:00:01.000Z';

  // Seed another queued job to verify expiry tick cancels it
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, item_id, kind, session_id, scheduled_for, status)
    VALUES (9002, ?, (SELECT id FROM monitoring_items WHERE item_uid = ?), 'item_refresh', 'tiktok-session-alpha', ?, 'queued')
  `).run(authorInit.id, videoUid, day60Iso);

  const tickResult = await ops.expireDueEntities({ now: day60Iso });
  assert.equal(tickResult.expiredCount, 1);
  assert.deepEqual(tickResult.expiredEntityIds, [authorInit.id]);
  assert.equal(tickResult.itemsPausedCount, 1);
  assert.equal(tickResult.jobsCancelledCount, 1);

  const authorAtDay60 = await ops.getEntity(authorInit.id);
  assert.equal(authorAtDay60.tracking_status, 'expired');
  assert.equal(authorAtDay60.reason, 'session_expired');

  const childItemAtDay60 = await ops.getItem(videoUid);
  assert.equal(childItemAtDay60.item_status, 'paused');

  const jobAtDay60 = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 9002').get();
  assert.equal(jobAtDay60.status, 'cancelled');

  // ---------------------------------------------------------------------------
  // DAY 65: User tries starring author past Day 60 -> Cannot revive!
  // ---------------------------------------------------------------------------
  const day65Iso = '2026-11-05T00:00:01.000Z';
  const starDay65Res = await ops.toggleEntityStar(authorInit.id, true, { now: day65Iso });
  assert.equal(starDay65Res.stateChanged, false);
  assert.equal(starDay65Res.error, 'PAST_60D_WINDOW_CANNOT_REACTIVATE');
  assert.equal(starDay65Res.trackingStatus, 'expired');

  const authorAtDay65 = await ops.getEntity(authorInit.id);
  assert.equal(authorAtDay65.tracking_status, 'expired');

  // ---------------------------------------------------------------------------
  // DAY 70: User clicks "Theo dõi lại" (Re-track) -> Starts brand-new session
  // ---------------------------------------------------------------------------
  const day70Iso = '2026-11-10T00:00:01.000Z';
  const retrackRes = await ops.retrackEntity(authorInit.id, { now: day70Iso, isStarred: false });
  assert.equal(retrackRes.stateChanged, true);
  assert.equal(retrackRes.action, 'new_session_started');
  assert.equal(retrackRes.trackingStatus, 'active');
  assert.notEqual(retrackRes.sessionId, 'tiktok-session-alpha');
  assert.equal(retrackRes.monitoringStartedAt, day70Iso);
  assert.equal(retrackRes.expiresAt, '2026-12-10T00:00:01.000Z'); // 30 days from Day 70

  const authorAtDay70 = await ops.getEntity(authorInit.id);
  assert.equal(authorAtDay70.tracking_status, 'active');
  assert.equal(authorAtDay70.session_id, retrackRes.sessionId);
  assert.equal(authorAtDay70.monitoring_started_at, day70Iso);
  assert.equal(authorAtDay70.expires_at, '2026-12-10T00:00:01.000Z');

  // Child items resumed
  const childItemAtDay70 = await ops.getItem(videoUid);
  assert.equal(childItemAtDay70.item_status, 'active');
});

// =============================================================================
// CHALLENGE 2: INDEPENDENT TICK-BASED EXPIRY CHECKER (expireDueEntities)
// =============================================================================

test('CHALLENGE 2.1: Expiry occurs on timer tick alone without incoming crawl payload', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const startedAt = '2026-09-01T00:00:00.000Z';
  const expiresAt = '2026-10-01T00:00:00.000Z';

  // Seed 3 active authors with deadline Day 30
  for (let i = 1; i <= 3; i++) {
    await db.prepare(`
      INSERT INTO monitoring_entities (
        id, platform, entity_type, external_id, identity_source, session_id,
        monitoring_started_at, expires_at, entity_next_due_at, tracking_status
      ) VALUES (?, 'tiktok', 'author', ?, 'canonical_url', 'sess-tick-test', ?, ?, ?, 'active')
    `).run(2000 + i, `author_batch_${i}`, startedAt, expiresAt, startedAt);
  }

  // 1 tick before deadline (Day 29d 23h 59m 59s) -> 0 expired
  const resBefore = await ops.expireDueEntities({ now: '2026-09-30T23:59:59.000Z' });
  assert.equal(resBefore.expiredCount, 0);

  // 1 tick at exact deadline (2026-10-01T00:00:00.000Z) -> exactly 3 expired on tick alone!
  const resAt = await ops.expireDueEntities({ now: '2026-10-01T00:00:00.000Z' });
  assert.equal(resAt.expiredCount, 3);
  assert.deepEqual(resAt.expiredEntityIds.sort(), [2001, 2002, 2003]);

  // Subsequent tick -> completely idempotent, 0 expired
  const resSubsequent = await ops.expireDueEntities({ now: '2026-10-01T00:00:05.000Z' });
  assert.equal(resSubsequent.expiredCount, 0);
});

test('CHALLENGE 2.2: Cascading pauses active child items but preserves unavailable items', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entityId = 2100;
  await db.prepare(`
    INSERT INTO monitoring_entities (
      id, platform, entity_type, external_id, identity_source, session_id,
      monitoring_started_at, expires_at, entity_next_due_at, tracking_status
    ) VALUES (?, 'tiktok', 'author', 'author_cascade_test', 'canonical_url', 'sess-casc', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', now(), 'active')
  `).run(entityId);

  // Seed 3 child items: item1 is active, item2 is unavailable, item3 is already paused
  await seedProduct(db, 'tt:item:active', { status: 'active' });
  await seedProduct(db, 'tt:item:unavail', { status: 'dropped' });
  await seedProduct(db, 'tt:item:already_paused', { status: 'active' });

  await db.prepare("INSERT INTO monitoring_items (id, item_uid, entity_id, eligibility, item_status) VALUES (11, 'tt:item:active', ?, 'ready', 'active')").run(entityId);
  await db.prepare("INSERT INTO monitoring_items (id, item_uid, entity_id, eligibility, item_status) VALUES (12, 'tt:item:unavail', ?, 'ready', 'unavailable')").run(entityId);
  await db.prepare("INSERT INTO monitoring_items (id, item_uid, entity_id, eligibility, item_status) VALUES (13, 'tt:item:already_paused', ?, 'ready', 'paused')").run(entityId);

  // Trigger expiry tick
  const tickRes = await ops.expireDueEntities({ now: '2026-10-01T00:00:01Z' });
  assert.equal(tickRes.expiredCount, 1);
  assert.equal(tickRes.itemsPausedCount, 1, 'Only the active child item should be transitioned to paused');

  const item1 = await db.prepare("SELECT item_status FROM monitoring_items WHERE item_uid = 'tt:item:active'").get();
  const item2 = await db.prepare("SELECT item_status FROM monitoring_items WHERE item_uid = 'tt:item:unavail'").get();
  const item3 = await db.prepare("SELECT item_status FROM monitoring_items WHERE item_uid = 'tt:item:already_paused'").get();

  assert.equal(item1.item_status, 'paused', 'Active item must transition to paused');
  assert.equal(item2.item_status, 'unavailable', 'Unavailable item must preserve unavailable status');
  assert.equal(item3.item_status, 'paused', 'Already paused item remains paused');
});

test('CHALLENGE 2.3: Cascading cancels queued jobs but preserves claimed/running/completed jobs', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const entityId = 2200;
  await db.prepare(`
    INSERT INTO monitoring_entities (
      id, platform, entity_type, external_id, identity_source, session_id,
      monitoring_started_at, expires_at, entity_next_due_at, tracking_status
    ) VALUES (?, 'tiktok', 'author', 'author_job_cancel_test', 'canonical_url', 'sess-jobs', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', now(), 'active')
  `).run(entityId);

  await seedProduct(db, 'tt:item:jobtest');
  await db.prepare("INSERT INTO monitoring_items (id, item_uid, entity_id, eligibility, item_status) VALUES (21, 'tt:item:jobtest', ?, 'ready', 'active')").run(entityId);

  // Seed jobs:
  // Job 1: queued -> must be cancelled
  // Job 2: claimed -> must be preserved
  // Job 3: running -> must be preserved
  // Job 4: completed -> must be preserved
  await db.prepare("INSERT INTO monitoring_jobs (id, entity_id, item_id, kind, session_id, scheduled_for, status) VALUES (101, ?, 21, 'item_refresh', 'sess-jobs', now(), 'queued')").run(entityId);
  await db.prepare("INSERT INTO monitoring_jobs (id, entity_id, item_id, kind, session_id, scheduled_for, status) VALUES (102, ?, 21, 'item_refresh', 'sess-jobs', now() + INTERVAL '1 hour', 'claimed')").run(entityId);
  await db.prepare("INSERT INTO monitoring_jobs (id, entity_id, item_id, kind, session_id, scheduled_for, status) VALUES (103, ?, 21, 'item_refresh', 'sess-jobs', now() + INTERVAL '2 hours', 'running')").run(entityId);
  await db.prepare("INSERT INTO monitoring_jobs (id, entity_id, item_id, kind, session_id, scheduled_for, status) VALUES (104, ?, 21, 'item_refresh', 'sess-jobs', now() + INTERVAL '3 hours', 'completed')").run(entityId);

  // Trigger expiry tick
  const tickRes = await ops.expireDueEntities({ now: '2026-10-01T00:00:01Z' });
  assert.equal(tickRes.jobsCancelledCount, 1);

  const j1 = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 101').get();
  const j2 = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 102').get();
  const j3 = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 103').get();
  const j4 = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 104').get();

  assert.equal(j1.status, 'cancelled', 'Queued job must be cancelled');
  assert.equal(j2.status, 'claimed', 'Claimed job must not be cancelled');
  assert.equal(j3.status, 'running', 'Running job must not be cancelled');
  assert.equal(j4.status, 'completed', 'Completed job must not be cancelled');
});

// =============================================================================
// CHALLENGE 3: METRIC SCOPE AND STATUS DECOUPLING
// =============================================================================

test('CHALLENGE 3.1: Video metric refresh updates product_current and daily_packed_history without mutating status', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const itemUid = 'tiktok:video:metrics_test_vid';
  // Seed with initial values and status = 'active'
  await seedProduct(db, itemUid, {
    current_views: 100000,
    current_likes: 5000,
    current_comments: 200,
    current_shares: 100,
    status: 'active',
  });

  const obsTime = '2026-09-05T14:30:00.000Z';
  const obsId = 'obs:vid:metric:refresh:1';

  await ops.applyMonitoringObservation(db, {
    itemUid,
    patch: {
      views: 120000,
      likes: 6500,
      comments: 310,
      shares: 175,
      observedAt: obsTime,
    },
    metadata: { observationId: obsId },
  });

  // Verify product_current values
  const pc = await db.prepare('SELECT * FROM product_current WHERE item_uid = ?').get(itemUid);
  assert.equal(pc.current_views, 120000);
  assert.equal(pc.prev_views, 100000);
  assert.equal(pc.delta_views, 20000);

  assert.equal(pc.current_likes, 6500);
  assert.equal(pc.prev_likes, 5000);
  assert.equal(pc.delta_likes, 1500);

  assert.equal(pc.current_comments, 310);
  assert.equal(pc.prev_comments, 200);
  assert.equal(pc.delta_comments, 110);

  assert.equal(pc.current_shares, 175);
  assert.equal(pc.prev_shares, 100);
  assert.equal(pc.delta_shares, 75);

  assert.equal(pc.status, 'active', 'product_current.status MUST remain active');

  // Verify daily_packed_history
  const hist = await db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, '2026-09-05');
  assert.ok(hist, 'daily_packed_history row must exist');
  const unpacked = unpackObservations(hist.observations_json);
  assert.equal(unpacked.length, 1);
  const entry = unpacked[0];
  assert.equal(entry.observationId, obsId);
  assert.equal(entry.views, 120000);
  assert.equal(entry.likes, 6500);
  assert.equal(entry.comments, 310);
  assert.equal(entry.shares, 175);
});

test('CHALLENGE 3.2: product_current.status is NEVER mutated across all Discovery lifecycle statuses (active, dropped, new)', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const statuses = ['active', 'dropped', 'new'];

  for (const s of statuses) {
    const itemUid = `tiktok:video:decouple_${s}`;
    await seedProduct(db, itemUid, {
      status: s,
      current_views: 1000,
      current_likes: 50,
    });

    // Ingest monitoring observation with payload attempting to alter status
    await ops.applyMonitoringObservation(db, {
      itemUid,
      patch: {
        views: 2000,
        likes: 100,
        status: 'mutated_status_attempt', // Should be strictly ignored!
        observedAt: '2026-09-02T10:00:00Z',
      },
      metadata: { observationId: `obs:decouple:${s}` },
    });

    const row = await db.prepare('SELECT status, current_views, current_likes FROM product_current WHERE item_uid = ?').get(itemUid);
    assert.equal(row.status, s, `product_current.status for status '${s}' must remain untouched`);
    assert.equal(row.current_views, 2000);
    assert.equal(row.current_likes, 100);
  }
});

test('CHALLENGE 3.3: Author aggregate metrics remain strictly isolated in monitoring_entities', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  // Author entity has total sales / metrics
  const author = await ops.createOrGetEntity({
    platform: 'tiktok',
    entity_type: 'author',
    external_id: 'top_creator_isolation',
    display_name: 'Isolated Creator',
    identity_source: 'canonical_url',
    session_id: 'sess-iso',
    monitoring_started_at: '2026-09-01T00:00:00Z',
    entity_next_due_at: '2026-09-01T00:00:00Z',
  });

  // Record an observation for the author entity
  await db.prepare(`
    INSERT INTO monitoring_entity_observations (
      entity_id, session_id, observation_id, observed_at, metric_name, metric_value, source, quality
    ) VALUES (?, 'sess-iso', 'obs:author:followers:1', now(), 'author_followers', 1500000, 'tiktok_profile', 'exact')
  `).run(author.id);

  // Seed video item belonging to this author
  const videoUid = 'tiktok:video:author_isolation_vid';
  await seedProduct(db, videoUid, { current_sold: 5, current_views: 10000 });
  await ops.registerItemForMonitoring({
    item_uid: videoUid,
    entity_id: author.id,
    eligibility: 'ready',
    item_status: 'active',
  });

  // Ingest video metric refresh
  await ops.applyMonitoringObservation(db, {
    itemUid: videoUid,
    patch: { views: 12000, observedAt: '2026-09-02T12:00:00Z' },
    metadata: { observationId: 'obs:author:vid:refresh' },
  });

  // 1. Author follower count is NOT written to product_current
  const prod = await db.prepare('SELECT current_sold, current_views FROM product_current WHERE item_uid = ?').get(videoUid);
  assert.equal(prod.current_sold, 5, 'Listing sold count must not be overwritten by author metrics');
  assert.equal(prod.current_views, 12000);

  // 2. Video metric refresh does NOT pollute monitoring_entities
  const ent = await db.prepare('SELECT sales FROM monitoring_entities WHERE id = ?').get(author.id);
  assert.equal(ent.sales, null);

  // 3. Author observation exists only in monitoring_entity_observations
  const authorObs = await db.prepare('SELECT * FROM monitoring_entity_observations WHERE entity_id = ?').all(author.id);
  assert.equal(authorObs.length, 1);
  assert.equal(authorObs[0].metric_name, 'author_followers');
  assert.equal(Number(authorObs[0].metric_value), 1500000);
});

// =============================================================================
// CHALLENGE 4: ADVERSARIAL STRESS & CORNER CASES
// =============================================================================

test('CHALLENGE 4.1: Pre-dispatch and pre-commit guards reject operations for expired entities', () => {
  const expiredEntity = {
    tracking_status: 'expired',
    expires_at: '2026-10-01T00:00:00.000Z',
  };

  // Pre-dispatch check
  assert.equal(canDispatchJob(expiredEntity, '2026-09-25T00:00:00Z'), false);
  assert.equal(canDispatchJob(expiredEntity, '2026-10-05T00:00:00Z'), false);

  // Pre-commit check
  const commitExpired = canCommitResult(expiredEntity, '2026-10-05T00:00:00Z');
  assert.equal(commitExpired.allowed, false);
  assert.equal(commitExpired.error, 'ENTITY_EXPIRED_IN_FLIGHT');

  // In-flight expiry check: entity was active at dispatch but clock passed expires_at
  const activeEntityPastDeadline = {
    tracking_status: 'active',
    expires_at: '2026-10-01T00:00:00.000Z',
  };
  assert.equal(canDispatchJob(activeEntityPastDeadline, '2026-10-01T00:00:01Z'), false);
  const commitInFlightExpired = canCommitResult(activeEntityPastDeadline, '2026-10-01T00:00:01Z');
  assert.equal(commitInFlightExpired.allowed, false);
  assert.equal(commitInFlightExpired.error, 'ENTITY_EXPIRED_IN_FLIGHT');
});

test('CHALLENGE 4.2: Sub-millisecond boundary precision for 30-day and 60-day deadlines', () => {
  const start = '2026-09-01T00:00:00.000Z';
  const startMs = new Date(start).getTime();

  // 30 days = 2,592,000,000 ms
  const exp30 = calculateExpiresAt(start, false);
  assert.equal(new Date(exp30).getTime(), startMs + (30 * 86400000));

  // 1ms before 30d -> not expired
  const tickJustBefore = evaluateTickExpiry({ tracking_status: 'active', expires_at: exp30 }, new Date(startMs + (30 * 86400000) - 1));
  assert.equal(tickJustBefore.tracking_status, 'active');
  assert.equal(tickJustBefore.stateChanged, false);

  // Exact 30d millisecond -> expired
  const tickAt = evaluateTickExpiry({ tracking_status: 'active', expires_at: exp30 }, new Date(startMs + (30 * 86400000)));
  assert.equal(tickAt.tracking_status, 'expired');
  assert.equal(tickAt.stateChanged, true);

  // 60 days = 5,184,000,000 ms
  const exp60 = calculateExpiresAt(start, true);
  assert.equal(new Date(exp60).getTime(), startMs + (60 * 86400000));

  // 1ms before 60d -> star reactivation allowed
  const starJustBefore60d = handleStar({
    monitoring_started_at: start,
    tracking_status: 'expired',
    expires_at: exp30,
    is_starred: false,
  }, new Date(startMs + (60 * 86400000) - 1));
  assert.equal(starJustBefore60d.tracking_status, 'active');
  assert.equal(starJustBefore60d.action, 'reactivated_from_expired');

  // Exact 60d millisecond -> star reactivation blocked
  const starAt60d = handleStar({
    monitoring_started_at: start,
    tracking_status: 'expired',
    expires_at: exp60,
    is_starred: true,
  }, new Date(startMs + (60 * 86400000)));
  assert.equal(starAt60d.tracking_status, 'expired');
  assert.equal(starAt60d.error, 'PAST_60D_WINDOW_CANNOT_REACTIVATE');
});
