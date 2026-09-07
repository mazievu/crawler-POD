const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getProxyPool } = require('../proxy');

/**
 * CloakBrowser Session Adapter for User Journey
 * Provides persistent-context stealth sessions specifically optimized for Etsy
 */

function resolveCloakProfileDir(platform = 'etsy', profileRoot = null) {
  const root = profileRoot || process.env.CLOAKBROWSER_PROFILE_ROOT || path.join(process.cwd(), 'data', 'cloakbrowser-profiles');
  return path.join(root, String(platform).toLowerCase());
}

async function createCloakBrowserSession({
  platform = 'etsy',
  proxy = null,
  executionToken = null,
  headless = process.env.CLOAKBROWSER_HEADLESS === 'true' ? true : false,
  profileRoot = null,
  signal = null,
  launchPersistentContextFn = null
} = {}) {
  let proxyUrl = proxy || null;
  let acquiredProxyId = null;
  let acquiredToken = null;

  // Integrate with ProxyPool if proxy was not explicitly provided
  if (!proxyUrl) {
    try {
      const pool = getProxyPool();
      if (pool && pool.enabled) {
        const token = executionToken || `cloak_journey_${platform}_${Date.now()}`;
        const admission = pool.acquire(token);
        if (admission && admission.allowed && admission.proxyUrl) {
          proxyUrl = admission.proxyUrl;
          acquiredProxyId = admission.proxyId;
          acquiredToken = token;
        }
      }
    } catch (err) {
      console.warn('[CloakBrowserSession] Proxy pool admission check failed, falling back to direct:', err.message);
    }
  }

  const userDataDir = resolveCloakProfileDir(platform, profileRoot);
  try {
    const lockFile = path.join(userDataDir, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }
  } catch {}
  
  let launchPersistentContext = launchPersistentContextFn;
  if (!launchPersistentContext) {
    try {
      const cloakModule = await import('cloakbrowser');
      launchPersistentContext = cloakModule.launchPersistentContext;
    } catch {
      const fallbackPath = pathToFileURL(path.join(process.cwd(), 'node_modules', 'cloakbrowser', 'dist', 'index.js')).href;
      const cloakModule = await import(fallbackPath);
      launchPersistentContext = cloakModule.launchPersistentContext;
    }
  }

  const launchOptions = {
    userDataDir,
    headless,
    locale: 'en-US',
    viewport: { width: 1366, height: 768 }
  };

  if (proxyUrl) {
    launchOptions.proxy = proxyUrl;
    launchOptions.geoip = true;
  }

  const context = await launchPersistentContext(launchOptions);
  const page = context.pages()[0] || await context.newPage();
  await page.setDefaultTimeout(30000);
  await page.setDefaultNavigationTimeout(45000);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    } finally {
      if (acquiredToken) {
        try {
          getProxyPool().release(acquiredToken);
        } catch {
          // Best effort release
        }
      }
    }
  };

  if (signal) {
    signal.addEventListener('abort', () => { close().catch(() => {}); }, { once: true });
  }

  return {
    browser: context.browser ? context.browser() : null,
    context,
    page,
    close,
    proxyUrl,
    acquiredProxyId,
    mode: 'cloakbrowser'
  };
}

module.exports = {
  createCloakBrowserSession,
  resolveCloakProfileDir
};
