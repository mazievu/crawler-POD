const { search } = require('../../scripts/searxng');

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
  return false;
}

async function discoverMarketplaceItems(platform, query, options = {}) {
  const limit = options.limit || 30;
  const siteQuery = platform === 'etsy'
    ? 'site:etsy.com/listing ' + query
    : 'site:ebay.com/itm ' + query + ' sold completed';

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

    items.push({
      platform,
      title,
      url: r.url,
      price: price.price,
      priceText: price.priceText,
      currency: price.priceText.startsWith('$') ? 'USD' : '',
      image: '',
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
  return { items };
}

module.exports = { discoverMarketplaceItems };
