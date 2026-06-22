/**
 * Toidispy CDP Filter Adapter
 * Chuyển UI filter selections → CDP actions trên toidispy.com
 * Selectors verified via live CDP inspection (June 2026)
 *
 * Flow:
 *   1. Fill keyword (required)
 *   2. Fill Page ID / Domain / Pixel (optional)
 *   3. Select platforms from dropdown (optional, multi-select)
 *   4. Select categories from dropdown (optional, multi-select)
 *   5. Set Created date preset (optional)
 *   6. Toggle Following (optional)
 *   7. Fill number inputs: Reactions, Comments, Shares / Adset number
 *   8. Set Type filter (optional)
 *   9. Set Status filter (Ads only, optional)
 *  10. Set Sort order (optional)
 *  11. Click Search / Apply button
 */

class ToidispyFilterAdapter {
  constructor(page) {
    this.page = page;
  }

  // ==================== MAIN ====================

  async applyFilters(filters, section = 'posts') {
    console.log(`\n🔧 Applying ${section} filters:`, JSON.stringify(filters, null, 2));

    // 1. Keyword (required)
    if (filters.keyword) {
      await this._fillInput('Enter keywords', filters.keyword);
    }

    // 2. Page ID / Domain / Pixel (optional)
    if (filters.pageId) {
      await this._fillInput('Page id, domain, pixel', filters.pageId);
    }

    // 3. Platforms (optional, multi-select)
    if (filters.platforms?.length > 0) {
      await this._selectMultiDropdown('Platforms', filters.platforms);
    }

    // 4. Categories (optional, multi-select)
    if (filters.categories?.length > 0) {
      await this._selectMultiDropdown('Categories', filters.categories);
    }

    // 5. Created date preset (optional)
    if (filters.created) {
      await this._selectCreatedPreset(filters.created);
    }

    // 6. Following checkbox (optional)
    if (filters.following) {
      await this._toggleFollowing(true);
    }

    // 7. Number inputs
    if (section === 'posts') {
      if (filters.reactionsMin > 0) await this._fillNumberInput('Reactions', filters.reactionsMin);
      if (filters.commentsMin > 0) await this._fillNumberInput('Comments', filters.commentsMin);
      if (filters.sharesMin > 0) await this._fillNumberInput('Shares', filters.sharesMin);
    } else {
      if (filters.adsetMin > 0) await this._fillNumberInput('Adset number', filters.adsetMin);
    }

    // 8. Type filter (optional)
    if (filters.type) {
      await this._selectByPlaceholder('Type', filters.type);
    }

    // 9. Status filter (Ads only)
    if (section === 'ads' && filters.status) {
      await this._selectByPlaceholder('Status', filters.status);
    }

    // 10. Sort (optional)
    if (filters.sort) {
      await this._selectSortBy(filters.sort);
    }

    console.log('✅ All filters applied');
  }

  // ==================== CLICK SEARCH ====================

  async clickSearch() {
    // The button says "Apply" on toidispy (not "Search")
    const selectors = [
      'button.btn-primary:has-text("Apply")',
      'button.btn-primary:has-text("Search")',
      'button:has-text("Apply")',
      'button:has-text("Search")',
      'button[type="submit"]',
    ];

    for (const sel of selectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn) {
          await btn.click();
          console.log('  🔍 Search clicked');
          await this.page.waitForTimeout(3000);
          return true;
        }
      } catch { /* selector not found, try next */ }
    }

    // Fallback: find the Apply button
    const applyBtns = await this.page.$$('button');
    for (const btn of applyBtns) {
      const text = await btn.textContent();
      if (text?.trim() === 'Apply' || text?.trim() === 'Search') {
        await btn.click();
        console.log(`  🔍 Clicked "${text.trim()}" button`);
        await this.page.waitForTimeout(3000);
        return true;
      }
    }

    // Last resort: press Enter
    await this.page.keyboard.press('Enter');
    console.log('  🔍 Search via Enter key');
    await this.page.waitForTimeout(3000);
    return true;
  }

  // ==================== GENERIC HELPERS ====================

  /**
   * Fill a text input by placeholder.
   * Toidispy text inputs use: input[placeholder="..."]
   */
  async _fillInput(placeholder, value) {
    const input = await this.page.$(`input[placeholder="${placeholder}"]`);
    if (input) {
      await input.click({ clickCount: 3 }); // Select all
      await input.fill(value);
      console.log(`  📝 ${placeholder}: "${value}"`);
      return true;
    }
    console.log(`  ⚠️ Input not found: ${placeholder}`);
    return false;
  }

  /**
   * Fill a number input by placeholder.
   * Toidispy: input[type="number"][placeholder="Reactions|Comments|Shares|Adset number"]
   */
  async _fillNumberInput(placeholder, value) {
    // There are duplicate inputs (responsive), target visible one
    const inputs = await this.page.$$(`input[type="number"][placeholder="${placeholder}"]`);
    for (const input of inputs) {
      const visible = await input.isVisible();
      if (visible) {
        await input.click({ clickCount: 3 });
        await input.fill(String(value));
        console.log(`  🔢 ${placeholder}: ${value}`);
        return true;
      }
    }
    console.log(`  ⚠️ Number input not found: ${placeholder}`);
    return false;
  }

  /**
   * Select a <select> by its label/placeholder text.
   * Toidispy uses native <select> for Type, Status, Sort.
   */
  async _selectByPlaceholder(label, value) {
    // Find the select near the label text
    const selects = await this.page.$$('select');
    for (const select of selects) {
      // Check if this select is visible and near the label
      const visible = await select.isVisible();
      if (!visible) continue;

      const parent = await select.evaluateHandle(el => el.closest('.d-flex, div'));
      const parentText = await parent.evaluate(el => el?.textContent || '');

      if (parentText.includes(label)) {
        await select.selectOption({ value });
        console.log(`  📋 ${label}: ${value}`);
        return true;
      }
    }

    // Fallback: find select by its first option text
    for (const select of await this.page.$$('select')) {
      const firstOption = await select.evaluate(el => el.options[0]?.text || '');
      if (firstOption === label) {
        await select.selectOption({ value });
        console.log(`  📋 ${label}: ${value} (fallback)`);
        return true;
      }
    }

    console.log(`  ⚠️ Select not found: ${label}`);
    return false;
  }

  /**
   * Select Sort by dropdown.
   * Toidispy: <select> with options like "", "trending", "created_time_desc", etc.
   */
  async _selectSortBy(value) {
    // Find the sort select (last visible select on page, or the one with "Sort by" label)
    const selects = await this.page.$$('select');
    for (const select of selects) {
      const visible = await select.isVisible();
      if (!visible) continue;

      const options = await select.evaluate(el => Array.from(el.options).map(o => o.value));
      // Sort select has values like '', 'trending', 'created_time_desc', etc.
      if (options.includes('trending') || options.includes('pe_today')) {
        await select.selectOption({ value });
        console.log(`  🔄 Sort: ${value}`);
        return true;
      }
    }

    console.log('  ⚠️ Sort select not found');
    return false;
  }

  /**
   * Select Created date preset.
   * Toidispy: dropdown with buttons "Today", "Last 7 Days", etc.
   */
  async _selectCreatedPreset(presetValue) {
    // Map our values to button labels
    const presetMap = {
      'today': 'Today',
      '7d': 'Last 7 Days',
      '30d': 'Last 30 Days',
      '3m': 'Last 3 Months',
      '6m': 'Last 6 Months',
    };

    const label = presetMap[presetValue];
    if (!label) {
      console.log(`  ⚠️ Unknown Created preset: ${presetValue}`);
      return false;
    }

    // Click the Created input to open dropdown
    const createdInput = await this.page.$('input[placeholder="Created"]');
    if (createdInput) {
      await createdInput.click();
      await this.page.waitForTimeout(500);

      // Find and click the preset button
      const buttons = await this.page.$$('.dropdown-menu button');
      for (const btn of buttons) {
        const text = await btn.textContent();
        if (text?.trim() === label) {
          await btn.click();
          console.log(`  📅 Created: ${label}`);
          await this.page.waitForTimeout(300);
          return true;
        }
      }
    }

    console.log(`  ⚠️ Created preset not found: ${label}`);
    return false;
  }

  /**
   * Toggle Following checkbox.
   * Toidispy: input[type="checkbox"] near "Following" text.
   */
  async _toggleFollowing(enabled) {
    // Find checkbox near Following label
    const checkboxes = await this.page.$$('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const visible = await cb.isVisible();
      if (!visible) continue;

      const parentText = await cb.evaluate(el => el.closest('div, label')?.textContent || '');
      if (parentText.includes('Following')) {
        const isChecked = await cb.isChecked();
        if (isChecked !== enabled) {
          await cb.click();
        }
        console.log(`  ☑️ Following: ${enabled}`);
        return true;
      }
    }

    console.log('  ⚠️ Following checkbox not found');
    return false;
  }

  /**
   * Multi-select dropdown (Platforms / Categories).
   * Toidispy: click input to open dropdown → check/uncheck checkboxes.
   *
   * IMPORTANT: Toidispy dropdowns have the SAME items duplicated in the DOM
   * (one set for mobile, one for desktop). We need to target the VISIBLE set.
   */
  async _selectMultiDropdown(placeholder, selectedValues) {
    // Click the input to open dropdown
    const input = await this.page.$(`input[placeholder="${placeholder}"]`);
    if (!input) {
      console.log(`  ⚠️ ${placeholder} dropdown input not found`);
      return false;
    }

    const isVisible = await input.isVisible();
    if (!isVisible) {
      console.log(`  ⚠️ ${placeholder} dropdown not visible (responsive hidden)`);
      return false;
    }

    await input.click();
    await this.page.waitForTimeout(500);

    // Find the VISIBLE dropdown menu
    const menus = await this.page.$$('.dropdown-menu');
    let targetMenu = null;

    for (const menu of menus) {
      const visible = await menu.isVisible();
      if (!visible) continue;

      // Check if this menu contains the right checkboxes
      const hasLabel = await menu.evaluate((el, ph) => {
        const labels = el.querySelectorAll('label');
        return Array.from(labels).some(l => l.textContent.trim() === ph);
      }, placeholder);

      // Also check input placeholder inside the menu area
      const hasInput = await menu.evaluate((el, ph) => {
        return el.closest('.dropdown')?.querySelector(`input[placeholder="${ph}"]`) !== null;
      }, placeholder);

      if (hasLabel || hasInput) {
        targetMenu = menu;
        break;
      }
    }

    if (!targetMenu) {
      console.log(`  ⚠️ ${placeholder} dropdown menu not visible`);
      return false;
    }

    // Get all checkbox labels in the visible menu
    const labels = await targetMenu.$$('label');
    let selected = 0;

    for (const label of labels) {
      const text = await label.textContent();
      const trimmed = text.trim();

      if (selectedValues.includes(trimmed)) {
        // Check if checkbox is already checked
        const checkbox = await label.evaluateHandle(el => el.previousElementSibling || el.closest('div')?.querySelector('input[type="checkbox"]'));
        if (checkbox) {
          const isChecked = await checkbox.evaluate(el => el.checked);
          if (!isChecked) {
            await label.click();
            selected++;
            await this.page.waitForTimeout(100);
          }
        }
      }
    }

    console.log(`  ✅ ${placeholder}: selected ${selected}/${selectedValues.length}`);

    // Close dropdown by clicking elsewhere
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(200);

    return true;
  }
}

module.exports = { ToidispyFilterAdapter };
