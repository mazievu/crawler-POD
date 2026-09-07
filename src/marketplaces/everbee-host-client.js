const crypto = require('node:crypto');
const { getEncryptionKey } = require('../security/encrypted-store');
const { assertMarketplaceUrl } = require('./validation');
const { normalizeMaxVariants, normalizeVariantMode } = require('./variant-pricing');

function deriveEverbeeHostToken(key = getEncryptionKey()) {
  return crypto.createHmac('sha256', key).update('everbee-host-executor-v1').digest('base64url');
}

async function captureViaEverbeeHost({
  platform,
  url,
  accountId = null,
  storageState = null,
  proxy = null,
  variantMode = 'base',
  maxVariants = 150,
  executorUrl = process.env.EVERBEE_HOST_EXECUTOR_URL,
  signal = null,
  fetchImpl = fetch,
} = {}) {
  const captureUrl = assertMarketplaceUrl(platform, url);
  if (!executorUrl) throw new Error('Everbee host executor URL is not configured');
  const endpoint = new URL('/v1/captures', executorUrl).toString();
  const response = await fetchImpl(endpoint, {
    signal,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-everbee-executor-token': deriveEverbeeHostToken(),
    },
    body: JSON.stringify({ platform, url: captureUrl, accountId, storageState, proxy, variantMode: normalizeVariantMode(variantMode), maxVariants: normalizeMaxVariants(maxVariants) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Everbee host executor failed: ${payload.error || `HTTP ${response.status}`}`);
  if (typeof payload.html !== 'string' || !payload.html.trim()) throw new Error('Everbee host executor returned no HTML');
  return {
    html: payload.html,
    finalUrl: payload.finalUrl || captureUrl,
    browserMode: 'everbee_host',
    variants: Array.isArray(payload.variants) ? payload.variants : [],
    variantMeta: payload.variantMeta || null,
  };
}

async function discoverMarketplaceListingsViaEverbeeHost({
  platform,
  keyword,
  accountId = null,
  storageState = null,
  proxy = null,
  limit = 30,
  executorUrl = process.env.EVERBEE_HOST_EXECUTOR_URL,
  signal = null,
  fetchImpl = fetch,
} = {}) {
  if (platform !== 'etsy') throw new Error('CloakBrowser discovery currently supports Etsy only');
  const normalizedKeyword = String(keyword || '').trim();
  if (!normalizedKeyword || normalizedKeyword.length > 200) throw new Error('Keyword must be between 1 and 200 characters');
  if (!executorUrl) throw new Error('Everbee host executor URL is not configured');
  const endpoint = new URL('/v1/discoveries', executorUrl).toString();
  const response = await fetchImpl(endpoint, {
    signal,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-everbee-executor-token': deriveEverbeeHostToken(),
    },
    body: JSON.stringify({
      platform,
      keyword: normalizedKeyword,
      accountId,
      storageState,
      proxy,
      limit: Math.min(Math.max(Number(limit) || 30, 1), 30),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Everbee host discovery failed: ${payload.error || `HTTP ${response.status}`}`);
  if (!Array.isArray(payload.items)) throw new Error('Everbee host discovery returned no listing data');
  return {
    items: payload.items.slice(0, 30).map((item) => ({
      url: assertMarketplaceUrl(platform, item?.url),
      title: String(item?.title || '').trim().slice(0, 300),
    })),
  };
}

module.exports = { captureViaEverbeeHost, discoverMarketplaceListingsViaEverbeeHost, deriveEverbeeHostToken };
