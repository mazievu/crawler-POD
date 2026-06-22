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
const { getFilterConfig, getDefaultFilters, getFiltersForUI, POSTS_CARD_SCHEMA, ADS_CARD_SCHEMA } = require('./scripts/toidispy-filters');

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

    // Start Apify actor async
    startRunAsync(run.id, platform, query, maxItems, country).catch(console.error);
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
app.post('/api/toidispy/import', (req, res) => {
  try {
    const { query, items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });

    // Create a run
    const run = db.createRun({ platform: 'toidispy', query: query || 'search', maxItems: items.length });

    // Convert toidispy format to raw_data
    const rawItems = items.map((item) => ({
      title: item.author || 'Unknown',
      author: item.author || '',
      domain: item.domain || '',
      image: item.imageUrl || '',
      url: item.domain ? `https://${item.domain}` : '',
      likes: item.reactions || 0,
      comments: item.comments || 0,
      shares: item.shares || 0,
      isAd: item.isAd || false,
      timeAgo: item.time || '',
      platform: 'facebook',
    }));

    const result = db.insertSnapshots(run.id, 'toidispy', query || 'search', rawItems);
    db.updateRun(run.id, { status: 'done', ...result });

    res.json({ runId: run.id, count: items.length, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toidispy — Run CDP with filters from UI
app.post('/api/toidispy/run', async (req, res) => {
  try {
    const { keyword, section, filters, maxScrolls } = req.body;
    if (!keyword?.trim()) return res.status(400).json({ error: 'keyword is required' });

    // Create a run record
    const run = db.createRun({
      platform: 'toidispy',
      query: keyword,
      maxItems: 100,
    });

    // Build filter args for CDP script
    const filterArgs = JSON.stringify(filters || {});
    const scriptPath = require('path').join(__dirname, 'scripts', 'toidispy-cdp.js');
    const { spawn } = require('child_process');

    const child = spawn('node', [scriptPath, keyword, section || 'posts', filterArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        const match = stdout.match(/Scraped (\d+) items/);
        const count = match ? parseInt(match[1]) : 0;
        db.updateRun(run.id, { status: 'done', itemsCount: count });
        console.log(`Toidispy run ${run.id}: ${count} items scraped`);
      } else {
        db.updateRun(run.id, { status: 'failed', errorMessage: stderr || 'CDP script failed' });
        console.error(`Toidispy run ${run.id} failed:`, stderr);
      }
    });

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

async function startRunAsync(runId, platform, query, maxItems, country) {
  db.updateRun(runId, { status: 'running' });

  try {
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
