/**
 * eBay Scraper
 * Free-first order:
 *   1. SearXNG search discovery for public eBay item pages.
 *   2. Public search page fallback through Playwright.
 */

const { launchStealth } = require('../../anti-bot/stealth-launcher');
const { discoverMarketplaceItems } = require('./search-discovery');

async function scrapePublic(query, options) {
  options = options || {};
  const limit = options.limit || 30;
  const proxyUrl = options.proxyUrl || process.env.EBAY_PROXY || null;
  const browser = await launchStealth({ proxyUrl, headless: true });

  try {
    const page = browser.page;
    const url = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query) + '&LH_BIN=1&_sop=12';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    const blocked = await page.locator('text=/Pardon Our Interruption|robot|captcha|access denied/i').count();
    if (blocked) throw new Error('BLOCKED_IP: eBay bot challenge');

    await page.waitForSelector('.s-item', { timeout: 15000 });

    const items = await page.$$eval('.s-item', (els, max) => els.slice(0, max + 5).map(el => {
      const title = el.querySelector('.s-item__title')?.textContent?.trim() || '';
      const link = el.querySelector('.s-item__link')?.href || '';
      const priceText = el.querySelector('.s-item__price')?.textContent?.trim() || '';
      const image = el.querySelector('.s-item__image img')?.src || '';
      const seller = el.querySelector('.s-item__seller-info-text')?.textContent?.trim() || '';
      const shipping = el.querySelector('.s-item__shipping, .s-item__logisticsCost')?.textContent?.trim() || '';
      const sold = el.querySelector('.s-item__quantitySold')?.textContent?.trim() || '';
      const price = parseFloat((priceText.match(/[\d,.]+/) || ['0'])[0].replace(/,/g, '')) || 0;
      return { platform: 'ebay', title, url: link, price, priceText, image, seller, shipping, sold, likes: 0, comments: 0, shares: 0, views: 0 };
    }, limit), limit);

    const clean = items.filter(i => i.title && i.title !== 'Shop on eBay' && i.url).slice(0, limit);
    if (!clean.length) throw new Error('EMPTY_RESULT: no eBay items parsed');
    return { items: clean };
  } finally {
    await browser.close();
  }
}

async function scrape(query, options) {
  try {
    return await discoverMarketplaceItems('ebay', query, options || {});
  } catch (err) {
    if (!/SearXNG|EMPTY_RESULT|fetch failed|ECONNREFUSED/i.test(err.message || '')) throw err;
    return scrapePublic(query, options);
  }
}

module.exports = { scrape };
