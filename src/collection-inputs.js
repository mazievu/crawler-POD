const DEFAULT_QUERY_FIELD = {
  id: 'query', label: 'Search query', type: 'text', required: true, placeholder: 'Enter keyword...',
};
const MAX_COLLECTION_ITEMS = 10000;

const schemas = {
  amazon: { fields: [] },
  ebay: { fields: [
    { id: 'proxyUrl', label: 'Residential proxy URL', type: 'url', placeholder: 'http://user:pass@host:port', help: 'Optional; required if eBay blocks your IP.' },
    { id: 'cdpUrl', label: 'Chrome / CloakBrowser CDP URL', type: 'url', placeholder: 'http://127.0.0.1:9222', help: 'Optional local stealth browser for the eBay fallback.' },
  ] },
  etsy: { fields: [{ id: 'proxyUrl', label: 'Residential proxy URL', type: 'url', placeholder: 'http://user:pass@host:port', help: 'Optional; helps with Etsy DataDome blocks.' }] },
  facebook_ads: { fields: [] },
  facebook_posts: { fields: [{ id: 'proxyUrl', label: 'Proxy URL', type: 'url', placeholder: 'http://user:pass@host:port' }] },
  google_shopping: { fields: [{ id: 'proxyUrl', label: 'Proxy URL', type: 'url', placeholder: 'http://user:pass@host:port' }] },
  instagram: { fields: [{ id: 'searchType', label: 'Search type', type: 'select', options: ['hashtag', 'user', 'place', 'popular'], default: 'hashtag' }] },
  pinterest: { fields: [
    { id: 'proxyUrl', label: 'Proxy URL', type: 'url', placeholder: 'http://user:pass@host:port' },
    { id: 'cdpUrl', label: 'Chrome / CloakBrowser CDP URL', type: 'url', placeholder: 'http://127.0.0.1:9222' },
  ] },
  reddit: { fields: [
    { id: 'sort', label: 'Sort', type: 'select', options: ['new', 'hot', 'top', 'relevance'], default: 'new' },
    { id: 'proxyUrl', label: 'Proxy URL', type: 'url', placeholder: 'http://user:pass@host:port' },
    { id: 'cdpUrl', label: 'Chrome / CloakBrowser CDP URL', type: 'url', placeholder: 'http://127.0.0.1:9222', help: 'Optional local CDP endpoint; never expose it publicly.' },
  ] },
  shopify: { queryField: { id: 'storeUrl', label: 'Store URL', type: 'url', required: true, placeholder: 'https://your-store.com' }, fields: [] },
  tiktok_shop: { fields: [{ id: 'proxyUrl', label: 'Residential proxy URL', type: 'url', placeholder: 'http://user:pass@host:port' }] },
  toidispy: { fields: [
    { id: 'section', label: 'Collection type', type: 'select', options: ['posts', 'ads'], default: 'posts' },
    { id: 'cdpUrl', label: 'Chrome / CloakBrowser CDP URL', type: 'url', placeholder: 'http://127.0.0.1:9222', help: 'Use a local authenticated browser session.' },
  ] },
  twitter: { fields: [{ id: 'sort', label: 'Sort', type: 'select', options: ['Latest', 'Top'], default: 'Latest' }] },
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function getPlatformQueryField(platform) {
  return clone(schemas[platform]?.queryField || DEFAULT_QUERY_FIELD);
}

function getPlatformInputFields(platform) {
  const schema = schemas[platform] || { fields: [] };
  return clone(schema.queryField?.id === 'storeUrl' ? [schema.queryField, ...schema.fields] : schema.fields);
}

function isLocalCdpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function buildCollectionOptions(platform, values = {}) {
  const options = {
    maxItems: Math.min(MAX_COLLECTION_ITEMS, Math.max(1, Number.parseInt(values.maxItems, 10) || 20)),
    country: String(values.country || ''),
  };
  const allowed = new Set(getPlatformInputFields(platform).map((field) => field.id));
  for (const field of getPlatformInputFields(platform)) {
    if (field.id === 'storeUrl') continue;
    const value = values[field.id];
    if (value !== undefined && value !== null && String(value).trim() !== '') options[field.id] = String(value).trim();
    else if (field.default !== undefined) options[field.id] = field.default;
  }
  if (values.cdpUrl && allowed.has('cdpUrl')) {
    if (!isLocalCdpUrl(values.cdpUrl)) throw new Error('CDP URL must use localhost or 127.0.0.1 over HTTP');
    options.cdpUrl = String(values.cdpUrl).trim();
  }
  return options;
}

module.exports = { MAX_COLLECTION_ITEMS, getPlatformQueryField, getPlatformInputFields, buildCollectionOptions, isLocalCdpUrl };
