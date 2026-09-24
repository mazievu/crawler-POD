'use strict';

/**
 * Durable Apify budget: review findings M3: runs still RUNNING at local abort/timeout
 * stay committed and are settled later by reconciliation.
 *
 * Runs against a real (PGlite) PostgreSQL loaded with the real schema, so the
 * idempotent ALTERs in pg-schema.sql are exercised too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ApifyTokenPoolManager, getApifyTokenPool } = require('../src/apify-token-pool');
const { createApifyBudgetLedger } = require('../src/apify-budget-ledger');
const { fromDriver } = require('../src/database/pg-client');

const PG_SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'database', 'pg-schema.sql'), 'utf8');

async function freshBudgetDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = fromDriver(new PGlite());
  await db.exec(PG_SCHEMA);
  return db;
}

const BUDGET_ENV = ['APIFY_INITIAL_BALANCE_USD', 'APIFY_BUDGET_LIMIT_USD', 'APIFY_MIN_BALANCE_USD'];

/** Clears the budget env for one test and restores it afterwards. */
function isolateBudgetEnv(t) {
  const saved = Object.fromEntries(BUDGET_ENV.map((k) => [k, process.env[k]]));
  for (const k of BUDGET_ENV) delete process.env[k];
  t.after(() => {
    for (const k of BUDGET_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

/** Captures console[method] lines for one test. */
function capture(t, method) {
  const lines = [];
  const original = console[method];
  console[method] = (...args) => { lines.push(args.join(' ')); };
  t.after(() => { console[method] = original; });
  return lines;
}

/** Stub Apify client whose run status/usage and abort calls are controllable. */
function stubApifyClient(runId, initial) {
  const state = { status: initial.status, usage: initial.usage, abortCalls: 0 };
  const client = {
    actor: () => ({ call: async () => ({ id: runId, defaultDatasetId: `ds-${runId}` }) }),
    run: (id) => ({
      get: async () => (id === runId ? { id, status: state.status, usageTotalUsd: state.usage } : null),
      abort: async () => { state.abortCalls += 1; return { id, status: 'ABORTING' }; },
    }),
    dataset: () => ({ listItems: async () => ({ items: [] }) }),
  };
  return { client, state };
}

async function reservationRow(db, runId) {
  const res = await db.query('SELECT status, apify_run_id, actual_usd FROM apify_budget_reservations WHERE apify_run_id = $1', [runId]);
  return res.rows[0];
}

test('M3: runs still RUNNING at local timeout/abort are reconciled later', async (t) => {
  const ApifyBackend = require('../src/backends/apify.backend');

  async function setup(t2, runId, initial) {
    isolateBudgetEnv(t2);
    capture(t2, 'log');
    capture(t2, 'warn');
    t2.after(() => { getApifyTokenPool({ forceNew: true, tokens: [] }); });
    const db = await freshBudgetDb();
    const pool = getApifyTokenPool({
      forceNew: true,
      tokens: ['apify_api_tokM3'],
      initialApifyBalance: 100,
      budgetLimitUsd: 10,
      defaultEstimatedCostUsd: 0.05,
      budgetLedger: createApifyBudgetLedger(db),
    });
    const stub = stubApifyClient(runId, initial);
    pool.clients.set('token-1', stub.client);
    return { db, pool, stub };
  }

  await t.test('poll timeout while RUNNING keeps the reservation committed and asks Apify to abort', async (t2) => {
    const { db, stub } = await setup(t2, 'run-to', { status: 'RUNNING', usage: 0.2 });
    const backend = new ApifyBackend({ pollIntervalMs: 1, maxPollAttempts: 2 });

    await assert.rejects(
      backend.run({ name: 'reddit' }, { actorId: 'trudax/reddit-scraper-lite' }, 'cats', { maxItems: 5 }),
      /RUNNING/,
    );
    const row = await reservationRow(db, 'run-to');
    assert.equal(row.status, 'committed', 'non-terminal run must not be settled as final');
    assert.equal(row.actual_usd, null);
    assert.equal(stub.state.abortCalls, 1, 'best-effort Apify abort on timeout');
  });

  await t.test('local abort while RUNNING keeps the reservation committed and asks Apify to abort', async (t2) => {
    const { db, stub } = await setup(t2, 'run-ab', { status: 'RUNNING', usage: 0.1 });
    const backend = new ApifyBackend({ pollIntervalMs: 5, maxPollAttempts: 50 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);

    await assert.rejects(
      backend.run({ name: 'reddit' }, { actorId: 'trudax/reddit-scraper-lite' }, 'cats', { maxItems: 5, signal: controller.signal }),
      /ABORTED/,
    );
    const row = await reservationRow(db, 'run-ab');
    assert.equal(row.status, 'committed');
    assert.equal(stub.state.abortCalls, 1);
  });

  await t.test('reconcilePendingRuns settles a committed run to usageTotalUsd once terminal', async (t2) => {
    const { db, pool, stub } = await setup(t2, 'run-rc', { status: 'RUNNING', usage: 0.2 });
    const backend = new ApifyBackend({ pollIntervalMs: 1, maxPollAttempts: 1 });
    await assert.rejects(
      backend.run({ name: 'reddit' }, { actorId: 'trudax/reddit-scraper-lite' }, 'cats', { maxItems: 5 }),
    );

    // Still running: sweep leaves it alone.
    const early = await pool.reconcilePendingRuns();
    assert.equal(early.settled, 0);
    assert.equal(early.pending, 1);
    assert.equal((await reservationRow(db, 'run-rc')).status, 'committed');

    stub.state.status = 'ABORTED';
    stub.state.usage = 0.9;
    const done = await pool.reconcilePendingRuns();
    assert.equal(done.settled, 1);
    const row = await reservationRow(db, 'run-rc');
    assert.equal(row.status, 'settled');
    assert.equal(Number(row.actual_usd), 0.9);
    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0.9);

    const again = await pool.reconcilePendingRuns();
    assert.equal(again.settled, 0, 'reconciliation is idempotent');
  });

  await t.test('a terminal run without a usage figure settles at the estimate', async (t2) => {
    const { db, pool, stub } = await setup(t2, 'run-nu', { status: 'RUNNING', usage: null });
    const backend = new ApifyBackend({ pollIntervalMs: 1, maxPollAttempts: 1 });
    await assert.rejects(
      backend.run({ name: 'reddit' }, { actorId: 'trudax/reddit-scraper-lite' }, 'cats', { maxItems: 5 }),
    );
    stub.state.status = 'SUCCEEDED';
    const out = await pool.reconcilePendingRuns();
    assert.equal(out.settled, 1);
    assert.equal(Number((await reservationRow(db, 'run-nu')).actual_usd), 0.05);
  });

  await t.test('in-memory mode: a pending run is kept (not refunded) and reconciled later', async (t2) => {
    isolateBudgetEnv(t2);
    capture(t2, 'warn');
    capture(t2, 'log');
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'], initialApifyBalance: 100, budgetLimitUsd: 10, defaultEstimatedCostUsd: 0.5,
    });
    const stub = stubApifyClient('run-mem', { status: 'RUNNING', usage: 0.1 });
    pool.clients.set('token-1', stub.client);

    await assert.rejects(pool.withTokenFailover(async (_c, _t, admission) => {
      admission.reportActorStarted('run-mem');
      admission.reportRunPending('run-mem');
      throw new Error('ABORTED: local cancel');
    }), /ABORTED/);
    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0.5, 'estimate stays counted');
    const [res] = [...pool.reservations.values()];
    assert.equal(pool.releaseBudget(res.id), false, 'a started run is never refunded');

    assert.equal((await pool.reconcilePendingRuns()).pending, 1);
    stub.state.status = 'SUCCEEDED';
    stub.state.usage = 0.3;
    assert.equal((await pool.reconcilePendingRuns()).settled, 1);
    assert.equal(pool.getBudgetStatus().totalSpentUsd, 0.3);
    assert.equal((await pool.reconcilePendingRuns()).checked, 0);
  });

  await t.test('startReconciliation runs immediately, repeats on an unref\'d interval, and stops', async (t2) => {
    isolateBudgetEnv(t2);
    const pool = new ApifyTokenPoolManager({ tokens: ['apify_api_tok1'] });
    let calls = 0;
    pool.reconcilePendingRuns = async () => { calls += 1; return { checked: 0, settled: 0, pending: 0, errors: 0 }; };

    const timer = pool.startReconciliation({ intervalMs: 10 });
    t2.after(() => pool.stopReconciliation());
    assert.equal(typeof timer.hasRef, 'function');
    assert.equal(timer.hasRef(), false, 'interval must not keep the process alive');
    await new Promise((r) => setTimeout(r, 45));
    assert.ok(calls >= 2, `expected immediate + periodic sweeps, got ${calls}`);

    pool.stopReconciliation();
    const frozen = calls;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, frozen);
  });

  await t.test('a sweep error is logged, not thrown out of the interval', async (t2) => {
    isolateBudgetEnv(t2);
    const errors = capture(t2, 'error');
    const pool = new ApifyTokenPoolManager({ tokens: ['apify_api_tok1'] });
    pool.reconcilePendingRuns = async () => { throw new Error('db down'); };
    pool.startReconciliation({ intervalMs: 1000 });
    t2.after(() => pool.stopReconciliation());
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(errors.some((l) => /db down/.test(l)));
  });
});
