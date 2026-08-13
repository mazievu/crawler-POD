const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INPUT_BUILDERS,
  startActor,
  getRunStatus,
  fetchDatasetItems,
} = require('../src/apify-client');

test('every configured Apify input builder returns an object for a standard collection request', () => {
  const input = { query: 'portable blender', maxItems: 25, country: 'US' };
  for (const [platform, build] of Object.entries(INPUT_BUILDERS)) {
    const value = build(input);
    assert.equal(typeof value, 'object', `${platform} must build an actor input object`);
  }
});

test('Amazon input stays within the actor per-keyword cap for large runs', () => {
  const input = INPUT_BUILDERS.amazon({ query: 'portable blender', maxItems: 10000, country: 'US' });
  assert.equal(input.maxProductsPerSearch, 1000);
  assert.equal(input.maxSearchPages, 20);
});

test('Apify client operations fail clearly when no token is configured', async () => {
  await assert.rejects(
    () => startActor('actor/id', 'amazon', { query: 'test', maxItems: 1 }),
    /not initialized/
  );
  await assert.rejects(() => getRunStatus('run-id'), /not initialized/);
  await assert.rejects(() => fetchDatasetItems('dataset-id', 1), /not initialized/);
});

test('Apify client operations use the supplied client and return complete paginated results', async () => {
  const calls = [];
  const apiClient = {
    actor(actorId) {
      return {
        async call(input, options) {
          calls.push({ actorId, input, options });
          return { id: 'run-1', defaultDatasetId: 'dataset-1' };
        },
      };
    },
    run(runId) {
      return { async get() { return { id: runId, status: 'SUCCEEDED' }; } };
    },
    dataset(datasetId) {
      return {
        async listItems({ offset, limit }) {
          return { items: Array.from({ length: Math.min(limit, 2 - offset) }, (_, index) => ({ id: `${datasetId}-${offset + index}` })) };
        },
      };
    },
  };

  const run = await startActor('actor/id', 'amazon', { query: 'test', maxItems: 2, country: 'US' }, apiClient);
  assert.deepEqual(run, { runId: 'run-1', datasetId: 'dataset-1' });
  assert.equal(calls.length, 1);
  assert.equal(await getRunStatus('run-1', apiClient), 'SUCCEEDED');
  assert.equal((await fetchDatasetItems('dataset-1', 2, apiClient)).length, 2);
});

test('Apify actor startup validates required actor and platform builder inputs before calling the API', async () => {
  const apiClient = { actor() { throw new Error('actor should not be called'); } };

  await assert.rejects(
    () => startActor('', 'amazon', { query: 'test', maxItems: 1 }, apiClient),
    /actorId is missing/
  );
  await assert.rejects(
    () => startActor('actor/id', 'not-a-platform', { query: 'test', maxItems: 1 }, apiClient),
    /No input builder/
  );
});
