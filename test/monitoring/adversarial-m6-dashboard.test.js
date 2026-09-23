'use strict';

/**
 * Milestone 6 Adversarial Challenge Test Suite: Admin Dashboard & Repo Update
 *
 * Authored by: Challenger 2 (Admin Dashboard & Repo Update Challenger)
 * Scope: Empirical stress tests, edge case mining, and security verification for:
 * 1. GET /api/admin/tasks (latency < 50ms, platform/kind/type filters, pagination, empty queue)
 * 2. POST /api/admin/tasks/reorder (priority ordering, partial IDs preservation at tail, invalid inputs)
 * 3. POST /api/admin/tasks/toggle (enable/disable, running task in-flight execution preservation F32.B3, not-found)
 * 4. POST /api/admin/repo/update (mutex concurrency F33.4, dirty tree abort F33.B2, zero command injection)
 * 5. Simulation 4: Full Admin Dashboard Operations & Live Recovery
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { AdminDashboardService, createAdminDashboardRouter } = require('../../src/admin/dashboard');
const { StealthBrowserRunner } = require('../../src/marketplaces/stealth-browser');

// Helper to start an ephemeral test server for HTTP endpoint tests
function createTestServer(serviceOptions = {}) {
  const app = express();
  app.use(express.json());
  const service = new AdminDashboardService(serviceOptions.stealthRunner || new StealthBrowserRunner(), serviceOptions);
  const router = createAdminDashboardRouter({ service, ...serviceOptions });
  app.use(router);

  const server = http.createServer(app);
  return {
    server,
    service,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// HTTP request helper using native fetch
async function apiRequest(port, method, path, body = null) {
  const url = `http://127.0.0.1:${port}${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== null) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json, headers: res.headers };
}

// =============================================================================
// CHALLENGE 1: GET /api/admin/tasks (Performance, Filters, Pagination, Queue Edge Cases)
// =============================================================================
describe('Challenge 1: GET /api/admin/tasks verification & stress tests', () => {
  let port;
  let serverInstance;
  let service;

  before(async () => {
    const s = createTestServer();
    serverInstance = s.server;
    service = s.service;
    port = await s.listen();
  });

  after(async () => {
    await new Promise((r) => serverInstance.close(r));
  });

  test('C1.1: Response time is strictly under 50ms for empty and populated task lists', async () => {
    // Warmup
    await apiRequest(port, 'GET', '/api/admin/tasks');

    // Benchmark 20 iterations
    const durations = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const res = await apiRequest(port, 'GET', '/api/admin/tasks');
      const dur = performance.now() - t0;
      durations.push(dur);
      assert.equal(res.status, 200);
    }

    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const maxDuration = Math.max(...durations);
    assert.ok(avgDuration < 50, `Average HTTP response time must be < 50ms (measured: ${avgDuration.toFixed(2)}ms)`);
    assert.ok(maxDuration < 50, `Peak HTTP response time must be < 50ms (measured: ${maxDuration.toFixed(2)}ms)`);
  });

  test('C1.2: Stress test with 1,000 tasks verifies latency < 50ms and array immutability', () => {
    const syntheticTasks = Array.from({ length: 1000 }, (_, i) => ({
      id: `task-bench-${i}`,
      name: `Stress Task ${i}`,
      priority: i + 1,
      status: i % 3 === 0 ? 'running' : i % 3 === 1 ? 'queued' : 'pending',
      enabled: i % 2 === 0,
      platform: i % 2 === 0 ? 'etsy' : 'tiktok',
      kind: i % 4 === 0 ? 'shop_probe' : 'item_refresh',
      startedAt: i % 3 === 0 ? new Date(Date.now() - (i * 1000)).toISOString() : null,
    }));

    service.tasks = syntheticTasks;

    const t0 = performance.now();
    const result = service.getTasks();
    const elapsed = performance.now() - t0;

    assert.ok(elapsed < 10, `In-memory 1,000 task filtering must execute in < 10ms (measured: ${elapsed.toFixed(2)}ms)`);
    assert.equal(result.running.length, 334);
    assert.equal(result.queued.length, 666); // 333 queued + 333 pending

    // Verify running tasks have non-negative elapsedMs
    for (const r of result.running) {
      assert.ok(typeof r.elapsedMs === 'number');
      assert.ok(r.elapsedMs >= 0);
    }
  });

  test('C1.3: Filtering by platform handles mixed case, whitespace, and unknown platforms', () => {
    service.tasks = [
      { id: 't1', platform: 'etsy', status: 'running' },
      { id: 't2', platform: 'tiktok', status: 'queued' },
      { id: 't3', platform: 'Etsy', status: 'queued' },
      { id: 't4', platform: 'EBAY', status: 'running' },
      { id: 't5', platform: null, status: 'queued' },
    ];

    // Case insensitivity and whitespace trim
    const etsyRes = service.getTasks({ platform: '  ETSY  ' });
    assert.equal(etsyRes.running.length, 1);
    assert.equal(etsyRes.queued.length, 1);

    // Platform without matches
    const unknownRes = service.getTasks({ platform: 'amazon' });
    assert.equal(unknownRes.running.length, 0);
    assert.equal(unknownRes.queued.length, 0);
  });

  test('C1.4: Filtering by job kind (shop_probe, item_refresh, discovery)', () => {
    service.tasks = [
      { id: 't1', kind: 'shop_probe', status: 'running' },
      { id: 't2', kind: 'item_refresh', status: 'queued' },
      { id: 't3', kind: 'discovery', status: 'queued' },
      { id: 't4', kind: 'SHOP_PROBE', status: 'queued' },
    ];

    const probeRes = service.getTasks({ kind: 'shop_probe' });
    assert.equal(probeRes.running.length, 1);
    assert.equal(probeRes.queued.length, 1);

    const refreshRes = service.getTasks({ kind: 'item_refresh' });
    assert.equal(refreshRes.queued.length, 1);
    assert.equal(refreshRes.running.length, 0);
  });

  test('C1.5: Pagination limit and offset boundary stress testing', () => {
    service.tasks = Array.from({ length: 25 }, (_, i) => ({
      id: `task-${i}`,
      status: 'queued',
      priority: i + 1,
    }));

    // Page 1: limit=10, offset=0
    const page1 = service.getTasks({ limit: 10, offset: 0 });
    assert.equal(page1.queued.length, 10);
    assert.equal(page1.totalQueued, 25);
    assert.equal(page1.queued[0].id, 'task-0');
    assert.equal(page1.queued[9].id, 'task-9');

    // Page 2: limit=10, offset=10
    const page2 = service.getTasks({ limit: 10, offset: 10 });
    assert.equal(page2.queued.length, 10);
    assert.equal(page2.queued[0].id, 'task-10');

    // Page 3: limit=10, offset=20 (partial page)
    const page3 = service.getTasks({ limit: 10, offset: 20 });
    assert.equal(page3.queued.length, 5);

    // Offset out of bounds
    const pageOOB = service.getTasks({ limit: 10, offset: 100 });
    assert.equal(pageOOB.queued.length, 0);
    assert.equal(pageOOB.totalQueued, 25);

    // Negative offset/limit safety clamping
    const clamped = service.getTasks({ limit: -5, offset: -10 });
    assert.equal(clamped.queued.length, 1); // Math.max(1, -5) -> 1
  });

  test('C1.6: Empty queue handling returns structured empty arrays without throwing', async () => {
    service.tasks = [];
    const res = await apiRequest(port, 'GET', '/api/admin/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { running: [], queued: [] });

    // With pagination params
    const pageRes = await apiRequest(port, 'GET', '/api/admin/tasks?limit=10&offset=0');
    assert.equal(pageRes.status, 200);
    assert.deepEqual(pageRes.data, {
      running: [],
      queued: [],
      totalRunning: 0,
      totalQueued: 0,
    });
  });
});

// =============================================================================
// CHALLENGE 2: POST /api/admin/tasks/reorder (Priority Reordering, Tail Preservation, Input Validation)
// =============================================================================
describe('Challenge 2: POST /api/admin/tasks/reorder verification & stress tests', () => {
  let port;
  let serverInstance;
  let service;

  before(async () => {
    const s = createTestServer();
    serverInstance = s.server;
    service = s.service;
    port = await s.listen();
  });

  after(async () => {
    await new Promise((r) => serverInstance.close(r));
  });

  test('C2.1: Full priority reordering updates all positions and sequential priority values (1-based)', async () => {
    service.tasks = [
      { id: 'task-1', priority: 1 },
      { id: 'task-2', priority: 2 },
      { id: 'task-3', priority: 3 },
    ];

    const res = await apiRequest(port, 'POST', '/api/admin/tasks/reorder', {
      order: ['task-3', 'task-2', 'task-1'],
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(service.tasks[0].id, 'task-3');
    assert.equal(service.tasks[0].priority, 1);
    assert.equal(service.tasks[1].id, 'task-2');
    assert.equal(service.tasks[1].priority, 2);
    assert.equal(service.tasks[2].id, 'task-1');
    assert.equal(service.tasks[2].priority, 3);
  });

  test('C2.2: F32.B2 contract: Unspecified task IDs MUST be preserved and placed at the tail', async () => {
    service.tasks = [
      { id: 'task-A', priority: 1 },
      { id: 'task-B', priority: 2 },
      { id: 'task-C', priority: 3 },
      { id: 'task-D', priority: 4 },
      { id: 'task-E', priority: 5 },
    ];

    // Only specify task-D and task-B
    const res = await apiRequest(port, 'POST', '/api/admin/tasks/reorder', {
      order: ['task-D', 'task-B'],
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(service.tasks.length, 5, 'No tasks must be dropped');

    // Specified tasks at head in specified order
    assert.equal(service.tasks[0].id, 'task-D');
    assert.equal(service.tasks[0].priority, 1);
    assert.equal(service.tasks[1].id, 'task-B');
    assert.equal(service.tasks[1].priority, 2);

    // Unspecified tasks at tail with sequential priority
    const tailIds = [service.tasks[2].id, service.tasks[3].id, service.tasks[4].id];
    assert.ok(tailIds.includes('task-A'));
    assert.ok(tailIds.includes('task-C'));
    assert.ok(tailIds.includes('task-E'));
    assert.equal(service.tasks[2].priority, 3);
    assert.equal(service.tasks[3].priority, 4);
    assert.equal(service.tasks[4].priority, 5);
  });

  test('C2.3: Reorder with non-existent or phantom task IDs does not corrupt registry', () => {
    service.tasks = [
      { id: 'task-1', priority: 1 },
      { id: 'task-2', priority: 2 },
    ];

    const result = service.reorderTasks(['phantom-999', 'task-2', 'another-phantom']);
    assert.equal(result.success, true);
    assert.equal(service.tasks.length, 2);
    assert.equal(service.tasks[0].id, 'task-2');
    assert.equal(service.tasks[0].priority, 1);
    assert.equal(service.tasks[1].id, 'task-1');
    assert.equal(service.tasks[1].priority, 2);
  });

  test('C2.4: Invalid input payloads are rejected with HTTP 400 and descriptive error', async () => {
    // String instead of array
    const res1 = await apiRequest(port, 'POST', '/api/admin/tasks/reorder', 'invalid-string');
    assert.equal(res1.status, 400);
    assert.match(res1.data.error, /array/i);

    // Object without taskOrder/order/tasks array
    const res2 = await apiRequest(port, 'POST', '/api/admin/tasks/reorder', { bogusKey: 123 });
    assert.equal(res2.status, 400);
    assert.match(res2.data.error, /array/i);

    // null payload
    const res3 = await apiRequest(port, 'POST', '/api/admin/tasks/reorder', null);
    assert.equal(res3.status, 400);
    assert.match(res3.data.error, /array/i);

    // Direct unit call throwing test
    assert.throws(() => service.reorderTasks(12345), /array/i);
    assert.throws(() => service.reorderTasks(null), /array/i);
  });
});

// =============================================================================
// CHALLENGE 3: POST /api/admin/tasks/toggle (In-Flight Task F32.B3, Adapters, Queues)
// =============================================================================
describe('Challenge 3: POST /api/admin/tasks/toggle verification & stress tests', () => {
  let port;
  let serverInstance;
  let service;

  before(async () => {
    const s = createTestServer();
    serverInstance = s.server;
    service = s.service;
    port = await s.listen();
  });

  after(async () => {
    await new Promise((r) => serverInstance.close(r));
  });

  test('C3.1: F32.B3 contract: Disabling an in-flight running task preserves status="running" while setting enabled=false', async () => {
    service.tasks = [
      { id: 'in-flight-crawl', status: 'running', enabled: true, startedAt: new Date().toISOString() },
    ];

    // Toggle off
    const res = await apiRequest(port, 'POST', '/api/admin/tasks/toggle', {
      taskId: 'in-flight-crawl',
      enabled: false,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.enabled, false);

    // Verify task state in service registry
    const task = service.tasks.find((t) => t.id === 'in-flight-crawl');
    assert.equal(task.status, 'running', 'CRITICAL: In-flight task status MUST remain "running" so current execution completes gracefully');
    assert.equal(task.enabled, false, 'CRITICAL: enabled MUST be false to block scheduling on subsequent ticks');
  });

  test('C3.2: Enabling a disabled task updates enabled=true', async () => {
    service.tasks = [
      { id: 'queued-task', status: 'queued', enabled: false },
    ];

    const res = await apiRequest(port, 'POST', '/api/admin/tasks/toggle', {
      taskId: 'queued-task',
      enabled: true,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.enabled, true);
    assert.equal(service.tasks[0].enabled, true);
  });

  test('C3.3: Toggling engine adapters (cloakbrowser, camoufox) and queues (discovery, monitoring)', async () => {
    // Toggle CloakBrowser adapter off
    const resAdapter = await apiRequest(port, 'POST', '/api/admin/tasks/toggle', {
      adapterId: 'cloakbrowser',
      enabled: false,
    });
    assert.equal(resAdapter.status, 200);
    assert.equal(service.adapters.cloakbrowser.enabled, false);

    // Toggle Discovery queue off
    const resQueue = await apiRequest(port, 'POST', '/api/admin/tasks/toggle', {
      queueId: 'discovery',
      enabled: false,
    });
    assert.equal(resQueue.status, 200);
    assert.equal(service.queues.discovery.enabled, false);

    // Restore
    service.toggleTask('cloakbrowser', true);
    service.toggleTask('discovery', true);
    assert.equal(service.adapters.cloakbrowser.enabled, true);
    assert.equal(service.queues.discovery.enabled, true);
  });

  test('C3.4: Toggling non-existent ID returns HTTP 404 with "Task not found"', async () => {
    const res = await apiRequest(port, 'POST', '/api/admin/tasks/toggle', {
      taskId: 'missing-entity-404',
      enabled: true,
    });

    assert.equal(res.status, 404);
    assert.equal(res.data.success, false);
    assert.equal(res.data.error, 'Task not found');
  });

  test('C3.5: Missing target identifier returns HTTP 400', async () => {
    const res = await apiRequest(port, 'POST', '/api/admin/tasks/toggle', {
      enabled: true,
    });

    assert.equal(res.status, 400);
    assert.match(res.data.error, /required/i);
  });
});

// =============================================================================
// CHALLENGE 4: POST /api/admin/repo/update (Mutex Concurrency, Dirty Tree Safety, Injection Defense)
// =============================================================================
describe('Challenge 4: POST /api/admin/repo/update verification & security stress tests', () => {
  let port;
  let serverInstance;
  let service;

  before(async () => {
    const s = createTestServer();
    serverInstance = s.server;
    service = s.service;
    port = await s.listen();
  });

  after(async () => {
    await new Promise((r) => serverInstance.close(r));
  });

  test('C4.1: F33.4 Mutex Concurrency: Concurrent trigger attempts return "Update already in progress" with HTTP 409', async () => {
    // Manually hold the mutex lock to simulate an ongoing update
    service.isUpdatingRepo = true;

    try {
      const res = await apiRequest(port, 'POST', '/api/admin/repo/update', {});
      assert.equal(res.status, 409, 'Concurrent update must return HTTP 409 Conflict');
      assert.equal(res.data.success, false);
      assert.equal(res.data.error, 'Update already in progress');

      // Unit check
      const unitRes = service.triggerRepoUpdate();
      assert.equal(unitRes.success, false);
      assert.equal(unitRes.error, 'Update already in progress');
    } finally {
      service.isUpdatingRepo = false;
    }
  });

  test('C4.2: F33.B2 Dirty Working Tree: Uncommitted changes cause immediate safe rejection before pull', async () => {
    // Simulation with dirty flag options
    const resDirty1 = service.triggerRepoUpdate({ isDirty: true });
    assert.equal(resDirty1.success, false);
    assert.equal(resDirty1.error, 'Working tree dirty. Fast-forward aborted.');
    assert.ok(resDirty1.executedAt);

    const resDirty2 = service.triggerRepoUpdate({ dirtyTree: true });
    assert.equal(resDirty2.success, false);
    assert.equal(resDirty2.error, 'Working tree dirty. Fast-forward aborted.');

    // HTTP endpoint test
    const httpRes = await apiRequest(port, 'POST', '/api/admin/repo/update', { isDirty: true });
    assert.equal(httpRes.status, 400);
    assert.equal(httpRes.data.success, false);
    assert.equal(httpRes.data.error, 'Working tree dirty. Fast-forward aborted.');
  });

  test('C4.3: Command Execution Safety: Zero command injection vulnerability via execFileSync parameter isolation', () => {
    // The implementation uses execFileSync('git', ['pull', '--ff-only', 'origin', branch], ...)
    // Test that shell metacharacters in branch parameter are safely isolated as literal arguments
    const maliciousPayloads = [
      '; cat /etc/passwd #',
      '&& rm -rf .',
      '| calc.exe',
      '`whoami`',
      '$(id)',
      'main\nrm -rf /',
    ];

    for (const payload of maliciousPayloads) {
      // In real git mode, passing malicious branch should fail gracefully at git ref lookup without executing shell commands
      const res = service.triggerRepoUpdate({
        executeRealGit: true,
        branch: payload,
      });

      assert.equal(res.success, false);
      assert.ok(res.error || res.output);
      // Ensure the command recorded is safely quoted/represented and does not escape git
      assert.ok(res.command.startsWith('git pull --ff-only origin'));
      assert.equal(service.isUpdatingRepo, false, 'Mutex must always be released in finally block');
    }
  });

  test('C4.4: Safe fast-forward oracle mode returns valid command, output, and ISO timestamp', async () => {
    const res = await apiRequest(port, 'POST', '/api/admin/repo/update', {});
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.ok(res.data.command.includes('git pull --ff-only'));
    assert.equal(res.data.output, 'Already up to date.');
    assert.ok(res.data.executedAt);
    assert.ok(new Date(res.data.executedAt).getTime() <= Date.now());
  });
});

// =============================================================================
// CHALLENGE 5: Simulation 4 (Full Admin Dashboard Operations & Live Recovery)
// =============================================================================
describe('Challenge 5: Simulation 4 E2E Orchestration', () => {
  test('C5.1: Simulation 4 executes complete operational lifecycle seamlessly', () => {
    const runner = new StealthBrowserRunner();
    const service = new AdminDashboardService(runner);

    // 1. Check task monitor lists running and queued tasks
    const initialTasks = service.getTasks();
    assert.equal(initialTasks.running.length, 1);
    assert.equal(initialTasks.queued.length, 2);
    assert.equal(initialTasks.running[0].status, 'running');
    assert.equal(initialTasks.queued[0].status, 'queued');

    // 2. Reorder task priorities (bring TikTok probes to priority 1)
    const reorderRes = service.reorderTasks(['task-2', 'task-1', 'task-3']);
    assert.equal(reorderRes.success, true);
    assert.equal(service.tasks[0].id, 'task-2');
    assert.equal(service.tasks[0].priority, 1);
    assert.equal(service.tasks[1].id, 'task-1');
    assert.equal(service.tasks[1].priority, 2);
    assert.equal(service.tasks[2].id, 'task-3');
    assert.equal(service.tasks[2].priority, 3);

    // 3. Toggle task enabled/disabled
    service.toggleTask('task-1', false);
    const disabledTask = service.tasks.find((t) => t.id === 'task-1');
    assert.equal(disabledTask.enabled, false);
    assert.equal(disabledTask.status, 'running', 'In-flight task finishes current run');

    service.toggleTask('task-1', true);
    assert.equal(disabledTask.enabled, true);

    // 4. Trigger repo auto-update
    const updateRes = service.triggerRepoUpdate();
    assert.equal(updateRes.success, true);
    assert.ok(updateRes.command.includes('git pull --ff-only'));
    assert.equal(updateRes.output, 'Already up to date.');
    assert.ok(updateRes.executedAt);
    assert.ok(!isNaN(Date.parse(updateRes.executedAt)));
  });
});
