const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyPoolManager } = require('../src/proxy/proxy-pool');
const { ResourceScheduler } = require('../src/scheduler/scheduler');

function createTestPool(proxies = null, options = {}) {
  const defaultProxies = proxies || [
    { id: 'proxy-A', protocol: 'http', host: '10.0.0.1', port: 8080, enabled: true },
    { id: 'proxy-B', protocol: 'socks5', host: '10.0.0.2', port: 1080, enabled: true },
    { id: 'proxy-C', protocol: 'http', host: '10.0.0.3', port: 3128, enabled: true },
  ];

  return new ProxyPoolManager({
    enabled: true,
    proxies: defaultProxies,
    failureThreshold: 2,
    cooldownMs: 100, // Short cooldown for fast testing
    maxProxyRotations: 3,
    ...options
  });
}

// Test A — Round robin (A -> B -> C -> A)
test('Test A — Round robin acquisition cycles through available proxies', () => {
  const pool = createTestPool();

  const run1 = pool.acquire('token-1');
  const run2 = pool.acquire('token-2');
  const run3 = pool.acquire('token-3');
  const run4 = pool.acquire('token-4');

  assert.equal(run1.proxy.id, 'proxy-A');
  assert.equal(run2.proxy.id, 'proxy-B');
  assert.equal(run3.proxy.id, 'proxy-C');
  assert.equal(run4.proxy.id, 'proxy-A');
});

// Test B — Auto failover (A -> 403 block -> A in cooldown -> retry with B -> success)
test('Test B — Auto failover handles blocked proxy and recovers with next proxy', async () => {
  const pool = createTestPool();
  let attemptCount = 0;
  const usedProxies = [];

  const result = await pool.withProxyFailover('token-exec-1', async (proxy) => {
    attemptCount++;
    usedProxies.push(proxy.id);
    if (proxy.id === 'proxy-A') {
      const err = new Error('HTTP 403 Forbidden - Access Denied by Cloudflare');
      err.status = 403;
      throw err;
    }
    return { data: 'success_from_' + proxy.id };
  });

  assert.equal(result.data, 'success_from_proxy-B');
  assert.equal(attemptCount, 2);
  assert.deepEqual(usedProxies, ['proxy-A', 'proxy-B']);

  const status = pool.getStatus();
  const proxyA = status.proxies.find(p => p.id === 'proxy-A');
  const proxyB = status.proxies.find(p => p.id === 'proxy-B');

  assert.equal(proxyA.state, 'COOLDOWN');
  assert.equal(proxyB.state, 'HEALTHY');
});

// Test C — Không ban proxy sai (HTTP 404 product not found does NOT ban proxy)
test('Test C — Normal errors like HTTP 404 do NOT mark proxy blocked or in cooldown', async () => {
  const pool = createTestPool();

  await assert.rejects(
    async () => {
      await pool.withProxyFailover('token-404', async (proxy) => {
        const notFoundErr = new Error('Product not found (HTTP 404)');
        notFoundErr.status = 404;
        throw notFoundErr;
      });
    },
    (err) => err.message.includes('404')
  );

  const status = pool.getStatus();
  const proxyA = status.proxies.find(p => p.id === 'proxy-A');
  assert.equal(proxyA.state, 'HEALTHY', 'Proxy must remain HEALTHY after 404');
  assert.equal(proxyA.consecutiveFailures, 0, 'consecutiveFailures must not increment on 404');
});

// Test D — Pool exhausted (A, B, C all blocked -> PROXY_POOL_EXHAUSTED, bounded rotations)
test('Test D — Bounded rotations and PROXY_POOL_EXHAUSTED when all proxies fail', async () => {
  const pool = createTestPool(null, { maxProxyRotations: 3 });
  let attempts = 0;

  await assert.rejects(
    async () => {
      await pool.withProxyFailover('token-exhaust', async () => {
        attempts++;
        const blockErr = new Error('ECONNREFUSED proxy connection error');
        blockErr.code = 'ECONNREFUSED';
        throw blockErr;
      });
    },
    (err) => {
      assert.equal(err.code, 'PROXY_POOL_EXHAUSTED');
      return true;
    }
  );

  assert.equal(attempts, 3, 'Must stop after exactly maxProxyRotations=3 without infinite looping');
  assert.equal(pool.getAvailable().length, 0, 'No proxies should be available');
});

// Test E — Cooldown recovery (after cooldown elapsed, proxy becomes available again)
test('Test E — Proxies in cooldown automatically recover after cooldown period elapses', async () => {
  const pool = createTestPool(null, { cooldownMs: 40 });

  pool.markBlocked('proxy-A', 'SIMULATED_BLOCK');
  assert.equal(pool.proxies.get('proxy-A').state, 'COOLDOWN');

  // Immediately checked: proxy-A is not available
  const availableImmediate = pool.getAvailable().map(p => p.id);
  assert.equal(availableImmediate.includes('proxy-A'), false);

  // Wait for cooldown to expire
  await new Promise(resolve => setTimeout(resolve, 60));

  // Re-check: proxy-A has auto-recovered to HEALTHY
  const availableAfter = pool.getAvailable().map(p => p.id);
  assert.equal(availableAfter.includes('proxy-A'), true);
  assert.equal(pool.proxies.get('proxy-A').state, 'HEALTHY');
});

// Test F — Concurrent ownership (Token-1 -> A, Token-2 -> B, Token-3 -> C, release correctly)
test('Test F — Concurrent ownership maps execution tokens to distinct proxies and tracks release', () => {
  const pool = createTestPool();

  const acq1 = pool.acquire('token-1');
  const acq2 = pool.acquire('token-2');
  const acq3 = pool.acquire('token-3');

  assert.equal(acq1.proxy.id, 'proxy-A');
  assert.equal(acq2.proxy.id, 'proxy-B');
  assert.equal(acq3.proxy.id, 'proxy-C');

  assert.equal(pool.activeReservations.get('token-1'), 'proxy-A');
  assert.equal(pool.activeReservations.get('token-2'), 'proxy-B');
  assert.equal(pool.activeReservations.get('token-3'), 'proxy-C');

  pool.release('token-2');
  assert.equal(pool.activeReservations.has('token-2'), false);
  assert.equal(pool.activeReservations.get('token-1'), 'proxy-A');
  assert.equal(pool.activeReservations.get('token-3'), 'proxy-C');

  pool.release('token-1');
  pool.release('token-3');
  assert.equal(pool.activeReservations.size, 0);
});

// Test G — Abort/failure cleanup in ResourceScheduler
test('Test G — Scheduler automatically releases proxy reservation upon execution completion or abort', async () => {
  const pool = createTestPool();
  const mockDb = {
    getAllRuns: () => [],
    getRunsByStatus: () => [],
    getRunById: () => null,
    updateRun: () => {},
    getChildRuns: () => []
  };

  const scheduler = new ResourceScheduler({
    database: mockDb,
    proxyPool: pool,
    planner: { plan: async () => ({ platform: 'shopify', pool: 'LOCAL', estimatedEnvelopeMB: 50, shardCount: 1, options: {} }) },
    executeRun: async () => {
      throw new Error('SIMULATED_RUN_FAILURE');
    }
  });

  const token = 'exec-token-test-g';
  // Simulate acquiring proxy during run dispatch
  pool.acquire(token);
  assert.equal(pool.activeReservations.has(token), true);

  // Trigger dispatchRun which rejects and enters finally
  scheduler.dispatchRun({ id: 999 }, { pool: 'LOCAL', estimatedEnvelopeMB: 50 }, 'LOCAL', token, 1);

  await new Promise(r => setTimeout(r, 60));

  assert.equal(pool.activeReservations.has(token), false, 'Proxy reservation must be cleaned up in finally block with 0 orphans');
});
