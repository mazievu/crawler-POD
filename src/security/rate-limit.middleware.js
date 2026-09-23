'use strict';

/**
 * src/security/rate-limit.middleware.js
 *
 * Rate Limiting & Abuse Prevention Middleware (Milestone M3)
 * Implements:
 * - Feature 9: Login Brute Force Throttler (5 failures / 15 min per IP/email)
 * - Feature 10: Run Creation Rate Limiter (10 requests / min per user/session/API key with IP fallback)
 *
 * Architecture:
 * - Pure Node.js in-memory sliding window log
 * - LRU bounded capacity cap (O(1) Map eviction) preventing memory leaks under flood attacks
 * - Periodic background sweep with unref'd timer (never blocks process exit)
 * - Injectable clock (nowProvider) for 100% deterministic unit testing
 */

const RATE_LIMIT_DEFAULTS = {
  LOGIN: {
    WINDOW_MS: 15 * 60 * 1000, // 15 minutes
    MAX_FAILURES: 5,
    SWEEP_INTERVAL_MS: 60 * 1000, // 1 minute
    MAX_KEYS: 10000,
  },
  RUN_CREATION: {
    WINDOW_MS: 60 * 1000, // 1 minute
    MAX_REQUESTS: 10,
    SWEEP_INTERVAL_MS: 30 * 1000, // 30 seconds
    MAX_KEYS: 10000,
  },
};

/**
 * Sliding Window Memory Store with LRU eviction and background cleanup.
 */
class SlidingWindowMemoryStore {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000;
    this.maxEntries = options.maxEntries || 10;
    this.maxKeys = options.maxKeys || 10000;
    this.sweepIntervalMs = options.sweepIntervalMs !== undefined ? options.sweepIntervalMs : 60000;
    this.now = typeof options.nowProvider === 'function' ? options.nowProvider : () => Date.now();
    this.hits = new Map(); // key -> number[] (timestamps)

    if (this.sweepIntervalMs > 0) {
      this._sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
      if (this._sweepTimer && typeof this._sweepTimer.unref === 'function') {
        this._sweepTimer.unref();
      }
    }
  }

  /**
   * Internal helper: prunes expired timestamps for a key.
   * If all expired, deletes key and returns null.
   */
  _cleanKey(key, now) {
    const timestamps = this.hits.get(key);
    if (!timestamps) return null;
    const cutoff = now - this.windowMs;

    let firstValidIdx = 0;
    while (firstValidIdx < timestamps.length && timestamps[firstValidIdx] <= cutoff) {
      firstValidIdx++;
    }

    if (firstValidIdx >= timestamps.length) {
      this.hits.delete(key);
      return null;
    }

    if (firstValidIdx > 0) {
      const active = timestamps.slice(firstValidIdx);
      this.hits.set(key, active);
      return active;
    }

    return timestamps;
  }

  /**
   * Inspects current status without consuming or recording an event.
   */
  check(key) {
    const now = this.now();
    const timestamps = this._cleanKey(key, now);
    const count = timestamps ? timestamps.length : 0;
    const allowed = count < this.maxEntries;
    let retryAfterSeconds = 0;
    let resetMs = 0;

    if (!allowed && timestamps && timestamps.length > 0) {
      const oldestValid = timestamps[0];
      resetMs = Math.max(0, oldestValid + this.windowMs - now);
      retryAfterSeconds = Math.max(1, Math.ceil(resetMs / 1000));
    } else if (timestamps && timestamps.length > 0) {
      resetMs = Math.max(0, timestamps[0] + this.windowMs - now);
    }

    return {
      allowed,
      remaining: Math.max(0, this.maxEntries - count),
      total: count,
      retryAfterSeconds,
      resetMs,
    };
  }

  /**
   * Records an event timestamp (e.g. login failure) unconditionally.
   */
  record(key) {
    const now = this.now();

    // Capacity cap: evict oldest entry if at capacity
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey !== undefined) {
        this.hits.delete(oldestKey);
      }
    }

    let timestamps = this._cleanKey(key, now) || [];
    timestamps.push(now);

    // Refresh Map insertion order for LRU
    this.hits.delete(key);
    this.hits.set(key, timestamps);

    return {
      count: timestamps.length,
      allowed: timestamps.length <= this.maxEntries,
    };
  }

  /**
   * Atomically checks quota and consumes 1 event if allowed.
   */
  consume(key) {
    const now = this.now();
    const timestamps = this._cleanKey(key, now);
    const count = timestamps ? timestamps.length : 0;

    if (count >= this.maxEntries) {
      const oldestValid = timestamps[0];
      const resetMs = Math.max(0, oldestValid + this.windowMs - now);
      const retryAfterSeconds = Math.max(1, Math.ceil(resetMs / 1000));
      return {
        allowed: false,
        remaining: 0,
        total: count,
        retryAfterSeconds,
        resetMs,
      };
    }

    // Capacity cap
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey !== undefined) {
        this.hits.delete(oldestKey);
      }
    }

    const nextTimestamps = timestamps ? [...timestamps] : [];
    nextTimestamps.push(now);
    this.hits.delete(key);
    this.hits.set(key, nextTimestamps);

    const remaining = Math.max(0, this.maxEntries - nextTimestamps.length);
    const resetMs = Math.max(0, nextTimestamps[0] + this.windowMs - now);

    return {
      allowed: true,
      remaining,
      total: nextTimestamps.length,
      retryAfterSeconds: 0,
      resetMs,
    };
  }

  /**
   * Clears state for a single key.
   */
  reset(key) {
    return this.hits.delete(key);
  }

  /**
   * Clears all state across all keys (for testing).
   */
  resetAll() {
    this.hits.clear();
  }

  /**
   * Background sweep of expired timestamps.
   */
  sweep() {
    const now = this.now();
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.hits.entries()) {
      const active = timestamps.filter((t) => t > cutoff);
      if (active.length === 0) {
        this.hits.delete(key);
      } else if (active.length < timestamps.length) {
        this.hits.set(key, active);
      }
    }
  }

  /**
   * Tears down store and background sweep timer.
   */
  destroy() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    this.hits.clear();
  }

  /**
   * Inspects exact state for testing assertions.
   */
  getState(key) {
    const now = this.now();
    const timestamps = this._cleanKey(key, now);
    return {
      count: timestamps ? timestamps.length : 0,
      timestamps: timestamps ? [...timestamps] : [],
    };
  }
}

/**
 * Extracts normalized client IP.
 */
function getClientIp(req) {
  return (
    req.ip ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

/**
 * Key generator factory for Login Brute Force Throttler:
 * Key format: `<ip>:<normalized_email>`
 */
function createLoginKeyGenerator(customFn) {
  if (typeof customFn === 'function') return customFn;
  return function defaultLoginKey(req) {
    const ip = getClientIp(req);
    const email = (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 256) : '');
    return `${ip}:${email || '__anonymous__'}`;
  };
}

/**
 * Key generator factory for Run Creation Rate Limiter:
 * Key format: `apikey:<id>` -> `user:<id>` -> `session:<token>` -> `ip:<ip>`
 */
function createRunKeyGenerator(customFn) {
  if (typeof customFn === 'function') return customFn;
  return function defaultRunKey(req) {
    if (req.apiKey && req.apiKey.id) {
      return `apikey:${req.apiKey.id}`;
    }
    if (req.user && req.user.apiKeyId) {
      return `apikey:${req.user.apiKeyId}`;
    }
    if (req.user && req.user.id) {
      return `user:${req.user.id}`;
    }
    if (req.session && req.session.sessionToken) {
      return `session:${req.session.sessionToken}`;
    }
    const ip = getClientIp(req);
    return `ip:${ip}`;
  };
}

/**
 * Feature 9: Login Brute Force Throttler
 *
 * Limits failed login attempts (default: 5 failures / 15 min per IP/email).
 * Returns HTTP 429 Too Many Requests with informative JSON and Retry-After header.
 * Successful login (2xx status) resets the failure count.
 */
function createLoginRateLimiter(options = {}) {
  const windowMs = options.windowMs || RATE_LIMIT_DEFAULTS.LOGIN.WINDOW_MS;
  const maxFailures = options.maxFailures || RATE_LIMIT_DEFAULTS.LOGIN.MAX_FAILURES;
  const store = options.store || new SlidingWindowMemoryStore({
    windowMs,
    maxEntries: maxFailures,
    sweepIntervalMs: options.sweepIntervalMs !== undefined ? options.sweepIntervalMs : RATE_LIMIT_DEFAULTS.LOGIN.SWEEP_INTERVAL_MS,
    maxKeys: options.maxKeys || RATE_LIMIT_DEFAULTS.LOGIN.MAX_KEYS,
    nowProvider: options.nowProvider,
  });

  const keyGenerator = createLoginKeyGenerator(options.keyGenerator);
  const countStatus = typeof options.countStatus === 'function' ? options.countStatus : (status) => status === 401;

  function loginRateLimiterMiddleware(req, res, next) {
    const key = keyGenerator(req);
    const checkResult = store.check(key);

    if (!checkResult.allowed) {
      res.setHeader('Retry-After', String(checkResult.retryAfterSeconds));
      return res.status(429).json({
        error: 'TOO_MANY_REQUESTS',
        message: 'Too many failed login attempts. Please try again later.',
        retryAfterSeconds: checkResult.retryAfterSeconds,
      });
    }

    // Intercept response completion to record failure or reset on success
    res.on('finish', () => {
      if (countStatus(res.statusCode)) {
        store.record(key);
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        store.reset(key);
      }
    });

    next();
  }

  // Attach controls for testing & management
  loginRateLimiterMiddleware.store = store;
  loginRateLimiterMiddleware.reset = (key) => store.reset(key);
  loginRateLimiterMiddleware.resetAll = () => store.resetAll();
  loginRateLimiterMiddleware.recordFailure = (key) => store.record(key);
  loginRateLimiterMiddleware.recordSuccess = (key) => store.reset(key);
  loginRateLimiterMiddleware.isBlocked = (key) => !store.check(key).allowed;
  loginRateLimiterMiddleware.getState = (key) => store.getState(key);
  loginRateLimiterMiddleware.destroy = () => store.destroy();

  return loginRateLimiterMiddleware;
}

/**
 * Feature 10: Run Creation Rate Limiter
 *
 * Caps run creation calls to 10 requests / min per user/session/API key (and IP fallback).
 * Returns HTTP 429 Too Many Requests with Retry-After header.
 */
function createRunRateLimiter(options = {}) {
  const windowMs = options.windowMs || RATE_LIMIT_DEFAULTS.RUN_CREATION.WINDOW_MS;
  const maxRequests = options.maxRequests || RATE_LIMIT_DEFAULTS.RUN_CREATION.MAX_REQUESTS;
  const store = options.store || new SlidingWindowMemoryStore({
    windowMs,
    maxEntries: maxRequests,
    sweepIntervalMs: options.sweepIntervalMs !== undefined ? options.sweepIntervalMs : RATE_LIMIT_DEFAULTS.RUN_CREATION.SWEEP_INTERVAL_MS,
    maxKeys: options.maxKeys || RATE_LIMIT_DEFAULTS.RUN_CREATION.MAX_KEYS,
    nowProvider: options.nowProvider,
  });

  const keyGenerator = createRunKeyGenerator(options.keyGenerator);

  function runRateLimiterMiddleware(req, res, next) {
    const key = keyGenerator(req);
    const consumeResult = store.consume(key);

    if (!consumeResult.allowed) {
      res.setHeader('Retry-After', String(consumeResult.retryAfterSeconds));
      return res.status(429).json({
        error: 'TOO_MANY_REQUESTS',
        message: 'Run creation rate limit exceeded. Maximum 10 requests per minute.',
        retryAfterSeconds: consumeResult.retryAfterSeconds,
      });
    }

    // Set standard rate limit headers
    res.setHeader('RateLimit-Limit', String(maxRequests));
    res.setHeader('RateLimit-Remaining', String(consumeResult.remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(consumeResult.resetMs / 1000)));

    next();
  }

  // Attach controls for testing & management
  runRateLimiterMiddleware.store = store;
  runRateLimiterMiddleware.reset = (key) => store.reset(key);
  runRateLimiterMiddleware.resetAll = () => store.resetAll();
  runRateLimiterMiddleware.isBlocked = (key) => !store.check(key).allowed;
  runRateLimiterMiddleware.getState = (key) => store.getState(key);
  runRateLimiterMiddleware.destroy = () => store.destroy();

  return runRateLimiterMiddleware;
}

module.exports = {
  RATE_LIMIT_DEFAULTS,
  SlidingWindowMemoryStore,
  getClientIp,
  createLoginKeyGenerator,
  createRunKeyGenerator,
  createLoginRateLimiter,
  createRunRateLimiter,
};
