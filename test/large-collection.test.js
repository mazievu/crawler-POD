const test = require('node:test');
const assert = require('node:assert/strict');

const { paginateDatasetItems } = require('../src/apify-client');
const { INPUT_BUILDERS } = require('../src/apify-client');
const { buildCollectionOptions } = require('../src/collection-inputs');

test('a large collection request accepts up to 10,000 items', () => {
  assert.equal(buildCollectionOptions('amazon', { maxItems: '10000' }).maxItems, 10000);
  assert.equal(buildCollectionOptions('amazon', { maxItems: '10001' }).maxItems, 10000);
});

test('dataset pagination returns every item across successive pages up to the requested limit', async () => {
  const calls = [];
  const dataset = {
    async listItems(options) {
      calls.push(options);
      const items = Array.from({ length: options.limit }, (_, index) => ({ id: options.offset + index }));
      return { items };
    },
  };

  const items = await paginateDatasetItems(dataset, 2500, { pageSize: 1000 });

  assert.equal(items.length, 2500);
  assert.deepEqual(calls.map(({ offset, limit }) => ({ offset, limit })), [
    { offset: 0, limit: 1000 },
    { offset: 1000, limit: 1000 },
    { offset: 2000, limit: 500 },
  ]);
});

test('dataset pagination stops as soon as a short page signals the end of available results', async () => {
  const calls = [];
  const dataset = {
    async listItems(options) {
      calls.push(options);
      return { items: options.offset === 0 ? [{ id: 1 }, { id: 2 }] : [] };
    },
  };

  const items = await paginateDatasetItems(dataset, 5000, { pageSize: 1000 });

  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
  assert.equal(calls.length, 1);
});

test('Amazon requests enough result pages instead of always stopping after page one', () => {
  const input = INPUT_BUILDERS.amazon({ query: 'wireless mouse', maxItems: 200, country: 'US' });

  assert.equal(input.maxProductsPerSearch, 200);
  assert.equal(input.maxSearchPages, 5);
});
