/**
 * Phase 1 Test — Kiểm tra 5 scrapers dễ nhất
 * node test/anti-bot/phase1-test.js
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (err) {
    failed++;
    console.log('  ❌ ' + name + ': ' + err.message);
  }
}

console.log('\n📋 Phase 1 — Unit Tests\n');

// ==================== error-diagnose.js ====================

const { diagnose, getFixHint } = require('../../anti-bot/error-diagnose');

test('diagnose 403 returns BLOCKED_IP', () => {
  const d = diagnose(new Error('HTTP 403 Forbidden'));
  assert.strictEqual(d.reason, 'BLOCKED_IP');
  assert.strictEqual(d.action, 'swap_proxy');
});

test('diagnose 429 returns RATE_LIMITED', () => {
  const d = diagnose(new Error('HTTP 429 Too Many Requests'));
  assert.strictEqual(d.reason, 'RATE_LIMITED');
});

test('diagnose captcha returns CAPTCHA', () => {
  const d = diagnose(new Error('captcha required'));
  assert.strictEqual(d.reason, 'CAPTCHA');
});

test('diagnose timeout returns TIMEOUT', () => {
  const d = diagnose(new Error('TimeoutError: page.load'));
  assert.strictEqual(d.reason, 'TIMEOUT');
});

test('diagnose unknown returns UNKNOWN', () => {
  const d = diagnose(new Error('something weird'));
  assert.strictEqual(d.reason, 'UNKNOWN');
});

test('getFixHint returns string', () => {
  assert.ok(getFixHint('BLOCKED_IP').length > 0);
  assert.ok(getFixHint('UNKNOWN').length > 0);
});

// ==================== backoff.js ====================

const { calculateBackoff, getEscalationStep } = require('../../anti-bot/backoff');

test('backoff exponential increases', () => {
  const d1 = calculateBackoff(1, { backoff: 'exponential', baseDelay: 1000 });
  const d3 = calculateBackoff(3, { backoff: 'exponential', baseDelay: 1000 });
  assert.ok(d3 > d1);
});

test('backoff respects maxDelay (with jitter margin)', () => {
  const d = calculateBackoff(10, { backoff: 'exponential', baseDelay: 100000, maxDelay: 5000 });
  assert.ok(d <= 6000, 'Expected <=6000 got ' + d);
});

test('backoff custom sequence', () => {
  const d = calculateBackoff(1, { backoff: 'custom', sequence: [100, 200, 300] });
  assert.ok(d >= 80 && d <= 120);
});

test('escalation steps increase with attempts', () => {
  const step1 = getEscalationStep(1);
  const step5 = getEscalationStep(5);
  assert.notStrictEqual(step1.action, step5.action);
});

// ==================== proxy-pool.js ====================

const { ProxyPool } = require('../../anti-bot/proxy-pool');

test('proxy pool round-robin', () => {
  const pool = new ProxyPool(['p1', 'p2', 'p3']);
  assert.strictEqual(pool.next(), 'p1');
  assert.strictEqual(pool.next(), 'p2');
  assert.strictEqual(pool.next(), 'p3');
  assert.strictEqual(pool.next(), 'p1');
});

test('proxy pool marks bad and cools down', () => {
  const pool = new ProxyPool(['p1'], { maxFailsBeforeCooldown: 2, cooldownMs: 1000 });
  pool.markBad('p1');
  assert.strictEqual(pool.stats().alive, 1);
  pool.markBad('p1');
  assert.strictEqual(pool.stats().alive, 0);
});

test('proxy pool returns null when empty', () => {
  const pool = new ProxyPool([]);
  assert.strictEqual(pool.next(), null);
});

// ==================== scraper-factory.js ====================

const { getStrategies, getPlatformsByTier } = require('../../anti-bot/scraper-factory');

test('getStrategies returns all platforms', () => {
  const s = getStrategies();
  assert.ok(s.reddit);
  assert.ok(s.ebay);
  assert.ok(s.amazon);
  assert.ok(Object.keys(s).length >= 13);
});

test('getPlatformsByTier returns grouped', () => {
  const tiers = getPlatformsByTier();
  assert.ok(tiers.api.includes('reddit'));
  assert.ok(tiers.playwright.includes('amazon'));
});

// ==================== scrapers modules ====================

test('reddit scraper module exists', () => {
  const m = require('../../src/scrapers/reddit');
  assert.strictEqual(typeof m.scrape, 'function');
});

test('shopify scraper module exists', () => {
  const m = require('../../src/scrapers/shopify');
  assert.strictEqual(typeof m.scrape, 'function');
});

test('ebay scraper module exists', () => {
  const m = require('../../src/scrapers/ebay');
  assert.strictEqual(typeof m.scrape, 'function');
});

test('etsy scraper module exists', () => {
  const m = require('../../src/scrapers/etsy');
  assert.strictEqual(typeof m.scrape, 'function');
});

test('pinterest scraper module exists', () => {
  const m = require('../../src/scrapers/pinterest');
  assert.strictEqual(typeof m.scrape, 'function');
});

// ==================== Summary ====================

console.log('\n' + '='.repeat(40));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
