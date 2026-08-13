const CHANNEL_STATUS = {
  READY: 'ready',
  WARN: 'warn',
  DISABLED: 'disabled',
  EXPERIMENTAL: 'experimental'
};

const BACKEND_KIND = {
  APIFY: 'apify',
  LOCAL: 'local',
  CDP: 'cdp',
  BROWSER_SESSION: 'browser_session',
  MOCK: 'mock'
};

module.exports = {
  CHANNEL_STATUS,
  BACKEND_KIND
};
