const path = require('node:path');
const { assertSupportedMarketplace } = require('./validation');
const { normalizeBrowserStorageState } = require('./storage-state');

// UI-BUG-06: `accountId` gives a real saved account a stable, reusable
// profile dir (correct — repeat captures for the same account should reuse
// its session). Every OTHER caller (no accountId) fell back to a single
// shared 'public' dir — including the one-off interactive login flow, whose
// concurrent/overlapping attempts collided on Chromium's own ProcessSingleton
// lock inside that shared directory. `sessionKey` lets a caller request a
// private, throwaway profile dir instead, without touching accountId's
// existing persistent-profile behavior.
function resolveEverbeeProfileDir({ platform, accountId = null, profileRoot, sessionKey = null } = {}) {
  assertSupportedMarketplace(platform);
  const root = profileRoot || process.env.EVERBEE_PROFILE_ROOT || path.join(process.cwd(), 'data', 'everbee-profiles');
  const profileName = sessionKey
    ? `session-${String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : Number.isSafeInteger(Number(accountId)) && Number(accountId) > 0
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
  sessionKey = null,
} = {}) {
  const userDataDir = resolveEverbeeProfileDir({ platform, accountId, profileRoot, sessionKey });
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
