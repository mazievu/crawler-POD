const fs = require('fs');
const path = require('path');
const { validateProxy, buildProxyUrl, proxyMetadata } = require('../marketplaces/proxy');

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'data', 'proxies.json');

const BLOCK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  'ERR_PROXY_CONNECTION_FAILED',
  'PROXY_CONNECTION_FAILED',
  'SOCKS_CONNECTION_FAILED',
  'EPROTO'
]);

const BLOCK_STATUS_CODES = new Set([403, 407, 429]);

const BLOCK_PATTERNS = [
  /cloudflare/i,
  /datadome/i,
  /captcha/i,
  /access denied/i,
  /rate limit/i,
  /too many requests/i,
  /forbidden/i,
  /ip blocked/i,
  /perimeterx/i,
  /bot detected/i
];

class ProxyPoolManager {
  constructor(options = {}) {
    this.configPath = options.configPath || DEFAULT_CONFIG_PATH;
    this.failureThreshold = Number(options.failureThreshold) || 2;
    this.cooldownMs = Number(options.cooldownMs) || 300000; // 5 minutes default
    this.maxProxyRotations = Number(options.maxProxyRotations) || 3;
    this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : false;

    this.proxies = new Map(); // id -> proxy runtime record
    this.activeReservations = new Map(); // executionToken -> proxyId
    this.currentIndex = 0;

    if (Array.isArray(options.proxies)) {
      this.initFromList(options.proxies);
    } else {
      this.load();
    }
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.enabled !== undefined) this.enabled = Boolean(parsed.enabled);
        if (parsed.failureThreshold) this.failureThreshold = Number(parsed.failureThreshold);
        if (parsed.cooldownMs) this.cooldownMs = Number(parsed.cooldownMs);
        if (parsed.maxProxyRotations) this.maxProxyRotations = Number(parsed.maxProxyRotations);
        if (Array.isArray(parsed.proxies)) {
          this.initFromList(parsed.proxies);
        }
      }
    } catch (err) {
      console.warn('[ProxyPool] Failed to load proxy config, using defaults:', err.message);
    }
  }

  initFromList(list) {
    this.proxies.clear();
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      try {
        const validated = validateProxy(item);
        const id = String(validated.id || `proxy-${i + 1}`);
        this.proxies.set(id, {
          ...item,
          ...validated,
          id,
          rawUrl: item.rawUrl || null,
          state: validated.enabled ? 'HEALTHY' : 'DISABLED',
          consecutiveFailures: 0,
          blockedUntil: 0,
          lastFailureAt: null,
          lastSuccessAt: null,
          lastBlockReason: null
        });
      } catch (err) {
        console.warn(`[ProxyPool] Skipping invalid proxy entry at index ${i}:`, err.message);
      }
    }
  }

  addProxy(input) {
    const validated = validateProxy(input);
    const id = String(validated.id || `proxy-${this.proxies.size + 1}`);
    const record = {
      ...input,
      ...validated,
      id,
      rawUrl: input.rawUrl || null,
      state: validated.enabled ? 'HEALTHY' : 'DISABLED',
      consecutiveFailures: 0,
      blockedUntil: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastBlockReason: null
    };
    this.proxies.set(id, record);
    return record;
  }

  removeProxy(id) {
    return this.proxies.delete(String(id));
  }

  isBlockSignal(signal) {
    if (!signal) return false;

    // Direct HTTP status code number
    if (typeof signal === 'number') {
      return BLOCK_STATUS_CODES.has(signal);
    }

    // Response-like object with status
    if (typeof signal.status === 'number') {
      if (signal.status === 404 || signal.status === 400 || signal.status === 422) return false;
      if (BLOCK_STATUS_CODES.has(signal.status)) return true;
    }

    // Error object
    const code = signal.code || (signal.cause && signal.cause.code);
    if (code && BLOCK_ERROR_CODES.has(code)) return true;

    const message = String(signal.message || signal.error || signal || '');
    // Explicitly exclude 404 Not Found from blocking
    if (/404|not found/i.test(message) && !/blocked|forbidden|cloudflare|captcha/i.test(message)) {
      return false;
    }

    return BLOCK_PATTERNS.some(pat => pat.test(message));
  }

  getAvailable(excludeIds = []) {
    const excluded = new Set((excludeIds || []).map(String));
    const now = Date.now();
    const available = [];

    for (const proxy of this.proxies.values()) {
      if (proxy.enabled === false || proxy.state === 'DISABLED') continue;
      if (excluded.has(proxy.id)) continue;

      // Auto-recover from cooldown if timeout elapsed
      if (proxy.state === 'COOLDOWN') {
        if (now >= proxy.blockedUntil) {
          proxy.state = 'HEALTHY';
          proxy.consecutiveFailures = 0;
          proxy.lastBlockReason = null;
        } else {
          continue; // Still in cooldown
        }
      }

      if (proxy.state === 'HEALTHY') {
        available.push(proxy);
      }
    }

    return available;
  }

  acquire(executionToken, options = {}) {
    if (!this.enabled || this.proxies.size === 0) {
      if (options.requireProxy) {
        return { allowed: false, reason: 'PROXY_POOL_DISABLED', error: 'PROXY_POOL_EMPTY', proxy: null };
      }
      return { allowed: true, proxy: null, direct: true };
    }

    const excluded = new Set((options.excludeProxyIds || []).map(String));
    const allProxies = Array.from(this.proxies.values());
    const total = allProxies.length;
    const now = Date.now();

    // Auto-recover any cooled-down proxies
    for (const p of allProxies) {
      if (p.state === 'COOLDOWN' && now >= p.blockedUntil) {
        p.state = 'HEALTHY';
        p.consecutiveFailures = 0;
        p.lastBlockReason = null;
      }
    }

    // Search for next available proxy starting from currentIndex
    let selected = null;
    for (let i = 0; i < total; i++) {
      const idx = (this.currentIndex + i) % total;
      const candidate = allProxies[idx];

      if (candidate.enabled !== false && candidate.state === 'HEALTHY' && !excluded.has(candidate.id)) {
        selected = candidate;
        this.currentIndex = (idx + 1) % total;
        break;
      }
    }

    if (!selected) {
      return { allowed: false, reason: 'PROXY_POOL_EXHAUSTED', error: 'PROXY_POOL_EXHAUSTED', proxy: null };
    }

    if (executionToken) {
      this.activeReservations.set(executionToken, selected.id);
    }

    return {
      allowed: true,
      proxy: selected,
      proxyId: selected.id,
      proxyUrl: buildProxyUrl(selected),
      rotationAttempt: Number(options.rotationAttempt || 1)
    };
  }

  release(executionToken) {
    if (!executionToken) return;
    this.activeReservations.delete(executionToken);
  }

  markSuccess(proxyId) {
    if (!proxyId) return;
    const proxy = this.proxies.get(String(proxyId));
    if (!proxy) return;

    proxy.consecutiveFailures = 0;
    proxy.state = 'HEALTHY';
    proxy.lastSuccessAt = new Date().toISOString();
  }

  markFailure(proxyId, reason = 'FAILURE') {
    if (!proxyId) return;
    const proxy = this.proxies.get(String(proxyId));
    if (!proxy) return;

    proxy.consecutiveFailures = (proxy.consecutiveFailures || 0) + 1;
    proxy.lastFailureAt = new Date().toISOString();

    if (proxy.consecutiveFailures >= this.failureThreshold) {
      this.markBlocked(proxyId, reason);
    }
  }

  markBlocked(proxyId, reason = 'BLOCKED') {
    if (!proxyId) return;
    const proxy = this.proxies.get(String(proxyId));
    if (!proxy) return;

    proxy.state = 'COOLDOWN';
    proxy.blockedUntil = Date.now() + this.cooldownMs;
    proxy.lastFailureAt = new Date().toISOString();
    proxy.lastBlockReason = String(reason || 'BLOCKED');
  }

  /**
   * Executes an async operation with automatic proxy failover up to maxProxyRotations.
   */
  async withProxyFailover(executionToken, fn, options = {}) {
    const maxRotations = Number(options.maxProxyRotations || this.maxProxyRotations);
    const excludeProxyIds = [];
    let lastError = null;

    for (let attempt = 1; attempt <= maxRotations; attempt++) {
      const admission = this.acquire(executionToken, {
        ...options,
        excludeProxyIds,
        rotationAttempt: attempt
      });

      if (!admission.allowed) {
        const err = new Error(admission.error || 'PROXY_POOL_EXHAUSTED');
        err.code = admission.reason || 'PROXY_POOL_EXHAUSTED';
        throw err;
      }

      const activeProxy = admission.proxy;
      const proxyId = activeProxy ? activeProxy.id : null;

      try {
        const result = await fn(activeProxy, admission);
        if (proxyId) this.markSuccess(proxyId);
        return result;
      } catch (err) {
        lastError = err;

        if (proxyId && this.isBlockSignal(err)) {
          console.warn(`[ProxyPool] Proxy ${proxyId} blocked during attempt ${attempt}/${maxRotations} (${err.message}). Rotating to next proxy...`);
          this.markBlocked(proxyId, err.message);
          excludeProxyIds.push(proxyId);
          this.release(executionToken);
          continue; // Failover to next proxy
        }

        // Non-block error (e.g. 404, parsing error) -> do not block proxy, propagate error
        if (proxyId && !this.isBlockSignal(err)) {
          this.markSuccess(proxyId);
        }
        throw err;
      }
    }

    const exhaustedErr = new Error(`Proxy rotations exceeded maximum limit (${maxRotations}): ${lastError ? lastError.message : 'ALL_PROXIES_BLOCKED'}`);
    exhaustedErr.code = 'PROXY_POOL_EXHAUSTED';
    exhaustedErr.cause = lastError;
    throw exhaustedErr;
  }

  getStatus() {
    let healthyCount = 0;
    let cooldownCount = 0;
    let disabledCount = 0;
    const now = Date.now();

    const proxyList = [];
    for (const p of this.proxies.values()) {
      let currentState = p.state;
      if (currentState === 'COOLDOWN' && now >= p.blockedUntil) {
        currentState = 'HEALTHY';
      }

      if (currentState === 'HEALTHY') healthyCount++;
      else if (currentState === 'COOLDOWN') cooldownCount++;
      else disabledCount++;

      proxyList.push({
        id: p.id,
        label: p.label,
        protocol: p.protocol,
        host: p.host,
        port: p.port,
        state: currentState,
        consecutiveFailures: p.consecutiveFailures,
        blockedUntil: p.blockedUntil > 0 ? new Date(p.blockedUntil).toISOString() : null,
        lastFailureAt: p.lastFailureAt,
        lastSuccessAt: p.lastSuccessAt,
        lastBlockReason: p.lastBlockReason
      });
    }

    return {
      enabled: this.enabled,
      total: this.proxies.size,
      healthyCount,
      cooldownCount,
      disabledCount,
      activeReservationsCount: this.activeReservations.size,
      maxProxyRotations: this.maxProxyRotations,
      cooldownMs: this.cooldownMs,
      failureThreshold: this.failureThreshold,
      activeReservations: Array.from(this.activeReservations.entries()).map(([token, proxyId]) => ({
        executionToken: token,
        proxyId
      })),
      proxies: proxyList
    };
  }
}

// Global Singleton pattern
let globalProxyPool = null;

function getProxyPool(options = {}) {
  if (!globalProxyPool || options.forceNew) {
    globalProxyPool = new ProxyPoolManager(options);
  }
  return globalProxyPool;
}

module.exports = {
  ProxyPoolManager,
  getProxyPool,
  BLOCK_ERROR_CODES,
  BLOCK_STATUS_CODES,
  BLOCK_PATTERNS
};
