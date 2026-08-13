const test = require('node:test');
const assert = require('node:assert/strict');

const { enrichEtsyImages } = require('../src/etsy-image-enrichment');

test('enriches missing Etsy listing images and saves only successful captures', async () => {
  const calls = [];
  const database = {
    getSnapshotsMissingEtsyImages(limit) {
      calls.push(['get', limit]);
      return [
        { id: 1, url: 'https://www.etsy.com/listing/100/first' },
        { id: 2, url: 'https://www.etsy.com/listing/200/second' },
      ];
    },
    updateSnapshotImage(id, image) {
      calls.push(['update', id, image]);
    },
  };

  const result = await enrichEtsyImages({
    database,
    limit: 2,
    captureListing: async (url) => url.includes('/100/')
      ? 'https://i.etsystatic.com/100/image.jpg'
      : '',
    sleep: async () => {},
  });

  assert.deepEqual(result, { requested: 2, updated: 1, failed: 1 });
  assert.deepEqual(calls, [
    ['get', 2],
    ['update', 1, 'https://i.etsystatic.com/100/image.jpg'],
  ]);
});

test('continues after an individual Etsy capture fails', async () => {
  const updated = [];
  const database = {
    getSnapshotsMissingEtsyImages() {
      return [
        { id: 1, url: 'https://www.etsy.com/listing/100/first' },
        { id: 2, url: 'https://www.etsy.com/listing/200/second' },
      ];
    },
    updateSnapshotImage(id, image) {
      updated.push([id, image]);
    },
  };

  const result = await enrichEtsyImages({
    database,
    captureListing: async (url) => {
      if (url.includes('/100/')) throw new Error('blocked');
      return 'https://i.etsystatic.com/200/image.jpg';
    },
    sleep: async () => {},
  });

  assert.deepEqual(result, { requested: 2, updated: 1, failed: 1 });
  assert.deepEqual(updated, [[2, 'https://i.etsystatic.com/200/image.jpg']]);
});
