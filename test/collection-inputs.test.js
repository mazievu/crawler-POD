const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPlatformInputFields,
  getPlatformQueryField,
  buildCollectionOptions,
} = require('../src/collection-inputs');
const { sanitizeForStorage, cleanImageUrl, hasImage } = require('../src/image-utils');

test('Shopify requires a store URL instead of a generic keyword', () => {
  const fields = getPlatformInputFields('shopify');
  assert.deepEqual(fields.map((field) => field.id), ['storeUrl']);
  assert.equal(fields[0].type, 'url');
  assert.equal(fields[0].required, true);
});

test('Reddit exposes sort and proxy/CDP connection inputs', () => {
  const fields = getPlatformInputFields('reddit');
  assert.ok(fields.some((field) => field.id === 'sort'));
  assert.ok(fields.some((field) => field.id === 'proxyUrl'));
  assert.ok(fields.some((field) => field.id === 'cdpUrl'));
});

test('unknown platforms fall back to a safe keyword input', () => {
  assert.equal(getPlatformQueryField('unknown').id, 'query');
  assert.deepEqual(getPlatformInputFields('unknown'), []);
});

test('buildCollectionOptions preserves platform inputs and standard collection controls', () => {
  const options = buildCollectionOptions('reddit', {
    maxItems: '5', country: 'US', sort: 'top', cdpUrl: 'http://127.0.0.1:9222',
  });
  assert.deepEqual(options, {
    maxItems: 5, country: 'US', sort: 'top', cdpUrl: 'http://127.0.0.1:9222',
  });
});

test('buildCollectionOptions rejects non-local CDP endpoints and clamps max items', () => {
  assert.throws(
    () => buildCollectionOptions('reddit', { maxItems: '900', cdpUrl: 'https://remote.example.com:9222' }),
    /CDP URL must use localhost/
  );
  assert.equal(buildCollectionOptions('reddit', { maxItems: '0' }).maxItems, 20);
});

test('sanitizeForStorage retains remote image URLs but removes inline image payloads', () => {
  const item = sanitizeForStorage({
    image: 'data:image/png;base64,AAAA',
    thumbnail: 'https://cdn.example.com/thumb.jpg',
    media: { imageUrl: 'data:image/webp;base64,BBBB', caption: 'Keep this product caption' },
  });
  assert.equal(item.image, '');
  assert.equal(item.thumbnail, 'https://cdn.example.com/thumb.jpg');
  assert.equal(item.media.imageUrl, '');
  assert.equal(item.media.caption, 'Keep this product caption');
  assert.equal(cleanImageUrl('not-a-url'), '');
  assert.equal(hasImage({ image: 'https://cdn.example.com/valid.jpg' }), true);
});
