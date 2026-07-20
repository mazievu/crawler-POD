# Etsy live-capture audit — TDD evidence

## Source and user journeys

Derived from the request to audit the deployed Etsy capture path against the
live listing rather than relying only on fixtures.

1. A user selecting **All dropdown variants** receives the price for each
   Size × Shape combination, not one generic listing price.
2. A user receives VND values from the displayed Etsy page, including the
   `₫` suffix, without mixing a number from one source with a currency from
   another.
3. A slow Etsy re-render does not silently drop a variation; the capture
   retries that selection once and reports a missing result only if retry fails.

## RED → GREEN evidence

| Guarantee | Test / audit | RED evidence | GREEN evidence |
| --- | --- | --- | --- |
| Stable product selectors survive re-render | `test/marketplace-variants.test.js` | Host used a temporary attribute; live capture returned 2 unavailable variants. | Uses Etsy `variation-selector-*` IDs; live full run produced 104 records. |
| VND suffix is parsed | `test/marketplace-variants.test.js` | `826,171₫` was not recognized. | Sale/original VND values parse independently. |
| Saved price text is compact | `test/marketplace-variants.test.js` | Live result stored the full product-page text in `displayText`. | Saved excerpt is only the labelled sale/original price. |
| Full capture avoids redundant controls | `test/marketplace-variants.test.js` | Each combination re-selected unchanged controls and ran too slowly. | Only changed controls are selected. |
| Delayed control is retried | `test/marketplace-variants.test.js` | `8 inches × Butterfly` returned unavailable. | One retry with 500ms delay produced a valid price. |

## Live audit result

Canonical Etsy listing `4467474365` was captured through the host Everbee
CloakBrowser with the saved account and `maxVariants: 150`.

- 104 total combinations, 104 captured, `truncated: false`
- 104 priced / 0 unavailable
- Currency: VND only
- Sale range: 357,851₫–5,784,848₫
- Original-price range: 715,702₫–11,569,697₫
- Capture status: `ok` (no CAPTCHA marker)

The direct page text for the sampled 8-inch options stated 826,171₫ sale and
1,652,342₫ original; the saved variant result matched those values.

## Validation

```text
node --test --experimental-test-coverage ... test/marketplace-variants.test.js
13 passed; coverage 100% lines, 81.82% branches, 100% functions.

npm.cmd test
82 passed, 0 failed.
```

Docker collector and host executor were rebuilt/restarted after the fixes.
