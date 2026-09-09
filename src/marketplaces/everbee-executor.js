const path = require('node:path');
const { assertSupportedMarketplace } = require('./validation');
const { normalizeBrowserStorageState } = require('./storage-state');

const fs = require('node:fs');
const os = require('node:os');

function cleanStaleSingletonLocks(userDataDir) {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lockPath = path.join(userDataDir, name);
    try {
      fs.lstatSync(lockPath);
      let isStale = false;
      try {
        const target = fs.readlinkSync(lockPath);
        const parts = target.split('-');
        if (parts.length >= 2) {
          const host = parts.slice(0, -1).join('-');
          const pid = parseInt(parts[parts.length - 1], 10);
          if (host !== os.hostname()) {
            isStale = true;
          } else if (pid && !isNaN(pid)) {
            try {
              process.kill(pid, 0);
            } catch (e) {
              if (e.code === 'ESRCH') isStale = true;
            }
          }
        } else {
          isStale = true;
        }
      } catch {
        isStale = true;
      }
      if (isStale) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Lock file does not exist
    }
  }
}

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
  cleanStaleSingletonLocks(userDataDir);
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
