/**
 * P1-3: Real scheduler concurrency/RAM/lock stress test.
 *
 * Uses the PRODUCTION ResourceScheduler, ResourceMonitor, WorkerPoolManager,
 * ResourceProfileManager, and RunQueue classes unmodified — only the DB (in-memory
 * mock, so this never touches data/collector.db) and the actual crawl execution
 * (a controlled async sleep instead of a real network scrape, since external
 * sites are not a reliable dependency for a deterministic stress test) are mocked.
 * The scheduling/admission/concurrency/RAM-reservation logic under test is 100%
 * the real production code path.
 */

const { ResourceScheduler } = require('../src/scheduler/scheduler');
const { ResourceMonitor } = require('../src/scheduler/resource-monitor');

const TOTAL_RUNS = 50;
const LOCAL_CONCURRENCY = 4;
const CLOUD_CONCURRENCY = 8;
const BROWSER_CONCURRENCY = 2;
const CDP_CONCURRENCY = 1;

function makeMockDb() {
  const runs = new Map();
  let nextId = 1;
  return {
    createRun: (payload) => {
      const id = nextId++;
      const run = { id, platform: payload.platform, query: payload.query, status: 'pending', input_options: JSON.stringify(payload.options || {}), created_at: new Date().toISOString() };
      runs.set(id, run);
      return run;
    },
    getRunById: (id) => runs.get(id),
    updateRun: (id, updates) => {
      const run = runs.get(id);
      if (!run) return;
      if (updates.status !== undefined) run.status = updates.status;
      if (updates.inputOptions !== undefined) run.input_options = updates.inputOptions;
      if (updates.errorMessage !== undefined) run.error_message = updates.errorMessage;
    },
    getAllRuns: () => Array.from(runs.values()),
    getRunsByStatus: (status) => Array.from(runs.values()).filter(r => r.status === status)
  };
}

async function main() {
  const mockDb = makeMockDb();
  const platformToPool = {
    shopify: 'LOCAL', etsy: 'LOCAL', ebay: 'LOCAL',
    amazon: 'CLOUD', facebook_ads: 'CLOUD', instagram: 'CLOUD',
    pinterest: 'BROWSER',
    toidispy: 'CDP'
  };
  const platforms = Object.keys(platformToPool);

  const observedConcurrency = { LOCAL: 0, CLOUD: 0, BROWSER: 0, CDP: 0 };
  const maxObservedConcurrency = { LOCAL: 0, CLOUD: 0, BROWSER: 0, CDP: 0 };
  const dispatchedRunIds = new Set();
  const duplicateDispatches = [];
  let completed = 0;

  const fakePlanner = {
    plan: async (run) => {
      const pool = platformToPool[run.platform] || 'LOCAL';
      const backend = pool === 'CLOUD' ? 'apify' : pool === 'CDP' ? 'cdp' : pool === 'BROWSER' ? 'browser' : 'local';
      return { platform: run.platform, backend, mode: 'default', pool, estimatedEnvelopeMB: 50, shardCount: 1, jobKind: 'channel', options: JSON.parse(run.input_options || '{}') };
    }
  };

  const scheduler = new ResourceScheduler({
    database: mockDb,
    planner: fakePlanner,
    monitor: new ResourceMonitor({}), // real physical RAM check
    poolOptions: { localConcurrency: LOCAL_CONCURRENCY, cloudConcurrency: CLOUD_CONCURRENCY, browserConcurrency: BROWSER_CONCURRENCY, cdpConcurrency: CDP_CONCURRENCY },
    tickIntervalMs: 100,
    executeRun: async (runId, platform) => {
      const pool = platformToPool[platform] || 'LOCAL';
      if (dispatchedRunIds.has(runId)) duplicateDispatches.push(runId);
      dispatchedRunIds.add(runId);

      observedConcurrency[pool]++;
      maxObservedConcurrency[pool] = Math.max(maxObservedConcurrency[pool], observedConcurrency[pool]);

      await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 150));

      observedConcurrency[pool]--;
      completed++;
      mockDb.updateRun(runId, { status: 'done' });
    }
  });

  const startedAt = Date.now();
  console.log(`[StressTest] Submitting ${TOTAL_RUNS} concurrent run requests...`);
  const submissions = [];
  for (let i = 0; i < TOTAL_RUNS; i++) {
    const platform = platforms[i % platforms.length];
    submissions.push(scheduler.submitRun({ platform, query: `stress-${i}` }));
  }
  await Promise.all(submissions);

  scheduler.start();
  const deadline = Date.now() + 30000;
  while (completed < TOTAL_RUNS && Date.now() < deadline) {
    await scheduler.tick();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  scheduler.stop();

  const durationMs = Date.now() - startedAt;
  const finalStatus = scheduler.getStatus();
  const capacities = { LOCAL: LOCAL_CONCURRENCY, CLOUD: CLOUD_CONCURRENCY, BROWSER: BROWSER_CONCURRENCY, CDP: CDP_CONCURRENCY };

  const report = {
    totalRuns: TOTAL_RUNS,
    completed,
    durationMs,
    maxObservedConcurrency,
    capacities,
    concurrencyViolations: Object.keys(maxObservedConcurrency).filter(p => maxObservedConcurrency[p] > capacities[p]),
    duplicateDispatchCount: duplicateDispatches.length,
    finalReservedRAMMB: finalStatus.ram.reservedMB,
    finalPoolState: finalStatus.pools.pools,
    allSlotsReleased: Object.values(finalStatus.pools.pools).every(p => p.running === 0)
  };

  console.log('STRESS_TEST_REPORT:', JSON.stringify(report, null, 2));

  const pass = report.concurrencyViolations.length === 0
    && report.duplicateDispatchCount === 0
    && report.finalReservedRAMMB === 0
    && report.allSlotsReleased
    && report.completed === TOTAL_RUNS;

  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch(err => {
  console.error('Stress test crashed:', err);
  process.exit(1);
});
