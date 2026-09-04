const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'http://localhost:20129';
const DB_PATH = path.resolve(__dirname, '..', 'data', 'collector.db');

async function apiFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(options.timeout || 30000),
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const ct = res.headers.get('content-type') || '';
  let body = null;
  if (ct.includes('json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }
  return { status: res.status, ok: res.ok, headers: res.headers, body };
}

async function main() {
  console.log('==================================================');
  console.log('STARTING UI-13 / MULTI-RUN CONCURRENCY VALIDATION');
  console.log('==================================================');

  // Baseline DB state
  const rawDb = new Database(DB_PATH, { readonly: true });
  const legacyCountBefore = rawDb.prepare('SELECT COUNT(1) c FROM snapshots').get().c;
  const currentCountBefore = rawDb.prepare('SELECT COUNT(1) c FROM product_current').get().c;
  const historyRowsBefore = rawDb.prepare('SELECT COUNT(1) c FROM daily_packed_history').get().c;
  const obsSumBefore = rawDb.prepare('SELECT SUM(observation_count) c FROM daily_packed_history').get().c || 0;
  rawDb.close();

  console.log(`[Baseline DB] Legacy snapshots: ${legacyCountBefore}, Product current: ${currentCountBefore}, History rows: ${historyRowsBefore}, Total observations: ${obsSumBefore}`);

  // TEST 1: Send 4 runs concurrently
  console.log('\n[TEST 1] Dispatching 4 Shopify runs concurrently via POST /api/runs...');
  const payload = {
    platform: 'shopify',
    query: 'https://colourpop.com',
    maxItems: 20
  };

  const startTime = Date.now();
  const dispatchPromises = [
    apiFetch('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
    apiFetch('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
    apiFetch('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
    apiFetch('/api/runs', { method: 'POST', body: JSON.stringify(payload) })
  ];

  const dispatchResults = await Promise.all(dispatchPromises);
  const createdRuns = dispatchResults.map(r => r.body);

  console.log('Created runs response:', createdRuns.map(r => ({ id: r.id, status: r.status })));

  const runIds = createdRuns.map(r => r.id);
  const [runA, runB, runC, runD] = runIds;

  // Poll state samples to observe concurrency & queue lifecycle
  console.log('\n[TEST 2 & 3] Sampling scheduler & run states every 150ms...');
  const timeline = [];
  const startPoll = Date.now();
  let allDone = false;

  while (Date.now() - startPoll < 30000) {
    const elapsed = Date.now() - startTime;
    const [schedRes, runDetails] = await Promise.all([
      apiFetch('/api/scheduler/status'),
      Promise.all(runIds.map(id => apiFetch(`/api/runs/${id}`)))
    ]);

    const statuses = runDetails.map(r => ({ id: r.body?.id, status: r.body?.status, started_at: r.body?.started_at, completed_at: r.body?.completed_at }));
    const schedState = schedRes.body?.pools?.LOCAL || {};

    timeline.push({
      elapsedMs: elapsed,
      statuses,
      localPool: { active: schedState.active, max: schedState.max, queued: schedRes.body?.queue?.length }
    });

    if (statuses.every(s => ['done', 'failed', 'stopped'].includes(s.status))) {
      allDone = true;
      break;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`Sampling finished in ${Date.now() - startPoll}ms. All done: ${allDone}`);

  // Fetch final details of the 4 runs from DB
  const db = new Database(DB_PATH, { readonly: true });
  const finalRuns = runIds.map(id => db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
  
  console.log('\n==================================================');
  console.log('FINAL RUN DETAILS FOR RUNS A, B, C, D:');
  console.log('==================================================');
  for (let i = 0; i < finalRuns.length; i++) {
    const r = finalRuns[i];
    const letter = ['A', 'B', 'C', 'D'][i];
    const options = typeof r.input_options === 'string' ? JSON.parse(r.input_options || '{}') : (r.options || {});
    const items = r.result_items_json ? JSON.parse(r.result_items_json) : [];
    console.log(`Run ${letter} (ID: ${r.id}):`);
    console.log(`  - Platform: ${r.platform}`);
    console.log(`  - Query: ${r.query}`);
    console.log(`  - Status: ${r.status}`);
    console.log(`  - Execution Class: ${r.execution_class || 'LOCAL'}`);
    console.log(`  - Execution Token: ${options.executionToken || 'none'}`);
    console.log(`  - Created At: ${r.created_at}`);
    console.log(`  - Started At: ${r.started_at}`);
    console.log(`  - Completed At: ${r.completed_at}`);
    console.log(`  - Item Count: ${items.length}`);
  }

  // TEST 4: Database integrity & observation checks
  console.log('\n==================================================');
  console.log('DB VALIDATION CHECKS:');
  console.log('==================================================');
  const integrity = db.pragma('integrity_check');
  const legacyCountAfter = db.prepare('SELECT COUNT(1) c FROM snapshots').get().c;
  const currentCountAfter = db.prepare('SELECT COUNT(1) c FROM product_current').get().c;
  const historyRowsAfter = db.prepare('SELECT COUNT(1) c FROM daily_packed_history').get().c;
  const obsSumAfter = db.prepare('SELECT SUM(observation_count) c FROM daily_packed_history').get().c || 0;

  let totalObsIds = new Set();
  let duplicateObs = 0;
  let malformedObs = 0;
  for (const row of db.prepare('SELECT observations_json FROM daily_packed_history').iterate()) {
    try {
      const arr = JSON.parse(row.observations_json);
      for (const o of arr) {
        if (!o || !o.observationId) { malformedObs++; continue; }
        if (totalObsIds.has(o.observationId)) { duplicateObs++; }
        else { totalObsIds.add(o.observationId); }
      }
    } catch { malformedObs++; }
  }
  db.close();

  console.log(`- PRAGMA integrity_check: ${integrity[0].integrity_check}`);
  console.log(`- Legacy snapshots count: ${legacyCountBefore} -> ${legacyCountAfter} (Delta: ${legacyCountAfter - legacyCountBefore})`);
  console.log(`- Product current rows: ${currentCountAfter}`);
  console.log(`- Daily packed history rows: ${historyRowsAfter}`);
  console.log(`- Total observations sum: ${obsSumAfter} (Unique IDs: ${totalObsIds.size})`);
  console.log(`- Duplicate observations: ${duplicateObs}`);
  console.log(`- Malformed observations: ${malformedObs}`);

  // TEST 5: Jobs History Visibility
  console.log('\n==================================================');
  console.log('JOBS HISTORY (GET /api/runs) VISIBILITY:');
  console.log('==================================================');
  const jobsRes = await apiFetch('/api/runs?limit=20');
  const jobsList = Array.isArray(jobsRes.body) ? jobsRes.body : [];
  const foundInJobs = runIds.map(id => jobsList.find(j => j.id === id));

  console.log('Found all 4 runs in Jobs History:', foundInJobs.every(Boolean));
  for (let i = 0; i < foundInJobs.length; i++) {
    const j = foundInJobs[i];
    const letter = ['A', 'B', 'C', 'D'][i];
    console.log(`- Run ${letter} (#${j?.id}): status=${j?.status}, platform=${j?.platform}, query=${j?.query}, items=${j?.item_count}`);
  }

  // Summary object
  const report = {
    test: 'UI-13 / MULTI-RUN CONCURRENCY VALIDATION',
    pass: allDone &&
          runIds.length === 4 &&
          new Set(runIds).size === 4 &&
          finalRuns.every(r => r.status === 'done') &&
          legacyCountAfter === legacyCountBefore &&
          duplicateObs === 0 &&
          malformedObs === 0 &&
          foundInJobs.every(Boolean),
    runIds: { A: runA, B: runB, C: runC, D: runD },
    finalRuns,
    timeline,
    db: {
      integrity: integrity[0].integrity_check,
      legacySnapshotsBefore: legacyCountBefore,
      legacySnapshotsAfter: legacyCountAfter,
      currentCount: currentCountAfter,
      historyRows: historyRowsAfter,
      totalObservations: obsSumAfter,
      duplicateObservations: duplicateObs,
      malformedObservations: malformedObs
    },
    jobsHistory: foundInJobs
  };

  fs.writeFileSync(path.resolve(__dirname, '..', 'data', 'ui13_test_result.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nSaved full UI-13 results to data/ui13_test_result.json');
}

main().catch(err => {
  console.error('FATAL IN UI-13 TEST:', err);
  process.exit(1);
});

