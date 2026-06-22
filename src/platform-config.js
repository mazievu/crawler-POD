/**
 * Platform Configuration — VERIFIED WORKING actors (June 2026)
 * 
 * ✅ = Free/Pay-per-event, tested and working
 * 💰 = Requires rental/paid plan
 */

const PLATFORMS = [
  {
    name: 'facebook_posts',
    displayName: 'Facebook Posts',
    description: 'Facebook post search (requires Apify paid plan)',
    queryType: 'keyword',
    actorId: 'danek/facebook-search-ppr',
    countrySupport: 0,
    icon: '📘',
    color: '#4599ff',
    paid: true,
  },
  {
    name: 'facebook_ads',
    displayName: 'Facebook Ads',
    description: 'Meta Ad Library ads',
    queryType: 'keyword',
    actorId: 'apify/facebook-ads-scraper',
    countrySupport: 1,
    icon: '📢',
    color: '#4599ff',
  },
  {
    name: 'pinterest',
    displayName: 'Pinterest',
    description: 'Pinterest pins and boards',
    queryType: 'keyword',
    actorId: 'automation-lab/pinterest-scraper',
    countrySupport: 0,
    icon: '📌',
    color: '#ff6b6b',
  },
  {
    name: 'amazon',
    displayName: 'Amazon',
    description: 'Amazon products, prices, reviews',
    queryType: 'keyword',
    actorId: 'automation-lab/amazon-scraper',
    countrySupport: 1,
    icon: '📦',
    color: '#ff9900',
  },
  {
    name: 'reddit',
    displayName: 'Reddit',
    description: 'Reddit posts and discussions',
    queryType: 'keyword',
    actorId: 'automation-lab/reddit-scraper',
    countrySupport: 0,
    icon: '🔴',
    color: '#ff6b3d',
  },
  {
    name: 'google_shopping',
    displayName: 'Google Shopping',
    description: 'Google Shopping product listings',
    queryType: 'keyword',
    actorId: 'automation-lab/google-shopping-scraper',
    countrySupport: 1,
    icon: '🛍️',
    color: '#6ba3f7',
  },
  {
    name: 'shopify',
    displayName: 'Shopify',
    description: 'Shopify store products',
    queryType: 'url',
    actorId: 'automation-lab/shopify-scraper',
    countrySupport: 0,
    icon: '🏪',
    color: '#96bf48',
  },
  {
    name: 'tiktok_shop',
    displayName: 'TikTok Shop',
    description: 'TikTok Shop products (requires Apify paid plan)',
    queryType: 'keyword',
    actorId: 'clockworks/tiktok-scraper',
    countrySupport: 0,
    icon: '🛒',
    color: '#ff4d8a',
    paid: true,
  },
  {
    name: 'etsy',
    displayName: 'Etsy',
    description: 'Etsy products (requires Apify paid plan)',
    queryType: 'keyword',
    actorId: 'epctex/etsy-scraper',
    countrySupport: 0,
    icon: '🧡',
    color: '#f1641e',
    paid: true,
  },
  {
    name: 'twitter',
    displayName: 'X / Twitter',
    description: 'Twitter/X tweets (requires Apify paid plan)',
    queryType: 'keyword',
    actorId: 'xquik/x-tweet-scraper',
    countrySupport: 0,
    icon: '🐦',
    color: '#1da1f2',
    paid: true,
  },
  {
    name: 'ebay',
    displayName: 'eBay Sold',
    description: 'eBay sold listings (actor under maintenance)',
    queryType: 'keyword',
    actorId: 'caffein.dev/ebay-sold-listings',
    countrySupport: 1,
    icon: '🏷️',
    color: '#e53238',
    disabled: true,
  },
  {
    name: 'instagram',
    displayName: 'Instagram',
    description: 'Instagram hashtags, profiles, places by keyword (requires paid plan)',
    queryType: 'keyword',
    actorId: 'apify/instagram-search-scraper',
    countrySupport: 0,
    icon: '📸',
    color: '#e4405f',
    paid: true,
  },
  {
    name: 'toidispy',
    displayName: 'Toidispy',
    description: 'Facebook Ads Library via CDP (free, requires login)',
    queryType: 'keyword',
    actorId: 'cdp',
    countrySupport: 0,
    icon: '🔍',
    color: '#00d4aa',
  },
];

function getPlatform(name) {
  return PLATFORMS.find((p) => p.name === name) || null;
}

function validateJobInput(platform, query) {
  if (!platform) return { valid: false, error: 'platform is required' };
  if (!query || !query.trim()) return { valid: false, error: 'query is required' };
  const config = getPlatform(platform);
  if (!config) return { valid: false, error: `Unknown platform: ${platform}` };
  return { valid: true };
}

module.exports = { PLATFORMS, getPlatform, validateJobInput };
