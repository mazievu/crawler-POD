const path = require('node:path');
const database = require('../src/database');
const { importAnalyticsDirectory } = require('../src/etsy-analytics-import');

const directory = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: node scripts/import-etsy-analytics.js <analytics-folder> [source-label]');
  process.exit(1);
}

const result = importAnalyticsDirectory({
  database,
  directory,
  sourceLabel: process.argv[3] || path.basename(directory),
});

console.log(JSON.stringify({
  runId: result.runId,
  files: result.files,
  shopRows: result.shopRows,
  productRows: result.productRows,
  importedRecords: result.records.length,
  newItems: result.newItems,
  activeItems: result.activeItems,
  droppedItems: result.droppedItems,
}, null, 2));
