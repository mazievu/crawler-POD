const { describe, it } = require('node:test');
const assert = require('assert');
const { ToidispyAutomation, fatal, parseCliArgs } = require('../scripts/toidispy-cdp');

describe('ToidispyAutomation Login Check', function() {
  it('should throw TOIDISPY_LOGIN_REQUIRED if redirected to login page', async function() {
    const auto = new ToidispyAutomation();
    auto.page = {
      url: () => 'https://toidispy.com/login?app_id=1',
      title: async () => 'Toidispy',
      goto: async () => {},
      waitForTimeout: async () => {}
    };

    let errorCaught = null;
    try {
      await auto.run('test keyword', { section: 'posts', maxScrolls: 0, saveToDb: false });
    } catch (err) {
      errorCaught = err;
    }

    assert.ok(errorCaught, 'Should throw an error');
    assert.strictEqual(errorCaught.code, 'TOIDISPY_LOGIN_REQUIRED');
    assert.ok(errorCaught.message.includes('Toidispy login required'));
  });

  it('should include error code in diagnostic output', async function() {
    let capturedStderr = '';
    const originalConsoleError = console.error;
    console.error = (msg) => { capturedStderr += msg; };

    try {
      const err = new Error("Toidispy login required.");
      err.code = 'TOIDISPY_LOGIN_REQUIRED';
      await fatal(err, { section: 'posts' }, null);

      const parsed = JSON.parse(capturedStderr);
      assert.strictEqual(parsed.code, 'TOIDISPY_LOGIN_REQUIRED');
      assert.strictEqual(parsed.event, 'toidispy_fatal');
      assert.strictEqual(parsed.level, 'error');
    } finally {
      console.error = originalConsoleError;
    }
  });
});

// §9/§20.K: --max-items previously referenced an undeclared `maxItems`
// variable in main() — a guaranteed ReferenceError. Regression-proof the
// parsing contract directly.
describe('Toidispy CLI --max-items parsing (§9/§20.K)', function() {
  it('parses a valid --max-items value', function() {
    const parsed = parseCliArgs(['--query', 'nails', '--max-items', '5']);
    assert.strictEqual(parsed.maxItems, 5);
    assert.strictEqual(parsed.keyword, 'nails');
  });

  it('ignores a non-numeric --max-items value', function() {
    const parsed = parseCliArgs(['--max-items', 'abc']);
    assert.strictEqual(parsed.maxItems, null);
  });

  it('ignores a non-positive --max-items value', function() {
    assert.strictEqual(parseCliArgs(['--max-items', '0']).maxItems, null);
    assert.strictEqual(parseCliArgs(['--max-items', '-5']).maxItems, null);
  });

  it('clamps --max-items to the safe upper bound', function() {
    const parsed = parseCliArgs(['--max-items', '999999']);
    assert.strictEqual(parsed.maxItems, 1000);
  });

  it('defaults maxItems to null when not provided', function() {
    const parsed = parseCliArgs(['--query', 'nails']);
    assert.strictEqual(parsed.maxItems, null);
  });
});

// §9/§20.L: maxItems must bound the returned/processed item count even though
// no real partition strategy exists (one execution, no fake sharding).
describe('Toidispy run() respects maxItems (§9/§20.L)', function() {
  function fakeAutomation(scrapedCount) {
    const auto = new ToidispyAutomation();
    auto.page = {
      url: () => 'https://app.toidispy.com/posts',
      title: async () => 'Toidispy',
      goto: async () => {},
      waitForTimeout: async () => {},
      waitForSelector: async () => {},
      evaluate: async () => {}, // scrollAndLoad's window.scrollTo() call
      $$eval: async () => scrapedCount // scrollAndLoad's item-count probe
    };
    auto.filterAdapter = { applyFilters: async () => {}, clickSearch: async () => {} };
    auto.scrapePosts = async () => Array.from({ length: scrapedCount }, (_, i) => ({ pageName: `Page ${i}`, reactions: i }));
    return auto;
  }

  it('maxItems=5 caps returned items at <=5 even though 10 were scraped', async function() {
    const auto = fakeAutomation(10);
    const result = await auto.run('nails', { section: 'posts', maxScrolls: 1, saveToDb: false, maxItems: 5 });
    assert.strictEqual(result.items.length, 5);
  });

  it('maxItems larger than the scraped count returns all scraped items unmodified', async function() {
    const auto = fakeAutomation(3);
    const result = await auto.run('nails', { section: 'posts', maxScrolls: 1, saveToDb: false, maxItems: 20 });
    assert.strictEqual(result.items.length, 3);
  });

  it('no maxItems (null) returns everything scraped, unbounded (no fake sharding)', async function() {
    const auto = fakeAutomation(7);
    const result = await auto.run('nails', { section: 'posts', maxScrolls: 1, saveToDb: false });
    assert.strictEqual(result.items.length, 7);
  });
});
