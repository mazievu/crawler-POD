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
  try {
    url = new URL(value);
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

module.exports = { assertMarketplaceUrl, assertSupportedMarketplace, MARKETPLACE_HOSTS };
