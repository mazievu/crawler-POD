const { runUserJourney } = require('../src/journey/user-journey-runner');
const { createMarketplaceCaptureScheduler } = require('../src/marketplaces/capture-scheduler');
const { scrape: etsyScrape } = require('../src/scrapers/etsy');
const { captureMarketplaceHtml } = require('../src/marketplaces/html-capture');
const db = require('../src/database');

const HOT_KEYWORDS = [
  'trending press on nails',
  'custom press on nails',
  'y2k press on nails',
  'handmade press on nails'
];

async function runHotNailsCollector() {
  console.log('=======================================================');
  console.log('🚀 STARTING HOT POD NAILS AUTOMATED COLLECTION & JOURNEYS');
  console.log('Keywords:', HOT_KEYWORDS.join(' | '));
  console.log('=======================================================');

  const results = [];

  for (const keyword of HOT_KEYWORDS) {
    console.log(`\n-------------------------------------------------------`);
    console.log(`▶ Executing User Journey & Capture for Keyword: '${keyword}' (Target: 20 products)`);
    console.log(`-------------------------------------------------------`);

    // 1. Run User Journey Session
    try {
      const summary = await runUserJourney({
        platform: 'etsy',
        keyword,
        maxProducts: 20
      });
      console.log(`✅ User Journey Completed for '${keyword}': ${summary.productsCollectedCount} products saved.`);
      results.push({ keyword, type: 'user_journey', status: summary.status, count: summary.productsCollectedCount });
    } catch (err) {
      console.error(`❌ User Journey Error for '${keyword}':`, err.message);
    }

    // 2. Run Scheduled Keyword Capture Flow
    try {
      const scheduler = createMarketplaceCaptureScheduler({
        discover: async (query, opts) => {
          const res = await etsyScrape(query, { maxItems: opts.limit });
          return { items: res.items || [] };
        },
        capture: async (params) => {
          return await captureMarketplaceHtml(params);
        },
        markComplete: async (id, summary) => {
          console.log(`📋 Schedule Capture Complete for '${keyword}':`, summary);
        }
      });

      const schResult = await scheduler.run({
        id: Date.now() % 100000,
        platform: 'etsy',
        keyword,
        max_listings: 20,
        account_id: null,
        variant_mode: 'base',
        max_variants: 0
      });

      results.push({ keyword, type: 'schedule_capture', ...schResult });
    } catch (err) {
      console.error(`❌ Schedule Capture Error for '${keyword}':`, err.message);
    }
  }

  console.log('\n=======================================================');
  console.log('🎉 ALL HOT NAILS POD JOURNEYS & CAPTURES COMPLETED!');
  console.log('Summary:', JSON.stringify(results, null, 2));
  console.log('=======================================================');
}

runHotNailsCollector().catch(console.error);
