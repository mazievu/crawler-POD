const assert = require('assert');
const { test, mock } = require('node:test');
const cdpBackend = require('../src/backends/cdp.backend');
const LocalScraperBackend = require('../src/backends/local-scraper.backend');

test('CDP unreachable probe', async () => {
  const backend = new cdpBackend();
  // Override process.env to ensure a bad port
  process.env.CDP_URL = 'http://localhost:11111';
  const result = await backend.probe({}, {});
  assert.strictEqual(result.status, 'failed');
  assert.ok(result.checkedUrl.includes('11111'));
  assert.ok(result.actions[0].includes('Start Chrome'));
});

test('CDP reachable probe', async () => {
  const backend = new cdpBackend();
  process.env.CDP_URL = 'http://localhost:22222';
  
  // Mock global fetch
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('22222')) {
      return { ok: true, json: async () => ({ Browser: 'Chrome/1.0', webSocketDebuggerUrl: 'ws://' }) };
    }
    throw new Error('Network error');
  };

  const result = await backend.probe({}, {});
  assert.strictEqual(result.status, 'ok');
  assert.ok(result.checkedUrl.includes('22222'));

  global.fetch = originalFetch; // restore
});

test('SearXNG 8080 default', async () => {
  // Test local scraper probe with Google Shopping, which has no non-SearXNG
  // discovery path (unlike Etsy since its CloakBrowser-primary round —
  // requires SearXNG)
  const backend = new LocalScraperBackend();
  delete process.env.SEARXNG_URL; // Force default
  const originalFetch = global.fetch;
  
  let fetchedUrl = '';
  global.fetch = async (url) => {
    fetchedUrl = url;
    throw new Error('Network error'); // Simulate unreachable
  };

  const result = await backend.probe({ name: 'google_shopping' }, {});
  assert.strictEqual(result.status, 'failed');
  assert.ok(result.checkedUrl.includes('8080'));
  assert.strictEqual(fetchedUrl, 'http://localhost:8080');

  global.fetch = originalFetch;
});

test('SearXNG required channel unreachable', async () => {
  const backend = new LocalScraperBackend();
  process.env.SEARXNG_URL = 'http://localhost:33333';
  
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network error'); };

  const result = await backend.probe({ name: 'google_shopping' }, {});
  assert.strictEqual(result.status, 'failed');
  assert.ok(result.missing.includes('SEARXNG'));
  assert.ok(result.checkedUrl.includes('33333'));

  global.fetch = originalFetch;
});

test('Reddit local no-SearXNG path', async () => {
  const backend = new LocalScraperBackend();
  process.env.SEARXNG_URL = 'http://localhost:44444';
  
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network error'); };

  const result = await backend.probe({ name: 'reddit' }, {});
  assert.strictEqual(result.status, 'ok'); // Reddit shouldn't fetch SearXNG
  assert.ok(!result.missing);

  global.fetch = originalFetch;
});

test('Unsupported local channel', async () => {
  const backend = new LocalScraperBackend();
  const result = await backend.probe({ name: 'facebook_ads' }, {});
  assert.strictEqual(result.status, 'unsupported');
  assert.ok(result.warnings[0].includes('not implemented'));
});

test('Toidispy stdout parse', async () => {
  const backend = new cdpBackend();
  const child_process = require('child_process');
  
  // Mock spawn
  const originalSpawn = child_process.spawn;
  child_process.spawn = () => {
    const EventEmitter = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    
    setTimeout(() => {
      child.stdout.emit('data', JSON.stringify({ items: [{ id: 1 }] }));
      child.stderr.emit('data', 'Some warning log');
      child.emit('close', 0);
    }, 10);
    
    return child;
  };

  const result = await backend.run({ name: 'toidispy' }, {}, 'test');
  assert.strictEqual(result.rawStatus, 'SUCCEEDED');
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].id, 1);

  child_process.spawn = originalSpawn;
});

test('Toidispy invalid stdout', async () => {
  const backend = new cdpBackend();
  const child_process = require('child_process');
  
  const originalSpawn = child_process.spawn;
  child_process.spawn = () => {
    const EventEmitter = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    
    setTimeout(() => {
      child.stdout.emit('data', 'Not JSON at all');
      child.emit('close', 0);
    }, 10);
    
    return child;
  };

  const result = await backend.run({ name: 'toidispy' }, {}, 'test');
  assert.strictEqual(result.rawStatus, 'FAILED');
  assert.ok(result.healthSnapshot.error.includes('valid JSON'));

  child_process.spawn = originalSpawn;
});

test('Toidispy CDP non-zero exit diagnostic parsing', async () => {
  const backend = new cdpBackend();
  const child_process = require('child_process');
  
  const originalSpawn = child_process.spawn;
  child_process.spawn = () => {
    const EventEmitter = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    
    setTimeout(() => {
      const stdoutError = { error: { message: 'Stdout error', currentUrl: 'http://stdout.com' } };
      child.stdout.emit('data', JSON.stringify(stdoutError) + '\n');
      
      const stderrDiagnostic = { event: 'toidispy_fatal', message: 'Fatal crash', currentUrl: 'http://fatal.com' };
      child.stderr.emit('data', 'Some warning\n' + JSON.stringify(stderrDiagnostic) + '\n');
      child.emit('close', 1);
    }, 10);
    
    return child;
  };

  const result = await backend.run({ name: 'toidispy' }, {}, 'test');
  assert.strictEqual(result.rawStatus, 'FAILED');
  assert.ok(result.healthSnapshot.error.includes('Stdout error'));
  assert.strictEqual(result.healthSnapshot.stdoutJson.error.currentUrl, 'http://stdout.com');
  assert.strictEqual(result.healthSnapshot.stderrDiagnostic.message, 'Fatal crash');

  child_process.spawn = originalSpawn;
});

test('Toidispy params propagation', async () => {
  const backend = new cdpBackend();
  const child_process = require('child_process');
  
  let spawnedArgs = [];
  const originalSpawn = child_process.spawn;
  child_process.spawn = (cmd, args) => {
    spawnedArgs = args;
    const EventEmitter = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      child.stdout.emit('data', JSON.stringify({ items: [] }));
      child.emit('close', 0);
    }, 10);
    return child;
  };

  await backend.run({ name: 'toidispy' }, {}, 'mykeyword', { section: 'ads', filters: { f1: 'v1' } });
  
  assert.ok(spawnedArgs.includes('--section'));
  assert.ok(spawnedArgs.includes('ads'));
  assert.ok(spawnedArgs.includes('--filters'));
  assert.ok(spawnedArgs.includes(JSON.stringify({ f1: 'v1' })));

  child_process.spawn = originalSpawn;
});

test('Doctor regression', async () => {
  const { runDoctor } = require('../src/doctor');
  process.env.CDP_URL = 'http://localhost:55555';
  process.env.SEARXNG_URL = 'http://localhost:55555';

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network error'); };

  const report = await runDoctor();
  
  if (!report.channels.toidispy || !report.channels.toidispy.backends) {
    console.error('Missing toidispy backends:', report.channels.toidispy);
  }
  const toidispyCdp = report.channels.toidispy.backends.find(b => b.name === 'cdp');
  assert.ok(toidispyCdp, 'toidispyCdp should be found');
  assert.strictEqual(toidispyCdp.status, 'failed');

  global.fetch = originalFetch;
});
