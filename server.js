/**
 * Apify Collector — Express Server
 * Tracks ads over time via snapshot comparison.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./src/database');
const { getPlatform } = require('./src/platform-config');
const { startActor, getRunStatus, fetchDatasetItems } = require('./src/apify-client');
const { getDefaultFilters, getFiltersForUI, POSTS_CARD_SCHEMA, ADS_CARD_SCHEMA } = require('./scripts/toidispy-filters');
const { ToidispyAutomation } = require('./scripts/toidispy-cdp');
const pinterestScraper = require('./src/scrapers/pinterest');
const redditScraper = require('./src/scrapers/reddit');
const shopifyScraper = require('./src/scrapers/shopify');
const etsyScraper = require('./src/scrapers/etsy');
const ebayScraper = require('./src/scrapers/ebay');
const { scrapeIndexedPlatform } = require('./src/scrapers/indexed-search');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Routes ====================

app.get('/api/platforms', (req, res) => {
  try { res.json(db.getAllPlatforms()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Runs
app.get('/api/runs', (req, res) => {
  try { res.json(db.getAllRuns(100)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/runs/:id', (req, res) => {
  try {
    const run = db.getRunById(parseInt(req.params.id, 10));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    run.snapshots = db.getSnapshotsByRunId(run.id);
    res.json(run);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/runs', async (req, res) => {
  try {
    const { platform, query, options } = req.body;
    if (!platform || !query) return res.status(400).json({ error: 'Platform and query are required' });
    const config = getPlatform(platform);
    if (!config) return res.status(400).json({ error: `Unknown platform: ${platform}` });

    const maxItems = options?.maxItems || 20;
    const country = options?.country || null;
    const run = db.createRun({ platform, query, maxItems, country });

    startRunAsync(run.id, platform, query, { ...options, maxItems, country }).catch(console.error);
    res.status(201).json(run);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/runs/:id', (req, res) => {
  try {
    const run = db.getRunById(parseInt(req.params.id, 10));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    db.deleteRun(run.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Items (latest snapshots)
app.get('/api/items', (req, res) => {
  try {
    const snapshots = db.getLatestSnapshots();
    // Add growth data
    const items = snapshots.map((s) => {
      let growth = { likes: 0, comments: 0, shares: 0, views: 0 };
      if (s.prev_snapshot_id) {
        const prev = db.getSnapshotHistory(s.item_uid);
        if (prev.length >= 2) {
          const older = prev[prev.length - 2];
          growth = {
            likes: s.likes - older.likes,
            comments: s.comments - older.comments,
            shares: s.shares - older.shares,
            views: s.views - older.views,
          };
        }
      }
      return { ...s, growth };
    });
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Item history (timeline)
app.get('/api/items/:uid/history', (req, res) => {
  try {
    const history = db.getSnapshotHistory(decodeURIComponent(req.params.uid));
    res.json(history);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stats
app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getStats();
    const runStats = db.getRunStats();
    res.json({ ...stats, platforms: runStats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toidispy import — save scraped items directly
function normalizeToidispyItems(items, section = 'posts') {
  return items.map((item) => ({
    title: item.pageName || item.author || 'Unknown',
    author: item.pageName || item.author || '',
    domain: item.domain || '',
    image: item.imageUrl || '',
    url: item.domain ? `https://${item.domain}` : '',
    likes: section === 'ads' ? item.adCount || 0 : item.reactions || 0,
    comments: item.comments || 0,
    shares: item.shares || 0,
    isAd: item.isAd || section === 'ads',
    timeAgo: item.timeAgo || item.time || '',
    pageId: item.pageId || '',
    adId: item.adId || '',
    pixelId: item.pixelId || '',
    gtmId: item.gtmId || '',
    googleAdsId: item.googleAdsId || '',
    platform: 'facebook',
  }));
}

async function runToidispyAsync(runId, query, options = {}) {
  const section = options.section || 'posts';
  const auto = new ToidispyAutomation();

  try {
    const connected = await auto.connect();
    if (!connected) {
      throw new Error('Cannot connect to CDP. Run `npm run start:cdp` and log in to Toidispy.');
    }

    const result = await auto.run(query, {
      section,
      filters: options.filters || {},
      maxScrolls: options.maxScrolls || 3,
      saveToDb: false,
    });
    const rawItems = normalizeToidispyItems(result.items, section);
    const counts = db.insertSnapshots(runId, 'toidispy', query, rawItems);
    db.updateRun(runId, { status: 'done', itemsCount: rawItems.length, ...counts });
    console.log(`Toidispy run ${runId}: ${rawItems.length} items scraped`);
  } catch (err) {
    db.updateRun(runId, { status: 'failed', errorMessage: err.message });
  } finally {
    await auto.close();
  }
}

async function runFreeFirstAsync(runId, platform, query, options = {}) {
  const maxItems = options.maxItems || 20;
  const localScrapers = {
    pinterest: pinterestScraper.scrape,
    reddit: redditScraper.scrape,
    shopify: shopifyScraper.scrape,
    etsy: etsyScraper.scrape,
    ebay: ebayScraper.scrape,
  };
  const indexedPlatforms = new Set(['amazon', 'facebook_posts', 'twitter', 'instagram', 'tiktok_shop']);
  const scraper = localScrapers[platform] || (indexedPlatforms.has(platform) ? scrapeIndexedPlatform : null);

  if (!scraper) return false;

  try {
    const result = localScrapers[platform]
      ? await scraper(query, { limit: maxItems, maxItems })
      : await scraper(platform, query, { limit: maxItems });
    const items = result.items || result.results || [];
    if (!items.length) throw new Error('EMPTY_RESULT: no items returned');
    const limitedItems = items.slice(0, maxItems);
    const counts = db.insertSnapshots(runId, platform, query, limitedItems);
    db.updateRun(runId, { status: 'done', itemsCount: limitedItems.length, ...counts });
    console.log(`Run ${runId}: ${limitedItems.length} items via free-first ${platform}`);
    return true;
  } catch (err) {
    console.warn(`[free-first] ${platform} failed, falling back to Apify: ${err.message}`);
    return false;
  }
}

app.post('/api/toidispy/import', (req, res) => {
  try {
    const { query, items, section } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });

    // Create a run
    const run = db.createRun({ platform: 'toidispy', query: query || 'search', maxItems: items.length });

    const rawItems = normalizeToidispyItems(items, section || 'posts');

    const result = db.insertSnapshots(run.id, 'toidispy', query || 'search', rawItems);
    db.updateRun(run.id, { status: 'done', ...result });

    res.json({ runId: run.id, count: items.length, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toidispy — Run CDP with filters from UI
app.post('/api/toidispy/run', async (req, res) => {
  try {
    const { keyword, section, filters } = req.body;
    if (!keyword?.trim()) return res.status(400).json({ error: 'keyword is required' });

    // Create a run record
    const run = db.createRun({
      platform: 'toidispy',
      query: keyword,
      maxItems: 100,
    });

    db.updateRun(run.id, { status: 'running' });
    runToidispyAsync(run.id, keyword, { section, filters }).catch(console.error);

    // Return immediately — client polls /api/runs/:id for status
    res.status(202).json({ runId: run.id, status: 'running', keyword, section, filters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toidispy filter config
app.get('/api/toidispy/filters', (req, res) => {
  try {
    const section = req.query.section || 'posts';
    res.json({
      filters: getFiltersForUI(section),
      defaults: getDefaultFilters(section),
      cardSchema: section === 'ads' ? ADS_CARD_SCHEMA : POSTS_CARD_SCHEMA,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export
app.get('/api/export/:runId', (req, res) => {
  try {
    const run = db.getRunById(parseInt(req.params.runId, 10));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const snapshots = db.getSnapshotsByRunId(run.id);
    const filename = `${run.platform}_${run.query.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({ run, items: snapshots.map((s) => ({ title: s.title, url: s.url, author: s.author, price: s.price, likes: s.likes, comments: s.comments, shares: s.shares, views: s.views, status: s.status })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== Apify Integration ====================

async function startRunAsync(runId, platform, query, options = {}) {
  db.updateRun(runId, { status: 'running' });

  try {
    if (platform === 'toidispy') {
      await runToidispyAsync(runId, query, options);
      return;
    }

    const maxItems = options.maxItems || 20;
    const country = options.country || null;
    if (await runFreeFirstAsync(runId, platform, query, options)) return;

    const { runId: apifyRunId, datasetId } = await startActor(platform, { query, maxItems, country });
    db.updateRun(runId, { apifyRunId, apifyDatasetId: datasetId });

    let attempts = 0;
    const maxAttempts = 120;

    const poll = setInterval(async () => {
      attempts++;
      try {
        const status = await getRunStatus(apifyRunId);
        if (status === 'SUCCEEDED') {
          clearInterval(poll);
          const items = await fetchDatasetItems(datasetId, maxItems);
          const result = db.insertSnapshots(runId, platform, query, items);
          db.updateRun(runId, { status: 'done', ...result });
          console.log(`Run ${runId}: ${items.length} items (${result.newItems} new, ${result.activeItems} active, ${result.droppedItems} dropped)`);
        } else if (status === 'FAILED' || status === 'ABORTED') {
          clearInterval(poll);
          db.updateRun(runId, { status: 'failed', errorMessage: `Apify run ${status.toLowerCase()}` });
        } else if (attempts >= maxAttempts) {
          clearInterval(poll);
          db.updateRun(runId, { status: 'failed', errorMessage: 'Timeout' });
        }
      } catch (err) { console.error(`Poll error run ${runId}:`, err.message); }
    }, 3000);
  } catch (err) {
    db.updateRun(runId, { status: 'failed', errorMessage: err.message });
  }
}

// ==================== Global Error Handler ====================

process.on('uncaughtException', (err) => console.error('[FATAL]', err));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

// ==================== Start ====================

app.listen(PORT, () => {
  console.log(`Apify Collector running at http://localhost:${PORT}`);
  if (!process.env.APIFY_TOKEN) console.warn('⚠️  APIFY_TOKEN not set');
});
