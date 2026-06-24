/**
 * Fingerprint Rotation Engine
 * Thay đổi browser fingerprint để tránh bị phát hiện là bot
 */

const USER_AGENTS = [
  // Windows Chrome
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  // macOS Chrome
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // Windows Edge
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  // macOS Safari
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  // Windows Firefox
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  // Mobile iOS
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  // Mobile Android Chrome
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  // Mobile
  { width: 390, height: 844, isMobile: true, deviceScaleFactor: 3 },
  { width: 414, height: 896, isMobile: true, deviceScaleFactor: 2 },
  { width: 360, height: 780, isMobile: true, deviceScaleFactor: 3 },
];

const LOCALES = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en'];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Denver',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Australia/Sydney',
];

/**
 * Pick a random item from an array
 */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate browser context options for stealth
 * @param {object} opts
 * @returns {import('playwright').BrowserContextOptions}
 */
function generateContextOpts(opts = {}) {
  const ua = opts.userAgent || pick(USER_AGENTS);
  const viewport = opts.viewport || pick(VIEWPORTS);

  const contextOpts = {
    userAgent: ua,
    viewport: { width: viewport.width, height: viewport.height },
    locale: pick(LOCALES),
    timezoneId: pick(TIMEZONES),
    geolocation: { longitude: -98.5795, latitude: 39.8283 },
    permissions: [],
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    forcedColors: 'none',
  };

  // Mobile emulation
  if (viewport.isMobile) {
    contextOpts.isMobile = true;
    contextOpts.deviceScaleFactor = viewport.deviceScaleFactor || 2;
    contextOpts.hasTouch = true;
  }

  // Proxy
  if (opts.proxyUrl) {
    const parsed = new URL(opts.proxyUrl);
    contextOpts.proxy = {
      server: `${parsed.protocol}//${parsed.hostname}:${parsed.port || '80'}`,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
    };
  }

  return contextOpts;
}

/**
 * Extra headers to mimic real browser more closely
 */
function getExtraHeaders(userAgent) {
  const isMobile = /Mobile|Android|iPhone/i.test(userAgent);
  return {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Google Chrome";v="125", "Chromium";v="125"',
    'Sec-Ch-Ua-Mobile': isMobile ? '?1' : '?0',
    'Sec-Ch-Ua-Platform': isMobile ? '"Android"' : '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Connection': 'keep-alive',
  };
}

module.exports = {
  USER_AGENTS,
  VIEWPORTS,
  LOCALES,
  TIMEZONES,
  pick,
  generateContextOpts,
  getExtraHeaders,
};
