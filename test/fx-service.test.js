const test = require('node:test');
const assert = require('node:assert/strict');
const { FxService, createRunFxContext, normalizeCurrencyCode } = require('../src/currency');

test('normalizeCurrencyCode maps symbols and codes properly', () => {
  assert.equal(normalizeCurrencyCode('$'), 'USD');
  assert.equal(normalizeCurrencyCode('usd'), 'USD');
  assert.equal(normalizeCurrencyCode('₫'), 'VND');
  assert.equal(normalizeCurrencyCode('vnd'), 'VND');
  assert.equal(normalizeCurrencyCode('€'), 'EUR');
  assert.equal(normalizeCurrencyCode('£'), 'GBP');
  assert.equal(normalizeCurrencyCode(''), 'USD');
  assert.equal(normalizeCurrencyCode(null), 'USD');
});

test('USD source returns amount unmodified without calling FX provider', async () => {
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    throw new Error('Should not be called');
  };

  const service = new FxService({ fetchImpl: mockFetch });
  const result = await service.convertToUsd(25.50, 'USD');

  assert.equal(fetchCalled, false, 'No fetch call should be made for USD');
  assert.equal(result.price, 25.50);
  assert.equal(result.currency, 'USD');
  assert.equal(result.source_price, 25.50);
  assert.equal(result.source_currency, 'USD');
  assert.equal(result.fx_rate, 1.0);
  assert.ok(result.fx_at);
});

test('VND -> USD converts correctly with mock provider', async () => {
  const mockRates = {
    result: 'success',
    rates: {
      VND: 25000,
      EUR: 0.90
    }
  };

  const mockFetch = async () => ({
    ok: true,
    json: async () => mockRates
  });

  const service = new FxService({ fetchImpl: mockFetch });
  const result = await service.convertToUsd(500000, 'VND');

  assert.equal(result.source_price, 500000);
  assert.equal(result.source_currency, 'VND');
  assert.equal(result.price, 20.00); // 500,000 / 25,000 = 20.00 USD
  assert.equal(result.currency, 'USD');
  assert.equal(result.fx_rate, 1 / 25000);
});

test('EUR -> USD converts correctly with mock provider', async () => {
  const mockRates = {
    result: 'success',
    rates: {
      EUR: 0.80
    }
  };

  const mockFetch = async () => ({
    ok: true,
    json: async () => mockRates
  });

  const service = new FxService({ fetchImpl: mockFetch });
  const result = await service.convertToUsd(80, 'EUR');

  assert.equal(result.source_price, 80);
  assert.equal(result.source_currency, 'EUR');
  assert.equal(result.price, 100.00); // 80 / 0.80 = 100.00 USD
  assert.equal(result.currency, 'USD');
});

test('In-run cache: 5 products in VND only call FX provider 1 time', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return {
      ok: true,
      json: async () => ({
        result: 'success',
        rates: { VND: 25000 }
      })
    };
  };

  const service = new FxService({ fetchImpl: mockFetch });
  const runContext = createRunFxContext(service);

  const amounts = [100000, 250000, 500000, 750000, 1000000];
  const results = [];

  for (const amt of amounts) {
    results.push(await runContext.convertToUsd(amt, 'VND'));
  }

  assert.equal(callCount, 1, 'FX provider should be called exactly ONCE across all 5 items in the run');
  assert.equal(results.length, 5);
  assert.equal(results[0].price, 4.00);
  assert.equal(results[1].price, 10.00);
  assert.equal(results[2].price, 20.00);
  assert.equal(results[3].price, 30.00);
  assert.equal(results[4].price, 40.00);
  for (const res of results) {
    assert.equal(res.currency, 'USD');
    assert.equal(res.source_currency, 'VND');
  }
});

test('Malformed / zero / missing price handled safely', async () => {
  const service = new FxService();
  const res1 = await service.convertToUsd(0, 'VND');
  assert.equal(res1.price, 0);
  assert.equal(res1.currency, 'USD');

  const res2 = await service.convertToUsd(null, 'EUR');
  assert.equal(res2.price, 0);
  assert.equal(res2.currency, 'USD');

  const res3 = await service.convertToUsd(undefined, '');
  assert.equal(res3.price, 0);
  assert.equal(res3.currency, 'USD');
});

test('FX provider failure retains original price and sets FX_CONVERSION_FAILED error without throwing', async () => {
  const failingFetch = async () => {
    throw new Error('ECONNREFUSED: Network unreachable');
  };

  const service = new FxService({ fetchImpl: failingFetch });
  const result = await service.convertToUsd(497633, 'VND');

  assert.equal(result.price, 497633);
  assert.equal(result.currency, 'VND');
  assert.equal(result.source_price, 497633);
  assert.equal(result.source_currency, 'VND');
  assert.equal(result.fx_rate, null);
  assert.equal(result.fx_error, 'FX_CONVERSION_FAILED');
});
