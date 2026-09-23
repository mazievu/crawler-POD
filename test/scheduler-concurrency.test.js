'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResourceScheduler } = require('../src/scheduler/scheduler');

function createMockScheduler(options = {}) {
  const fakeDatabase = {
    getAllPlatforms: async () => [],
    getRunsFiltered: async () => [],
  };
  const fakeQueue = {
    peek: async () => [],
    countByStatus: async () => ({ queued: 0, running: 0, done: 0 }),
  };
  const fakeMonitor = {
    getSnapshot: () => ({ state: 'GREEN', availableMB: 4096 }),
    canAdmit: () => ({ allowed: true }),
    reserve: () => {},
    release: () => {},
  };
  const fakePools = {
    getStatus: () => ({}),
    isElastic: () => true,
    canAdmit: () => ({ allowed: true }),
    acquireSlot: () => true,
    acquireLock: () => true,
    releaseAllForToken: () => {},
  };

  return new ResourceScheduler({
    database: fakeDatabase,
    queue: fakeQueue,
    monitor: fakeMonitor,
    pools: fakePools,
    ...options,
  });
}

test('Scheduler Concurrency: Feature 11 System Concurrency Cap', async (t) => {
  await t.test('initializes default and custom MAX_CONCURRENT_RUNS', () => {
    const s1 = createMockScheduler();
    assert.strictEqual(s1.getMaxConcurrentRuns(), 10);

    const s2 = createMockScheduler({ maxConcurrentRuns: 4 });
    assert.strictEqual(s2.getMaxConcurrentRuns(), 4);
  });

  await t.test('canAdmitRun evaluates against concurrency ceiling', () => {
    const scheduler = createMockScheduler({ maxConcurrentRuns: 2 });
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);

    const check1 = scheduler.canAdmitRun();
    assert.strictEqual(check1.allowed, true);

    // Simulate 1 active run
    scheduler.setActiveRunsCount(1);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 1);
    assert.strictEqual(scheduler.canAdmitRun().allowed, true);

    // Simulate 2 active runs (hits cap)
    scheduler.setActiveRunsCount(2);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 2);
    const check2 = scheduler.canAdmitRun();
    assert.strictEqual(check2.allowed, false);
    assert.strictEqual(check2.reason, 'CONCURRENCY_LIMIT_REACHED');
    assert.match(check2.message, /Concurrency limit reached/i);
  });

  await t.test('dynamic ceiling change (B11.2)', () => {
    const scheduler = createMockScheduler({ maxConcurrentRuns: 5 });
    scheduler.setActiveRunsCount(3);
    assert.strictEqual(scheduler.canAdmitRun().allowed, true);

    // Lower ceiling below active count
    scheduler.setMaxConcurrentRuns(2);
    assert.strictEqual(scheduler.canAdmitRun().allowed, false);

    // Raise ceiling above active count
    scheduler.setMaxConcurrentRuns(10);
    assert.strictEqual(scheduler.canAdmitRun().allowed, true);
  });

  await t.test('zero underflow protection on active run counter (B11.4)', () => {
    const scheduler = createMockScheduler({ maxConcurrentRuns: 5 });
    scheduler.setActiveRunsCount(0);
    // Setting negative count clamps to 0
    scheduler.setActiveRunsCount(-5);
    assert.strictEqual(scheduler.getActiveExecutionCount(), 0);
  });

  await t.test('tick halts candidate admission when at concurrency limit', async () => {
    let peekCalled = false;
    const mockQueue = {
      peek: async () => {
        peekCalled = true;
        return [{ id: 101, platform: 'etsy' }];
      },
      countByStatus: async () => ({}),
    };

    const scheduler = createMockScheduler({
      maxConcurrentRuns: 2,
      queue: mockQueue,
    });

    // Set active runs to 2 (cap reached)
    scheduler.setActiveRunsCount(2);

    await scheduler.tick();

    // Peek should NOT be called because tick halts before queue peek
    assert.strictEqual(peekCalled, false);
  });
});

test('Scheduler Concurrency: Feature 13 Emergency Dispatch Freeze', async (t) => {
  await t.test('toggles emergency freeze and returns current state', () => {
    const scheduler = createMockScheduler();
    assert.strictEqual(scheduler.isFrozen(), false);

    scheduler.setEmergencyFreeze(true);
    assert.strictEqual(scheduler.isFrozen(), true);

    // Idempotent call
    scheduler.setEmergencyFreeze(true);
    assert.strictEqual(scheduler.isFrozen(), true);

    scheduler.setEmergencyFreeze(false);
    assert.strictEqual(scheduler.isFrozen(), false);
  });

  await t.test('canAdmitRun rejects immediately with DISPATCH_FROZEN when frozen', () => {
    const scheduler = createMockScheduler({ maxConcurrentRuns: 10 });
    scheduler.setActiveRunsCount(0); // 0 active runs, plenty of capacity

    scheduler.setEmergencyFreeze(true);
    const result = scheduler.canAdmitRun();

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'DISPATCH_FROZEN');
    assert.match(result.message, /frozen by administrator/i);
  });

  await t.test('tick halts admission immediately when frozen even if capacity is open', async () => {
    let peekCalled = false;
    const mockQueue = {
      peek: async () => {
        peekCalled = true;
        return [{ id: 101, platform: 'etsy' }];
      },
      countByStatus: async () => ({}),
    };

    const scheduler = createMockScheduler({
      maxConcurrentRuns: 10,
      queue: mockQueue,
    });

    scheduler.setEmergencyFreeze(true);
    await scheduler.tick();

    assert.strictEqual(peekCalled, false);
  });

  await t.test('getStatus reflects freeze and concurrency status accurately', async () => {
    const scheduler = createMockScheduler({ maxConcurrentRuns: 8 });
    scheduler.setEmergencyFreeze(true);
    scheduler.setActiveRunsCount(3);

    const status = await scheduler.getStatus();
    assert.strictEqual(status.isFrozen, true);
    assert.strictEqual(status.concurrency.active, 3);
    assert.strictEqual(status.concurrency.maxConcurrentRuns, 8);
    assert.strictEqual(status.concurrency.isFrozen, true);
  });
});
