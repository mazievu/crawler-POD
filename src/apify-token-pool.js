/**
 * Apify Token Pool Manager — High Availability & Auto-Failover
 * Manages rotation across multiple Apify API tokens.
 * Automatically rotates to the next available token on:
 * - 401 Unauthorized / Invalid Token
 * - 402 Payment Required / Monthly Cap Reached / Usage Limit Exceeded
 * - 429 Too Many Requests / Rate Limited
 */

const fs = require('fs');
const path = require('path');
const { ApifyClient } = require('apify-client');

// Allow tests (and any hermetic subprocess) to override where the token
// pool persists its state, so they never read or write the real
// data/apify_tokens.json used by a developer's local run.
const DEFAULT_CONFIG_PATH = process.env.APIFY_TOKENS_PATH
  ? path.resolve(process.env.APIFY_TOKENS_PATH)
  : path.join(process.cwd(), 'data', 'apify_tokens.json');

const AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid token/i,
  /token is invalid/i,
  /authentication failed/i,
  /cannot authenticate/i,
  /user not found/i,
];

const QUOTA_PATTERNS = [
  /payment required/i,
  /usage limit exceeded/i,
  /monthly usage limit/i,
  // Apify's real wording once an account crosses maxMonthlyUsageUsd is
  // "Monthly usage hard limit exceeded" — observed on run #100 (tiktok_shop,
  // 2026-09-07) while /v2/users/me/limits reported monthlyUsageUsd 5.0150
  // against maxMonthlyUsageUsd 5. The word "hard" sits between "usage" and
  // "limit", so neither /monthly usage limit/ nor /usage limit exceeded/
  // matched. The failure was therefore classified as no-error: the drained
  // token was recorded as successful instead of quarantined, and the pool kept
  // handing it out while two sibling tokens still held ~$4.50 of budget.
  /monthly usage\b.*\blimit exceeded/i,
  /hard limit exceeded/i,
  /monthly cap reached/i,
  /out of credit/i,
  /free usage tier limit/i,
  /not enough prepaid usage/i,
  /exceeded maximum allowable usage/i,
  /insufficient funds/i,
  /account is suspended/i,
];

const RATE_LIMIT_PATTERNS = [
  /too many requests/i,
  /rate limit/i,
  /rate-limit/i,
  /quota exceeded/i,
];

function maskToken(token) {
  if (!token || typeof token !== 'string') return '';
  const trimmed = token.trim();
  if (trimmed.length <= 8) return '****';
  return trimmed.slice(0, 7) + '...' + trimmed.slice(-4);
}

function parseTokenSignal(signal) {
  if (!signal) return { isError: false };

  const status = typeof signal === 'number' 
    ? signal 
    : (typeof signal.status === 'number' ? signal.status : (signal.statusCode || null));
  
  const message = typeof signal === 'number' ? '' : String(signal.message || signal.error || signal || '');

  if (status === 401 || AUTH_PATTERNS.some(pat => pat.test(message))) {
    return { isError: true, type: 'INVALID', reason: message || 'HTTP 401 Unauthorized' };
  }

  if (status === 402 || QUOTA_PATTERNS.some(pat => pat.test(message))) {
    return { isError: true, type: 'EXHAUSTED', reason: message || 'HTTP 402 Payment Required / Out of Credit' };
  }

  if (status === 429 || RATE_LIMIT_PATTERNS.some(pat => pat.test(message))) {
    return { isError: true, type: 'RATE_LIMITED', reason: message || 'HTTP 429 Too Many Requests' };
  }

  return { isError: false };
}

const DEFAULT_ESTIMATED_RUN_COST_USD = 0.05;
const DEFAULT_INITIAL_BALANCE_USD = 100.0;
const USD_DECIMALS = 4;

function roundUsd(value) {
  return Number(Number(value).toFixed(USD_DECIMALS));
}

function isPositiveUsd(value) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * A zero, negative or non-numeric estimate would let runs through the cap for
 * free, so anything but a positive finite number falls back to the default.
 */
function resolveEstimateConfig(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ESTIMATED_RUN_COST_USD;
  if (isPositiveUsd(raw)) return Number(raw);
  console.warn(`[ApifyTokenPool] Ignoring invalid APIFY_DEFAULT_RUN_COST_USD "${raw}"; using $${DEFAULT_ESTIMATED_RUN_COST_USD}`);
  return DEFAULT_ESTIMATED_RUN_COST_USD;
}

/**
 * Per-attempt record of what a paid-actor callback reported back to the pool.
 * `started` is what decides between refund (release) and settlement.
 */
function createRunTracker() {
  return { started: false, runId: null, costUsd: null, costFinal: false, commitPromise: null };
}

/** Folds a callback's return value into the tracker (legacy cost/runId fields). */
function absorbResult(tracker, result) {
  // A callback that returned normally may well have started a paid actor
  // without saying so; assume it did — over-counting is the safe direction.
  tracker.started = true;
  if (result && typeof result === 'object') {
    const runId = result.backendRunId || result.runId;
    if (runId && !tracker.runId) tracker.runId = String(runId);
    const cost = typeof result.cost === 'number' ? result.cost : result.costUsd;
    if (cost !== undefined && cost !== null && Number.isFinite(Number(cost)) && Number(cost) >= 0) {
      tracker.costUsd = Number(cost);
      tracker.costFinal = true;
    }
  }
}

/** Final settlement amount: real usage when final, never below the estimate otherwise. */
function settlementAmount(tracker, estimate) {
  if (tracker.costUsd === null) return estimate;
  if (tracker.costFinal) return tracker.costUsd;
  return Math.max(estimate, tracker.costUsd);
}

function budgetUpdateError(message) {
  const err = new Error(message);
  err.status = 400;
  err.statusCode = 400;
  err.code = 'INVALID_BUDGET_UPDATE';
  return err;
}

/**
 * Custom Error for Apify Budget Exceeded (Feature 12)
 */
class ApifyBudgetExceededError extends Error {
  constructor(message = 'Apify account budget limit reached or token balance zero', details = {}) {
    super(message);
    this.name = 'ApifyBudgetExceededError';
    this.code = 'APIFY_BUDGET_EXCEEDED';
    this.status = 402;
    this.statusCode = 402;
    this.remainingBalance = details.remainingBalance ?? 0.0;
    this.budgetLimit = details.budgetLimit ?? null;
    this.threshold = details.threshold ?? 0.0;
  }
}

class ApifyTokenPoolManager {
  constructor(options = {}) {
    this.configPath = options.configPath || DEFAULT_CONFIG_PATH;
    this.rateLimitCooldownMs = Number(options.rateLimitCooldownMs) || 600000; // 10 minutes default
    this.exhaustedCooldownMs = Number(options.exhaustedCooldownMs) || 86400000; // 24 hours default
    this.failureThreshold = Number(options.failureThreshold) || 2;
    this.maxTokenRotations = Number(options.maxTokenRotations) || 5;

    // Feature 12: Apify Budget Kill Switch Configuration
    this.minBalanceThresholdUsd = options.minBalanceThresholdUsd !== undefined
      ? Number(options.minBalanceThresholdUsd)
      : (process.env.APIFY_MIN_BALANCE_USD !== undefined ? Number(process.env.APIFY_MIN_BALANCE_USD) : 0.0);

    this.budgetLimitUsd = options.budgetLimitUsd !== undefined
      ? Number(options.budgetLimitUsd)
      : (process.env.APIFY_BUDGET_LIMIT_USD ? Number(process.env.APIFY_BUDGET_LIMIT_USD) : Infinity);

    const envInitial = process.env.APIFY_INITIAL_BALANCE_USD !== undefined ? Number(process.env.APIFY_INITIAL_BALANCE_USD) : null;
    const optInitial = options.initialApifyBalance !== undefined ? Number(options.initialApifyBalance) : null;
    this.remainingBalanceUsd = optInitial !== null ? optInitial : (envInitial !== null ? envInitial : DEFAULT_INITIAL_BALANCE_USD);

    // What the durable ledger may apply at attach time. Only EXPLICITLY
    // configured values (option or env) override the stored row; a default
    // never does, so a restart without config keeps tracked balance/limits.
    this._ledgerSeed = {
      initialBalanceUsd: this.remainingBalanceUsd,
      balanceExplicit: optInitial !== null || envInitial !== null,
      budgetLimitUsd: this.budgetLimitUsd === Infinity ? null : this.budgetLimitUsd,
      minBalanceUsd: options.minBalanceThresholdUsd !== undefined || process.env.APIFY_MIN_BALANCE_USD !== undefined
        ? this.minBalanceThresholdUsd
        : null,
    };

    this.defaultRunCostUsd = Number(options.defaultRunCostUsd || process.env.APIFY_DEFAULT_RUN_COST_USD || 1.0);
    this.totalSpentUsd = 0.0;
    this.lastBudgetSyncAt = null;
    this.syncIntervalMs = Number(options.syncIntervalMs) || 300000;

    // Amount reserved (and, once the actor starts, committed as spend) for a
    // paid run whose real cost is not yet known. APIFY_DEFAULT_RUN_COST_USD.
    this.defaultEstimatedCostUsd = resolveEstimateConfig(
      options.defaultEstimatedCostUsd !== undefined
        ? options.defaultEstimatedCostUsd
        : process.env.APIFY_DEFAULT_RUN_COST_USD
    );
    // In-memory reservations: used ONLY when no durable ledger is attached
    // (unit tests / tooling). Production attaches the Postgres ledger at boot.
    this.reservations = new Map();
    this.reservationCounter = 0;
    this.budgetLedger = null;
    this._ledgerReady = null;
    if (options.budgetLedger) this.attachBudgetLedger(options.budgetLedger);

    this.tokens = new Map(); // id -> token record
    this.clients = new Map(); // id -> ApifyClient instance
    this.currentIndex = 0;

    if (Array.isArray(options.tokens)) {
      this.initFromList(options.tokens);
    } else {
      this.load();
    }
  }

  /**
   * Checks whether Apify budget is available for paid actor execution.
   */
  checkBudget(options = {}) {
    const cost = options.cost !== undefined ? Number(options.cost) : this.defaultRunCostUsd;
    const balance = Number(this.remainingBalanceUsd);
    const threshold = Number(this.minBalanceThresholdUsd);

    if (balance <= threshold) {
      return {
        allowed: false,
        remainingBalance: balance,
        budgetLimit: this.budgetLimitUsd,
        totalSpent: this.totalSpentUsd,
        threshold,
        reason: 'APIFY_BUDGET_EXCEEDED',
        message: 'Apify account budget limit reached or token balance zero',
      };
    }

    if (this.budgetLimitUsd !== Infinity && (this.totalSpentUsd + cost) > this.budgetLimitUsd) {
      return {
        allowed: false,
        remainingBalance: balance,
        budgetLimit: this.budgetLimitUsd,
        totalSpent: this.totalSpentUsd,
        threshold,
        reason: 'APIFY_BUDGET_EXCEEDED',
        message: `Configured budget limit of $${this.budgetLimitUsd} reached`,
      };
    }

    return {
      allowed: true,
      remainingBalance: balance,
      budgetLimit: this.budgetLimitUsd,
      totalSpent: this.totalSpentUsd,
      threshold,
    };
  }

  /**
   * Asserts that budget is available; throws ApifyBudgetExceededError (402) if not.
   */
  assertBudgetAvailable(options = {}) {
    const check = this.checkBudget(options);
    if (!check.allowed) {
      throw new ApifyBudgetExceededError(check.message, check);
    }
    return check;
  }

  /**
   * Atomically deducts run cost from remaining budget and increments total spend.
   */
  deductBudget(amount = null) {
    const cost = amount !== null ? Number(amount) : this.defaultRunCostUsd;
    if (this.remainingBalanceUsd !== null && this.remainingBalanceUsd !== undefined) {
      const nextBalance = this.remainingBalanceUsd - cost;
      this.remainingBalanceUsd = Number(Math.max(0, nextBalance).toFixed(4));
    }
    this.totalSpentUsd = Number((this.totalSpentUsd + cost).toFixed(4));
    return this.remainingBalanceUsd;
  }

  /**
   * Reserves a budget amount before an operation.
   * Throws APIFY_BUDGET_EXCEEDED if budget is insufficient.
   */
  reserveBudget(estimatedCostUsd) {
    const cost = estimatedCostUsd !== undefined ? Number(estimatedCostUsd) : this.defaultEstimatedCostUsd;
    
    const balance = Number(this.remainingBalanceUsd);
    const threshold = Number(this.minBalanceThresholdUsd);

    if (balance - cost < threshold) {
      throw new ApifyBudgetExceededError('Apify account budget limit reached or token balance zero', {
        remainingBalance: balance,
        budgetLimit: this.budgetLimitUsd,
        threshold,
      });
    }

    if (this.budgetLimitUsd !== Infinity && (this.totalSpentUsd + cost) > this.budgetLimitUsd) {
      throw new ApifyBudgetExceededError(`Configured budget limit of $${this.budgetLimitUsd} reached`, {
        remainingBalance: balance,
        budgetLimit: this.budgetLimitUsd,
        threshold,
      });
    }

    // Deduct immediately
    this.remainingBalanceUsd = Number(Math.max(0, balance - cost).toFixed(4));
    this.totalSpentUsd = Number((this.totalSpentUsd + cost).toFixed(4));

    this.reservationCounter++;
    const id = `res-${this.reservationCounter}-${Date.now()}`;
    const reservation = { id, amount: cost, createdAt: Date.now() };
    this.reservations.set(id, reservation);

    return reservation;
  }

  /**
   * Releases a previously reserved budget.
   */
  releaseBudget(reservationId) {
    const res = this.reservations.get(reservationId);
    // A committed reservation belongs to an actor that STARTED: that money is
    // spent on Apify's side and must never be refunded here.
    if (!res || res.committed) return false;

    this.remainingBalanceUsd = Number((this.remainingBalanceUsd + res.amount).toFixed(4));
    this.totalSpentUsd = Number(Math.max(0, this.totalSpentUsd - res.amount).toFixed(4));
    this.reservations.delete(reservationId);
    return true;
  }

  /**
   * Reconciles a reservation with actual cost.
   */
  reconcileBudget(reservationId, actualCostUsd) {
    const res = this.reservations.get(reservationId);
    if (!res) return false;

    const actual = Number(actualCostUsd);
    const delta = res.amount - actual;

    // Refund the difference
    this.remainingBalanceUsd = Number((this.remainingBalanceUsd + delta).toFixed(4));
    this.totalSpentUsd = Number(Math.max(0, this.totalSpentUsd - delta).toFixed(4));
    this.reservations.delete(reservationId);
    return true;
  }

  /**
   * Dynamically updates budget limit or balance (Admin controls).
   */
  setBudget(options = {}) {
    if (options.budgetLimitUsd !== undefined) {
      this.budgetLimitUsd = Number(options.budgetLimitUsd);
    }
    if (options.minBalanceThresholdUsd !== undefined) {
      this.minBalanceThresholdUsd = Number(options.minBalanceThresholdUsd);
    }
    if (options.remainingBalanceUsd !== undefined) {
      this.remainingBalanceUsd = Number(options.remainingBalanceUsd);
    }
    if (options.resetSpent === true) {
      this.totalSpentUsd = 0.0;
    }
    return this.getBudgetStatus();
  }

  getBudgetStatus() {
    const isExhausted = this.remainingBalanceUsd <= this.minBalanceThresholdUsd ||
      (this.budgetLimitUsd !== Infinity && this.totalSpentUsd >= this.budgetLimitUsd);

    return {
      budgetLimitUsd: this.budgetLimitUsd === Infinity ? null : this.budgetLimitUsd,
      remainingBalanceUsd: this.remainingBalanceUsd,
      minBalanceThresholdUsd: this.minBalanceThresholdUsd,
      totalSpentUsd: this.totalSpentUsd,
      isExhausted,
      status: isExhausted ? 'EXHAUSTED' : (this.remainingBalanceUsd <= 5.0 ? 'LOW_BALANCE' : 'HEALTHY'),
      lastSyncAt: this.lastBudgetSyncAt,
    };
  }

  // ==================== Durable ledger (Postgres) ====================

  /**
   * Makes the DB ledger the source of truth for spend/balance. Without one,
   * the pool falls back to in-process fields (unit tests / tooling only):
   * that fallback resets on restart and is not shared across instances.
   */
  attachBudgetLedger(ledger) {
    this.budgetLedger = ledger || null;
    this._ledgerReady = null;
    return this;
  }

  async _ensureLedger() {
    if (!this.budgetLedger) return null;
    if (!this._ledgerReady) {
      this._ledgerReady = this.budgetLedger
        .init({ ...this._ledgerSeed })
        .then((state) => { this._applyLedgerState(state); })
        .catch((err) => { this._ledgerReady = null; throw err; });
    }
    await this._ledgerReady;
    return this.budgetLedger;
  }

  _applyLedgerState(state) {
    if (state) {
      this.totalSpentUsd = roundUsd(state.spentUsd);
      this.remainingBalanceUsd = roundUsd(state.remainingBalanceUsd);
      // The row's cap/floor win (durable, cluster-wide); null = not configured
      // there, so the locally configured value stays in effect.
      if (state.budgetLimitUsd !== null && state.budgetLimitUsd !== undefined) {
        this.budgetLimitUsd = state.budgetLimitUsd;
      }
      if (state.minBalanceUsd !== null && state.minBalanceUsd !== undefined) {
        this.minBalanceThresholdUsd = state.minBalanceUsd;
      }
      this.lastBudgetSyncAt = new Date().toISOString();
    }
    return this.getBudgetStatus();
  }

  /** Refreshes the cached spend/balance from the ledger (no-op in memory mode). */
  async syncBudgetFromLedger() {
    const ledger = await this._ensureLedger();
    if (!ledger) return this.getBudgetStatus();
    return this._applyLedgerState(await ledger.getState());
  }

  /**
   * Admin budget update that is persisted when a ledger is attached. Same
   * input/output shape as setBudget(); rejects non-numeric values (400).
   * With a ledger the DB write happens FIRST (balance, spend reset, cap and
   * floor in one statement) and memory is only updated from its result, so a
   * failed write leaves this instance unchanged.
   */
  async applyBudgetUpdate(options = {}) {
    const input = options && typeof options === 'object' ? options : {};
    for (const field of ['budgetLimitUsd', 'minBalanceThresholdUsd', 'remainingBalanceUsd']) {
      const value = input[field];
      if (value === undefined) continue;
      if (typeof value === 'boolean' || value === null || value === '' || !Number.isFinite(Number(value))) {
        throw budgetUpdateError(`${field} must be a finite number`);
      }
    }

    const ledger = await this._ensureLedger();
    if (!ledger) return this.setBudget(input);

    const state = await ledger.update({
      remainingBalanceUsd: input.remainingBalanceUsd,
      resetSpent: input.resetSpent === true,
      budgetLimitUsd: input.budgetLimitUsd,
      minBalanceUsd: input.minBalanceThresholdUsd,
    });
    if (!state) throw new Error(`Apify budget ledger row "${ledger.key}" not found`);
    return this._applyLedgerState(state);
  }

  _budgetExceeded(cost) {
    const details = {
      remainingBalance: this.remainingBalanceUsd,
      budgetLimit: this.budgetLimitUsd,
      threshold: this.minBalanceThresholdUsd,
    };
    const overCap = this.budgetLimitUsd !== Infinity && (this.totalSpentUsd + cost) > this.budgetLimitUsd;
    const message = overCap
      ? `Configured budget limit of $${this.budgetLimitUsd} reached`
      : 'Apify account budget limit reached or token balance zero';
    return new ApifyBudgetExceededError(message, details);
  }

  /** Reserves `estimate` for one paid-actor attempt; throws APIFY_BUDGET_EXCEEDED. */
  async _openReservation(estimate) {
    const ledger = await this._ensureLedger();
    if (!ledger) {
      const res = this.reserveBudget(estimate);
      return { id: res.id, amount: res.amount, ledger: null };
    }

    const outcome = await ledger.reserve({
      amountUsd: estimate,
      budgetLimitUsd: this.budgetLimitUsd === Infinity ? null : this.budgetLimitUsd,
      minBalanceUsd: this.minBalanceThresholdUsd,
    });
    this._applyLedgerState(outcome.state);
    if (!outcome.ok) throw this._budgetExceeded(estimate);
    return { id: outcome.reservationId, amount: estimate, ledger };
  }

  /** Actor started: the reservation becomes non-refundable spend. */
  async _commitReservation(reservation, runId) {
    if (!reservation.ledger) {
      const res = this.reservations.get(reservation.id);
      if (res) res.committed = true;
      return;
    }
    await reservation.ledger.commit(reservation.id, runId);
  }

  /** Adjusts spend from the estimate to the settled amount. */
  async _settleReservation(reservation, tracker) {
    const amount = settlementAmount(tracker, reservation.amount);
    try {
      if (tracker.commitPromise) await tracker.commitPromise;
      if (!reservation.ledger) {
        this.reconcileBudget(reservation.id, amount);
        return;
      }
      this._applyLedgerState(await reservation.ledger.settle(reservation.id, amount, tracker.runId));
    } catch (err) {
      // The estimate stays counted as spend (over-counting is the safe side).
      console.error(`[ApifyTokenPool] Budget settlement failed for ${reservation.id}: ${err.message}`);
    }
  }

  /** Refunds a reservation whose actor never started. */
  async _releaseReservation(reservation) {
    try {
      if (!reservation.ledger) {
        this.releaseBudget(reservation.id);
        return;
      }
      this._applyLedgerState(await reservation.ledger.release(reservation.id));
    } catch (err) {
      console.error(`[ApifyTokenPool] Budget release failed for ${reservation.id}: ${err.message}`);
    }
  }

  /** The admission handed to a callback, plus hooks to report start and cost. */
  _buildRunAdmission(admission, reservation, tracker) {
    return {
      ...admission,
      reportActorStarted: (runId) => {
        tracker.started = true;
        if (runId) tracker.runId = String(runId);
        if (!tracker.commitPromise) {
          tracker.commitPromise = this._commitReservation(reservation, tracker.runId).catch((err) => {
            console.error(`[ApifyTokenPool] Budget commit failed for ${reservation.id}: ${err.message}`);
          });
        }
      },
      reportRunCost: (usd, { final = false } = {}) => {
        const n = Number(usd);
        if (usd === null || usd === undefined || !Number.isFinite(n) || n < 0) return;
        tracker.costUsd = n;
        tracker.costFinal = Boolean(final);
      },
    };
  }

  load() {
    this.tokens.clear();
    this.clients.clear();
    const tokenList = [];

    // 1. From environment: APIFY_TOKENS (comma, semicolon, or newline separated)
    if (process.env.APIFY_TOKENS) {
      const parts = process.env.APIFY_TOKENS.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
      tokenList.push(...parts);
    }

    // 2. From environment: single APIFY_TOKEN
    if (process.env.APIFY_TOKEN && !tokenList.includes(process.env.APIFY_TOKEN.trim())) {
      tokenList.push(process.env.APIFY_TOKEN.trim());
    }

    // 3. From config file data/apify_tokens.json if exists
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.tokens)) {
          for (const item of parsed.tokens) {
            const tok = typeof item === 'string' ? item.trim() : (item.token ? item.token.trim() : '');
            if (tok && !tokenList.includes(tok)) {
              tokenList.push(tok);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[ApifyTokenPool] Failed to read token config file:', err.message);
    }

    this.initFromList(tokenList);
  }

  initFromList(list) {
    this.tokens.clear();
    this.clients.clear();

    const seen = new Set();
    let idx = 1;

    for (const item of list) {
      const token = typeof item === 'string' ? item.trim() : (item.token ? String(item.token).trim() : '');
      if (!token || seen.has(token) || /placeholder|your_apify_token/i.test(token)) continue;
      seen.add(token);

      const id = (typeof item === 'object' && item.id) ? String(item.id) : `token-${idx}`;
      const record = {
        id,
        token,
        label: maskToken(token),
        state: 'HEALTHY',
        consecutiveFailures: 0,
        blockedUntil: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
        lastBlockReason: null,
        usageCount: 0
      };

      this.tokens.set(id, record);
      this.clients.set(id, new ApifyClient({ token }));
      idx++;
    }
  }

  addToken(token, id = null) {
    if (!token || typeof token !== 'string') return null;
    const trimmed = token.trim();
    if (!trimmed) return null;

    const assignedId = id ? String(id) : `token-${this.tokens.size + 1}`;
    const record = {
      id: assignedId,
      token: trimmed,
      label: maskToken(trimmed),
      state: 'HEALTHY',
      consecutiveFailures: 0,
      blockedUntil: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastBlockReason: null,
      usageCount: 0
    };

    this.tokens.set(assignedId, record);
    this.clients.set(assignedId, new ApifyClient({ token: trimmed }));
    return record;
  }

  saveToFile() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tokensToSave = [];
      for (const rec of this.tokens.values()) {
        tokensToSave.push({
          id: rec.id,
          token: rec.token,
          label: rec.label,
          addedAt: rec.addedAt || new Date().toISOString()
        });
      }
      fs.writeFileSync(this.configPath, JSON.stringify({ tokens: tokensToSave }, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.warn('[ApifyTokenPool] Failed to save token config file:', err.message);
      return false;
    }
  }

  addAndPersistToken(token, customLabel = null) {
    if (!token || typeof token !== 'string') return null;
    const trimmed = token.trim();
    if (!trimmed) return null;

    // Check if token already exists in pool
    for (const rec of this.tokens.values()) {
      if (rec.token === trimmed) {
        if (customLabel) rec.label = customLabel;
        this.saveToFile();
        return rec;
      }
    }

    const assignedId = `token-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const record = {
      id: assignedId,
      token: trimmed,
      label: customLabel || maskToken(trimmed),
      state: 'HEALTHY',
      consecutiveFailures: 0,
      blockedUntil: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastBlockReason: null,
      usageCount: 0,
      addedAt: new Date().toISOString()
    };

    this.tokens.set(assignedId, record);
    this.clients.set(assignedId, new ApifyClient({ token: trimmed }));
    this.saveToFile();
    return record;
  }

  removeToken(id) {
    if (!id) return false;
    const strId = String(id);
    let found = false;
    for (const [key, rec] of this.tokens.entries()) {
      if (key === strId || rec.id === strId) {
        this.tokens.delete(key);
        this.clients.delete(key);
        found = true;
        break;
      }
    }
    if (found) {
      this.saveToFile();
    }
    return found;
  }

  clearNonHealthyTokens() {
    let count = 0;
    for (const [key, rec] of [...this.tokens.entries()]) {
      if (rec.state === 'EXHAUSTED' || rec.state === 'INVALID') {
        this.tokens.delete(key);
        this.clients.delete(key);
        count++;
      }
    }
    if (count > 0) {
      this.saveToFile();
    }
    return count;
  }

  isBlockSignal(signal) {
    return parseTokenSignal(signal).isError;
  }

  getAvailable(excludeIds = []) {
    const excluded = new Set((excludeIds || []).map(String));
    const now = Date.now();
    const available = [];

    for (const record of this.tokens.values()) {
      if (excluded.has(record.id) || record.state === 'DISABLED' || record.state === 'INVALID') continue;

      // Auto-recover from cooldown if elapsed
      if ((record.state === 'COOLDOWN' || record.state === 'EXHAUSTED') && record.blockedUntil > 0) {
        if (now >= record.blockedUntil) {
          record.state = 'HEALTHY';
          record.consecutiveFailures = 0;
          record.lastBlockReason = null;
        } else {
          continue; // Still in cooldown
        }
      }

      if (record.state === 'HEALTHY') {
        available.push(record);
      }
    }

    return available;
  }

  acquire(options = {}) {
    if (this.tokens.size === 0) {
      return {
        allowed: false,
        reason: 'APIFY_POOL_EMPTY',
        error: 'No Apify tokens configured in APIFY_TOKENS or APIFY_TOKEN',
        tokenRecord: null,
        client: null
      };
    }

    const excluded = new Set((options.excludeTokenIds || []).map(String));
    const allTokens = Array.from(this.tokens.values());
    const total = allTokens.length;
    const now = Date.now();

    // Auto-recover cooled-down tokens
    for (const rec of allTokens) {
      if ((rec.state === 'COOLDOWN' || rec.state === 'EXHAUSTED') && rec.blockedUntil > 0 && now >= rec.blockedUntil) {
        rec.state = 'HEALTHY';
        rec.consecutiveFailures = 0;
        rec.lastBlockReason = null;
      }
    }

    let selected = null;
    for (let i = 0; i < total; i++) {
      const idx = (this.currentIndex + i) % total;
      const candidate = allTokens[idx];

      if (candidate.state === 'HEALTHY' && !excluded.has(candidate.id)) {
        selected = candidate;
        this.currentIndex = (idx + 1) % total;
        break;
      }
    }

    if (!selected) {
      return {
        allowed: false,
        reason: 'APIFY_POOL_EXHAUSTED',
        error: 'All Apify tokens in pool are currently exhausted, invalid, or in cooldown',
        tokenRecord: null,
        client: null
      };
    }

    selected.usageCount++;
    const client = this.clients.get(selected.id) || new ApifyClient({ token: selected.token });

    return {
      allowed: true,
      tokenRecord: selected,
      tokenId: selected.id,
      tokenMasked: selected.label,
      client,
      rotationAttempt: Number(options.rotationAttempt || 1)
    };
  }

  markSuccess(tokenId) {
    if (!tokenId) return;
    const record = this.tokens.get(String(tokenId));
    if (!record) return;

    record.consecutiveFailures = 0;
    record.state = 'HEALTHY';
    record.lastSuccessAt = new Date().toISOString();
  }

  markFailure(tokenId, error = null) {
    if (!tokenId) return;
    const record = this.tokens.get(String(tokenId));
    if (!record) return;

    const signal = parseTokenSignal(error);
    if (signal.isError) {
      if (signal.type === 'INVALID') {
        this.markInvalid(tokenId, signal.reason);
        return;
      }
      if (signal.type === 'EXHAUSTED') {
        this.markExhausted(tokenId, signal.reason);
        return;
      }
      if (signal.type === 'RATE_LIMITED') {
        this.markCooldown(tokenId, signal.reason, this.rateLimitCooldownMs);
        return;
      }
    }

    record.consecutiveFailures = (record.consecutiveFailures || 0) + 1;
    record.lastFailureAt = new Date().toISOString();

    if (record.consecutiveFailures >= this.failureThreshold) {
      this.markCooldown(tokenId, error ? (error.message || String(error)) : 'CONSECUTIVE_FAILURES', this.rateLimitCooldownMs);
    }
  }

  markExhausted(tokenId, reason = 'PAYMENT_REQUIRED_OR_OUT_OF_CREDIT') {
    if (!tokenId) return;
    const record = this.tokens.get(String(tokenId));
    if (!record) return;

    record.state = 'EXHAUSTED';
    record.blockedUntil = Date.now() + this.exhaustedCooldownMs;
    record.lastFailureAt = new Date().toISOString();
    record.lastBlockReason = String(reason || 'EXHAUSTED');
    console.warn(`[ApifyTokenPool] Token ${record.id} (${record.label}) marked EXHAUSTED: ${record.lastBlockReason}`);
  }

  markInvalid(tokenId, reason = 'INVALID_TOKEN_OR_UNAUTHORIZED') {
    if (!tokenId) return;
    const record = this.tokens.get(String(tokenId));
    if (!record) return;

    record.state = 'INVALID';
    record.blockedUntil = 0; // Permanent until refreshed
    record.lastFailureAt = new Date().toISOString();
    record.lastBlockReason = String(reason || 'INVALID');
    console.warn(`[ApifyTokenPool] Token ${record.id} (${record.label}) marked INVALID: ${record.lastBlockReason}`);
  }

  markCooldown(tokenId, reason = 'RATE_LIMITED', cooldownMs = null) {
    if (!tokenId) return;
    const record = this.tokens.get(String(tokenId));
    if (!record) return;

    const duration = cooldownMs !== null ? Number(cooldownMs) : this.rateLimitCooldownMs;
    record.state = 'COOLDOWN';
    record.blockedUntil = Date.now() + duration;
    record.lastFailureAt = new Date().toISOString();
    record.lastBlockReason = String(reason || 'COOLDOWN');
    console.warn(`[ApifyTokenPool] Token ${record.id} (${record.label}) in COOLDOWN for ${Math.round(duration / 1000)}s: ${record.lastBlockReason}`);
  }

  /**
   * Executes an Apify operation with automatic token failover across all healthy tokens.
   * @param {Function} fn - async (client, tokenRecord, admission) => Promise<any>
   * @param {object} options
   * @returns {Promise<any>}
   */
  //
  // Budget contract (P0):
  // - A reservation of the estimate (APIFY_DEFAULT_RUN_COST_USD) is admitted
  //   atomically BEFORE any actor can start; APIFY_BUDGET_EXCEEDED otherwise.
  // - Once the callback reports the actor started (admission.reportActorStarted,
  //   or by returning normally), the reservation is spend and is never refunded.
  //   It is settled to the run's usageTotalUsd (admission.reportRunCost, or a
  //   legacy result.cost/costUsd) — on success AND on failure/abort/timeout.
  // - Only an attempt whose actor never started is released.
  // - Each token attempt that starts an actor gets its own reservation, so a
  //   failover after a start can never launch a second run for free.
  async withTokenFailover(fn, options = {}) {
    const estimate = isPositiveUsd(options.estimatedCostUsd)
      ? Number(options.estimatedCostUsd)
      : this.defaultEstimatedCostUsd;
    const maxRotations = Math.min(
      Math.max(1, this.tokens.size),
      Number(options.maxTokenRotations || this.maxTokenRotations)
    );
    const excludeTokenIds = [];
    let lastError = null;
    let reservation = null;

    try {
      for (let attempt = 1; attempt <= maxRotations; attempt++) {
        if (!reservation) reservation = await this._openReservation(estimate);

        const admission = this.acquire({ ...options, excludeTokenIds, rotationAttempt: attempt });
        if (!admission.allowed) {
          const err = new Error(admission.error || 'APIFY_POOL_EXHAUSTED');
          err.code = admission.reason || 'APIFY_POOL_EXHAUSTED';
          err.cause = lastError;
          throw err;
        }

        const { client, tokenRecord, tokenId } = admission;
        const tracker = createRunTracker();

        try {
          const result = await fn(client, tokenRecord, this._buildRunAdmission(admission, reservation, tracker));
          if (tokenId) this.markSuccess(tokenId);
          absorbResult(tracker, result);
          const settled = reservation;
          reservation = null;
          await this._settleReservation(settled, tracker);
          return result;
        } catch (err) {
          lastError = err;
          if (tracker.started) {
            const settled = reservation;
            reservation = null;
            await this._settleReservation(settled, tracker);
          }
          if (!this._shouldRotate(err, tokenId, tokenRecord, attempt, maxRotations, excludeTokenIds)) throw err;
        }
      }

      const exhaustedErr = new Error(`All Apify tokens failed or exhausted after ${maxRotations} rotation(s): ${lastError ? lastError.message : 'APIFY_POOL_EXHAUSTED'}`);
      exhaustedErr.code = 'APIFY_POOL_EXHAUSTED';
      exhaustedErr.cause = lastError;
      throw exhaustedErr;
    } finally {
      // Still open only when no actor was started under it: refund.
      if (reservation) await this._releaseReservation(reservation);
    }
  }

  /** Token-specific failures rotate to the next token; anything else is rethrown. */
  _shouldRotate(err, tokenId, tokenRecord, attempt, maxRotations, excludeTokenIds) {
    const signal = parseTokenSignal(err);
    if (signal.isError && tokenId) {
      console.warn(`[ApifyTokenPool] Token ${tokenId} (${tokenRecord.label}) failed during attempt ${attempt}/${maxRotations}: ${signal.reason}. Rotating to next token...`);
      this.markFailure(tokenId, err);
      excludeTokenIds.push(tokenId);
      return true;
    }
    // Not a token-specific error (e.g. invalid actor input, client abort): keep the token.
    if (tokenId) this.markSuccess(tokenId);
    return false;
  }

  getStatus() {
    let healthyCount = 0;
    let cooldownCount = 0;
    let exhaustedCount = 0;
    let invalidCount = 0;
    const now = Date.now();

    const tokenList = [];
    for (const rec of this.tokens.values()) {
      let currentState = rec.state;
      if ((currentState === 'COOLDOWN' || currentState === 'EXHAUSTED') && rec.blockedUntil > 0 && now >= rec.blockedUntil) {
        currentState = 'HEALTHY';
      }

      if (currentState === 'HEALTHY') healthyCount++;
      else if (currentState === 'COOLDOWN') cooldownCount++;
      else if (currentState === 'EXHAUSTED') exhaustedCount++;
      else invalidCount++;

      tokenList.push({
        id: rec.id,
        label: rec.label,
        state: currentState,
        consecutiveFailures: rec.consecutiveFailures,
        blockedUntil: rec.blockedUntil > 0 ? new Date(rec.blockedUntil).toISOString() : null,
        lastFailureAt: rec.lastFailureAt,
        lastSuccessAt: rec.lastSuccessAt,
        lastBlockReason: rec.lastBlockReason,
        usageCount: rec.usageCount
      });
    }

    return {
      total: this.tokens.size,
      healthyCount,
      cooldownCount,
      exhaustedCount,
      invalidCount,
      currentIndex: this.currentIndex,
      budget: this.getBudgetStatus(),
      tokens: tokenList
    };
  }
}

// Global Singleton
let globalApifyTokenPool = null;

function getApifyTokenPool(options = {}) {
  if (!globalApifyTokenPool || options.forceNew) {
    globalApifyTokenPool = new ApifyTokenPoolManager(options);
  }
  return globalApifyTokenPool;
}

module.exports = {
  ApifyBudgetExceededError,
  ApifyTokenPoolManager,
  getApifyTokenPool,
  maskToken,
  parseTokenSignal,
};
