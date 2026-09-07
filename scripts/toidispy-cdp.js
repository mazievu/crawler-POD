/**
 * Toidispy CDP Automation
 * Connect to Chrome via CDP → apply filters → scrape data → save to DB
 *
 * Selectors verified via live CDP inspection (June 2026)
 */

const { chromium } = require('playwright');
const { ToidispyFilterAdapter } = require('./toidispy-filter-adapter');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ==================== Database Helper ====================

const DB = {
  async savePosts(items, keyword, filters = {}, importUrl = 'http://localhost:3000/api/toidispy/import') {
    const response = await fetch(importUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: keyword, filters, items }),
    });
    return await response.json();
  },
};

// ==================== Main Automation ====================

class ToidispyAutomation {
  constructor() {
    this.browser = null;
    this.page = null;
    this.filterAdapter = null;
  }

  /**
   * Connect to existing Chrome via CDP.
   * Requires Chrome launched with: chrome.exe --remote-debugging-port=9222
   */
  async connect(cdpUrl = process.env.CDP_URL || 'http://localhost:9222') {
    try {
      this.browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10000 });
      const contexts = this.browser.contexts();
      if (contexts.length === 0) throw new Error('No browser contexts found');
      this.page = contexts[0].pages()[0];
      this.filterAdapter = new ToidispyFilterAdapter(this.page);
      console.error('✅ Connected to Chrome');
      return true;
    } catch (err) {
      console.error('❌ Connection failed:', err.message);
      return false;
    }
  }

  // ==================== NAVIGATION ====================

  async navigate(section = 'posts') {
    const url = section === 'ads'
      ? 'https://app.toidispy.com/libraries'
      : 'https://app.toidispy.com/posts';
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.error(`📄 Navigated to ${section}`);
    await this.page.waitForTimeout(2000);
  }

  // ==================== SCROLLING ====================

  async scrollAndLoad(maxScrolls = 5, targetCount = null) {
    let lastCount = 0;
    for (let i = 0; i < maxScrolls; i++) {
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // eslint-disable-line no-undef
      await this.page.waitForTimeout(2000);

      const currentCount = await this.page.$$eval('.p-item-col', els => els.length);
      console.error(`  📜 Scroll ${i + 1}/${maxScrolls}: ${currentCount} items`);

      // §9: stop scrolling early once we already have enough for a bounded
      // maxItems request — no point loading more than will ever be returned.
      if (Number.isFinite(targetCount) && targetCount > 0 && currentCount >= targetCount) {
        console.error(`  ⏹️ Reached requested maxItems=${targetCount}, stopping scroll`);
        break;
      }

      if (currentCount === lastCount) {
        console.error('  ⏹️ No more items to load');
        break;
      }
      lastCount = currentCount;
    }
  }

  // ==================== SCRAPE POSTS ====================

  /**
   * Scrape all post cards from the current page.
   *
   * Card structure (verified via CDP):
   *   .p-item-col
   *     a.fw-500.text-primary          → page name
   *     a[title="Created time"]         → time ago
   *     .bg-success                     → Ad badge
   *     .item-reactions div:nth-child(1) → reactions count
   *     .item-reactions div:nth-child(2) → comments count
   *     .item-reactions div:nth-child(3) → shares count
   *     a[href*="redirect?type=ap"]     → domain, pageId, pixelId, gtmId, googleAdsId
   *     .p-carousel-item-img            → image (background-image)
   */
  async scrapePosts() {
    return await this.page.evaluate(() => { /* eslint-disable no-undef */
      const cards = document.querySelectorAll('.p-item-col');
      const items = [];

      cards.forEach(card => {
        // Page name
        const pageNameEl = card.querySelector('a.fw-500.text-primary');
        const pageName = pageNameEl ? pageNameEl.textContent.trim() : '';

        // Time ago
        const timeEl = card.querySelector('a[title="Created time"]');
        const timeAgo = timeEl ? timeEl.textContent.trim() : '';

        // Ad badge
        const isAd = !!card.querySelector('.bg-success');

        // Reactions / Comments / Shares
        const reactionsSection = card.querySelector('.item-reactions');
        let reactions = 0, comments = 0, shares = 0;
        if (reactionsSection) {
          const pElements = reactionsSection.querySelectorAll('p');
          const values = [];
          pElements.forEach(p => {
            const text = p.textContent.trim();
            if (text && text !== '--') {
              values.push(text);
            }
          });
          if (values.length >= 1) reactions = parseInt(values[0]) || 0;
          if (values.length >= 2) comments = parseInt(values[1]) || 0;
          if (values.length >= 3) shares = parseInt(values[2]) || 0;
        }

        // Links: domain, pageId, pixelId, gtmId, googleAdsId
        const allLinks = Array.from(card.querySelectorAll('a[href*="redirect?type=ap"]'));
        let domain = '', pageId = '', pixelId = '', gtmId = '', googleAdsId = '';

        allLinks.forEach(link => {
          const text = link.textContent.trim();
          // Skip page name link (it's fw-500.text-primary, already captured)
          if (link.classList.contains('fw-500') || link.classList.contains('text-primary')) return;

          if (/^G-[A-Z0-9-]+$/i.test(text)) {
            pixelId = text;
          } else if (/^GTM-[A-Z0-9-]+$/i.test(text)) {
            gtmId = text;
          } else if (/^AW-\d+$/i.test(text)) {
            googleAdsId = text;
          } else if (/^UA-\d+-\d+$/i.test(text)) {
            // Google Analytics - skip or add to a separate field
          } else if (/^\d{10,}$/.test(text)) {
            pageId = text;
          } else if (text.includes('.') && !text.startsWith('http')) {
            domain = text;
          }
        });

        // Image
        const imageEl = card.querySelector('.p-carousel-item-img');
        const imageUrl = imageEl
          ? (imageEl.style.backgroundImage || '').replace(/url\(["']?|["']?\)/g, '')
          : '';

        items.push({
          pageName,
          timeAgo,
          isAd,
          reactions,
          comments,
          shares,
          domain,
          pageId,
          pixelId,
          gtmId,
          googleAdsId,
          imageUrl,
        });
      });

      return items;
    });
  }

  // ==================== SCRAPE ADS LIBRARY ====================

  /**
   * Scrape all ads library cards from the current page.
   *
   * Card structure (verified via CDP):
   *   .p-item-col
   *     a.fw-500.text-primary          → page name
   *     a[title="Created time"]         → time ago
   *     text content "N Ad(s)"          → ad count
   *     small                           → ad ID ("ID: ...")
   *     a[href*="redirect?type=aa"]     → domain, pageId, googleAdsId
   *     .p-carousel-item-img            → image
   */
  async scrapeAdsLibrary() {
    return await this.page.evaluate(() => { /* eslint-disable no-undef */
      const cards = document.querySelectorAll('.p-item-col');
      const items = [];

      cards.forEach(card => {
        // Page name
        const pageNameEl = card.querySelector('a.fw-500.text-primary');
        const pageName = pageNameEl ? pageNameEl.textContent.trim() : '';

        // Time ago
        const timeEl = card.querySelector('a[title="Created time"]');
        const timeAgo = timeEl ? timeEl.textContent.trim() : '';

        // Ad count (e.g., "1 Ad", "3 Ads")
        const cardText = card.innerText || '';
        const adCountMatch = cardText.match(/(\d+)\s*Ad/i);
        const adCount = adCountMatch ? parseInt(adCountMatch[1]) : 0;

        // Ad ID from <small> element
        const smallEl = card.querySelector('small');
        const adId = smallEl
          ? smallEl.textContent.replace('ID:', '').trim()
          : '';

        // Links: domain, pageId, googleAdsId
        const allLinks = Array.from(card.querySelectorAll('a[href*="redirect?type=aa"]'));
        let domain = '', pageId = '', googleAdsId = '';

        allLinks.forEach(link => {
          const text = link.textContent.trim();
          if (/^AW-\d+$/i.test(text)) {
            googleAdsId = text;
          } else if (/^\d{10,}$/.test(text)) {
            pageId = text;
          } else if (text.includes('.') && !text.startsWith('http')) {
            domain = text;
          }
        });

        // Image
        const imageEl = card.querySelector('.p-carousel-item-img');
        const imageUrl = imageEl
          ? (imageEl.style.backgroundImage || '').replace(/url\(["']?|["']?\)/g, '')
          : '';

        items.push({
          pageName,
          timeAgo,
          adCount,
          adId,
          domain,
          pageId,
          googleAdsId,
          imageUrl,
        });
      });

      return items;
    });
  }

  // ==================== FULL RUN ====================

  async run(keyword, options = {}) {
    const {
      section = 'posts',
      filters = {},
      maxScrolls = 3,
      saveToDb = true,
      importUrl = 'http://localhost:3000/api/toidispy/import',
      maxItems = null
    } = options;

    const appliedFilters = { ...filters, keyword };

    console.error(`\n🚀 Starting Toidispy automation`);
    console.error(`   Section: ${section}`);
    console.error(`   Keyword: "${keyword}"`);
    console.error(`   Filters:`, JSON.stringify(appliedFilters, null, 2));

    // 1. Navigate
    await this.navigate(section);

    const currentUrl = this.page.url();
    if (currentUrl.includes('/login')) {
      const err = new Error("Toidispy login required. Open the CDP browser, login to Toidispy, then retry.");
      err.code = 'TOIDISPY_LOGIN_REQUIRED';
      throw err;
    }

    // 2. Apply all filters
    await this.filterAdapter.applyFilters(appliedFilters, section);

    // 3. Click search
    await this.filterAdapter.clickSearch();

    // 4. Wait for results
    try {
      await this.page.waitForSelector('.p-item-col', { timeout: 10000 });
      console.error('✅ Results loaded');
    } catch {
      console.error('⚠️ No results found');
      return { items: [], filters: appliedFilters };
    }

    // 5. Scroll to load more
    await this.scrollAndLoad(maxScrolls, maxItems);

    // 6. Scrape data
    let items;
    if (section === 'ads') {
      items = await this.scrapeAdsLibrary();
    } else {
      items = await this.scrapePosts();
    }

    // §9: final result slice safety — one execution, no fake sharding, but the
    // returned/processed count must respect maxItems where technically possible.
    if (Number.isFinite(maxItems) && maxItems > 0 && items.length > maxItems) {
      items = items.slice(0, maxItems);
    }

    console.error(`📊 Scraped ${items.length} items`);

    // 7. Save to database
    if (saveToDb && items.length > 0) {
      const result = await DB.savePosts(items, keyword, appliedFilters, importUrl);
      console.error(`💾 Saved: ${result.count} items`);
    }

    return { items, filters: appliedFilters };
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

// ==================== CLI Runner ====================

async function fatal(error, context = {}, page = null) {
  const diagnostic = {
    level: 'error',
    event: 'toidispy_fatal',
    code: error?.code,
    message: error?.message || String(error),
    stack: error?.stack,
    ...context
  };

  try {
    if (page) {
      diagnostic.currentUrl = page.url();
      diagnostic.title = await page.title().catch(() => null);

      const debugDir = process.env.TOIDISPY_DEBUG_DIR;
      if (debugDir) {
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        const prefix = `run-${Date.now()}`;
        const screenshotPath = path.join(debugDir, `${prefix}.png`);
        const htmlPath = path.join(debugDir, `${prefix}.html`);
        await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5000 }).catch(() => null);
        const html = await page.content().catch(() => '');
        fs.writeFileSync(htmlPath, html, 'utf-8');
        diagnostic.screenshotPath = screenshotPath;
        diagnostic.htmlPath = htmlPath;
      }
    }
  } catch (debugError) {
    diagnostic.debugCaptureError = debugError.message;
  }

  console.error(JSON.stringify(diagnostic));
}

const MAX_ITEMS_SAFE_UPPER_BOUND = 1000;

/**
 * §9/§20.K: extracted from main() so the CLI parsing contract (in particular
 * --max-items, which previously referenced an undeclared `maxItems` variable
 * — a guaranteed ReferenceError on every run that reached that line) can be
 * unit-tested without spawning a real CDP-connected process.
 */
function parseCliArgs(args) {
  let output = 'import'; // default legacy
  let keyword = 'press on nail';
  let section = 'posts';
  let filters = {};
  let importUrl = 'http://localhost:3000/api/toidispy/import';
  let cdpUrl = process.env.CDP_URL || 'http://localhost:9222';
  let maxItems = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) output = args[++i];
    else if (args[i] === '--query' && args[i + 1]) keyword = args[++i];
    else if (args[i] === '--section' && args[i + 1]) section = args[++i];
    else if (args[i] === '--import-url' && args[i + 1]) importUrl = args[++i];
    else if (args[i] === '--cdp-url' && args[i + 1]) cdpUrl = args[++i];
    else if (args[i] === '--max-items' && args[i + 1]) {
      const parsed = Number.parseInt(args[++i], 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        maxItems = Math.min(parsed, MAX_ITEMS_SAFE_UPPER_BOUND);
      } else {
        console.error(`⚠️ Invalid --max-items value, ignoring (must be a positive integer)`);
      }
    }
    else if (args[i] === '--filters' && args[i + 1]) {
      try { filters = JSON.parse(args[++i]); }
      catch { console.error('⚠️ Invalid filters JSON, using defaults'); }
    }
  }

  return { output, keyword, section, filters, importUrl, cdpUrl, maxItems };
}

async function main() {
  const { output, keyword, section, filters, importUrl, cdpUrl, maxItems } = parseCliArgs(process.argv.slice(2));

  const auto = new ToidispyAutomation();
  const context = { section, query: keyword, filters, outputMode: output, cdpUrl };

  try {
    const connected = await auto.connect(cdpUrl);
    if (!connected) {
      throw new Error('Run `npm run start:cdp` or start Chrome with CDP at ' + cdpUrl);
    }

    const saveToDb = (output === 'import');
    const result = await auto.run(keyword, { section, filters, saveToDb, importUrl, maxItems });

    if (output === 'stdout') {
      process.stdout.write(JSON.stringify({ items: result.items, meta: { platform: 'toidispy', status: 'ok', query: keyword, section, filters: result.filters, maxItems } }) + '\n');
    } else {
      console.error('\n📊 Summary:');
      console.error(`- Total items: ${result.items.length}`);

      if (result.items.length > 0) {
        const sample = result.items[0];
        console.error(`- Sample item:`, JSON.stringify(sample, null, 2));

        if (section === 'posts') {
          const totalReactions = result.items.reduce((s, i) => s + (i.reactions || 0), 0);
          const totalComments = result.items.reduce((s, i) => s + (i.comments || 0), 0);
          const totalShares = result.items.reduce((s, i) => s + (i.shares || 0), 0);
          console.error(`- Total reactions: ${totalReactions}`);
          console.error(`- Total comments: ${totalComments}`);
          console.error(`- Total shares: ${totalShares}`);
        } else {
          const totalAds = result.items.reduce((s, i) => s + (i.adCount || 0), 0);
          console.error(`- Total ads across pages: ${totalAds}`);
        }
      }
    }
  } catch (err) {
    await fatal(err, context, auto.page);

    if (output === 'stdout') {
      const errorPayload = {
        items: [],
        meta: {
          platform: 'toidispy',
          status: 'failed',
          query: keyword,
          section,
          filters
        },
        error: {
          message: err.message,
          code: err.code,
          type: err.name,
          currentUrl: auto.page ? auto.page.url() : null,
          title: auto.page ? await auto.page.title().catch(() => null) : null
        }
      };
      process.stdout.write(JSON.stringify(errorPayload) + '\n');
    }
    await auto.close();
    process.exit(1);
  }
}

module.exports = { ToidispyAutomation, DB, fatal, parseCliArgs };

if (require.main === module) {
  main();
}
