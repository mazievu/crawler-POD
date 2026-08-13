const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('dashboard renders imported analytics even when a product export has no listing image', () => {
  assert.match(app, /const cardImage = item\.image/);
  assert.doesNotMatch(app, /const imageItems = items\.filter\(\(item\) => item\.image\)/);
});

test('dashboard searches the server instead of loading every imported analytics record into the browser', () => {
  assert.match(app, /apiFetch\(`\/api\/items\?\$\{params\}`\)/);
  assert.match(app, /params\.set\('search', query\)/);
});
