const test = require('node:test');
const assert = require('node:assert/strict');

const { enumerateEtsyVariants, normalizeMaxVariants, parseVisibleEtsyPrice, summarizeVariantPrices } = require('../src/marketplaces/variant-pricing');
const { isEtsyVariationSelectId, marketplaceVariationSelector } = require('../src/marketplaces/etsy-variants');

test('variant enumeration excludes quantity and returns every selectable Size × Shape combination', () => {
  const variants = enumerateEtsyVariants([
    { label: 'Size', selector: 'size', options: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] },
    { label: 'Shape Options', selector: 'shape', options: [{ value: 'round', label: 'Round' }, { value: 'heart', label: 'Heart' }] },
    { label: 'Quantity', selector: 'quantity', options: [{ value: '1', label: '1' }, { value: '2', label: '2' }] },
  ], 10);

  assert.deepEqual(variants, {
    combinations: [
      [{ label: 'Size', value: 'small', text: 'Small', selector: 'size' }, { label: 'Shape Options', value: 'round', text: 'Round', selector: 'shape' }],
      [{ label: 'Size', value: 'small', text: 'Small', selector: 'size' }, { label: 'Shape Options', value: 'heart', text: 'Heart', selector: 'shape' }],
      [{ label: 'Size', value: 'large', text: 'Large', selector: 'size' }, { label: 'Shape Options', value: 'round', text: 'Round', selector: 'shape' }],
      [{ label: 'Size', value: 'large', text: 'Large', selector: 'size' }, { label: 'Shape Options', value: 'heart', text: 'Heart', selector: 'shape' }],
    ],
    totalCombinations: 4,
    truncated: false,
  });
});

test('visible Etsy price parsing keeps sale and original VND prices separate', () => {
  assert.deepEqual(parseVisibleEtsyPrice('VND 357,851 VND 715,702+'), {
    salePrice: 357851,
    originalPrice: 715702,
    currency: 'VND',
    displayText: 'VND 357,851 VND 715,702+',
  });
});

test('visible Etsy price parsing recognizes the Vietnamese dong suffix used by Etsy options', () => {
  assert.deepEqual(parseVisibleEtsyPrice('8 inches (826,171₫)'), {
    salePrice: 826171,
    originalPrice: 0,
    currency: 'VND',
    displayText: '8 inches (826,171₫)',
  });
});

test('Etsy variation selectors use stable listing IDs that survive a DOM re-render', () => {
  assert.equal(isEtsyVariationSelectId('variation-selector-0'), true);
  assert.equal(isEtsyVariationSelectId('estimated-shipping-country'), false);
  assert.equal(marketplaceVariationSelector('variation-selector-1'), '#variation-selector-1');
});

test('variant summary reports a price range instead of pretending one option is the listing price', () => {
  assert.deepEqual(summarizeVariantPrices([
    { price: { salePrice: 357851, originalPrice: 715702, currency: 'VND' } },
    { price: { salePrice: 489000, originalPrice: 820000, currency: 'VND' } },
  ]), {
    price: 357851,
    currency: 'VND',
    priceMin: 357851,
    priceMax: 489000,
    originalPriceMin: 715702,
    originalPriceMax: 820000,
    priceType: 'variant_range',
    variantCount: 2,
  });
});

test('variant captures allow a practical bounded Etsy matrix while preventing unbounded work', () => {
  assert.equal(normalizeMaxVariants(150), 150);
  assert.equal(normalizeMaxVariants(999), 250);
});
