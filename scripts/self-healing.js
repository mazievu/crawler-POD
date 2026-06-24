/**
 * Self-Healing Scraper
 * Vòng lặp tự động: code → test → detect block → fix → retry → log
 *
 * Usage:
 *   node scripts/self-healing.js <platform> <keyword>
 *   node scripts/self-healing.js all "press on nail"
 *   node scripts/self-healing.js --loop           (tuần tự từng platform)
 *   node scripts/self-healing.js --phase 1        (chạy Phase 1)
 */

const { scrapeWithRetry, setProxies, getPlatformsByTier } = require('../anti-bot/scraper-factory');
const fs = require('fs');
const path = require('path');

const PHASES = [
  ['reddit', 'ebay', 'shopify', 'etsy', 'pinterest'],
  ['facebook_ads', 'twitter', 'google_shopping'],
  ['amazon', 'tiktok_shop', 'instagram', 'tiktok_ads'],
];

const DEFAULT_KEYWORD = 'press on nail';
const LOG_DIR = path.join(__dirname, '..', 'data', 'scrape-logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * Load proxies from env or file
 */
function loadProxies() {
  const proxyStr = process.env.PROXY_LIST || '';
  if (proxyStr) return proxyStr.split(',').map(s => s.trim()).filter(Boolean);

  const proxyFile = path.join(__dirname, '..', 'proxies.txt');
  if (fs.existsSync(proxyFile)) {
    return fs.readFileSync(proxyFile, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Run self-healing scrape for one platform
 */
async function runPlatform(platform, keyword) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  🚀 Platform: ${platform}`);
  console.log(`  🔍 Query: "${keyword}"`);
  console.log(`${'='.repeat(60)}`);

  const startTime = Date.now();

  try {
    const result = await scrapeWithRetry(platform, keyword);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n✅ ${platform}: ${result.items.length} items in ${result.attempts} attempt(s), ${elapsed}s`);

    // Save result
    const logFile = path.join(LOG_DIR, `${platform}-${Date.now()}.json`);
    fs.writeFileSync(logFile, JSON.stringify({
      platform,
      query: keyword,
      attempts: result.attempts,
      itemCount: result.items.length,
      elapsed,
      timestamp: new Date().toISOString(),
      sample: result.items.slice(0, 3),
    }, null, 2));
    console.log(`📁 Saved to ${logFile}`);

    return { success: true, platform, items: result.items.length, attempts: result.attempts };
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.error(`\n❌ ${platform}: FAILED after ${elapsed}s`);
    console.error(`   ${err.message.slice(0, 200)}`);

    // Log failure
    const logFile = path.join(LOG_DIR, `${platform}-FAILED-${Date.now()}.json`);
    fs.writeFileSync(logFile, JSON.stringify({
      platform,
      query: keyword,
      status: 'failed',
      error: err.message.slice(0, 500),
      elapsed,
      timestamp: new Date().toISOString(),
    }, null, 2));

    return { success: false, platform, error: err.message.slice(0, 200), attempts: err.attempts || 0 };
  }
}

/**
 * Run all platforms
 */
async function runAll(keyword) {
  const results = { passed: [], failed: [] };
  const allPlatforms = [...new Set(Object.values(PHASES).flat())];

  for (const platform of allPlatforms) {
    const r = await runPlatform(platform, keyword);
    if (r.success) results.passed.push(r);
    else results.failed.push(r);
  }

  printSummary(results);
}

/**
 * Run a specific phase
 */
async function runPhase(phaseNum, keyword) {
  const platforms = PHASES[phaseNum - 1];
  if (!platforms) throw new Error(`Phase ${phaseNum} not found (1-${PHASES.length})`);

  console.log(`\n📌 Running Phase ${phaseNum}: [${platforms.join(', ')}]`);
  const results = { passed: [], failed: [] };

  for (const platform of platforms) {
    const r = await runPlatform(platform, keyword);
    if (r.success) results.passed.push(r);
    else results.failed.push(r);
  }

  printSummary(results);
}

/**
 * Print summary
 */
function printSummary(results) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  📊 FINAL SUMMARY`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  ✅ Passed: ${results.passed.length}`);
  results.passed.forEach(r => console.log(`    • ${r.platform}: ${r.items} items in ${r.attempts} attempts`));
  if (results.failed.length > 0) {
    console.log(`  ❌ Failed: ${results.failed.length}`);
    results.failed.forEach(r => console.log(`    • ${r.platform}: ${r.error}`));
  }
}

// ==================== CLI ====================

async function main() {
  const proxies = loadProxies();
  if (proxies.length > 0) {
    setProxies(proxies);
    console.log(`🔌 Loaded ${proxies.length} proxies`);
  } else {
    console.log('🔌 No proxies configured — running direct (ok for free APIs)');
  }

  const args = process.argv.slice(2);

  if (args.includes('--loop')) {
    await runAll(DEFAULT_KEYWORD);
  } else if (args.includes('--phase')) {
    const idx = args.indexOf('--phase');
    const phaseNum = parseInt(args[idx + 1]) || 1;
    const keyword = args[idx + 2] || DEFAULT_KEYWORD;
    await runPhase(phaseNum, keyword);
  } else if (args[0] === 'all') {
    const keyword = args[1] || DEFAULT_KEYWORD;
    await runAll(keyword);
  } else if (args[0]) {
    const platform = args[0];
    const keyword = args[1] || DEFAULT_KEYWORD;
    await runPlatform(platform, keyword);
  } else {
    console.log(`
Usage:
  node scripts/self-healing.js <platform> <keyword>     — single platform
  node scripts/self-healing.js all <keyword>             — all platforms
  node scripts/self-healing.js --phase 1 <keyword>       — Phase 1 only
  node scripts/self-healing.js --loop                    — all + default keyword
    `);
  }
}

if (require.main === module) main();

module.exports = { runPlatform, runAll, runPhase };
