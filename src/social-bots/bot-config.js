/**
 * Social Listening Bot Configurations
 * Provides platform-specific seed queries, intervals, filters, and state tracking
 * for Facebook, TikTok, Reddit, Instagram, and Twitter (X).
 */

const DEFAULT_BOT_CONFIGS = {
  facebook: {
    platform: 'facebook_posts',
    displayName: 'Facebook Social Listening',
    enabled: false,
    intervalMinutes: 180,
    queries: ['pod tshirt', 'custom mug', 'trending merchandise', 'print on demand'],
    maxItems: 30,
    filters: { minLikes: 50, country: 'US' }
  },
  tiktok: {
    platform: 'tiktok_videos',
    displayName: 'TikTok Trend Listening',
    enabled: false,
    intervalMinutes: 180,
    queries: ['#tiktokmademebuyit', '#podtrend', '#custommerch', '#printondemand'],
    maxItems: 30,
    filters: { minViews: 5000 }
  },
  reddit: {
    platform: 'reddit',
    displayName: 'Reddit Niche & Problem Listening',
    enabled: false,
    intervalMinutes: 180,
    queries: ['custom gift idea', 'print on demand reviews', 'etsy trending', 'gift for mom'],
    maxItems: 40,
    filters: { minScore: 10 }
  },
  instagram: {
    platform: 'instagram',
    displayName: 'Instagram Visual Trend Listening',
    enabled: false,
    intervalMinutes: 180,
    queries: ['#podfashion', '#customstreetwear', '#graphictee', '#aestheticmug'],
    maxItems: 30,
    filters: { minLikes: 100 }
  },
  twitter: {
    platform: 'twitter',
    displayName: 'X / Twitter Realtime Buzz',
    enabled: false,
    intervalMinutes: 180,
    queries: ['print on demand launch', 'new tshirt drop', 'etsy bestseller'],
    maxItems: 30,
    filters: { minRetweets: 5 }
  }
};

class BotConfigManager {
  constructor(filePath = null) {
    const path = require('path');
    this.filePath = filePath || path.join(__dirname, '..', '..', 'data', 'social-bots.json');
    this.configs = new Map();
    this.load();
  }

  load() {
    for (const [k, v] of Object.entries(DEFAULT_BOT_CONFIGS)) {
      this.configs.set(k, { ...v });
    }

    const fs = require('fs');
    try {
      if (fs.existsSync(this.filePath)) {
        const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        for (const [k, v] of Object.entries(saved)) {
          if (this.configs.has(k)) {
            this.configs.set(k, { ...this.configs.get(k), ...v });
          } else {
            this.configs.set(k, v);
          }
        }
      } else {
        // Simplification Round #21: don't just claim the file "auto-regenerates"
        // from in-memory defaults — actually persist it, so the on-disk state
        // (including TikTok staying disabled) is real, not just an assertion.
        this.save();
      }
    } catch (_e) {
      // Use in-memory defaults if the file is unreadable/corrupt.
    }
  }

  save() {
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [k, v] of this.configs.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (_e) {}
  }

  get(platformKey) {
    return this.configs.get(platformKey);
  }

  getAll() {
    return Array.from(this.configs.entries()).map(([key, config]) => ({
      key,
      ...config
    }));
  }

  update(platformKey, updates = {}) {
    const current = this.configs.get(platformKey);
    if (!current) throw new Error(`Unknown bot platform: ${platformKey}`);
    if (updates.enabled === true && !current.platform) {
      throw new Error(`Cannot enable bot '${platformKey}': no real channel is mapped (${current.unsupportedReason || 'unsupported'})`);
    }
    const updated = {
      ...current,
      ...updates,
      platform: current.platform, // Keep immutable
      intervalMinutes: Math.max(5, Number(updates.intervalMinutes || current.intervalMinutes))
    };
    this.configs.set(platformKey, updated);
    this.save();
    return updated;
  }
}

module.exports = {
  DEFAULT_BOT_CONFIGS,
  BotConfigManager
};
