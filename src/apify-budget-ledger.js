'use strict';

/**
 * Durable Apify budget ledger (PostgreSQL).
 *
 * Tables: apify_budget_ledger / apify_budget_reservations (src/database/pg-schema.sql).
 *
 * Every mutation is a SINGLE SQL statement (data-modifying CTEs), so each one
 * is atomic on its own and needs no client-side transaction. Admission is the
 * conditional UPDATE in reserve(): under concurrent callers — in this process
 * or any other instance sharing the database — Postgres serialises the row
 * update and re-checks the WHERE clause against the committed row, so the cap
 * can never be overshot.
 *
 * Money flow of one reservation:
 *   reserve  -> spent += estimate            (status 'reserved')
 *   commit   -> actor started, no money move (status 'committed', never refundable)
 *   settle   -> spent += actual - estimate    (status 'settled')
 *   release  -> spent -= estimate            (only from 'reserved': actor never started)
 */

const crypto = require('crypto');

const DEFAULT_LEDGER_KEY = 'global';
const MONEY_DECIMALS = 6;

function toMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(MONEY_DECIMALS)) : 0;
}

function toState(row) {
  if (!row) return null;
  return {
    spentUsd: toMoney(row.spent_usd),
    remainingBalanceUsd: toMoney(row.remaining_balance_usd),
  };
}

function assertMoney(name, value, { allowNegative = false } = {}) {
  const n = Number(value);
  if (typeof value === 'boolean' || value === null || value === '' || !Number.isFinite(n)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if (!allowNegative && n < 0) throw new RangeError(`${name} must be >= 0`);
  return n;
}

const SQL = {
  init: `
    INSERT INTO apify_budget_ledger (key, spent_usd, remaining_balance_usd)
    VALUES ($1, 0, $2::numeric)
    ON CONFLICT (key) DO NOTHING`,

  state: 'SELECT spent_usd, remaining_balance_usd FROM apify_budget_ledger WHERE key = $1',

  reserve: `
    WITH admitted AS (
      UPDATE apify_budget_ledger
         SET spent_usd = spent_usd + $2::numeric,
             remaining_balance_usd = remaining_balance_usd - $2::numeric,
             updated_at = now()
       WHERE key = $1
         AND remaining_balance_usd - $2::numeric >= $3::numeric
         AND ($4::numeric IS NULL OR spent_usd + $2::numeric <= $4::numeric)
      RETURNING key, spent_usd, remaining_balance_usd
    ), inserted AS (
      INSERT INTO apify_budget_reservations (id, ledger_key, estimated_usd, status)
      SELECT $5, key, $2::numeric, 'reserved' FROM admitted
      RETURNING id
    )
    SELECT a.spent_usd, a.remaining_balance_usd, i.id AS reservation_id
      FROM admitted a CROSS JOIN inserted i`,

  commit: `
    UPDATE apify_budget_reservations
       SET status = 'committed', apify_run_id = COALESCE($2, apify_run_id), updated_at = now()
     WHERE id = $1 AND status = 'reserved'
    RETURNING id`,

  // Adjust spend by (actual - estimate). Never refunds more than was spent.
  settle: `
    WITH r AS (
      UPDATE apify_budget_reservations
         SET status = 'settled', actual_usd = $2::numeric,
             apify_run_id = COALESCE($3, apify_run_id), updated_at = now()
       WHERE id = $1 AND status IN ('reserved', 'committed')
      RETURNING ledger_key, $2::numeric - estimated_usd AS delta
    )
    UPDATE apify_budget_ledger l
       SET spent_usd = GREATEST(0, l.spent_usd + r.delta),
           remaining_balance_usd = l.remaining_balance_usd - r.delta,
           updated_at = now()
      FROM r
     WHERE l.key = r.ledger_key
    RETURNING l.spent_usd, l.remaining_balance_usd`,

  // Only a reservation whose actor never started may be refunded.
  release: `
    WITH r AS (
      UPDATE apify_budget_reservations
         SET status = 'released', updated_at = now()
       WHERE id = $1 AND status = 'reserved'
      RETURNING ledger_key, estimated_usd
    )
    UPDATE apify_budget_ledger l
       SET spent_usd = GREATEST(0, l.spent_usd - r.estimated_usd),
           remaining_balance_usd = l.remaining_balance_usd + r.estimated_usd,
           updated_at = now()
      FROM r
     WHERE l.key = r.ledger_key
    RETURNING l.spent_usd, l.remaining_balance_usd`,

  update: `
    UPDATE apify_budget_ledger
       SET remaining_balance_usd = COALESCE($2::numeric, remaining_balance_usd),
           spent_usd = CASE WHEN $3::boolean THEN 0 ELSE spent_usd END,
           updated_at = now()
     WHERE key = $1
    RETURNING spent_usd, remaining_balance_usd`,
};

/**
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: object[] }> }} db
 * @param {{ key?: string }} [options]
 */
function createApifyBudgetLedger(db, options = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('createApifyBudgetLedger: db must expose query(text, values)');
  }
  const key = String(options.key || DEFAULT_LEDGER_KEY);

  async function first(sql, values) {
    const res = await db.query(sql, values);
    return res.rows[0] || null;
  }

  return {
    kind: 'postgres',
    key,

    /** Seeds the ledger row once; an existing row (prior spend) is kept. */
    async init({ initialBalanceUsd = 0 } = {}) {
      const balance = assertMoney('initialBalanceUsd', initialBalanceUsd, { allowNegative: true });
      await db.query(SQL.init, [key, balance]);
      return toState(await first(SQL.state, [key]));
    },

    async getState() {
      return toState(await first(SQL.state, [key]));
    },

    /**
     * Atomically admits `amountUsd` against the cap and the balance floor.
     * @returns {Promise<{ ok: boolean, reservationId: string|null, state: object|null }>}
     */
    async reserve({ amountUsd, budgetLimitUsd = null, minBalanceUsd = 0 }) {
      const amount = assertMoney('amountUsd', amountUsd);
      const cap = budgetLimitUsd === null || budgetLimitUsd === Infinity
        ? null
        : assertMoney('budgetLimitUsd', budgetLimitUsd, { allowNegative: true });
      const floor = assertMoney('minBalanceUsd', minBalanceUsd, { allowNegative: true });
      const id = `res-${crypto.randomUUID()}`;

      const row = await first(SQL.reserve, [key, amount, floor, cap, id]);
      if (row) return { ok: true, reservationId: row.reservation_id, state: toState(row) };
      return { ok: false, reservationId: null, state: await this.getState() };
    },

    /** Marks the actor as started. Returns true when the status changed. */
    async commit(reservationId, runId = null) {
      const row = await first(SQL.commit, [String(reservationId), runId === null ? null : String(runId)]);
      return Boolean(row);
    },

    /** Returns the new ledger state, or null when already settled/released. */
    async settle(reservationId, actualUsd, runId = null) {
      const actual = assertMoney('actualUsd', actualUsd);
      const row = await first(SQL.settle, [String(reservationId), actual, runId === null ? null : String(runId)]);
      return toState(row);
    },

    /** Returns the new ledger state, or null when not refundable. */
    async release(reservationId) {
      return toState(await first(SQL.release, [String(reservationId)]));
    },

    /** Admin adjustment: absolute balance and/or spend reset. */
    async update({ remainingBalanceUsd, resetSpent = false } = {}) {
      const balance = remainingBalanceUsd === undefined
        ? null
        : assertMoney('remainingBalanceUsd', remainingBalanceUsd, { allowNegative: true });
      return toState(await first(SQL.update, [key, balance, resetSpent === true]));
    },
  };
}

module.exports = {
  createApifyBudgetLedger,
  DEFAULT_LEDGER_KEY,
};
