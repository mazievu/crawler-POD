const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString('base64');

const db = require('../src/database');
const { normalizeMarketplaceCaptureUrl } = require('../src/marketplaces/validation');

function successfulData() {
  return {
    metrics: { platform: 'etsy', title: 'Cached product', price: 357851, currency: 'VND' },
    capture: { status: 'ok', browserMode: 'everbee' },
    variants: [],
  };
}

test('reuses the newest successful capture for the same canonical product and capture options', async () => {
  const listingId = `cache${Date.now()}`.replace(/\D/g, '').slice(-10);
  const stored = await db.createMarketplaceCapture({
    platform: 'etsy',
    url: `https://www.etsy.com/listing/${listingId}/cached-product?ref=homepage`,
    html: '<html><title>Cached product</title></html>',
    parsedData: successfulData(),
    variantMode: 'base',
    maxVariants: 0,
  });

  const cached = await db.getCachedMarketplaceCapture({
    platform: 'etsy',
    url: `https://www.etsy.com/listing/${listingId}/cached-product?utm_source=mail`,
    accountId: null,
    variantMode: 'base',
    maxVariants: 0,
  });

  assert.equal(cached.id, stored.id);
  assert.equal(cached.parsedData.metrics.title, 'Cached product');
});

test('does not reuse a capture for different variant options or a blocked page', async () => {
  const listingId = `cache${Date.now() + 1}`.replace(/\D/g, '').slice(-10);
  const url = `https://www.etsy.com/listing/${listingId}/cached-product`;
  await db.createMarketplaceCapture({
    platform: 'etsy', url, html: '<html>blocked</html>',
    parsedData: { metrics: {}, capture: { status: 'blocked' }, variants: [] },
    variantMode: 'base', maxVariants: 0,
  });

  assert.equal(await db.getCachedMarketplaceCapture({ platform: 'etsy', url, accountId: null, variantMode: 'base', maxVariants: 0 }), null);
  assert.equal(await db.getCachedMarketplaceCapture({ platform: 'etsy', url, accountId: null, variantMode: 'all', maxVariants: 10 }), null);
});

test('cache URL normalization removes tracking parameters without removing product options', () => {
  assert.equal(
    normalizeMarketplaceCaptureUrl('amazon', 'https://www.amazon.com/dp/B012345678?th=1&utm_source=mail&ref=homepage'),
    'https://www.amazon.com/dp/B012345678?th=1',
  );
});

test('marketplace URLs without a scheme default to HTTPS', () => {
  assert.equal(
    normalizeMarketplaceCaptureUrl('etsy', 'www.etsy.com/listing/123456789/ceramic-mug'),
    'https://www.etsy.com/listing/123456789',
  );
});

test('marketplace cache normalizes an explicit HTTP URL to HTTPS', () => {
  assert.equal(
    normalizeMarketplaceCaptureUrl('etsy', 'http://etsy.com/listing/123456789/ceramic-mug'),
    'https://etsy.com/listing/123456789',
  );
});
