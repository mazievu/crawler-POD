/**
 * Concurrency & PostgreSQL Advisory Locking Utilities (Milestone 2)
 *
 * Implements transaction-level advisory locks for item_uid serialization
 * using 64 bits of entropy extracted from SHA-256 (two signed 32-bit integers).
 *
 * Authoritative specification: docs/DISCOVERY_MONITORING_PLAN_REVISED.md §5
 * Feature reference: .agents/orchestrator_1/PROJECT.md (Feature F6)
 */

const crypto = require('crypto');

/**
 * Computes two signed 32-bit integers from an item_uid using SHA-256.
 * Guarantees uniform distribution and avoids JavaScript BigInt serialization issues.
 *
 * @param {string} itemUid - The unique identifier of the item (e.g. 'etsy:https://...')
 * @returns {[number, number]} Tuple of two signed 32-bit integers in [-2147483648, 2147483647]
 */
function getAdvisoryLockKeys(itemUid) {
  if (typeof itemUid !== 'string' || itemUid.length === 0) {
    throw new TypeError('getAdvisoryLockKeys: itemUid must be a non-empty string');
  }
  const digest = crypto.createHash('sha256').update(itemUid).digest();
  const k1 = digest.readInt32BE(0);
  const k2 = digest.readInt32BE(4);
  return [k1, k2];
}

/**
 * Acquires a transaction-level advisory lock on item_uid.
 * The lock is scoped to the current transaction and is automatically released
 * when the transaction commits or rolls back.
 *
 * @param {Object} db - Database client instance supporting .query()
 * @param {string} itemUid - Unique item identifier
 * @returns {Promise<any>}
 */
async function acquireItemAdvisoryLock(db, itemUid) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('acquireItemAdvisoryLock: db must be a database client with a query method');
  }
  const [k1, k2] = getAdvisoryLockKeys(itemUid);
  return await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int);', [k1, k2]);
}

// Aliases for compatibility across explorer reports and test harnesses
const hashItemUidToAdvisoryKey = getAdvisoryLockKeys;
const hashItemUidToLockKeys = getAdvisoryLockKeys;

module.exports = {
  getAdvisoryLockKeys,
  acquireItemAdvisoryLock,
  hashItemUidToAdvisoryKey,
  hashItemUidToLockKeys,
};
