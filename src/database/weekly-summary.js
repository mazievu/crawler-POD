/**
 * Weekly Summary Engine (Tier 3)
 * Aggregates multi-week metrics for macro trend discovery and growth curves.
 * This is an analytics accelerator ONLY — Tier 2 (daily_packed_history) remains
 * the full-fidelity historical source and is never modified or reduced here.
 */

function getYearWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function createWeeklySummaryOps(db) {
  const findWeekly = db.prepare('SELECT * FROM weekly_summary WHERE item_uid = ? AND year_week = ?');

  const insertWeekly = db.prepare(`
    INSERT INTO weekly_summary (
      item_uid, platform, year_week,
      sample_count, sum_price, avg_price,
      first_price, last_price, first_views, last_views, first_likes, last_likes,
      first_sold, last_sold, first_comments, last_comments, first_shares, last_shares,
      max_likes, max_views, delta_likes, delta_views, delta_sold, growth_rate,
      created_at, updated_at
    ) VALUES (
      @item_uid, @platform, @year_week,
      1, @price, @price,
      @price, @price, @views, @views, @likes, @likes,
      @sold, @sold, @comments, @comments, @shares, @shares,
      @likes, @views, 0, 0, 0, 0,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);

  // avg_price = sum/count computed correctly (not a running (old+new)/2 average).
  // delta_* = last - first over the whole week, not "new - existing max" like
  // Fix Round 1's version. growth_rate is 0 (not divide-by-zero) when there is
  // no first_views baseline yet.
  const updateWeeklyStmt = db.prepare(`
    UPDATE weekly_summary SET
      sample_count = sample_count + 1,
      sum_price = sum_price + @price,
      avg_price = (sum_price + @price) / (sample_count + 1),
      last_price = @price,
      last_views = @views,
      last_likes = @likes,
      last_sold = @sold,
      last_comments = @comments,
      last_shares = @shares,
      max_likes = MAX(max_likes, @likes),
      max_views = MAX(max_views, @views),
      delta_likes = @likes - first_likes,
      delta_views = @views - first_views,
      delta_sold = @sold - first_sold,
      growth_rate = CASE WHEN first_views > 0 THEN ROUND((CAST(@views - first_views AS REAL) / first_views) * 100, 2) ELSE 0 END,
      updated_at = CURRENT_TIMESTAMP
    WHERE item_uid = @item_uid AND year_week = @year_week
  `);

  const listWeeklyByUid = db.prepare(`
    SELECT * FROM weekly_summary
    WHERE item_uid = ?
    ORDER BY year_week DESC
    LIMIT ?
  `);

  function updateWeekly(item, timestamp = new Date()) {
    const yearWeek = getYearWeek(new Date(timestamp));
    const price = Number(item.price || 0);
    const likes = Number(item.likes || 0);
    const comments = Number(item.comments || 0);
    const shares = Number(item.shares || 0);
    const views = Number(item.views || 0);
    const sold = Number(item.sold_count || item.soldCount || 0);

    const existing = findWeekly.get(item.item_uid, yearWeek);

    if (!existing) {
      insertWeekly.run({
        item_uid: item.item_uid,
        platform: item.platform,
        year_week: yearWeek,
        price, likes, comments, shares, views, sold
      });
      return { yearWeek, isNew: true };
    } else {
      updateWeeklyStmt.run({
        item_uid: item.item_uid,
        year_week: yearWeek,
        price, likes, comments, shares, views, sold
      });
      return { yearWeek, isNew: false };
    }
  }

  function getWeekly(itemUid, limitWeeks = 12) {
    return listWeeklyByUid.all(itemUid, limitWeeks);
  }

  return {
    updateWeekly,
    getWeekly,
    getYearWeek
  };
}

/**
 * Rebuilds every weekly_summary row from Tier 2 (daily_packed_history), which
 * is unaffected by the P0-5 schema/formula fix and remains the source of truth.
 * Safe to run multiple times (idempotent: wipes and rebuilds weekly_summary only,
 * never touches product_current or daily_packed_history).
 */
function recomputeWeeklySummaryFromHistory(db) {
  const dailyRows = db.prepare('SELECT item_uid, platform, date, observations_json FROM daily_packed_history ORDER BY item_uid, date ASC').all();
  const weeklyOps = createWeeklySummaryOps(db);

  const tx = db.transaction(() => {
    db.exec('DELETE FROM weekly_summary');
    for (const row of dailyRows) {
      let observations = [];
      try { observations = JSON.parse(row.observations_json || '[]'); } catch (_e) { observations = []; }
      for (const obs of observations) {
        const timestamp = `${row.date}T${obs.time}Z`;
        weeklyOps.updateWeekly({
          item_uid: row.item_uid,
          platform: row.platform,
          price: obs.price,
          likes: obs.likes,
          comments: obs.comments,
          shares: obs.shares,
          views: obs.views,
          sold_count: obs.sold
        }, timestamp);
      }
    }
  });
  tx();

  return { weeksRebuilt: db.prepare('SELECT COUNT(*) c FROM weekly_summary').get().c };
}

module.exports = { createWeeklySummaryOps, getYearWeek, recomputeWeeklySummaryFromHistory };
