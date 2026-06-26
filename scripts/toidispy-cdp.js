/**
 * Toidispy CDP Automation
 * Connect to Chrome via CDP → apply filters → scrape data → save to DB
 *
 * Selectors verified via live CDP inspection (June 2026)
 */

const { chromium } = require('playwright');
const { ToidispyFilterAdapter } = require('./toidispy-filter-adapter');
require('dotenv').config();

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function calculateScrollBudget(maxItems, maxScrolls) {
  const explicitMaxScrolls = parsePositiveInt(maxScrolls, null);
  if (explicitMaxScrolls) return explicitMaxScrolls;

  const targetItems = parsePositiveInt(maxItems, 20);
  return Math.min(60, Math.max(3, Math.ceil(targetItems / 10)));
}

// ==================== Database Helper ====================

const DB = {
  async savePosts(items, keyword, filters = {}) {
    const response = await fetch('http://localhost:3000/api/toidispy/import', {
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
      this.browser = await chromium.connectOverCDP(cdpUrl);
      const contexts = this.browser.contexts();
      if (contexts.length === 0) throw new Error('No browser contexts found');
      this.page = contexts[0].pages()[0];
      this.filterAdapter = new ToidispyFilterAdapter(this.page);
      console.log('✅ Connected to Chrome');
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
    await this.page.goto(url, { waitUntil: 'networkidle' });
    console.log(`📄 Navigated to ${section}`);
    await this.page.waitForTimeout(2000);
  }

  // ==================== SCROLLING ====================

  async scrollAndLoad({ targetItems = 20, maxScrolls = 5 } = {}) {
    let lastCount = 0;
    for (let i = 0; i < maxScrolls; i++) {
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // eslint-disable-line no-undef
      await this.page.waitForTimeout(2000);

      const currentCount = await this.page.$$eval('.p-item-col', els => els.length);
      if (currentCount >= targetItems) {
        console.log(`  Target item count reached: ${currentCount}/${targetItems}`);
        break;
      }
      console.log(`  📜 Scroll ${i + 1}/${maxScrolls}: ${currentCount} items`);

      if (currentCount === lastCount) {
        console.log('  ⏹️ No more items to load');
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
      maxItems = 20,
      maxScrolls = null,
      saveToDb = true,
    } = options;

    const targetItems = parsePositiveInt(maxItems, 20);
    const scrollBudget = calculateScrollBudget(targetItems, maxScrolls);
    const appliedFilters = { ...filters, keyword };

    console.log(`\n🚀 Starting Toidispy automation`);
    console.log(`   Section: ${section}`);
    console.log(`   Keyword: "${keyword}"`);
    console.log(`   Filters:`, JSON.stringify(appliedFilters, null, 2));

    // 1. Navigate
    await this.navigate(section);

    // 2. Apply all filters
    await this.filterAdapter.applyFilters(appliedFilters, section);

    // 3. Click search
    await this.filterAdapter.clickSearch();

    // 4. Wait for results
    try {
      await this.page.waitForSelector('.p-item-col', { timeout: 10000 });
      console.log('✅ Results loaded');
    } catch {
      console.log('⚠️ No results found');
      return { items: [], filters: appliedFilters };
    }

    // 5. Scroll to load more
    await this.scrollAndLoad({ targetItems, maxScrolls: scrollBudget });

    // 6. Scrape data
    let items;
    if (section === 'ads') {
      items = await this.scrapeAdsLibrary();
      items = items.slice(0, targetItems);
    } else {
      items = await this.scrapePosts();
      items = items.slice(0, targetItems);
    }

    console.log(`📊 Scraped ${items.length} items`);

    // 7. Save to database
    if (saveToDb && items.length > 0) {
      const result = await DB.savePosts(items, keyword, appliedFilters);
      console.log(`💾 Saved: ${result.count} items`);
    }

    return { items, filters: appliedFilters };
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

// ==================== CLI Runner ====================

async function main() {
  const args = process.argv.slice(2);

  // Parse: node toidispy-cdp.js "keyword" [section] [filters-json]
  const keyword = args[0] || 'press on nail';
  const section = args[1] || 'posts';
  let filters = {};

  if (args[2]) {
    try { filters = JSON.parse(args[2]); }
    catch { console.log('⚠️ Invalid filters JSON, using defaults'); }
  }

  const auto = new ToidispyAutomation();

  try {
    const connected = await auto.connect();
    if (!connected) {
      console.log('\n💡 Run `npm run start:cdp` or start Chrome with CDP at ' + (process.env.CDP_URL || 'http://localhost:9222'));
      process.exit(1);
    }

    const result = await auto.run(keyword, { section, filters });

    console.log('\n📊 Summary:');
    console.log(`- Total items: ${result.items.length}`);

    if (result.items.length > 0) {
      const sample = result.items[0];
      console.log(`- Sample item:`, JSON.stringify(sample, null, 2));

      if (section === 'posts') {
        const totalReactions = result.items.reduce((s, i) => s + (i.reactions || 0), 0);
        const totalComments = result.items.reduce((s, i) => s + (i.comments || 0), 0);
        const totalShares = result.items.reduce((s, i) => s + (i.shares || 0), 0);
        console.log(`- Total reactions: ${totalReactions}`);
        console.log(`- Total comments: ${totalComments}`);
        console.log(`- Total shares: ${totalShares}`);
      } else {
        const totalAds = result.items.reduce((s, i) => s + (i.adCount || 0), 0);
        console.log(`- Total ads across pages: ${totalAds}`);
      }
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await auto.close();
  }
}

module.exports = { ToidispyAutomation, DB, calculateScrollBudget };

if (require.main === module) {
  main();
}
