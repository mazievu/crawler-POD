const path = require('node:path');
const { assertSupportedMarketplace } = require('./validation');
const { normalizeBrowserStorageState } = require('./storage-state');

const fs = require('node:fs');

function resolveEverbeeProfileDir({ platform, accountId = null, profileRoot } = {}) {
  assertSupportedMarketplace(platform);
  const root = profileRoot || process.env.EVERBEE_PROFILE_ROOT || path.join(process.cwd(), 'data', 'everbee-profiles');
  const profileName = Number.isSafeInteger(Number(accountId)) && Number(accountId) > 0
    ? `account-${Number(accountId)}`
    : 'public';
  return path.join(root, platform, profileName);
}


function cleanStaleProfileLocks(userDataDir) {
  try {
    if (!userDataDir || !fs.existsSync(userDataDir)) return;
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];
    for (const file of lockFiles) {
      const p = path.join(userDataDir, file);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) {}
      }
    }
  } catch (e) {}
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
  let userDataDir = resolveEverbeeProfileDir({ platform, accountId, profileRoot });
  cleanStaleProfileLocks(userDataDir);

  const launch = launchPersistentContext || (await import('cloakbrowser')).launchPersistentContext;
  const launchOptions = { userDataDir, headless, locale: 'en-US' };
  if (proxy) launchOptions.proxy = proxy;

  let context;
  try {
    context = await launch(launchOptions);
  } catch (launchErr) {
    if (/process_singleton|quy trình Chromium khác|lock/i.test(launchErr.message)) {
      cleanStaleProfileLocks(userDataDir);
      try {
        context = await launch(launchOptions);
      } catch (retryErr) {
        // Fallback to a isolated session dir if profile is strictly locked by another process
        const fallbackDir = `${userDataDir}_sub_${Date.now()}`;
        context = await launch({ ...launchOptions, userDataDir: fallbackDir });
      }
    } else {
      throw launchErr;
    }
  }

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
    await context?.close().catch(() => {});
    throw error;
  }
}

module.exports = { createEverbeeContextSession, resolveEverbeeProfileDir, cleanStaleProfileLocks };

