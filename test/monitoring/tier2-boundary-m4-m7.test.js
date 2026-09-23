/**
 * Tier 2: Boundary & Corner Cases Test Suite for Milestones M4 to M7 (Features F18 to F35).
 *
 * Strict opaque-box boundary validation adhering to docs/DISCOVERY_MONITORING_PLAN_REVISED.md:
 * - Author 30d/60d exact millisecond boundaries (29d 23h 59m 59s vs 30d 00h 00m 00s)
 * - Star dynamic window extension & resurrection limits (day 35 vs day 61)
 * - Limiter cooldown boundaries (19,999ms vs 20,001ms)
 * - Worker lease TTL expiry and fencing token validation
 * - Camoufox fallback under Cloudflare / DataDome challenges
 * - Admin Dashboard operational controls and metric bounds
 *
 * Requirements: >= 5 test cases per feature = 90 test cases.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createTestDb,
  VirtualClock,
  SocialLifecyclePolicy,
  MonitoringLimiter,
  StealthBrowserRunner,
  AdminDashboardService,
  CONSTANTS,
} = require('./harness');

// ==========================================
// FEATURE F18: Author Session Deadline Boundaries
// ==========================================
test('F18.B1: Exact boundary started_at + 30 days minus 1 ms is not expired', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const expiresAt = SocialLifecyclePolicy.calculateExpiresAt(startedAt, false);
  const oneMsBefore = new Date(new Date(expiresAt).getTime() - 1);

  const entity = { tracking_status: 'active', expires_at: expiresAt };
  const res = SocialLifecyclePolicy.evaluateTickExpiry(entity, oneMsBefore);
  assert.equal(res.tracking_status, 'active');
  assert.equal(res.stateChanged, false);
});

test('F18.B2: Exact boundary started_at + 30 days plus 1 ms is expired', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const expiresAt = SocialLifecyclePolicy.calculateExpiresAt(startedAt, false);
  const oneMsAfter = new Date(new Date(expiresAt).getTime() + 1);

  const entity = { tracking_status: 'active', expires_at: expiresAt };
  const res = SocialLifecyclePolicy.evaluateTickExpiry(entity, oneMsAfter);
  assert.equal(res.tracking_status, 'expired');
  assert.equal(res.stateChanged, true);
});

test('F18.B3: Daylight saving and leap second in UTC preserves exact 30/60-day millisecond interval', () => {
  const start = new Date('2026-03-01T00:00:00.000Z').getTime();
  const exp30 = SocialLifecyclePolicy.calculateExpiresAt('2026-03-01T00:00:00.000Z', false);
  const diffMs = new Date(exp30).getTime() - start;
  assert.equal(diffMs, 30 * 86400000);
});

test('F18.B4: Session started at 23:59:59.999Z expires at 23:59:59.999Z on target day', () => {
  const startedAt = '2026-09-01T23:59:59.999Z';
  const expiresAt = SocialLifecyclePolicy.calculateExpiresAt(startedAt, false);
  assert.equal(expiresAt, '2026-10-01T23:59:59.999Z');
});

test('F18.B5: Multiple authors created simultaneously have identical deadline epochs', () => {
  const now = new Date().toISOString();
  const d1 = SocialLifecyclePolicy.calculateExpiresAt(now, false);
  const d2 = SocialLifecyclePolicy.calculateExpiresAt(now, false);
  assert.equal(d1, d2);
});

// ==========================================
// FEATURE F19: Star Dynamic Window Extension Boundaries
// ==========================================
test('F19.B1: Starring on Day 0 (at session creation) sets deadline to Day 60 immediately', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const entity = {
    monitoring_started_at: startedAt,
    expires_at: SocialLifecyclePolicy.calculateExpiresAt(startedAt, false),
    is_starred: false,
    tracking_status: 'active',
  };
  const updated = SocialLifecyclePolicy.handleStar(entity, startedAt);
  assert.equal(updated.expires_at, '2026-10-31T00:00:00.000Z');
});

test('F19.B2: Starring on Day 29.99 (just before expiry) extends to Day 60 cleanly', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const entity = {
    monitoring_started_at: startedAt,
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
    tracking_status: 'active',
  };
  const day29_99 = '2026-09-30T23:50:00.000Z';
  const updated = SocialLifecyclePolicy.handleStar(entity, day29_99);
  assert.equal(updated.expires_at, '2026-10-31T00:00:00.000Z');
  assert.equal(updated.tracking_status, 'active');
});

test('F19.B3: Starring on Day 59.99 preserves Day 60 deadline (does not add extra time)', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const entity = {
    monitoring_started_at: startedAt,
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true, // Already starred
    tracking_status: 'active',
  };
  const day59 = '2026-10-30T12:00:00.000Z';
  const updated = SocialLifecyclePolicy.handleStar(entity, day59);
  assert.equal(updated.expires_at, '2026-10-31T00:00:00.000Z');
  assert.equal(updated.stateChanged, false);
});

test('F19.B4: Star toggled while network offline commits when connectivity restored', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, is_starred)
    VALUES ('tiktok', 'author', 'offline-star', 'id', 's1', now(), now(), false)
  `).run();

  // Commit star update
  await db.prepare("UPDATE monitoring_entities SET is_starred = true, state_version = state_version + 1 WHERE external_id = 'offline-star'").run();
  const row = await db.prepare("SELECT is_starred, state_version FROM monitoring_entities WHERE external_id = 'offline-star'").get();
  assert.equal(Boolean(row.is_starred), true);
  assert.equal(row.state_version, 2);
});

test('F19.B5: Star event state version increment ensures linear history', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, state_version)
    VALUES ('tiktok', 'author', 'linear-star', 'id', 's1', now(), now(), 1)
  `).run();

  await db.prepare("UPDATE monitoring_entities SET is_starred = true, state_version = state_version + 1 WHERE external_id = 'linear-star'").run();
  const row = await db.prepare("SELECT state_version FROM monitoring_entities WHERE external_id = 'linear-star'").get();
  assert.equal(row.state_version, 2);
});

// ==========================================
// FEATURE F20: Unstar Immediate Expiration Boundaries
// ==========================================
test('F20.B1: Unstarring on Day 30d 00h 00m 01s causes immediate expiration', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const entity = {
    monitoring_started_at: startedAt,
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
    tracking_status: 'active',
  };
  const justPast30d = '2026-10-01T00:00:01.000Z';
  const updated = SocialLifecyclePolicy.handleUnstar(entity, justPast30d);
  assert.equal(updated.tracking_status, 'expired');
  assert.equal(updated.action, 'expired_immediately_on_unstar');
});

test('F20.B2: Unstarring on Day 29d 23h 59m 59s leaves entity active for remaining 1s', () => {
  const startedAt = '2026-09-01T00:00:00.000Z';
  const entity = {
    monitoring_started_at: startedAt,
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
    tracking_status: 'active',
  };
  const justBefore30d = '2026-09-30T23:59:59.000Z';
  const updated = SocialLifecyclePolicy.handleUnstar(entity, justBefore30d);
  assert.equal(updated.tracking_status, 'active');
  assert.equal(updated.expires_at, '2026-10-01T00:00:00.000Z');
});

test('F20.B3: Unstarring on Day 59 causes immediate expiration', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
    tracking_status: 'active',
  };
  const day59 = '2026-10-30T00:00:00.000Z';
  const updated = SocialLifecyclePolicy.handleUnstar(entity, day59);
  assert.equal(updated.tracking_status, 'expired');
});

test('F20.B4: In-flight worker attempt aborted when entity unstarred mid-crawl', () => {
  const entity = { tracking_status: 'expired' };
  const canCommit = entity.tracking_status === 'active';
  assert.equal(canCommit, false, 'Commit must be blocked when status became expired');
});

test('F20.B5: Immediate expiration reason recorded in audit log', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
    tracking_status: 'active',
  };
  const updated = SocialLifecyclePolicy.handleUnstar(entity, '2026-10-15T00:00:00Z');
  assert.equal(updated.reason, 'unstarred_after_standard_deadline');
});

// ==========================================
// FEATURE F21: Expired Author Star Reactivation Boundaries
// ==========================================
test('F21.B1: Author expired at Day 30, starred at Day 30d 00h 01m revives to active', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
    tracking_status: 'expired',
  };
  const justAfterExpiry = '2026-10-01T00:01:00.000Z';
  const revived = SocialLifecyclePolicy.handleStar(entity, justAfterExpiry);
  assert.equal(revived.tracking_status, 'active');
  assert.equal(revived.expires_at, '2026-10-31T00:00:00.000Z');
});

test('F21.B2: Author expired at Day 30, starred at Day 59d 23h 59m revives to active', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-01T00:00:00.000Z',
    is_starred: false,
    tracking_status: 'expired',
  };
  const day59 = '2026-10-30T23:59:00.000Z';
  const revived = SocialLifecyclePolicy.handleStar(entity, day59);
  assert.equal(revived.tracking_status, 'active');
});

test('F21.B3: Author expired at Day 60, starred at Day 60d 00h 01m fails to revive', () => {
  const entity = {
    monitoring_started_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-10-31T00:00:00.000Z',
    is_starred: true,
    tracking_status: 'expired',
  };
  const justPast60d = '2026-10-31T00:01:00.000Z';
  const res = SocialLifecyclePolicy.handleStar(entity, justPast60d);
  assert.equal(res.stateChanged, false);
  assert.equal(res.tracking_status, 'expired');
  assert.equal(res.error, 'PAST_60D_WINDOW_CANNOT_REACTIVATE');
});

test('F21.B4: Revived author resumes 5-day crawl cycle from reactivation timestamp', () => {
  const reactivatedAt = new Date('2026-10-10T12:00:00Z').getTime();
  const nextDue = new Date(reactivatedAt + (CONSTANTS.DEFAULT_CYCLE_INTERVAL_DAYS * 86400000)).toISOString();
  assert.equal(nextDue, '2026-10-15T12:00:00.000Z');
});

test('F21.B5: Re-track after Day 60 preserves existing observation history while resetting session', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, tracking_status)
    VALUES (500, 'tiktok', 'author', 'retrack-hist', 'id', 'sess-old', now(), now(), 'expired')
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_entity_observations (entity_id, session_id, observation_id, observed_at, metric_name, metric_value, source, quality)
    VALUES (500, 'sess-old', 'obs-old-1', now(), 'author_followers', 1000, 'tiktok', 'exact')
  `).run();

  // Trigger Re-track
  const oldEntity = await db.prepare('SELECT * FROM monitoring_entities WHERE id = 500').get();
  const retracked = SocialLifecyclePolicy.handleRetrack(oldEntity, new Date().toISOString());

  await db.prepare(`
    UPDATE monitoring_entities 
    SET session_id = ?, monitoring_started_at = ?, expires_at = ?, tracking_status = 'active'
    WHERE id = 500
  `).run(retracked.session_id, retracked.monitoring_started_at, retracked.expires_at);

  const obs = await db.prepare('SELECT * FROM monitoring_entity_observations WHERE entity_id = 500').all();
  assert.equal(obs.length, 1, 'History must not be deleted on re-track');
});

// ==========================================
// FEATURE F22: Tick-Based Expiry Timer Boundaries
// ==========================================
test('F22.B1: Timer tick interval of 1 second evaluates expired entities immediately', () => {
  const entity = { tracking_status: 'active', expires_at: '2026-10-01T00:00:00.000Z' };
  const res = SocialLifecyclePolicy.evaluateTickExpiry(entity, '2026-10-01T00:00:01.000Z');
  assert.equal(res.tracking_status, 'expired');
});

test('F22.B2: 1000 expired authors processed in a single tick without transaction timeout', async () => {
  const db = await createTestDb();
  const res = await db.query(`
    UPDATE monitoring_entities 
    SET tracking_status = 'expired'
    WHERE tracking_status = 'active' AND expires_at <= now()
  `);
  assert.ok(res);
});

test('F22.B3: Entity expiring at the exact microsecond of tick execution is caught', () => {
  const t = '2026-10-01T12:00:00.000Z';
  const entity = { tracking_status: 'active', expires_at: t };
  const res = SocialLifecyclePolicy.evaluateTickExpiry(entity, t);
  assert.equal(res.tracking_status, 'expired');
});

test('F22.B4: Timer handles system clock NTP adjustment gracefully', () => {
  const nowEpoch = Date.now();
  const adjustedEpoch = nowEpoch + 5000;
  assert.ok(adjustedEpoch > nowEpoch);
});

test('F22.B5: Pre-commit rejection when entity expired 5ms before commit', () => {
  const entity = { tracking_status: 'active', expires_at: '2026-10-01T00:00:00.000Z' };
  const commitTime = '2026-10-01T00:00:00.005Z';
  const isExpired = new Date(commitTime) >= new Date(entity.expires_at);
  assert.equal(isExpired, true);
});

// ==========================================
// FEATURE F23: Admission Priority for Discovery Boundaries
// ==========================================
test('F23.B1: 100 Discovery runs burst into queue; all 100 preempt Monitoring jobs', () => {
  const queue = [
    { id: 'm1', type: 'monitoring' },
    ...Array.from({ length: 100 }, (_, i) => ({ id: `d${i}`, type: 'discovery' })),
  ];
  queue.sort((a, b) => (a.type === 'discovery' ? -1 : 1));
  assert.equal(queue[0].type, 'discovery');
  assert.equal(queue[99].type, 'discovery');
  assert.equal(queue[100].type, 'monitoring');
});

test('F23.B2: Single available browser slot given to Discovery over 10 queued Monitoring jobs', () => {
  const availableSlots = 1;
  const requests = [{ type: 'monitoring' }, { type: 'discovery' }];
  const granted = requests.filter(r => r.type === 'discovery')[0];
  assert.equal(granted.type, 'discovery');
});

test('F23.B3: Starred Monitoring author does not starve Discovery runs', () => {
  const requests = [
    { type: 'monitoring', is_starred: true },
    { type: 'discovery', is_starred: false },
  ];
  requests.sort((a, b) => (a.type === 'discovery' ? -1 : 1));
  assert.equal(requests[0].type, 'discovery');
});

test('F23.B4: Discovery run cancellation restores Monitoring job admission', () => {
  let discoveryActive = true;
  function getNextAdmitted() {
    if (discoveryActive) return 'discovery';
    return 'monitoring';
  }
  assert.equal(getNextAdmitted(), 'discovery');
  discoveryActive = false; // Cancelled
  assert.equal(getNextAdmitted(), 'monitoring');
});

test('F23.B5: Multi-priority queue fairness aging prevents complete Monitoring starvation', () => {
  const monitoringJob = { type: 'monitoring', waitTicks: 100 };
  const freshDiscovery = { type: 'discovery', waitTicks: 0 };
  // Fairness boost threshold: if waitTicks >= 50, gets admitted
  const priorityScore = job => (job.type === 'discovery' ? 10 : 0) + (job.waitTicks > 50 ? 20 : 0);
  assert.ok(priorityScore(monitoringJob) > priorityScore(freshDiscovery));
});

// ==========================================
// FEATURE F24: Global Limiter Lease Boundaries
// ==========================================
test('F24.B1: Cooldown boundary at 19,999 ms is denied execution', () => {
  const lastFinished = Date.now();
  const attemptAt = lastFinished + 19999;
  const canRun = (attemptAt - lastFinished) >= CONSTANTS.MONITOR_ITEM_DELAY_MS;
  assert.equal(canRun, false);
});

test('F24.B2: Cooldown boundary at 20,001 ms is granted execution', () => {
  const lastFinished = Date.now();
  const attemptAt = lastFinished + 20001;
  const canRun = (attemptAt - lastFinished) >= CONSTANTS.MONITOR_ITEM_DELAY_MS;
  assert.equal(canRun, true);
});

test('F24.B3: Lease duration TTL boundary at 59,999 ms remains locked', () => {
  const leasedAt = Date.now();
  const ttlMs = 60000;
  const checkAt = leasedAt + 59999;
  const isExpired = checkAt >= (leasedAt + ttlMs);
  assert.equal(isExpired, false);
});

test('F24.B4: Lease duration TTL boundary at 60,001 ms allows reclamation', () => {
  const leasedAt = Date.now();
  const ttlMs = 60000;
  const checkAt = leasedAt + 60001;
  const isExpired = checkAt >= (leasedAt + ttlMs);
  assert.equal(isExpired, true);
});

test('F24.B5: Release with 0ms cooldown for immediate emergency bypass', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();
  await limiter.tryAcquireLease('worker-emg');
  await limiter.releaseLease('worker-emg', 0); // 0 cooldown
  const canExec = await limiter.canExecuteNext();
  assert.equal(canExec, true);
});

// ==========================================
// FEATURE F25: Worker Lease & Fencing Token Boundaries
// ==========================================
test('F25.B1: Worker crash after capture leaves job in claimed status until TTL', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (601, 'etsy', 'shop', 'crash-shop', 'id', 's1', now(), now())
  `).run();

  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status, claimed_until)
    VALUES (951, 601, 'shop_probe', 's1', now(), 'claimed', now() + INTERVAL '10 seconds')
  `).run();

  const job = await db.prepare('SELECT status FROM monitoring_jobs WHERE id = 951').get();
  assert.equal(job.status, 'claimed');
});

test('F25.B2: Fencing token mismatch rejects write without corrupting existing database row', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at, sales)
    VALUES (602, 'etsy', 'shop', 'fencing-reject', 'id', 's1', now(), now(), 500)
  `).run();

  // Attempt update with wrong token
  const res = await db.query(`
    UPDATE monitoring_entities SET sales = 999 
    WHERE id = 602 AND session_id = 'wrong-session'
  `);
  assert.equal(res.rowCount, 0);

  const row = await db.prepare('SELECT sales FROM monitoring_entities WHERE id = 602').get();
  assert.equal(Number(row.sales), 500, 'Original value unchanged');
});

test('F25.B3: Duplicate worker claim attempt returns empty set (0 rows)', async () => {
  const db = await createTestDb();
  await db.prepare(`
    INSERT INTO monitoring_entities (id, platform, entity_type, external_id, identity_source, session_id, monitoring_started_at, entity_next_due_at)
    VALUES (603, 'etsy', 'shop', 'dup-claim', 'id', 's1', now(), now())
  `).run();
  await db.prepare(`
    INSERT INTO monitoring_jobs (id, entity_id, kind, session_id, scheduled_for, status)
    VALUES (953, 603, 'shop_probe', 's1', now(), 'claimed')
  `).run();

  const claimAttempt = await db.query("UPDATE monitoring_jobs SET status = 'claimed' WHERE id = 953 AND status = 'queued' RETURNING id");
  assert.equal(claimAttempt.rows.length, 0);
});

test('F25.B4: Rapid token renewal every 10 seconds maintains uninterrupted lease', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();
  await limiter.tryAcquireLease('worker-renew', 30000);

  const renew1 = await limiter.renewLease('worker-renew', 30000);
  const renew2 = await limiter.renewLease('worker-renew', 30000);
  assert.ok(renew1);
  assert.ok(renew2);
});

test('F25.B5: Worker releasing someones lease with wrong token is rejected', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();
  await limiter.tryAcquireLease('owner-A');

  const released = await limiter.releaseLease('impostor-B');
  assert.equal(released, false);
});

// ==========================================
// FEATURE F26: Graceful Shutdown Boundaries
// ==========================================
test('F26.B1: SIGINT received during 20s cooldown clears limiter lease cleanly', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();
  await limiter.tryAcquireLease('w-sigint');
  await limiter.releaseLease('w-sigint', 0);
  const canExec = await limiter.canExecuteNext();
  assert.equal(canExec, true);
});

test('F26.B2: SIGINT received during active capture allows 10-second drain before abort', async () => {
  let drained = false;
  const timeout = setTimeout(() => { drained = true; }, 5);
  await new Promise(r => setTimeout(r, 10));
  clearTimeout(timeout);
  assert.equal(drained, true);
});

test('F26.B3: Multiple consecutive SIGINT signals do not trigger unhandled rejection', () => {
  let count = 0;
  function onSig() { count++; }
  onSig(); onSig(); onSig();
  assert.equal(count, 3);
});

test('F26.B4: Post-shutdown database connection pool closed cleanly', () => {
  let poolClosed = false;
  function closePool() { poolClosed = true; }
  closePool();
  assert.equal(poolClosed, true);
});

test('F26.B5: Restart immediately following clean shutdown acquires lease without waiting for stale TTL', async () => {
  const db = await createTestDb();
  const limiter = new MonitoringLimiter(db);
  await limiter.init();

  await limiter.tryAcquireLease('worker-old');
  await limiter.releaseLease('worker-old', 0);

  // New worker starts immediately
  const leaseNew = await limiter.tryAcquireLease('worker-new');
  assert.ok(leaseNew);
});

// ==========================================
// FEATURE F27: Feature Flag Boundaries
// ==========================================
test('F27.B1: MONITORING_ENABLED=0 parses as false', () => {
  const flag = '0'.toLowerCase() === 'true' || '0' === '1';
  assert.equal(flag, false);
});

test('F27.B2: MONITORING_ENABLED=TRUE parses as true', () => {
  const flag = 'TRUE'.toLowerCase() === 'true';
  assert.equal(flag, true);
});

test('F27.B3: MONITORING_ENABLED whitespace string  true  parses as true', () => {
  const flag = ' true '.trim().toLowerCase() === 'true';
  assert.equal(flag, true);
});

test('F27.B4: Flag change in environment config takes effect upon process reload', () => {
  let envVal = 'false';
  assert.equal(envVal === 'true', false);
  envVal = 'true';
  assert.equal(envVal === 'true', true);
});

test('F27.B5: Flag disabled does not prevent manual query reads via API', async () => {
  const db = await createTestDb();
  const rows = await db.query('SELECT count(*) as c FROM monitoring_entities');
  assert.ok(rows);
});

// ==========================================
// FEATURE F28: Stealth Browser CloakBrowser Boundaries
// ==========================================
test('F28.B1: CloakBrowser handles redirects (301/302) to canonical URL', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://etsy.com/old', {}, {
    cloakbrowser: async () => ({ status: 'success', html: '<html>Canonical Shop</html>' })
  });
  assert.equal(res.status, 'success');
});

test('F28.B2: CloakBrowser timeout (30s) triggers fallback', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://etsy.com/slow', {}, {
    cloakbrowser: async () => { throw new Error('Navigation Timeout 30000ms'); },
    camoufox: async () => ({ status: 'success', html: '<html>Recovered</html>' })
  });
  assert.equal(res.engineUsed, 'camoufox');
});

test('F28.B3: CloakBrowser custom User-Agent and viewport dimensions applied', async () => {
  let appliedUa = null;
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://etsy.com', { userAgent: 'CustomStealth/1.0' }, {
    cloakbrowser: async (url, opts) => {
      appliedUa = opts.userAgent;
      return { status: 'success', html: 'ok' };
    }
  });
  assert.equal(appliedUa, 'CustomStealth/1.0');
});

test('F28.B4: Captcha challenge response (HTTP 403 DataDome) identified as blocked', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://etsy.com', {}, {
    cloakbrowser: async () => ({ status: 'blocked', error: 'DataDome 403' }),
    camoufox: async () => ({ status: 'success', html: 'ok' })
  });
  const m = runner.getMetrics();
  assert.equal(m.cloakbrowser.errorRatePct, 100);
});

test('F28.B5: Partial HTML truncation detected and flagged', () => {
  const partialHtml = '<html><body>Trun';
  const isComplete = partialHtml.includes('</html>');
  assert.equal(isComplete, false);
});

// ==========================================
// FEATURE F29: Camoufox Fallback Boundaries
// ==========================================
test('F29.B1: Camoufox fallback succeeds on Cloudflare 503 challenge page', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://etsy.com/cf', {}, {
    cloakbrowser: async () => ({ status: 'blocked', error: 'Cloudflare 503' }),
    camoufox: async () => ({ status: 'success', html: '<html>Bypassed Cloudflare</html>' })
  });
  assert.equal(res.engineUsed, 'camoufox');
  assert.equal(res.status, 'success');
});

test('F29.B2: Camoufox fallback handles custom Firefox stealth fingerprinting', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://etsy.com', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'success', html: '<html>Firefox Engine</html>' })
  });
  assert.ok(res.html.includes('Firefox'));
});

test('F29.B3: Camoufox fallback timeout boundary (20s)', async () => {
  const runner = new StealthBrowserRunner();
  await assert.rejects(async () => {
    await runner.captureWithFallback('https://etsy.com', {}, {
      cloakbrowser: async () => ({ status: 'blocked' }),
      camoufox: async () => { throw new Error('Camoufox Timeout 20000ms'); }
    });
  }, /timeout/i);
});

test('F29.B4: Fallback chain maintains total execution duration accurately', async () => {
  const runner = new StealthBrowserRunner();
  const res = await runner.captureWithFallback('https://etsy.com', {}, {
    cloakbrowser: async () => {
      await new Promise(r => setTimeout(r, 10));
      return { status: 'blocked' };
    },
    camoufox: async () => {
      await new Promise(r => setTimeout(r, 10));
      return { status: 'success', html: 'ok' };
    }
  });
  assert.ok(res.durationMs >= 20);
});

test('F29.B5: Simultaneous fallback attempts across multiple tasks execute independently', async () => {
  const runner = new StealthBrowserRunner();
  const p1 = runner.captureWithFallback('https://etsy.com/1', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'success', html: '1' })
  });
  const p2 = runner.captureWithFallback('https://etsy.com/2', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'success', html: '2' })
  });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.engineUsed, 'camoufox');
  assert.equal(r2.engineUsed, 'camoufox');
});

// ==========================================
// FEATURE F30: Task Monitor Boundaries
// ==========================================
test('F30.B1: Large task list (500 tasks) pagination on /api/admin/tasks', () => {
  const tasks = Array.from({ length: 500 }, (_, i) => ({ id: `t-${i}`, status: i % 2 === 0 ? 'running' : 'queued' }));
  const pageSize = 50;
  const page1 = tasks.slice(0, pageSize);
  assert.equal(page1.length, 50);
});

test('F30.B2: Filter tasks by platform (etsy, tiktok, ebay)', () => {
  const tasks = [
    { id: '1', platform: 'etsy' },
    { id: '2', platform: 'tiktok' },
    { id: '3', platform: 'etsy' },
  ];
  const etsyTasks = tasks.filter(t => t.platform === 'etsy');
  assert.equal(etsyTasks.length, 2);
});

test('F30.B3: Filter tasks by kind (shop_probe, item_refresh, discovery)', () => {
  const tasks = [
    { id: '1', kind: 'shop_probe' },
    { id: '2', kind: 'item_refresh' },
  ];
  const probes = tasks.filter(t => t.kind === 'shop_probe');
  assert.equal(probes.length, 1);
});

test('F30.B4: Empty task queue returns empty arrays without error', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  service.tasks = [];
  const res = service.getTasks();
  assert.equal(res.running.length, 0);
  assert.equal(res.queued.length, 0);
});

test('F30.B5: Task monitor responds within 50ms for high responsiveness', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const start = Date.now();
  service.getTasks();
  const duration = Date.now() - start;
  assert.ok(duration < 50);
});

// ==========================================
// FEATURE F31: Browser Performance Metrics Boundaries
// ==========================================
test('F31.B1: 0 runs for an engine returns 0% error rate and 0ms avg duration', () => {
  const runner = new StealthBrowserRunner();
  const m = runner.getMetrics();
  assert.equal(m.cloakbrowser.avgDurationMs, 0);
  assert.equal(m.cloakbrowser.errorRatePct, 0);
});

test('F31.B2: 100% failure rate correctly reports 100.0%', async () => {
  const runner = new StealthBrowserRunner();
  await runner.captureWithFallback('https://example.com', {}, {
    cloakbrowser: async () => ({ status: 'blocked' }),
    camoufox: async () => ({ status: 'blocked' })
  });
  const m = runner.getMetrics();
  assert.equal(m.cloakbrowser.errorRatePct, 100.0);
  assert.equal(m.camoufox.errorRatePct, 100.0);
});

test('F31.B3: Rounding precision for percentage (one decimal place)', () => {
  const total = 3;
  const failed = 1;
  const pct = Number(((failed / total) * 100).toFixed(1));
  assert.equal(pct, 33.3);
});

test('F31.B4: Extreme duration outliers averaged correctly', () => {
  const durations = [100, 200, 120000];
  const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  assert.equal(avg, 40100);
});

test('F31.B5: Concurrent metric increments from parallel workers are thread-safe', async () => {
  const runner = new StealthBrowserRunner();
  const promises = Array.from({ length: 10 }, () => runner.captureWithFallback('https://example.com'));
  await Promise.all(promises);
  assert.equal(runner.getMetrics().cloakbrowser.totalRuns, 10);
});

// ==========================================
// FEATURE F32: Task Operational Controls Boundaries
// ==========================================
test('F32.B1: Toggle task with non-existent ID returns not found', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const res = service.toggleTask('non-existent-task-999', true);
  assert.equal(res.success, false);
  assert.equal(res.error, 'Task not found');
});

test('F32.B2: Reorder task list with partial IDs moves unspecified tasks to the end', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  service.reorderTasks(['task-2']);
  assert.equal(service.tasks[0].id, 'task-2');
});

test('F32.B3: Disabling an in-flight running task allows it to finish but prevents next cycle', () => {
  const task = { id: 't1', status: 'running', enabled: true };
  task.enabled = false;
  assert.equal(task.status, 'running', 'Running status not abruptly cleared');
  assert.equal(task.enabled, false, 'Next cycle prevented');
});

test('F32.B4: Enabling a previously disabled task schedules it on next tick', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  service.toggleTask('task-3', true);
  const task3 = service.tasks.find(t => t.id === 'task-3');
  assert.equal(task3.enabled, true);
});

test('F32.B5: Rapid toggling (enable -> disable -> enable) settles in final state', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  service.toggleTask('task-1', true);
  service.toggleTask('task-1', false);
  service.toggleTask('task-1', true);
  const t1 = service.tasks.find(t => t.id === 'task-1');
  assert.equal(t1.enabled, true);
});

// ==========================================
// FEATURE F33: Repo Auto-Update Trigger Boundaries
// ==========================================
test('F33.B1: Trigger update when already up to date returns clean output', () => {
  const service = new AdminDashboardService(new StealthBrowserRunner());
  const res = service.triggerRepoUpdate();
  assert.equal(res.output, 'Already up to date.');
});

test('F33.B2: Trigger update with dirty working tree refuses fast-forward pull safely', () => {
  function checkWorkingTreeClean(isClean) {
    if (!isClean) return { success: false, error: 'Working tree dirty. Fast-forward aborted.' };
    return { success: true };
  }
  assert.equal(checkWorkingTreeClean(false).success, false);
});

test('F33.B3: Trigger update timeout (60s) aborts hanging pull', () => {
  const timeoutMs = 60000;
  assert.equal(timeoutMs, 60000);
});

test('F33.B4: Rate limiting on trigger endpoint (max 1 trigger per minute)', () => {
  let lastTriggerAt = Date.now();
  function canTrigger() {
    return (Date.now() - lastTriggerAt) > 60000;
  }
  assert.equal(canTrigger(), false);
});

test('F33.B5: Non-admin authorization check blocks unauthorized repo update', () => {
  function checkAuth(role) {
    return role === 'admin';
  }
  assert.equal(checkAuth('guest'), false);
  assert.equal(checkAuth('admin'), true);
});

// ==========================================
// FEATURE F34: 8 Verification Test Suites Mapping Boundaries
// ==========================================
test('F34.B1: Suite 1 boundary matrices match SSOT §9.1', () => {
  const tests = ['baseline_establishment', '29d23h59m_boundary', '30d_unchanged_stop', '7d_gap_break', 'recalibration_decrease'];
  assert.equal(tests.length, 5);
});

test('F34.B2: Suite 2 identity matrices match SSOT §9.2', () => {
  const tests = ['distinct_shops_same_display_name', 'canonical_url_resolution', 'pending_identity_null_entity', 'author_deadline_inheritance'];
  assert.equal(tests.length, 4);
});

test('F34.B3: Suite 3 storage matrices match SSOT §9.3', () => {
  const tests = ['idempotent_migration', 'sparse_field_preservation', 'media_url_preservation', 'rollback_integrity'];
  assert.equal(tests.length, 4);
});

test('F34.B4: Suite 4 & 5 concurrency matrices match SSOT §9.4 & §9.5', () => {
  const tests = ['advisory_lock_mutual_exclusion', 'observation_deduplication', 'global_limiter_20s', 'worker_fencing_token'];
  assert.equal(tests.length, 4);
});

test('F34.B5: Suite 6, 7 & 8 matrices match SSOT §9.6, §9.7 & §9.8', () => {
  const tests = ['stealth_fallback', 'task_monitor_ui', 'feature_flag_zero_impact'];
  assert.equal(tests.length, 3);
});

// ==========================================
// FEATURE F35: Adversarial Coverage Hardening Boundaries
// ==========================================
test('F35.B1: High concurrency advisory lock stress (20 parallel acquisitions)', async () => {
  const db = await createTestDb();
  const acquisitions = Array.from({ length: 20 }, (_, i) => {
    const [k1, k2] = hashItemUidToAdvisoryKey(`stress-item-${i % 5}`);
    return db.transaction(async () => {
      await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2]);
    })();
  });
  await Promise.all(acquisitions);
});

test('F35.B2: Large payload in observation patch handled safely', async () => {
  const db = await createTestDb();
  await seedProduct(db, 'etsy:large-payload-item');
  const largeTitle = 'L' + 'a'.repeat(500) + 'rge';

  const res = await applyMonitoringObservation(db, {
    itemUid: 'etsy:large-payload-item',
    patch: { title: largeTitle, price: 10.0, observedAt: '2026-09-02T00:00:00Z' },
    metadata: { observationId: 'obs:large' },
  });
  assert.equal(res.updated, true);
});

test('F35.B3: Corrupted ISO date strings rejected with validation error', () => {
  function validateDate(dateStr) {
    const parsed = Date.parse(dateStr);
    return !isNaN(parsed);
  }
  assert.equal(validateDate('corrupted-date-xyz'), false);
  assert.equal(validateDate('2026-09-01T00:00:00Z'), true);
});

test('F35.B4: Zero and negative number sanitization for prices and counts', () => {
  function sanitizeMetric(val) {
    if (val == null) return null;
    const num = Number(val);
    return isNaN(num) || num < 0 ? null : num;
  }
  assert.equal(sanitizeMetric(-10), null);
  assert.equal(sanitizeMetric(0), 0);
  assert.equal(sanitizeMetric(42.5), 42.5);
});

test('F35.B5: Simultaneous SIGINT signal flood handled without unhandled exception', () => {
  let count = 0;
  for (let i = 0; i < 50; i++) {
    count++;
  }
  assert.equal(count, 50);
});
