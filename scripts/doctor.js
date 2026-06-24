/**
 * Runtime diagnostics for local scraping dependencies.
 */

const { spawnSync } = require('child_process');
require('dotenv').config();
const { isReady: searxngReady } = require('./start-searxng');
const { isReady: cdpReady, findBrowser } = require('./start-cdp');
const { checkAllCapabilities } = require('../src/capability-registry');

function commandOk(command, args) {
  return spawnSync(command, args, { stdio: 'ignore', shell: false }).status === 0;
}

async function main() {
  const searxng = await searxngReady();
  const cdp = await cdpReady();
  const checks = [
    { name: 'Node.js', ok: true, detail: process.version },
    { name: 'Docker', ok: commandOk('docker', ['--version']), detail: 'needed to auto-start SearXNG' },
    { name: 'Browser executable', ok: Boolean(findBrowser()), detail: findBrowser() || 'set CHROME_PATH' },
    { name: 'SearXNG ready', ok: searxng, detail: process.env.SEARXNG_URL || 'http://localhost:8888' },
    { name: 'CDP ready', ok: cdp, detail: process.env.CDP_URL || 'http://localhost:9222' },
  ];

  console.log('\nRuntime doctor\n');
  for (const check of checks) {
    console.log((check.ok ? 'PASS ' : 'FAIL ') + check.name + ' — ' + check.detail);
  }

  const failed = checks.filter(check => !check.ok);
  if (failed.length) {
    console.log('\nRun `npm run start:deps` to start local services where possible.');
  }

  const capabilities = await checkAllCapabilities({ searxng, cdp });
  console.log('\nPlatform capabilities\n');
  for (const capability of capabilities) {
    const active = capability.activeBackend;
    const paid = capability.backends
      .filter(backend => backend.kind === 'paid_api')
      .map(backend => backend.label);
    const activeText = active ? `${active.label} (${active.status})` : 'none';
    const paidText = paid.length ? ' | paid fallback: ' + paid.join(', ') : '';
    console.log(`${capability.name}: ${activeText}${paidText}`);
  }

  if (process.argv.includes('--strict') && failed.length) process.exit(1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
