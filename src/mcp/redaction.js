'use strict';

/**
 * List of forbidden keys that must never be exposed outside MCP
 */
const FORBIDDEN_KEYS = new Set([
  'raw_data',
  'rawdata',
  'raw',
  'raw_html',
  'rawhtml',
  'html_encrypted',
  'session_encrypted',
  'config_encrypted',
  'apify_run_id',
  'apifyrunid',
  'apify_dataset_id',
  'apifydatasetid',
  'error_message',
  'errormessage',
  'actor_id',
  'actorid',
  'token',
  'tokens',
  'cookie',
  'cookies',
  'session',
  'sessions',
  'credential',
  'credentials',
  'password',
  'secret',
  'proxy',
  'proxies',
  'authorization',
  'auth',
]);

/**
 * Check if a key is forbidden
 * @param {string} key
 * @returns {boolean}
 */
function isForbiddenKey(key) {
  if (!key || typeof key !== 'string') return false;
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
  return FORBIDDEN_KEYS.has(normalized);
}

/**
 * Deeply redact forbidden fields from an object, array, or primitive value
 * @param {*} data
 * @param {number} [depth=0]
 * @returns {*} Redacted data
 */
function redactResponse(data, depth = 0) {
  if (depth > 20) return data; // Prevent circular reference stack overflows

  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactResponse(item, depth + 1));
  }

  if (typeof data === 'object') {
    const cleanObj = {};
    for (const [key, value] of Object.entries(data)) {
      if (isForbiddenKey(key)) {
        continue; // Strip forbidden key completely
      }
      cleanObj[key] = redactResponse(value, depth + 1);
    }
    return cleanObj;
  }

  return data;
}

module.exports = {
  FORBIDDEN_KEYS,
  isForbiddenKey,
  redactResponse,
};
