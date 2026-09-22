process.env.PG_MODE = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeScheduleInput } = require('../src/marketplaces/capture-scheduler');
const { buildCollectionOptions } = require('../src/collection-inputs');
const { ResourceScheduler } = require('../src/scheduler/scheduler');

test('normalizeScheduleInput parses and normalizes comma and newline separated keywords', () => {
  const result = normalizeScheduleInput({
    platform: 'etsy',
    keyword: 'áo thun, cốc sứ\n túi vải ,  áo thun ',
    maxListings: 25,
  });

  assert.equal(result.platform, 'etsy');
  assert.equal(result.maxListings, 25);
  // Case-insensitive deduplicated, comma-separated normalized string
  assert.equal(result.keyword, 'áo thun, cốc sứ, túi vải');
});

test('normalizeScheduleInput allows multiple keywords with total length exceeding old 200 character limit', () => {
  const manyKeywords = Array.from({ length: 20 }, (_, i) => `vintage-item-keyword-number-${i}`).join(', ');
  assert.ok(manyKeywords.length > 200, 'input string must be longer than 200 chars');

  const result = normalizeScheduleInput({
    platform: 'etsy',
    keyword: manyKeywords,
    maxListings: 30,
  });
  assert.ok(result.keyword.length > 200);
});

test('Schedule dispatch simulation: a multi-keyword schedule fans out to N child runs with full maxItems each', async () => {
  const runs = new Map();
  let nextId = 1;
  const mockDb = {
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
        if (k === 'itemsCount') run.items_count = v;
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

  const dispatched = [];
  const scheduler = new ResourceScheduler({
    database: mockDb,
    poolOptions: { localConcurrency: 4 },
    planner: {
      plan: async (run) => {
        const options = JSON.parse(run.input_options || '{}');
        return {
          platform: run.platform, backend: 'local', mode: 'default', pool: 'LOCAL',
          estimatedEnvelopeMB: 50, shardCount: 1, jobKind: 'channel',
          maxItems: Number(options.maxItems || run.max_items || 30), options
        };
      }
    },
    executeRun: async (runId, platform, query, options) => {
      dispatched.push({ runId, query, maxItems: options.maxItems });
      mockDb.updateRun(runId, { status: 'done', items_count: 10 });
    }
  });

  // Simulate what dispatchScheduleExecution does
  const schedule = {
    id: 99,
    platform: 'etsy',
    keyword: 'hoodie, mug, poster',
    max_listings: 30,
    country: 'US',
  };

  const normalizedOptions = buildCollectionOptions(schedule.platform, {
    maxItems: schedule.max_listings,
    country: schedule.country,
    query: schedule.keyword,
  });

  assert.deepEqual(normalizedOptions.keywords, ['hoodie', 'mug', 'poster']);

  const parentRun = mockDb.createRun({
    platform: schedule.platform,
    query: normalizedOptions.keywords.join(' | '),
    maxItems: schedule.max_listings,
    country: schedule.country,
    options: normalizedOptions,
  });

  await scheduler.submitRun(parentRun);
  await scheduler.tick(); // fan-out

  const children = mockDb.getChildRuns(parentRun.id);
  assert.equal(children.length, 3, '3 child runs should be created for 3 keywords');
  assert.deepEqual(children.map((c) => c.query), ['hoodie', 'mug', 'poster']);
  assert.deepEqual(children.map((c) => c.max_items), [30, 30, 30], 'each child run receives initial maxItems of 30');

  await scheduler.tick(); // dispatch children
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(dispatched.length, 3);
  assert.deepEqual(dispatched.map((d) => d.maxItems), [30, 30, 30]);

  await scheduler.tick(); // reconcile
  const parentFinal = mockDb.getRunById(parentRun.id);
  assert.equal(parentFinal.status, 'done');
  assert.equal(parentFinal.items_count, 30);
});
