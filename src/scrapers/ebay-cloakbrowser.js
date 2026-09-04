/**
 * eBay Collect — CloakBrowser PRIMARY discovery & detail enrichment.
 *
 * Searches eBay listings directly through a real (CloakBrowser)
 * browser session, paginating until maxItems unique listings are collected,
 * then visits each candidate's product page to extract real metrics:
 * Price, Seller Feedback/Reviews, Sold count, Watchers/Likes, High-res Image.
 */
const { createCloakBrowserSession } = require('../journey/cloakbrowser-session');

const ITEM_ID_PATTERN = /ebay\.[a-z.]+\/itm\/(\d+)|itm\/(\d+)/i;

const CURRENCY_SYMBOLS = {
  '$': 'USD', '€': 'EUR', '£': 'GBP', '₫': 'VND', '¥': 'JPY',
  'AU $': 'AUD', 'C $': 'CAD', 'US $': 'USD'
};

function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const match = String(v ?? '').replace(/,/g, '').match(/([\d.]+)\s*([kmbKMB])?/i);
  if (!match) return 0;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return (parseFloat(match[1]) * multiplier) || 0;
}

function parsePriceFromCard(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const match = clean.match(/(AU\s?\$|C\s?\$|US\s?\$|[$€£₫¥]|USD|EUR|GBP|VND|JPY|AUD|CAD)\s?(\d[\d,.]*)|(\d[\d,.]*)\s?(AU\s?\$|C\s?\$|US\s?\$|[$€£₫¥]|USD|EUR|GBP|VND|JPY|AUD|CAD)/iu);
  if (!match) return { price: 0, currency: 'USD', priceText: clean };
  const symbol = (match[1] || match[4] || '').trim();
  const digits = match[2] || match[3] || '0';
  const currency = CURRENCY_SYMBOLS[symbol] || (symbol.length === 3 ? symbol : 'USD');
  let price = parseFloat(digits.replace(/,/g, '')) || 0;

  // If local currency is VND, convert to approximate USD
  if (currency === 'VND' && price > 1000) {
    price = Number((price / 25400).toFixed(2));
    return { price, currency: 'USD', priceText: `$${price}` };
  }
  return { price: Number(price.toFixed(2)), currency, priceText: clean };
}

const MAX_PAGES_SAFETY = Number(process.env.EBAY_CLOAKBROWSER_MAX_PAGES) || 10;

/**
 * Visits a single eBay listing detail page to extract real metrics:
 * Price, Feedback/Reviews, Sold count, Watchers/Likes, Image, Seller.
 */
async function enrichEbayListingFromDetailPage(page, item) {
  try {
    await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);

    const detail = await page.evaluate(() => {
      const text = document.body.innerText || '';

      const soldMatch = text.match(/([\d,]+)\s*(?:sold|đã bán)/i);
      const watchersMatch = text.match(/([\d,]+)\s*(?:watchers|watching|người theo dõi|theo dõi)/i);
      const feedbackMatch = text.match(/([\d,.]+[kmbKMB]?)\s*(?:feedback score|feedback)/i) || text.match(/\(([\d,.]+[kmbKMB]?)\)\s*[\d.]*%/);
      const reviewsMatch = text.match(/([\d,]+)\s*(?:product ratings|ratings|reviews)/i);

      const pctMatch = text.match(/([\d.]+)%\s*(?:positive|tích cực)/i);
      const starMatch = text.match(/(\d(?:\.\d)?)\s*(?:out of 5 stars|stars|sao)/i);
      const rating = pctMatch ? parseFloat(pctMatch[1]) : (starMatch ? parseFloat(starMatch[1]) : 0);

      const priceEl = document.querySelector('[data-testid="x-price-primary"], .x-price-primary, #prcIsum, .mainPrice, [itemprop="price"]');
      const sellerEl = document.querySelector('[data-testid="str-title"], .x-sellercard-atf__info, .mbg-nw');
      const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
      const titleEl = document.querySelector('h1.x-item-title__mainTitle, h1#itemTitle, h1');

      return {
        title: titleEl ? titleEl.innerText : '',
        priceText: priceEl ? priceEl.innerText : '',
        seller: sellerEl ? sellerEl.innerText.split('\n')[0] : '',
        sold: soldMatch ? soldMatch[1] : null,
        watchers: watchersMatch ? watchersMatch[1] : null,
        feedback: feedbackMatch ? feedbackMatch[1] : null,
        reviews: reviewsMatch ? reviewsMatch[1] : null,
        rating,
        image: ogImg || ''
      };
    });

    if (detail.title) item.title = detail.title.replace(/\s+/g, ' ').trim();
    if (detail.priceText) {
      const priceInfo = parsePriceFromCard(detail.priceText);
      if (priceInfo.price > 0) {
        item.price = priceInfo.price;
        item.priceText = priceInfo.priceText;
        item.currency = priceInfo.currency;
      }
    }
    if (detail.seller) item.author = detail.seller.replace(/By\s+/i, '').trim();

    const soldVal = parseNum(detail.sold || 0);
    if (soldVal > 0) item.soldCount = soldVal;

    const feedbackVal = parseNum(detail.feedback || detail.reviews || 0);
    if (feedbackVal > 0) {
      item.reviews = feedbackVal;
      item.reviewCount = feedbackVal;
    }

    const watchersVal = parseNum(detail.watchers || 0);
    if (watchersVal > 0) item.likes = watchersVal;

    if (detail.image) item.image = detail.image;
    if (detail.rating > 0) item.rating = detail.rating;
  } catch (_err) {
    // Keep search card data on detail navigation failure
  }
}

/**
 * Discovers eBay listings directly using CloakBrowser.
 * @param {object} options
 * @param {string} options.query
 * @param {number} [options.maxItems=30]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.proxy]
 * @param {string} [options.sessionKey]
 * @returns {Promise<{ items: Array, pagesVisited: number, blocked: boolean }>}
 */
async function discoverEbayListingsViaCloakBrowser({ query, maxItems = 30, signal = null, proxy = null, sessionKey = null } = {}) {
  const seen = new Map(); // itemId -> item
  let pagesVisited = 0;
  let blocked = false;
  let session = null;

  try {
    session = await createCloakBrowserSession({
      platform: 'ebay',
      executionToken: sessionKey || `ebay-collect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      proxy,
      headless: true,
      signal
    });

    const page = session.page;
    for (let pageNum = 1; pageNum <= MAX_PAGES_SAFETY && seen.size < maxItems; pageNum++) {
      if (signal?.aborted) break;

      const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&_from=R40&_sacat=0&_pgn=${pageNum}`;
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('.s-card, .s-item, li[data-listingid]', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
      } catch (_navErr) {
        break;
      }

      let rawCards = await page.$$eval('.s-card, .s-item, li[data-listingid], [data-view]', (elements) => {
        const results = [];
        for (const el of elements) {
          const linkEl = el.querySelector('a.s-card__link[href*="/itm/"], a.s-item__link, a[href*="/itm/"]');
          const href = linkEl ? linkEl.href : '';
          if (!href || href.includes('123456')) continue;

          const titleEl = el.querySelector('.s-card__title, .s-item__title, [role="heading"]');
          const title = (titleEl ? titleEl.textContent : '').replace(/\s+/g, ' ').trim();
          if (!title || title.includes('Shop on eBay')) continue;

          const priceEl = el.querySelector('.s-card__price, .s-item__price, [class*="price"]');
          const priceText = (priceEl ? priceEl.textContent : '').replace(/\s+/g, ' ').trim();

          const imgEl = el.querySelector('.s-card__image, .s-item__image img, img');
          const image = imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-retina-src') || '') : '';

          const sellerEl = el.querySelector('.s-card__subtitle, .s-item__seller-info-text, .s-item__seller-info');
          const seller = (sellerEl ? sellerEl.textContent : '').replace(/\s+/g, ' ').trim();

          const text = el.innerText || '';
          const soldMatch = text.match(/([\d,]+)\s*(?:sold|đã bán)/i);
          const watchersMatch = text.match(/([\d,]+)\s*(?:watchers|watching|theo dõi)/i);
          const feedbackMatch = text.match(/\(([\d,.]+[kmbKMB]?)\)\s*[\d.]*%/i) || text.match(/([\d,.]+[kmbKMB]?)\s*(?:feedback)/i);
          const pctMatch = text.match(/([\d.]+)%\s*(?:positive|tích cực)/i);
          const starMatch = text.match(/(\d(?:\.\d)?)\s*(?:out of 5 stars|stars|sao)/i);
          const ratingVal = pctMatch ? parseFloat(pctMatch[1]) : (starMatch ? parseFloat(starMatch[1]) : 0);

          results.push({
            href,
            title,
            priceText,
            image,
            seller,
            soldText: soldMatch ? soldMatch[1] : '',
            watchersText: watchersMatch ? watchersMatch[1] : '',
            feedbackText: feedbackMatch ? feedbackMatch[1] : '',
            ratingVal
          });
        }
        return results;
      });

      pagesVisited++;

      let newOnThisPage = 0;
      for (const card of rawCards) {
        const match = card.href.match(ITEM_ID_PATTERN);
        const itemId = match ? (match[1] || match[2]) : null;
        if (!itemId || seen.has(itemId)) continue;

        const priceInfo = parsePriceFromCard(card.priceText);
        const cleanTitle = card.title
          .replace(/Opens in a new window or tab/gi, '')
          .replace(/^New Listing\s+/i, '')
          .trim();

        const soldCount = parseNum(card.soldText || 0);
        const feedback = parseNum(card.feedbackText || 0);
        const watchers = parseNum(card.watchersText || 0);
        const rating = Number(card.ratingVal || 0);

        seen.set(itemId, {
          platform: 'ebay',
          title: cleanTitle,
          url: card.href.split('?')[0],
          image: card.image,
          price: priceInfo.price,
          priceText: priceInfo.priceText || `$${priceInfo.price}`,
          currency: priceInfo.currency || 'USD',
          itemId,
          listingId: itemId,
          seller: card.seller || 'eBay Seller',
          author: card.seller || 'eBay Seller',
          rating: rating,
          reviews: feedback,
          reviewCount: feedback,
          soldCount: soldCount,
          likes: watchers,
          comments: 0,
          shares: 0,
          views: 0,
          listingStatus: 'sold_or_completed',
          source: 'cloakbrowser'
        });

        newOnThisPage++;
        if (seen.size >= maxItems) break;
      }

      if (newOnThisPage === 0) break;
    }

    // Enrich candidate listings from their product detail pages
    for (const item of seen.values()) {
      if (signal?.aborted) break;
      await enrichEbayListingFromDetailPage(page, item);
    }

  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[eBay CloakBrowser] Discovery error:', err.message);
  } finally {
    if (session) {
      await session.close().catch(() => {});
    }
  }

  return {
    items: Array.from(seen.values()),
    pagesVisited,
    blocked
  };
}

module.exports = {
  discoverEbayListingsViaCloakBrowser,
  parsePriceFromCard
};
