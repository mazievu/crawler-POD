/**
 * Proxy Pool Bridge
 * Bridges legacy anti-bot ProxyPool with unified ProxyPoolManager in src/proxy
 */

const { ProxyPoolManager, getProxyPool } = require('../src/proxy/proxy-pool');
const { buildProxyUrl } = require('../src/marketplaces/proxy');

class ProxyPool {
  constructor(proxies = [], options = {}) {
    this.rawList = Array.isArray(proxies) ? proxies : [];
    this.options = {
      maxFailsBeforeCooldown: 3,
      cooldownMs: 60000,
      maxFailsBeforeRemove: 10,
      ...options
    };

    const proxyList = this.rawList.map((p, idx) => {
      if (typeof p === 'string') {
        let protocol = 'http';
        let host = p;
        let port = 80;
        let username = '';
        let password = '';
        try {
          if (p.includes('://')) {
            const parsed = new URL(p);
            protocol = parsed.protocol.replace(':', '');
            host = parsed.hostname;
            port = parseInt(parsed.port, 10) || 80;
            username = parsed.username || '';
            password = parsed.password || '';
          }
        } catch {
          // Keep fallback defaults
        }

        return {
          id: p,
          label: p,
          protocol,
          host,
          port,
          username,
          password,
          rawUrl: p,
          enabled: true
        };
      }
      return p;
    });

    this.manager = new ProxyPoolManager({
      enabled: proxyList.length > 0,
      proxies: proxyList,
      failureThreshold: this.options.maxFailsBeforeCooldown,
      cooldownMs: this.options.cooldownMs,
      maxProxyRotations: options.maxProxyRotations || 3,
      ...options
    });
  }

  add(proxyInput) {
    if (typeof proxyInput === 'string') {
      let protocol = 'http';
      let host = proxyInput;
      let port = 80;
      let username = '';
      let password = '';
      try {
        if (proxyInput.includes('://')) {
          const parsed = new URL(proxyInput);
          protocol = parsed.protocol.replace(':', '');
          host = parsed.hostname;
          port = parseInt(parsed.port, 10) || 80;
          username = parsed.username || '';
          password = parsed.password || '';
        }
      } catch {}

      this.manager.addProxy({
        id: proxyInput,
        label: proxyInput,
        protocol,
        host,
        port,
        username,
        password,
        rawUrl: proxyInput,
        enabled: true
      });
    } else {
      this.manager.addProxy(proxyInput);
    }
  }

  next(executionToken = null) {
    const admission = this.manager.acquire(executionToken);
    if (!admission.allowed || !admission.proxy) return null;
    return admission.proxy.rawUrl || admission.proxyUrl || admission.proxy.id;
  }

  markBad(proxyIdentifier) {
    for (const p of this.manager.proxies.values()) {
      if (p.id === proxyIdentifier || p.rawUrl === proxyIdentifier || p.host === proxyIdentifier || buildProxyUrl(p) === proxyIdentifier) {
        this.manager.markFailure(p.id, 'LEGACY_MARK_BAD');
        break;
      }
    }
  }

  markGood(proxyIdentifier) {
    for (const p of this.manager.proxies.values()) {
      if (p.id === proxyIdentifier || p.rawUrl === proxyIdentifier || p.host === proxyIdentifier || buildProxyUrl(p) === proxyIdentifier) {
        this.manager.markSuccess(p.id);
        break;
      }
    }
  }

  stats() {
    const status = this.manager.getStatus();
    return {
      total: status.total,
      alive: status.healthyCount,
      dead: status.cooldownCount + status.disabledCount
    };
  }

  isUsable() {
    return this.manager.getAvailable().length > 0;
  }
}

module.exports = {
  ProxyPool,
  ProxyPoolManager,
  getProxyPool
};
