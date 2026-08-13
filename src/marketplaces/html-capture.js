const { analyzeMarketplaceHtml } = require('./html-parser');
const { assertMarketplaceUrl } = require('./validation');
const { normalizeBrowserStorageState } = require('./storage-state');
const { createEverbeeContextSession } = require('./everbee-executor');
const { captureViaEverbeeHost } = require('./everbee-host-client');
const { normalizeMaxVariants, normalizeVariantMode, summarizeVariantPrices } = require('./variant-pricing');

async function captureMarketplaceHtml({ platform, url, storageState = null, accountId = null, proxy = null, variantMode = 'base', maxVariants = 150, browserFactory = defaultBrowserFactory, hostCapture = null }) {
  const captureUrl = assertMarketplaceUrl(platform, url);
  const normalizedStorageState = normalizeStorageState(platform, storageState);
  const remoteCapture = hostCapture || (browserFactory === defaultBrowserFactory && process.env.EVERBEE_HOST_EXECUTOR_URL ? captureViaEverbeeHost : null);
  if (remoteCapture) {
    const remote = await remoteCapture({ platform, url: captureUrl, accountId, storageState: normalizedStorageState, proxy, variantMode: normalizeVariantMode(variantMode), maxVariants: normalizeMaxVariants(maxVariants) });
    const analysis = analyzeMarketplaceHtml({ platform, url: remote.finalUrl || captureUrl, html: remote.html });
    const variants = Array.isArray(remote.variants) ? remote.variants : [];
    const variantSummary = platform === 'etsy' && normalizeVariantMode(variantMode) === 'all' ? summarizeVariantPrices(variants) : {};
    return {
      html: remote.html,
      metrics: { ...analysis.metrics, ...variantSummary },
      variants,
      capture: { ...analysis.capture, browserMode: remote.browserMode || 'everbee_host', variantMode: normalizeVariantMode(variantMode), variantMeta: remote.variantMeta || null },
    };
  }
  const resource = await browserFactory({ platform, accountId, storageState: normalizedStorageState, proxy });
  const session = resource?.browser
    ? resource
    : resource?.context
      ? resource
      : { browser: resource, context: null, ownsBrowser: true, ownsContext: true, mode: 'headless' };
  const { browser } = session;
  let context;
  let page;

  try {
    context = session.context || await browser.newContext(normalizedStorageState ? { storageState: normalizedStorageState } : {});
    if (session.context && normalizedStorageState?.cookies?.length && !session.storageStateApplied) {
      if (typeof context.addCookies !== 'function') throw new Error('Browser context cannot accept the saved cookies');
      await context.addCookies(normalizedStorageState.cookies);
    }
    page = await context.newPage();
    await page.goto(captureUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const html = await page.content();
    const analysis = analyzeMarketplaceHtml({ platform, url: captureUrl, html });
    return { html, metrics: analysis.metrics, capture: { ...analysis.capture, browserMode: session.mode || 'headless' } };
  } finally {
    await page?.close().catch(() => {});
    if (typeof session.close === 'function') await session.close().catch(() => {});
    else {
      if (session.ownsContext !== false) await context?.close().catch(() => {});
      if (session.ownsBrowser !== false) await browser?.close?.().catch(() => {});
    }
  }
}

function normalizeStorageState(platform, storageState) {
  if (!storageState) return null;
  return normalizeBrowserStorageState(platform, storageState);
}

async function defaultBrowserFactory(options) {
  return createEverbeeContextSession(options);
}

module.exports = { captureMarketplaceHtml, normalizeStorageState };
