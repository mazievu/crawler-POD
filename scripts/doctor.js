/**
 * Runtime diagnostics for local scraping dependencies.
 */

const { spawnSync } = require('child_process');
const { isReady: searxngReady } = require('./start-searxng');
const { isReady: cdpReady, findBrowser } = require('./start-cdp');

function commandOk(command, args) {
  return spawnSync(command, args, { stdio: 'ignore', shell: false }).status === 0;
}

async function main() {
  const checks = [
    { name: 'Node.js', ok: true, detail: process.version },
    { name: 'Docker', ok: commandOk('docker', ['--version']), detail: 'needed to auto-start SearXNG' },
    { name: 'Browser executable', ok: Boolean(findBrowser()), detail: findBrowser() || 'set CHROME_PATH' },
    { name: 'SearXNG ready', ok: await searxngReady(), detail: process.env.SEARXNG_URL || 'http://localhost:8888' },
    { name: 'CDP ready', ok: await cdpReady(), detail: process.env.CDP_URL || 'http://localhost:9222' },
  ];

  console.log('\nRuntime doctor\n');
  for (const check of checks) {
    console.log((check.ok ? 'PASS ' : 'FAIL ') + check.name + ' — ' + check.detail);
  }

  const failed = checks.filter(check => !check.ok);
  if (failed.length) {
    console.log('\nRun `npm run start:deps` to start local services where possible.');
  }

  if (process.argv.includes('--strict') && failed.length) process.exit(1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
