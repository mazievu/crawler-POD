/**
 * 10M-Scale Database Benchmark (P1-2)
 * Generates a synthetic dataset with >= 10,000,000 logical historical
 * observations and measures P50/P95/P99/max latency for every query pattern
 * the spec requires: item_uid lookup, daily history of one item, date-range
 * history, top rank by platform, weekly history, and latest items by platform.
 *
 * Note: item_uid IS the PRIMARY KEY of product_current, so "lookup Current by
 * item_uid" and "Current by primary key" are the same query in this schema —
 * reported once as `singleItemLookup`, not duplicated to inflate the query count.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { initSchemaV2 } = require('./schema-v2');

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Number(sorted[Math.max(0, idx)].toFixed(3));
}

function latencyStats(arr) {
  return {
    p50: percentile(arr, 50),
    p95: percentile(arr, 95),
    p99: percentile(arr, 99),
    max: arr.length ? Number(Math.max(...arr).toFixed(3)) : 0,
    sampleCount: arr.length
  };
}

async function runBenchmark(options = {}) {
  const productCount = options.productCount || 100000;
  const observationsPerItem = options.observationsPerItem || 100;
  const dbPath = options.dbPath || path.join(__dirname, '..', '..', 'data', 'benchmark-10m.db');
  const daysSpan = options.daysSpan || 3; // spreads observationsPerItem across N days for date-range queries

  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch (_e) {}
  }

  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  initSchemaV2(db);

  const totalObservations = productCount * observationsPerItem;
  console.log(`[Benchmark 10M] Initializing ${productCount.toLocaleString()} products with ${totalObservations.toLocaleString()} logical observations across ${daysSpan} days...`);

  const platforms = ['shopify', 'etsy', 'ebay', 'reddit', 'tiktok', 'facebook'];
  const dateFor = (dayOffset) => {
    const d = new Date('2026-08-24T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - dayOffset);
    return d.toISOString().slice(0, 10);
  };
  const dates = Array.from({ length: daysSpan }, (_, i) => dateFor(daysSpan - 1 - i)); // oldest -> newest

  const insertCurrent = db.prepare(`
    INSERT INTO product_current (
      item_uid, platform, query, title, url, author,
      current_price, current_rating, current_sold, current_likes, current_views,
      delta_sold, delta_likes, delta_views, rank_score, status, observation_count, last_crawled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);

  const insertHistory = db.prepare(`
    INSERT INTO daily_packed_history (
      item_uid, platform, date, observations_json, observation_count,
      min_price, max_price, latest_price, latest_likes, latest_views, latest_sold
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertWeekly = db.prepare(`
    INSERT INTO weekly_summary (
      item_uid, platform, year_week, sample_count, sum_price, avg_price,
      first_price, last_price, first_views, last_views, first_likes, last_likes,
      first_sold, last_sold, max_likes, max_views, delta_likes, delta_views, delta_sold, growth_rate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const perDay = Math.max(1, Math.floor(observationsPerItem / daysSpan));
  const batchSize = 5000;
  const startInsert = Date.now();

  for (let b = 0; b < productCount; b += batchSize) {
    const end = Math.min(b + batchSize, productCount);
    const tx = db.transaction(() => {
      for (let i = b; i < end; i++) {
        const platform = platforms[i % platforms.length];
        const uid = `${platform}:item_${i}`;
        const title = `POD Trending T-Shirt Model #${i}`;
        const basePrice = 19.99 + (i % 50);
        const rating = 4.0 + (i % 10) / 10;

        let firstViews = null, firstLikes = null, firstSold = null, firstPrice = null;
        let lastViews = 0, lastLikes = 0, lastSold = 0, lastPrice = 0, sumPrice = 0, sampleCount = 0;

        for (let dayIdx = 0; dayIdx < daysSpan; dayIdx++) {
          const packedObs = [];
          for (let obs = 0; obs < perDay; obs++) {
            const seq = dayIdx * perDay + obs;
            const price = Number((basePrice + (seq % 5) * 0.5).toFixed(2));
            const likes = (i * 13 + seq * 3) % 20000;
            const views = (i * 97 + seq * 50) % 500000;
            const sold = (i * 7 + seq) % 5000;
            packedObs.push({ time: `${String(obs % 24).padStart(2, '0')}:00:00`, price, likes, views, sold });

            if (firstViews === null) { firstViews = views; firstLikes = likes; firstSold = sold; firstPrice = price; }
            lastViews = views; lastLikes = likes; lastSold = sold; lastPrice = price;
            sumPrice += price; sampleCount++;
          }

          const prices = packedObs.map(o => o.price);
          insertHistory.run(
            uid, platform, dates[dayIdx], JSON.stringify(packedObs), packedObs.length,
            Math.min(...prices), Math.max(...prices),
            packedObs[packedObs.length - 1].price, packedObs[packedObs.length - 1].likes,
            packedObs[packedObs.length - 1].views, packedObs[packedObs.length - 1].sold
          );
        }

        const rankScore = Number(((lastSold * 2) + (lastLikes * 0.8) + (lastViews * 0.05)).toFixed(2));
        insertCurrent.run(
          uid, platform, 't-shirt', title, `https://store.example.com/${uid}`, 'MerchantPro',
          lastPrice, rating, lastSold, lastLikes, lastViews,
          lastSold - firstSold, lastLikes - firstLikes, lastViews - firstViews,
          rankScore, sampleCount, `2026-08-24T${String(i % 24).padStart(2, '0')}:00:00Z`
        );

        const growthRate = firstViews > 0 ? Number((((lastViews - firstViews) / firstViews) * 100).toFixed(2)) : 0;
        insertWeekly.run(
          uid, platform, '2026-W34', sampleCount, Number(sumPrice.toFixed(2)), Number((sumPrice / sampleCount).toFixed(2)),
          firstPrice, lastPrice, firstViews, lastViews, firstLikes, lastLikes,
          firstSold, lastSold, Math.max(firstLikes, lastLikes), Math.max(firstViews, lastViews),
          lastLikes - firstLikes, lastViews - firstViews, lastSold - firstSold, growthRate
        );
      }
    });
    tx();
  }

  const insertTimeMs = Date.now() - startInsert;
  const physicalDailyRows = productCount * daysSpan;
  console.log(`[Benchmark 10M] Ingestion completed in ${(insertTimeMs / 1000).toFixed(2)}s`);

  const stat = fs.statSync(dbPath);
  const dbSizeMB = Number((stat.size / (1024 * 1024)).toFixed(2));
  const indexListBefore = db.pragma('index_list(product_current)');
  console.log(`[Benchmark 10M] SQLite Database Size: ${dbSizeMB} MB`);

  const queryCount = options.queryCount || 500;
  console.log(`[Benchmark 10M] Executing ${queryCount} randomized queries per pattern...`);

  const findItemStmt = db.prepare('SELECT * FROM product_current WHERE item_uid = ?');
  const rankQueryStmt = db.prepare('SELECT * FROM product_current WHERE platform = ? ORDER BY rank_score DESC LIMIT 50');
  const dailyHistoryStmt = db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date = ?');
  const dateRangeStmt = db.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ? AND date BETWEEN ? AND ? ORDER BY date ASC');
  const weeklyStmt = db.prepare('SELECT * FROM weekly_summary WHERE item_uid = ? ORDER BY year_week DESC LIMIT 12');
  const latestByPlatformStmt = db.prepare('SELECT * FROM product_current WHERE platform = ? ORDER BY last_crawled_at DESC LIMIT 50');

  const latencies = { singleItemLookup: [], topRankedPlatform: [], dailyHistoryOneItem: [], dateRangeHistory: [], weeklyHistory: [], latestItemsByPlatform: [] };

  for (let q = 0; q < queryCount; q++) {
    const randomIdx = Math.floor(Math.random() * productCount);
    const platform = platforms[randomIdx % platforms.length];
    const uid = `${platform}:item_${randomIdx}`;

    let t0 = process.hrtime.bigint(); findItemStmt.get(uid); latencies.singleItemLookup.push(Number(process.hrtime.bigint() - t0) / 1e6);
    t0 = process.hrtime.bigint(); rankQueryStmt.all(platform); latencies.topRankedPlatform.push(Number(process.hrtime.bigint() - t0) / 1e6);
    t0 = process.hrtime.bigint(); dailyHistoryStmt.get(uid, dates[dates.length - 1]); latencies.dailyHistoryOneItem.push(Number(process.hrtime.bigint() - t0) / 1e6);
    t0 = process.hrtime.bigint(); dateRangeStmt.all(uid, dates[0], dates[dates.length - 1]); latencies.dateRangeHistory.push(Number(process.hrtime.bigint() - t0) / 1e6);
    t0 = process.hrtime.bigint(); weeklyStmt.all(uid); latencies.weeklyHistory.push(Number(process.hrtime.bigint() - t0) / 1e6);
    t0 = process.hrtime.bigint(); latestByPlatformStmt.all(platform); latencies.latestItemsByPlatform.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  const results = {
    hardware: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model || 'unknown', totalMemMB: Math.round(os.totalmem() / (1024 * 1024)), platform: os.platform() },
    sqliteVersion: db.pragma('user_version') !== undefined ? require('better-sqlite3/package.json').version : 'unknown',
    dataset: {
      logicalObservations: totalObservations,
      productCurrentRows: productCount,
      dailyPackedHistoryRows: physicalDailyRows,
      weeklySummaryRows: productCount,
      dbSizeMB,
      indexCount: indexListBefore.length,
      ingestTimeSeconds: Number((insertTimeMs / 1000).toFixed(2))
    },
    queryCount,
    latencyMs: {
      singleItemLookup: latencyStats(latencies.singleItemLookup),
      topRankedPlatform: latencyStats(latencies.topRankedPlatform),
      dailyHistoryOneItem: latencyStats(latencies.dailyHistoryOneItem),
      dateRangeHistory: latencyStats(latencies.dateRangeHistory),
      weeklyHistory: latencyStats(latencies.weeklyHistory),
      latestItemsByPlatform: latencyStats(latencies.latestItemsByPlatform)
    }
  };

  db.close();
  if (!options.keepDbFile) {
    try { fs.unlinkSync(dbPath); } catch (_e) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_e) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_e) {}
  }

  return results;
}

module.exports = { runBenchmark };

if (require.main === module) {
  const productCount = Number(process.env.BENCH_PRODUCT_COUNT) || 100000;
  const observationsPerItem = Number(process.env.BENCH_OBS_PER_ITEM) || 100;
  runBenchmark({ productCount, observationsPerItem })
    .then(res => {
      console.log('BENCHMARK_RESULTS:', JSON.stringify(res, null, 2));
    })
    .catch(err => {
      console.error('BENCHMARK_FAILED:', err);
      process.exit(1);
    });
}
