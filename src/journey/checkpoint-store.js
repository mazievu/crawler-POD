const fs = require('fs');
const path = require('path');
const db = require('../database');
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

  processAndSaveProductDetail(url, html, runId = null) {
    try {
      const { metrics } = analyzeMarketplaceHtml({ platform: this.platform, url, html });
      if (!metrics || !metrics.title) return null;

      const productRecord = {
        platform: this.platform,
        title: metrics.title,
        url: metrics.url || url,
        image: metrics.image || '',
        author: metrics.brand || 'Seller',
        price: metrics.price || 0,
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

      if (runId) {
        db.insertSnapshots(runId, this.platform, this.keyword, [productRecord]);
      }

      return productRecord;
    } catch (err) {
      console.warn(`[CheckpointStore] Failed to process detail HTML for ${url}:`, err.message);
      return null;
    }
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

module.exports = { CheckpointStore };
