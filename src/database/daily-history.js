/**
 * Daily Packed History Engine (Tier 2)
 * Compresses multiple intra-day observations into 1 daily row per item,
 * preserving 100% of historical timestamps and observations while reducing row count.
 *
 * Final Blocker Fix Round §4: each packed observation now carries a stable
 * `observationId`, and appendObservation() is idempotent by that identity —
 * calling it twice for the same real observation (a retried write, a
 * re-run migration) updates/replaces the existing entry instead of blindly
 * pushing a duplicate. observation_count is always derived from the final
 * array length, never blindly incremented, so a rejected/replaced duplicate
 * cannot inflate the count.
 */

/**
 * Deterministic identity for one observation:
 *  - migrating from legacy: `legacy:<snapshot_id>` — re-running the backfill
 *    for the same legacy row must produce the exact same identity, so it
 *    replaces (not duplicates) its own prior migration.
 *  - a real live crawl: `run:<runId>:<itemUid>` — the invariant is one
 *    observation per item per Run, so this is stable and never collides
 *    with a different Run's observation for the same item, even within the
 *    same second (timestamp alone is NOT a safe identity — two crawls can
 *    legitimately land in the same second).
 *  - neither available: no stable identity can be formed; the caller gets
 *    `null` back and the observation is appended without dedup (best-effort
 *    fallback for callers that don't supply either, e.g. ad-hoc scripts).
 */
function buildObservationId({ runId, legacySnapshotId, itemUid }) {
  if (legacySnapshotId != null) return `legacy:${legacySnapshotId}`;
  if (runId != null) return `run:${runId}:${itemUid}`;
  return null;
}

/**
 * Normalizes a SQLite UTC timestamp string (e.g. '2026-08-24 09:20:46')
 * or ISO timestamp string into a canonical ISO string ('2026-08-24T09:20:46.000Z').
 * Ensures timestamps stored without 'Z' by SQLite are explicitly interpreted as UTC,
 * preventing local timezone offset shifts (e.g. 7-hour shift on UTC+7).
 */
function normalizeLegacyUtcTimestamp(rawTimestamp) {
  if (!rawTimestamp) return new Date().toISOString();
  if (rawTimestamp instanceof Date) return rawTimestamp.toISOString();
  try {
    let str = String(rawTimestamp).trim();
    if (!str.includes('T') && !str.endsWith('Z')) {
      str = str.replace(' ', 'T') + 'Z';
    }
    const d = new Date(str);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch (_e) {
    return new Date().toISOString();
  }
}

function createDailyHistoryOps(db) {
  const findRow = db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?');

  const insertRow = db.prepare(`
    INSERT INTO daily_packed_history (
      item_uid, platform, date, observations_json, observation_count,
      min_price, max_price, latest_price, latest_likes, latest_views, latest_sold,
      created_at, updated_at
    ) VALUES (
      @item_uid, @platform, @date, @observations_json, @observation_count,
      @price, @price, @price, @likes, @views, @sold,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);

  // §4.2: observation_count is passed explicitly (final array length), never
  // a blind `+ 1` — a replaced duplicate must not inflate the count.
  const updateRow = db.prepare(`
    UPDATE daily_packed_history SET
      observations_json = @observations_json,
      observation_count = @observation_count,
      -- LEAST/GREATEST, not MIN/MAX: SQLite has a two-argument scalar MIN()/MAX(),
      -- PostgreSQL only has MIN()/MAX() as aggregates, so the scalar form fails
      -- there with "function min(double precision, unknown) does not exist".
      min_price = LEAST(min_price, @price),
      max_price = GREATEST(max_price, @price),
      latest_price = @price,
      latest_likes = @likes,
      latest_views = @views,
      latest_sold = @sold,
      updated_at = CURRENT_TIMESTAMP
    WHERE item_uid = @item_uid AND date = @date
  `);

  const findHistoryByUid = db.prepare(`
    SELECT * FROM daily_packed_history
    WHERE item_uid = ?
    ORDER BY date DESC
    LIMIT ?
  `);

  async function appendObservation(item, timestamp = new Date(), identity = {}) {
    const { runId = null, legacySnapshotId = null } = identity || {};
    const isoStr = normalizeLegacyUtcTimestamp(timestamp);
    const dateStr = isoStr.slice(0, 10); // 'YYYY-MM-DD'
    const timeStr = isoStr.slice(11, 19); // 'HH:MM:SS'

    const price = Number(item.price || 0);
    const likes = Number(item.likes || 0);
    const comments = Number(item.comments || 0);
    const shares = Number(item.shares || 0);
    const views = Number(item.views || 0);
    const sold = Number(item.sold_count || item.soldCount || 0);
    const rating = Number(item.rating || 0);
    // Gap #3 closure (Final Gap Closure Round): `reviews` was missing from the
    // packed observation schema entirely, making per-observation history
    // parity for review counts structurally impossible. Finalized once, here,
    // before DB rebuild/cutover — not deferred to a later migration.
    const reviews = Number(item.reviews || 0);

    const observationId = buildObservationId({ runId, legacySnapshotId, itemUid: item.item_uid });

    const observation = {
      observationId,
      runId,
      time: timeStr,
      price,
      likes,
      comments,
      shares,
      views,
      sold,
      rating,
      reviews
    };

    const existing = await findRow.get(item.item_uid, dateStr);

    if (!existing) {
      const observationsArray = [observation];
      await insertRow.run({
        item_uid: item.item_uid,
        platform: item.platform,
        date: dateStr,
        observations_json: JSON.stringify(observationsArray),
        observation_count: observationsArray.length,
        price,
        likes,
        views,
        sold
      });
      return { date: dateStr, count: 1, duplicate: false };
    }

    let observationsArray = [];
    try {
      observationsArray = JSON.parse(existing.observations_json || '[]');
      if (!Array.isArray(observationsArray)) observationsArray = [];
    } catch (_e) {
      observationsArray = [];
    }

    // §4.1: idempotent by observationId identity when available:
    //  - legacy:<id> (migration backfill): replaces prior entry for the same snapshot row
    //  - run:<runId>:<itemUid> (live crawl): replaces prior entry for the same Run attempt
    // If no observationId is available, falls back to time-based matching.
    let duplicate = false;
    let existingIndex = -1;
    if (observationId != null) {
      existingIndex = observationsArray.findIndex(o => o && o.observationId === observationId);
    } else {
      existingIndex = observationsArray.findIndex(o => o && o.time === timeStr);
    }

    if (existingIndex >= 0) {
      observationsArray[existingIndex] = observation;
      duplicate = true;
    } else {
      observationsArray.push(observation);
    }

    await updateRow.run({
      item_uid: item.item_uid,
      date: dateStr,
      observations_json: JSON.stringify(observationsArray),
      observation_count: observationsArray.length,
      price,
      likes,
      views,
      sold
    });
    return { date: dateStr, count: observationsArray.length, duplicate };
  }

  async function getHistory(itemUid, limitDays = 30) {
    const rows = await findHistoryByUid.all(itemUid, limitDays);
    return rows.map(r => {
      let observations = [];
      try {
        observations = JSON.parse(r.observations_json || '[]');
      } catch (_e) {
        observations = [];
      }
      return {
        ...r,
        observations
      };
    });
  }

  return {
    appendObservation,
    getHistory,
    findRow: async (itemUid, date) => await findRow.get(itemUid, date),
    buildObservationId,
    normalizeLegacyUtcTimestamp
  };
}

module.exports = { createDailyHistoryOps, buildObservationId, normalizeLegacyUtcTimestamp };
