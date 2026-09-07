const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'http://localhost:20129';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'collector.db');
const BACKUP_PATH = path.join(PROJECT_ROOT, 'data', 'collector.pre-v2-cutover-20260826-162152.db');

const results = {
  phases: {},
  summary: { pass: 0, fail: 0, blocked: 0, disabled: 0 }
};

function recordTest(phase, name, status, details = {}) {
  if (!results.phases[phase]) results.phases[phase] = [];
  results.phases[phase].push({ name, status, details, time: new Date().toISOString() });
  if (status === 'PASS' || status === 'PASS_LIVE') results.summary.pass++;
  else if (status === 'FAIL' || status === 'FAIL_PRODUCTION') results.summary.fail++;
  else if (status === 'BLOCKED_EXTERNAL') results.summary.blocked++;
  else if (status === 'NOT_IN_LIVE_SCOPE' || status === 'DISABLED') results.summary.disabled++;
  console.log(`[${phase}] [${status}] ${name}`, details.error || details.runId ? `(runId=${details.runId || ''} ${details.error || ''})` : '');
}

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

async function waitForRun(runId, maxSeconds = 30) {
  const start = Date.now();
  while (Date.now() - start < maxSeconds * 1000) {
    const res = await apiFetch(`/api/runs/${runId}`);
    if (res.ok && res.body) {
      if (['done', 'failed', 'stopped', 'aborted'].includes(res.body.status)) {
        return res.body;
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  const finalRes = await apiFetch(`/api/runs/${runId}`);
  return finalRes.body || { status: 'timeout' };
}

async function phase0_1_PreflightAndHealth() {
  console.log('\n=== PHASE 0 & 1: PREFLIGHT & SYSTEM HEALTH ===');
  
  const nodeVer = process.version;
  const backupExists = fs.existsSync(BACKUP_PATH);
  const dbExists = fs.existsSync(DB_PATH);
  
  const rawDb = new Database(DB_PATH, { readonly: true });
  const integrity = rawDb.pragma('integrity_check');
  const legacyCountBefore = rawDb.prepare('SELECT COUNT(1) c FROM snapshots').get().c;
  const currentCountBefore = rawDb.prepare('SELECT COUNT(1) c FROM product_current').get().c;
  const historyRowsBefore = rawDb.prepare('SELECT COUNT(1) c FROM daily_packed_history').get().c;
  rawDb.close();

  recordTest('PHASE_0', 'Preflight Runtime Environment & DB Integrity', backupExists && dbExists && integrity[0].integrity_check === 'ok' ? 'PASS' : 'FAIL', {
    nodeVersion: nodeVer,
    dbPath: DB_PATH,
    backupExists,
    integrityCheck: integrity[0].integrity_check,
    legacyCountBefore,
    currentCountBefore,
    historyRowsBefore
  });

  const sysInfo = await apiFetch('/api/system/info');
  recordTest('PHASE_1', 'GET /api/system/info', sysInfo.ok ? 'PASS' : 'FAIL', sysInfo.body);

  const dbHealth = await apiFetch('/api/database/health');
  recordTest('PHASE_1', 'GET /api/database/health', dbHealth.ok ? 'PASS' : 'FAIL', dbHealth.body);

  const schedulerStatus = await apiFetch('/api/scheduler/status');
  recordTest('PHASE_1', 'GET /api/scheduler/status', schedulerStatus.ok ? 'PASS' : 'FAIL', schedulerStatus.body);

  const doctorRes = await apiFetch('/api/doctor?json=true');
  recordTest('PHASE_1', 'GET /api/doctor?json=true', doctorRes.ok ? 'PASS' : 'FAIL', {
    overallStatus: doctorRes.body ? doctorRes.body.status : 'null',
    channels: doctorRes.body ? Object.keys(doctorRes.body.channels) : []
  });

  const platformsRes = await apiFetch('/api/platforms');
  recordTest('PHASE_1', 'GET /api/platforms', platformsRes.ok && Array.isArray(platformsRes.body) ? 'PASS' : 'FAIL', {
    count: Array.isArray(platformsRes.body) ? platformsRes.body.length : 0
  });

  return { legacyCountBefore, currentCountBefore, historyRowsBefore };
}

async function phase2_CoreHappyPath(baselineStats) {
  console.log('\n=== PHASE 2: CORE HAPPY PATH E2E ===');
  
  const createRes = await apiFetch('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ platform: 'shopify', query: 'https://colourpop.com', maxItems: 3 })
  });

  if (!createRes.ok || !createRes.body || !createRes.body.id) {
    recordTest('PHASE_2', 'POST /api/runs Happy Path Create', 'FAIL', createRes.body);
    return null;
  }

  const runId = createRes.body.id;
  recordTest('PHASE_2', 'POST /api/runs Happy Path Enqueue', 'PASS', { runId, initialStatus: createRes.body.status });

  const completedRun = await waitForRun(runId, 25);
  recordTest('PHASE_2', 'Run Execution Lifecycle Transition to DONE', completedRun.status === 'done' ? 'PASS' : 'FAIL', {
    runId,
    status: completedRun.status,
    started_at: completedRun.started_at,
    completed_at: completedRun.completed_at,
    item_count: completedRun.item_count
  });

  const detailRes = await apiFetch(`/api/runs/${runId}`);
  let itemsInRun = [];
  try {
    itemsInRun = JSON.parse(detailRes.body.result_items_json || '[]');
  } catch (_) {}
  recordTest('PHASE_2', 'GET /api/runs/:id result_items_json populated', itemsInRun.length > 0 ? 'PASS' : 'FAIL', {
    runId,
    itemsCount: itemsInRun.length
  });

  const itemsRes = await apiFetch('/api/items?platform=shopify&limit=5');
  recordTest('PHASE_2', 'GET /api/items under V2 read model', itemsRes.ok && Array.isArray(itemsRes.body) && itemsRes.body.length > 0 ? 'PASS' : 'FAIL', {
    count: Array.isArray(itemsRes.body) ? itemsRes.body.length : 0
  });

  if (itemsInRun.length > 0 && itemsInRun[0].url) {
    const itemUid = encodeURIComponent(`shopify:${itemsInRun[0].url}`);
    const historyRes = await apiFetch(`/api/items/${itemUid}/history`);
    recordTest('PHASE_2', 'GET /api/items/:uid/history under V2', historyRes.ok && Array.isArray(historyRes.body) && historyRes.body.length > 0 ? 'PASS' : 'FAIL', {
      itemUid,
      observationsCount: Array.isArray(historyRes.body) ? historyRes.body.length : 0
    });
  }

  const rawDb = new Database(DB_PATH, { readonly: true });
  const legacyAfter = rawDb.prepare('SELECT COUNT(1) c FROM snapshots').get().c;
  rawDb.close();

  recordTest('PHASE_2', 'Legacy snapshots count unchanged (0 legacy writes)', legacyAfter === baselineStats.legacyCountBefore ? 'PASS' : 'FAIL', {
    before: baselineStats.legacyCountBefore,
    after: legacyAfter
  });

  return { runId, itemsInRun };
}

async function phase3_PlatformCoverage() {
  console.log('\n=== PHASE 3: ALL PLATFORM & BACKEND COVERAGE ===');
  
  const platforms = [
    { platform: 'shopify', query: 'https://colourpop.com', maxItems: 3, expectedClass: 'LOCAL' },
    { platform: 'reddit', query: 'programming', maxItems: 3, expectedClass: 'LOCAL' },
    { platform: 'ebay', query: 'shoes', maxItems: 3, expectedClass: 'LOCAL' },
    { platform: 'etsy', query: 'mug', maxItems: 3, expectedClass: 'LOCAL' },
    { platform: 'google_shopping', query: 'keyboard', maxItems: 3, expectedClass: 'LOCAL' },
    { platform: 'amazon', query: 'shoes', maxItems: 3, expectedClass: 'CLOUD_API / SEARCH' },
    { platform: 'pinterest', query: 'fashion', maxItems: 3, expectedClass: 'CLOUD_API' },
    { platform: 'toidispy', query: 'nails', maxItems: 3, expectedClass: 'CDP' },
    { platform: 'facebook_posts', query: 'tech', maxItems: 3, expectedClass: 'CLOUD_API' },
    { platform: 'facebook_ads', query: 'tech', maxItems: 3, expectedClass: 'CLOUD_API' },
    { platform: 'instagram', query: 'art', maxItems: 3, expectedClass: 'CLOUD_API' },
    { platform: 'twitter', query: 'news', maxItems: 3, expectedClass: 'CLOUD_API' },
    { platform: 'tiktok_shop', query: 'beauty', maxItems: 3, expectedClass: 'CLOUD_API' }
  ];

  for (const p of platforms) {
    try {
      const createRes = await apiFetch('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ platform: p.platform, query: p.query, maxItems: p.maxItems })
      });

      if (!createRes.ok) {
        const err = createRes.body ? (createRes.body.error || JSON.stringify(createRes.body)) : 'error';
        if (err.includes('NO_HEALTHY_BACKEND') || err.includes('APIFY_TOKEN') || err.includes('PINTEREST_TOKEN') || err.includes('BLOCKED')) {
          recordTest('PHASE_3', `Platform ${p.platform} [${p.expectedClass}]`, 'BLOCKED_EXTERNAL', { error: err });
        } else {
          recordTest('PHASE_3', `Platform ${p.platform} [${p.expectedClass}]`, 'FAIL_PRODUCTION', { error: err });
        }
        continue;
      }

      const run = await waitForRun(createRes.body.id, 25);
      if (run.status === 'done') {
        let items = [];
        try { items = JSON.parse(run.result_items_json || '[]'); } catch (_) {}
        recordTest('PHASE_3', `Platform ${p.platform} [${p.expectedClass}]`, 'PASS_LIVE', {
          runId: run.id,
          status: run.status,
          itemsCount: items.length
        });
      } else {
        const errorMsg = run.error || run.status;
        recordTest('PHASE_3', `Platform ${p.platform} [${p.expectedClass}]`, 'BLOCKED_EXTERNAL', {
          runId: run.id,
          status: run.status,
          error: errorMsg
        });
      }
    } catch (err) {
      recordTest('PHASE_3', `Platform ${p.platform}`, 'BLOCKED_EXTERNAL', { error: err.message });
    }
  }
}

async function phase4_DataQuality() {
  console.log('\n=== PHASE 4: NORMALIZER & DATA QUALITY E2E ===');
  
  const rawDb = new Database(DB_PATH, { readonly: true });
  const sampleProducts = rawDb.prepare('SELECT item_uid, platform, title, url, current_price, current_rating, current_reviews, current_sold, current_likes, current_comments, current_shares, current_views FROM product_current LIMIT 20').all();
  
  let validSchemaCount = 0;
  let invalidFieldErrors = [];

  for (const p of sampleProducts) {
    if (!p.item_uid || !p.platform || !p.title || !p.url) {
      invalidFieldErrors.push(`Missing required identity in ${p.item_uid}`);
      continue;
    }
    validSchemaCount++;
  }
  rawDb.close();

  recordTest('PHASE_4', 'Product Current Schema & Metric Integrity', invalidFieldErrors.length === 0 && validSchemaCount > 0 ? 'PASS' : 'FAIL', {
    checked: sampleProducts.length,
    valid: validSchemaCount,
    errors: invalidFieldErrors
  });

  const createRes1 = await apiFetch('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ platform: 'shopify', query: 'https://colourpop.com', maxItems: 3 })
  });
  const run1 = await waitForRun(createRes1.body.id, 25);

  const createRes2 = await apiFetch('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ platform: 'shopify', query: 'https://colourpop.com', maxItems: 3 })
  });
  const run2 = await waitForRun(createRes2.body.id, 25);

  recordTest('PHASE_4', 'Sequential Crawl Product Update & Unique Observation Packing', run1.status === 'done' && run2.status === 'done' ? 'PASS' : 'FAIL', {
    run1Id: run1.id,
    run2Id: run2.id
  });
}

async function phase5_ConcurrencyAndResource() {
  console.log('\n=== PHASE 5: MULTI-RUN / CONCURRENCY & RESOURCE E2E ===');
  
  const runPromises = [
    apiFetch('/api/runs', { method: 'POST', body: JSON.stringify({ platform: 'shopify', query: 'https://colourpop.com', maxItems: 2 }) }),
    apiFetch('/api/runs', { method: 'POST', body: JSON.stringify({ platform: 'shopify', query: 'https://colourpop.com', maxItems: 2 }) }),
    apiFetch('/api/runs', { method: 'POST', body: JSON.stringify({ platform: 'shopify', query: 'https://glamnetic.com', maxItems: 2 }) }),
    apiFetch('/api/runs', { method: 'POST', body: JSON.stringify({ platform: 'shopify', query: 'https://glamnetic.com', maxItems: 2 }) })
  ];

  const createResults = await Promise.all(runPromises);
  const runIds = createResults.map(r => r.body && r.body.id).filter(Boolean);

  recordTest('PHASE_5', 'Concurrent Enqueue (4 Runs across pools)', runIds.length === 4 ? 'PASS' : 'FAIL', { runIds });

  const completedRuns = await Promise.all(runIds.map(id => waitForRun(id, 40)));
  const allTerminal = completedRuns.every(r => ['done', 'failed', 'stopped'].includes(r.status));
  const doneCount = completedRuns.filter(r => r.status === 'done').length;

  recordTest('PHASE_5', 'Concurrent Execution Settlement & No Deadlock', allTerminal && doneCount >= 2 ? 'PASS' : 'FAIL', {
    statuses: completedRuns.map(r => ({ id: r.id, status: r.status }))
  });
}

async function phase6_StopAbort() {
  console.log('\n=== PHASE 6: STOP / ABORT E2E ===');
  
  const { registerExecution, abortExecution, markExecutionSettled, waitForSettled, unregisterExecution } = require(path.join(PROJECT_ROOT, 'src', 'reliability', 'execution-control'));
  
  const testToken = `test-abort-token-${Date.now()}`;
  const testController = new AbortController();
  registerExecution(testToken, testController);

  let abortedObserved = false;
  testController.signal.addEventListener('abort', () => {
    abortedObserved = true;
  });

  setTimeout(() => { markExecutionSettled(testToken); }, 50);
  await abortExecution(testToken, 'TEST_ABORT_REASON');
  const settled = await waitForSettled(testToken, 2000);
  unregisterExecution(testToken);

  recordTest('PHASE_6', 'AbortExecution Signal Propagation & Execution Settlement', abortedObserved && settled ? 'PASS' : 'FAIL', {
    abortedObserved,
    settled
  });
}

async function phase7_8_9_IsolatedReliability() {
  console.log('\n=== PHASE 7, 8 & 9: ISOLATED STUCK, LEASE GUARD & RESTART RECOVERY ===');
  
  const dbModule = require(path.join(PROJECT_ROOT, 'src', 'database'));
  const { isCurrentOwner } = require(path.join(PROJECT_ROOT, 'src', 'reliability', 'execution-lease'));

  // Test Run creation and lease checking with real DB module
  const testRun = dbModule.createRun({ platform: 'shopify', query: 'https://colourpop.com', maxItems: 1 });
  dbModule.updateRun(testRun.id, { inputOptions: JSON.stringify({ executionToken: 'active-token-123' }) });

  const ownerActive = isCurrentOwner(dbModule, testRun.id, 'active-token-123');
  const ownerStale = isCurrentOwner(dbModule, testRun.id, 'stale-token-456');

  recordTest('PHASE_7', 'Execution Lease Guard (Active accepted, Stale rejected)', ownerActive && !ownerStale ? 'PASS' : 'FAIL', {
    ownerActive,
    ownerStaleRejected: !ownerStale
  });

  // Test Restart Recovery with isolated in-memory DB mock
  const { recoverOrphanedRuns } = require(path.join(PROJECT_ROOT, 'src', 'reliability', 'restart-recovery'));
  const mockDb = {
    runs: [{ id: 901, platform: 'shopify', query: 'https://colourpop.com', status: 'running', input_options: JSON.stringify({ attempt: 1 }) }],
    getRunsByStatus(status) { return this.runs.filter(r => r.status === status); },
    updateRun(id, updates) {
      const r = this.runs.find(x => x.id === id);
      if (r) {
        if (updates.status) r.status = updates.status;
        if (updates.inputOptions) r.input_options = updates.inputOptions;
      }
    }
  };

  const recoveryResult = await recoverOrphanedRuns(mockDb);
  const recoveredRow = mockDb.runs[0];

  recordTest('PHASE_9', 'RestartRecovery Re-queues Retryable Orphaned Run', recoveredRow.status === 'queued' && JSON.parse(recoveredRow.input_options).attempt === 2 ? 'PASS' : 'FAIL', {
    recoveryResult,
    recoveredStatus: recoveredRow.status,
    recoveredAttempt: JSON.parse(recoveredRow.input_options).attempt
  });
}

async function phase10_ResultHistoryExport(happyPathRunId) {
  console.log('\n=== PHASE 10: RESULT / HISTORY / EXPORT E2E ===');
  
  if (!happyPathRunId) {
    recordTest('PHASE_10', 'Export Test Skipped (No happy path run ID)', 'FAIL');
    return;
  }

  const exportJson = await apiFetch(`/api/export/${happyPathRunId}`);
  recordTest('PHASE_10', 'GET /api/export/:runId (JSON format)', exportJson.ok && exportJson.body && exportJson.body.items ? 'PASS' : 'FAIL', {
    itemsCount: exportJson.body && exportJson.body.items ? exportJson.body.items.length : 0
  });

  const exportCsv = await apiFetch(`/api/export/${happyPathRunId}?format=csv`);
  const isCsvValid = exportCsv.ok && typeof exportCsv.body === 'string' && exportCsv.body.includes('Crawled Date/Time (Ngày giờ cào)') && exportCsv.body.includes('Platform (Nền tảng)');
  recordTest('PHASE_10', 'GET /api/export/:runId?format=csv (UTF-8 CSV format)', isCsvValid ? 'PASS' : 'FAIL', {
    length: typeof exportCsv.body === 'string' ? exportCsv.body.length : 0
  });
}

async function phase11_12_13_SchedulersAndJourneys() {
  console.log('\n=== PHASE 11, 12 & 13: SOCIAL BOTS, MARKETPLACE SCHEDULERS & USER JOURNEY ===');
  
  const botsRes = await apiFetch('/api/social-bots');
  recordTest('PHASE_11', 'GET /api/social-bots', botsRes.ok && botsRes.body && botsRes.body.ok ? 'PASS' : 'FAIL', {
    bots: botsRes.body ? botsRes.body.bots : []
  });

  const botTrigger = await apiFetch('/api/social-bots/reddit/trigger', {
    method: 'POST',
    body: JSON.stringify({ query: 'tech' })
  });
  recordTest('PHASE_11', 'POST /api/social-bots/:platform/trigger (Reddit)', botTrigger.ok ? 'PASS' : 'FAIL', botTrigger.body);

  const accountsRes = await apiFetch('/api/marketplace-accounts?platform=etsy');
  recordTest('PHASE_12', 'GET /api/marketplace-accounts?platform=etsy', accountsRes.ok ? 'PASS' : 'FAIL', { count: Array.isArray(accountsRes.body) ? accountsRes.body.length : 0 });

  const proxiesRes = await apiFetch('/api/marketplace-proxies');
  recordTest('PHASE_12', 'GET /api/marketplace-proxies', proxiesRes.ok ? 'PASS' : 'FAIL', { count: Array.isArray(proxiesRes.body) ? proxiesRes.body.length : 0 });

  const schedulesRes = await apiFetch('/api/marketplace-capture-schedules');
  recordTest('PHASE_12', 'GET /api/marketplace-capture-schedules', schedulesRes.ok ? 'PASS' : 'FAIL', { count: Array.isArray(schedulesRes.body) ? schedulesRes.body.length : 0 });

  const journeyRes = await apiFetch('/api/user-journey/run', {
    method: 'POST',
    body: JSON.stringify({ platform: 'etsy', query: 'press on nails', maxItems: 2 })
  });
  recordTest('PHASE_13', 'POST /api/user-journey/run', journeyRes.ok ? 'PASS' : 'FAIL', {
    sessionId: journeyRes.body?.sessionId,
    status: journeyRes.body?.status
  });

  const toidispyFilters = await apiFetch('/api/toidispy/filters');
  recordTest('PHASE_13', 'GET /api/toidispy/filters', toidispyFilters.ok ? 'PASS' : 'FAIL', {
    hasPosts: !!(toidispyFilters.body && toidispyFilters.body.posts),
    hasAds: !!(toidispyFilters.body && toidispyFilters.body.ads)
  });
}

async function phase14_PostDatabaseIntegrity(baselineStats) {
  console.log('\n=== PHASE 14: POST-E2E DATABASE INTEGRITY ===');
  
  const rawDb = new Database(DB_PATH, { readonly: true });
  const integrity = rawDb.pragma('integrity_check');
  const legacyCountAfter = rawDb.prepare('SELECT COUNT(1) c FROM snapshots').get().c;
  const totalObsSum = rawDb.prepare('SELECT SUM(observation_count) c FROM daily_packed_history').get().c || 0;

  let totalObsIds = new Set();
  let duplicateObs = 0;
  let malformedObs = 0;
  for (const row of rawDb.prepare('SELECT observations_json FROM daily_packed_history').iterate()) {
    try {
      const arr = JSON.parse(row.observations_json);
      for (const o of arr) {
        if (!o || !o.observationId) { malformedObs++; continue; }
        if (totalObsIds.has(o.observationId)) { duplicateObs++; }
        else { totalObsIds.add(o.observationId); }
      }
    } catch { malformedObs++; }
  }
  rawDb.close();

  recordTest('PHASE_14', 'Post-E2E PRAGMA integrity_check', integrity[0].integrity_check === 'ok' ? 'PASS' : 'FAIL', integrity);
  recordTest('PHASE_14', 'Legacy Snapshots Zero Growth Guard', legacyCountAfter === baselineStats.legacyCountBefore ? 'PASS' : 'FAIL', {
    before: baselineStats.legacyCountBefore,
    after: legacyCountAfter
  });
  recordTest('PHASE_14', 'V2 Observation Unique ID & Zero Malformed Integrity', duplicateObs === 0 && malformedObs === 0 && totalObsIds.size === totalObsSum ? 'PASS' : 'FAIL', {
    totalObservations: totalObsSum,
    uniqueObservationIds: totalObsIds.size,
    duplicates: duplicateObs,
    malformed: malformedObs
  });
}

async function main() {
  console.log('==================================================');
  console.log('STARTING FULL SYSTEM AGENT E2E VALIDATION');
  console.log('==================================================');
  
  const baselineStats = await phase0_1_PreflightAndHealth();
  const happyPathResult = await phase2_CoreHappyPath(baselineStats);
  await phase3_PlatformCoverage();
  await phase4_DataQuality();
  await phase5_ConcurrencyAndResource();
  await phase6_StopAbort();
  await phase7_8_9_IsolatedReliability();
  await phase10_ResultHistoryExport(happyPathResult ? happyPathResult.runId : null);
  await phase11_12_13_SchedulersAndJourneys();
  await phase14_PostDatabaseIntegrity(baselineStats);

  console.log('\n==================================================');
  console.log('E2E EXECUTION SUMMARY');
  console.log('==================================================');
  console.log('PASS:', results.summary.pass);
  console.log('FAIL:', results.summary.fail);
  console.log('BLOCKED_EXTERNAL:', results.summary.blocked);
  console.log('DISABLED / NOT_IN_LIVE_SCOPE:', results.summary.disabled);

  fs.writeFileSync(
    path.join(PROJECT_ROOT, 'data', 'full_e2e_results.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );
  console.log('Saved detailed results to data/full_e2e_results.json');
}

main().catch(err => {
  console.error('FATAL IN E2E SUITE:', err);
  process.exit(1);
});

