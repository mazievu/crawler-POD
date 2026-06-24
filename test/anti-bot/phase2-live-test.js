/**
 * Phase 2 live probes for platforms that are not yet verified end-to-end.
 *
 * Default mode records pass/fail without failing the process. Use --strict to
 * exit non-zero when a platform has no live data proof.
 *
 * node test/anti-bot/phase2-live-test.js
 * node test/anti-bot/phase2-live-test.js --strict
 */

const fs = require('fs');
const path = require('path');
const { search } = require('../../scripts/searxng');

const ROOT = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT, 'data', 'scrape-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const STRICT = process.argv.includes('--strict');
const DEFAULT_LIMIT = 5;

const PLATFORMS = [
  {
    platform: 'amazon',
    status: 'candidate_free',
    source: 'searxng',
    queries: [
      'site:amazon.com/dp "press on nail"',
      'site:amazon.com/gp/product "press on nail"',
      'site:amazon.com "press on nails" "dp"',
    ],
    urlPattern: /amazon\.[^/]+\/(?:[^?]*\/)?(?:dp|gp\/product)\//i,
    paidFallback: ['Scrapingdog', 'Scrape.do', 'Apify amazon actor'],
  },
  {
    platform: 'google_shopping',
    status: 'needs_provider_or_better_probe',
    source: 'searxng',
    queries: [
      'site:shopping.google.com "press on nail"',
      'site:google.com/shopping/product "press on nail"',
      'press on nail Google Shopping product',
    ],
    urlPattern: /(?:shopping\.google\.com|google\.[^/]+\/shopping\/product)/i,
    paidFallback: ['Serper.dev Google Shopping', 'SerpAPI Google Shopping', 'Apify Google Shopping actor'],
  },
  {
    platform: 'facebook_posts',
    status: 'candidate_free',
    source: 'searxng',
    queries: [
      'site:facebook.com "press on nail" "posts"',
      'site:facebook.com/groups "press on nail"',
      'site:facebook.com/reel "press on nail"',
    ],
    urlPattern: /facebook\.com\/(?:groups\/[^/]+\/posts|[^/]+\/posts|reel\/)/i,
    paidFallback: ['Scrape Creators Facebook', 'Apify Facebook actors'],
  },
  {
    platform: 'twitter',
    status: 'candidate_free',
    source: 'searxng',
    queries: [
      'site:x.com "press on nail"',
      'site:twitter.com "press on nail"',
    ],
    urlPattern: /(?:x|twitter)\.com\/[^/]+\/status\/\d+/i,
    paidFallback: ['GetXAPI', 'Sorsa', 'Apify tweet scraper'],
  },
  {
    platform: 'instagram',
    status: 'candidate_free',
    source: 'searxng',
    queries: [
      'site:instagram.com/p "press on nail"',
      'site:instagram.com/reel "press on nail"',
    ],
    urlPattern: /instagram\.com\/(?:p|reel)\//i,
    paidFallback: ['Apify Instagram scraper', 'Scrape Creators Instagram', 'ScrapFly'],
  },
  {
    platform: 'tiktok',
    status: 'candidate_free',
    source: 'searxng',
    queries: [
      'site:tiktok.com/@ "press on nail"',
      'site:tiktok.com/@ "press on nails"',
    ],
    urlPattern: /tiktok\.com\/@[^/]+\/(?:video|photo)\//i,
    paidFallback: ['Apify clockworks/tiktok-scraper', 'Scrape Creators TikTok', 'SociaVault'],
  },
];

function cleanText(value, maxLength = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeResult(platform, result, sourceQuery) {
  return {
    platform,
    title: cleanText(result.title),
    url: result.url,
    content: cleanText(result.content, 500),
    source: 'searxng',
    engine: result.engine || '',
    sourceQuery,
  };
}

async function runProbe(config) {
  const attempts = [];
  const seen = new Set();
  const items = [];

  for (const query of config.queries) {
    const attempt = { query, at: new Date().toISOString() };
    attempts.push(attempt);

    try {
      const result = await search(query, {
        engines: 'google,bing,duckduckgo',
        categories: 'general',
      });

      attempt.count = (result.results || []).length;

      for (const row of result.results || []) {
        if (!config.urlPattern.test(row.url || '')) continue;
        if (seen.has(row.url)) continue;
        seen.add(row.url);
        items.push(normalizeResult(config.platform, row, query));
        if (items.length >= DEFAULT_LIMIT) break;
      }

      attempt.matches = items.length;
      if (items.length >= DEFAULT_LIMIT) break;
    } catch (err) {
      attempt.error = err.message;
    }
  }

  const ok = items.length > 0;
  return {
    ok,
    platform: config.platform,
    status: config.status,
    source: config.source,
    count: items.length,
    paidFallback: config.paidFallback,
    attempts,
    sample: items.slice(0, 3),
  };
}

function saveReport(results) {
  const out = path.join(LOG_DIR, 'phase2-live-' + Date.now() + '.json');
  fs.writeFileSync(out, JSON.stringify({
    ok: results.every(r => r.ok),
    generatedAt: new Date().toISOString(),
    results,
  }, null, 2));
  return out;
}

async function main() {
  console.log('\nPhase 2 live probes — unverified platforms\n');

  const results = [];
  for (const config of PLATFORMS) {
    const result = await runProbe(config);
    results.push(result);

    const mark = result.ok ? 'PASS' : 'FAIL';
    console.log(`${mark} ${result.platform}: ${result.count} item(s) via ${result.source}`);
    if (result.sample[0]) console.log('  ' + result.sample[0].title + ' -> ' + result.sample[0].url);
    if (!result.ok) console.log('  fallback candidates: ' + result.paidFallback.join(', '));
  }

  const report = saveReport(results);
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;

  console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
  console.log('Report: ' + report);

  if (STRICT && failed > 0) process.exit(1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { PLATFORMS, runProbe };
