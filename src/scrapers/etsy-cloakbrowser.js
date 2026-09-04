/**
 * Etsy Collect — CloakBrowser PRIMARY discovery & product detail enrichment.
 *
 * Searches Etsy directly through a real (CloakBrowser) browser session,
 * paginating until maxItems unique listings are collected, then visiting each
 * listing's detail page to extract 100% real metrics (Rating, Reviews,
 * Favorites/Likes, Total Sales/Sold, Price, High-res Image).
 */
const { createEverbeeContextSession } = require('../marketplaces/everbee-executor');

const LISTING_ID_PATTERN = /etsy\.com\/listing\/(\d+)/i;
const CURRENCY_SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₫': 'VND', '¥': 'JPY' };

function parsePriceFromCard(text) {
  const match = String(text || '').match(/([$€£₫¥])\s?(\d[\d,.]*)|(\d[\d,.]*)\s?([$€£₫¥])/u);
  if (!match) return { price: 0, currency: 'USD' };
  const symbol = match[1] || match[4];
  const digits = match[2] || match[3];
  let price = parseFloat(digits.replace(/,/g, '')) || 0;
  const currency = CURRENCY_SYMBOLS[symbol] || 'USD';

  // If local currency is VND, convert to approximate USD
  if (currency === 'VND' && price > 1000) {
    price = Number((price / 25400).toFixed(2));
    return { price, currency: 'USD' };
  }
  return { price: Number(price.toFixed(2)), currency };
}

const MAX_PAGES_SAFETY = Number(process.env.ETSY_CLOAKBROWSER_MAX_PAGES) || 10;

/**
 * Visits a single Etsy listing detail page to extract real metrics:
 * Rating, Review count, Favorites (likes), Sales (sold), Price, High-res Image.
 */
async function enrichListingFromDetailPage(page, item) {
  try {
    await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);

    const detail = await page.evaluate(() => {
      // 1. Extract JSON-LD structured data
      const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      let productJson = null;
      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          if (Array.isArray(data)) {
            const found = data.find(i => i['@type'] === 'Product');
            if (found) { productJson = found; break; }
          } else if (data['@type'] === 'Product') {
            productJson = data;
            break;
          }
        } catch {}
      }

      const text = document.body.innerText || '';
      const favMatch = text.match(/([\d,]+)\s*(?:favorites|favourites|người yêu thích)/i);
      const salesMatch = text.match(/([\d,]+)\s*(?:sales|đã bán)/i);

      let rating = 0;
      let reviewCount = 0;
      let price = 0;
      let currency = 'USD';
      let title = '';
      let image = '';
      let shopName = '';

      if (productJson) {
        title = productJson.name || '';
        if (productJson.aggregateRating) {
          rating = parseFloat(productJson.aggregateRating.ratingValue) || 0;
          reviewCount = parseInt(productJson.aggregateRating.reviewCount, 10) || 0;
        }
        if (productJson.brand) {
          shopName = productJson.brand.name || '';
        }
        if (productJson.image) {
          if (Array.isArray(productJson.image)) {
            image = typeof productJson.image[0] === 'string' ? productJson.image[0] : (productJson.image[0]?.contentURL || productJson.image[0]?.thumbnail || '');
          } else if (typeof productJson.image === 'string') {
            image = productJson.image;
          } else if (productJson.image?.contentURL) {
            image = productJson.image.contentURL;
          }
        }
        if (productJson.offers) {
          const offers = Array.isArray(productJson.offers) ? productJson.offers[0] : productJson.offers;
          const rawPrice = parseFloat(offers.price) || 0;
          const rawCurrency = offers.priceCurrency || 'USD';
          if (rawCurrency === 'VND' && rawPrice > 1000) {
            price = Number((rawPrice / 25400).toFixed(2));
            currency = 'USD';
          } else {
            price = Number(rawPrice.toFixed(2));
            currency = rawCurrency;
          }
        }
      }

      // Fallbacks if JSON-LD missing or incomplete
      if (!rating) {
        const rMatch = text.match(/(\d(?:\.\d)?)\s*(?:out of 5 stars|stars|sao|\/5)/i);
        if (rMatch) rating = parseFloat(rMatch[1]);
      }
      if (!reviewCount) {
        const revMatch = text.match(/\((\d[\d,.]*)\s*(?:reviews|đánh giá)?\)/i);
        if (revMatch) reviewCount = parseInt(revMatch[1].replace(/[,.]/g, ''), 10);
      }

      const favorites = favMatch ? parseInt(favMatch[1].replace(/[,.]/g, ''), 10) : 0;
      const sales = salesMatch ? parseInt(salesMatch[1].replace(/[,.]/g, ''), 10) : 0;

      return {
        title,
        rating,
        reviewCount,
        favorites,
        sales,
        price,
        currency,
        shopName,
        image
      };
    });

    if (detail.title) item.title = detail.title;
    if (detail.rating) item.rating = detail.rating;
    if (detail.reviewCount) {
      item.reviewCount = detail.reviewCount;
      item.reviews = detail.reviewCount;
    }
    if (detail.favorites) item.likes = detail.favorites;
    if (detail.sales) item.soldCount = detail.sales;
    if (detail.price) {
      item.price = detail.price;
      item.currency = detail.currency;
    }
    if (detail.shopName) item.author = detail.shopName;
    if (detail.image) item.image = detail.image;
  } catch (_err) {
    // Keep search card data on detail navigation failure
  }
}

/**
 * @returns {{ items: Array, pagesVisited: number, blocked: boolean }}
 */
async function discoverEtsyListingsViaCloakBrowser({ query, maxItems = 30, signal = null, proxy = null, sessionKey = null } = {}) {
  const seen = new Map();
  let pagesVisited = 0;
  let blocked = false;
  let session = null;

  try {
    session = await createEverbeeContextSession({
      platform: 'etsy',
      sessionKey: null,
      proxy,
      headless: true,
    });

    const page = await session.context.newPage();
    try {
      for (let pageNum = 1; pageNum <= MAX_PAGES_SAFETY && seen.size < maxItems; pageNum++) {
        if (signal?.aborted) break;

        const url = pageNum === 1
          ? `https://www.etsy.com/search?q=${encodeURIComponent(query)}`
          : `https://www.etsy.com/search?q=${encodeURIComponent(query)}&ref=pagination&page=${pageNum}`;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(1500);
        } catch (_navErr) {
          break;
        }

        const cards = await page.$$eval('a[href*="/listing/"]', (anchors) => {
          const results = [];
          const seenIds = new Set();
          for (const a of anchors) {
            try {
              const href = a.href || '';
              const idMatch = href.match(/listing\/(\d+)/);
              if (!idMatch) continue;
              const listingId = idMatch[1];
              if (seenIds.has(listingId)) continue;

              const container = a.closest('li, div[data-listing-id], [data-palette-listing-id]') || a.parentElement;
              const img = container ? container.querySelector('img') : a.querySelector('img');
              const priceEl = container ? container.querySelector('[class*="price"], .currency-value') : null;
              const titleEl = container ? container.querySelector('h3, h2, [class*="title"]') : null;
              const ratingEl = container ? container.querySelector('[aria-label*="star"], [aria-label*="out of 5"], .wt-rating, .screen-reader-only') : null;
              const reviewsEl = container ? container.querySelector('[class*="rating-count"], [class*="reviews-count"], .wt-text-caption') : null;
              const shopEl = container ? container.querySelector('[class*="shop-name"], [class*="seller"], a[href*="/shop/"]') : null;

              const text = container ? container.innerText : '';
              let title = (titleEl ? titleEl.innerText : a.getAttribute('title') || a.innerText || '').replace(/\s+/g, ' ').trim();
              if (/^(Bestseller|Popular now|Ad\b)/i.test(title)) {
                title = title.replace(/^(Bestseller|Popular now|Ad[・\s]*)/gi, '').trim();
              }

              let rating = 0;
              let reviewCount = 0;
              const ratingMatch = text.match(/(\d(?:\.\d)?)\s*(?:out of 5|stars|sao|\/5)/i) || ratingEl?.getAttribute('aria-label')?.match(/(\d(?:\.\d)?)/);
              if (ratingMatch) rating = parseFloat(ratingMatch[1]);

              const reviewMatch = text.match(/\((\d[\d,.]*)\)/) || reviewsEl?.innerText?.match(/(\d[\d,.]*)/);
              if (reviewMatch) reviewCount = parseInt(reviewMatch[1].replace(/[,.]/g, ''), 10);

              const imgSrc = (img && (img.src || img.getAttribute('data-src') || img.getAttribute('src'))) || '';
              const priceText = (priceEl ? (priceEl.innerText || priceEl.textContent) : '') || '';

              seenIds.add(listingId);
              results.push({
                listingId,
                title: title || 'Etsy Product',
                url: href.split('?')[0],
                image: imgSrc,
                priceText: priceText.replace(/\s+/g, ' ').trim(),
                shopName: shopEl ? shopEl.innerText.replace(/By\s+/i, '').trim() : '',
                rating,
                reviewCount
              });
            } catch (_err) {}
          }
          return results;
        });

        pagesVisited++;

        if (cards.length === 0 && seen.size === 0) {
          const title = await page.title().catch(() => '');
          if (/captcha|verify you are human|unusual traffic|pardon our interruption|just a moment/i.test(title)) {
            blocked = true;
            break;
          }
        }

        let newOnThisPage = 0;
        for (const card of cards) {
          const listingId = card.listingId;
          if (!listingId || seen.has(listingId)) continue;

          const priceInfo = parsePriceFromCard(card.priceText);
          const rating = Number(card.rating || 0);
          const reviews = Number(card.reviewCount || 0);

          seen.set(listingId, {
            platform: 'etsy',
            title: card.title,
            url: card.url,
            image: card.image,
            price: priceInfo.price,
            priceText: card.priceText,
            currency: priceInfo.currency,
            author: card.shopName,
            rating: rating,
            reviewCount: reviews,
            reviews: reviews,
            soldCount: 0,
            likes: reviews,
            comments: 0,
            shares: 0,
            views: 0,
            listingId,
            source: 'cloakbrowser'
          });
          newOnThisPage++;
          if (seen.size >= maxItems) break;
        }

        if (newOnThisPage === 0) break;
      }

      // Enrich collected candidate listings with exact details from product pages
      for (const item of seen.values()) {
        if (signal?.aborted) break;
        await enrichListingFromDetailPage(page, item);
      }

    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    if (session) await session.close().catch(() => {});
  }

  return { items: Array.from(seen.values()), pagesVisited, blocked };
}

module.exports = { discoverEtsyListingsViaCloakBrowser };
