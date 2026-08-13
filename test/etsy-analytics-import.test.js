const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseCsv,
  buildAnalyticsRecords,
  loadAnalyticsDirectory,
  importAnalyticsDirectory,
} = require('../src/etsy-analytics-import');
const db = require('../src/database');

const SHOP_CSV = `Shop ID,Shop Name,Shop Logo,Sales (30 days),Total Sales,Revenue (30 days),Total Revenue,Shop Age,Review Rate,Review Average,Category,Active Listings Count,Currency Code,Conversion Rate,Digital Listings Count,Number of Favorers,Review Count,Shop Location Country ISO,Shop URL\n9403338,PillowFever,https://images.example.test/pillow.jpg,161,27744,15295,1710535,146 Mo,19.55,4.9,Home & Living,497,USD,0.95,0,17349,5425,US,https://www.etsy.com/shop/PillowFever`;
const PRODUCT_CSV = `Product Name,Product Link,Shop Name,Shop Link,Price,Est. Sales,Est. Revenue,Growth Rate,Est. Total Sales,Total Reviews,Listing Age,Total Favorites,Avg. Reviews,Total Views,Category,Tags\n"College Logo, Engraved Tumbler",https://www.etsy.com/listing/1869036938/college-tumbler,PillowFever,https://www.etsy.com/shop/PillowFever,21.99,31,700,-100,120,8,16 Mo.,23,1,1557,Home & Living,"college tumbler, graduation gift"`;

test('parses quoted CSV fields without splitting commas inside product names or tags', () => {
  const [product] = parseCsv(PRODUCT_CSV);

  assert.equal(product['Product Name'], 'College Logo, Engraved Tumbler');
  assert.equal(product.Tags, 'college tumbler, graduation gift');
});

test('converts shop and product analytics to searchable snapshot records', () => {
  const records = buildAnalyticsRecords({
    shops: parseCsv(SHOP_CSV),
    products: parseCsv(PRODUCT_CSV),
    sourceLabel: '2026-07-25',
  });

  assert.equal(records.length, 2);
  const shop = records.find((record) => record.kind === 'etsy_shop_analytics');
  const product = records.find((record) => record.kind === 'etsy_product_analytics');

  assert.deepEqual(
    { title: shop.title, author: shop.author, url: shop.url, soldCount: shop.soldCount, views: shop.views },
    {
      title: 'Shop: PillowFever', author: 'PillowFever', url: 'https://www.etsy.com/shop/PillowFever', soldCount: '161', views: '497',
    },
  );
  assert.deepEqual(
    { title: product.title, author: product.author, url: product.url, price: product.price, soldCount: product.soldCount, views: product.views },
    {
      title: 'College Logo, Engraved Tumbler', author: 'PillowFever', url: 'https://www.etsy.com/listing/1869036938/college-tumbler', price: '21.99', soldCount: '31', views: '1557',
    },
  );
});

test('deduplicates repeated export rows by their Etsy URLs', () => {
  const products = parseCsv(`${PRODUCT_CSV}\n"College Logo, Engraved Tumbler",https://www.etsy.com/listing/1869036938/college-tumbler,PillowFever,https://www.etsy.com/shop/PillowFever,21.99,31,700,-100,120,8,16 Mo.,23,1,1557,Home & Living,"college tumbler, graduation gift"`);
  const records = buildAnalyticsRecords({ shops: [], products, sourceLabel: '2026-07-25' });

  assert.equal(records.length, 1);
});

test('loads nested CSV exports and imports the normalized records in one Etsy run', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-analytics-'));
  const nestedDirectory = path.join(directory, 'nested');
  fs.mkdirSync(nestedDirectory);
  fs.writeFileSync(path.join(directory, 'shops.csv'), SHOP_CSV);
  fs.writeFileSync(path.join(nestedDirectory, 'products.csv'), PRODUCT_CSV);
  fs.writeFileSync(path.join(directory, 'ignored.csv'), 'Unknown,Columns\nvalue,other');

  const calls = [];
  const database = {
    createRun(input) { calls.push(['createRun', input]); return { id: 77 }; },
    insertSnapshots(...input) { calls.push(['insertSnapshots', input]); return { newItems: 2, activeItems: 0, droppedItems: 0 }; },
    updateRun(...input) { calls.push(['updateRun', input]); },
  };

  try {
    const loaded = loadAnalyticsDirectory(directory, 'fixture');
    const imported = importAnalyticsDirectory({ database, directory, sourceLabel: 'fixture' });

    assert.deepEqual({ files: loaded.files, shopRows: loaded.shopRows, productRows: loaded.productRows, records: loaded.records.length }, { files: 3, shopRows: 1, productRows: 1, records: 2 });
    assert.equal(imported.runId, 77);
    assert.equal(calls[1][1][3].length, 2);
    assert.deepEqual(calls[2], ['updateRun', [77, { status: 'done', newItems: 2, activeItems: 0, droppedItems: 0 }]]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('latest snapshots include imported analytics records without a product image', () => {
  const query = `etsy-analytics-no-image-${Date.now()}`;
  const run = db.createRun({ platform: 'etsy', query, maxItems: 1 });
  try {
    db.insertSnapshots(run.id, 'etsy', query, [{
      title: 'Image-free imported listing',
      url: `https://www.etsy.com/listing/${Date.now()}`,
      author: 'Analytics Shop',
      price: '21.99',
    }]);
    db.updateRun(run.id, { status: 'done' });

    assert.equal(db.getLatestSnapshots().some((item) => item.title === 'Image-free imported listing'), true);
  } finally {
    db.deleteRun(run.id);
  }
});

test('latest snapshot search returns only matching imported product or shop records', () => {
  const marker = `needle-${Date.now()}`;
  const query = `etsy-analytics-search-${marker}`;
  const run = db.createRun({ platform: 'etsy', query, maxItems: 2 });
  try {
    db.insertSnapshots(run.id, 'etsy', query, [
      { title: `Analytics search ${marker} tumbler`, url: `https://www.etsy.com/listing/${Date.now()}`, author: 'Needle Shop' },
      { title: 'Unrelated blanket', url: `https://www.etsy.com/listing/${Date.now() + 1}`, author: 'Blanket Shop' },
    ]);
    db.updateRun(run.id, { status: 'done' });

    const results = db.getLatestSnapshots({ search: marker, limit: 10 });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, `Analytics search ${marker} tumbler`);
  } finally {
    db.deleteRun(run.id);
  }
});
