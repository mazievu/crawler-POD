const fs = require('fs');
const path = require('path');
const { analyzeMarketplaceHtml } = require('../marketplaces/html-parser');

class CheckpointStore {
  constructor({ platform, keyword, sessionId = `session_${Date.now()}` }) {
    this.platform = platform;
    this.keyword = keyword;
    this.sessionId = sessionId;
    this.baseDir = path.join(__dirname, '..', '..', 'data', 'captures', this.sessionId);
    
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    this.checkpointLog = [];
    this.savedProducts = [];
  }

  saveHtmlCheckpoint(name, html, metadata = {}) {
    const filename = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.html`;
    const filePath = path.join(this.baseDir, filename);
    fs.writeFileSync(filePath, html, 'utf-8');

    const record = {
      checkpoint: name,
      filename,
      filePath,
      timestamp: new Date().toISOString(),
      metadata
    };

    this.checkpointLog.push(record);
    console.log(`[CheckpointStore] Saved HTML snapshot '${name}' -> ${filename}`);
    return record;
  }

  // UI-BUG-10: this used to call `db.insertSnapshots(runId, ..., [productRecord])`
  // once per product, right here. insertSnapshots() unconditionally OVERWRITES
  // `runs.result_items_json` with exactly the batch it was given (correct for
  // its normal one-call-per-Run contract used by the regular crawl flow) — so
  // calling it once per item made every call clobber the previous item(s),
  // leaving only the LAST product in `result_items_json` once the journey
  // loop finished. Fix: only accumulate in-memory here; the caller
  // (user-journey-runner.js) now makes exactly one insertSnapshots() call with
  // the FULL accumulated batch, after the loop completes.
  processAndSaveProductDetail(url, html, fxContext = null) {
    try {
      const { metrics } = analyzeMarketplaceHtml({ platform: this.platform, url, html });
      if (!metrics || !metrics.title) return null;

      const rawPrice = metrics.price || 0;
      const rawCurrency = metrics.currency || '';
      const { normalizeCurrencyCode, getFxService } = require('../currency');
      const normCurrency = normalizeCurrencyCode(rawCurrency);

      let converted = {
        price: rawPrice,
        currency: normCurrency || 'USD',
        source_price: rawPrice,
        source_currency: normCurrency || 'USD',
        fx_rate: 1.0,
        fx_at: new Date().toISOString()
      };

      if (normCurrency !== 'USD' && rawPrice > 0) {
        const converter = (fxContext && typeof fxContext.convertToUsd === 'function')
          ? fxContext
          : getFxService();
        const res = converter.convertToUsd(rawPrice, rawCurrency);
        if (res && typeof res.then === 'function') {
          return res.then((c) => this._buildAndPushRecord(metrics, url, c));
        }
        converted = res;
      }

      return this._buildAndPushRecord(metrics, url, converted);
    } catch (err) {
      console.warn(`[CheckpointStore] Failed to process detail HTML for ${url}:`, err.message);
      return null;
    }
  }

  _buildAndPushRecord(metrics, url, converted) {
    const productRecord = {
      platform: this.platform,
      title: metrics.title,
      url: canonicalListingUrl(this.platform, metrics, url),
      image: metrics.image || '',
      author: metrics.brand || 'Seller',
      price: converted.price,
      currency: converted.currency,
      source_price: converted.source_price,
      source_currency: converted.source_currency,
      fx_rate: converted.fx_rate,
      fx_at: converted.fx_at,
      ...(converted.fx_error ? { fx_error: converted.fx_error } : {}),
      rating: metrics.rating || 0,
      reviews: metrics.reviewCount || 0,
      soldCount: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      views: 0,
      status: metrics.availability === 'out_of_stock' ? 'dropped' : 'new'
    };

    this.savedProducts.push(productRecord);
    return productRecord;
  }

  saveSummary(status = 'COMPLETED') {
    const summary = {
      sessionId: this.sessionId,
      platform: this.platform,
      keyword: this.keyword,
      status,
      checkpointsCount: this.checkpointLog.length,
      productsCollectedCount: this.savedProducts.length,
      checkpointLog: this.checkpointLog,
      completedAt: new Date().toISOString()
    };

    const summaryPath = path.join(this.baseDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    return summary;
  }
}

// BUG-AMZ-02: identity must be based on ASIN, not the raw scraped URL — the
// same physical product commonly gets scraped from multiple raw URLs
// (different SEO slug text, different ref= tracking params), which would
// otherwise each generate a DIFFERENT item_uid downstream (generateUid() in
// database.js is `${platform}:${url}` — it already trusts whatever URL it's
// given as canonical, so no change is needed there). Reuses
// html-parser.js's own already-computed metrics.listingId (the ASIN) — no
// new identity scheme. Scoped to Amazon only; every other platform keeps
// using metrics.url/the raw scraped url exactly as before.
function canonicalListingUrl(platform, metrics, rawUrl) {
  if (platform === 'amazon' && metrics.listingId) {
    return `https://www.amazon.com/dp/${metrics.listingId}`;
  }
  return metrics.url || rawUrl;
}

module.exports = { CheckpointStore };
