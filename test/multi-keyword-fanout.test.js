/**
 * TASK-2 — multi-keyword crawl fan-out.
 *
 * Contract under test:
 *   N keywords submitted in ONE crawl request become N independent Tasks
 *   (§4: "Task = đơn vị công việc độc lập bên trong Run ... ví dụ ... query"),
 *   fanned out as one child Run per keyword through the EXISTING parent/child +
 *   worker-pool machinery. No new concurrency mechanism, no raised limits:
 *   each child is admitted by the same WorkerPoolManager capacities and the
 *   same ResourceMonitor RAM reservation as any single-keyword run.
 *
 * These tests use the same in-memory mock database shape as
 * test/scheduler.test.js. Nothing here touches PGlite or the live server.
 */

process.env.PG_MODE = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ResourceScheduler } = require('../src/scheduler/scheduler');
const { ExecutionPlanner } = require('../src/scheduler/execution-planner');
const { needsKeywordFanOut, planKeywordTasks, needsSharding } = require('../src/scheduler/job-sharder');
const { parseKeywordList, buildCollectionOptions, MAX_CRAWL_KEYWORDS } = require('../src/collection-inputs');

// ==================== Input parsing (src/collection-inputs.js) ====================

test('parseKeywordList splits on BOTH lines and commas into distinct keywords', () => {
  const { keywords } = parseKeywordList('press on nails, short square\nnail glue\n  gel tips  ');
  assert.deepEqual(keywords, ['press on nails', 'short square', 'nail glue', 'gel tips']);
});

test('parseKeywordList handles comma-separated list on a single line', () => {
  const { keywords } = parseKeywordList('áo thun, cốc sứ, túi vải');
  assert.deepEqual(keywords, ['áo thun', 'cốc sứ', 'túi vải']);
});

test('parseKeywordList handles mixed commas, consecutive newlines and extra spaces', () => {
  const { keywords } = parseKeywordList('  a, b , , c\n\n d , e \n');
  assert.deepEqual(keywords, ['a', 'b', 'c', 'd', 'e']);
});

test('parseKeywordList drops blank lines and case-insensitive duplicates, reporting what it dropped', () => {
  const { keywords, duplicates } = parseKeywordList('nail glue\n\n ,  \nNail Glue, gel tips\n');
  assert.deepEqual(keywords, ['nail glue', 'gel tips']);
  assert.deepEqual(duplicates, ['Nail Glue'], 'a dropped duplicate must be reported, never silently swallowed');
});

test('parseKeywordList refuses empty input and over-limit input with a named reason (no silent rejection)', () => {
  assert.throws(() => parseKeywordList('   \n\n ,  '), /at least one keyword/i);
  const tooMany = Array.from({ length: MAX_CRAWL_KEYWORDS + 1 }, (_v, i) => `kw${i}`).join(',');
  assert.throws(() => parseKeywordList(tooMany), new RegExp(`Too many keywords: ${MAX_CRAWL_KEYWORDS + 1}`));
});

test('buildCollectionOptions whitelists `keywords` so the fan-out instruction survives to the Scheduler', () => {
  const options = buildCollectionOptions('etsy', { maxItems: 20, keywords: ['a', 'b', 'c'] });
  assert.deepEqual(options.keywords, ['a', 'b', 'c'], 'keywords must NOT be dropped by the option whitelist');
  assert.equal(options.maxItems, 20);
});

test('buildCollectionOptions automatically extracts keywords from query when query contains commas or newlines', () => {
  const options = buildCollectionOptions('etsy', { maxItems: 20, query: 'vintage hoodie, custom mug\nposter' });
  assert.deepEqual(options.keywords, ['vintage hoodie', 'custom mug', 'poster']);
  assert.equal(options.maxItems, 20);
});

test('buildCollectionOptions emits NO `keywords` key for a single keyword query or input', () => {
  const before = buildCollectionOptions('etsy', { maxItems: 20 });
  const single = buildCollectionOptions('etsy', { maxItems: 20, keywords: ['only one'] });
  const singleQuery = buildCollectionOptions('etsy', { maxItems: 20, query: 'only one' });
  assert.equal('keywords' in single, false, 'one keyword must produce the exact pre-change option shape');
  assert.equal('keywords' in singleQuery, false, 'single query must produce no keywords key');
  assert.deepEqual(single, before);
  assert.deepEqual(singleQuery, before);
});

test('buildCollectionOptions rejects an all-blank keyword list instead of silently crawling nothing', () => {
  assert.throws(() => buildCollectionOptions('etsy', { maxItems: 20, keywords: ['', '   ', ','] }), /at least one keyword/i);
});

// ==================== Task planning (src/scheduler/job-sharder.js) ====================

test('needsKeywordFanOut only fires for 2+ keywords', () => {
  assert.equal(needsKeywordFanOut({ options: { keywords: ['a', 'b'] } }), true);
  assert.equal(needsKeywordFanOut({ options: { keywords: ['a'] } }), false);
  assert.equal(needsKeywordFanOut({ options: {} }), false);
  assert.equal(needsKeywordFanOut({}), false);
});

// Rules §5.4: maxItems semantics must be stated, not left ambiguous.
test('planKeywordTasks gives each keyword the FULL maxItems (per keyword), never maxItems/N (§5.4)', () => {
  const tasks = planKeywordTasks({ max_items: 20 }, { maxItems: 20, options: { keywords: ['a', 'b', 'c'] } });
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.maxItems), [20, 20, 20], 'keywords are different result sets; there is nothing to partition');
  assert.deepEqual(tasks.map((t) => t.keyword), ['a', 'b', 'c']);
  assert.deepEqual(tasks.map((t) => t.keywordIndex), [0, 1, 2]);
  assert.equal(tasks[0].keywordCount, 3);
});

// ==================== Scheduler fan-out ====================

function makeMockDb() {
  const runs = new Map();
  let nextId = 1;
  return {
    createRun: (payload) => {
      const id = nextId++;
      const run = {
        id, platform: payload.platform, query: payload.query, status: 'pending',
        max_items: payload.maxItems, country: payload.country || null,
        input_options: JSON.stringify(payload.options || {}),
        parent_run_id: payload.parentRunId || null, created_at: new Date().toISOString(),
        items_count: 0, new_count: 0, active_count: 0, dropped_count: 0
      };
      runs.set(id, run);
      return run;
    },
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => {
      const run = runs.get(id);
      if (!run) return;
      for (const [k, v] of Object.entries(updates)) {
        if (k === 'inputOptions') run.input_options = v;
        else if (k === 'itemsCount') run.items_count = v;
        else if (k === 'newCount') run.new_count = v;
        else if (k === 'activeCount') run.active_count = v;
        else if (k === 'droppedCount') run.dropped_count = v;
        else if (k === 'errorMessage') run.error_message = v;
        else run[k] = v;
      }
    },
    getAllRuns: () => Array.from(runs.values()),
    getRunsByStatus: (status) => Array.from(runs.values()).filter((r) => r.status === status),
    getChildRuns: (parentId) => Array.from(runs.values()).filter((r) => r.parent_run_id === parentId)
  };
}

function passthroughPlanner() {
  return {
    plan: async (run) => {
      const options = JSON.parse(run.input_options || '{}');
      return {
        platform: run.platform, backend: 'local', mode: 'default', pool: 'LOCAL',
        estimatedEnvelopeMB: 50, shardCount: 1, jobKind: 'channel',
        maxItems: Number(options.maxItems || run.max_items || 100), options
      };
    }
  };
}

test('Scheduler splits a 3-keyword run into 3 child runs — one keyword per child — and parks the parent', async () => {
  const mockDb = makeMockDb();
  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 4, elasticPools: [] },
    planner: passthroughPlanner(),
    executeRun: async (runId, platform, query, options) => {
      dispatched.push({ runId, query, maxItems: options.maxItems, keyword: options.keyword });
      mockDb.updateRun(runId, { status: 'done', itemsCount: 7 });
    }
  });

  const parent = await scheduler.submitRun({
    platform: 'etsy', query: 'nail glue',
    options: { maxItems: 20, keywords: ['nail glue', 'gel tips', 'press on nails'] }
  });

  await scheduler.tick(); // fan-out
  assert.equal(mockDb.getRunById(parent.id).status, 'sharded', 'parent must be parked, never executed itself');
  assert.equal(dispatched.length, 0, 'the parent run must NOT be dispatched to a worker');

  const children = mockDb.getChildRuns(parent.id);
  assert.equal(children.length, 3, 'one child run per keyword');
  assert.deepEqual(children.map((c) => c.query), ['nail glue', 'gel tips', 'press on nails']);
  assert.deepEqual(children.map((c) => c.max_items), [20, 20, 20], 'maxItems is per keyword (§5.4)');

  for (const child of children) {
    const opts = JSON.parse(child.input_options);
    assert.equal('keywords' in opts, false, 'a child must NOT carry `keywords` — otherwise it would fan out again (unbounded nesting)');
    assert.equal(opts.keywordCount, 3);
    assert.equal(typeof opts.keyword, 'string');
  }

  await scheduler.tick(); // admit + dispatch the 3 children
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(dispatched.map((d) => d.query).sort(), ['gel tips', 'nail glue', 'press on nails']);
  assert.deepEqual(dispatched.map((d) => d.maxItems), [20, 20, 20], 'each worker crawls its own keyword with the full item budget');

  await scheduler.tick(); // reconcile parent
  const parentFinal = mockDb.getRunById(parent.id);
  assert.equal(parentFinal.status, 'done');
  assert.equal(parentFinal.items_count, 21, '3 keyword tasks x 7 items aggregated onto the parent');
  assert.equal(scheduler.monitor.getReservedTotalMB(), 0, 'every child must release its RAM reservation');
});

test('Scheduler does NOT fan out a single-keyword run — it executes directly, exactly as before', async () => {
  const mockDb = makeMockDb();
  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 4, elasticPools: [] },
    planner: passthroughPlanner(),
    executeRun: async (runId, platform, query) => {
      dispatched.push({ runId, query });
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  const run = await scheduler.submitRun({ platform: 'etsy', query: 'nail glue', options: { maxItems: 20 } });
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(mockDb.getChildRuns(run.id).length, 0, 'no child runs for a single keyword');
  assert.deepEqual(dispatched, [{ runId: run.id, query: 'nail glue' }]);
});

// The user's constraint: reuse the EXISTING worker-division rules. N keywords
// must NOT buy N guaranteed workers — they queue for the same pool slots.
test('Keyword tasks obey the EXISTING per-pool worker limits — 3 keywords do not get 3 workers when the pool has 1 slot', async () => {
  const mockDb = makeMockDb();
  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 1, elasticPools: [] }, // strict single LOCAL worker
    planner: passthroughPlanner(),
    executeRun: async (runId) => {
      dispatched.push(runId);
      await new Promise((r) => setTimeout(r, 200)); // still occupying the slot
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  const parent = await scheduler.submitRun({
    platform: 'etsy', query: 'a', options: { maxItems: 20, keywords: ['a', 'b', 'c'] }
  });

  await scheduler.tick(); // fan-out
  await scheduler.tick(); // admission attempt for all 3 children
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(dispatched.length, 1, 'only one keyword task may hold the single LOCAL slot');
  assert.equal(scheduler.pools.getStatus().pools.LOCAL.running, 1, 'pool capacity must not be raised by keyword fan-out');
  // Child runs are created straight through db.createRun (exactly like size
  // shards), so they sit at the 'pending' end of the same queue the scheduler
  // peeks — getQueuedRuns() selects status IN ('queued','pending').
  const counts = await scheduler.queue.countByStatus();
  assert.equal(counts.pending + counts.queued, 2, 'the other two keyword tasks wait in the queue, they do not open extra workers');
  assert.equal(mockDb.getChildRuns(parent.id).length, 3);
});

test('Keyword tasks obey the EXISTING RAM admission — a child that does not fit stays queued', async () => {
  const mockDb = makeMockDb();
  const { ResourceMonitor } = require('../src/scheduler/resource-monitor');
  // Headroom 1200MB, 500MB per run -> exactly 2 keyword tasks fit, the 3rd must wait.
  const monitor = new ResourceMonitor({
    fixedPhysicalSnapshot: {
      timestamp: new Date().toISOString(), state: 'GREEN', totalMB: 10000, usedMB: 5000, freeMB: 5000,
      usedPercent: 50, mandatoryReserveMB: 3800, usableHeadroomMB: 1200, process: { rssMB: 100, heapUsedMB: 50 }
    }
  });

  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    monitor,
    planner: {
      plan: async (run) => {
        const options = JSON.parse(run.input_options || '{}');
        return {
          platform: run.platform, backend: 'local', mode: 'default', pool: 'LOCAL',
          estimatedEnvelopeMB: 500, shardCount: 1, jobKind: 'channel',
          maxItems: Number(options.maxItems || 100), options
        };
      }
    },
    executeRun: async (runId) => {
      dispatched.push(runId);
      await new Promise((r) => setTimeout(r, 300));
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  await scheduler.submitRun({ platform: 'etsy', query: 'a', options: { maxItems: 20, keywords: ['a', 'b', 'c'] } });
  await scheduler.tick(); // fan-out
  await scheduler.tick(); // admission
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(dispatched.length, 2, 'RAM headroom, not keyword count, decides how many keyword tasks run at once');
  assert.equal(scheduler.monitor.getReservedTotalMB(), 1000);
});

// Interaction with the pre-existing size-based sharding: fan-out first, then
// each keyword child may size-shard exactly like a single-keyword run would.
// Nesting must stop there.
test('Keyword fan-out happens BEFORE size sharding, and a keyword child can never fan out again (bounded nesting)', async () => {
  const mockDb = makeMockDb();
  const planner = new ExecutionPlanner({ router: { selectBackend: async () => ({ adapter: {}, config: { kind: 'local', name: 'local-scraper' } }) } });
  planner.channelSupportsSharding = () => true; // every real channel declares false today; force it on to exercise the interaction

  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 8 },
    planner,
    executeRun: async (runId, platform, query) => {
      dispatched.push({ runId, query });
      mockDb.updateRun(runId, { status: 'done', itemsCount: 5 });
    }
  });

  const parent = await scheduler.submitRun({
    platform: 'etsy', query: 'a',
    options: { maxItems: 250, shardSize: 100, keywords: ['alpha', 'beta'] }
  });

  await scheduler.tick(); // keyword fan-out (NOT size sharding) must run first
  const keywordChildren = mockDb.getChildRuns(parent.id);
  assert.equal(keywordChildren.length, 2, 'the parent splits by keyword first, not into size shards');
  assert.deepEqual(keywordChildren.map((c) => c.query), ['alpha', 'beta']);
  assert.deepEqual(keywordChildren.map((c) => c.max_items), [250, 250], 'each keyword keeps the full maxItems budget');

  await scheduler.tick(); // each keyword child now size-shards on its own
  for (const child of keywordChildren) {
    assert.equal(mockDb.getRunById(child.id).status, 'sharded');
    const grandChildren = mockDb.getChildRuns(child.id);
    assert.equal(grandChildren.length, 3, '250 items / shardSize 100 = 3 shards per keyword, same as a single-keyword run');
    for (const grandChild of grandChildren) {
      assert.equal(grandChild.query, child.query, 'a size shard keeps its keyword');
      assert.equal('keywords' in JSON.parse(grandChild.input_options), false, 'nesting must stop: a shard of a keyword child cannot fan out again');
    }
  }

  // 2 keywords x 3 shards = 6 leaf executions — exactly what submitting these
  // two keywords as separate crawls would produce, not a new multiplier.
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dispatched.length, 6);
  assert.deepEqual(dispatched.filter((d) => d.query === 'alpha').length, 3);

  await scheduler.tick(); // reconcile keyword children
  await scheduler.tick(); // reconcile the top parent
  const parentFinal = mockDb.getRunById(parent.id);
  assert.equal(parentFinal.status, 'done');
  assert.equal(parentFinal.items_count, 30, '6 leaf executions x 5 items rolled up through both levels');
});

test('A fully failed keyword parent reports "keyword tasks", while a size-shard parent keeps its existing "shards" wording', async () => {
  const mockDb = makeMockDb();
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 4 },
    planner: passthroughPlanner(),
    executeRun: async (runId) => { mockDb.updateRun(runId, { status: 'failed' }); }
  });

  const keywordParent = await scheduler.submitRun({ platform: 'etsy', query: 'a', options: { maxItems: 20, keywords: ['a', 'b'] } });
  await scheduler.tick();
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 30));
  await scheduler.tick();

  const finalParent = mockDb.getRunById(keywordParent.id);
  assert.equal(finalParent.status, 'failed');
  assert.equal(finalParent.error_message, 'All 2 keyword tasks failed');
  assert.equal(scheduler.isKeywordFanOutParent(finalParent), true);

  // A size-shard parent must be described exactly as before this change.
  const shardParent = mockDb.createRun({ platform: 'etsy', query: 'x', maxItems: 250, options: { maxItems: 250 } });
  assert.equal(scheduler.isKeywordFanOutParent(shardParent), false);
  assert.equal(needsSharding({ shardCount: 3 }), true, 'size-based sharding is untouched');
});
