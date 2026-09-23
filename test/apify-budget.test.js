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
});
