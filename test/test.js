/**
 * Tests — toidispy-filters.js + toidispy-filter-adapter.js + database.js
 * AAA pattern: Arrange → Act → Assert
 */

const assert = require('assert');
const path = require('path');

// ==================== toidispy-filters.js ====================

const {
  POSTS_FILTERS,
  ADS_FILTERS,
  POSTS_CARD_SCHEMA,
  ADS_CARD_SCHEMA,
  DEFAULT_POSTS_FILTERS,
  DEFAULT_ADS_FILTERS,
  getFilterConfig,
  getDefaultFilters,
  validateFilters,
  getFiltersForUI,
} = require('../scripts/toidispy-filters');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

console.log('\n📋 toidispy-filters.js tests:');

test('POSTS_FILTERS has 11 filters', () => {
  assert.strictEqual(Object.keys(POSTS_FILTERS).length, 11);
});

test('ADS_FILTERS has 10 filters', () => {
  assert.strictEqual(Object.keys(ADS_FILTERS).length, 10);
});

test('POSTS platforms has 23 options', () => {
  assert.strictEqual(POSTS_FILTERS.platforms.options.length, 23);
});

test('POSTS categories has 33 options', () => {
  assert.strictEqual(POSTS_FILTERS.categories.options.length, 33);
});

test('POSTS sort has 8 options (including empty for Latest)', () => {
  assert.strictEqual(POSTS_FILTERS.sort.options.length, 8);
});

test('ADS sort has 5 options', () => {
  assert.strictEqual(ADS_FILTERS.sort.options.length, 5);
});

test('getFilterConfig("posts") returns POSTS_FILTERS', () => {
  assert.deepStrictEqual(getFilterConfig('posts'), POSTS_FILTERS);
});

test('getFilterConfig("ads") returns ADS_FILTERS', () => {
  assert.deepStrictEqual(getFilterConfig('ads'), ADS_FILTERS);
});

test('getDefaultFilters("posts") returns all default keys', () => {
  const defaults = getDefaultFilters('posts');
  assert.strictEqual(defaults.keyword, '');
  assert.strictEqual(defaults.reactionsMin, 0);
  assert.strictEqual(defaults.commentsMin, 0);
  assert.strictEqual(defaults.sharesMin, 0);
  assert.strictEqual(defaults.following, false);
  assert.strictEqual(defaults.sort, '');
});

test('getDefaultFilters("ads") returns all default keys', () => {
  const defaults = getDefaultFilters('ads');
  assert.strictEqual(defaults.adsetMin, 0);
  assert.strictEqual(defaults.status, '');
});

test('validateFilters: keyword required', () => {
  const result = validateFilters({}, 'posts');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('Keyword is required'));
});

test('validateFilters: valid with keyword', () => {
  const result = validateFilters({ keyword: 'test' }, 'posts');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('validateFilters: negative reactions rejected', () => {
  const result = validateFilters({ keyword: 'test', reactionsMin: -1 }, 'posts');
  assert.strictEqual(result.valid, false);
});

test('validateFilters: negative adset rejected', () => {
  const result = validateFilters({ keyword: 'test', adsetMin: -1 }, 'ads');
  assert.strictEqual(result.valid, false);
});

test('getFiltersForUI returns array sorted by order', () => {
  const filters = getFiltersForUI('posts');
  assert.ok(Array.isArray(filters));
  assert.strictEqual(filters.length, 11);
  for (let i = 1; i < filters.length; i++) {
    assert.ok(filters[i].order >= filters[i - 1].order,
      `Filter ${filters[i].id} order ${filters[i].id} < previous`);
  }
});

test('POSTS_CARD_SCHEMA has expected fields', () => {
  assert.ok(POSTS_CARD_SCHEMA.pageName);
  assert.ok(POSTS_CARD_SCHEMA.reactions);
  assert.ok(POSTS_CARD_SCHEMA.comments);
  assert.ok(POSTS_CARD_SCHEMA.shares);
  assert.ok(POSTS_CARD_SCHEMA.domain);
  assert.ok(POSTS_CARD_SCHEMA.imageUrl);
});

test('ADS_CARD_SCHEMA has expected fields', () => {
  assert.ok(ADS_CARD_SCHEMA.pageName);
  assert.ok(ADS_CARD_SCHEMA.adCount);
  assert.ok(ADS_CARD_SCHEMA.adId);
  assert.ok(ADS_CARD_SCHEMA.domain);
});

// ==================== database.js ====================

console.log('\n📋 database.js tests:');

const db = require('../src/database');

test('getAllPlatforms returns array', () => {
  const platforms = db.getAllPlatforms();
  assert.ok(Array.isArray(platforms));
  assert.ok(platforms.length > 0);
});

test('createRun + getRunById works', () => {
  const run = db.createRun({ platform: 'test', query: 'test-query', maxItems: 5 });
  assert.ok(run.id);
  assert.strictEqual(run.platform, 'test');
  assert.strictEqual(run.query, 'test-query');
  assert.strictEqual(run.status, 'pending');
  // Cleanup
  db.deleteRun(run.id);
});

test('deleteRun removes run', () => {
  const run = db.createRun({ platform: 'test', query: 'delete-me', maxItems: 1 });
  db.deleteRun(run.id);
  const found = db.getRunById(run.id);
  assert.strictEqual(found, undefined);
});

test('insertSnapshots handles empty items', () => {
  const run = db.createRun({ platform: 'test', query: 'empty', maxItems: 0 });
  const result = db.insertSnapshots(run.id, 'test', 'empty', []);
  assert.strictEqual(result.newItems, 0);
  assert.strictEqual(result.activeItems, 0);
  db.deleteRun(run.id);
});

test('insertSnapshots inserts items', () => {
  const run = db.createRun({ platform: 'test', query: 'items', maxItems: 3 });
  const items = [
    { title: 'Item 1', url: 'https://example.com/1', likes: 10 },
    { title: 'Item 2', url: 'https://example.com/2', likes: 20 },
    { title: 'Item 3', url: 'https://example.com/3', likes: 30 },
  ];
  const result = db.insertSnapshots(run.id, 'test', 'items', items);
  assert.strictEqual(result.newItems, 3);
  assert.strictEqual(result.activeItems, 0);
  // Cleanup
  db.deleteRun(run.id);
});

test('getStats returns numbers', () => {
  const stats = db.getStats();
  assert.strictEqual(typeof stats.totalRuns, 'number');
  assert.strictEqual(typeof stats.totalSnapshots, 'number');
});

// ==================== apify-client.js ====================

console.log('\n📋 apify-client.js tests:');

const { INPUT_BUILDERS } = require('../src/apify-client');

test('INPUT_BUILDERS has builders for all platforms', () => {
  const expected = ['facebook_posts', 'facebook_ads', 'pinterest', 'amazon',
    'reddit', 'google_shopping', 'shopify', 'tiktok_shop', 'etsy',
    'twitter', 'ebay', 'instagram'];
  expected.forEach(p => {
    assert.ok(INPUT_BUILDERS[p], `Missing builder for ${p}`);
  });
});

test('amazon builder includes marketplace', () => {
  const input = INPUT_BUILDERS.amazon({ query: 'test', maxItems: 10, country: 'UK' });
  assert.strictEqual(input.marketplace, 'UK');
});

test('amazon builder defaults marketplace to US', () => {
  const input = INPUT_BUILDERS.amazon({ query: 'test', maxItems: 10 });
  assert.strictEqual(input.marketplace, 'US');
});

// ==================== capability-registry.js ====================

console.log('\nCapability registry tests:');

const packageJson = require('../package.json');
const { CAPABILITIES, getCapability, selectActiveBackend } = require('../src/capability-registry');

test('capability registry has web fallback and core target platforms', () => {
  const names = CAPABILITIES.map(c => c.name);
  ['web', 'search', 'amazon', 'google_shopping', 'facebook_posts', 'twitter', 'instagram', 'tiktok_shop'].forEach(name => {
    assert.ok(names.includes(name), `Missing capability: ${name}`);
  });
  assert.ok(!names.includes('tiktok'), 'Use dashboard platform key tiktok_shop, not tiktok');
});

test('amazon keeps free SearXNG before paid fallbacks', () => {
  const amazon = getCapability('amazon');
  assert.strictEqual(amazon.backends[0].check, 'searxng');
  assert.strictEqual(amazon.backends[1].kind, 'paid_api');
});

test('selectActiveBackend prefers ready free backend', () => {
  const amazon = getCapability('amazon');
  const selected = selectActiveBackend(amazon.backends, { searxng: true });
  assert.strictEqual(selected.active.id, 'searxng-amazon');
  assert.strictEqual(selected.active.status, 'ok');
});

test('selectActiveBackend does not activate paid fallback without credentials', () => {
  const amazon = getCapability('amazon');
  const selected = selectActiveBackend(amazon.backends, { searxng: false, credentials: {} });
  assert.strictEqual(selected.active, null);
  assert.strictEqual(selected.backends[1].status, 'off');
});

test('selectActiveBackend can activate configured paid fallback', () => {
  const amazon = getCapability('amazon');
  const selected = selectActiveBackend(amazon.backends, {
    searxng: false,
    credentials: { SCRAPE_DO_TOKEN: 'test-token' },
  });
  assert.strictEqual(selected.active.id, 'scrape-do');
  assert.strictEqual(selected.active.status, 'fallback');
});

test('google shopping has no active backend without verified free path or paid credentials', () => {
  const googleShopping = getCapability('google_shopping');
  const selected = selectActiveBackend(googleShopping.backends, { searxng: true, credentials: {} });
  assert.strictEqual(selected.active, null);
  assert.strictEqual(selected.backends[0].status, 'warn');
});

test('manual backends are not marked active without a probe', () => {
  const reddit = getCapability('reddit');
  const selected = selectActiveBackend(reddit.backends, { credentials: {} });
  assert.strictEqual(selected.active, null);
  assert.strictEqual(selected.backends[0].status, 'warn');
});

test('npm start attempts dependency startup without blocking server startup', () => {
  assert.ok(packageJson.scripts.start.includes('start-deps.js --optional'));
  assert.ok(packageJson.scripts.start.includes('node server.js'));
});

// ==================== web-reader.js ====================

console.log('\nWeb reader tests:');

const { normalizeUrl, buildJinaReaderUrl } = require('../src/scrapers/web-reader');

test('normalizeUrl keeps absolute HTTPS URLs', () => {
  assert.strictEqual(normalizeUrl('https://example.com/a'), 'https://example.com/a');
});

test('normalizeUrl adds HTTPS to bare domains', () => {
  assert.strictEqual(normalizeUrl('example.com/a'), 'https://example.com/a');
});

test('buildJinaReaderUrl prefixes normalized target URL', () => {
  assert.strictEqual(
    buildJinaReaderUrl('example.com/a', 'https://r.jina.ai'),
    'https://r.jina.ai/https://example.com/a'
  );
});

// ==================== indexed-search.js ====================

console.log('\nIndexed search tests:');

const { CONFIGS: INDEXED_SEARCH_CONFIGS } = require('../src/scrapers/indexed-search');

test('indexed search supports collect platform keys', () => {
  ['amazon', 'facebook_posts', 'twitter', 'instagram', 'tiktok_shop'].forEach(platform => {
    assert.ok(INDEXED_SEARCH_CONFIGS[platform], `Missing indexed search config for ${platform}`);
  });
  assert.ok(!INDEXED_SEARCH_CONFIGS.tiktok, 'Use collect key tiktok_shop, not tiktok');
});

// ==================== start-searxng.js ====================

console.log('\nSearXNG bootstrap tests:');

const { settingsTextEnablesJson } = require('../scripts/start-searxng');

test('settingsTextEnablesJson detects json output format', () => {
  assert.strictEqual(settingsTextEnablesJson([
    'search:',
    '  formats:',
    '    - html',
    '    - json',
  ].join('\n')), true);
});

test('settingsTextEnablesJson rejects stale html-only settings', () => {
  assert.strictEqual(settingsTextEnablesJson([
    'search:',
    '  formats:',
    '    - html',
  ].join('\n')), false);
});

// ==================== Summary ====================

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
