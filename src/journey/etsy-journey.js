class EtsyJourneyHandler {
  constructor(page, store) {
    this.page = page;
    this.store = store;
  }

  async setupLocation(zipCode) {
    console.log('[EtsyJourney] J2: Checking & setting location for Etsy...');
    try {
      // Check region/currency footer button if available
      const regionBtn = this.page.locator('button[aria-label*="region"], button:has-text("United States")').first();
      if (await regionBtn.isVisible()) {
        console.log('[EtsyJourney] Region settings verified on Etsy footer/header.');
      }
    } catch (e) {
      console.warn('[EtsyJourney] Location setup warning:', e.message);
    }
  }

  async performSearch(keyword) {
    console.log(`[EtsyJourney] J3: Performing search for '${keyword}'...`);
    try {
      const searchInput = this.page.locator('input[id*="search-query"], input[name="q"]').first();
      await searchInput.waitFor({ state: 'attached', timeout: 5000 });
      await searchInput.fill(keyword);
      await this.page.keyboard.press('Enter');
    } catch (e) {
      console.warn('[EtsyJourney] Direct search input interaction failed, navigating directly to search URL...');
      await this.page.goto(`https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForTimeout(2000);
    this.store.saveHtmlCheckpoint('search_results', await this.page.content());
  }


  async applyFilters(filters = {}) {
    console.log('[EtsyJourney] J4: Applying filters (Free shipping, Price)...');
    try {
      const filterBtn = this.page.locator('button:has-text("Filters"), button:has-text("All Filters")').first();
      if (await filterBtn.isVisible()) {
        await filterBtn.click();
        await this.page.waitForTimeout(1000);
        
        if (filters.freeShipping) {
          const freeShipCheckbox = this.page.locator('label:has-text("FREE shipping")').first();
          if (await freeShipCheckbox.isVisible()) await freeShipCheckbox.click();
        }

        const applyBtn = this.page.locator('button:has-text("Apply"), button:has-text("Show results")').first();
        if (await applyBtn.isVisible()) await applyBtn.click();
        await this.page.waitForLoadState('domcontentloaded');
        await this.page.waitForTimeout(2000);
      }
    } catch (e) {
      console.warn('[EtsyJourney] Filter application warning:', e.message);
    }
    this.store.saveHtmlCheckpoint('search_filtered', await this.page.content());
  }

  async extractListingUrls(maxProducts = 10) {
    console.log('[EtsyJourney] J5: Scanning product listing cards...');
    await this.page.evaluate(() => window.scrollBy(0, 800));
    await this.page.waitForTimeout(1000);

    const urls = await this.page.$$eval('a[href*="/listing/"]', (links) => {
      const set = new Set();
      for (const a of links) {
        if (a.href && !a.href.includes('#') && !a.href.includes('reviews')) {
          set.add(a.href.split('?')[0]);
        }
      }
      return Array.from(set);
    });

    console.log(`[EtsyJourney] Found ${urls.length} Etsy listing URLs.`);
    return urls.slice(0, maxProducts);
  }

  async interactProductDetail(url, idx) {
    console.log(`[EtsyJourney] J6-J7: Opening product detail #${idx + 1}: ${url}`);
    const detailPage = await this.page.context().newPage();
    try {
      await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await detailPage.waitForTimeout(1500);

      // Check variations dropdown
      const selectBoxes = await detailPage.$$('select[id*="variation-select"]');
      if (selectBoxes.length > 0) {
        console.log(`[EtsyJourney] J7: Interacting with ${selectBoxes.length} variations on product #${idx + 1}...`);
        try {
          await selectBoxes[0].selectOption({ index: 1 });
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

module.exports = { EtsyJourneyHandler };
