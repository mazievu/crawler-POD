/**
 * Adversarial Challenger 1 Test Suite for Milestone 4:
 * Author Star/Unstar & Session Dynamics Challenger.
 *
 * Mandate & Invariants Verified:
 * 1. Challenge Day 20 Star toggle:
 *    - Verify session extends from Day 30 to Day 60 (started_at + 60d UTC, not now + 60d).
 * 2. Challenge Day 40 Unstar toggle:
 *    - Verify session expires immediately (now >= started_at + 30d).
 *    - Verify tracking_status becomes 'expired'.
 *    - Verify action is 'expired_immediately_on_unstar' and reason is 'unstarred_after_standard_deadline'.
 *    - Verify cascading pauses child items and cancels queued jobs in DB operations.
 * 3. Challenge Day 35 Star revival:
 *    - For an unstarred author expired at Day 30, verify starring at Day 35 revives author to 'active'.
 *    - Verify expires_at is extended to Day 60 (started_at + 60d).
 *    - Verify reason is cleared (null) and action is 'reactivated_from_expired'.
 * 4. Challenge Day 65 Star past 60-day window:
 *    - Verify starring an expired author at Day 65 (past 60d from started_at) is strictly rejected.
 *    - Verify error code is exactly 'PAST_60D_WINDOW_CANNOT_REACTIVATE'.
 *    - Verify tracking_status remains 'expired' (DOES NOT reactivate).
 * 5. Challenge Day 70 "Theo dõi lại" (Re-track):
 *    - Verify calling retrack or retrackEntity starts brand-new session with new session_id (UUID).
 *    - Verify monitoring_started_at resets to current time.
 *    - Verify initial 30d (or 60d if starred) deadline is computed from new start time.
 *    - Verify tracking_status is 'active' and past history is preserved intact.
 * 6. Adversarial Edge Cases & Boundaries:
 *    - Sub-millisecond boundary at Day 29d 23h 59m 59s 999ms vs Day 30d 00h 00m 00s 000ms.
 *    - Sub-millisecond boundary at Day 59d 23h 59m 59s 999ms vs Day 60d 00h 00m 00s 000ms.
 *    - Pre-dispatch gate (canDispatchJob) and pre-commit gate (canCommitResult).
 *    - Verification of Explorer 3 finding: already-starred author past Day 60 rejected with error.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { fromDriver } = require('../../src/database/pg-client');
const {
  createMonitoringOps,
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

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'pg-schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

/**
 * Creates an isolated PGlite in-memory database with production schema.
 */
async function createIsolatedTestDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const driver = new PGlite();
  const db = fromDriver(driver);
  await db.exec(SCHEMA_SQL);
  return db;
}

// =============================================================================
// CHALLENGE 1: Day 20 Star Toggle (Session Window Extension)
// =============================================================================
test('Challenge 1: Day 20 Star toggle extends session from Day 30 to Day 60 (started_at + 60d)', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const initialExpiresAt = '2026-10-01T00:00:00.000Z'; // Day 30
  const entity = {
    monitoring_started_at: startedAt,
    expires_at: initialExpiresAt,
    is_starred: false,
    tracking_status: 'active',
  };

  const day20 = '2026-09-21T00:00:00.000Z';
  const starred = SocialLifecyclePolicy.handleStar(entity, day20);

  assert.equal(starred.success, true);
  assert.equal(starred.is_starred, true);
  assert.equal(starred.tracking_status, 'active');
  assert.equal(starred.stateChanged, true);
  assert.equal(starred.action, 'window_extended_to_60d');

  // Must extend to started_at + 60d (2026-10-31), NOT now + 60d (2026-11-20)
  const expected60d = '2026-10-31T00:00:00.000Z';
  assert.equal(starred.expires_at, expected60d);
  assert.notEqual(starred.expires_at, '2026-11-20T00:00:00.000Z', 'Must not extend 60 days from now');
});

test('Challenge 1 (DB): toggleEntityStar persists Day 20 extension and updates state_version', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const author = await ops.createOrGetEntity({
    platform: 'tiktok',
    entity_type: 'author',
    external_id: 'creator_ch1',
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    is_starred: false,
  });

  assert.equal(author.is_starred, false);
  assert.equal(author.expires_at, '2026-10-01T00:00:00.000Z');

  const res = await ops.toggleEntityStar(author.id, true, {
    now: '2026-09-21T00:00:00.000Z',
  });

  assert.equal(res.stateChanged, true);
  assert.equal(res.action, 'window_extended_to_60d');
  assert.equal(res.expiresAt, '2026-10-31T00:00:00.000Z');
  assert.equal(res.entity.state_version, 2);
  assert.equal(res.entity.is_starred, true);
});

// =============================================================================
// CHALLENGE 2: Day 40 Unstar Toggle (Immediate Expiration & Cascading)
// =============================================================================
test('Challenge 2: Day 40 Unstar toggle causes immediate expiration (now >= started_at + 30d)', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const entity = {
    monitoring_started_at: startedAt,
    expires_at: '2026-10-31T00:00:00.000Z', // Starred (Day 60)
    is_starred: true,
    tracking_status: 'active',
  };

  const day40 = '2026-10-11T00:00:00.000Z';
  const unstarred = SocialLifecyclePolicy.handleUnstar(entity, day40);

  assert.equal(unstarred.success, true);
  assert.equal(unstarred.is_starred, false);
  assert.equal(unstarred.tracking_status, 'expired');
  assert.equal(unstarred.reason, 'unstarred_after_standard_deadline');
  assert.equal(unstarred.action, 'expired_immediately_on_unstar');
  assert.equal(unstarred.immediate_expired_post_30d, true);

  // Expiration reflects standard deadline in past (2026-10-01)
  assert.equal(unstarred.expires_at, '2026-10-01T00:00:00.000Z');
});

test('Challenge 2 (DB): toggleEntityStar on Day 40 cascades to pause items and cancel jobs', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const author = await ops.createOrGetEntity({
    platform: 'tiktok',
    entity_type: 'author',
    external_id: 'creator_ch2',
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
  });

  // Seed product item
  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, status)
    VALUES ('tiktok:video:ch2_vid', 'tiktok', 'dance', 'Dance 2', 'https://tiktok.com/@creator/video/ch2', 'active');
  `).run();

  // Register item for author
  const item = await ops.registerItemForMonitoring({
    itemUid: 'tiktok:video:ch2_vid',
    entityId: author.id,
  });
  assert.equal(item.item_status, 'active');

  // Enqueue a job for this author
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (9001, ?, 'shop_probe', ?, now(), 'queued');
  `).run(author.id, author.session_id);

  // Unstar on Day 40
  const res = await ops.toggleEntityStar(author.id, false, {
    now: '2026-10-11T00:00:00.000Z',
  });

  assert.equal(res.stateChanged, true);
  assert.equal(res.trackingStatus, 'expired');
  assert.equal(res.action, 'expired_immediately_on_unstar');
  assert.equal(res.itemsPaused, 1);
  assert.equal(res.jobsCancelled, 1);

  // Verify child item is now paused
  const updatedItem = await ops.getItem(item.id);
  assert.equal(updatedItem.item_status, 'paused');

  // Verify queued job is cancelled
  const job = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 9001').get();
  assert.equal(job.status, 'cancelled');
});

// =============================================================================
// CHALLENGE 3: Day 35 Star Revival (Reactivation Within 60-Day Window)
// =============================================================================
test('Challenge 3: Day 35 Star revival reactivates expired author to active and extends to Day 60', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const entity = {
    monitoring_started_at: startedAt,
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
    tracking_status: 'expired',
    reason: 'session_expired',
  };

  const day35 = '2026-10-06T00:00:00.000Z';
  const revived = SocialLifecyclePolicy.handleStar(entity, day35);

  assert.equal(revived.success, true);
  assert.equal(revived.is_starred, true);
  assert.equal(revived.tracking_status, 'active');
  assert.equal(revived.reason, null);
  assert.equal(revived.expires_at, '2026-10-31T00:00:00.000Z'); // started_at + 60d
  assert.equal(revived.stateChanged, true);
  assert.equal(revived.action, 'reactivated_from_expired');
});

test('Challenge 3 (DB): toggleEntityStar on Day 35 revives author and unpauses child items', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const author = await ops.createOrGetEntity({
    platform: 'tiktok',
    entity_type: 'author',
    external_id: 'creator_ch3',
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
  });

  // Seed item
  await db.prepare(`
    INSERT INTO product_current (item_uid, platform, query, title, url, status)
    VALUES ('tiktok:video:ch3_vid', 'tiktok', 'dance', 'Dance 3', 'https://tiktok.com/@creator/video/ch3', 'active');
  `).run();

  const item = await ops.registerItemForMonitoring({
    itemUid: 'tiktok:video:ch3_vid',
    entityId: author.id,
  });

  // Expire at Day 30
  await ops.expireDueEntities({ now: '2026-10-02T00:00:00.000Z' });
  const expiredAuthor = await ops.getEntity(author.id);
  assert.equal(expiredAuthor.tracking_status, 'expired');
  const pausedItem = await ops.getItem(item.id);
  assert.equal(pausedItem.item_status, 'paused');

  // Star at Day 35
  const res = await ops.toggleEntityStar(author.id, true, {
    now: '2026-10-06T00:00:00.000Z',
  });

  assert.equal(res.stateChanged, true);
  assert.equal(res.trackingStatus, 'active');
  assert.equal(res.action, 'reactivated_from_expired');
  assert.equal(res.expiresAt, '2026-10-31T00:00:00.000Z');

  // Verify child item was unpaused to active
  const resumedItem = await ops.getItem(item.id);
  assert.equal(resumedItem.item_status, 'active');
});

// =============================================================================
// CHALLENGE 4: Day 65 Star Past 60-Day Window (Strict Rejection)
// =============================================================================
test('Challenge 4: Day 65 Star past 60d is strictly rejected with PAST_60D_WINDOW_CANNOT_REACTIVATE', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const entity = {
    monitoring_started_at: startedAt,
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
    tracking_status: 'expired',
    reason: 'session_expired',
  };

  const day65 = '2026-11-05T00:00:00.000Z';
  const res = SocialLifecyclePolicy.handleStar(entity, day65);

  assert.equal(res.success, false);
  assert.equal(res.stateChanged, false);
  assert.equal(res.tracking_status, 'expired', 'Author must remain expired');
  assert.equal(res.error, 'PAST_60D_WINDOW_CANNOT_REACTIVATE');
  assert.equal(res.action, 'past_60d_window_cannot_reactivate');
});

test('Challenge 4 (Explorer 3 Bug Regression): Star at Day 65 on previously-starred expired author rejects with error', () => {
  // In Explorer 3 finding: if is_starred was already true on entity, old harness returned no-op without error.
  // Verify production policy checks 60d window FIRST!
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true, // Already true in DB from previous star
    tracking_status: 'expired',
  };

  const day65 = '2026-11-05T00:00:00.000Z';
  const res = SocialLifecyclePolicy.handleStar(entity, day65);

  assert.equal(res.success, false);
  assert.equal(res.error, 'PAST_60D_WINDOW_CANNOT_REACTIVATE');
  assert.equal(res.tracking_status, 'expired');
});

test('Challenge 4 (DB): toggleEntityStar on Day 65 leaves DB row unchanged and returns error', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const author = await ops.createOrGetEntity({
    platform: 'tiktok',
    entity_type: 'author',
    external_id: 'creator_ch4',
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
  });

  // Mark expired at Day 60
  await ops.expireDueEntities({ now: '2026-10-31T00:00:01.000Z' });

  // Attempt to star at Day 65
  const res = await ops.toggleEntityStar(author.id, true, {
    now: '2026-11-05T00:00:00.000Z',
  });

  assert.equal(res.stateChanged, false);
  assert.equal(res.error, 'PAST_60D_WINDOW_CANNOT_REACTIVATE');

  // Verify entity in DB was NOT modified
  const current = await ops.getEntity(author.id);
  assert.equal(current.tracking_status, 'expired');
});

// =============================================================================
// CHALLENGE 5: Day 70 "Theo dõi lại" (Re-track New Session & History Preservation)
// =============================================================================
test('Challenge 5: Day 70 retrack starts new session with fresh session_id and 30d deadline', () => {
  const entity = {
    session_id: 'old-session-uuid-1111',
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: false,
    tracking_status: 'expired',
    reason: 'session_expired',
  };

  const day70 = '2026-11-10T00:00:00.000Z';
  const newSession = SocialLifecyclePolicy.handleRetrack(entity, day70);

  assert.equal(newSession.stateChanged, true);
  assert.equal(newSession.tracking_status, 'active');
  assert.equal(newSession.reason, null);
  assert.notEqual(newSession.session_id, 'old-session-uuid-1111');
  assert.equal(newSession.monitoring_started_at, '2026-11-10T00:00:00.000Z');
  // Initial unstarred 30d deadline from Day 70
  assert.equal(newSession.expires_at, '2026-12-10T00:00:00.000Z');
  assert.equal(newSession.action, 'new_session_started');
});

test('Challenge 5 (DB): retrackEntity starts new session while keeping previous observations intact', async () => {
  const db = await createIsolatedTestDb();
  const ops = createMonitoringOps(db);

  const author = await ops.createOrGetEntity({
    platform: 'tiktok',
    entity_type: 'author',
    external_id: 'creator_ch5',
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
  });
  const originalSessionId = author.session_id;

  // Record an observation in original session
  await ops.recordEntityObservation({
    entityId: author.id,
    sessionId: originalSessionId,
    observationId: 'obs:old_sess:1',
    observedAt: '2026-09-10T00:00:00.000Z',
    metricName: 'total_followers',
    metricValue: 50000,
    quality: 'exact',
  });

  // Expire author
  await ops.expireDueEntities({ now: '2026-10-05T00:00:00.000Z' });

  // Retrack on Day 70
  const retrackRes = await ops.retrackEntity(author.id, {
    now: '2026-11-10T00:00:00.000Z',
  });

  assert.equal(retrackRes.stateChanged, true);
  assert.equal(retrackRes.trackingStatus, 'active');
  assert.notEqual(retrackRes.sessionId, originalSessionId);
  assert.equal(retrackRes.monitoringStartedAt, '2026-11-10T00:00:00.000Z');
  assert.equal(retrackRes.expiresAt, '2026-12-10T00:00:00.000Z');

  // VERIFY HISTORY PRESERVATION: Past observation must still exist intact!
  const historicObs = await db.prepare('SELECT * FROM monitoring_entity_observations WHERE entity_id = ?').all(author.id);
  assert.equal(historicObs.length, 1);
  assert.equal(historicObs[0].session_id, originalSessionId);
  assert.equal(historicObs[0].metric_value, 50000);
});

// =============================================================================
// CHALLENGE 6: Millisecond Boundary Stress Tests
// =============================================================================
test('Challenge 6.1: Sub-millisecond boundary at Day 30 - 1ms vs Day 30 exact on Unstar', () => {
  const startedAt = '2026-09-01T00:00:00.000Z'; // 1788220800000
  const startMs = Date.parse(startedAt);
  const deadline30Ms = startMs + (30 * 86400000);

  const entity = {
    monitoring_started_at: startedAt,
    expires_at: new Date(startMs + 60 * 86400000).toISOString(),
    is_starred: true,
    tracking_status: 'active',
  };

  // Exactly 1ms before 30d deadline -> Reverts to 30d deadline, remains ACTIVE
  const before30d = new Date(deadline30Ms - 1).toISOString();
  const resBefore = SocialLifecyclePolicy.handleUnstar(entity, before30d);
  assert.equal(resBefore.tracking_status, 'active');
  assert.equal(resBefore.action, 'reverted_to_standard_deadline');

  // Exactly at 30d deadline -> EXPIRES IMMEDIATELY
  const at30d = new Date(deadline30Ms).toISOString();
  const resAt = SocialLifecyclePolicy.handleUnstar(entity, at30d);
  assert.equal(resAt.tracking_status, 'expired');
  assert.equal(resAt.action, 'expired_immediately_on_unstar');
});

test('Challenge 6.2: Sub-millisecond boundary at Day 60 - 1ms vs Day 60 exact on Star', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const startMs = Date.parse(startedAt);
  const deadline60Ms = startMs + (60 * 86400000);

  const entity = {
    monitoring_started_at: startedAt,
    expires_at: new Date(startMs + 30 * 86400000).toISOString(),
    is_starred: false,
    tracking_status: 'expired',
  };

  // Exactly 1ms before 60d deadline -> CAN STILL REVIVE!
  const before60d = new Date(deadline60Ms - 1).toISOString();
  const resBefore = SocialLifecyclePolicy.handleStar(entity, before60d);
  assert.equal(resBefore.success, true);
  assert.equal(resBefore.tracking_status, 'active');
  assert.equal(resBefore.action, 'reactivated_from_expired');

  // Exactly at 60d deadline -> CANNOT REVIVE!
  const at60d = new Date(deadline60Ms).toISOString();
  const resAt = SocialLifecyclePolicy.handleStar(entity, at60d);
  assert.equal(resAt.success, false);
  assert.equal(resAt.error, 'PAST_60D_WINDOW_CANNOT_REACTIVATE');
  assert.equal(resAt.tracking_status, 'expired');
});

// =============================================================================
// CHALLENGE 7: Pre-dispatch & Pre-commit Execution Invariants
// =============================================================================
test('Challenge 7: Pre-dispatch (canDispatchJob) and pre-commit (canCommitResult) blocks expired author', () => {
  const activeEntity = {
    tracking_status: 'active',
    expires_at: '2026-10-01T00:00:00.000Z',
  };
  const expiredEntity = {
    tracking_status: 'expired',
    expires_at: '2026-10-01T00:00:00.000Z',
  };

  // Before deadline
  assert.equal(canDispatchJob(activeEntity, '2026-09-15T00:00:00.000Z'), true);
  assert.equal(canCommitResult(activeEntity, '2026-09-15T00:00:00.000Z').allowed, true);

  // Past deadline (even if status not yet flipped)
  assert.equal(canDispatchJob(activeEntity, '2026-10-02T00:00:00.000Z'), false);
  assert.equal(canCommitResult(activeEntity, '2026-10-02T00:00:00.000Z').allowed, false);
  assert.equal(canCommitResult(activeEntity, '2026-10-02T00:00:00.000Z').error, 'ENTITY_EXPIRED_IN_FLIGHT');

  // Expired status
  assert.equal(canDispatchJob(expiredEntity, '2026-09-15T00:00:00.000Z'), false);
  assert.equal(canCommitResult(expiredEntity, '2026-09-15T00:00:00.000Z').allowed, false);
  assert.equal(canCommitResult(expiredEntity, '2026-09-15T00:00:00.000Z').error, 'ENTITY_EXPIRED_IN_FLIGHT');
});
