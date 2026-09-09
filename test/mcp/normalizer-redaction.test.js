'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeItemContract,
  extractExplicitCurrency,
  normalizeNullableNumber,
  normalizeNullableInt,
  isDataStale,
} = require('../../src/mcp/normalizer');
const { redactResponse, isForbiddenKey } = require('../../src/mcp/redaction');

test('Currency handling: Strictly returns null when currency is absent, extracts only explicit currency', () => {
  // Absent in raw payload
  assert.strictEqual(extractExplicitCurrency(null), null);
  assert.strictEqual(extractExplicitCurrency('{}'), null);
  assert.strictEqual(extractExplicitCurrency('{"title": "Test Product"}'), null);
  assert.strictEqual(extractExplicitCurrency({ title: 'Test Product' }), null);

  // Present in raw payload
  assert.strictEqual(extractExplicitCurrency('{"currency": "USD"}'), 'USD');
  assert.strictEqual(extractExplicitCurrency('{"soldCurrency": "eur"}'), 'EUR');
  assert.strictEqual(extractExplicitCurrency('{"analytics": {"currency": "VND"}}'), 'VND');
  assert.strictEqual(extractExplicitCurrency({ currency: 'GBP' }), 'GBP');
});

test('Number normalization: distinguishes 0 from null/undefined', () => {
  // Price amounts
  assert.strictEqual(normalizeNullableNumber(0), 0);
  assert.strictEqual(normalizeNullableNumber('0'), 0);
  assert.strictEqual(normalizeNullableNumber(24.99), 24.99);
  assert.strictEqual(normalizeNullableNumber(null), null);
  assert.strictEqual(normalizeNullableNumber(undefined), null);
  assert.strictEqual(normalizeNullableNumber(''), null);
  assert.strictEqual(normalizeNullableNumber('not-a-number'), null);

  // Integers
  assert.strictEqual(normalizeNullableInt(0), 0);
  assert.strictEqual(normalizeNullableInt('0'), 0);
  assert.strictEqual(normalizeNullableInt(100.4), 100);
  assert.strictEqual(normalizeNullableInt(null), null);
  assert.strictEqual(normalizeNullableInt(undefined), null);
});

test('Item Contract normalization: produces compliant contract shape', () => {
  const row = {
    id: 123,
    run_id: 45,
    platform: 'etsy',
    query: 'handmade jewelry',
    item_uid: 'etsy:https://etsy.com/listing/987654321',
    raw_data: '{"title": "Silver Ring", "currency": "USD"}',
    title: 'Silver Ring',
    url: 'https://etsy.com/listing/987654321',
    image: 'https://img.etsy.com/1.jpg',
    author: 'SilverArtisan',
    price: 35.5,
    likes: 120,
    comments: 5,
    shares: 0,
    views: 1200,
    status: 'active',
    first_seen_at: '2026-07-01 10:00:00',
    created_at: '2026-08-01 12:00:00',
    run_completed_at: '2026-08-01 12:05:00',
  };

  const contract = normalizeItemContract(row);

  assert.strictEqual(contract.item_uid, 'etsy:https://etsy.com/listing/987654321');
  assert.strictEqual(contract.platform, 'etsy');
  assert.strictEqual(contract.title, 'Silver Ring');
  assert.strictEqual(contract.url, 'https://etsy.com/listing/987654321');
  assert.strictEqual(contract.image, 'https://img.etsy.com/1.jpg');
  assert.strictEqual(contract.author, 'SilverArtisan');

  assert.deepStrictEqual(contract.price, {
    amount: 35.5,
    currency: 'USD',
  });

  assert.deepStrictEqual(contract.engagement, {
    likes: 120,
    comments: 5,
    shares: 0,
    views: 1200,
  });

  assert.strictEqual(contract.status, 'active');
  assert.strictEqual(contract.first_seen_at, '2026-07-01 10:00:00');
  assert.strictEqual(contract.last_seen_at, '2026-08-01 12:00:00');

  assert.deepStrictEqual(contract.provenance, {
    platform: 'etsy',
    url: 'https://etsy.com/listing/987654321',
    query: 'handmade jewelry',
    run_id: '45',
    snapshot_id: '123',
    collected_at: '2026-08-01 12:00:00',
  });

  assert.strictEqual(contract.freshness.data_as_of, '2026-08-01 12:05:00');
  assert.strictEqual(typeof contract.freshness.stale, 'boolean');
});

test('Redaction: Deeply strips all forbidden fields from response objects', () => {
  const sensitivePayload = {
    item_uid: 'item-1',
    platform: 'facebook',
    raw_data: '{"secret_data": 123}',
    rawData: '{"secret": "xyz"}',
    apify_run_id: 'apify-12345',
    apify_dataset_id: 'dataset-67890',
    actor_id: 'actor-999',
    error_message: 'DB connection timeout',
    cookie: 'session_id=abcdef',
    token: 'bearer_token_123',
    nested: {
      url: 'https://example.com',
      token: 'nested-token',
      password: 'password123',
      proxy: 'socks5://127.0.0.1:9050',
      safe_field: 'public value',
    },
    list: [
      { id: 1, session: 'session-token', name: 'Item 1' },
      { id: 2, authorization: 'auth-header', name: 'Item 2' },
    ],
  };

  const clean = redactResponse(sensitivePayload);

  // Forbidden fields stripped
  assert.strictEqual(clean.raw_data, undefined);
  assert.strictEqual(clean.rawData, undefined);
  assert.strictEqual(clean.apify_run_id, undefined);
  assert.strictEqual(clean.apify_dataset_id, undefined);
  assert.strictEqual(clean.actor_id, undefined);
  assert.strictEqual(clean.error_message, undefined);
  assert.strictEqual(clean.cookie, undefined);
  assert.strictEqual(clean.token, undefined);

  // Nested forbidden fields stripped
  assert.strictEqual(clean.nested.token, undefined);
  assert.strictEqual(clean.nested.password, undefined);
  assert.strictEqual(clean.nested.proxy, undefined);
  assert.strictEqual(clean.nested.safe_field, 'public value');

  // Array elements stripped
  assert.strictEqual(clean.list[0].session, undefined);
  assert.strictEqual(clean.list[0].name, 'Item 1');
  assert.strictEqual(clean.list[1].authorization, undefined);
  assert.strictEqual(clean.list[1].name, 'Item 2');

  // Safe fields preserved
  assert.strictEqual(clean.item_uid, 'item-1');
  assert.strictEqual(clean.platform, 'facebook');
});
