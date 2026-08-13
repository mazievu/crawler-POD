const MARKETPLACE_HOSTS = {
  amazon: /^([a-z0-9-]+\.)*amazon\.[a-z]{2,}(?:\.[a-z]{2})?$/i,
  ebay: /^([a-z0-9-]+\.)*ebay\.[a-z]{2,}(?:\.[a-z]{2})?$/i,
  etsy: /^([a-z0-9-]+\.)*etsy\.com$/i,
};

function assertSupportedMarketplace(platform) {
  if (!MARKETPLACE_HOSTS[platform]) throw new Error(`Unsupported marketplace: ${platform}`);
}

function assertMarketplaceUrl(platform, value) {
  assertSupportedMarketplace(platform);
  let url;
  const input = String(value || '').trim();
  try {
    url = new URL(input.startsWith('//')
      ? `https:${input}`
      : /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error('A valid HTTP(S) URL is required');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('A valid HTTP(S) URL without embedded credentials is required');
  }
  if (!MARKETPLACE_HOSTS[platform].test(url.hostname)) {
    throw new Error(`URL does not belong to ${platform}`);
  }
  return url.toString();
}

function normalizeMarketplaceCaptureUrl(platform, value) {
  const url = new URL(assertMarketplaceUrl(platform, value));
  url.protocol = 'https:';
  url.hash = '';

  if (platform === 'etsy') {
    const listing = url.pathname.match(/^\/listing\/(\d+)/i);
    if (listing) {
      url.pathname = `/listing/${listing[1]}`;
      url.search = '';
      return url.toString();
    }
  }

  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|ref$|ref_|sr_prefetch$|content_source$|logging_key$|dd_referrer$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

module.exports = { assertMarketplaceUrl, normalizeMarketplaceCaptureUrl, assertSupportedMarketplace, MARKETPLACE_HOSTS };
