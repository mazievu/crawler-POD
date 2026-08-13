const database = require('./database');
const { cleanImageUrl } = require('./image-utils');
const { captureMarketplaceHtml } = require('./marketplaces/html-capture');

async function captureEtsyListingImage(url) {
  const capture = await captureMarketplaceHtml({ platform: 'etsy', url });
  return cleanImageUrl(capture.metrics?.image);
}

async function enrichEtsyImages({
  limit = 50,
  delayMs = 1_200,
  database: targetDatabase = database,
  captureListing = captureEtsyListingImage,
  sleep = wait,
} = {}) {
  const snapshots = targetDatabase.getSnapshotsMissingEtsyImages(limit);
  let updated = 0;
  let failed = 0;

  for (const [index, snapshot] of snapshots.entries()) {
    try {
      const image = cleanImageUrl(await captureListing(snapshot.url));
      if (!image) {
        failed += 1;
      } else {
        targetDatabase.updateSnapshotImage(snapshot.id, image);
        updated += 1;
      }
    } catch {
      failed += 1;
    }

    if (index < snapshots.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  return { requested: snapshots.length, updated, failed };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { captureEtsyListingImage, enrichEtsyImages };
