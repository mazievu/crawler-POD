const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('dashboard includes account management and HTML capture controls', () => {
  assert.match(html, /id="marketplace-accounts-modal"/);
  assert.match(html, /id="capture-html-modal"/);
  assert.match(html, /onclick="showMarketplaceAccountsModal\(\)"/);
  assert.match(html, /onclick="showCaptureHtmlModal\(\)"/);
  assert.match(app, /async function saveMarketplaceAccount/);
  assert.match(app, /async function captureMarketplaceHtml/);
});
