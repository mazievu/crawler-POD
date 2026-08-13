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

test('dashboard provides SOCKS5 proxy profile controls', () => {
  assert.match(html, /id="marketplace-proxy-label"/);
  assert.match(html, /id="marketplace-proxy-host"/);
  assert.match(html, /id="marketplace-account-proxy"/);
  assert.match(app, /async function saveMarketplaceProxy/);
  assert.match(app, /async function assignMarketplaceAccountProxy/);
});

test('capture dialog lets a user request Etsy variant prices with a bounded combination limit', () => {
  assert.match(html, /id="capture-variant-mode"/);
  assert.match(html, /id="capture-max-variants"/);
  assert.match(app, /variantMode/);
  assert.match(app, /maxVariants/);
  assert.match(app, /Variant prices/);
  assert.match(app, /priceMax/);
});

test('all-variant captures use a background job so the browser request does not time out', () => {
  assert.match(html, /id="capture-html-submit"/);
  assert.match(app, /async function waitForCaptureJob/);
  assert.match(app, /\/api\/html-capture-jobs/);
  assert.match(app, /response\.job/);
});

test('dashboard exposes a saved captures view and marks cached results', () => {
  assert.match(html, /onclick="showSavedCapturesModal\(\)"/);
  assert.match(html, /id="saved-captures-modal"/);
  assert.match(app, /async function showSavedCapturesModal/);
  assert.match(app, /Loaded saved capture/);
});

test('dashboard provides a scheduled Etsy keyword capture form', () => {
  assert.match(html, /id="marketplace-schedules-modal"/);
  assert.match(html, /id="marketplace-schedule-keyword"/);
  assert.match(html, /id="marketplace-schedule-every-hours"/);
  assert.match(app, /async function saveMarketplaceSchedule/);
  assert.match(html, /id="marketplace-schedule-type"/);
  assert.match(html, /id="marketplace-schedule-daily-time"/);
  assert.match(html, /id="marketplace-schedule-once-datetime"/);
  assert.match(app, /async function toggleMarketplaceScheduleRunHistory/);
  assert.match(app, /marketplace-schedule-run-history-/);
});
