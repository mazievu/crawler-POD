'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ApifyTokenPoolManager,
  ApifyBudgetExceededError,
} = require('../src/apify-token-pool');

test('Apify Budget: Feature 12 Apify Budget Kill Switch', async (t) => {
  await t.test('checkBudget allows when balance is above threshold', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 50.0,
      minBalanceThresholdUsd: 0.0,
    });

    const check = pool.checkBudget();
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.remainingBalance, 50.0);
  });

  await t.test('checkBudget blocks at exact 0.00 boundary (B12.1)', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 0.0,
      minBalanceThresholdUsd: 0.0,
    });

    const check = pool.checkBudget();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.reason, 'APIFY_BUDGET_EXCEEDED');
  });

  await t.test('checkBudget blocks when balance is negative (F12.3)', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: -5.0,
      minBalanceThresholdUsd: 0.0,
    });

    const check = pool.checkBudget();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.reason, 'APIFY_BUDGET_EXCEEDED');
  });

  await t.test('floating-point precision: balance of 0.0001 is allowed (B12.2)', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 0.0001,
      minBalanceThresholdUsd: 0.0,
    });

    const check = pool.checkBudget();
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.remainingBalance, 0.0001);
  });

  await t.test('assertBudgetAvailable throws ApifyBudgetExceededError (status 402)', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 0.0,
      minBalanceThresholdUsd: 0.0,
    });

    assert.throws(
      () => pool.assertBudgetAvailable(),
      (err) => {
        assert.strictEqual(err.name, 'ApifyBudgetExceededError');
        assert.strictEqual(err.code, 'APIFY_BUDGET_EXCEEDED');
        assert.strictEqual(err.status, 402);
        assert.strictEqual(err.statusCode, 402);
        return true;
      }
    );
  });

  await t.test('deductBudget decrements balance atomically and prevents negative underflow (B12.4)', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 2.0,
      defaultRunCostUsd: 1.0,
    });

    assert.strictEqual(pool.deductBudget(), 1.0);
    assert.strictEqual(pool.totalSpentUsd, 1.0);

    assert.strictEqual(pool.deductBudget(), 0.0);
    assert.strictEqual(pool.totalSpentUsd, 2.0);

    // Further deduction does not make remainingBalance negative
    assert.strictEqual(pool.deductBudget(5.0), 0.0);
    assert.strictEqual(pool.totalSpentUsd, 7.0);
  });

  await t.test('configured budget limit ceiling halts paid actions when reached', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 100.0,
      budgetLimitUsd: 2.0,
      defaultRunCostUsd: 1.0,
    });

    assert.strictEqual(pool.checkBudget().allowed, true);
    pool.deductBudget(1.0);
    assert.strictEqual(pool.checkBudget().allowed, true);
    pool.deductBudget(1.0); // totalSpent = 2.0 = budgetLimit

    const check = pool.checkBudget();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.reason, 'APIFY_BUDGET_EXCEEDED');
  });

  await t.test('setBudget allows admin dynamic adjustment', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 0.0,
    });

    assert.strictEqual(pool.checkBudget().allowed, false);

    // Top up balance
    pool.setBudget({ remainingBalanceUsd: 50.0 });
    assert.strictEqual(pool.checkBudget().allowed, true);
    assert.strictEqual(pool.remainingBalanceUsd, 50.0);

    const status = pool.getBudgetStatus();
    assert.strictEqual(status.status, 'HEALTHY');
    assert.strictEqual(status.isExhausted, false);
  });

  await t.test('withTokenFailover halts before calling actor when budget is exhausted', async () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1', 'apify_api_tok2'],
      initialApifyBalance: 0.0,
    });

    let actorExecuted = false;
    await assert.rejects(
      async () => {
        await pool.withTokenFailover(async () => {
          actorExecuted = true;
          return { runId: 'actor-123' };
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'APIFY_BUDGET_EXCEEDED');
        assert.strictEqual(err.status, 402);
        return true;
      }
    );

    assert.strictEqual(actorExecuted, false);
  });

  await t.test('getStatus includes budget details in payload', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 25.0,
      budgetLimitUsd: 50.0,
    });

    const status = pool.getStatus();
    assert.ok(status.budget);
    assert.strictEqual(status.budget.remainingBalanceUsd, 25.0);
    assert.strictEqual(status.budget.budgetLimitUsd, 50.0);
    assert.strictEqual(status.budget.isExhausted, false);
  });

  await t.test('Test concurrent: 2 reserve cùng lúc, budget chỉ đủ cho 1 -> cái thứ 2 bị reject', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 0.08,
      defaultEstimatedCostUsd: 0.05,
    });

    const res1 = pool.reserveBudget(0.05);
    assert.ok(res1);
    assert.strictEqual(pool.remainingBalanceUsd, 0.03);

    assert.throws(
      () => pool.reserveBudget(0.05),
      (err) => {
        assert.strictEqual(err.code, 'APIFY_BUDGET_EXCEEDED');
        return true;
      }
    );
  });

  await t.test('Test release: reserve rồi release -> budget khôi phục', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 0.10,
    });

    const res = pool.reserveBudget(0.05);
    assert.strictEqual(pool.remainingBalanceUsd, 0.05);

    const released = pool.releaseBudget(res.id);
    assert.strictEqual(released, true);
    assert.strictEqual(pool.remainingBalanceUsd, 0.10);
  });

  await t.test('Test reconcile: reserve $0.05, thực tế $0.03 -> delta $0.02 hoàn lại', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 0.10,
    });

    const res = pool.reserveBudget(0.05);
    assert.strictEqual(pool.remainingBalanceUsd, 0.05);

    const reconciled = pool.reconcileBudget(res.id, 0.03);
    assert.strictEqual(reconciled, true);
    // remaining should be 0.05 + 0.02 = 0.07
    assert.strictEqual(pool.remainingBalanceUsd, 0.07);
    assert.strictEqual(pool.totalSpentUsd, 0.03);
  });

  await t.test('Test exhaustion: budget $0.10, 3 lần reserve $0.05 -> lần 3 bị reject', () => {
    const pool = new ApifyTokenPoolManager({
      tokens: ['apify_api_tok1'],
      initialApifyBalance: 0.10,
    });

    pool.reserveBudget(0.05);
    pool.reserveBudget(0.05);

    assert.throws(
      () => pool.reserveBudget(0.05),
      (err) => {
        assert.strictEqual(err.code, 'APIFY_BUDGET_EXCEEDED');
        return true;
      }
    );
  });
});
