/**
 * Live Data Loop (P1-5 audit note)
 *
 * PURPOSE: a manual/CI proof-of-life tool. It calls scrapers directly from
 * src/scrapers/*, writes raw proof JSON to data/scrape-logs/, and never creates
 * a `runs` row or touches the Resource Scheduler, RunQueue, or WorkerPoolManager.
 * It exists to answer "can we still scrape platform X right now at all" — it is
 * NOT a production scheduling component and must never be treated as one.
 *
 * This is a DIFFERENT thing from src/social-bots/social-scheduler.js, which IS
 * a production component: it creates real `runs` rows, persists dedupe state in
 * SQLite (social_bot_state), and submits every job through ResourceScheduler so
 * admission control / worker pools / RAM reservation apply. Do not merge the two
 * or route this script's output through the scheduler — they serve different
 * concerns (ad-hoc scrape health check vs. managed recurring collection).
 *
 * Daemon-mode behavior (audited against the P1-5 checklist):
 *  - `--once` / RUN_ONCE=true: single-shot, exits after first success (or
 *    NO_DATA_WRITTEN failure) — used by CI/manual verification.
 *  - default (no flag): persistent loop with `running` flag + SIGINT/SIGTERM
 *    handlers for graceful shutdown; each full cycle sleeps LOOP_DELAY_MS
 *    (default 10s) before the next, so a run of all-failing attempts still
 *    cannot busy-loop indefinitely — it is bounded by one sleep per cycle.
 *  - Individual attempts within a cycle have no per-attempt backoff/delay; this
 *    is acceptable for a low-frequency manual diagnostic tool but would not be
 *    appropriate for a high-frequency production poller (which is what
 *    RetryPolicy's exponential backoff in src/reliability/retry-policy.js is
 *    for, and which this script intentionally does not use).
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
  const isOnce = process.argv.includes('--once') || process.env.RUN_ONCE === 'true';
  const loopDelayMs = parseInt(process.env.LOOP_DELAY_MS || '10000', 10);
  const proxies = loadProxies();
  const attempts = [];

  let running = true;
  process.on('SIGINT', () => { console.log('\n[LiveDataLoop] Gracefully shutting down...'); running = false; });
  process.on('SIGTERM', () => { console.log('\n[LiveDataLoop] Gracefully shutting down...'); running = false; });

  const plan = [
    // Highest success probability, no proxy/API key.
    { platform: 'shopify', queries: ['colourpop.com', 'gymshark.com', 'allbirds.com', 'fashionnova.com'], proxies: [null] },

    // Public pages, proxy helps.
    { platform: 'ebay', queries: ['press on nail', 'custom tshirt', 'pet portrait'], proxies: proxies.length ? proxies : [null] },

    // Reddit currently blocks these proxy IPs, but keep in loop for proof.
    { platform: 'reddit', queries: ['press on nail', 'custom tshirt'], proxies: proxies.length ? proxies : [null] },
  ];

  let successCount = 0;
  let cycle = 0;

  while (running) {
    cycle++;
    console.log(`\n[LiveDataLoop] Starting collection cycle #${cycle}...`);
    let cycleSuccess = false;

    for (const step of plan) {
      if (!running) break;
      for (const query of step.queries) {
        if (!running) break;
        for (const proxyUrl of step.proxies) {
          if (!running) break;
          const attempt = { platform: step.platform, query, proxy: safeProxy(proxyUrl), at: new Date().toISOString(), cycle };
          attempts.push(attempt);
          console.log('ATTEMPT', JSON.stringify(attempt));
          try {
            const result = await tryScraper(step.platform, query, { limit: 10, proxyUrl }, attempts);
            console.log('SUCCESS', JSON.stringify(result, null, 2));
            successCount++;
            cycleSuccess = true;

            if (isOnce) {
              console.log('[LiveDataLoop] --once flag detected, exiting after successful run.');
              process.exit(0);
            }
          } catch (err) {
            const d = diagnose(err);
            attempt.error = err.message.slice(0, 200);
            attempt.diagnosis = d;
            console.log('FAIL', step.platform, query, safeProxy(proxyUrl), d.reason, err.message.slice(0, 160));
          }
        }
      }
    }

    if (!isOnce && running) {
      console.log(`[LiveDataLoop] Cycle #${cycle} finished (Total Successes: ${successCount}). Sleeping for ${loopDelayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, loopDelayMs));
    } else {
      break;
    }
  }

  if (successCount === 0) {
    const failFile = path.join(LOG_DIR, 'proof-failed-' + Date.now() + '.json');
    fs.writeFileSync(failFile, JSON.stringify({ ok: false, attempts }, null, 2));
    console.error('NO_DATA_WRITTEN', failFile);
    process.exit(1);
  }
}

if (require.main === module) main();
