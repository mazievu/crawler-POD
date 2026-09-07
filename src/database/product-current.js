/**
 * Product Current State Engine (Tier 1)
 * Guarantees exactly 1 row per unique item_uid, computing deltas atomically.
 */

const { defaultRanker } = require('../ranking/product-ranker');

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TOLERANCE_MS = 30 * 60 * 1000; // bots may run a few minutes late

/**
 * Finds the historical observation closest to `targetTime` within `toleranceMs`,
 * reading from Tier 2 (daily_packed_history) which is the full-fidelity source.
 * Returns null when nothing in the window qualifies — callers must NOT default
 * to 0, since 0 would be indistinguishable from "no growth happened".
 */
async function findObservationNear(dailyHistoryOps, itemUid, targetTimeMs, toleranceMs) {
  const daysNeeded = Math.ceil((Date.now() - targetTimeMs + toleranceMs) / 86400000) + 2;
  const rows = await dailyHistoryOps.getHistory(itemUid, Math.max(3, daysNeeded));

  let best = null;
  let bestDist = Infinity;
  for (const row of rows) {
    for (const obs of row.observations || []) {
      const obsTimeMs = Date.parse(`${row.date}T${obs.time}Z`);
      if (Number.isNaN(obsTimeMs)) continue;
      const dist = Math.abs(obsTimeMs - targetTimeMs);
      if (dist <= toleranceMs && dist < bestDist) {
        bestDist = dist;
        best = obs;
      }
    }
  }
  return best;
}

async function windowedDelta(dailyHistoryOps, itemUid, currentValue, currentTimeMs, windowMs, field, toleranceMs) {
  const reference = await findObservationNear(dailyHistoryOps, itemUid, currentTimeMs - windowMs, toleranceMs);
  if (!reference) return null; // No qualifying historical point -> unknown, not 0.
  const refValue = Number(reference[field] || 0);
  return currentValue - refValue;
}

function createProductCurrentOps(db, dailyHistoryOps, options = {}) {
  const toleranceMs = options.toleranceMs || DEFAULT_TOLERANCE_MS;
  const findByUid = db.prepare('SELECT * FROM product_current WHERE item_uid = ?');

  const insertCurrent = db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, image, author,
      current_price, current_rating, current_reviews, current_sold,
      current_likes, current_comments, current_shares, current_views,
      delta_3h_likes, delta_3h_views, delta_24h_likes, delta_24h_views, delta_24h_sold,
      rank_score, status, last_run_id, observation_count,
      first_seen_at, last_seen_at, last_crawled_at
    ) VALUES (
      @item_uid, @platform, @query, @title, @url, @image, @author,
      @current_price, @current_rating, @current_reviews, @current_sold,
      @current_likes, @current_comments, @current_shares, @current_views,
      NULL, NULL, NULL, NULL, NULL,
      @rank_score, 'new', @last_run_id, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);

  const updateCurrent = db.prepare(`
    UPDATE product_current SET
      title = @title,
      url = @url,
      image = CASE WHEN @image != '' THEN @image ELSE image END,
      author = @author,

      prev_price = current_price,
      prev_rating = current_rating,
      prev_likes = current_likes,
      prev_comments = current_comments,
      prev_shares = current_shares,
      prev_views = current_views,
      prev_sold = current_sold,
      prev_reviews = current_reviews,

      current_price = @current_price,
      current_rating = @current_rating,
      current_reviews = @current_reviews,
      current_sold = @current_sold,
      current_likes = @current_likes,
      current_comments = @current_comments,
      current_shares = @current_shares,
      current_views = @current_views,

      delta_price = @delta_price,
      delta_rating = @delta_rating,
      delta_likes = @delta_likes,
      delta_comments = @delta_comments,
      delta_shares = @delta_shares,
      delta_views = @delta_views,
      delta_sold = @delta_sold,
      delta_reviews = @delta_reviews,

      delta_3h_likes = @delta_3h_likes,
      delta_3h_views = @delta_3h_views,
      delta_24h_likes = @delta_24h_likes,
      delta_24h_views = @delta_24h_views,
      delta_24h_sold = @delta_24h_sold,

      rank_score = @rank_score,
      status = 'active',
      last_run_id = @last_run_id,
      observation_count = observation_count + 1,
      last_seen_at = CURRENT_TIMESTAMP,
      last_crawled_at = CURRENT_TIMESTAMP
    WHERE item_uid = @item_uid
  `);

  const listCurrent = db.prepare(`
    SELECT * FROM product_current
    WHERE (@platform::text IS NULL OR platform = @platform)
      AND (@search::text IS NULL OR title LIKE '%' || @search || '%' OR query LIKE '%' || @search || '%')
    ORDER BY rank_score DESC, last_crawled_at DESC
    LIMIT @limit
  `);

  // upsertItem is called BEFORE dailyHistoryOps.appendObservation for the same
  // crawl (see database.js), so daily_packed_history at this point only contains
  // strictly-past observations — the windowed lookups below can never "see" the
  // current observation and double-count it.
  async function upsertItem(item, runId = null, timestamp = new Date()) {
    const existing = await findByUid.get(item.item_uid);
    const price = Number(item.price || 0);
    const rating = Number(item.rating || 0);
    const reviews = Number(item.reviews || 0);
    const sold = Number(item.sold_count || item.soldCount || 0);
    const likes = Number(item.likes || 0);
    const comments = Number(item.comments || 0);
    const shares = Number(item.shares || 0);
    const views = Number(item.views || 0);
    const nowMs = new Date(timestamp).getTime();

    if (!existing) {
      const rankScore = defaultRanker.calculateRankScore({
        delta_sold: 0,
        delta_likes: 0,
        current_rating: rating
      });

      await insertCurrent.run({
        item_uid: item.item_uid,
        platform: item.platform,
        query: item.query || '',
        title: item.title || '',
        url: item.url || '',
        image: item.image || '',
        author: item.author || '',
        current_price: price,
        current_rating: rating,
        current_reviews: reviews,
        current_sold: sold,
        current_likes: likes,
        current_comments: comments,
        current_shares: shares,
        current_views: views,
        rank_score: rankScore,
        last_run_id: runId
      });

      return { isNew: true, itemUid: item.item_uid, rankScore };
    } else {
      const delta_price = Number((price - existing.current_price).toFixed(2));
      const delta_rating = Number((rating - (existing.current_rating || 0)).toFixed(2));
      const delta_likes = likes - existing.current_likes;
      const delta_comments = comments - existing.current_comments;
      const delta_shares = shares - existing.current_shares;
      const delta_views = views - existing.current_views;
      const delta_sold = sold - existing.current_sold;
      const delta_reviews = reviews - existing.current_reviews;

      const delta_3h_likes = await windowedDelta(dailyHistoryOps, item.item_uid, likes, nowMs, THREE_HOURS_MS, 'likes', toleranceMs);
      const delta_3h_views = await windowedDelta(dailyHistoryOps, item.item_uid, views, nowMs, THREE_HOURS_MS, 'views', toleranceMs);
      const delta_24h_likes = await windowedDelta(dailyHistoryOps, item.item_uid, likes, nowMs, TWENTY_FOUR_HOURS_MS, 'likes', toleranceMs);
      const delta_24h_views = await windowedDelta(dailyHistoryOps, item.item_uid, views, nowMs, TWENTY_FOUR_HOURS_MS, 'views', toleranceMs);
      const delta_24h_sold = await windowedDelta(dailyHistoryOps, item.item_uid, sold, nowMs, TWENTY_FOUR_HOURS_MS, 'sold', toleranceMs);

      const rankScore = defaultRanker.calculateRankScore({
        delta_sold,
        delta_likes,
        delta_comments,
        delta_shares,
        delta_views,
        current_rating: rating
      });

      await updateCurrent.run({
        item_uid: item.item_uid,
        title: item.title || existing.title,
        url: item.url || existing.url,
        image: item.image || existing.image,
        author: item.author || existing.author,
        current_price: price,
        current_rating: rating,
        current_reviews: reviews,
        current_sold: sold,
        current_likes: likes,
        current_comments: comments,
        current_shares: shares,
        current_views: views,
        delta_price,
        delta_rating,
        delta_likes,
        delta_comments,
        delta_shares,
        delta_views,
        delta_sold,
        delta_reviews,
        delta_3h_likes,
        delta_3h_views,
        delta_24h_likes,
        delta_24h_views,
        delta_24h_sold,
        rank_score: rankScore,
        last_run_id: runId
      });

      return {
        isNew: false,
        itemUid: item.item_uid,
        rankScore,
        deltas: { delta_sold, delta_likes, delta_price, delta_rating, delta_reviews, delta_3h_likes, delta_3h_views, delta_24h_likes, delta_24h_views, delta_24h_sold }
      };
    }
  }

  return {
    upsertItem,
    findByUid: async (uid) => await findByUid.get(uid),
    listCurrent: async ({ platform = null, search = null, limit = 100 } = {}) => {
      return await listCurrent.all({ platform, search, limit });
    }
  };
}

module.exports = { createProductCurrentOps, windowedDelta, findObservationNear };
