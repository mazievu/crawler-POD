'use strict';

/**
 * Durable Apify budget: review findings M1 (balance seed follows an explicit
 * env change) and M2 (cap/threshold persisted in the ledger row).
 *
 * Runs against a real (PGlite) PostgreSQL loaded with the real schema, so the
 * idempotent ALTERs in pg-schema.sql are exercised too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ApifyTokenPoolManager } = require('../src/apify-token-pool');
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

/** Pool built only from env (no explicit budget options). */
const envPool = (db, overrides = {}) => new ApifyTokenPoolManager({
  tokens: ['apify_api_tok1'],
  defaultEstimatedCostUsd: 1,
  budgetLedger: createApifyBudgetLedger(db),
  ...overrides,
});

const startedRun = (runId) => async () => ({ backend: 'apify', backendRunId: runId, items: [] });

test('M1: durable ledger balance seed follows an explicit APIFY_INITIAL_BALANCE_USD change', async (t) => {
  await t.test('default-seeded balance is re-seeded when the env value is set and differs', async (t2) => {
    isolateBudgetEnv(t2);
    const logs = capture(t2, 'warn');
    const db = await freshBudgetDb();

    const first = envPool(db);
    await first.withTokenFailover(startedRun('run-s1'));
    await first.syncBudgetFromLedger();
    assert.equal(first.getBudgetStatus().remainingBalanceUsd, 99, 'default seed is 100');

    process.env.APIFY_INITIAL_BALANCE_USD = '250';
    const second = envPool(db);
    await second.syncBudgetFromLedger();
    assert.equal(second.getBudgetStatus().remainingBalanceUsd, 250, 'explicit new seed replaces the balance');
    assert.equal(second.getBudgetStatus().totalSpentUsd, 1, 'spend history is kept');
    assert.ok(logs.some((l) => /re-?seed/i.test(l) && /250/.test(l)), `re-seed must be logged, got: ${logs.join(' | ')}`);

    const row = await db.query("SELECT seed_balance_usd FROM apify_budget_ledger WHERE key = 'global'");
    assert.equal(Number(row.rows[0].seed_balance_usd), 250);
  });

  await t.test('same explicit seed on restart keeps the tracked balance', async (t2) => {
    isolateBudgetEnv(t2);
    capture(t2, 'warn');
    const db = await freshBudgetDb();
    process.env.APIFY_INITIAL_BALANCE_USD = '40';

    const first = envPool(db);
    await first.withTokenFailover(startedRun('run-k1'));

    const restarted = envPool(db);
    await restarted.syncBudgetFromLedger();
    assert.equal(restarted.getBudgetStatus().remainingBalanceUsd, 39);
    assert.equal(restarted.getBudgetStatus().totalSpentUsd, 1);
  });

  await t.test('an unset env on restart keeps the tracked balance (no silent reset to 100)', async (t2) => {
    isolateBudgetEnv(t2);
    capture(t2, 'warn');
    const db = await freshBudgetDb();
    process.env.APIFY_INITIAL_BALANCE_USD = '40';
    await envPool(db).withTokenFailover(startedRun('run-u1'));

    delete process.env.APIFY_INITIAL_BALANCE_USD;
    const restarted = envPool(db);
    await restarted.syncBudgetFromLedger();
    assert.equal(restarted.getBudgetStatus().remainingBalanceUsd, 39);
  });
});

test('schema: re-running pg-schema.sql upgrades a pre-existing ledger row idempotently', async (t) => {
  isolateBudgetEnv(t);
  capture(t, 'warn');
  const { PGlite } = await import('@electric-sql/pglite');
  const db = fromDriver(new PGlite());
  // The table as it existed before the budget-config columns were added.
  await db.exec(`CREATE TABLE apify_budget_ledger (
    key TEXT PRIMARY KEY,
    spent_usd NUMERIC(14, 6) NOT NULL DEFAULT 0,
    remaining_balance_usd NUMERIC(14, 6) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.query("INSERT INTO apify_budget_ledger (key, spent_usd, remaining_balance_usd) VALUES ('global', 3, 42)");

  await db.exec(PG_SCHEMA);
  await db.exec(PG_SCHEMA); // every boot re-runs it

  const pool = envPool(db);
  await pool.syncBudgetFromLedger();
  assert.equal(pool.getBudgetStatus().remainingBalanceUsd, 42, 'no explicit env: legacy balance kept');
  assert.equal(pool.getBudgetStatus().totalSpentUsd, 3);
});

test('M2: admin cap/threshold are persisted in the ledger and read by reserve()', async (t) => {
  await t.test('applyBudgetUpdate cap/threshold survive a new pool instance', async (t2) => {
    isolateBudgetEnv(t2);
    capture(t2, 'warn');
    const db = await freshBudgetDb();
    const pool = envPool(db, { budgetLimitUsd: 50, minBalanceThresholdUsd: 0 });
    const status = await pool.applyBudgetUpdate({ budgetLimitUsd: 3, minBalanceThresholdUsd: 1.5 });
    assert.equal(status.budgetLimitUsd, 3);
    assert.equal(status.minBalanceThresholdUsd, 1.5);

    const restarted = envPool(db, { budgetLimitUsd: 50, minBalanceThresholdUsd: 0 });
    await restarted.syncBudgetFromLedger();
    assert.equal(restarted.getBudgetStatus().budgetLimitUsd, 3);
    assert.equal(restarted.getBudgetStatus().minBalanceThresholdUsd, 1.5);
  });

  await t.test('a cap set on one instance binds reserve() on another un-synced instance', async (t2) => {
    isolateBudgetEnv(t2);
    capture(t2, 'warn');
    const db = await freshBudgetDb();
    const a = envPool(db, { budgetLimitUsd: 50 });
    const b = envPool(db, { budgetLimitUsd: 50 });
    await b.syncBudgetFromLedger();

    await a.applyBudgetUpdate({ budgetLimitUsd: 1 });

    await b.withTokenFailover(startedRun('run-b1')); // spent 1 of cap 1
    let started = false;
    await assert.rejects(
      b.withTokenFailover(async () => { started = true; return { backendRunId: 'run-b2' }; }),
      (err) => err.code === 'APIFY_BUDGET_EXCEEDED',
    );
    assert.equal(started, false);
  });

  await t.test('a threshold set in the DB is enforced by reserve()', async (t2) => {
    isolateBudgetEnv(t2);
    capture(t2, 'warn');
    const db = await freshBudgetDb();
    const a = envPool(db, { initialApifyBalance: 10 });
    const b = envPool(db, { initialApifyBalance: 10 });
    await b.syncBudgetFromLedger();
    await a.applyBudgetUpdate({ minBalanceThresholdUsd: 9.5 });

    await assert.rejects(
      b.withTokenFailover(startedRun('run-t1')),
      (err) => err.code === 'APIFY_BUDGET_EXCEEDED',
    );
  });

  await t.test('a DB failure leaves the in-memory budget unchanged', async (t2) => {
    isolateBudgetEnv(t2);
    capture(t2, 'warn');
    const db = await freshBudgetDb();
    const realLedger = createApifyBudgetLedger(db);
    const failingLedger = {
      ...realLedger,
      update: async () => { throw new Error('connection terminated'); },
    };
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 100,
      budgetLimitUsd: 20,
      minBalanceThresholdUsd: 0,
      budgetLedger: failingLedger,
    });
    await pool.syncBudgetFromLedger();
    const before = pool.getBudgetStatus();

    await assert.rejects(
      pool.applyBudgetUpdate({ budgetLimitUsd: 2, minBalanceThresholdUsd: 5, remainingBalanceUsd: 1, resetSpent: true }),
      /connection terminated/,
    );
    const after = pool.getBudgetStatus();
    assert.equal(after.budgetLimitUsd, before.budgetLimitUsd);
    assert.equal(after.minBalanceThresholdUsd, before.minBalanceThresholdUsd);
    assert.equal(after.remainingBalanceUsd, before.remainingBalanceUsd);
    assert.equal(after.totalSpentUsd, before.totalSpentUsd);
  });
});

