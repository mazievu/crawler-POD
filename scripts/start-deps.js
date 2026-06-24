/**
 * Start local runtime dependencies needed by free-first scraping.
 */

const { spawnSync } = require('child_process');

function run(label, script) {
  console.log('\n[' + label + ']');
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

run('SearXNG', require.resolve('./start-searxng'));
run('CDP', require.resolve('./start-cdp'));

console.log('\n[Deps] Ready');
