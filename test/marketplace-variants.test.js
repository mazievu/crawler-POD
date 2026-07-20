const test = require('node:test');
const assert = require('node:assert/strict');

const { enumerateEtsyVariants, extractEtsyPriceText, normalizeMaxVariants, normalizeVariantMode, parseVisibleEtsyPrice, summarizeVariantPrices } = require('../src/marketplaces/variant-pricing');
const { changedEtsyVariationSelections, etsyVariantInteractionOptions, isEtsyVariationSelectId, marketplaceVariationSelector } = require('../src/marketplaces/etsy-variants');

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

test('Etsy price capture keeps only the labeled price excerpt instead of the whole product page', () => {
  assert.equal(
    extractEtsyPriceText('Homepage text. Now Price: 826,171₫ Original Price: 1,652,342₫ Loading product details.'),
    '826,171₫ 1,652,342₫',
  );
});

test('Etsy variation selectors use stable listing IDs that survive a DOM re-render', () => {
  assert.equal(isEtsyVariationSelectId('variation-selector-0'), true);
  assert.equal(isEtsyVariationSelectId('estimated-shipping-country'), false);
  assert.equal(marketplaceVariationSelector('variation-selector-1'), '#variation-selector-1');
});

test('successive Etsy combinations only select controls whose values changed', () => {
  const previous = new Map([['#variation-selector-0', 'small'], ['#variation-selector-1', 'circle']]);
  const next = [
    { selector: '#variation-selector-0', value: 'small' },
    { selector: '#variation-selector-1', value: 'waves' },
  ];
  assert.deepEqual(changedEtsyVariationSelections(previous, next), [{ selector: '#variation-selector-1', value: 'waves' }]);
});

test('Etsy control changes have a short bounded timeout and a render-settle delay', () => {
  assert.deepEqual(etsyVariantInteractionOptions(), { timeout: 1000, settleMs: 150, retryDelayMs: 500 });
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

test('variant configuration falls back safely for invalid modes, bounds, and empty product controls', () => {
  assert.equal(normalizeVariantMode('unknown'), 'base');
  assert.equal(normalizeVariantMode('all'), 'all');
  assert.equal(normalizeMaxVariants(0), 1);
  assert.equal(normalizeMaxVariants(), 150);
  assert.deepEqual(enumerateEtsyVariants([{ label: 'Quantity', selector: 'quantity', options: [{ value: '1' }] }]), {
    combinations: [], totalCombinations: 0, truncated: false,
  });
});

test('price helpers handle standard currency symbols and harmless non-price text', () => {
  assert.deepEqual(parseVisibleEtsyPrice('$25.98 $49.99'), {
    salePrice: 25.98, originalPrice: 49.99, currency: 'USD', displayText: '$25.98 $49.99',
  });
  assert.equal(extractEtsyPriceText('No current price is visible yet'), 'No current price is visible yet');
  assert.deepEqual(summarizeVariantPrices([]), {});
});

test('price helpers support common thousands and decimal separators without cross-currency guessing', () => {
  assert.equal(parseVisibleEtsyPrice('EUR 1.234,56').salePrice, 1234.56);
  assert.equal(parseVisibleEtsyPrice('USD 1,234').salePrice, 1234);
  assert.equal(parseVisibleEtsyPrice('USD 1,25').salePrice, 1.25);
  assert.equal(parseVisibleEtsyPrice('USD 1.234').salePrice, 1234);
  assert.equal(isEtsyVariationSelectId(), false);
  assert.throws(() => marketplaceVariationSelector('locale-overlay-select-region_code'), /Unsupported Etsy variation selector/);
});

test('variant helpers cover disabled options, truncation, single-price summaries, and mixed currencies', () => {
  assert.deepEqual(enumerateEtsyVariants([{ selector: 'size', options: [{ value: 's', label: 'Small', disabled: true }, { value: 'm', label: 'Medium' }] }], 1), {
    combinations: [[{ label: 'Option', selector: 'size', value: 'm', text: 'Medium' }]], totalCombinations: 1, truncated: false,
  });
  assert.deepEqual(enumerateEtsyVariants([{ label: 'Size', selector: 'size', options: [{ value: 's' }, { value: 'm' }, { value: 'l' }] }], 2).truncated, true);
  assert.equal(parseVisibleEtsyPrice('USD 2 EUR 3').originalPrice, 0);
  assert.deepEqual(summarizeVariantPrices([{ price: { salePrice: 9, currency: 'USD' } }, { price: { salePrice: 10, currency: 'EUR' } }]), {
    price: 9, currency: 'USD', priceMin: 9, priceMax: 9, priceType: 'variant_fixed', variantCount: 1,
  });
});
