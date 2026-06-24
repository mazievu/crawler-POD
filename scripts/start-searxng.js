/**
 * Start SearXNG for local search discovery.
 *
 * Uses Docker when SearXNG is not already reachable. This keeps the app
 * free-first without requiring a hosted search API.
 */

const { spawnSync } = require('child_process');

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';
const CONTAINER_NAME = process.env.SEARXNG_CONTAINER || 'apify-collector-searxng';
const IMAGE = process.env.SEARXNG_IMAGE || 'searxng/searxng:latest';
const PORT = new URL(SEARXNG_URL).port || '8888';

async function isReady() {
  try {
    const resp = await fetch(SEARXNG_URL + '/search?q=health&format=json', {
      signal: AbortSignal.timeout(4000),
    });
    return resp.ok;
  } catch (_err) {
    return false;
  }
}

function run(command, args) {
  return spawnSync(command, args, { stdio: 'inherit', shell: false });
}

function dockerAvailable() {
  return spawnSync('docker', ['--version'], { stdio: 'ignore', shell: false }).status === 0;
}

function containerExists() {
  const result = spawnSync('docker', ['container', 'inspect', CONTAINER_NAME], {
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
}

async function waitUntilReady() {
  for (let i = 0; i < 30; i++) {
    if (await isReady()) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  if (await isReady()) {
    console.log('[SearXNG] Ready at ' + SEARXNG_URL);
    return;
  }

  if (!dockerAvailable()) {
    throw new Error('SearXNG is not running and Docker is not available. Install Docker or start SearXNG at ' + SEARXNG_URL);
  }

  if (containerExists()) {
    console.log('[SearXNG] Starting existing container ' + CONTAINER_NAME);
    const start = run('docker', ['start', CONTAINER_NAME]);
    if (start.status !== 0) throw new Error('Failed to start existing SearXNG container');
  } else {
    console.log('[SearXNG] Creating container ' + CONTAINER_NAME + ' on port ' + PORT);
    const create = run('docker', [
      'run',
      '-d',
      '--name', CONTAINER_NAME,
      '-p', PORT + ':8080',
      '-e', 'BASE_URL=' + SEARXNG_URL + '/',
      IMAGE,
    ]);
    if (create.status !== 0) throw new Error('Failed to create SearXNG container');
  }

  if (!(await waitUntilReady())) {
    throw new Error('SearXNG did not become ready at ' + SEARXNG_URL);
  }

  console.log('[SearXNG] Ready at ' + SEARXNG_URL);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[SearXNG] ' + err.message);
    process.exit(1);
  });
}

module.exports = { isReady };
