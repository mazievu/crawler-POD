const crypto = require('crypto');
const { assertSupportedMarketplace } = require('./validation');
const { openInteractiveLogin } = require('./session-login');

function createMarketplaceLoginManager({ openInteractiveLogin: openLogin = openInteractiveLogin, timeoutMs = 15 * 60 * 1000 } = {}) {
  const sessions = new Map();

  async function start({ platform }) {
    assertSupportedMarketplace(platform);
    const login = await openLogin({ platform });
    const id = crypto.randomUUID();
    const session = { id, platform, status: 'pending_login', login, createdAt: new Date().toISOString() };
    session.timeout = setTimeout(() => cancel(id), timeoutMs);
    sessions.set(id, session);
    return safeSession(session);
  }

  async function complete(id) {
    const session = sessions.get(id);
    if (!session) throw new Error('Login session not found or has expired');
    try {
      const storageState = await session.login.complete();
      return { platform: session.platform, storageState };
    } finally {
      clearTimeout(session.timeout);
      sessions.delete(id);
    }
  }

  async function cancel(id) {
    const session = sessions.get(id);
    if (!session) return false;
    clearTimeout(session.timeout);
    sessions.delete(id);
    await session.login.cancel();
    return true;
  }

  function get(id) {
    const session = sessions.get(id);
    return session ? safeSession(session) : null;
  }

  return { start, complete, cancel, get };
}

function safeSession(session) {
  return { id: session.id, platform: session.platform, status: session.status, createdAt: session.createdAt };
}

module.exports = { createMarketplaceLoginManager };
