/**
 * Free product discovery fallback. It returns indexed merchant listings with
 * price and product images when the paid Google Shopping actor is unavailable.
 */
const { discoverMarketplaceItems } = require('./search-discovery');

async function scrape(query, options = {}) {
  return discoverMarketplaceItems('google_shopping', query, options);
}

module.exports = { scrape };
