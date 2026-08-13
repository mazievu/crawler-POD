/**
 * Apify Collector — Express Server
 * Tracks ads over time via snapshot comparison.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./src/database');
const { scrapeWithRetry } = require('./anti-bot/scraper-factory');
const { getDefaultFilters, getFiltersForUI, POSTS_CARD_SCHEMA, ADS_CARD_SCHEMA } = require('./scripts/toidispy-filters');
const { runDoctor } = require('./src/doctor');
const { executeRun, router } = require('./src/runs.service');
const { getPlatformQueryField, buildCollectionOptions } = require('./src/collection-inputs');
const { createMarketplaceLoginManager } = require('./src/marketplaces/login-manager');
const { createCaptureJobQueue } = require('./src/marketplaces/capture-jobs');
const { createMarketplaceCaptureScheduler } = require('./src/marketplaces/capture-scheduler');
const { discoverMarketplaceListingsViaEverbeeHost } = require('./src/marketplaces/everbee-host-client');

const app = express();
const PORT = process.env.PORT || 3000;
const LOCAL_SCRAPER_PLATFORMS = new Set(['shopify', 'reddit', 'pinterest', 'etsy', 'ebay']);
const marketplaceLoginManager = createMarketplaceLoginManager();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Routes ====================

app.get('/api/platforms', (req, res) => {
  const { getPlatformCompatibilityList } = require('./src/channels/registry');
  try { res.json(getPlatformCompatibilityList()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Marketplace browser sessions. Only opaque account metadata is ever returned;
// the encrypted browser storage state stays server-side for captures.
app.get('/api/marketplace-accounts', (req, res) => {
  try {
    if (!req.query.platform) return res.status(400).json({ error: 'platform is required' });
    res.json(db.getMarketplaceAccounts(req.query.platform));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-accounts', (req, res) => {
  try {
    const account = db.createMarketplaceAccount(req.body || {});
    res.status(201).json(account);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/marketplace-accounts/:id/proxy', (req, res) => {
  try {
    const account = db.assignMarketplaceAccountProxy(Number(req.params.id), req.body?.proxyId ?? null);
    if (!account) return res.status(404).json({ error: 'Marketplace account not found' });
    res.json(account);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/marketplace-accounts/:id', (req, res) => {
  try {
    const deleted = db.deleteMarketplaceAccount(Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Marketplace account not found' });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// SOCKS5 proxy profiles are encrypted at rest. List responses deliberately
// omit credentials, and a proxy is only resolved when an account captures.
app.get('/api/marketplace-proxies', (req, res) => {
  try { res.json(db.getMarketplaceProxies()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-proxies', (req, res) => {
  try { res.status(201).json(db.createMarketplaceProxy(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/marketplace-proxies/:id', (req, res) => {
  try {
    const deleted = db.deleteMarketplaceProxy(Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Proxy profile not found' });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Browser login runs only after the local user explicitly starts it. The UI
// never receives the resulting cookies; confirmation saves them encrypted.
app.post('/api/marketplace-login-sessions', async (req, res) => {
  try {
    res.status(201).json(await marketplaceLoginManager.start({ platform: req.body?.platform }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-login-sessions/:id/complete', async (req, res) => {
  try {
    const result = await marketplaceLoginManager.complete(req.params.id);
    const account = db.createMarketplaceAccount({
      platform: result.platform,
      label: req.body?.label,
      storageState: result.storageState,
    });
    res.status(201).json(account);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/marketplace-login-sessions/:id', async (req, res) => {
  try {
    const cancelled = await marketplaceLoginManager.cancel(req.params.id);
    if (!cancelled) return res.status(404).json({ error: 'Login session not found or has expired' });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/html-captures', (req, res) => {
  try {
    res.json(db.getMarketplaceCaptures({ platform: req.query.platform || null, limit: req.query.limit }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/html-captures/:id', (req, res) => {
  try {
    const capture = db.getMarketplaceCapture(Number(req.params.id));
    if (!capture) return res.status(404).json({ error: 'HTML capture not found' });
    res.json(capture);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

async function runMarketplaceCapture(payload) {
  const { platform, url, accountId, variantMode, maxVariants } = payload || {};
  let normalizedAccountId = null;
  if (accountId) {
    const account = db.getMarketplaceAccounts(platform).find((candidate) => candidate.id === Number(accountId));
    if (!account) {
      const error = new Error('Marketplace account not found for this platform');
      error.status = 404;
      throw error;
    }
    normalizedAccountId = Number(accountId);
  }
  const cachedCapture = db.getCachedMarketplaceCapture({ platform, url, accountId: normalizedAccountId, variantMode, maxVariants });
  if (cachedCapture) {
    return {
      capture: cachedCapture,
      metrics: cachedCapture.parsedData.metrics || {},
      variants: cachedCapture.parsedData.variants || [],
      captureStatus: cachedCapture.parsedData.capture || { status: 'ok' },
      cached: true,
    };
  }

  let storageState = null;
  let proxy = null;
  if (normalizedAccountId) {
    const account = db.getMarketplaceAccounts(platform).find((candidate) => candidate.id === normalizedAccountId);
    storageState = JSON.parse(db.getMarketplaceStorageState(account.id));
    proxy = db.getMarketplaceProxyUrl(account.proxy_id);
  }
  const { captureMarketplaceHtml } = require('./src/marketplaces/html-capture');
  const result = await captureMarketplaceHtml({ platform, url, storageState, accountId: normalizedAccountId, proxy, variantMode, maxVariants });
  if (result.capture?.status !== 'ok') {
    return { capture: null, metrics: result.metrics, variants: result.variants || [], captureStatus: result.capture, cached: false };
  }
  const capture = db.createMarketplaceCapture({
    platform,
    accountId: normalizedAccountId,
    url,
    html: result.html,
    parsedData: { metrics: result.metrics, capture: result.capture, variants: result.variants || [] },
    variantMode,
    maxVariants,
  });
  return { capture, metrics: result.metrics, variants: result.variants || [], captureStatus: result.capture, cached: false };
}

async function discoverScheduledEtsyListings(keyword, { limit, accountId } = {}) {
  const normalizedAccountId = accountId == null ? null : Number(accountId);
  let storageState = null;
  let proxy = null;
  if (normalizedAccountId != null) {
    const account = db.getMarketplaceAccounts('etsy').find((candidate) => candidate.id === normalizedAccountId);
    if (account) {
      storageState = JSON.parse(db.getMarketplaceStorageState(account.id));
      proxy = db.getMarketplaceProxyUrl(account.proxy_id);
    }
  }

  // Tier 1: Try Everbee Host if configured
  if (process.env.EVERBEE_HOST_EXECUTOR_URL) {
    try {
      const everbeeResult = await discoverMarketplaceListingsViaEverbeeHost({
        platform: 'etsy', keyword, accountId: normalizedAccountId, storageState, proxy, limit,
      });
      if (everbeeResult && Array.isArray(everbeeResult.items) && everbeeResult.items.length > 0) {
        return everbeeResult;
      }
    } catch (err) {
      console.warn('[Scheduled Discovery] Everbee host attempt failed, falling back:', err.message);
    }
  }

  // Tier 2: Multi-Tier Resilient Scraper (SearXNG + DB Snapshot matching + Resilient card generator)
  const { scrape: etsyScrape } = require('./src/scrapers/etsy');
  const result = await etsyScrape(keyword, { maxItems: limit || 30 });
  const rawItems = Array.isArray(result?.items) ? result.items : (Array.isArray(result) ? result : []);
  return { items: rawItems.map(item => ({ url: item.url, title: item.title })) };
}

const marketplaceCaptureJobs = createCaptureJobQueue({ runCapture: runMarketplaceCapture });
const marketplaceCaptureScheduler = createMarketplaceCaptureScheduler({
  discover: discoverScheduledEtsyListings,
  capture: runMarketplaceCapture,
  markComplete: (id, summary) => db.completeMarketplaceCaptureSchedule(id, summary),
});
let marketplaceScheduleTickActive = false;

async function runDueMarketplaceSchedules() {
  if (marketplaceScheduleTickActive) return;
  marketplaceScheduleTickActive = true;
  try {
    const dueSchedules = db.getDueMarketplaceCaptureSchedules();
    for (const schedule of dueSchedules) {
      try {
        await marketplaceCaptureScheduler.run(schedule);
      } catch (schErr) {
        console.error(`[Marketplace schedules] Error running schedule #${schedule.id} (${schedule.keyword}):`, schErr.message);
      }
    }
  } catch (error) {
    console.error('[Marketplace schedules] Global tick error:', error.message);
  } finally {
    marketplaceScheduleTickActive = false;
  }
}
setInterval(() => { void runDueMarketplaceSchedules(); }, 60 * 1000).unref();

app.get('/api/marketplace-capture-schedules', (req, res) => {
  try { res.json(db.getMarketplaceCaptureSchedules()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/marketplace-capture-schedules', (req, res) => {
  try { res.status(201).json(db.createMarketplaceCaptureSchedule(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/marketplace-capture-schedules/:id/runs', (req, res) => {
  try { res.json(db.getMarketplaceCaptureScheduleRuns(req.params.id, req.query.limit)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/marketplace-capture-schedules/:id', (req, res) => {
  try {
    if (!db.deleteMarketplaceCaptureSchedule(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/html-capture-jobs/:id', (req, res) => {
  const job = marketplaceCaptureJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Capture job not found' });
  res.json(job);
});

app.post('/api/html-captures', async (req, res) => {
  const payload = req.body || {};
  if (payload.platform === 'etsy' && payload.variantMode === 'all') {
    return res.status(202).json({ job: marketplaceCaptureJobs.enqueue(payload) });
  }
  try {
    res.status(201).json(await runMarketplaceCapture(payload));
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// User Journey Automated Capture & Parsing Endpoint
app.post('/api/user-journey/run', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { runUserJourney } = require('./src/journey/user-journey-runner');
    const summary = await runUserJourney(req.body || {});
    res.status(200).json(summary);
  } catch (err) {
    res.status(500).json({ status: 'FAILED', error: err.message });
  }
});

// Doctor
app.get('/api/doctor', async (req, res) => {
  try {
    const isJson = req.query.json === '1' || req.query.json === 'true';
    const options = { platform: req.query.platform };
    const report = await runDoctor(options);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const queryField = getPlatformQueryField(platform);
    if (!platform || !query) return res.status(400).json({ error: `${queryField.label} is required` });
    const config = require('./src/platform-config').getPlatform(platform);
    if (!config) return res.status(400).json({ error: `Unknown platform: ${platform}` });
    const normalizedOptions = buildCollectionOptions(platform, options || {});

    // Pre-flight check
    try {
      await router.selectBackend(platform, normalizedOptions);
    } catch (err) {
      if (err.name === 'NoHealthyBackendError') {
        return res.status(400).json({
          error: 'NO_HEALTHY_BACKEND',
          platform: err.platform,
          message: err.message,
          diagnostic: err.diagnostic
        });
      }
      throw err;
    }

    const maxItems = normalizedOptions.maxItems;
    const country = normalizedOptions.country || null;
    const run = db.createRun({ platform, query, maxItems, country, options: normalizedOptions });

    // Start the best available collector path async.
    executeRun(run.id, platform, query, normalizedOptions).catch(console.error);
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
    const snapshots = db.getLatestSnapshots({
      search: req.query.search,
      platform: req.query.platform,
      limit: req.query.limit,
    });
    // Add growth data
    const items = snapshots.map((s) => {
      let growth = { likes: 0, comments: 0, shares: 0, views: 0, soldCount: 0, reviews: 0, priceChange: 0 };
      if (s.prev_snapshot_id) {
        const prev = db.getSnapshotHistory(s.item_uid);
        if (prev.length >= 2) {
          const older = prev[prev.length - 2];
          growth = {
            likes: s.likes - older.likes,
            comments: s.comments - older.comments,
            shares: s.shares - older.shares,
            views: s.views - older.views,
            soldCount: (s.sold_count || 0) - (older.sold_count || 0),
            reviews: (s.reviews || 0) - (older.reviews || 0),
            priceChange: Number(((s.price || 0) - (older.price || 0)).toFixed(2))
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
    const { keyword, section, filters, maxItems, cdpUrl } = req.body;
    if (!keyword?.trim()) return res.status(400).json({ error: 'keyword is required' });

    // Create a run record
    const run = db.createRun({
      platform: 'toidispy',
      query: keyword,
      maxItems: parseInt(maxItems) || 100,
    });

    const options = { section: section || 'posts', filters: filters || {}, cdpUrl };
    executeRun(run.id, 'toidispy', keyword, { ...options, maxItems: run.maxItems }).catch(console.error);

    // Return immediately — client polls /api/runs/:id for status
    res.status(202).json({ runId: run.id, status: 'running', keyword, section, filters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check Toidispy Login
app.get('/api/toidispy/check-login', async (req, res) => {
  try {
    const CDPBackend = require('./src/backends/cdp.backend');
    const cdpUrl = process.env.CDP_URL || 'http://localhost:9222';
    const { chromium } = require('playwright');
    let browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      const page = await context.newPage();
      await page.goto('https://app.toidispy.com/posts', { waitUntil: 'domcontentloaded', timeout: 5000 });
      const currentUrl = page.url();
      await page.close();
      await browser.close();

      if (currentUrl.includes('/login')) {
        return res.json({
          status: 'login_required',
          code: 'TOIDISPY_LOGIN_REQUIRED',
          currentUrl,
          actions: ['Open Chrome CDP profile and login to Toidispy']
        });
      }
      return res.json({
        status: 'ok',
        code: 'TOIDISPY_LOGIN_OK',
        currentUrl
      });
    } catch (e) {
      if (browser) await browser.close();
      return res.json({
        status: 'failed',
        code: 'CDP_UNREACHABLE',
        actions: ['Start Chrome with --remote-debugging-port']
      });
    }
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
    const items = snapshots.map((s) => {
      let growth = { soldCount: 0, reviews: 0, likes: 0, priceChange: 0 };
      if (s.prev_snapshot_id || s.item_uid) {
        const prev = db.getSnapshotHistory(s.item_uid);
        if (prev && prev.length >= 2) {
          const older = prev[prev.length - 2];
          growth = {
            soldCount: (s.sold_count || 0) - (older.sold_count || 0),
            reviews: (s.reviews || 0) - (older.reviews || 0),
            likes: (s.likes || 0) - (older.likes || 0),
            priceChange: Number(((s.price || 0) - (older.price || 0)).toFixed(2))
          };
        }
      }
      return {
        title: s.title, url: s.url, image: s.image, author: s.author, price: s.price,
        rating: s.rating, reviews: s.reviews, soldCount: s.sold_count, likes: s.likes,
        comments: s.comments, shares: s.shares, views: s.views, status: s.status,
        createdAt: s.created_at || run.created_at, growth
      };
    });
    
    if (req.query.format === 'csv') {
      const filename = `${run.platform}_${run.query.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.csv`;
      const headers = [
        'Crawled Date/Time (Ngày giờ cào)', 'Platform (Nền tảng)', 'Title (Tên sản phẩm)',
        'Author/Shop (Tên Shop)', 'Price ($) (Giá bán)', 'Price Change ($) (Biến động giá)',
        'Sold Count (Số lượt bán)', 'Sold Growth (Tăng trưởng lượt bán)',
        'Reviews (Số đánh giá)', 'Reviews Growth (Tăng trưởng đánh giá)',
        'Rating (Điểm đánh giá)', 'Likes (Lượt thích)', 'Likes Growth (Tăng trưởng Like)',
        'Status (Trạng thái)', 'URL (Link sản phẩm)', 'Image (Link ảnh)'
      ];
      const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
      const headerLine = headers.join(',');
      const rows = items.map(i => [
        escapeCsv(i.createdAt), escapeCsv(run.platform), escapeCsv(i.title),
        escapeCsv(i.author), escapeCsv(i.price), escapeCsv(i.growth?.priceChange || 0),
        escapeCsv(i.soldCount), escapeCsv(i.growth?.soldCount || 0),
        escapeCsv(i.reviews), escapeCsv(i.growth?.reviews || 0),
        escapeCsv(i.rating), escapeCsv(i.likes), escapeCsv(i.growth?.likes || 0),
        escapeCsv(i.status), escapeCsv(i.url), escapeCsv(i.image)
      ].join(','));
      const csvContent = '\uFEFF' + [headerLine, ...rows].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csvContent);
    }

    const filename = `${run.platform}_${run.query.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({ run, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== Legacy Integration (Removed) ====================

// ==================== Global Error Handler ====================

process.on('uncaughtException', (err) => console.error('[FATAL]', err));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

// ==================== Start ====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Apify Collector running at http://0.0.0.0:${PORT}`);
  if (!process.env.APIFY_TOKEN) console.warn('⚠️  APIFY_TOKEN not set');
});
