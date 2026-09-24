/**
 * Monitoring Database Operations (Milestone 1)
 * Manages entity identities, item registrations, and tracking status.
 * Strictly decoupled from Discovery: never mutates product_current.status.
 */

const crypto = require('crypto');
const { acquireItemAdvisoryLock, getAdvisoryLockKeys } = require('./concurrency');
const { unpackObservations, packObservations } = require('./daily-history');
const { computeBackoffRetryAt } = require('../monitoring/shop-lifecycle');
const { MonitoringLimiter, acquireMonitoringLease, releaseMonitoringLease } = require('../monitoring/limiter');
const { MonitoringDispatcher, parseMonitoringFlag } = require('../monitoring/dispatcher');

/**
 * Normalizes any UTC date string or Date object into canonical ISO string ('YYYY-MM-DDTHH:MM:SS.sssZ').
 */
function normalizeUtcTimestamp(raw) {
  if (raw === null || raw === undefined || raw === '') return new Date().toISOString();
  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? new Date().toISOString() : raw.toISOString();
  }
  if (typeof raw === 'number') {
    if (isNaN(raw) || !Number.isFinite(raw)) return new Date().toISOString();
    const d = new Date(raw);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  try {
    let s = String(raw).trim();
    if (/^\d{10,14}$/.test(s)) {
      const num = Number(s);
      const d = new Date(num);
      return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      s += 'T00:00:00.000Z';
    } else if (s.includes(' ') && !s.includes('T')) {
      s = s.replace(' ', 'T');
      if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) s += 'Z';
    } else if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) {
      s += 'Z';
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch (_e) {
    return new Date().toISOString();
  }
}

/**
 * Parses timestamp string into UTC milliseconds.
 */
function parseUtcMillis(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  if (ts instanceof Date) {
    const t = ts.getTime();
    return isNaN(t) ? null : t;
  }
  if (typeof ts === 'number') {
    if (isNaN(ts) || !Number.isFinite(ts)) return null;
    return ts;
  }
  try {
    let s = String(ts).trim();
    if (/^\d{10,14}$/.test(s)) {
      const num = Number(s);
      return isNaN(num) ? null : num;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      s += 'T00:00:00.000Z';
    } else if (s.includes(' ') && !s.includes('T')) {
      s = s.replace(' ', 'T');
      if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) s += 'Z';
    } else if (!s.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) {
      s += 'Z';
    }
    const ms = Date.parse(s);
    return isNaN(ms) ? null : ms;
  } catch (_e) {
    return null;
  }
}

/**
 * Serializes a monitoring_entities row for callers.
 *
 * Both node-postgres and PGlite hand TIMESTAMPTZ columns back as JS Date
 * objects, while the lifecycle policies (SocialLifecyclePolicy /
 * ShopLifecyclePolicy), their results (expiresAt, unchangedSince, ...) and the
 * values callers pass in are all canonical ISO 8601 UTC strings. Returning the
 * entity with Dates meant `entity.expires_at` and `result.expiresAt` for the
 * same instant had different types. Timestamp columns are therefore returned
 * as ISO strings; the row object itself is copied, never mutated.
 */
function serializeEntityRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date && !isNaN(value.getTime()) ? value.toISOString() : value;
  }
  return out;
}

/**
 * Checks whether a metric value is explicitly present and numeric.
 * Preserves 0 as a valid measurement; rejects null, undefined, '', boolean, and NaN.
 */
function isMetricPresent(val) {
  if (val === undefined || val === null || val === '') return false;
  if (typeof val === 'boolean') return false;
  const num = Number(val);
  return !isNaN(num) && Number.isFinite(num);
}

/**
 * Observation identity/time given at the top level of the config object form
 * ({ itemUid, patch, observationId, observedAt | observedIso }) rather than in
 * metadata/patch. Dropping them silently would replace the caller's stable
 * observationId with a random one and disable deduplication for that write.
 */
function pickTopLevelObservationFields(config) {
  const picked = {};
  if (!config || typeof config !== 'object') return picked;
  if (config.observationId != null) picked.observationId = config.observationId;
  if (config.observedAt != null) picked.observedAt = config.observedAt;
  if (config.observedIso != null) picked.observedIso = config.observedIso;
  return picked;
}

function createMonitoringOps(db, options = {}) {
  // ==================== Entity Statements ====================

  const findEntityById = db.prepare(`
    SELECT * FROM monitoring_entities WHERE id = ?;
  `);

  const findEntityByComposite = db.prepare(`
    SELECT * FROM monitoring_entities
    WHERE platform = ? AND entity_type = ? AND external_id = ?;
  `);

  const insertEntity = db.prepare(`
    INSERT INTO monitoring_entities (
      platform, entity_type, external_id, canonical_url, display_name,
      identity_source, identity_confidence, session_id,
      monitoring_started_at, expires_at, entity_next_due_at,
      is_starred, tracking_status, policy_version, state_version
    ) VALUES (
      @platform, @entity_type, @external_id, @canonical_url, @display_name,
      @identity_source, @identity_confidence, @session_id,
      @monitoring_started_at, @expires_at, @entity_next_due_at,
      @is_starred, 'active', @policy_version, @state_version
    )
    ON CONFLICT (platform, entity_type, external_id)
    DO UPDATE SET
      display_name = COALESCE(monitoring_entities.display_name, EXCLUDED.display_name),
      canonical_url = COALESCE(monitoring_entities.canonical_url, EXCLUDED.canonical_url)
    RETURNING *;
  `);

  const updateEntityMetadata = db.prepare(`
    UPDATE monitoring_entities SET
      display_name = COALESCE(display_name, @display_name),
      canonical_url = COALESCE(canonical_url, @canonical_url),
      updated_at = now()
    WHERE id = @id
    RETURNING *;
  `);

  const findDueEntitiesStmt = db.prepare(`
    SELECT * FROM monitoring_entities
    WHERE tracking_status = 'active'
      AND entity_next_due_at <= @now::timestamptz
      AND (expires_at IS NULL OR expires_at > @now::timestamptz)
      AND (@platform::text IS NULL OR platform = @platform)
      AND (@entity_type::text IS NULL OR entity_type = @entity_type)
    ORDER BY is_starred DESC, entity_next_due_at ASC
    LIMIT @limit;
  `);

  const updateEntityStatusStmt = db.prepare(`
    UPDATE monitoring_entities SET
      tracking_status = @status,
      reason = @reason,
      state_version = state_version + 1,
      updated_at = now()
    WHERE id = @id
      AND (@expected_state_version::int IS NULL OR state_version = @expected_state_version::int)
    RETURNING *;
  `);

  // ==================== Item Statements ====================

  const findItemByUid = db.prepare(`
    SELECT * FROM monitoring_items WHERE item_uid = ?;
  `);

  const findItemById = db.prepare(`
    SELECT * FROM monitoring_items WHERE id = ?;
  `);

  const findItemWithEntityStmt = db.prepare(`
    SELECT mi.*,
           me.platform, me.entity_type, me.external_id, me.display_name,
           me.canonical_url, me.tracking_status AS entity_tracking_status,
           me.is_starred, me.expires_at AS entity_expires_at,
           me.sales AS entity_sales
    FROM monitoring_items mi
    LEFT JOIN monitoring_entities me ON mi.entity_id = me.id
    WHERE mi.item_uid = ?;
  `);

  const insertOrUpdateItem = db.prepare(`
    INSERT INTO monitoring_items (
      item_uid, entity_id, eligibility, item_status, next_due_at
    ) VALUES (
      @item_uid, @entity_id, @eligibility, @item_status, @next_due_at
    )
    ON CONFLICT (item_uid)
    DO UPDATE SET
      entity_id = CASE
        WHEN monitoring_items.entity_id IS NULL AND EXCLUDED.entity_id IS NOT NULL THEN EXCLUDED.entity_id
        ELSE monitoring_items.entity_id
      END,
      eligibility = CASE
        WHEN monitoring_items.eligibility = 'pending_identity' AND EXCLUDED.entity_id IS NOT NULL THEN 'ready'
        ELSE monitoring_items.eligibility
      END,
      next_due_at = COALESCE(monitoring_items.next_due_at, EXCLUDED.next_due_at),
      updated_at = now()
    RETURNING *;
  `);

  const insertPendingItemStmt = db.prepare(`
    INSERT INTO monitoring_items (
      item_uid, entity_id, eligibility, item_status, next_due_at
    ) VALUES (
      @item_uid, NULL, 'pending_identity', 'active', NULL
    )
    ON CONFLICT (item_uid)
    DO UPDATE SET
      updated_at = CASE
        WHEN monitoring_items.entity_id IS NULL THEN now()
        ELSE monitoring_items.updated_at
      END
    RETURNING *;
  `);

  const resolvePendingItemStmt = db.prepare(`
    UPDATE monitoring_items SET
      entity_id = @entity_id,
      eligibility = 'ready',
      next_due_at = COALESCE(next_due_at, now()),
      updated_at = now()
    WHERE item_uid = @item_uid
      AND (eligibility = 'pending_identity' OR entity_id IS NULL OR entity_id = @entity_id)
    RETURNING *;
  `);

  const findDueItemsStmt = db.prepare(`
    SELECT mi.*,
           me.platform, me.entity_type, me.external_id,
           me.tracking_status AS entity_tracking_status
    FROM monitoring_items mi
    JOIN monitoring_entities me ON mi.entity_id = me.id
    WHERE mi.eligibility = 'ready'
      AND mi.item_status = 'active'
      AND me.tracking_status = 'active'
      AND (me.expires_at IS NULL OR me.expires_at > @now::timestamptz)
      AND mi.next_due_at <= @now::timestamptz
    ORDER BY me.is_starred DESC, mi.next_due_at ASC
    LIMIT @limit;
  `);

  // ==================== Milestone 3: Shop Statements ====================

  const findEntityForUpdateStmt = db.prepare(`
    SELECT * FROM monitoring_entities WHERE id = ? FOR UPDATE;
  `);

  const updateShopObservationStmt = db.prepare(`
    UPDATE monitoring_entities SET
      sales = @sales,
      sales_observed_at = @sales_observed_at::timestamptz,
      unchanged_since = @unchanged_since::timestamptz,
      last_increase_observed_at = @last_increase_observed_at::timestamptz,
      entity_next_due_at = @entity_next_due_at::timestamptz,
      last_success_at = COALESCE(@last_success_at::timestamptz, last_success_at),
      tracking_status = @tracking_status,
      reason = @reason,
      state_version = state_version + 1,
      updated_at = now()
    WHERE id = @id
      AND (@expected_state_version::int IS NULL OR state_version = @expected_state_version::int)
    RETURNING *;
  `);

  const insertEntityObservationStmt = db.prepare(`
    INSERT INTO monitoring_entity_observations (
      entity_id, session_id, observation_id, observed_at,
      metric_name, metric_value, source, quality, raw_ref
    ) VALUES (
      @entity_id, @session_id, @observation_id, @observed_at::timestamptz,
      @metric_name, @metric_value, @source, @quality, @raw_ref
    )
    ON CONFLICT (observation_id) DO UPDATE SET
      metric_value = EXCLUDED.metric_value,
      quality = EXCLUDED.quality,
      raw_ref = COALESCE(EXCLUDED.raw_ref, monitoring_entity_observations.raw_ref)
    RETURNING *;
  `);

  const findDueShopEntitiesStmt = db.prepare(`
    SELECT * FROM monitoring_entities
    WHERE entity_type = 'shop'
      AND tracking_status = 'active'
      AND entity_next_due_at <= @now::timestamptz
      AND (expires_at IS NULL OR expires_at > @now::timestamptz)
      AND (@platform::text IS NULL OR platform = @platform)
    ORDER BY is_starred DESC, entity_next_due_at ASC
    LIMIT @limit;
  `);

  const getChildItemsForEntityStmt = db.prepare(`
    SELECT mi.*,
           pc.title, pc.url, pc.current_price, pc.current_sold,
           pc.status AS discovery_status
    FROM monitoring_items mi
    LEFT JOIN product_current pc ON mi.item_uid = pc.item_uid
    WHERE mi.entity_id = @entity_id
      AND (@item_status::text IS NULL OR mi.item_status = @item_status)
      AND (@eligibility::text IS NULL OR mi.eligibility = @eligibility)
    ORDER BY mi.next_due_at ASC NULLS FIRST, mi.id ASC
    LIMIT @limit;
  `);

  // ==================== Milestone 4: Author & Expiry Statements ====================

  const findDueAuthorEntitiesStmt = db.prepare(`
    SELECT * FROM monitoring_entities
    WHERE entity_type = 'author'
      AND tracking_status = 'active'
      AND entity_next_due_at <= @now::timestamptz
      AND (expires_at IS NULL OR expires_at > @now::timestamptz)
      AND (@platform::text IS NULL OR platform = @platform)
    ORDER BY is_starred DESC, entity_next_due_at ASC
    LIMIT @limit;
  `);

  const findDueEntitiesForExpiryStmt = db.prepare(`
    SELECT id, platform, entity_type, external_id, state_version
    FROM monitoring_entities
    WHERE tracking_status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at <= @now::timestamptz
      AND (@platform::text IS NULL OR platform = @platform)
      AND (@entity_type::text IS NULL OR entity_type = @entity_type)
    ORDER BY expires_at ASC
    LIMIT @limit;
  `);

  const toggleEntityStarStmt = db.prepare(`
    UPDATE monitoring_entities SET
      is_starred = @is_starred,
      expires_at = @expires_at::timestamptz,
      tracking_status = @tracking_status,
      reason = @reason,
      entity_next_due_at = COALESCE(@entity_next_due_at::timestamptz, entity_next_due_at),
      state_version = state_version + 1,
      updated_at = now()
    WHERE id = @id
      AND (@expected_state_version::int IS NULL OR state_version = @expected_state_version::int)
    RETURNING *;
  `);

  const expireEntityStmt = db.prepare(`
    UPDATE monitoring_entities SET
      tracking_status = 'expired',
      reason = COALESCE(@reason::text, reason, 'session_expired'),
      state_version = state_version + 1,
      updated_at = now()
    WHERE id = @id
      AND tracking_status = 'active'
    RETURNING *;
  `);

  const retrackEntityStmt = db.prepare(`
    UPDATE monitoring_entities SET
      session_id = @session_id,
      monitoring_started_at = @monitoring_started_at::timestamptz,
      expires_at = @expires_at::timestamptz,
      entity_next_due_at = @entity_next_due_at::timestamptz,
      is_starred = @is_starred,
      tracking_status = 'active',
      reason = NULL,
      state_version = state_version + 1,
      updated_at = now()
    WHERE id = @id
      AND (@expected_state_version::int IS NULL OR state_version = @expected_state_version::int)
    RETURNING *;
  `);

  const pauseChildItemsForEntityStmt = db.prepare(`
    UPDATE monitoring_items
    SET item_status = 'paused', updated_at = now()
    WHERE entity_id = ? AND item_status = 'active';
  `);

  const resumeChildItemsForEntityStmt = db.prepare(`
    UPDATE monitoring_items
    SET item_status = 'active', updated_at = now()
    WHERE entity_id = ? AND item_status = 'paused';
  `);

  // CRITICAL: monitoring_jobs has NO updated_at column!
  const cancelQueuedJobsForEntityStmt = db.prepare(`
    UPDATE monitoring_jobs
    SET status = 'cancelled'
    WHERE status = 'queued'
      AND (
        entity_id = @entity_id
        OR item_id IN (
          SELECT id FROM monitoring_items WHERE entity_id = @entity_id
        )
      );
  `);

  // ==================== Public Methods ====================

  async function createOrGetEntity(data = {}) {
    const platform = data.platform;
    const entityType = data.entityType || data.entity_type;
    const externalId = data.externalId || data.external_id;
    const canonicalUrl = data.canonicalUrl !== undefined ? data.canonicalUrl : (data.canonical_url || null);
    const displayName = data.displayName !== undefined ? data.displayName : (data.display_name || null);
    const identitySource = data.identitySource || data.identity_source || 'adapter';
    const identityConfidence = data.identityConfidence !== undefined ? data.identityConfidence : (data.identity_confidence !== undefined ? data.identity_confidence : 1.0);
    const sessionId = data.sessionId || data.session_id || null;
    const monitoringStartedAt = data.monitoringStartedAt || data.monitoring_started_at || null;
    const expiresAt = data.expiresAt || data.expires_at || null;
    const entityNextDueAt = data.entityNextDueAt || data.entity_next_due_at || null;
    const isStarred = data.isStarred !== undefined ? data.isStarred : Boolean(data.is_starred);
    const policyVersion = data.policyVersion || data.policy_version || 1;
    const stateVersion = data.stateVersion || data.state_version || 1;

    if (!platform || typeof platform !== 'string') {
      throw new TypeError('createOrGetEntity: platform is required');
    }
    if (entityType !== 'shop' && entityType !== 'author') {
      throw new RangeError("createOrGetEntity: entityType must be 'shop' or 'author'");
    }
    if (!externalId || typeof externalId !== 'string') {
      throw new TypeError('createOrGetEntity: externalId is required');
    }

    const startedIso = monitoringStartedAt
      ? new Date(monitoringStartedAt).toISOString()
      : new Date().toISOString();

    let computedExpiresAt = null;
    if (expiresAt) {
      computedExpiresAt = new Date(expiresAt).toISOString();
    } else if (entityType === 'author') {
      const days = isStarred ? 60 : 30;
      computedExpiresAt = new Date(Date.parse(startedIso) + days * 86400000).toISOString();
    }

    const dueIso = entityNextDueAt
      ? new Date(entityNextDueAt).toISOString()
      : startedIso;

    const row = await insertEntity.get({
      platform,
      entity_type: entityType,
      external_id: externalId,
      canonical_url: canonicalUrl || null,
      display_name: displayName || null,
      identity_source: identitySource || 'adapter',
      identity_confidence: identityConfidence != null ? Number(identityConfidence) : 1.0,
      session_id: sessionId || crypto.randomUUID(),
      monitoring_started_at: startedIso,
      expires_at: computedExpiresAt,
      entity_next_due_at: dueIso,
      is_starred: Boolean(isStarred),
      policy_version: Number(policyVersion) || 1,
      state_version: Number(stateVersion) || 1,
    });

    return serializeEntityRow(row);
  }

  async function getEntity(id) {
    if (id == null) return null;
    return serializeEntityRow(await findEntityById.get(Number(id))) || null;
  }

  async function getEntityByCompositeKey(platform, entityType, externalId) {
    if (!platform || !entityType || !externalId) return null;
    return serializeEntityRow(await findEntityByComposite.get(platform, entityType, externalId)) || null;
  }

  async function findDueEntities(limit = 100, options = {}) {
    const now = options.now || new Date();
    const platform = options.platform || null;
    const entityType = options.entityType || options.entity_type || null;

    const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

    const rows = await findDueEntitiesStmt.all({
      now: nowIso,
      platform: platform || null,
      entity_type: entityType || null,
      limit: Math.max(1, Number(limit) || 100),
    });
    return rows.map(serializeEntityRow);
  }

  async function updateEntityStatus(id, status, reason = null, options = {}) {
    const VALID_STATUSES = new Set(['active', 'paused', 'stopped', 'expired']);
    if (!VALID_STATUSES.has(status)) {
      throw new RangeError(`updateEntityStatus: invalid tracking_status '${status}'`);
    }

    const expectedStateVersion = options.expectedStateVersion !== undefined
      ? options.expectedStateVersion
      : (options.expected_state_version !== undefined ? options.expected_state_version : null);

    const updated = await updateEntityStatusStmt.get({
      id: Number(id),
      status,
      reason: reason || null,
      expected_state_version: expectedStateVersion != null ? Number(expectedStateVersion) : null,
    });

    return serializeEntityRow(updated) || null;
  }

  async function registerItemForMonitoring(data = {}) {
    const itemUid = data.itemUid || data.item_uid;
    const entityId = data.entityId !== undefined ? data.entityId : (data.entity_id !== undefined ? data.entity_id : null);
    const eligibility = data.eligibility || 'ready';
    const itemStatus = data.itemStatus || data.item_status || 'active';
    const nextDueAt = data.nextDueAt || data.next_due_at || null;

    if (!itemUid || typeof itemUid !== 'string') {
      throw new TypeError('registerItemForMonitoring: itemUid is required');
    }

    const resolvedEligibility = (entityId == null && eligibility === 'ready')
      ? 'pending_identity'
      : eligibility;

    const resolvedNextDueAt = resolvedEligibility === 'ready'
      ? (nextDueAt ? new Date(nextDueAt).toISOString() : new Date().toISOString())
      : null;

    const row = await insertOrUpdateItem.get({
      item_uid: itemUid,
      entity_id: entityId != null ? Number(entityId) : null,
      eligibility: resolvedEligibility,
      item_status: itemStatus || 'active',
      next_due_at: resolvedNextDueAt,
    });

    return row;
  }

  async function handlePendingIdentity(itemUid, options = {}) {
    const uid = typeof itemUid === 'object' && itemUid !== null ? (itemUid.itemUid || itemUid.item_uid) : itemUid;
    if (!uid || typeof uid !== 'string') {
      throw new TypeError('handlePendingIdentity: itemUid is required');
    }

    return await insertPendingItemStmt.get({
      item_uid: uid,
    });
  }

  /**
   * Looks up a monitoring item by its item_uid (string, e.g. 'etsy:123') or by
   * its numeric monitoring_items.id. item_uid is always a platform-prefixed
   * string, so a number is unambiguous and resolves by primary key.
   */
  async function getItem(itemUidOrId) {
    if (itemUidOrId == null || itemUidOrId === '') return null;
    if (typeof itemUidOrId === 'number') return getMonitoringItemById(itemUidOrId);
    return await findItemByUid.get(itemUidOrId) || null;
  }

  async function getMonitoringItemById(itemId) {
    if (itemId == null) return null;
    return await findItemById.get(Number(itemId)) || null;
  }

  async function getItemWithEntity(itemUid) {
    if (!itemUid) return null;
    return await findItemWithEntityStmt.get(itemUid) || null;
  }

  async function resolvePendingIdentity(itemUid, entityId) {
    if (!itemUid || typeof itemUid !== 'string') {
      throw new TypeError('resolvePendingIdentity: itemUid is required');
    }
    if (entityId == null) {
      throw new TypeError('resolvePendingIdentity: entityId is required');
    }

    return await resolvePendingItemStmt.get({
      item_uid: itemUid,
      entity_id: Number(entityId),
    }) || null;
  }

  async function findDueItems(limit = 100, options = {}) {
    const now = options.now || new Date();
    const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

    return await findDueItemsStmt.all({
      now: nowIso,
      limit: Math.max(1, Number(limit) || 100),
    });
  }

  /**
   * Applies a monitoring observation to product_current and daily_packed_history.
   *
   * Guarantees:
   * 1. Transactional isolation via pg_advisory_xact_lock on item_uid.
   * 2. Field presence merge semantics: only measured fields are updated.
   *    Missing fields are NEVER coerced to 0 or null.
   * 3. Media URLs (image, video_url), canonical url, and title are preserved.
   * 4. Strictly preserves product_current.status, query, and first_seen_at.
   * 5. Deduplication via stable observationId (idempotent, no inflated counts).
   * 6. Late arrival protection: if observedAt < last_crawled_at, appends to history
   *    without rolling back newer product_current state.
   * 7. Supports dual signature:
   *    applyMonitoringObservation(itemUid, payload, options)
   *    applyMonitoringObservation(db, { itemUid, patch, metadata })
   */
  async function applyMonitoringObservation(arg1, arg2, arg3) {
    let targetDb = db;
    let itemUid;
    let patch = {};
    let metadata = {};
    let options = {};

    if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
      // Signature: applyMonitoringObservation(db, { itemUid, patch, metadata })
      targetDb = arg1;
      if (typeof arg2 === 'string') {
        itemUid = arg2;
        patch = arg3 || {};
        metadata = patch.metadata || {};
        options = patch.options || {};
      } else {
        const config = arg2 || {};
        itemUid = config.itemUid || config.item_uid;
        patch = config.patch || config.payload || {};
        metadata = config.metadata || {};
        if (!metadata || typeof metadata !== 'object') metadata = {};
        options = { ...pickTopLevelObservationFields(config), ...metadata, ...(config.options || {}) };
      }
    } else {
      // Signature: applyMonitoringObservation(itemUid, payload, options)
      if (typeof arg1 === 'object' && arg1 !== null) {
        itemUid = arg1.itemUid || arg1.item_uid;
        patch = arg1.patch || arg1.payload || arg2 || {};
        metadata = (arg1 && arg1.metadata) || (arg2 && typeof arg2 === 'object' && arg2.metadata ? arg2.metadata : {});
        if (!metadata || typeof metadata !== 'object') metadata = {};
        options = { ...pickTopLevelObservationFields(arg1), ...(arg3 || arg1.options || {}) };
        if (options.db) targetDb = options.db;
      } else {
        itemUid = arg1;
        patch = arg2 || {};
        options = arg3 || {};
        metadata = options.metadata || (patch && patch.metadata ? patch.metadata : {});
        if (!metadata || typeof metadata !== 'object') metadata = {};
        if (options.db) targetDb = options.db;
      }
    }

    if (!targetDb) {
      throw new Error('applyMonitoringObservation: database instance must be provided');
    }
    if (!itemUid || typeof itemUid !== 'string') {
      throw new TypeError('applyMonitoringObservation: itemUid is required and must be a string');
    }

    const obsId = metadata.observationId
      || patch.observationId
      || options.observationId
      || (metadata.jobId && metadata.captureId ? `monitoring:${metadata.jobId}:${metadata.captureId}` : null)
      || (options.jobId && options.captureId ? `monitoring:${options.jobId}:${options.captureId}` : null)
      || (metadata.jobId ? `monitoring:${metadata.jobId}:${crypto.randomUUID()}` : null)
      || (options.jobId ? `monitoring:${options.jobId}:${crypto.randomUUID()}` : null)
      || `monitoring:job:${crypto.randomUUID()}`;

    const rawObservedAt = patch.observedAt || options.observedAt || metadata.observedAt || options.observedIso || new Date();
    const observedIso = normalizeUtcTimestamp(rawObservedAt);
    const observedDate = observedIso.slice(0, 10);
    const observedTime = observedIso.slice(11, 19);
    const observedSqlText = observedIso.replace('T', ' ').slice(0, 19);

    const runTx = targetDb.transaction(async () => {
      // 1. Transaction Advisory Lock on itemUid
      await acquireItemAdvisoryLock(targetDb, itemUid);

      // 2. Fetch existing row in product_current
      const existing = await targetDb.prepare('SELECT * FROM product_current WHERE item_uid = ?').get(itemUid);
      if (!existing) {
        throw new Error(`Item ${itemUid} not found in product_current. Cannot apply monitoring patch.`);
      }

      // 3. Deduplication check in daily_packed_history
      const historyRow = await targetDb.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?').get(itemUid, observedDate);
      let observations = historyRow ? unpackObservations(historyRow.observations_json) : [];

      let isDuplicate = observations.some(o => o && o.observationId === obsId);
      if (!isDuplicate) {
        // Safe cross-date check matching exact observationId JSON structure with wildcard escaping
        const escapedObsId = String(obsId).replace(/([%_\\])/g, '\\$1');
        const crossRows = await targetDb.prepare(
          "SELECT id, observations_json FROM daily_packed_history WHERE item_uid = ? AND observations_json LIKE ? ESCAPE '\\'"
        ).all(itemUid, `%"observationId":"${escapedObsId}"%`);
        if (crossRows && crossRows.length > 0) {
          for (const row of crossRows) {
            const crossObs = unpackObservations(row.observations_json);
            if (crossObs.some(o => o && o.observationId === obsId)) {
              isDuplicate = true;
              break;
            }
          }
        }
      }

      if (isDuplicate) {
        return {
          updated: false,
          duplicate: true,
          isLateArrival: false,
          observationId: obsId,
          itemUid,
        };
      }

      // 4. Late arrival check
      let isLateArrival = false;
      if (existing.last_crawled_at) {
        const obsMs = parseUtcMillis(observedIso);
        const crawledMs = parseUtcMillis(existing.last_crawled_at);
        if (obsMs !== null && crawledMs !== null && obsMs < crawledMs) {
          isLateArrival = true;
        }
      }

      // 5. Update product_current (only for fresh observations)
      if (!isLateArrival) {
        const updates = [];
        const params = {};

        function mergeMetric(rawVal, colCurrent, colPrev, colDelta, isFloat = false) {
          if (isMetricPresent(rawVal)) {
            const num = Number(rawVal);
            if (num < 0) {
              // Reject negative metric values to prevent corrupted counters and inverted deltas
              return false;
            }
            const val = isFloat ? num : Math.trunc(num);
            const prevVal = existing[colCurrent] != null ? Number(existing[colCurrent]) : null;

            updates.push(`${colCurrent} = @${colCurrent}`);
            params[colCurrent] = val;

            if (colPrev) {
              updates.push(`${colPrev} = @${colPrev}`);
              params[colPrev] = prevVal;
            }

            if (colDelta) {
              const delta = prevVal != null
                ? (isFloat ? Number((val - prevVal).toFixed(2)) : (val - prevVal))
                : 0;
              updates.push(`${colDelta} = @${colDelta}`);
              params[colDelta] = delta;
            }
            return true;
          }
          return false;
        }

        mergeMetric(patch.price, 'current_price', 'prev_price', 'delta_price', true);
        const rawSold = patch.soldCount ?? patch.sold_count ?? patch.sold;
        mergeMetric(rawSold, 'current_sold', 'prev_sold', 'delta_sold', false);
        mergeMetric(patch.likes, 'current_likes', 'prev_likes', 'delta_likes', false);
        mergeMetric(patch.comments, 'current_comments', 'prev_comments', 'delta_comments', false);
        mergeMetric(patch.shares, 'current_shares', 'prev_shares', 'delta_shares', false);
        mergeMetric(patch.views, 'current_views', 'prev_views', 'delta_views', false);
        // Notice: saves has current_saves and prev_saves, but NO delta_saves!
        mergeMetric(patch.saves, 'current_saves', 'prev_saves', null, false);
        mergeMetric(patch.rating, 'current_rating', 'prev_rating', 'delta_rating', true);
        mergeMetric(patch.reviews, 'current_reviews', 'prev_reviews', 'delta_reviews', false);

        // Preserving media URLs and titles
        if (patch.title !== undefined && patch.title !== null && String(patch.title).trim() !== '') {
          updates.push('title = @title');
          params.title = patch.title;
        }
        if (patch.url !== undefined && patch.url !== null && String(patch.url).trim() !== '') {
          updates.push('url = @url');
          params.url = patch.url;
        }
        if (patch.image !== undefined && patch.image !== null && String(patch.image).trim() !== '') {
          updates.push('image = @image');
          params.image = patch.image;
        }
        const rawVideo = patch.videoUrl !== undefined ? patch.videoUrl : patch.video_url;
        if (rawVideo !== undefined && rawVideo !== null && String(rawVideo).trim() !== '') {
          updates.push('video_url = @video_url');
          params.video_url = rawVideo;
        }
        const rawMediaType = patch.mediaType !== undefined ? patch.mediaType : patch.media_type;
        if (rawMediaType !== undefined && rawMediaType !== null && String(rawMediaType).trim() !== '') {
          updates.push('media_type = @media_type');
          params.media_type = rawMediaType;
        }
        const rawShopUrl = patch.shopUrl !== undefined ? patch.shopUrl : patch.shop_url;
        if (rawShopUrl !== undefined && rawShopUrl !== null && String(rawShopUrl).trim() !== '') {
          updates.push('shop_url = @shop_url');
          params.shop_url = rawShopUrl;
        }
        if (patch.country !== undefined && patch.country !== null && String(patch.country).trim() !== '') {
          updates.push('country = @country');
          params.country = patch.country;
        }

        // Marketplace return position & 30d stats
        const rawReturnPos = patch.returnPosition ?? patch.return_position;
        if (isMetricPresent(rawReturnPos)) {
          const newPos = Math.trunc(Number(rawReturnPos));
          updates.push('prev_return_position = @prev_return_position');
          params.prev_return_position = existing.return_position;
          updates.push('return_position = @return_position');
          params.return_position = newPos;
          if (existing.return_position != null) {
            updates.push('delta_return_position = @delta_return_position');
            params.delta_return_position = existing.return_position - newPos;
          }
        }
        const rawSold30d = patch.sold30d ?? patch.sold_30d;
        if (isMetricPresent(rawSold30d)) {
          updates.push('sold_30d = @sold_30d');
          params.sold_30d = Math.trunc(Number(rawSold30d));
        }
        if (isMetricPresent(patch.gmv)) {
          updates.push('gmv = @gmv');
          params.gmv = Number(patch.gmv);
        }

        // Strictly increment observation_count and update timestamps
        updates.push('observation_count = observation_count + 1');
        updates.push('last_seen_at = @last_seen_at');
        params.last_seen_at = observedSqlText;
        updates.push('last_crawled_at = @last_crawled_at');
        params.last_crawled_at = observedSqlText;

        params.item_uid = itemUid;
        const updateSql = `UPDATE product_current SET ${updates.join(', ')} WHERE item_uid = @item_uid`;
        await targetDb.prepare(updateSql).run(params);
      }

      // 6. Record observation in daily_packed_history
      const rawSold = patch.soldCount ?? patch.sold_count ?? patch.sold;
      const rawReturnPos = patch.returnPosition ?? patch.return_position;
      const rawSold30d = patch.sold30d ?? patch.sold_30d;

      const isNonNegMetric = v => isMetricPresent(v) && Number(v) >= 0;

      const newObsEntry = {
        observationId: obsId,
        runId: null, // Critical: preserves checkV2Parity contract
        time: observedTime,
        price: isNonNegMetric(patch.price) ? Number(patch.price) : null,
        sold: isNonNegMetric(rawSold) ? Math.trunc(Number(rawSold)) : null,
        likes: isNonNegMetric(patch.likes) ? Math.trunc(Number(patch.likes)) : null,
        views: isNonNegMetric(patch.views) ? Math.trunc(Number(patch.views)) : null,
        comments: isNonNegMetric(patch.comments) ? Math.trunc(Number(patch.comments)) : null,
        shares: isNonNegMetric(patch.shares) ? Math.trunc(Number(patch.shares)) : null,
        saves: isNonNegMetric(patch.saves) ? Math.trunc(Number(patch.saves)) : null,
        rating: isMetricPresent(patch.rating) ? Number(patch.rating) : null,
        reviews: isNonNegMetric(patch.reviews) ? Math.trunc(Number(patch.reviews)) : null,
        returnPosition: isMetricPresent(rawReturnPos) ? Math.trunc(Number(rawReturnPos)) : null,
        sold30d: isNonNegMetric(rawSold30d) ? Math.trunc(Number(rawSold30d)) : null,
        gmv: isNonNegMetric(patch.gmv) ? Number(patch.gmv) : null,
        source: metadata.source || options.source || 'monitoring',
        quality: metadata.quality || options.quality || 'exact',
      };

      observations.push(newObsEntry);
      const packedJson = packObservations(observations);
      const obsCount = observations.length;

      const validPrices = observations
        .map(o => o.price)
        .filter(p => p !== null && p !== undefined && !isNaN(p));

      const obsWithValidPrices = observations.filter(o => o.price !== null && o.price !== undefined && !isNaN(o.price));
      const latestPriceObs = obsWithValidPrices.length > 0
        ? obsWithValidPrices.reduce((latest, o) => new Date(o.time).getTime() > new Date(latest.time).getTime() ? o : latest, obsWithValidPrices[0])
        : null;

      if (historyRow) {
        const minPrice = validPrices.length > 0
          ? validPrices.reduce((m, p) => (p < m ? p : m), validPrices[0])
          : historyRow.min_price;
        const maxPrice = validPrices.length > 0
          ? validPrices.reduce((m, p) => (p > m ? p : m), validPrices[0])
          : historyRow.max_price;
        const latestPrice = (isNonNegMetric(patch.price) && !isLateArrival)
          ? Number(patch.price)
          : (latestPriceObs ? latestPriceObs.price : historyRow.latest_price);
        const latestLikes = (isNonNegMetric(patch.likes) && !isLateArrival)
          ? Math.trunc(Number(patch.likes))
          : historyRow.latest_likes;
        const latestViews = (isNonNegMetric(patch.views) && !isLateArrival)
          ? Math.trunc(Number(patch.views))
          : historyRow.latest_views;
        const latestSold = (isNonNegMetric(rawSold) && !isLateArrival)
          ? Math.trunc(Number(rawSold))
          : historyRow.latest_sold;

        await targetDb.prepare(`
          UPDATE daily_packed_history SET
            observations_json = @observations_json,
            observation_count = @observation_count,
            min_price = @min_price,
            max_price = @max_price,
            latest_price = @latest_price,
            latest_likes = @latest_likes,
            latest_views = @latest_views,
            latest_sold = @latest_sold,
            updated_at = @updated_at
          WHERE item_uid = @item_uid AND date = @date
        `).run({
          item_uid: itemUid,
          date: observedDate,
          observations_json: packedJson,
          observation_count: obsCount,
          min_price: minPrice,
          max_price: maxPrice,
          latest_price: latestPrice,
          latest_likes: latestLikes,
          latest_views: latestViews,
          latest_sold: latestSold,
          updated_at: observedSqlText,
        });
      } else {
        const fallbackPrice = existing.current_price ?? 0.0;
        const priceVal = isNonNegMetric(patch.price) ? Number(patch.price) : fallbackPrice;
        const minPrice = validPrices.length > 0
          ? validPrices.reduce((m, p) => (p < m ? p : m), validPrices[0])
          : priceVal;
        const maxPrice = validPrices.length > 0
          ? validPrices.reduce((m, p) => (p > m ? p : m), validPrices[0])
          : priceVal;
        const likesVal = isNonNegMetric(patch.likes) ? Math.trunc(Number(patch.likes)) : (existing.current_likes ?? 0);
        const viewsVal = isNonNegMetric(patch.views) ? Math.trunc(Number(patch.views)) : (existing.current_views ?? 0);
        const soldVal = isNonNegMetric(rawSold) ? Math.trunc(Number(rawSold)) : (existing.current_sold ?? 0);

        await targetDb.prepare(`
          INSERT INTO daily_packed_history (
            item_uid, platform, date, observations_json, observation_count,
            min_price, max_price, latest_price, latest_likes, latest_views, latest_sold,
            created_at, updated_at
          ) VALUES (
            @item_uid, @platform, @date, @observations_json, @observation_count,
            @min_price, @max_price, @latest_price, @latest_likes, @latest_views, @latest_sold,
            @created_at, @updated_at
          )
        `).run({
          item_uid: itemUid,
          platform: existing.platform,
          date: observedDate,
          observations_json: packedJson,
          observation_count: obsCount,
          min_price: minPrice,
          max_price: maxPrice,
          latest_price: priceVal,
          latest_likes: likesVal,
          latest_views: viewsVal,
          latest_sold: soldVal,
          created_at: observedSqlText,
          updated_at: observedSqlText,
        });
      }

      return {
        updated: !isLateArrival,
        duplicate: false,
        isLateArrival,
        observationId: obsId,
        itemUid,
      };
    });

    return await runTx();
  }

  // ==================== Milestone 3: Shop Methods ====================

  /**
   * Atomically records an observation for an entity into monitoring_entity_observations.
   */
  async function recordEntityObservation(entityIdOrObservation, observation = {}, options = {}) {
    // Also accept the single-object form recordEntityObservation({ entityId, ...observation }).
    let entityId = entityIdOrObservation;
    if (entityIdOrObservation && typeof entityIdOrObservation === 'object') {
      options = observation || {};
      observation = entityIdOrObservation;
      entityId = observation.entityId ?? observation.entity_id;
    }
    if (entityId == null) {
      throw new TypeError('recordEntityObservation: entityId is required');
    }
    const targetDb = options.db || db;
    const entity = await getEntity(entityId);
    if (!entity) {
      throw new Error(`recordEntityObservation: Entity ${entityId} not found`);
    }

    const rawVal = observation.metricValue ?? observation.metric_value ?? observation.value ?? observation.sales;
    const metricValue = isMetricPresent(rawVal) ? Number(rawVal) : null;
    const observedAt = observation.observedAt || observation.observed_at || new Date();
    const observedIso = normalizeUtcTimestamp(observedAt);

    const obsId = observation.observationId
      || observation.observation_id
      || options.observationId
      || `obs:entity:${entity.id}:${Date.now()}:${crypto.randomUUID()}`;

    const rawRef = observation.rawRef
      || observation.raw_ref
      || observation.rawPayload
      || observation.raw_payload
      || null;

    const rawRefStr = rawRef != null ? (typeof rawRef === 'string' ? rawRef : JSON.stringify(rawRef)) : null;

    const metricName = observation.metricName
      || observation.metric_name
      || observation.observationType
      || observation.observation_type
      || 'shop_sales';

    const quality = observation.quality || 'exact';
    const VALID_QUALITIES = new Set(['exact', 'rounded', 'estimated', 'unreliable', 'recalibrated']);
    if (!VALID_QUALITIES.has(quality)) {
      throw new RangeError(`recordEntityObservation: invalid quality '${quality}'`);
    }

    const insertStmt = (targetDb === db) ? insertEntityObservationStmt : targetDb.prepare(`
      INSERT INTO monitoring_entity_observations (
        entity_id, session_id, observation_id, observed_at,
        metric_name, metric_value, source, quality, raw_ref
      ) VALUES (
        @entity_id, @session_id, @observation_id, @observed_at::timestamptz,
        @metric_name, @metric_value, @source, @quality, @raw_ref
      )
      ON CONFLICT (observation_id) DO UPDATE SET
        metric_value = EXCLUDED.metric_value,
        quality = EXCLUDED.quality,
        raw_ref = COALESCE(EXCLUDED.raw_ref, monitoring_entity_observations.raw_ref)
      RETURNING *;
    `);

    const row = await insertStmt.get({
      entity_id: Number(entity.id),
      session_id: entity.session_id,
      observation_id: obsId,
      observed_at: observedIso,
      metric_name: metricName,
      metric_value: metricValue,
      source: observation.source || options.source || 'adapter',
      quality: quality,
      raw_ref: rawRefStr,
    });

    return row || null;
  }

  /**
   * Applies a shop probe observation atomically in a transaction.
   * Evaluates observation with ShopLifecyclePolicy, updates monitoring_entities,
   * logs to monitoring_entity_observations, and recalculates entity_next_due_at.
   */
  async function applyShopObservation(entityId, observation = {}, options = {}) {
    if (entityId == null) {
      throw new TypeError('applyShopObservation: entityId is required');
    }

    const targetDb = options.db || db;
    const runTx = targetDb.transaction(async () => {
      const entityIdNum = Number(entityId);
      // 1. Fetch current entity state with pessimistic row lock
      const entity = (targetDb === db)
        ? await findEntityForUpdateStmt.get(entityIdNum)
        : await targetDb.prepare('SELECT * FROM monitoring_entities WHERE id = ? FOR UPDATE;').get(entityIdNum);

      if (!entity) {
        throw new Error(`applyShopObservation: Entity ${entityId} not found`);
      }
      if (entity.entity_type !== 'shop') {
        throw new RangeError(`applyShopObservation: Entity ${entityId} is not a shop (entity_type='${entity.entity_type}')`);
      }

      // 2. Prepare current state for ShopLifecyclePolicy
      const currentState = {
        trackingStatus: entity.tracking_status,
        reason: entity.reason,
        sales: entity.sales != null ? Number(entity.sales) : null,
        unchangedSince: entity.unchanged_since ? normalizeUtcTimestamp(entity.unchanged_since) : null,
        salesObservedAt: entity.sales_observed_at ? normalizeUtcTimestamp(entity.sales_observed_at) : null,
        lastIncreaseObservedAt: entity.last_increase_observed_at ? normalizeUtcTimestamp(entity.last_increase_observed_at) : null,
      };

      // 3. Resolve observation inputs
      const rawSales = observation.value !== undefined
        ? observation.value
        : (observation.sales !== undefined ? observation.sales : (observation.metricValue ?? observation.metric_value));
      const observedAt = observation.observedAt || observation.observed_at || new Date();
      const observedIso = normalizeUtcTimestamp(observedAt);
      const quality = observation.quality || 'exact';
      const error = observation.error || null;

      const observationPayload = {
        value: isMetricPresent(rawSales) ? Number(rawSales) : null,
        observedAt: observedIso,
        quality,
        error,
      };

      // 4. Evaluate observation via ShopLifecyclePolicy
      let policy = options.shopLifecyclePolicy || options.lifecyclePolicy;
      if (!policy) {
        try {
          policy = require('../monitoring/shop-lifecycle').ShopLifecyclePolicy;
        } catch (_err) {
          throw new Error('applyShopObservation: ShopLifecyclePolicy could not be loaded. Please provide options.shopLifecyclePolicy.');
        }
      }

      const evaluation = policy.evaluateObservation(currentState, observationPayload);

      // 5. Calculate entity_next_due_at (F11: 5-day cycle + non-negative jitter)
      let nextDueIso = entity.entity_next_due_at ? normalizeUtcTimestamp(entity.entity_next_due_at) : null;
      if (!error && evaluation.action !== 'error_ignored') {
        const intervalDays = options.intervalDays !== undefined ? Number(options.intervalDays) : 5;
        const jitterMs = Math.max(0, Number(options.jitterMs) || (Number(options.jitterHours || 0) * 3600 * 1000));
        const obsMs = parseUtcMillis(observedIso) || Date.now();
        nextDueIso = new Date(obsMs + (intervalDays * 86400000) + jitterMs).toISOString();
      } else if (options.retryAt) {
        nextDueIso = normalizeUtcTimestamp(options.retryAt);
      } else if (options.retryDelayMs) {
        nextDueIso = new Date(Date.now() + Math.max(0, Number(options.retryDelayMs))).toISOString();
      }

      // 6. Update monitoring_entities
      const expectedStateVersion = options.expectedStateVersion !== undefined
        ? options.expectedStateVersion
        : (options.expected_state_version !== undefined ? options.expected_state_version : null);

      const updateParams = {
        id: entity.id,
        sales: evaluation.sales != null ? Math.trunc(Number(evaluation.sales)) : null,
        sales_observed_at: evaluation.salesObservedAt ? normalizeUtcTimestamp(evaluation.salesObservedAt) : null,
        unchanged_since: evaluation.unchangedSince ? normalizeUtcTimestamp(evaluation.unchangedSince) : null,
        last_increase_observed_at: evaluation.lastIncreaseObservedAt ? normalizeUtcTimestamp(evaluation.lastIncreaseObservedAt) : null,
        entity_next_due_at: nextDueIso,
        last_success_at: (!error && evaluation.action !== 'error_ignored') ? observedIso : (entity.last_success_at ? normalizeUtcTimestamp(entity.last_success_at) : null),
        tracking_status: evaluation.trackingStatus,
        reason: evaluation.reason || null,
        expected_state_version: expectedStateVersion != null ? Number(expectedStateVersion) : null,
      };

      const updateStmt = (targetDb === db) ? updateShopObservationStmt : targetDb.prepare(`
        UPDATE monitoring_entities SET
          sales = @sales,
          sales_observed_at = @sales_observed_at::timestamptz,
          unchanged_since = @unchanged_since::timestamptz,
          last_increase_observed_at = @last_increase_observed_at::timestamptz,
          entity_next_due_at = @entity_next_due_at::timestamptz,
          last_success_at = COALESCE(@last_success_at::timestamptz, last_success_at),
          tracking_status = @tracking_status,
          reason = @reason,
          state_version = state_version + 1,
          updated_at = now()
        WHERE id = @id
          AND (@expected_state_version::int IS NULL OR state_version = @expected_state_version::int)
        RETURNING *;
      `);

      const updatedEntity = await updateStmt.get(updateParams);
      if (!updatedEntity && expectedStateVersion != null) {
        throw new Error(`applyShopObservation: State version mismatch on entity ${entityId}. Expected ${expectedStateVersion}.`);
      }

      // 7. Insert observation into monitoring_entity_observations
      const obsId = observation.observationId
        || observation.observation_id
        || (options.jobId ? `obs:probe:${options.jobId}:${crypto.randomUUID()}` : `obs:shop:${entity.id}:${Date.now()}:${crypto.randomUUID()}`);

      const rawRef = observation.rawRef
        || observation.raw_ref
        || observation.rawPayload
        || observation.raw_payload
        || null;
      const rawRefStr = rawRef != null ? (typeof rawRef === 'string' ? rawRef : JSON.stringify(rawRef)) : null;

      const VALID_QUALITIES = new Set(['exact', 'rounded', 'estimated', 'unreliable', 'recalibrated']);
      let safeQuality = quality;
      if (!VALID_QUALITIES.has(safeQuality)) {
        safeQuality = error ? 'unreliable' : 'exact';
      }

      const insertObsStmt = (targetDb === db) ? insertEntityObservationStmt : targetDb.prepare(`
        INSERT INTO monitoring_entity_observations (
          entity_id, session_id, observation_id, observed_at,
          metric_name, metric_value, source, quality, raw_ref
        ) VALUES (
          @entity_id, @session_id, @observation_id, @observed_at::timestamptz,
          @metric_name, @metric_value, @source, @quality, @raw_ref
        )
        ON CONFLICT (observation_id) DO UPDATE SET
          metric_value = EXCLUDED.metric_value,
          quality = EXCLUDED.quality,
          raw_ref = COALESCE(EXCLUDED.raw_ref, monitoring_entity_observations.raw_ref)
        RETURNING *;
      `);

      const obsRow = await insertObsStmt.get({
        entity_id: entity.id,
        session_id: entity.session_id,
        observation_id: obsId,
        observed_at: observedIso,
        metric_name: observation.metricName || observation.metric_name || 'shop_sales',
        metric_value: isMetricPresent(rawSales) ? Number(rawSales) : null,
        source: observation.source || options.source || 'shop_probe',
        quality: safeQuality,
        raw_ref: rawRefStr,
      });

      // 8. If shop stopped, cascade pause/cancel to child monitoring_items & jobs
      if (evaluation.trackingStatus === 'stopped') {
        await targetDb.prepare(`
          UPDATE monitoring_items
          SET item_status = 'paused', updated_at = now()
          WHERE entity_id = ? AND item_status = 'active';
        `).run(entity.id);

        await targetDb.prepare(`
          UPDATE monitoring_jobs
          SET status = 'cancelled'
          WHERE kind = 'item_refresh'
            AND status = 'queued'
            AND (entity_id = @entity_id OR item_id IN (
              SELECT id FROM monitoring_items WHERE entity_id = @entity_id
            ));
        `).run({ entity_id: entity.id });
      }

      return {
        entity: serializeEntityRow(updatedEntity),
        evaluation,
        observation: obsRow,
        action: evaluation.action,
        trackingStatus: evaluation.trackingStatus,
        reason: evaluation.reason,
        sales: evaluation.sales,
        unchangedSince: evaluation.unchangedSince,
        salesObservedAt: evaluation.salesObservedAt,
        lastIncreaseObservedAt: evaluation.lastIncreaseObservedAt,
        stateChanged: evaluation.stateChanged,
      };
    });

    return await runTx();
  }

  /**
   * Queries monitoring_entities for active shop entities due for probe scrape.
   */
  async function findDueShopEntities(limit = 100, options = {}) {
    const targetDb = options.db || db;
    const now = options.now || new Date();
    const nowIso = normalizeUtcTimestamp(now);
    const platform = options.platform || null;

    const stmt = (targetDb === db) ? findDueShopEntitiesStmt : targetDb.prepare(`
      SELECT * FROM monitoring_entities
      WHERE entity_type = 'shop'
        AND tracking_status = 'active'
        AND entity_next_due_at <= @now::timestamptz
        AND (expires_at IS NULL OR expires_at > @now::timestamptz)
        AND (@platform::text IS NULL OR platform = @platform)
      ORDER BY is_starred DESC, entity_next_due_at ASC
      LIMIT @limit;
    `);

    const rows = await stmt.all({
      now: nowIso,
      platform: platform || null,
      limit: Math.max(1, Number(limit) || 100),
    });
    return rows.map(serializeEntityRow);
  }

  /**
   * Retrieves child items linked to a shop entity for sequential probe hierarchy execution.
   */
  async function getChildItemsForEntity(entityId, options = {}) {
    if (entityId == null) {
      throw new TypeError('getChildItemsForEntity: entityId is required');
    }
    const targetDb = options.db || db;
    const itemStatus = options.itemStatus !== undefined ? options.itemStatus : (options.item_status || 'active');
    const eligibility = options.eligibility || null;
    const limit = options.limit ? Math.max(1, Number(options.limit)) : 1000;

    const stmt = (targetDb === db) ? getChildItemsForEntityStmt : targetDb.prepare(`
      SELECT mi.*,
             pc.title, pc.url, pc.current_price, pc.current_sold,
             pc.status AS discovery_status
      FROM monitoring_items mi
      LEFT JOIN product_current pc ON mi.item_uid = pc.item_uid
      WHERE mi.entity_id = @entity_id
        AND (@item_status::text IS NULL OR mi.item_status = @item_status)
        AND (@eligibility::text IS NULL OR mi.eligibility = @eligibility)
      ORDER BY mi.next_due_at ASC NULLS FIRST, mi.id ASC
      LIMIT @limit;
    `);

    return await stmt.all({
      entity_id: Number(entityId),
      item_status: itemStatus === 'all' ? null : itemStatus,
      eligibility: eligibility || null,
      limit,
    });
  }

  // ==================== Milestone 4: Author & Lifecycle Operations ====================

  /**
   * Toggles star status for an entity (author or shop).
   *
   * For authors:
   * - Starring (true): extends expires_at to monitoring_started_at + 60d.
   *   If expired between Day 30 and Day 60, revives to 'active'.
   *   If past Day 60, rejects revival with PAST_60D_WINDOW_CANNOT_REACTIVATE.
   * - Unstarring (false):
   *   If before Day 30, reverts expires_at to monitoring_started_at + 30d.
   *   If on/after Day 30, triggers immediate expiration ('expired'),
   *   cascading to pause active child items and cancel queued jobs.
   *
   * For shops:
   * - Toggles is_starred (scheduling priority only; does not alter sales stoppage policy).
   */
  async function toggleEntityStar(entityId, isStarred, options = {}) {
    if (entityId == null) {
      throw new TypeError('toggleEntityStar: entityId is required');
    }

    const targetDb = options.db || db;
    const starredBool = Boolean(isStarred);
    const now = options.now || new Date();
    const nowIso = normalizeUtcTimestamp(now);

    const runTx = targetDb.transaction(async () => {
      const entityIdNum = Number(entityId);

      // 1. Pessimistic row lock
      const entity = (targetDb === db)
        ? await findEntityForUpdateStmt.get(entityIdNum)
        : await targetDb.prepare('SELECT * FROM monitoring_entities WHERE id = ? FOR UPDATE;').get(entityIdNum);

      if (!entity) {
        throw new Error(`toggleEntityStar: Entity ${entityId} not found`);
      }

      // Optimistic lock check if requested
      const expectedStateVersion = options.expectedStateVersion !== undefined
        ? options.expectedStateVersion
        : (options.expected_state_version !== undefined ? options.expected_state_version : null);

      if (expectedStateVersion != null && entity.state_version !== Number(expectedStateVersion)) {
        throw new Error(`toggleEntityStar: State version mismatch on entity ${entityId}. Expected ${expectedStateVersion}, found ${entity.state_version}.`);
      }

      // 2. Resolve lifecycle policy
      let policy = options.socialLifecyclePolicy || options.lifecyclePolicy;
      if (!policy && entity.entity_type === 'author') {
        try {
          policy = require('../monitoring/social-lifecycle').SocialLifecyclePolicy;
        } catch (_err) {
          // Fallback handled below
        }
      }

      let newStatus = entity.tracking_status;
      let newExpiresAt = entity.expires_at ? normalizeUtcTimestamp(entity.expires_at) : null;
      let newReason = entity.reason;
      let action = 'noop';
      let stateChanged = false;
      let error = null;
      let nextDueIso = entity.entity_next_due_at ? normalizeUtcTimestamp(entity.entity_next_due_at) : null;

      if (entity.entity_type === 'author') {
        if (starredBool === Boolean(entity.is_starred) && entity.tracking_status !== 'expired') {
          // Idempotent no-op
          return {
            entity: serializeEntityRow(entity),
            stateChanged: false,
            action: starredBool ? 'noop_already_starred' : 'noop_already_unstarred',
            isStarred: starredBool,
            trackingStatus: entity.tracking_status,
            expiresAt: newExpiresAt,
          };
        }

        if (policy) {
          const evalResult = starredBool
            ? policy.handleStar(entity, nowIso)
            : policy.handleUnstar(entity, nowIso);

          stateChanged = evalResult.stateChanged !== false;
          newStatus = evalResult.tracking_status || evalResult.trackingStatus || newStatus;
          newExpiresAt = evalResult.expires_at || evalResult.expiresAt || newExpiresAt;
          newReason = evalResult.reason !== undefined ? evalResult.reason : newReason;
          action = evalResult.action || (starredBool ? 'window_extended_to_60d' : 'reverted_to_standard_deadline');
          error = evalResult.error || null;
        } else {
          // Fallback inline policy oracle matching SSOT §3.3
          const startMs = parseUtcMillis(entity.monitoring_started_at) || Date.now();
          const nowMs = parseUtcMillis(nowIso) || Date.now();
          const standardMs = startMs + (30 * 86400000);
          const starredMs = startMs + (60 * 86400000);

          if (starredBool) {
            if (nowMs >= starredMs) {
              return {
                entity: serializeEntityRow(entity),
                stateChanged: false,
                error: 'PAST_60D_WINDOW_CANNOT_REACTIVATE',
                action: 'past_60d_cannot_reactivate',
                isStarred: true,
                trackingStatus: entity.tracking_status,
                expiresAt: newExpiresAt,
              };
            }
            newExpiresAt = new Date(starredMs).toISOString();
            if (entity.tracking_status === 'expired') {
              newStatus = 'active';
              newReason = null;
              action = 'reactivated_from_expired';
            } else {
              action = 'window_extended_to_60d';
            }
            stateChanged = true;
          } else {
            newExpiresAt = new Date(standardMs).toISOString();
            if (nowMs >= standardMs) {
              newStatus = 'expired';
              newReason = 'unstarred_after_standard_deadline';
              action = 'expired_immediately_on_unstar';
            } else {
              action = 'reverted_to_standard_deadline';
            }
            stateChanged = true;
          }
        }

        // On reactivation from expired, schedule next due 5 days from now
        if (action === 'reactivated_from_expired') {
          const intervalDays = options.intervalDays !== undefined ? Number(options.intervalDays) : 5;
          nextDueIso = new Date((parseUtcMillis(nowIso) || Date.now()) + (intervalDays * 86400000)).toISOString();
        }
      } else {
        // Shop or other entity: star updates priority only
        if (starredBool === Boolean(entity.is_starred)) {
          return {
            entity: serializeEntityRow(entity),
            stateChanged: false,
            action: 'noop_already_set',
            isStarred: starredBool,
            trackingStatus: entity.tracking_status,
            expiresAt: newExpiresAt,
          };
        }
        stateChanged = true;
        action = starredBool ? 'shop_starred' : 'shop_unstarred';
      }

      if (!stateChanged && error) {
        return {
          entity: serializeEntityRow(entity),
          stateChanged: false,
          error,
          action,
          isStarred: starredBool,
          trackingStatus: entity.tracking_status,
          expiresAt: newExpiresAt,
        };
      }

      // 3. Update database
      const updateStmt = (targetDb === db) ? toggleEntityStarStmt : targetDb.prepare(`
        UPDATE monitoring_entities SET
          is_starred = @is_starred,
          expires_at = @expires_at::timestamptz,
          tracking_status = @tracking_status,
          reason = @reason,
          entity_next_due_at = COALESCE(@entity_next_due_at::timestamptz, entity_next_due_at),
          state_version = state_version + 1,
          updated_at = now()
        WHERE id = @id
          AND (@expected_state_version::int IS NULL OR state_version = @expected_state_version::int)
        RETURNING *;
      `);

      const updatedEntity = await updateStmt.get({
        id: entity.id,
        is_starred: starredBool,
        expires_at: newExpiresAt,
        tracking_status: newStatus,
        reason: newReason || null,
        entity_next_due_at: nextDueIso,
        expected_state_version: expectedStateVersion != null ? Number(expectedStateVersion) : null,
      });

      // 4. Cascade handling
      let itemsPaused = 0;
      let jobsCancelled = 0;

      if (newStatus === 'expired' && entity.tracking_status !== 'expired') {
        const pauseStmt = (targetDb === db) ? pauseChildItemsForEntityStmt : targetDb.prepare(`
          UPDATE monitoring_items
          SET item_status = 'paused', updated_at = now()
          WHERE entity_id = ? AND item_status = 'active';
        `);
        const itemRes = await pauseStmt.run(entity.id);
        itemsPaused = itemRes.changes || 0;

        const cancelStmt = (targetDb === db) ? cancelQueuedJobsForEntityStmt : targetDb.prepare(`
          UPDATE monitoring_jobs
          SET status = 'cancelled'
          WHERE status = 'queued'
            AND (
              entity_id = @entity_id
              OR item_id IN (
                SELECT id FROM monitoring_items WHERE entity_id = @entity_id
              )
            );
        `);
        const jobRes = await cancelStmt.run({ entity_id: entity.id });
        jobsCancelled = jobRes.changes || 0;
      } else if (action === 'reactivated_from_expired' && options.resumeChildItems !== false) {
        const resumeStmt = (targetDb === db) ? resumeChildItemsForEntityStmt : targetDb.prepare(`
          UPDATE monitoring_items
          SET item_status = 'active', updated_at = now()
          WHERE entity_id = ? AND item_status = 'paused';
        `);
        await resumeStmt.run(entity.id);
      }

      return {
        entity: serializeEntityRow(updatedEntity),
        stateChanged: true,
        action,
        isStarred: starredBool,
        trackingStatus: newStatus,
        expiresAt: newExpiresAt,
        reason: newReason,
        itemsPaused,
        jobsCancelled,
      };
    });

    return await runTx();
  }

  /**
   * Scans and expires active monitoring_entities where expires_at <= now().
   *
   * Transactional and atomic:
   * 1. Finds active entities past expires_at.
   * 2. Sets tracking_status = 'expired', state_version = state_version + 1.
   * 3. Cascades to pause active child items in monitoring_items (item_status = 'paused').
   * 4. Cascades to cancel queued jobs in monitoring_jobs (status = 'cancelled').
   */
  async function expireDueEntities(options = {}) {
    const targetDb = options.db || db;
    const now = options.now || new Date();
    const nowIso = normalizeUtcTimestamp(now);
    const platform = options.platform || null;
    const entityType = options.entityType || options.entity_type || null;
    const limit = Math.max(1, Number(options.limit) || 1000);
    const reason = options.reason || 'session_expired';

    const runTx = targetDb.transaction(async () => {
      const selectStmt = (targetDb === db) ? findDueEntitiesForExpiryStmt : targetDb.prepare(`
        SELECT id, platform, entity_type, external_id, state_version
        FROM monitoring_entities
        WHERE tracking_status = 'active'
          AND expires_at IS NOT NULL
          AND expires_at <= @now::timestamptz
          AND (@platform::text IS NULL OR platform = @platform)
          AND (@entity_type::text IS NULL OR entity_type = @entity_type)
        ORDER BY expires_at ASC
        LIMIT @limit;
      `);

      const dueEntities = await selectStmt.all({
        now: nowIso,
        platform,
        entity_type: entityType,
        limit,
      });

      if (!dueEntities || dueEntities.length === 0) {
        return {
          expiredCount: 0,
          expiredEntityIds: [],
          itemsPausedCount: 0,
          jobsCancelledCount: 0,
        };
      }

      const expiredEntityIds = [];
      let itemsPausedCount = 0;
      let jobsCancelledCount = 0;

      const expireStmt = (targetDb === db) ? expireEntityStmt : targetDb.prepare(`
        UPDATE monitoring_entities SET
          tracking_status = 'expired',
          reason = COALESCE(@reason::text, reason, 'session_expired'),
          state_version = state_version + 1,
          updated_at = now()
        WHERE id = @id
          AND tracking_status = 'active'
        RETURNING *;
      `);

      const pauseStmt = (targetDb === db) ? pauseChildItemsForEntityStmt : targetDb.prepare(`
        UPDATE monitoring_items
        SET item_status = 'paused', updated_at = now()
        WHERE entity_id = ? AND item_status = 'active';
      `);

      const cancelStmt = (targetDb === db) ? cancelQueuedJobsForEntityStmt : targetDb.prepare(`
        UPDATE monitoring_jobs
        SET status = 'cancelled'
        WHERE status = 'queued'
          AND (
            entity_id = @entity_id
            OR item_id IN (
              SELECT id FROM monitoring_items WHERE entity_id = @entity_id
            )
          );
      `);

      for (const ent of dueEntities) {
        const updated = await expireStmt.get({ id: ent.id, reason });
        if (updated) {
          expiredEntityIds.push(ent.id);

          const pauseRes = await pauseStmt.run(ent.id);
          itemsPausedCount += (pauseRes.changes || 0);

          const cancelRes = await cancelStmt.run({ entity_id: ent.id });
          jobsCancelledCount += (cancelRes.changes || 0);
        }
      }

      return {
        expiredCount: expiredEntityIds.length,
        expiredEntityIds,
        itemsPausedCount,
        jobsCancelledCount,
      };
    });

    return await runTx();
  }

  /**
   * Queries monitoring_entities for active author entities due for recrawl.
   *
   * Criteria:
   * - entity_type = 'author'
   * - tracking_status = 'active'
   * - entity_next_due_at <= now()
   * - expires_at IS NULL OR expires_at > now()
   * - ORDER BY is_starred DESC, entity_next_due_at ASC
   */
  async function findDueAuthorEntities(arg1, arg2) {
    let limit = 100;
    let options = {};
    if (typeof arg1 === 'number') {
      limit = arg1;
      options = arg2 || {};
    } else if (typeof arg1 === 'object' && arg1 !== null) {
      options = arg1;
      limit = options.limit !== undefined ? options.limit : 100;
    }

    const targetDb = options.db || db;
    const now = options.now || new Date();
    const nowIso = normalizeUtcTimestamp(now);
    const platform = options.platform || null;

    const stmt = (targetDb === db) ? findDueAuthorEntitiesStmt : targetDb.prepare(`
      SELECT * FROM monitoring_entities
      WHERE entity_type = 'author'
        AND tracking_status = 'active'
        AND entity_next_due_at <= @now::timestamptz
        AND (expires_at IS NULL OR expires_at > @now::timestamptz)
        AND (@platform::text IS NULL OR platform = @platform)
      ORDER BY is_starred DESC, entity_next_due_at ASC
      LIMIT @limit;
    `);

    const rows = await stmt.all({
      now: nowIso,
      platform: platform || null,
      limit: Math.max(1, Number(limit) || 100),
    });
    return rows.map(serializeEntityRow);
  }

  /**
   * Starts a brand new monitoring session for an expired/stopped entity ("Theo dõi lại").
   *
   * - Allocates brand new session_id (UUID).
   * - Resets monitoring_started_at = now().
   * - Recomputes expires_at = now() + (is_starred ? 60 : 30) days.
   * - Resets entity_next_due_at = now().
   * - Sets tracking_status = 'active', reason = null.
   * - Increments state_version = state_version + 1.
   * - Preserves all historic observations in monitoring_entity_observations.
   */
  async function retrackEntity(entityId, options = {}) {
    if (entityId == null) {
      throw new TypeError('retrackEntity: entityId is required');
    }

    const targetDb = options.db || db;
    const now = options.now || new Date();
    const nowIso = normalizeUtcTimestamp(now);
    const newSessionId = options.sessionId || crypto.randomUUID();

    const runTx = targetDb.transaction(async () => {
      const entityIdNum = Number(entityId);
      const entity = (targetDb === db)
        ? await findEntityForUpdateStmt.get(entityIdNum)
        : await targetDb.prepare('SELECT * FROM monitoring_entities WHERE id = ? FOR UPDATE;').get(entityIdNum);

      if (!entity) {
        throw new Error(`retrackEntity: Entity ${entityId} not found`);
      }

      const expectedStateVersion = options.expectedStateVersion !== undefined
        ? options.expectedStateVersion
        : (options.expected_state_version !== undefined ? options.expected_state_version : null);

      if (expectedStateVersion != null && entity.state_version !== Number(expectedStateVersion)) {
        throw new Error(`retrackEntity: State version mismatch on entity ${entityId}. Expected ${expectedStateVersion}, found ${entity.state_version}.`);
      }

      const isStarred = options.isStarred !== undefined ? Boolean(options.isStarred) : (options.is_starred !== undefined ? Boolean(options.is_starred) : false);
      const days = isStarred ? 60 : 30;
      const startMs = parseUtcMillis(nowIso) || Date.now();
      const expiresIso = entity.entity_type === 'author'
        ? new Date(startMs + (days * 86400000)).toISOString()
        : null;

      const updateStmt = (targetDb === db) ? retrackEntityStmt : targetDb.prepare(`
        UPDATE monitoring_entities SET
          session_id = @session_id,
          monitoring_started_at = @monitoring_started_at::timestamptz,
          expires_at = @expires_at::timestamptz,
          entity_next_due_at = @entity_next_due_at::timestamptz,
          is_starred = @is_starred,
          tracking_status = 'active',
          reason = NULL,
          state_version = state_version + 1,
          updated_at = now()
        WHERE id = @id
          AND (@expected_state_version::int IS NULL OR state_version = @expected_state_version::int)
        RETURNING *;
      `);

      const updatedEntity = await updateStmt.get({
        id: entity.id,
        session_id: newSessionId,
        monitoring_started_at: nowIso,
        expires_at: expiresIso,
        entity_next_due_at: nowIso,
        is_starred: isStarred,
        expected_state_version: expectedStateVersion != null ? Number(expectedStateVersion) : null,
      });

      // Resume child items if requested
      if (options.resumeChildItems !== false) {
        const resumeStmt = (targetDb === db) ? resumeChildItemsForEntityStmt : targetDb.prepare(`
          UPDATE monitoring_items
          SET item_status = 'active', updated_at = now()
          WHERE entity_id = ? AND item_status = 'paused';
        `);
        await resumeStmt.run(entity.id);
      }

      return {
        entity: serializeEntityRow(updatedEntity),
        action: 'new_session_started',
        sessionId: newSessionId,
        monitoringStartedAt: nowIso,
        expiresAt: expiresIso,
        isStarred,
        is_starred: isStarred,
        trackingStatus: 'active',
        stateChanged: true,
      };
    });

    return await runTx();
  }

  // ==========================================
  // Milestone 5: Queue & Fencing Operations
  // ==========================================

  async function claimNextDueMonitoringJob(arg1, arg2) {
    let workerToken;
    let leaseDurationMs = 60000;
    if (arg1 && typeof arg1 === 'object') {
      workerToken = arg1.workerToken || arg1.claimToken || arg1.claim_token;
      if (arg1.leaseDurationMs !== undefined) leaseDurationMs = Number(arg1.leaseDurationMs);
    } else {
      workerToken = arg1;
      if (arg2 !== undefined) leaseDurationMs = Number(arg2);
    }
    if (!workerToken) {
      workerToken = `worker:${process.pid}:${crypto.randomUUID()}`;
    }

    const res = await db.query(`
      UPDATE monitoring_jobs
      SET status = 'claimed',
          claim_token = $1,
          claimed_until = now() + ($2 || ' milliseconds')::interval,
          started_at = now()
      WHERE id = (
        SELECT j.id
        FROM monitoring_jobs j
        LEFT JOIN monitoring_entities e ON j.entity_id = e.id
        LEFT JOIN monitoring_items i ON j.item_id = i.id
        LEFT JOIN monitoring_entities ei ON i.entity_id = ei.id
        WHERE j.status = 'queued'
          AND (j.retry_at IS NULL OR j.retry_at <= now())
          AND j.scheduled_for <= now()
        ORDER BY
          -- Shop probe runs before items
          CASE WHEN j.kind = 'shop_probe' THEN 0 ELSE 1 END ASC,
          -- Starred entities prioritized (either direct entity or via item)
          CASE WHEN COALESCE(e.is_starred, ei.is_starred, FALSE) IS TRUE THEN 0 ELSE 1 END ASC,
          -- Scheduled time (aging)
          j.scheduled_for ASC
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      RETURNING *;
    `, [workerToken, `${leaseDurationMs}`]);

    return res.rows && res.rows.length > 0 ? res.rows[0] : null;
  }

  async function completeMonitoringJob(arg1, arg2, arg3) {
    let jobId;
    let claimToken;
    let observationId = null;

    if (arg1 && typeof arg1 === 'object') {
      jobId = arg1.jobId || arg1.id;
      claimToken = arg1.claimToken || arg1.claim_token;
      observationId = arg1.observationId || arg1.observation_id || null;
    } else {
      jobId = arg1;
      claimToken = arg2;
      observationId = arg3 || null;
    }

    if (!jobId || !claimToken) return false;

    const res = await db.query(`
      UPDATE monitoring_jobs
      SET status = 'completed',
          finished_at = now(),
          observation_id = COALESCE($3, observation_id)
      WHERE id = $1 AND claim_token = $2 AND status = 'claimed'
      RETURNING id;
    `, [jobId, claimToken, observationId]);

    return Boolean(res.rows && res.rows.length > 0);
  }

  async function failMonitoringJob(arg1, arg2, arg3, arg4) {
    let jobId;
    let claimToken;
    let error = 'Unknown failure';
    let isRetryable = true;
    let baseMs = 1000;
    let maxRetries = 5;

    if (arg1 && typeof arg1 === 'object') {
      jobId = arg1.jobId || arg1.id;
      claimToken = arg1.claimToken || arg1.claim_token;
      error = arg1.error || arg1.errorMessage || arg1.error_message || error;
      if (arg1.isRetryable !== undefined) isRetryable = Boolean(arg1.isRetryable);
      if (arg1.baseMs !== undefined) baseMs = Number(arg1.baseMs);
      if (arg1.maxRetries !== undefined) maxRetries = Number(arg1.maxRetries);
    } else {
      jobId = arg1;
      claimToken = arg2;
      if (arg3 !== undefined) error = arg3;
      if (arg4 !== undefined) {
        if (typeof arg4 === 'object') {
          if (arg4.isRetryable !== undefined) isRetryable = Boolean(arg4.isRetryable);
          if (arg4.baseMs !== undefined) baseMs = Number(arg4.baseMs);
          if (arg4.maxRetries !== undefined) maxRetries = Number(arg4.maxRetries);
        } else {
          isRetryable = Boolean(arg4);
        }
      }
    }

    if (!jobId || !claimToken) return false;

    const currentJob = await db.prepare('SELECT id, attempt_count FROM monitoring_jobs WHERE id = ?').get(jobId);
    if (!currentJob) return false;

    const nextAttempt = Number(currentJob.attempt_count || 0) + 1;
    const canRetry = isRetryable && (nextAttempt < maxRetries);
    const errorMessage = String(error?.message || error || 'Unknown failure');

    if (canRetry) {
      const nextRetryAt = computeBackoffRetryAt(nextAttempt, { baseMs });
      const res = await db.query(`
        UPDATE monitoring_jobs
        SET status = 'queued',
            attempt_count = $1,
            retry_at = $2::timestamptz,
            claim_token = NULL,
            claimed_until = NULL,
            finished_at = now(),
            error_message = $3
        WHERE id = $4 AND claim_token = $5 AND status = 'claimed'
        RETURNING id, attempt_count, retry_at;
      `, [nextAttempt, nextRetryAt.toISOString(), errorMessage, jobId, claimToken]);

      return (res.rows && res.rows.length > 0)
        ? { retried: true, attemptCount: nextAttempt, retryAt: nextRetryAt }
        : false;
    } else {
      const res = await db.query(`
        UPDATE monitoring_jobs
        SET status = 'failed',
            attempt_count = $1,
            claim_token = NULL,
            claimed_until = NULL,
            finished_at = now(),
            error_message = $2
        WHERE id = $3 AND claim_token = $4 AND status = 'claimed'
        RETURNING id, attempt_count;
      `, [nextAttempt, errorMessage, jobId, claimToken]);

      return (res.rows && res.rows.length > 0)
        ? { retried: false, attemptCount: nextAttempt, status: 'failed' }
        : false;
    }
  }

  async function recoverExpiredMonitoringJobs() {
    const res = await db.query(`
      UPDATE monitoring_jobs
      SET status = 'queued',
          claim_token = NULL,
          claimed_until = NULL
      WHERE status = 'claimed' AND claimed_until < now()
      RETURNING id;
    `);

    return res.rows || [];
  }

  return {
    // Entity methods
    createOrGetEntity,
    getEntity,
    getEntityByCompositeKey,
    findDueEntities,
    updateEntityStatus,

    // Item methods
    registerItemForMonitoring,
    handlePendingIdentity,
    getItem,
    getMonitoringItemById,
    getItemWithEntity,
    resolvePendingIdentity,
    findDueItems,

    // Patch Writer (Milestone 2)
    applyMonitoringObservation,

    // Shop operations (Milestone 3)
    applyShopObservation,
    recordEntityObservation,
    findDueShopEntities,
    getChildItemsForEntity,

    // Milestone 4: Author & Lifecycle Operations
    toggleEntityStar,
    expireDueEntities,
    findDueAuthorEntities,
    retrackEntity,

    // Milestone 5: Queue & Fencing Operations
    claimNextDueMonitoringJob,
    completeMonitoringJob,
    failMonitoringJob,
    recoverExpiredMonitoringJobs,
  };
}

async function applyMonitoringObservation(arg1, arg2, arg3) {
  let db;
  if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
    db = arg1;
  } else {
    const options = arg3 || {};
    db = options.db;
  }
  const ops = createMonitoringOps(db);
  return await ops.applyMonitoringObservation(arg1, arg2, arg3);
}

async function applyShopObservation(arg1, arg2, arg3, arg4) {
  let db;
  let entityId;
  let observation;
  let options;

  if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
    db = arg1;
    entityId = arg2;
    observation = arg3;
    options = arg4 || {};
  } else {
    entityId = arg1;
    observation = arg2;
    options = arg3 || {};
    db = options.db;
  }
  const ops = createMonitoringOps(db, options);
  return await ops.applyShopObservation(entityId, observation, options);
}

async function recordEntityObservation(arg1, arg2, arg3, arg4) {
  let db;
  let entityId;
  let observation;
  let options;

  if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
    db = arg1;
    entityId = arg2;
    observation = arg3;
    options = arg4 || {};
  } else {
    entityId = arg1;
    observation = arg2;
    options = arg3 || {};
    db = options.db;
  }
  const ops = createMonitoringOps(db, options);
  return await ops.recordEntityObservation(entityId, observation, options);
}

async function findDueShopEntities(arg1, arg2, arg3) {
  let db;
  let limit;
  let options;

  if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
    db = arg1;
    limit = arg2;
    options = arg3 || {};
  } else {
    limit = arg1;
    options = arg2 || {};
    db = options.db;
  }
  const ops = createMonitoringOps(db, options);
  return await ops.findDueShopEntities(limit, options);
}

async function getChildItemsForEntity(arg1, arg2, arg3) {
  let db;
  let entityId;
  let options;

  if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
    db = arg1;
    entityId = arg2;
    options = arg3 || {};
  } else {
    entityId = arg1;
    options = arg2 || {};
    db = options.db;
  }
  const ops = createMonitoringOps(db, options);
  return await ops.getChildItemsForEntity(entityId, options);
}

async function toggleEntityStar(arg1, arg2, arg3, arg4) {
  let db;
  let entityId;
  let isStarred;
  let options;

  if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
    db = arg1;
    entityId = arg2;
    isStarred = arg3;
    options = arg4 || {};
  } else {
    entityId = arg1;
    isStarred = arg2;
    options = arg3 || {};
    db = options.db;
  }
  const ops = createMonitoringOps(db, options);
  return await ops.toggleEntityStar(entityId, isStarred, options);
}

async function expireDueEntities(arg1, arg2) {
  let db;
  let options;

  if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
    db = arg1;
    options = arg2 || {};
  } else {
    options = arg1 || {};
    db = options.db;
  }
  const ops = createMonitoringOps(db, options);
  return await ops.expireDueEntities(options);
}

async function findDueAuthorEntities(arg1, arg2, arg3) {
  let db;
  let limit;
  let options;

  if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
    db = arg1;
    limit = arg2;
    options = arg3 || {};
  } else {
    limit = arg1;
    options = arg2 || {};
    db = options.db;
  }
  const ops = createMonitoringOps(db, options);
  return await ops.findDueAuthorEntities(limit, options);
}

async function retrackEntity(arg1, arg2, arg3) {
  let db;
  let entityId;
  let options;

  if (arg1 && typeof arg1 === 'object' && (typeof arg1.prepare === 'function' || typeof arg1.query === 'function')) {
    db = arg1;
    entityId = arg2;
    options = arg3 || {};
  } else {
    entityId = arg1;
    options = arg2 || {};
    db = options.db;
  }
  const ops = createMonitoringOps(db, options);
  return await ops.retrackEntity(entityId, options);
}

async function claimNextDueMonitoringJob(...args) {
  let db;
  let targetArgs;
  if (args[0] && typeof args[0] === 'object' && (typeof args[0].prepare === 'function' || typeof args[0].query === 'function')) {
    db = args[0];
    targetArgs = args.slice(1);
  } else {
    targetArgs = args;
    db = (args[0] && args[0].db) || (args[1] && args[1].db);
  }
  const ops = createMonitoringOps(db);
  return await ops.claimNextDueMonitoringJob(...targetArgs);
}

async function completeMonitoringJob(...args) {
  let db;
  let targetArgs;
  if (args[0] && typeof args[0] === 'object' && (typeof args[0].prepare === 'function' || typeof args[0].query === 'function')) {
    db = args[0];
    targetArgs = args.slice(1);
  } else {
    targetArgs = args;
    db = (args[0] && args[0].db) || (args[1] && args[1].db);
  }
  const ops = createMonitoringOps(db);
  return await ops.completeMonitoringJob(...targetArgs);
}

async function failMonitoringJob(...args) {
  let db;
  let targetArgs;
  if (args[0] && typeof args[0] === 'object' && (typeof args[0].prepare === 'function' || typeof args[0].query === 'function')) {
    db = args[0];
    targetArgs = args.slice(1);
  } else {
    targetArgs = args;
    db = (args[0] && args[0].db) || (args[1] && args[1].db);
  }
  const ops = createMonitoringOps(db);
  return await ops.failMonitoringJob(...targetArgs);
}

async function recoverExpiredMonitoringJobs(...args) {
  let db;
  if (args[0] && typeof args[0] === 'object' && (typeof args[0].prepare === 'function' || typeof args[0].query === 'function')) {
    db = args[0];
  } else {
    db = (args[0] && args[0].db);
  }
  const ops = createMonitoringOps(db);
  return await ops.recoverExpiredMonitoringJobs();
}

module.exports = {
  createMonitoringOps,
  applyMonitoringObservation,
  applyShopObservation,
  recordEntityObservation,
  findDueShopEntities,
  getChildItemsForEntity,
  // Milestone 4 Additions
  toggleEntityStar,
  expireDueEntities,
  findDueAuthorEntities,
  retrackEntity,
  // Milestone 5 Additions
  claimNextDueMonitoringJob,
  completeMonitoringJob,
  failMonitoringJob,
  recoverExpiredMonitoringJobs,
  MonitoringLimiter,
  acquireMonitoringLease,
  releaseMonitoringLease,
  MonitoringDispatcher,
  parseMonitoringFlag,
};
