/**
 * Shared metric filter / ranking core.
 *
 * One registry, two consumers, so a metric never means two different things:
 *
 *   - the crawl pipeline (src/runs.service.js) evaluates conditions against a
 *     freshly NORMALIZED item, before anything is persisted;
 *   - the items API (server.js /api/items) turns the same conditions into SQL
 *     against product_current.
 *
 * That is why every metric carries both `itemKeys` (where to read it on a
 * normalized item) and `column` (where it lives in the database). Adding a
 * metric in one place therefore adds it in both.
 */

/**
 * Numbers arrive from providers in three shapes: a real number, a plain
 * numeric string, and a human-formatted string ("160.23K", "$2.95M", "1,234").
 * A threshold typed as "1K" has to mean the same thing as 1000, so both sides
 * of a comparison go through this.
 *
 * Returns null — never 0 — when there is no number to be had. 0 is a real
 * value ("this post has zero likes") and must stay distinguishable from "this
 * provider did not report likes".
 */
function parseMetricNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return null;

  const text = String(value).trim();
  if (!text) return null;

  const match = text.replace(/,/g, '').match(/^[^\d.-]*(-?\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return null;

  const base = parseFloat(match[1]);
  if (!Number.isFinite(base)) return null;

  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return base * multiplier;
}

const ECOM = 'ecom';
const SOCIAL = 'social';

/**
 * `groups` is a list because `likes` genuinely belongs to both panels: an
 * e-commerce listing and a social post both report it.
 */
const METRICS = {
  price: {
    label: 'Current price', groups: [ECOM],
    itemKeys: ['price', 'current_price'], column: 'current_price',
  },
  rating: {
    label: 'Rating', groups: [ECOM],
    itemKeys: ['rating', 'current_rating'], column: 'current_rating',
  },
  reviews: {
    label: 'Reviews', groups: [ECOM],
    itemKeys: ['reviewCount', 'reviews', 'current_reviews'], column: 'current_reviews',
  },
  sold: {
    label: 'Sold', groups: [ECOM],
    itemKeys: ['soldCount', 'sold_count', 'sold', 'current_sold'], column: 'current_sold',
  },
  likes: {
    label: 'Likes', groups: [ECOM, SOCIAL],
    itemKeys: ['likes', 'current_likes'], column: 'current_likes',
  },
  comments: {
    label: 'Comments', groups: [SOCIAL],
    itemKeys: ['comments', 'current_comments'], column: 'current_comments',
  },
  shares: {
    label: 'Shares', groups: [SOCIAL],
    itemKeys: ['shares', 'current_shares'], column: 'current_shares',
  },
  views: {
    label: 'Views', groups: [SOCIAL],
    itemKeys: ['views', 'current_views'], column: 'current_views',
  },
  // "Lưu" — TikTok's collectCount. Deliberately not merged into `shares`: a
  // save is intent to return, a share is distribution, and the provider counts
  // them separately (67,000 diggs / 4,929 shares / 20,238 collects on one
  // video, run bufWDKmTr1ENybDdK).
  saves: {
    label: 'Saves (Lưu)', groups: [SOCIAL],
    itemKeys: ['saves', 'collectCount', 'current_saves'], column: 'current_saves',
  },
};

/** Symbols and names both accepted, so a UI and a JSON job spec can share this. */
const OPERATORS = {
  '>=': 'gte', gte: 'gte',
  '>': 'gt', gt: 'gt',
  '<=': 'lte', lte: 'lte',
  '<': 'lt', lt: 'lt',
  '=': 'eq', '==': 'eq', eq: 'eq',
  '!=': 'ne', '<>': 'ne', ne: 'ne',
};

const OPERATOR_SQL = { gte: '>=', gt: '>', lte: '<=', lt: '<', eq: '=', ne: '<>' };

function compare(actual, operator, expected) {
  switch (operator) {
    case 'gte': return actual >= expected;
    case 'gt': return actual > expected;
    case 'lte': return actual <= expected;
    case 'lt': return actual < expected;
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    default: return false;
  }
}

function isKnownMetric(field) {
  return Object.prototype.hasOwnProperty.call(METRICS, String(field || '').trim());
}

/**
 * Accepts what a job spec or a query string can realistically carry and
 * returns only conditions that are fully understood.
 *
 * A malformed entry is DROPPED rather than silently treated as "always true"
 * or "always false" — both of those quietly change which items get kept. The
 * dropped entries come back in `invalid` so the caller can report them instead
 * of pretending the filter was applied.
 */
function parseConditions(input) {
  const raw = Array.isArray(input) ? input : (input ? [input] : []);
  const conditions = [];
  const invalid = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') { invalid.push({ entry, reason: 'not_an_object' }); continue; }

    const field = String(entry.field ?? entry.metric ?? '').trim();
    if (!isKnownMetric(field)) { invalid.push({ entry, reason: 'unknown_field' }); continue; }

    const operator = OPERATORS[String(entry.operator ?? entry.op ?? '>=').trim().toLowerCase()];
    if (!operator) { invalid.push({ entry, reason: 'unknown_operator' }); continue; }

    const value = parseMetricNumber(entry.value);
    if (value === null) { invalid.push({ entry, reason: 'non_numeric_value' }); continue; }

    conditions.push({ field, operator, value });
  }

  return { conditions, invalid };
}

/**
 * Reads a metric off a normalized item, trying each spelling the normalizers use.
 *
 * Every metric here is a non-negative quantity — a price, a rating, or a count
 * of things that happened. A negative value is therefore never a measurement,
 * it is a provider sentinel: Instagram returns likesCount -1 for a post whose
 * author has hidden the like count (seen on run #423, post Dc-pYjViJw2). Such a
 * value is reported as unknown rather than as -1, because comparing it as a
 * real number gets the answer wrong in one direction — "likes <= 0" would
 * otherwise match a post whose likes are merely hidden.
 */
function readMetric(item, field) {
  const metric = METRICS[field];
  if (!metric || !item) return null;
  for (const key of metric.itemKeys) {
    if (item[key] !== undefined && item[key] !== null) {
      const parsed = parseMetricNumber(item[key]);
      if (parsed !== null) return parsed < 0 ? null : parsed;
    }
  }
  return null;
}

/**
 * Evaluates every condition with AND semantics: an item is kept only when all
 * of them hold.
 *
 * A metric the provider did not report is a REJECT, not a pass. "likes >= 1000"
 * cannot be shown to hold for an item whose likes are unknown, and treating
 * unknown as 0 would be wrong in the other direction for "price < 50". The
 * failing condition is named in `reasons`, so a rejection is always explainable.
 */
function evaluateConditions(item, conditions) {
  const reasons = [];
  const values = {};

  for (const { field, operator, value } of conditions) {
    const actual = readMetric(item, field);
    values[field] = actual;

    if (actual === null) {
      reasons.push(`${field} is not reported by this item (required ${OPERATOR_SQL[operator]} ${value})`);
      continue;
    }
    if (!compare(actual, operator, value)) {
      reasons.push(`${field}=${actual} fails ${OPERATOR_SQL[operator]} ${value}`);
    }
  }

  return { kept: reasons.length === 0, reasons, values };
}

/** Convenience wrapper: splits a batch into kept/rejected with per-item reasons. */
function applyConditions(items, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    // No conditions selected -> previous behaviour exactly: keep everything.
    return { kept: Array.isArray(items) ? items : [], rejected: [] };
  }
  const kept = [];
  const rejected = [];
  for (const item of (Array.isArray(items) ? items : [])) {
    const verdict = evaluateConditions(item, conditions);
    if (verdict.kept) kept.push(item);
    else rejected.push({ item, reasons: verdict.reasons, values: verdict.values });
  }
  return { kept, rejected };
}

/**
 * Builds a parameterised SQL fragment for the same conditions.
 *
 * Only the whitelisted column name from METRICS is ever interpolated; every
 * value travels as a bound parameter, so a condition arriving on a query
 * string cannot reach the database as SQL.
 */
function buildSqlFilter(conditions, paramPrefix = 'mc') {
  const clauses = [];
  const params = {};
  conditions.forEach((condition, index) => {
    const metric = METRICS[condition.field];
    if (!metric) return;
    const name = `${paramPrefix}${index}`;
    clauses.push(`${metric.column} ${OPERATOR_SQL[condition.operator]} @${name}`);
    params[name] = condition.value;
  });
  return { sql: clauses.join(' AND '), params };
}

/** Ranking is separate from filtering: this decides ORDER, not membership. */
function buildSqlOrder(sortField, sortDirection) {
  const metric = METRICS[String(sortField || '').trim()];
  if (!metric) return null;
  const direction = String(sortDirection || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // NULLS LAST in both directions: a row with no value for the sorted metric
  // is not "the smallest", it is unknown, and should never head the list.
  return `${metric.column} ${direction} NULLS LAST`;
}

/**
 * Which metrics each platform can actually report.
 *
 * The normalizers emit one common field set for every platform, so the shape of
 * a normalized item says nothing about which numbers are real — an e-commerce
 * listing still carries `shares: 0` because the normalizer always writes the
 * key. Offering all eight metrics everywhere would therefore invite the user to
 * filter Etsy by "shares" and get zero results forever.
 *
 * Each list below is grounded in what that platform's scraper/actor genuinely
 * extracts, cross-checked against the rows now in product_current:
 *
 *   amazon        43/43 rows have price, rating, reviews, likes; sold 0/43
 *   tiktok_shop   41 price, 38 rating, 20 reviews, 36 sold, 16 return_position
 *   instagram     likes + comments populated; views 0/11 (image posts report none)
 *   facebook_ads  likes 16/16 (page likes)
 *   etsy / ebay   scrapers read s.price, s.rating, s.reviews, s.sold_count;
 *                 likes/comments/shares/views are `item.x || 0` passthrough
 *   shopify       scraper reads price only; likes/comments/shares/views literal 0
 *   pinterest     enrichPinMetrics reads reactions, commentCount, repinCount, viewCount
 *   reddit        scraper reads ups + num_comments; shares/views literal 0
 *   twitter       apify payload carries favorite/reply/retweet/view counts
 *   facebook_posts reactions, comments, shares
 *
 * An over-inclusive entry is self-correcting and visible: the item is rejected
 * with "<metric> is not reported by this item". An under-inclusive one silently
 * hides a filter the user could have used, which is the worse failure.
 */
const PLATFORM_METRICS = {
  amazon: ['price', 'rating', 'reviews', 'likes'],
  ebay: ['price', 'rating', 'reviews', 'sold'],
  etsy: ['price', 'rating', 'reviews', 'sold'],
  google_shopping: ['price', 'rating', 'reviews'],
  shopify: ['price'],
  tiktok_shop: ['price', 'rating', 'reviews', 'sold'],

  facebook_ads: ['likes'],
  facebook_posts: ['likes', 'comments', 'shares'],
  instagram: ['likes', 'comments', 'views'],
  pinterest: ['likes', 'comments', 'shares', 'views'],
  reddit: ['likes', 'comments'],
  toidispy: ['likes', 'comments', 'shares', 'views'],
  twitter: ['likes', 'comments', 'shares', 'views'],
  // clockworks/tiktok-scraper reports all five, saves included — verified on
  // run bufWDKmTr1ENybDdK (3/3 videos carried a non-zero collectCount).
  tiktok_videos: ['likes', 'comments', 'shares', 'views', 'saves'],
};

/**
 * Per-platform metric list for the UI. An unknown platform falls back to every
 * metric rather than to none, so a channel added later still gets a usable
 * filter before this table is updated.
 */
function metricsForPlatform(platform) {
  const names = PLATFORM_METRICS[String(platform || '').trim()] || Object.keys(METRICS);
  return names
    .filter((name) => METRICS[name])
    .map((name) => ({ name, label: METRICS[name].label }));
}

/**
 * "Ticked metric" semantics — the crawl filter and the DB filter both work by
 * SELECTION rather than by threshold: the user ticks the metrics that matter
 * and the highest values win. There is deliberately no operator and no number
 * to type, because "the best by likes" does not need one.
 *
 * A ticked metric an item does not report is a REJECT, not a zero: an item
 * whose likes are unknown cannot be "the highest by likes". With two ticks an
 * item must report BOTH, which is the AND the user asked for.
 */
function evaluateSelection(item, metricNames) {
  const reasons = [];
  const values = {};
  for (const name of metricNames) {
    const actual = readMetric(item, name);
    values[name] = actual;
    if (actual === null) reasons.push(`${name} is not reported by this item`);
  }
  return { kept: reasons.length === 0, reasons, values };
}

/**
 * Keeps the items that report every ticked metric and orders them so the
 * highest come first. Ties on the first ticked metric are broken by the next,
 * which is what "đạt cả 2 điều kiện" means once neither has a threshold.
 */
function applySelection(items, metricNames) {
  const list = Array.isArray(items) ? items : [];
  if (!Array.isArray(metricNames) || metricNames.length === 0) {
    return { kept: list, rejected: [] };
  }
  const names = metricNames.filter((n) => METRICS[n]);
  if (names.length === 0) return { kept: list, rejected: [] };

  const kept = [];
  const rejected = [];
  for (const item of list) {
    const verdict = evaluateSelection(item, names);
    if (verdict.kept) kept.push(item);
    else rejected.push({ item, reasons: verdict.reasons, values: verdict.values });
  }

  kept.sort((a, b) => {
    for (const name of names) {
      const diff = (readMetric(b, name) ?? 0) - (readMetric(a, name) ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

  return { kept, rejected };
}

/** SQL side of applySelection(): the metric must be present to be ranked by. */
function buildSqlSelectionFilter(metricNames) {
  const clauses = [];
  for (const name of (metricNames || [])) {
    const metric = METRICS[name];
    if (!metric) continue;
    clauses.push(`${metric.column} IS NOT NULL AND ${metric.column} > 0`);
  }
  return { sql: clauses.join(' AND '), params: {} };
}

/**
 * Ranking for the DB filter. Unlike the crawl filter this one takes a
 * direction, because in the database the user is browsing what was already
 * collected and may want the cheapest as readily as the most liked.
 */
function buildSqlSelectionOrder(metricNames, direction) {
  const dir = String(direction || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const parts = [];
  for (const name of (metricNames || [])) {
    const metric = METRICS[name];
    if (!metric) continue;
    parts.push(`${metric.column} ${dir} NULLS LAST`);
  }
  return parts.length ? parts.join(', ') : null;
}

/** Keeps only names this registry knows, preserving the user's tick order. */
function parseMetricSelection(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set();
  const selected = [];
  const invalid = [];
  for (const entry of raw) {
    const name = String(entry || '').trim();
    if (!name) continue;
    if (!METRICS[name]) { invalid.push(name); continue; }
    if (seen.has(name)) continue;
    seen.add(name);
    selected.push(name);
  }
  return { selected, invalid };
}

function metricsForGroup(group) {
  return Object.entries(METRICS)
    .filter(([, metric]) => metric.groups.includes(group))
    .map(([name, metric]) => ({ name, label: metric.label }));
}

module.exports = {
  ECOM,
  SOCIAL,
  METRICS,
  PLATFORM_METRICS,
  metricsForPlatform,
  parseMetricSelection,
  evaluateSelection,
  applySelection,
  buildSqlSelectionFilter,
  buildSqlSelectionOrder,
  OPERATORS,
  OPERATOR_SQL,
  parseMetricNumber,
  isKnownMetric,
  parseConditions,
  readMetric,
  evaluateConditions,
  applyConditions,
  buildSqlFilter,
  buildSqlOrder,
  metricsForGroup,
};
