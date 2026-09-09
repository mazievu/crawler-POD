const fs = require('node:fs');
const path = require('node:path');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < String(text || '').length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, '').trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function cleanText(value) {
  return String(value || '').trim();
}

function uniqueKey(...values) {
  return values.map((value) => cleanText(value).toLowerCase()).join('|');
}

function buildAnalyticsRecords({ shops = [], products = [], sourceLabel = '' }) {
  const records = [];
  const seenShops = new Set();
  const seenProducts = new Set();

  for (const row of shops) {
    const shopName = cleanText(row['Shop Name']);
    const shopUrl = cleanText(row['Shop URL']);
    if (!shopName && !shopUrl) continue;
    const key = uniqueKey(shopUrl, shopName);
    if (seenShops.has(key)) continue;
    seenShops.add(key);
    records.push({
      kind: 'etsy_shop_analytics',
      sourceLabel,
      title: `Shop: ${shopName || shopUrl}`,
      url: shopUrl,
      image: cleanText(row['Shop Logo']),
      author: shopName,
      price: '0',
      rating: cleanText(row['Review Average']),
      reviews: cleanText(row['Review Count']),
      soldCount: cleanText(row['Sales (30 days)']),
      likes: cleanText(row['Number of Favorers']),
      comments: cleanText(row['Review Count']),
      shares: '0',
      views: cleanText(row['Active Listings Count']),
      analytics: row,
    });
  }

  for (const row of products) {
    const title = cleanText(row['Product Name']);
    const url = cleanText(row['Product Link']);
    const author = cleanText(row['Shop Name']);
    if (!title && !url) continue;
    const key = uniqueKey(url, author, title);
    if (seenProducts.has(key)) continue;
    seenProducts.add(key);
    records.push({
      kind: 'etsy_product_analytics',
      sourceLabel,
      title,
      url,
      image: '',
      author,
      price: cleanText(row.Price),
      rating: cleanText(row['Avg. Reviews']),
      reviews: cleanText(row['Total Reviews']),
      soldCount: cleanText(row['Est. Sales']),
      likes: cleanText(row['Total Favorites']),
      comments: cleanText(row['Total Reviews']),
      shares: '0',
      views: cleanText(row['Total Views']),
      analytics: row,
    });
  }

  return records;
}

function csvFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return csvFiles(filePath);
    return entry.isFile() && path.extname(entry.name).toLowerCase() === '.csv' ? [filePath] : [];
  });
}

function loadAnalyticsDirectory(directory, sourceLabel = path.basename(directory)) {
  const shops = [];
  const products = [];
  const files = csvFiles(directory);

  for (const filePath of files) {
    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    if (!rows.length) continue;
    if (Object.hasOwn(rows[0], 'Product Name')) products.push(...rows);
    else if (Object.hasOwn(rows[0], 'Shop Name')) shops.push(...rows);
  }

  const records = buildAnalyticsRecords({ shops, products, sourceLabel });
  return { files: files.length, shopRows: shops.length, productRows: products.length, records };
}

async function importAnalyticsDirectory({ database, directory, sourceLabel = path.basename(directory) }) {
  const collection = loadAnalyticsDirectory(directory, sourceLabel);
  if (!collection.records.length) throw new Error(`No Etsy analytics rows found in ${directory}`);

  const query = `Etsy analytics import: ${sourceLabel}`;
  const run = await database.createRun({ platform: 'etsy', query, maxItems: collection.records.length });
  try {
    const result = await database.insertSnapshots(run.id, 'etsy', query, collection.records);
    await database.updateRun(run.id, { status: 'done', ...result });
    return { runId: run.id, ...collection, ...result };
  } catch (error) {
    await database.updateRun(run.id, { status: 'failed', errorMessage: error.message });
    throw error;
  }
}

module.exports = { parseCsv, buildAnalyticsRecords, loadAnalyticsDirectory, importAnalyticsDirectory };
