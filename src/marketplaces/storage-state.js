const { assertSupportedMarketplace } = require('./validation');

const DEFAULT_COOKIE_DOMAINS = {
  amazon: '.amazon.com',
  ebay: '.ebay.com',
  etsy: '.etsy.com',
};

function normalizeBrowserStorageState(platform, input) {
  assertSupportedMarketplace(platform);
  const value = parseStorageInput(input);
  const rawCookies = Array.isArray(value)
    ? value
    : Array.isArray(value?.cookies)
      ? value.cookies
      : isCookie(value)
        ? [value]
        : null;

  if (!rawCookies?.length) throw new Error('Provide at least one browser cookie or a Playwright storage-state JSON object');
  return {
    cookies: rawCookies.map((cookie) => normalizeCookie(platform, cookie)),
    origins: Array.isArray(value?.origins) ? value.origins : [],
  };
}

function parseStorageInput(input) {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Browser storage state or cookie is required');
  try { return JSON.parse(trimmed); }
  catch {
    if (!trimmed.includes('=')) throw new Error('Cookie text must use name=value format or valid JSON');
    return trimmed.split(';').map((part) => {
      const [name, ...valueParts] = part.trim().split('=');
      return { name: name?.trim(), value: valueParts.join('=').trim() };
    }).filter((cookie) => cookie.name);
  }
}

function isCookie(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.name === 'string' && Object.hasOwn(value, 'value');
}

function normalizeCookie(platform, cookie) {
  if (!isCookie(cookie) || !cookie.name.trim()) throw new Error('Every cookie requires a name and value');
  const domain = String(cookie.domain || DEFAULT_COOKIE_DOMAINS[platform]).trim();
  const expectedDomain = DEFAULT_COOKIE_DOMAINS[platform].slice(1);
  if (!domain.toLowerCase().replace(/^\./, '').endsWith(expectedDomain)) {
    throw new Error(`Cookie domain must belong to ${platform}`);
  }

  const expiry = Number(cookie.expires ?? cookie.expirationDate);
  return {
    name: cookie.name.trim(),
    value: String(cookie.value),
    domain,
    path: String(cookie.path || '/'),
    expires: Number.isFinite(expiry) ? expiry : -1,
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

function normalizeSameSite(value) {
  const normalized = String(value || 'Lax').toLowerCase();
  if (normalized === 'strict') return 'Strict';
  if (normalized === 'none' || normalized === 'no_restriction') return 'None';
  return 'Lax';
}

module.exports = { normalizeBrowserStorageState };
