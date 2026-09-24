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
 * The spend cap and balance floor are stored on the ledger row too, so an
 * admin change is durable and binds every instance; the caller's values are
 * only a fallback for a row that has none configured.
 *
 * Money flow of one reservation:
 *   reserve  -> spent += estimate            (status 'reserved')
 *   commit   -> actor started, no money move (status 'committed', never refundable)
 *   settle   -> spent += actual - estimate    (status 'settled')
 *   release  -> spent -= estimate            (only from 'reserved': actor never started)
 * A 'committed' reservation with an apify_run_id whose final cost was not
 * known locally (run still RUNNING) is settled later by reconciliation.
 */

const crypto = require('crypto');

const DEFAULT_LEDGER_KEY = 'global';
const MONEY_DECIMALS = 6;
const DEFAULT_PENDING_LIMIT = 100;

function toMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(MONEY_DECIMALS)) : 0;
}

function toNullableMoney(value) {
  return value === null || value === undefined ? null : toMoney(value);
}

function toState(row) {
  if (!row) return null;
  return {
    spentUsd: toMoney(row.spent_usd),
    remainingBalanceUsd: toMoney(row.remaining_balance_usd),
    seedBalanceUsd: toNullableMoney(row.seed_balance_usd),
    // null = not configured on the row (the caller's default applies)
    budgetLimitUsd: toNullableMoney(row.budget_limit_usd),
    minBalanceUsd: toNullableMoney(row.min_balance_usd),
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

/** null/undefined/Infinity = "not configured". */
function optionalMoney(name, value) {
  if (value === undefined || value === null || value === Infinity) return null;
  return assertMoney(name, value, { allowNegative: true });
}

const STATE_COLUMNS = 'spent_usd, remaining_balance_usd, seed_balance_usd, budget_limit_usd, min_balance_usd';
const L_STATE_COLUMNS = STATE_COLUMNS.split(', ').map((c) => `l.${c}`).join(', ');

/** SET clause pair: apply an explicit value only when it differs from its seed. */
function seededAssignment(column, seedColumn, param) {
  const changed = `${param}::numeric IS NOT NULL AND ${param}::numeric IS DISTINCT FROM ${seedColumn}`;
  return `${column} = CASE WHEN ${changed} THEN ${param}::numeric ELSE ${column} END,
           ${seedColumn} = CASE WHEN ${changed} THEN ${param}::numeric ELSE ${seedColumn} END`;
}

const SQL = {
  init: `
    INSERT INTO apify_budget_ledger
      (key, spent_usd, remaining_balance_usd, seed_balance_usd,
       budget_limit_usd, budget_limit_seed_usd, min_balance_usd, min_balance_seed_usd)
    VALUES ($1, 0, $2::numeric, $2::numeric, $3::numeric, $3::numeric, $4::numeric, $4::numeric)
    ON CONFLICT (key) DO NOTHING`,

  // Applies EXPLICIT configuration to an existing row, but only a value that
  // differs from the one last applied: a restart with unchanged env keeps the
  // tracked balance and any admin override, while an operator changing the
  // env value takes effect. Spend is never touched. $3 = balance explicit.
  applyConfig: `
    UPDATE apify_budget_ledger
       SET remaining_balance_usd = CASE WHEN $3::boolean AND $2::numeric IS DISTINCT FROM seed_balance_usd
                                        THEN $2::numeric ELSE remaining_balance_usd END,
           seed_balance_usd      = CASE WHEN $3::boolean AND $2::numeric IS DISTINCT FROM seed_balance_usd
                                        THEN $2::numeric ELSE seed_balance_usd END,
           ${seededAssignment('budget_limit_usd', 'budget_limit_seed_usd', '$4')},
           ${seededAssignment('min_balance_usd', 'min_balance_seed_usd', '$5')},
           updated_at = now()
     WHERE key = $1
    RETURNING ${STATE_COLUMNS}`,

  state: `SELECT ${STATE_COLUMNS} FROM apify_budget_ledger WHERE key = $1`,

  // Cap/floor come from the row; $3/$4 are only fallbacks when the row has none.
  reserve: `
    WITH admitted AS (
      UPDATE apify_budget_ledger
         SET spent_usd = spent_usd + $2::numeric,
             remaining_balance_usd = remaining_balance_usd - $2::numeric,
             updated_at = now()
       WHERE key = $1
         AND remaining_balance_usd - $2::numeric >= COALESCE(min_balance_usd, $3::numeric)
         AND (COALESCE(budget_limit_usd, $4::numeric) IS NULL
              OR spent_usd + $2::numeric <= COALESCE(budget_limit_usd, $4::numeric))
      RETURNING key, ${STATE_COLUMNS}
    ), inserted AS (
      INSERT INTO apify_budget_reservations (id, ledger_key, estimated_usd, status)
      SELECT $5, key, $2::numeric, 'reserved' FROM admitted
      RETURNING id
    )
    SELECT a.*, i.id AS reservation_id
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
    RETURNING ${L_STATE_COLUMNS}`,

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
    RETURNING ${L_STATE_COLUMNS}`,

  update: `
    UPDATE apify_budget_ledger
       SET remaining_balance_usd = COALESCE($2::numeric, remaining_balance_usd),
           spent_usd = CASE WHEN $3::boolean THEN 0 ELSE spent_usd END,
           budget_limit_usd = COALESCE($4::numeric, budget_limit_usd),
           min_balance_usd = COALESCE($5::numeric, min_balance_usd),
           updated_at = now()
     WHERE key = $1
    RETURNING ${STATE_COLUMNS}`,

  // Runs that STARTED but whose final cost is not yet recorded (e.g. still
  // RUNNING when this process stopped polling). Settled by reconciliation.
  pendingRuns: `
    SELECT id, apify_run_id, estimated_usd
      FROM apify_budget_reservations
     WHERE ledger_key = $1 AND status = 'committed' AND apify_run_id IS NOT NULL
     ORDER BY created_at
     LIMIT $2`,
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

    /**
     * Creates the ledger row if missing (prior spend is always kept), then
     * applies explicitly configured values that differ from the last seed:
     * - initialBalanceUsd re-seeds the balance only when balanceExplicit;
     * - budgetLimitUsd / minBalanceUsd (null = not configured) override the
     *   stored value only when they differ from the last configured value,
     *   so admin updates survive restarts until the env value changes.
     */
    async init({ initialBalanceUsd = 0, balanceExplicit = false, budgetLimitUsd = null, minBalanceUsd = null } = {}) {
      const balance = assertMoney('initialBalanceUsd', initialBalanceUsd, { allowNegative: true });
      const cap = optionalMoney('budgetLimitUsd', budgetLimitUsd);
      const floor = optionalMoney('minBalanceUsd', minBalanceUsd);
      await db.query(SQL.init, [key, balance, cap, floor]);
      const before = toState(await first(SQL.state, [key]));
      const after = toState(await first(SQL.applyConfig, [key, balance, balanceExplicit === true, cap, floor]));
      if (before && after && before.seedBalanceUsd !== after.seedBalanceUsd) {
        console.warn(
          `[ApifyBudget] Re-seeded ledger "${key}" balance from explicit APIFY_INITIAL_BALANCE_USD: `
          + `seed $${before.seedBalanceUsd} -> $${after.seedBalanceUsd}, `
          + `balance $${before.remainingBalanceUsd} -> $${after.remainingBalanceUsd} (spend kept at $${after.spentUsd})`
        );
      }
      return after;
    },

    async getState() {
      return toState(await first(SQL.state, [key]));
    },

    /**
     * Atomically admits `amountUsd` against the cap and the balance floor
     * (row values first; the arguments are fallbacks for an unconfigured row).
     * @returns {Promise<{ ok: boolean, reservationId: string|null, state: object|null }>}
     */
    async reserve({ amountUsd, budgetLimitUsd = null, minBalanceUsd = 0 }) {
      const amount = assertMoney('amountUsd', amountUsd);
      const cap = optionalMoney('budgetLimitUsd', budgetLimitUsd);
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

    /** Admin adjustment: balance, spend reset, cap and floor (undefined = unchanged). */
    async update({ remainingBalanceUsd, resetSpent = false, budgetLimitUsd, minBalanceUsd } = {}) {
      const balance = remainingBalanceUsd === undefined
        ? null
        : assertMoney('remainingBalanceUsd', remainingBalanceUsd, { allowNegative: true });
      const cap = budgetLimitUsd === undefined ? null : assertMoney('budgetLimitUsd', budgetLimitUsd, { allowNegative: true });
      const floor = minBalanceUsd === undefined ? null : assertMoney('minBalanceUsd', minBalanceUsd, { allowNegative: true });
      return toState(await first(SQL.update, [key, balance, resetSpent === true, cap, floor]));
    },

    /** Committed reservations with a known Apify run id (final cost pending). */
    async listPendingRuns({ limit = DEFAULT_PENDING_LIMIT } = {}) {
      const bounded = Math.max(1, Math.trunc(Number(limit)) || DEFAULT_PENDING_LIMIT);
      const res = await db.query(SQL.pendingRuns, [key, bounded]);
      return res.rows.map((row) => ({
        reservationId: row.id,
        apifyRunId: row.apify_run_id,
        estimatedUsd: toMoney(row.estimated_usd),
      }));
    },
  };
}

module.exports = {
  createApifyBudgetLedger,
  DEFAULT_LEDGER_KEY,
};
