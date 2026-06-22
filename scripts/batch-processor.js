// Batch Processing Script
// Chạy nhiều keywords tự động

const { ToidispyAutomation } = require('./toidispy-cdp');
const { discoverProductUrls } = require('./searxng');

// Config
const CONFIG = {
  keywords: [
    'press on nail',
    'custom tshirt',
    'pet portrait',
    'cottagecore',
    'mom life'
  ],
  sections: ['posts', 'ads'],
  delayBetweenKeywords: 5000, // 5 seconds
  delayBetweenSections: 3000, // 3 seconds
  maxScrolls: 3
};

// Sleep helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Main batch processor
async function batchProcess(options = {}) {
  const {
    keywords = CONFIG.keywords,
    sections = CONFIG.sections,
    useSearxng = true
  } = options;

  console.log('\n🚀 Batch Processing Started');
  console.log(`📝 Keywords: ${keywords.length}`);
  console.log(`📌 Sections: ${sections.join(', ')}`);

  const results = {
    totalItems: 0,
    byKeyword: {},
    bySection: {},
    errors: []
  };

  const auto = new ToidispyAutomation();

  try {
    // Connect to Chrome
    const connected = await auto.connect();
    if (!connected) {
      throw new Error('Cannot connect to Chrome. Run with: chrome.exe --remote-debugging-port=9222');
    }

    // Process each keyword
    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i];
      console.log(`\n${'='.repeat(50)}`);
      console.log(`📌 Processing [${i + 1}/${keywords.length}]: "${keyword}"`);
      console.log('='.repeat(50));

      results.byKeyword[keyword] = { posts: 0, ads: 0, searxng: 0 };

      // Step 1: SearXNG URL Discovery (optional)
      if (useSearxng) {
        try {
          console.log('\n🔍 Step 1: SearXNG URL Discovery');
          const discovery = await discoverProductUrls(keyword);
          results.byKeyword[keyword].searxng = discovery.totalUrls;
          console.log(`   Found ${discovery.totalUrls} URLs across ${Object.keys(discovery.platforms).length} platforms`);
        } catch (err) {
          console.log(`   ⚠️ SearXNG error: ${err.message}`);
          results.errors.push({ keyword, error: `SearXNG: ${err.message}` });
        }
      }

      // Step 2: Toidispy scraping
      for (const section of sections) {
        try {
          console.log(`\n📊 Step 2: Toidispy ${section.toUpperCase()}`);

          const items = await auto.run(keyword, {
            section,
            maxScrolls: CONFIG.maxScrolls,
            saveToDb: true
          });

          // Update results
          results.byKeyword[keyword][section] = items.length;
          results.bySection[section] = (results.bySection[section] || 0) + items.length;
          results.totalItems += items.length;

          console.log(`   ✅ Scraped ${items.length} items from ${section}`);

        } catch (err) {
          console.log(`   ❌ Error scraping ${section}: ${err.message}`);
          results.errors.push({ keyword, section, error: err.message });
        }

        // Delay between sections
        if (sections.indexOf(section) < sections.length - 1) {
          console.log(`   ⏳ Waiting ${CONFIG.delayBetweenSections / 1000}s...`);
          await sleep(CONFIG.delayBetweenSections);
        }
      }

      // Delay between keywords
      if (i < keywords.length - 1) {
        console.log(`\n⏳ Waiting ${CONFIG.delayBetweenKeywords / 1000}s before next keyword...`);
        await sleep(CONFIG.delayBetweenKeywords);
      }
    }

  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    results.errors.push({ error: err.message });
  } finally {
    await auto.close();
  }

  // Print final summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 BATCH PROCESSING COMPLETE');
  console.log('='.repeat(50));
  console.log(`\n📈 Summary:`);
  console.log(`- Total items scraped: ${results.totalItems}`);
  console.log(`- Keywords processed: ${keywords.length}`);
  console.log(`- Errors: ${results.errors.length}`);

  console.log(`\n📌 By Section:`);
  for (const [section, count] of Object.entries(results.bySection)) {
    console.log(`   - ${section}: ${count} items`);
  }

  console.log(`\n📝 By Keyword:`);
  for (const [keyword, data] of Object.entries(results.byKeyword)) {
    console.log(`   - "${keyword}":`);
    console.log(`     Posts: ${data.posts} | Ads: ${data.ads} | SearXNG URLs: ${data.searxng}`);
  }

  if (results.errors.length > 0) {
    console.log(`\n⚠️ Errors:`);
    results.errors.forEach(err => {
      console.log(`   - ${err.keyword || 'N/A'}: ${err.error}`);
    });
  }

  return results;
}

// CLI runner
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const options = {
    keywords: args.length > 0 ? args : CONFIG.keywords,
    sections: CONFIG.sections,
    useSearxng: true
  };

  // Check for --no-searxng flag
  if (args.includes('--no-searxng')) {
    options.useSearxng = false;
    options.keywords = options.keywords.filter(k => k !== '--no-searxng');
  }

  // Check for --posts-only flag
  if (args.includes('--posts-only')) {
    options.sections = ['posts'];
    options.keywords = options.keywords.filter(k => k !== '--posts-only');
  }

  // Check for --ads-only flag
  if (args.includes('--ads-only')) {
    options.sections = ['ads'];
    options.keywords = options.keywords.filter(k => k !== '--ads-only');
  }

  await batchProcess(options);
}

// Export
module.exports = { batchProcess, CONFIG };

// Run if called directly
if (require.main === module) {
  main();
}
