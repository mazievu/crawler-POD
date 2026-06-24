/**
 * Live Data Loop
 * Goal: keep trying platforms/proxies/queries until real data is collected.
 * Stops only after writing proof JSON.
 */

const fs = require('fs');
const path = require('path');
const { diagnose } = require('../anti-bot/error-diagnose');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'data', 'scrape-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function loadProxies() {
  const p = path.join(ROOT, 'proxies.txt');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function safeProxy(p) {
  return p ? p.replace(/https?:\/\/[^:]+:[^@]+@/, 'http://***:***@') : 'direct';
}

function saveProof(platform, query, result, attempts) {
  const items = result.items || result.results || result;
  if (!Array.isArray(items) || !items.length) throw new Error('no items to save');
  const out = path.join(LOG_DIR, 'proof-' + platform + '-' + Date.now() + '.json');
  fs.writeFileSync(out, JSON.stringify({
    ok: true,
    platform,
    query,
    count: items.length,
    scrapedAt: new Date().toISOString(),
    attempts,
    items,
  }, null, 2));
  return out;
}

async function tryScraper(platform, query, opts, attempts) {
  const mod = require('../src/scrapers/' + platform);
  const started = Date.now();
  const result = await mod.scrape(query, opts || {});
  const items = result.items || result.results || result;
  if (!Array.isArray(items) || !items.length) throw new Error('EMPTY_RESULT: no data returned');
  const file = saveProof(platform, query, result, attempts);
  return { platform, query, count: items.length, file, first: items[0], ms: Date.now() - started };
}

async function main() {
  const proxies = loadProxies();
  const attempts = [];

  const plan = [
    // Highest success probability, no proxy/API key.
    { platform: 'shopify', queries: ['colourpop.com', 'gymshark.com', 'allbirds.com', 'fashionnova.com'], proxies: [null] },

    // Public pages, proxy helps.
    { platform: 'ebay', queries: ['press on nail', 'custom tshirt', 'pet portrait'], proxies: proxies.length ? proxies : [null] },

    // Reddit currently blocks these proxy IPs, but keep in loop for proof.
    { platform: 'reddit', queries: ['press on nail', 'custom tshirt'], proxies: proxies.length ? proxies : [null] },
  ];

  for (const step of plan) {
    for (const query of step.queries) {
      for (const proxyUrl of step.proxies) {
        const attempt = { platform: step.platform, query, proxy: safeProxy(proxyUrl), at: new Date().toISOString() };
        attempts.push(attempt);
        console.log('ATTEMPT', JSON.stringify(attempt));
        try {
          const result = await tryScraper(step.platform, query, { limit: 10, proxyUrl }, attempts);
          console.log('SUCCESS', JSON.stringify(result, null, 2));
          process.exit(0);
        } catch (err) {
          const d = diagnose(err);
          attempt.error = err.message.slice(0, 200);
          attempt.diagnosis = d;
          console.log('FAIL', step.platform, query, safeProxy(proxyUrl), d.reason, err.message.slice(0, 160));
        }
      }
    }
  }

  const failFile = path.join(LOG_DIR, 'proof-failed-' + Date.now() + '.json');
  fs.writeFileSync(failFile, JSON.stringify({ ok: false, attempts }, null, 2));
  console.error('NO_DATA_WRITTEN', failFile);
  process.exit(1);
}

if (require.main === module) main();
