const { parseConditions, parseMetricSelection, parseMetricNumber } = require('./filters/metric-conditions');

const DEFAULT_QUERY_FIELD = {
  id: 'query', label: 'Search query', type: 'text', required: true, placeholder: 'Enter keyword...',
};
const MAX_COLLECTION_ITEMS = 10000;
// Multi-keyword fan-out: how many independent keyword Tasks one submitted Run
// may be split into. This is an INPUT bound (same role MAX_COLLECTION_ITEMS
// plays for maxItems), not a concurrency limit — how many of these Tasks run at
// the same time is still decided exclusively by WorkerPoolManager capacities +
// ResourceMonitor RAM admission, which this feature does not touch.
const MAX_CRAWL_KEYWORDS = 50;

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

/**
 * Multi-keyword input parsing — ONE KEYWORD PER LINE.
 *
 * Newline, not comma: a single real keyword very often contains a comma
 * ("press on nails, short square"), so comma-splitting would silently corrupt
 * queries that work today. A line break never appears inside a keyword typed
 * into a one-line box, which makes this a strictly additive interpretation of
 * the existing `query` contract.
 *
 * Returns { keywords, duplicates } and THROWS on input that cannot be honoured
 * (all-blank, or more lines than MAX_CRAWL_KEYWORDS) — §"no silent buttons":
 * a rejected input must be named, never quietly dropped.
 */
function parseKeywordList(raw) {
  const lines = Array.isArray(raw)
    ? raw.map((entry) => String(entry ?? ''))
    : String(raw ?? '').split(/\r?\n/);

  const keywords = [];
  const duplicates = [];
  const seen = new Set();
  for (const line of lines) {
    const keyword = line.trim();
    if (keyword === '') continue; // Blank lines are formatting, not input.
    const dedupeKey = keyword.toLowerCase();
    if (seen.has(dedupeKey)) { duplicates.push(keyword); continue; }
    seen.add(dedupeKey);
    keywords.push(keyword);
  }

  if (keywords.length === 0) throw new Error('Enter at least one keyword (one per line).');
  if (keywords.length > MAX_CRAWL_KEYWORDS) {
    throw new Error(`Too many keywords: ${keywords.length}. The maximum per crawl is ${MAX_CRAWL_KEYWORDS} (one keyword per line).`);
  }
  return { keywords, duplicates };
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

  // Task 3: crawl-time metric conditions. Deliberately NOT declared as
  // per-platform fields — the metric set is shared (an e-commerce listing and a
  // social post are filtered by the same core), so gating them on
  // getPlatformInputFields() would silently drop them for every platform.
  // parseConditions() is the same whitelist the crawl pipeline and the items
  // API use, so an unknown field or operator cannot get through here either.
  if (values.conditions !== undefined) {
    let raw = values.conditions;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { throw new Error('conditions must be a JSON array of {field, operator, value}'); }
    }
    const { conditions, invalid } = parseConditions(raw);
    if (invalid.length > 0) {
      throw new Error(`Unusable filter condition(s): ${invalid.map((i) => `${JSON.stringify(i.entry)} (${i.reason})`).join(', ')}`);
    }
    if (conditions.length > 0) options.conditions = conditions;
  }

  // Ticked-metric crawl filter. Same reasoning as `conditions` above: not a
  // per-platform input field, and validated by the shared registry rather than
  // by a second list here — parseMetricSelection() rejects any name the crawl
  // pipeline and the items API would not accept either.
  if (values.metrics !== undefined) {
    const { selected, invalid } = parseMetricSelection(values.metrics);
    if (invalid.length > 0) {
      throw new Error(`Unknown metric(s): ${invalid.join(', ')}`);
    }
    if (selected.length > 0) options.metrics = selected;
  }

  /*
   * MINIMUM VALUE for the ticked crawl metrics.
   *
   * WHITELISTED HERE DELIBERATELY, and for the same reason `keywords` and
   * `metrics` are: this function copies only what it names, so an option it
   * does not name is dropped without a word — which is exactly how an earlier
   * feature's `options.metrics` disappeared and let a run report success with
   * the filter never applied.
   *
   * SEMANTICS — one number, every ticked metric, AND, `>=`:
   *   metrics = ['likes','views'], metricMin = 1000
   *     -> conditions = [likes >= 1000, views >= 1000]
   *   and an item is kept only if it satisfies BOTH, which is the AND the panel
   *   already advertises ("Tích nhiều ô = sản phẩm phải đạt tất cả").
   *   No metricMin  -> no conditions added, and a tick keeps its existing
   *   meaning exactly: the item must REPORT the metric, highest first.
   *
   * WHY IT BECOMES `conditions` RATHER THAN A NEW PIPELINE INPUT: the crawl
   * pipeline already evaluates `options.conditions` after normalization and
   * before persistence (runs.service.js -> applyConditions), with AND across
   * entries and "metric not reported" counting as a REJECT. A threshold is
   * precisely a condition, so expressing it as one means no new evaluation path
   * — and no second place where "minimum" could come to mean something else.
   * Expanding it HERE rather than in the browser also means the pairing of
   * threshold-to-metrics cannot be got wrong by a client.
   *
   * `metricMin` itself is kept on the options so the run row records the number
   * the user typed, not only the conditions it became.
   */
  if (values.metricMin !== undefined && values.metricMin !== null && String(values.metricMin).trim() !== '') {
    const min = parseMetricNumber(values.metricMin);
    if (min === null) throw new Error(`Minimum metric value must be a number (got ${JSON.stringify(values.metricMin)}).`);
    if (min < 0) throw new Error(`Minimum metric value must not be negative (got ${min}).`);

    const targets = options.metrics || [];
    // A threshold with nothing to apply to is refused, never ignored: silently
    // dropping it would run the crawl WITHOUT the limit the user asked for and
    // still report success.
    if (targets.length === 0) {
      throw new Error('A minimum metric value needs at least one selected metric to apply to. Tick the metric(s) it applies to, or clear the minimum.');
    }
    const explicit = new Set((options.conditions || []).map((c) => c.field));
    const clash = targets.filter((field) => explicit.has(field));
    if (clash.length > 0) {
      throw new Error(`Minimum metric value conflicts with an explicit condition on: ${clash.join(', ')}. Use one or the other.`);
    }

    options.metricMin = min;
    options.conditions = (options.conditions || []).concat(
      targets.map((field) => ({ field, operator: 'gte', value: min })),
    );
  }

  // Multi-keyword fan-out. Whitelisted HERE deliberately: this function drops
  // anything it does not explicitly copy, and a previous feature already lost
  // `options.metrics` exactly that way (the run reported success with the
  // filter never applied). `keywords` must survive to the Scheduler, which is
  // the layer that turns it into one child Run per keyword.
  //
  // Not a per-platform input field: keyword fan-out is a property of the shared
  // crawl contract, not of any one channel's schema, so gating it on
  // getPlatformInputFields() would silently disable it for every platform.
  //
  // Only set for 2+ keywords. With exactly one keyword the emitted options are
  // byte-identical to what this function produced before this change, so the
  // single-keyword path keeps its EXACT existing behaviour (no parent run, no
  // child run, no fan-out).
  if (values.keywords !== undefined) {
    const { keywords } = parseKeywordList(values.keywords);
    if (keywords.length > 1) options.keywords = keywords;
  }

  return options;
}

module.exports = { MAX_COLLECTION_ITEMS, MAX_CRAWL_KEYWORDS, getPlatformQueryField, getPlatformInputFields, buildCollectionOptions, isLocalCdpUrl, parseKeywordList };
