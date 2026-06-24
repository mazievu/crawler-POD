/**
 * eBay Scraper
 * Free-first order:
 *   1. eBay Browse API when free developer credentials are available.
 *   2. Public search page fallback through Playwright.
 */

const { launchStealth } = require('../../anti-bot/stealth-launcher');

let cachedToken = null;

function hasBrowseApiCredentials() {
  return Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
}

async function getBrowseApiToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;

  const creds = Buffer.from(process.env.EBAY_CLIENT_ID + ':' + process.env.EBAY_CLIENT_SECRET).toString('base64');
  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
  });

  if (!resp.ok) throw new Error('AUTH_REQUIRED: eBay token request failed HTTP ' + resp.status);
  const body = await resp.json();
  if (!body.access_token) throw new Error('AUTH_REQUIRED: eBay token response missing access_token');

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + ((body.expires_in || 7200) * 1000),
  };
  return cachedToken.value;
}

function mapBrowseItem(d) {
  const price = d.price || {};
  const shipping = d.shippingOptions?.[0]?.shippingCost || {};
  return {
    platform: 'ebay',
    title: d.title || '',
    url: d.itemWebUrl || '',
    price: parseFloat(price.value || 0) || 0,
    priceText: price.value ? `${price.value} ${price.currency || ''}`.trim() : '',
    currency: price.currency || '',
    image: d.image?.imageUrl || d.thumbnailImages?.[0]?.imageUrl || '',
    seller: d.seller?.username || '',
    sellerFeedback: d.seller?.feedbackScore || 0,
    shipping: shipping.value ? `${shipping.value} ${shipping.currency || ''}`.trim() : '',
    condition: d.condition || '',
    buyingOptions: Array.isArray(d.buyingOptions) ? d.buyingOptions.join(', ') : '',
    sold: '',
    likes: 0,
    comments: 0,
    shares: 0,
    views: 0,
  };
}

async function scrapeBrowseApi(query, options) {
  options = options || {};
  const limit = Math.min(options.limit || 30, 200);
  const token = await getBrowseApiToken();
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });

  const resp = await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?' + params.toString(), {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': options.marketplace || 'EBAY_US',
    },
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('AUTH_REQUIRED: eBay Browse API credentials missing approval or expired');
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': eBay Browse API search failed');

  const body = await resp.json();
  const items = (body.itemSummaries || []).map(mapBrowseItem).filter(i => i.title && i.url).slice(0, limit);
  if (!items.length) throw new Error('EMPTY_RESULT: no eBay Browse API items parsed');
  return { items };
}

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
  if (hasBrowseApiCredentials()) return scrapeBrowseApi(query, options);
  return scrapePublic(query, options);
}

module.exports = { scrape };
