'use strict';

/**
 * Extract explicit currency string from raw_data if present.
 * NEVER speculates currency if not explicitly found in the payload.
 * @param {string|Object} rawData
 * @returns {string|null}
 */
function extractExplicitCurrency(rawData) {
  if (!rawData) return null;
  let data;
  if (typeof rawData === 'string') {
    try {
      data = JSON.parse(rawData);
    } catch {
      return null;
    }
  } else if (typeof rawData === 'object') {
    data = rawData;
  } else {
    return null;
  }

  const explicitCurrency =
    data.currency ||
    data.soldCurrency ||
    data.shippingCurrency ||
    data.productCurrency ||
    (data.analytics && data.analytics.currency) ||
    null;

  if (typeof explicitCurrency === 'string' && explicitCurrency.trim()) {
    return explicitCurrency.trim().toUpperCase();
  }

  return null;
}

/**
 * Normalize number value, distinguishing null/undefined from 0.
 * @param {*} val
 * @returns {number|null}
 */
function normalizeNullableNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

/**
 * Normalize integer value, distinguishing null/undefined from 0.
 * @param {*} val
 * @returns {number|null}
 */
function normalizeNullableInt(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? Math.round(num) : null;
}

/**
 * Determine if a timestamp indicates stale data (e.g. > 7 days old)
 * @param {string} timestamp
 * @param {number} [thresholdDays=7]
 * @returns {boolean}
 */
function isDataStale(timestamp, thresholdDays = 7) {
  if (!timestamp) return true;
  const collectedDate = new Date(timestamp);
  if (isNaN(collectedDate.getTime())) return true;
  const now = new Date();
  const diffMs = now.getTime() - collectedDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays > thresholdDays;
}

/**
 * Normalize a snapshot database row into the standard Item Contract
 * @param {Object} row - Database row from snapshots joined with runs
 * @returns {Object} Public Item Contract
 */
function normalizeItemContract(row) {
  if (!row) return null;

  const rawCurrency = extractExplicitCurrency(row.raw_data);
  const priceAmount = normalizeNullableNumber(row.price);

  const collectedAt = row.created_at || new Date().toISOString();
  const dataAsOf = row.run_completed_at || row.run_created_at || collectedAt;

  return {
    item_uid: String(row.item_uid || ''),
    platform: String(row.platform || ''),
    title: row.title ? String(row.title) : '',
    url: row.url ? String(row.url) : '',
    image: row.image ? String(row.image) : null,
    author: row.author ? String(row.author) : null,

    price: {
      amount: priceAmount,
      currency: rawCurrency, // strictly null if not explicitly in DB
    },

    engagement: {
      likes: normalizeNullableInt(row.likes),
      comments: normalizeNullableInt(row.comments),
      shares: normalizeNullableInt(row.shares),
      views: normalizeNullableInt(row.views),
    },

    status: row.status ? String(row.status) : 'new',

    first_seen_at: row.first_seen_at ? String(row.first_seen_at) : collectedAt,
    last_seen_at: collectedAt,

    provenance: {
      platform: String(row.platform || ''),
      url: row.url ? String(row.url) : '',
      query: row.query ? String(row.query) : '',
      run_id: String(row.run_id || ''),
      snapshot_id: String(row.id || ''),
      collected_at: collectedAt,
    },

    freshness: {
      data_as_of: dataAsOf,
      stale: isDataStale(dataAsOf),
    },
  };
}

module.exports = {
  normalizeItemContract,
  extractExplicitCurrency,
  normalizeNullableNumber,
  normalizeNullableInt,
  isDataStale,
};
