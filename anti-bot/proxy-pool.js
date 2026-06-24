/**
 * Proxy Pool Manager
 * Quản lý và rotation proxy IPs
 *
 * Usage:
 *   const pool = new ProxyPool(['http://user:pass@ip1:port', ...]);
 *   const proxy = pool.next();        // Get next proxy
 *   pool.markBad(proxy);              // Mark as failed (skip for a while)
 *   pool.markGood(proxy);             // Mark as successful
 */

class ProxyPool {
  /**
   * @param {string[]} proxies - Array of proxy URLs
   * @param {object} options
   */
  constructor(proxies = [], options = {}) {
    this.proxies = proxies.map(url => ({
      url,
      fails: 0,
      successes: 0,
      lastUsed: 0,
      cooldownUntil: 0,
    }));
    this.options = {
      maxFailsBeforeCooldown: 3,
      cooldownMs: 60000,          // 1 min cooldown after max fails
      maxFailsBeforeRemove: 10,   // Remove from pool if fails too many times
      ...options,
    };
    this._index = 0;
  }

  /**
   * Add proxy to pool
   */
  add(proxyUrl) {
    this.proxies.push({ url: proxyUrl, fails: 0, successes: 0, lastUsed: 0, cooldownUntil: 0 });
  }

  /**
   * Get next available proxy (round-robin, skip cooled-down)
   * Returns null if all proxies are dead
   */
  next() {
    const now = Date.now();
    const available = this.proxies.filter(p =>
      p.cooldownUntil <= now && p.fails < this.options.maxFailsBeforeRemove
    );

    if (available.length === 0) {
      // Reset all cooldowns if everything is dead
      this.proxies.forEach(p => p.cooldownUntil = 0);
      console.warn('[ProxyPool] All proxies in cooldown — resetting');
      return this.proxies.length > 0 ? this.proxies[0].url : null;
    }

    // Round-robin through available
    this._index = this._index % available.length;
    const proxy = available[this._index];
    this._index = (this._index + 1) % available.length;
    proxy.lastUsed = now;
    return proxy.url;
  }

  /**
   * Mark a proxy as failed
   */
  markBad(proxyUrl) {
    const p = this.proxies.find(x => x.url === proxyUrl);
    if (p) {
      p.fails++;
      p.successes = 0;
      if (p.fails >= this.options.maxFailsBeforeCooldown) {
        p.cooldownUntil = Date.now() + this.options.cooldownMs;
        console.warn(`[ProxyPool] ${proxyUrl} cooled down for ${this.options.cooldownMs}ms (fails: ${p.fails})`);
      }
    }
  }

  /**
   * Mark a proxy as successful
   */
  markGood(proxyUrl) {
    const p = this.proxies.find(x => x.url === proxyUrl);
    if (p) {
      p.successes++;
      p.fails = 0;  // Reset fail count on success
    }
  }

  /**
   * Get stats about pool health
   */
  stats() {
    const total = this.proxies.length;
    const alive = this.proxies.filter(p =>
      p.cooldownUntil <= Date.now() && p.fails < this.options.maxFailsBeforeRemove
    ).length;
    return { total, alive, dead: total - alive };
  }

  /**
   * Check if pool is usable
   */
  isUsable() {
    return this.proxies.length > 0 && this.proxies.some(p =>
      p.fails < this.options.maxFailsBeforeRemove
    );
  }
}

module.exports = { ProxyPool };
