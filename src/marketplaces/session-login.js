const crypto = require('crypto');
const { assertSupportedMarketplace } = require('./validation');
const { createEverbeeContextSession } = require('./everbee-executor');

const MARKETPLACE_LOGIN_URLS = {
  amazon: 'https://www.amazon.com/',
  ebay: 'https://www.ebay.com/',
  etsy: 'https://www.etsy.com/',
};

async function openInteractiveLogin({
  platform,
  browserFactory = defaultBrowserFactory,
}) {
  assertSupportedMarketplace(platform);
  // UI-BUG-06: without a unique per-attempt profile, this defaulted to the
  // shared 'public' Chromium profile dir (see everbee-executor.js) — a
  // second concurrent/overlapping login attempt for the same platform then
  // collided on Chromium's own ProcessSingleton lock and failed to launch.
  const sessionKey = `login-${platform}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  let session;
  let browser;
  try {
    const resource = await browserFactory({ platform, headless: false, sessionKey });
    session = resource?.context || resource?.browser
      ? resource
      : { browser: resource, context: null, ownsBrowser: true, ownsContext: true };
    browser = session.browser;
  } catch {
    throw new Error('Could not launch the server login browser. Paste a cookie into the account form instead.');
  }
  let context;
  let page;
  try {
    context = session.context || await browser.newContext();
    if (!context) throw new Error('No usable browser context is available for login');
    page = await context.newPage();
    await page.goto(MARKETPLACE_LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 45000 });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await page?.close?.().catch(() => {});
      if (typeof session.close === 'function') await session.close().catch(() => {});
      else {
        await context?.close?.().catch(() => {});
        await browser?.close?.().catch(() => {});
      }
    };
    return {
      platform,
      complete: async () => {
        try { return await context.storageState(); }
        finally { await close(); }
      },
      cancel: close,
    };
  } finally {
    if (!context) {
      if (typeof session?.close === 'function') await session.close().catch(() => {});
      else await browser?.close?.().catch(() => {});
    }
  }
}

async function collectInteractiveStorageState({ platform, browserFactory = defaultBrowserFactory, waitForConfirmation }) {
  if (typeof waitForConfirmation !== 'function') throw new Error('waitForConfirmation callback is required');
  const login = await openInteractiveLogin({ platform, browserFactory });
  try {
    await waitForConfirmation();
    return await login.complete();
  } catch (error) {
    await login.cancel();
    throw error;
  }
}

async function defaultBrowserFactory(options) {
  return createEverbeeContextSession({ ...options, headless: false });
}

module.exports = { collectInteractiveStorageState, openInteractiveLogin, MARKETPLACE_LOGIN_URLS };
