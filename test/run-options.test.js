const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/database');

test('a collection run stores the submitted platform-specific options', async () => {
  const options = {
    sort: 'top',
    proxyUrl: 'http://proxy.example:8080',
    cdpUrl: 'http://127.0.0.1:9222',
  };
  const run = await db.createRun({ platform: 'test', query: 'option-persistence', maxItems: 1, options });

  assert.deepEqual(JSON.parse(run.input_options), options);
  await db.deleteRun(run.id);
});
