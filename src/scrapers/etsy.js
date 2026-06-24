/**
 * Etsy Scraper
 * Free-first source: SearXNG search discovery for public Etsy listing pages.
 *
 * Etsy search/category pages are protected by DataDome in this environment,
 * so this avoids the developer API and uses indexed public listing results.
 */

const { discoverMarketplaceItems } = require('./search-discovery');

async function scrape(query, options = {}) {
  const result = await discoverMarketplaceItems('etsy', query, options);
  const items = result.items.map(item => ({
    platform: 'etsy',
    title: item.title,
    url: item.url,
    price: item.price,
    priceText: item.priceText,
    currency: item.currency,
    image: item.image,
    description: item.description,
    shopName: '',
    listingId: item.listingId,
    tags: '',
    materials: '',
    source: item.source,
    engine: item.engine,
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
  }));

  return { items };
}

module.exports = { scrape };
