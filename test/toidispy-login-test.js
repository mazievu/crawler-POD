const { describe, it } = require('node:test');
const assert = require('assert');
const { ToidispyAutomation, fatal } = require('../scripts/toidispy-cdp');

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
