/**
 * Start local runtime dependencies needed by free-first scraping.
 */

const { spawnSync } = require('child_process');
require('dotenv').config();

const OPTIONAL = process.argv.includes('--optional');
if (process.env.SKIP_DEPS === 'true' || process.env.SKIP_DEPS === '1') {
  console.log('[Deps] Skipping dependency probes (SKIP_DEPS=1)');
  process.exit(0);
}


function run(label, script) {
  console.log('\n[' + label + ']');
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    if (!OPTIONAL) process.exit(result.status || 1);
    console.log('[' + label + '] Not ready; continuing because startup is optional');
  }
}

run('SearXNG', require.resolve('./start-searxng'));
run('CDP', require.resolve('./start-cdp'));

console.log('\n[Deps] Ready');
