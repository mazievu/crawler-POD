// Main Orchestrator
// Tích hợp SearXNG + Toidispy scraping

const { search: _search, discoverUrls } = require('./searxng'); // eslint-disable-line no-unused-vars

// SearXNG search for URL discovery
async function discoverProductUrls(keyword) {
  console.log(`\n🔍 Discovering URLs for: "${keyword}"`);

  const results = await discoverUrls(keyword);

  const summary = {
    keyword,
    platforms: {},
    totalUrls: 0
  };

  for (const platform of results) {
    summary.platforms[platform.platform] = {
      query: platform.query,
      urlCount: platform.results.length,
      topResults: platform.results.slice(0, 3).map(r => ({
        url: r.url,
        title: r.title
      }))
    };
    summary.totalUrls += platform.results.length;
  }

  return summary;
}

// Save to database via API
async function saveToDatabase(data) {
  const response = await fetch('http://localhost:3000/api/toidispy/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return await response.json();
}

// Main execution
async function main() {
  const keyword = process.argv[2] || 'press on nail';

  try {
    // Step 1: Discover URLs via SearXNG
    console.log('\n📡 Step 1: SearXNG URL Discovery');
    const discovery = await discoverProductUrls(keyword);
    console.log(`Found ${discovery.totalUrls} URLs across ${Object.keys(discovery.platforms).length} platforms`);

    // Step 2: Toidispy scraping (run via CDP separately)
    console.log('\n🕷️ Step 2: Toidispy CDP Scraping');
    console.log('Run this in browser context:');
    console.log('  1. Navigate to https://app.toidispy.com/posts');
    console.log('  2. Fill keyword: "' + keyword + '"');
    console.log('  3. Click Search');
    console.log('  4. Execute scrapePosts() function');
    console.log('  5. Save results via /api/toidispy/import');

    // Step 3: Save discovery results
    console.log('\n💾 Step 3: Saving Results');
    const saveResult = await saveToDatabase({
      query: keyword,
      items: discovery.platforms.facebook?.topResults || []
    });
    console.log(`Saved: ${saveResult.count} items`);

    // Print summary
    console.log('\n📊 Summary:');
    console.log(JSON.stringify(discovery, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

// Export for use
module.exports = { discoverProductUrls, saveToDatabase };

// Run if called directly
if (require.main === module) {
  main();
}
