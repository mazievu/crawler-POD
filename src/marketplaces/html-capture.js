const { chromium } = require('playwright');
const { parseMarketplaceHtml } = require('./html-parser');
const { assertMarketplaceUrl } = require('./validation');

async function captureMarketplaceHtml({ platform, url, storageState = null, browserFactory = defaultBrowserFactory }) {
  const captureUrl = assertMarketplaceUrl(platform, url);
  const normalizedStorageState = normalizeStorageState(storageState);
  const browser = await browserFactory();
  let context;
  let page;

  try {
    context = await browser.newContext(normalizedStorageState ? { storageState: normalizedStorageState } : {});
    page = await context.newPage();
    await page.goto(captureUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const html = await page.content();
    return { html, metrics: parseMarketplaceHtml({ platform, url: captureUrl, html }) };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function normalizeStorageState(storageState) {
  if (!storageState) return null;
  const state = typeof storageState === 'string' ? JSON.parse(storageState) : storageState;
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Browser storage state must be a JSON object');
  return state;
}

async function defaultBrowserFactory() {
  return chromium.launch({ headless: true });
}

module.exports = { captureMarketplaceHtml, normalizeStorageState };
