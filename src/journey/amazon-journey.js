class AmazonJourneyHandler {
  constructor(page, store) {
    this.page = page;
    this.store = store;
  }

  async setupLocation(zipCode = '90210') {
    console.log(`[AmazonJourney] J2: Setting Amazon ZIP location to ${zipCode}...`);
    try {
      const navGlobalLocation = this.page.locator('#nav-global-location-popover-link, #glow-ingress-block').first();
      if (await navGlobalLocation.isVisible()) {
        await navGlobalLocation.click();
        await this.page.waitForTimeout(1500);

        const zipInput = this.page.locator('#GLUXZipUpdateInput').first();
        if (await zipInput.isVisible()) {
          await zipInput.fill(zipCode);
          const applyBtn = this.page.locator('#GLUXZipUpdate, input[aria-labelledby="GLUXZipUpdate-announce"]').first();
          if (await applyBtn.isVisible()) await applyBtn.click();
          await this.page.waitForTimeout(1500);

          const continueBtn = this.page.locator('button[name="glowDoneButton"], #GLUXConfirmClose, input[aria-labelledby="GLUXConfirmClose-announce"]').first();
          if (await continueBtn.isVisible()) await continueBtn.click();
          await this.page.waitForTimeout(1500);
        }
      }
      // Ensure backdrop is dismissed
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(1000);
    } catch (e) {
      console.warn('[AmazonJourney] Location modal warning:', e.message);
    }
  }

  async performSearch(keyword) {
    console.log(`[AmazonJourney] J3: Performing search for '${keyword}'...`);
    try {
      const searchInput = this.page.locator('#twotabsearchtextbox').first();
      await searchInput.waitFor({ state: 'attached', timeout: 5000 });
      await searchInput.fill(keyword);
      const searchBtn = this.page.locator('#nav-search-submit-button').first();
      if (await searchBtn.isVisible()) await searchBtn.click();
      else await this.page.keyboard.press('Enter');
    } catch (e) {
      console.warn('[AmazonJourney] Direct search input interaction failed, navigating directly to search URL...');
      await this.page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForTimeout(2500);
    this.store.saveHtmlCheckpoint('search_results', await this.page.content());
  }


  async applyFilters(filters = {}) {
    console.log('[AmazonJourney] J4: Applying Amazon filters...');
    try {
      const primeFilter = this.page.locator('i.a-icon-prime').first();
      if (await primeFilter.isVisible()) {
        await primeFilter.click();
        await this.page.waitForLoadState('domcontentloaded');
        await this.page.waitForTimeout(2000);
      }
    } catch (e) {
      console.warn('[AmazonJourney] Filter warning:', e.message);
    }
    this.store.saveHtmlCheckpoint('search_filtered', await this.page.content());
  }

  async extractListingUrls(maxProducts = 10) {
    console.log('[AmazonJourney] J5: Scanning Amazon product cards (ASINs)...');
    await this.page.evaluate(() => window.scrollBy(0, 800));
    await this.page.waitForTimeout(1000);

    const urls = await this.page.$$eval('a.a-link-normal[href*="/dp/"]', (links) => {
      const set = new Set();
      for (const a of links) {
        if (a.href && !a.href.includes('#customerReviews')) {
          set.add(a.href.split('?')[0]);
        }
      }
      return Array.from(set);
    });

    console.log(`[AmazonJourney] Found ${urls.length} Amazon ASIN URLs.`);
    return urls.slice(0, maxProducts);
  }

  async interactProductDetail(url, idx) {
    console.log(`[AmazonJourney] J6-J7: Opening Amazon ASIN detail #${idx + 1}: ${url}`);
    const detailPage = await this.page.context().newPage();
    try {
      await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await detailPage.waitForTimeout(2000);

      // Check swatch / variation buttons
      const swatches = await detailPage.$$('li[id*="color_name_"], li[aria-label*="Select"]');
      if (swatches.length > 1) {
        console.log(`[AmazonJourney] J7: Clicking variation swatch on ASIN #${idx + 1}...`);
        try {
          await swatches[1].click();
          await detailPage.waitForTimeout(1500);
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

module.exports = { AmazonJourneyHandler };
