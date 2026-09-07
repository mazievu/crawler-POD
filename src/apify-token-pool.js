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

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'data', 'apify_tokens.json');

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

class ApifyTokenPoolManager {
  constructor(options = {}) {
    this.configPath = options.configPath || DEFAULT_CONFIG_PATH;
    this.rateLimitCooldownMs = Number(options.rateLimitCooldownMs) || 600000; // 10 minutes default
    this.exhaustedCooldownMs = Number(options.exhaustedCooldownMs) || 86400000; // 24 hours default
    this.failureThreshold = Number(options.failureThreshold) || 2;
    this.maxTokenRotations = Number(options.maxTokenRotations) || 5;

    this.tokens = new Map(); // id -> token record
    this.clients = new Map(); // id -> ApifyClient instance
    this.currentIndex = 0;

    if (Array.isArray(options.tokens)) {
      this.initFromList(options.tokens);
    } else {
      this.load();
    }
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
  async withTokenFailover(fn, options = {}) {
    const maxRotations = Math.min(
      Math.max(1, this.tokens.size),
      Number(options.maxTokenRotations || this.maxTokenRotations)
    );
    const excludeTokenIds = [];
    let lastError = null;

    for (let attempt = 1; attempt <= maxRotations; attempt++) {
      const admission = this.acquire({
        ...options,
        excludeTokenIds,
        rotationAttempt: attempt
      });

      if (!admission.allowed) {
        const err = new Error(admission.error || 'APIFY_POOL_EXHAUSTED');
        err.code = admission.reason || 'APIFY_POOL_EXHAUSTED';
        err.cause = lastError;
        throw err;
      }

      const { client, tokenRecord, tokenId } = admission;

      try {
        const result = await fn(client, tokenRecord, admission);
        if (tokenId) this.markSuccess(tokenId);
        return result;
      } catch (err) {
        lastError = err;
        const signal = parseTokenSignal(err);

        if (signal.isError && tokenId) {
          console.warn(`[ApifyTokenPool] Token ${tokenId} (${tokenRecord.label}) failed during attempt ${attempt}/${maxRotations}: ${signal.reason}. Rotating to next token...`);
          this.markFailure(tokenId, err);
          excludeTokenIds.push(tokenId);
          continue; // Auto-rotate to next token
        }

        // If not a token-specific error (e.g. invalid actor input, client abort), don't discard token
        if (tokenId) this.markSuccess(tokenId);
        throw err;
      }
    }

    const exhaustedErr = new Error(`All Apify tokens failed or exhausted after ${maxRotations} rotation(s): ${lastError ? lastError.message : 'APIFY_POOL_EXHAUSTED'}`);
    exhaustedErr.code = 'APIFY_POOL_EXHAUSTED';
    exhaustedErr.cause = lastError;
    throw exhaustedErr;
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
  ApifyTokenPoolManager,
  getApifyTokenPool,
  maskToken,
  parseTokenSignal,
};
