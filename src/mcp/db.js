'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * Resolve database path from environment variable or standard location
 * @param {string} [customPath]
 * @returns {string}
 */
function resolveDbPath(customPath) {
  if (customPath) return path.resolve(customPath);
  if (process.env.CRAWLER_DB_PATH) return path.resolve(process.env.CRAWLER_DB_PATH);
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  return path.resolve(__dirname, '..', '..', 'data', 'collector.db');
}

/**
 * Initialize Read-Only Database Connection
 * @param {Object} [options]
 * @param {string} [options.dbPath]
 * @returns {Object} DB helper instance
 */
function createReadOnlyDb(options = {}) {
  const dbPath = resolveDbPath(options.dbPath);

  if (!fs.existsSync(dbPath)) {
    const error = new Error(`[MCP DB] Database file does not exist at path: ${dbPath}. Read-only MCP startup failed.`);
    error.code = 'SQLITE_CANTOPEN';
    throw error;
  }

  // Open strictly read-only and require file to exist
  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });

  // Enforce query_only pragma to guarantee SQLite rejects all write attempts
  db.pragma('query_only = ON');

  // Verify connection by querying sqlite_master
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  const requiredTables = ['platforms', 'runs', 'snapshots'];
  const missingTables = requiredTables.filter((t) => !tables.includes(t));
  if (missingTables.length > 0) {
    db.close();
    throw new Error(`[MCP DB] Database is missing required table(s): ${missingTables.join(', ')}`);
  }

  return {
    db,
    dbPath,

    /**
     * Get platform listing with crawl statistics from successful runs
     */
    listPlatformsWithStats() {
      const sql = `
        SELECT 
          p.name AS platform,
          p.display_name,
          p.description,
          p.query_type,
          p.country_support,
          p.icon,
          p.color,
          COALESCE(stats.item_count, 0) AS item_count,
          stats.last_successful_crawl_at,
          COALESCE(stats.data_as_of, stats.last_successful_crawl_at) AS data_as_of
        FROM platforms p
        LEFT JOIN (
          SELECT 
            r.platform,
            COUNT(s.id) AS item_count,
            MAX(r.created_at) AS last_successful_crawl_at,
            MAX(r.completed_at) AS data_as_of
          FROM runs r
          LEFT JOIN snapshots s ON s.run_id = r.id AND s.status != 'dropped'
          WHERE r.status = 'done'
          GROUP BY r.platform
        ) stats ON p.name = stats.platform
        ORDER BY p.name ASC
      `;
      return db.prepare(sql).all();
    },

    /**
     * Search current items across successful runs
     * @param {Object} filterParams
     */
    searchItems(filterParams = {}) {
      const {
        keyword,
        platform,
        author,
        priceMin,
        priceMax,
        likesMin,
        commentsMin,
        sharesMin,
        viewsMin,
        country,
        collectedAtFrom,
        collectedAtTo,
        sort = 'collected_at:desc',
        limit = 50,
        cursor,
      } = filterParams;

      const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
      const conditions = [];
      const params = {};

      // Current items: latest snapshot for each item_uid from successful runs, not dropped
      conditions.push("r.status = 'done'");
      conditions.push("s.status != 'dropped'");

      if (platform && typeof platform === 'string' && platform.trim()) {
        conditions.push('s.platform = @platform');
        params.platform = platform.trim();
      }

      if (keyword && typeof keyword === 'string' && keyword.trim()) {
        const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
        for (let i = 0; i < terms.length; i++) {
          const paramName = `term_${i}`;
          conditions.push(`(LOWER(s.title) LIKE @${paramName} OR LOWER(s.author) LIKE @${paramName} OR LOWER(s.query) LIKE @${paramName})`);
          params[paramName] = `%${terms[i]}%`;
        }
      }

      if (author && typeof author === 'string' && author.trim()) {
        conditions.push('LOWER(s.author) LIKE @author');
        params.author = `%${author.trim().toLowerCase()}%`;
      }

      if (priceMin !== undefined && priceMin !== null && !isNaN(Number(priceMin))) {
        conditions.push('s.price >= @priceMin');
        params.priceMin = Number(priceMin);
      }

      if (priceMax !== undefined && priceMax !== null && !isNaN(Number(priceMax))) {
        conditions.push('s.price <= @priceMax');
        params.priceMax = Number(priceMax);
      }

      if (likesMin !== undefined && likesMin !== null && !isNaN(Number(likesMin))) {
        conditions.push('s.likes >= @likesMin');
        params.likesMin = Number(likesMin);
      }

      if (commentsMin !== undefined && commentsMin !== null && !isNaN(Number(commentsMin))) {
        conditions.push('s.comments >= @commentsMin');
        params.commentsMin = Number(commentsMin);
      }

      if (sharesMin !== undefined && sharesMin !== null && !isNaN(Number(sharesMin))) {
        conditions.push('s.shares >= @sharesMin');
        params.sharesMin = Number(sharesMin);
      }

      if (viewsMin !== undefined && viewsMin !== null && !isNaN(Number(viewsMin))) {
        conditions.push('s.views >= @viewsMin');
        params.viewsMin = Number(viewsMin);
      }

      if (country && typeof country === 'string' && country.trim()) {
        conditions.push('r.country = @country');
        params.country = country.trim();
      }

      if (collectedAtFrom && typeof collectedAtFrom === 'string' && collectedAtFrom.trim()) {
        conditions.push('s.created_at >= @collectedAtFrom');
        params.collectedAtFrom = collectedAtFrom.trim();
      }

      if (collectedAtTo && typeof collectedAtTo === 'string' && collectedAtTo.trim()) {
        conditions.push('s.created_at <= @collectedAtTo');
        params.collectedAtTo = collectedAtTo.trim();
      }

      // Cursor decoding (format: base64 JSON { id, sortVal })
      let cursorData = null;
      if (cursor && typeof cursor === 'string') {
        try {
          cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        } catch {
          cursorData = null;
        }
      }

      // Sorting configuration
      const sortMap = {
        'collected_at:desc': { order: 's.created_at DESC, s.id DESC', field: 'created_at', desc: true },
        'collected_at:asc': { order: 's.created_at ASC, s.id ASC', field: 'created_at', desc: false },
        'price:desc': { order: 's.price DESC, s.id DESC', field: 'price', desc: true },
        'price:asc': { order: 's.price ASC, s.id ASC', field: 'price', desc: false },
        'likes:desc': { order: 's.likes DESC, s.id DESC', field: 'likes', desc: true },
        'likes:asc': { order: 's.likes ASC, s.id ASC', field: 'likes', desc: false },
        'comments:desc': { order: 's.comments DESC, s.id DESC', field: 'comments', desc: true },
        'shares:desc': { order: 's.shares DESC, s.id DESC', field: 'shares', desc: true },
        'views:desc': { order: 's.views DESC, s.id DESC', field: 'views', desc: true },
        'rating:desc': { order: 's.rating DESC, s.id DESC', field: 'rating', desc: true },
        'reviews:desc': { order: 's.reviews DESC, s.id DESC', field: 'reviews', desc: true },
      };

      const selectedSort = sortMap[String(sort).toLowerCase()] || sortMap['collected_at:desc'];

      if (cursorData && cursorData.id) {
        if (selectedSort.field === 'created_at') {
          if (selectedSort.desc) {
            conditions.push('(s.created_at < @cursorVal OR (s.created_at = @cursorVal AND s.id < @cursorId))');
          } else {
            conditions.push('(s.created_at > @cursorVal OR (s.created_at = @cursorVal AND s.id > @cursorId))');
          }
          params.cursorVal = cursorData.val;
          params.cursorId = cursorData.id;
        } else {
          const col = `s.${selectedSort.field}`;
          if (selectedSort.desc) {
            conditions.push(`(${col} < @cursorVal OR (${col} = @cursorVal AND s.id < @cursorId))`);
          } else {
            conditions.push(`(${col} > @cursorVal OR (${col} = @cursorVal AND s.id > @cursorId))`);
          }
          params.cursorVal = cursorData.val;
          params.cursorId = cursorData.id;
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.fetchLimit = safeLimit + 1;

      const querySql = `
        WITH latest_snapshots AS (
          SELECT s.id, s.item_uid, s.run_id, s.platform, s.query, s.raw_data, s.title, s.url,
                 s.image, s.author, s.price, s.rating, s.reviews, s.sold_count,
                 s.likes, s.comments, s.shares, s.views, s.status, s.prev_snapshot_id, s.created_at,
                 r.completed_at AS run_completed_at, r.created_at AS run_created_at,
                 ROW_NUMBER() OVER(PARTITION BY s.item_uid ORDER BY s.id DESC) as rn
          FROM snapshots s
          JOIN runs r ON s.run_id = r.id
          WHERE r.status = 'done'
        )
        SELECT s.*, 
               first_seen.first_seen_at
        FROM latest_snapshots s
        JOIN runs r ON s.run_id = r.id
        LEFT JOIN (
          SELECT item_uid, MIN(created_at) as first_seen_at
          FROM snapshots
          GROUP BY item_uid
        ) first_seen ON s.item_uid = first_seen.item_uid
        ${whereClause} AND s.rn = 1
        ORDER BY ${selectedSort.order}
        LIMIT @fetchLimit
      `;

      const rows = db.prepare(querySql).all(params);
      let nextCursor = null;

      if (rows.length > safeLimit) {
        const lastIncluded = rows[safeLimit - 1];
        rows.pop();
        const cursorPayload = {
          id: lastIncluded.id,
          val: selectedSort.field === 'created_at' ? lastIncluded.created_at : lastIncluded[selectedSort.field],
        };
        nextCursor = Buffer.from(JSON.stringify(cursorPayload)).toString('base64');
      }

      const dataAsOf = rows.length > 0 ? rows[0].run_completed_at || rows[0].created_at : new Date().toISOString();

      return {
        rows,
        nextCursor,
        limit: safeLimit,
        dataAsOf,
      };
    },

    /**
     * Get detailed item by item_uid (returns null if dropped or not current)
     * @param {string} itemUid
     */
    getItemByUid(itemUid) {
      if (!itemUid || typeof itemUid !== 'string') return null;

      const sql = `
        SELECT s.*, 
               r.status AS run_status,
               r.created_at AS run_created_at,
               r.completed_at AS run_completed_at,
               first_s.first_seen_at
        FROM snapshots s
        JOIN runs r ON s.run_id = r.id
        LEFT JOIN (
          SELECT item_uid, MIN(created_at) as first_seen_at
          FROM snapshots
          WHERE item_uid = ?
        ) first_s ON s.item_uid = first_s.item_uid
        WHERE s.item_uid = ? AND r.status = 'done'
        ORDER BY s.id DESC
        LIMIT 1
      `;

      const row = db.prepare(sql).get(itemUid, itemUid);
      if (!row) return null;

      if (row.status === 'dropped') {
        return { isDropped: true, row };
      }

      return { isDropped: false, row };
    },

    /**
     * Get snapshot history for an item_uid
     * @param {string} itemUid
     * @param {Object} [options]
     */
    getItemHistory(itemUid, options = {}) {
      if (!itemUid || typeof itemUid !== 'string') return { rows: [], nextCursor: null };

      const { from, to, limit = 50, cursor } = options;
      const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
      const conditions = ['s.item_uid = @itemUid', "r.status = 'done'"];
      const params = { itemUid: itemUid.trim(), fetchLimit: safeLimit + 1 };

      if (from && typeof from === 'string' && from.trim()) {
        conditions.push('s.created_at >= @from');
        params.from = from.trim();
      }

      if (to && typeof to === 'string' && to.trim()) {
        conditions.push('s.created_at <= @to');
        params.to = to.trim();
      }

      if (cursor && typeof cursor === 'string') {
        try {
          const cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
          if (cursorData && cursorData.id) {
            conditions.push('(s.created_at > @cursorVal OR (s.created_at = @cursorVal AND s.id > @cursorId))');
            params.cursorVal = cursorData.val;
            params.cursorId = cursorData.id;
          }
        } catch {
          // ignore malformed cursor
        }
      }

      const sql = `
        SELECT s.*, 
               r.created_at AS run_created_at,
               r.completed_at AS run_completed_at,
               r.query AS run_query
        FROM snapshots s
        JOIN runs r ON s.run_id = r.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY s.created_at ASC, s.id ASC
        LIMIT @fetchLimit
      `;

      const rows = db.prepare(sql).all(params);
      let nextCursor = null;

      if (rows.length > safeLimit) {
        const lastIncluded = rows[safeLimit - 1];
        rows.pop();
        const cursorPayload = { id: lastIncluded.id, val: lastIncluded.created_at };
        nextCursor = Buffer.from(JSON.stringify(cursorPayload)).toString('base64');
      }

      return { rows, nextCursor };
    },

    /**
     * Aggregation & Summary for Insights
     * @param {Object} [filterParams]
     */
    getInsightsSummary(filterParams = {}) {
      const { platform, keyword, from, to } = filterParams;
      const conditions = ["r.status = 'done'"];
      const params = {};

      if (platform && typeof platform === 'string' && platform.trim()) {
        conditions.push('s.platform = @platform');
        params.platform = platform.trim();
      }

      if (keyword && typeof keyword === 'string' && keyword.trim()) {
        conditions.push('(LOWER(s.title) LIKE @kw OR LOWER(s.author) LIKE @kw OR LOWER(s.query) LIKE @kw)');
        params.kw = `%${keyword.trim().toLowerCase()}%`;
      }

      if (from && typeof from === 'string' && from.trim()) {
        conditions.push('s.created_at >= @from');
        params.from = from.trim();
      }

      if (to && typeof to === 'string' && to.trim()) {
        conditions.push('s.created_at <= @to');
        params.to = to.trim();
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const statsSql = `
        SELECT 
          COUNT(s.id) AS total_snapshots,
          COUNT(DISTINCT s.item_uid) AS unique_items_count,
          MIN(s.created_at) AS earliest_crawl,
          MAX(s.created_at) AS latest_crawl,
          
          -- Price metrics
          MIN(CASE WHEN s.price > 0 THEN s.price ELSE NULL END) AS min_price,
          MAX(s.price) AS max_price,
          AVG(CASE WHEN s.price > 0 THEN s.price ELSE NULL END) AS avg_price,
          SUM(CASE WHEN s.price IS NOT NULL AND s.price > 0 THEN 1 ELSE 0 END) AS price_known_count,
          SUM(CASE WHEN s.price IS NULL OR s.price = 0 THEN 1 ELSE 0 END) AS price_unknown_or_zero_count,
          
          -- Likes metrics
          MIN(s.likes) AS min_likes,
          MAX(s.likes) AS max_likes,
          AVG(s.likes) AS avg_likes,
          SUM(s.likes) AS total_likes,
          
          -- Comments metrics
          MIN(s.comments) AS min_comments,
          MAX(s.comments) AS max_comments,
          AVG(s.comments) AS avg_comments,
          SUM(s.comments) AS total_comments,

          -- Shares metrics
          MIN(s.shares) AS min_shares,
          MAX(s.shares) AS max_shares,
          AVG(s.shares) AS avg_shares,
          SUM(s.shares) AS total_shares,

          -- Views metrics
          MIN(s.views) AS min_views,
          MAX(s.views) AS max_views,
          AVG(s.views) AS avg_views,
          SUM(s.views) AS total_views
        FROM snapshots s
        JOIN runs r ON s.run_id = r.id
        ${whereClause}
      `;

      const stats = db.prepare(statsSql).get(params);

      const platformSql = `
        SELECT s.platform, COUNT(s.id) AS count, COUNT(DISTINCT s.item_uid) AS unique_count
        FROM snapshots s
        JOIN runs r ON s.run_id = r.id
        ${whereClause}
        GROUP BY s.platform
        ORDER BY count DESC
      `;
      const platformDistribution = db.prepare(platformSql).all(params);

      const statusSql = `
        SELECT s.status, COUNT(s.id) AS count
        FROM snapshots s
        JOIN runs r ON s.run_id = r.id
        ${whereClause}
        GROUP BY s.status
      `;
      const statusDistribution = db.prepare(statusSql).all(params);

      return {
        stats,
        platformDistribution,
        statusDistribution,
        dataAsOf: stats.latest_crawl || new Date().toISOString(),
      };
    },

    /**
     * Close database connection
     */
    close() {
      try {
        db.close();
      } catch (err) {
        // ignore if already closed
      }
    },
  };
}

module.exports = {
  createReadOnlyDb,
  resolveDbPath,
};
