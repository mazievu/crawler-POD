const { search } = require('../../scripts/searxng');
const { cleanImageUrl } = require('../image-utils');

function cleanText(value, maxLength = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function parsePrice(text) {
  const match = cleanText(text).match(/([$€£]\s?\d[\d,.]*)/);
  if (!match) return { price: 0, priceText: '' };
  return {
    price: parseFloat(match[1].replace(/[^0-9.]/g, '')) || 0,
    priceText: match[1],
  };
}

function normalizePriceNumber(numberText) {
  const lastComma = numberText.lastIndexOf(',');
  const lastDot = numberText.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    return numberText
      .replace(new RegExp('\\' + thousandsSeparator, 'g'), '')
      .replace(decimalSeparator, '.');
  }

  if (lastComma > -1) {
    const decimals = numberText.length - lastComma - 1;
    return decimals > 0 && decimals <= 2
      ? numberText.replace(/\./g, '').replace(',', '.')
      : numberText.replace(/,/g, '');
  }

  return numberText.replace(/,/g, '');
}

function parseSearchPrice(text) {
  const match = cleanText(text).match(/([$\u20ac\u00a3]\s?\d[\d,.]*)/u);
  if (!match) return { price: 0, priceText: '' };
  const numberText = match[1].replace(/[$\u20ac\u00a3\s]/gu, '');
  const normalized = normalizePriceNumber(numberText);
  return {
    price: parseFloat(normalized.replace(/[^0-9.]/g, '')) || 0,
    priceText: match[1],
  };
}

function normalizeTitle(platform, title) {
  return cleanText(title)
    .replace(/\s+-\s+Etsy$/i, '')
    .replace(/\s+\|\s+eBay$/i, '')
    .replace(/\s+-\s+eBay$/i, '')
    .replace(/\s+\.\.\.$/, '');
}

function itemIdFromUrl(platform, url) {
  if (platform === 'google_shopping') return String(url || '');
  const pattern = platform === 'etsy'
    ? /etsy\.com\/listing\/(\d+)/i
    : /ebay\.com\/itm\/(\d+)/i;
  const match = String(url || '').match(pattern);
  return match ? match[1] : '';
}

function isPlatformUrl(platform, url) {
  const text = String(url || '');
  if (platform === 'etsy') return /etsy\.com\/listing\/\d+/i.test(text);
  if (platform === 'ebay') return /ebay\.com\/itm\/\d+/i.test(text);
  if (platform === 'google_shopping') return /^https?:\/\//i.test(text) && !/google\.[^/]+\/(?:search|shopping)/i.test(text);
  return false;
}

function isMerchantResult(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !/(?:wikipedia|britannica|youtube|facebook|instagram|pinterest|reddit|x\.com|twitter\.com)$/i.test(host)
      && !/(?:wikipedia|britannica|youtube|facebook|instagram|pinterest|reddit|x\.com|twitter\.com)\./i.test(host);
  } catch {
    return false;
  }
}

function imageFromSearchResult(result) {
  return cleanImageUrl(
    result.img_src || result.image || result.imageUrl || result.thumbnail || result.thumbnailUrl || ''
  );
}

async function imageFromProductPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!response.ok) return '';
    const html = await response.text();
    const match = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    return cleanImageUrl(match?.[1] || '');
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichImages(items) {
  const concurrency = 4;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      if (!items[index].image) items[index].image = await imageFromProductPage(items[index].url);
    }
  });
  await Promise.all(workers);
  return items;
}

async function discoverMarketplaceItems(platform, query, options = {}) {
  const limit = options.limit || 30;
  const siteQuery = platform === 'etsy'
    ? 'site:etsy.com/listing ' + query
    : platform === 'ebay'
      ? 'site:ebay.com/itm ' + query + ' sold completed'
      : query + ' product price buy';

  const result = await search(siteQuery, {
    engines: options.engines || 'google,bing,duckduckgo',
    categories: 'general',
  });

  const seen = new Set();
  const items = [];

  for (const r of result.results || []) {
    if (!isPlatformUrl(platform, r.url)) continue;
    const id = itemIdFromUrl(platform, r.url);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const title = normalizeTitle(platform, r.title);
    const description = cleanText(r.content, 500);
    const price = parseSearchPrice(r.content);

    // General web results are only useful as a Google Shopping fallback when
    // they clearly represent a priced item from a merchant, not an article.
    if (platform === 'google_shopping' && (!price.price || !isMerchantResult(r.url))) continue;

    items.push({
      platform,
      title,
      url: r.url,
      price: price.price,
      priceText: price.priceText,
      currency: price.priceText.startsWith('$') ? 'USD' : '',
      image: imageFromSearchResult(r),
      description,
      listingId: platform === 'etsy' ? id : undefined,
      itemId: platform === 'ebay' ? id : undefined,
      listingStatus: platform === 'ebay' ? 'sold_or_completed_search' : undefined,
      source: 'searxng',
      engine: r.engine || '',
      likes: 0,
      comments: 0,
      shares: 0,
      views: 0,
    });

    if (items.length >= limit) break;
  }

  if (!items.length) throw new Error('EMPTY_RESULT: no ' + platform + ' items found via search discovery');
  await enrichImages(items);
  return { items };
}

module.exports = { discoverMarketplaceItems, imageFromSearchResult, isMerchantResult };
