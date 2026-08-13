const path = require('node:path');
const { assertSupportedMarketplace } = require('./validation');
const { normalizeBrowserStorageState } = require('./storage-state');

function resolveEverbeeProfileDir({ platform, accountId = null, profileRoot } = {}) {
  assertSupportedMarketplace(platform);
  const root = profileRoot || process.env.EVERBEE_PROFILE_ROOT || path.join(process.cwd(), 'data', 'everbee-profiles');
  const profileName = Number.isSafeInteger(Number(accountId)) && Number(accountId) > 0
    ? `account-${Number(accountId)}`
    : 'public';
  return path.join(root, platform, profileName);
}

async function createEverbeeContextSession({
  platform,
  accountId = null,
  storageState = null,
  profileRoot,
  proxy = null,
  headless = process.env.EVERBEE_HEADLESS !== 'false',
  launchPersistentContext,
} = {}) {
  const userDataDir = resolveEverbeeProfileDir({ platform, accountId, profileRoot });
  const launch = launchPersistentContext || (await import('cloakbrowser')).launchPersistentContext;
  const launchOptions = { userDataDir, headless, locale: 'en-US' };
  if (proxy) launchOptions.proxy = proxy;
  const context = await launch(launchOptions);

  try {
    const normalizedStorageState = storageState ? normalizeBrowserStorageState(platform, storageState) : null;
    if (normalizedStorageState?.cookies?.length) {
      if (typeof context.addCookies !== 'function') throw new Error('Everbee browser context cannot accept saved cookies');
      await context.addCookies(normalizedStorageState.cookies);
    }

    return {
      context,
      mode: 'everbee',
      storageStateApplied: Boolean(normalizedStorageState),
      close: async () => context.close(),
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

module.exports = { createEverbeeContextSession, resolveEverbeeProfileDir };
