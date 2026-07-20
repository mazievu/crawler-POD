const { chromium } = require('playwright');
const { assertSupportedMarketplace } = require('./validation');

const MARKETPLACE_LOGIN_URLS = {
  amazon: 'https://www.amazon.com/',
  ebay: 'https://www.ebay.com/',
  etsy: 'https://www.etsy.com/',
};

async function collectInteractiveStorageState({ platform, browserFactory = defaultBrowserFactory, waitForConfirmation }) {
  assertSupportedMarketplace(platform);
  if (typeof waitForConfirmation !== 'function') throw new Error('waitForConfirmation callback is required');

  const browser = await browserFactory();
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(MARKETPLACE_LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForConfirmation();
    return await context.storageState();
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function defaultBrowserFactory() {
  return chromium.launch({ headless: false });
}

module.exports = { collectInteractiveStorageState, MARKETPLACE_LOGIN_URLS };
