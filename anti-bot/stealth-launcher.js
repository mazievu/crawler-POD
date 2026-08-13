/**
 * Stealth Browser Launcher
 * Khởi tạo Playwright với đầy đủ anti-detection
 */

const { chromium } = require('playwright');
const { generateContextOpts } = require('./fingerprint');

/**
 * Launch a stealth browser instance
 * @param {object} options
 * @param {string} [options.proxyUrl] - Proxy URL
 * @param {boolean} [options.mobileEmulation] - Use mobile viewport
 * @param {boolean} [options.headless] - Run headless (default true)
 * @returns {{ browser: Browser, context: BrowserContext, page: Page, close: Function }}
 */
async function launchStealth(options = {}) {
  const {
    proxyUrl = null,
    mobileEmulation = false,
    headless = true,
    userAgent = null,
    viewport = null,
    cdpUrl = null,
  } = options;

  const isRemoteBrowser = Boolean(cdpUrl);
  const browser = isRemoteBrowser ? await chromium.connectOverCDP(cdpUrl) : await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-automation',
      '--disable-infobars',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
    ],
  });

  // Create context with fingerprint
  const contextOptions = generateContextOpts({
    proxyUrl,
    userAgent,
    viewport: viewport || (mobileEmulation ? { width: 390, height: 844, isMobile: true, deviceScaleFactor: 3 } : null),
  });

  const context = isRemoteBrowser ? (browser.contexts()[0] || await browser.newContext(contextOptions)) : await browser.newContext(contextOptions);

  // Inject anti-detection scripts
  await context.addInitScript(() => {
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Override chrome.runtime
    if (!window.chrome) {
      window.chrome = { runtime: {} };
    }
    Object.defineProperty(window.chrome, 'runtime', {
      get: () => ({
        connect: () => null,
        sendMessage: () => null,
        onMessage: { addListener: () => {} },
        onConnect: { addListener: () => {} },
      }),
    });

    // Override permissions
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: 'denied' })
          : originalQuery(params);
    }

    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // Override platform
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  });

  const page = isRemoteBrowser ? (context.pages()[0] || await context.newPage()) : await context.newPage();
  await page.setDefaultTimeout(30000);
  await page.setDefaultNavigationTimeout(30000);

  return {
    browser,
    context,
    page,
    async close() {
      if (!isRemoteBrowser) {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      }
    },
  };
}

module.exports = { launchStealth };
