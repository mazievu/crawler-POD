class EbayJourneyHandler {
  constructor(page, store) {
    this.page = page;
    this.store = store;
  }

  async setupLocation(zipCode = '90210') {
    console.log(`[EbayJourney] J2: Setting ZIP/location to ${zipCode}...`);
    try {
      const shipToBtn = this.page.locator('button:has-text("Ship to"), button[aria-label*="Ship to"]').first();
      if (await shipToBtn.isVisible()) {
        await shipToBtn.click();
        await this.page.waitForTimeout(1000);
        const zipInput = this.page.locator('input[placeholder*="ZIP"], input[name="zipCode"]').first();
        if (await zipInput.isVisible()) {
          await zipInput.fill(zipCode);
          const applyBtn = this.page.locator('button:has-text("Apply"), button:has-text("Done")').first();
          if (await applyBtn.isVisible()) await applyBtn.click();
          await this.page.waitForTimeout(1500);
        }
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(500);
      }
    } catch (e) {
      console.warn('[EbayJourney] ZIP setup warning:', e.message);
    }
  }


  async performSearch(keyword) {
    console.log(`[EbayJourney] J3: Performing search for '${keyword}'...`);
    try {
      const searchInput = this.page.locator('input[id="gh-ac"], input[name="_nkw"]').first();
      await searchInput.waitFor({ state: 'attached', timeout: 5000 });
      await searchInput.fill(keyword);
      const searchBtn = this.page.locator('input[id="gh-btn"], button[id="gh-search-btn"]').first();
      if (await searchBtn.isVisible()) await searchBtn.click();
      else await this.page.keyboard.press('Enter');
    } catch (e) {
      console.warn('[EbayJourney] Direct search input interaction failed, navigating directly to search URL...');
      await this.page.goto(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForTimeout(2000);
    this.store.saveHtmlCheckpoint('search_results', await this.page.content());
  }


  async applyFilters(filters = {}) {
    console.log('[EbayJourney] J4: Applying eBay filters (Buy It Now, Condition)...');
    try {
      const buyItNowBtn = this.page.locator('a:has-text("Buy It Now"), button:has-text("Buy It Now")').first();
      if (await buyItNowBtn.isVisible()) {
        await buyItNowBtn.click();
        await this.page.waitForLoadState('domcontentloaded');
        await this.page.waitForTimeout(1500);
      }
    } catch (e) {
      console.warn('[EbayJourney] Filter warning:', e.message);
    }
    this.store.saveHtmlCheckpoint('search_filtered', await this.page.content());
  }

  async extractListingUrls(maxProducts = 10) {
    console.log('[EbayJourney] J5: Scanning eBay item cards...');
    await this.page.evaluate(() => window.scrollBy(0, 800));
    await this.page.waitForTimeout(1000);

    const urls = await this.page.$$eval('a.s-item__link, a[href*="/itm/"]', (links) => {
      const set = new Set();
      for (const a of links) {
        if (a.href && a.href.includes('/itm/')) {
          set.add(a.href.split('?')[0]);
        }
      }
      return Array.from(set);
    });

    console.log(`[EbayJourney] Found ${urls.length} eBay item URLs.`);
    return urls.slice(0, maxProducts);
  }

  async interactProductDetail(url, idx) {
    console.log(`[EbayJourney] J6-J7: Opening eBay product detail #${idx + 1}: ${url}`);
    const detailPage = await this.page.context().newPage();
    try {
      await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await detailPage.waitForTimeout(1500);

      // Check variations
      const selects = await detailPage.$$('select[id*="msku"], select[name*="Variation"]');
      if (selects.length > 0) {
        console.log(`[EbayJourney] J7: Selecting variation for eBay item #${idx + 1}...`);
        try {
          await selects[0].selectOption({ index: 1 });
          await detailPage.waitForTimeout(1000);
          this.store.saveHtmlCheckpoint(`product_${idx + 1}_variant_selected`, await detailPage.content());
        } catch (e) {}
      }

      const html = await detailPage.content();
      this.store.saveHtmlCheckpoint(`product_${idx + 1}_detail`, html);
      return html;
    } finally {
      await detailPage.close().catch(() => {});
    }
  }
}

module.exports = { EbayJourneyHandler };
