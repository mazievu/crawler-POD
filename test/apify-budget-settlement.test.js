'use strict';

/**
 * P0: the Apify budget cap must bind REAL paid runs.
 *
 * Once an actor has started on Apify, its money is spent whether or not our
 * callback later succeeds, so the reservation must be settled (never refunded).
 * Spend must also survive a restart and be shared across instances, which is
 * why the DB-backed ledger is exercised against a real (PGlite) PostgreSQL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ApifyTokenPoolManager, getApifyTokenPool } = require('../src/apify-token-pool');
// Required lazily so the in-memory cases report individually even before the
// ledger module exists (RED phase).
const createApifyBudgetLedger = (db) => require('../src/apify-budget-ledger').createApifyBudgetLedger(db);
const { fromDriver } = require('../src/database/pg-client');

const PG_SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'database', 'pg-schema.sql'), 'utf8');

/** A fresh, isolated in-memory PostgreSQL loaded with the real schema. */
async function freshBudgetDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = fromDriver(new PGlite());
  await db.exec(PG_SCHEMA);
  return db;
}

/** A callback shaped like ApifyBackend's result: the actor ran, no cost info. */
const startedRun = (runId) => async () => ({ backend: 'apify', backendRunId: runId, items: [] });

function silence(t, method) {
  const original = console[method];
  console[method] = () => {};
  t.after(() => { console[method] = original; });
}

function memoryPool(overrides = {}) {
  return new ApifyTokenPoolManager({
    tokens: ['apify_api_tok1'],
    initialApifyBalance: 100,
    budgetLimitUsd: 10,
    defaultEstimatedCostUsd: 0.5,
    ...overrides,
  });
}

test('Apify Budget P0: started runs consume the cap', async (t) => {
  await t.test('(a) cap $2, estimate $1: third sequential start is rejected and spend >= $2', async () => {
    const pool = memoryPool({ budgetLimitUsd: 2, defaultEstimatedCostUsd: 1 });

    await pool.withTokenFailover(startedRun('run-1'));
    await pool.withTokenFailover(startedRun('run-2'));

    let thirdStarted = false;
    await assert.rejects(
      pool.withTokenFailover(async () => { thirdStarted = true; return { backendRunId: 'run-3' }; }),
      (err) => err.code === 'APIFY_BUDGET_EXCEEDED' && err.status === 402,
    );
    assert.equal(thirdStarted, false, 'the third actor must never be started');
    const spent = pool.getBudgetStatus().totalSpentUsd;
    assert.ok(spent >= 2, `spend was ${spent}`);
  });

  await t.test('(c) callback throws after actor start -> estimate is settled, not released', async () => {
    const pool = memoryPool();

    await assert.rejects(
      pool.withTokenFailover(async (_client, _token, admission) => {
        admission.reportActorStarted('run-c');
        throw new Error('ABORTED: execution cancelled while polling Apify run status');
      }),
      /ABORTED/,
    );

    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0.5);
    assert.equal(pool.getBudgetStatus().remainingBalanceUsd, 99.5);
  });

  await t.test('(c2) failed run with a final usage figure settles to the actual usage', async () => {
    const pool = memoryPool();

    await assert.rejects(
      pool.withTokenFailover(async (_client, _token, admission) => {
        admission.reportActorStarted('run-c2');
        admission.reportRunCost(0.3, { final: true });
        throw new Error('Apify run ended with status: FAILED');
      }),
      /FAILED/,
    );

    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0.3);
  });

  await t.test('(c3) a partial (non-final) usage figure never lowers spend below the estimate', async () => {
    const pool = memoryPool();

    await assert.rejects(
      pool.withTokenFailover(async (_client, _token, admission) => {
        admission.reportActorStarted('run-c3');
        admission.reportRunCost(0.2, { final: false });
        throw new Error('Apify run ended with status: RUNNING');
      }),
      /RUNNING/,
    );

    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0.5);
  });

  await t.test('(c4) a token error AFTER start settles that run before rotating', async (t2) => {
    silence(t2, 'warn');
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tokA', 'apify_api_tokB'],
      initialApifyBalance: 100,
      budgetLimitUsd: 10,
      defaultEstimatedCostUsd: 0.5,
    });

    const result = await pool.withTokenFailover(async (_client, tokenRecord, admission) => {
      admission.reportActorStarted(`run-${tokenRecord.id}`);
      if (tokenRecord.id === 'token-1') {
        const err = new Error('429 Too Many Requests');
        err.status = 429;
        throw err;
      }
      admission.reportRunCost(0.2, { final: true });
      return { backendRunId: 'run-token-2' };
    });

    assert.equal(result.backendRunId, 'run-token-2');
    // run on token-1 kept its $0.50 estimate; run on token-2 settled to $0.20.
    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0.7);
  });

  await t.test('failure BEFORE the actor started releases the reservation', async () => {
    const pool = memoryPool();

    await assert.rejects(
      pool.withTokenFailover(async () => { throw new Error('No input builder for: nope'); }),
      /No input builder/,
    );

    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0);
    assert.equal(pool.getBudgetStatus().remainingBalanceUsd, 100);
  });

  await t.test('reserve estimate defaults to APIFY_DEFAULT_RUN_COST_USD and rejects unsafe values', (t2) => {
    silence(t2, 'warn');
    const previous = process.env.APIFY_DEFAULT_RUN_COST_USD;
    t2.after(() => {
      if (previous === undefined) delete process.env.APIFY_DEFAULT_RUN_COST_USD;
      else process.env.APIFY_DEFAULT_RUN_COST_USD = previous;
    });

    process.env.APIFY_DEFAULT_RUN_COST_USD = '0.75';
    assert.equal(new ApifyTokenPoolManager({ tokens: ['apify_api_tok1'] }).defaultEstimatedCostUsd, 0.75);

    process.env.APIFY_DEFAULT_RUN_COST_USD = '-5';
    assert.equal(new ApifyTokenPoolManager({ tokens: ['apify_api_tok1'] }).defaultEstimatedCostUsd, 0.05);

    process.env.APIFY_DEFAULT_RUN_COST_USD = 'abc';
    assert.equal(new ApifyTokenPoolManager({ tokens: ['apify_api_tok1'] }).defaultEstimatedCostUsd, 0.05);
  });

  await t.test('a negative per-call estimate cannot bypass the cap', async () => {
    const pool = memoryPool({ budgetLimitUsd: 1, defaultEstimatedCostUsd: 1 });
    await pool.withTokenFailover(startedRun('run-n1'));
    await assert.rejects(
      pool.withTokenFailover(startedRun('run-n2'), { estimatedCostUsd: -100 }),
      (err) => err.code === 'APIFY_BUDGET_EXCEEDED',
    );
  });
});

test('Apify Budget P0: ApifyBackend settles to the run\'s real usageTotalUsd', async (t) => {
  await t.test('(b) stubbed client reports usageTotalUsd 0.7 -> spend is 0.7', async (t2) => {
    silence(t2, 'log');
    const ApifyBackend = require('../src/backends/apify.backend');
    t2.after(() => { getApifyTokenPool({ forceNew: true, tokens: [] }); });

    const pool = getApifyTokenPool({
      forceNew: true,
      tokens: ['apify_api_tokB'],
      initialApifyBalance: 100,
      budgetLimitUsd: 10,
      defaultEstimatedCostUsd: 0.05,
    });
    pool.clients.set('token-1', {
      actor: () => ({ call: async () => ({ id: 'run-b', defaultDatasetId: 'ds-b' }) }),
      run: () => ({ get: async () => ({ id: 'run-b', status: 'SUCCEEDED', usageTotalUsd: 0.7 }) }),
      dataset: () => ({ listItems: async () => ({ items: [{ id: 'x1' }] }) }),
    });

    const backend = new ApifyBackend({ pollIntervalMs: 1 });
    const result = await backend.run(
      { name: 'reddit' },
      { actorId: 'trudax/reddit-scraper-lite' },
      'cats',
      { maxItems: 5 },
    );

    assert.equal(result.backendRunId, 'run-b');
    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0.7);
  });

  await t.test('(b2) a FAILED run still settles to its usageTotalUsd', async (t2) => {
    silence(t2, 'log');
    const ApifyBackend = require('../src/backends/apify.backend');
    t2.after(() => { getApifyTokenPool({ forceNew: true, tokens: [] }); });

    const pool = getApifyTokenPool({
      forceNew: true,
      tokens: ['apify_api_tokB'],
      initialApifyBalance: 100,
      budgetLimitUsd: 10,
      defaultEstimatedCostUsd: 0.05,
    });
    pool.clients.set('token-1', {
      actor: () => ({ call: async () => ({ id: 'run-f', defaultDatasetId: 'ds-f' }) }),
      run: () => ({ get: async () => ({ id: 'run-f', status: 'FAILED', usageTotalUsd: 0.4 }) }),
      dataset: () => ({ listItems: async () => ({ items: [] }) }),
    });

    const backend = new ApifyBackend({ pollIntervalMs: 1 });
    await assert.rejects(
      backend.run({ name: 'reddit' }, { actorId: 'trudax/reddit-scraper-lite' }, 'cats', { maxItems: 5 }),
      /FAILED/,
    );
    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0.4);
  });

  await t.test('getRunInfo exposes status and usageTotalUsd', async () => {
    const { getRunInfo } = require('../src/apify-client');
    const client = { run: () => ({ get: async () => ({ status: 'FAILED', usageTotalUsd: 0.42 }) }) };
    assert.deepEqual(await getRunInfo('r', client), { status: 'FAILED', usageTotalUsd: 0.42 });

    const noUsage = { run: () => ({ get: async () => ({ status: 'RUNNING' }) }) };
    assert.deepEqual(await getRunInfo('r', noUsage), { status: 'RUNNING', usageTotalUsd: null });
  });
});

test('Apify Budget P0: durable DB ledger', async (t) => {
  const makePool = (db, overrides = {}) => new ApifyTokenPoolManager({
    tokens: ['apify_api_tok1'],
    initialApifyBalance: 100,
    budgetLimitUsd: 2,
    defaultEstimatedCostUsd: 1,
    budgetLedger: createApifyBudgetLedger(db),
    ...overrides,
  });

  await t.test('(d) a new pool instance on the same DB sees prior spend and enforces the cap', async () => {
    const db = await freshBudgetDb();

    const first = makePool(db);
    await first.withTokenFailover(startedRun('run-d1'));
    await first.withTokenFailover(startedRun('run-d2'));

    // Simulated restart / second instance.
    const second = makePool(db);
    await second.syncBudgetFromLedger();
    assert.equal(second.getBudgetStatus().totalSpentUsd, 2);
    assert.equal(second.getBudgetStatus().remainingBalanceUsd, 98);

    let started = false;
    await assert.rejects(
      second.withTokenFailover(async () => { started = true; return { backendRunId: 'run-d3' }; }),
      (err) => err.code === 'APIFY_BUDGET_EXCEEDED',
    );
    assert.equal(started, false);

    const row = await db.query("SELECT spent_usd FROM apify_budget_ledger WHERE key = 'global'");
    assert.equal(Number(row.rows[0].spent_usd), 2);
    const res = await db.query('SELECT status, apify_run_id FROM apify_budget_reservations ORDER BY created_at, id');
    assert.deepEqual(res.rows.map((r) => r.status).sort(), ['settled', 'settled']);
    assert.deepEqual(res.rows.map((r) => r.apify_run_id).sort(), ['run-d1', 'run-d2']);
  });

  await t.test('(d2) DB settlement adjusts spend to the reported actual cost', async () => {
    const db = await freshBudgetDb();
    const pool = makePool(db, { budgetLimitUsd: 5 });
    await pool.withTokenFailover(async (_c, _t, admission) => {
      admission.reportActorStarted('run-d4');
      admission.reportRunCost(0.7, { final: true });
      return { backendRunId: 'run-d4' };
    });

    const again = makePool(db, { budgetLimitUsd: 5 });
    await again.syncBudgetFromLedger();
    assert.equal(again.getBudgetStatus().totalSpentUsd, 0.7);
    assert.equal(again.getBudgetStatus().remainingBalanceUsd, 99.3);
  });

  await t.test('(d3) a pre-start failure releases the DB reservation', async () => {
    const db = await freshBudgetDb();
    const pool = makePool(db);
    await assert.rejects(pool.withTokenFailover(async () => { throw new Error('bad input'); }), /bad input/);
    await pool.syncBudgetFromLedger();
    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0);
    const res = await db.query('SELECT status FROM apify_budget_reservations');
    assert.deepEqual(res.rows.map((r) => r.status), ['released']);
  });

  await t.test('(d4) release/settle are idempotent: a settled reservation cannot be refunded', async () => {
    const db = await freshBudgetDb();
    const ledger = createApifyBudgetLedger(db);
    await ledger.init({ initialBalanceUsd: 10 });
    const res = await ledger.reserve({ amountUsd: 1, budgetLimitUsd: null, minBalanceUsd: 0 });
    assert.equal(res.ok, true);
    await ledger.settle(res.reservationId, 0.4, 'run-x');
    const afterRelease = await ledger.release(res.reservationId);
    assert.equal(afterRelease, null);
    const again = await ledger.settle(res.reservationId, 0, 'run-x');
    assert.equal(again, null);
    const state = await ledger.getState();
    assert.equal(state.spentUsd, 0.4);
    assert.equal(state.remainingBalanceUsd, 9.6);
  });

  await t.test('(f) two concurrent reserves at the last dollar -> exactly one succeeds', async () => {
    const db = await freshBudgetDb();
    const warm = makePool(db);
    await warm.withTokenFailover(startedRun('run-f0')); // spent = 1 of 2

    const a = makePool(db);
    const b = makePool(db);
    const slowStart = (runId) => async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { backendRunId: runId };
    };

    const outcomes = await Promise.allSettled([
      a.withTokenFailover(slowStart('run-fa')),
      b.withTokenFailover(slowStart('run-fb')),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'APIFY_BUDGET_EXCEEDED');

    const row = await db.query("SELECT spent_usd FROM apify_budget_ledger WHERE key = 'global'");
    assert.equal(Number(row.rows[0].spent_usd), 2);
  });

  await t.test('applyBudgetUpdate persists balance and resetSpent to the ledger', async () => {
    const db = await freshBudgetDb();
    const pool = makePool(db, { budgetLimitUsd: 50 });
    await pool.withTokenFailover(startedRun('run-u1'));
    const status = await pool.applyBudgetUpdate({ remainingBalanceUsd: 7, resetSpent: true });
    assert.equal(status.remainingBalanceUsd, 7);
    assert.equal(status.totalSpentUsd, 0);

    const fresh = makePool(db, { budgetLimitUsd: 50 });
    await fresh.syncBudgetFromLedger();
    assert.equal(fresh.getBudgetStatus().remainingBalanceUsd, 7);
    assert.equal(fresh.getBudgetStatus().totalSpentUsd, 0);
  });
});
