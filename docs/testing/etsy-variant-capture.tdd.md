# Etsy variant-price capture â€” TDD evidence

## User journey

For an Etsy listing with product dropdowns such as **Size** and **Shape
Options**, a user can choose **All dropdown variants** in Capture HTML. The
host-side Everbee CloakBrowser then selects each bounded combination, reads the
visible sale and original price, and returns those observations with the HTML
snapshot. `Quantity` is deliberately not treated as a product variation.

The default remains **Base product only**. A user can request 1â€“250
combinations; the response explicitly marks an incomplete run as `truncated`.

## RED â†’ GREEN evidence

| Behaviour | Test | RED evidence | GREEN evidence |
| --- | --- | --- | --- |
| Selectable variation matrix excludes quantity | `test/marketplace-variants.test.js` | `Cannot find module '../src/marketplaces/variant-pricing'` | Size Ã— Shape enumerates four selections and ignores Quantity. |
| VND sale/original values remain separate | `test/marketplace-variants.test.js` | Parser module unavailable | `VND 357,851` and `VND 715,702+` yield separate numeric fields. |
| Listing reports a range across variants | `test/marketplace-variants.test.js`, `test/marketplace-capture.test.js` | Capture did not forward variant mode or merge observations | Metrics report `priceMin`, `priceMax`, and `priceType: variant_range`. |
| Host executor receives the bounded mode | `test/everbee-host-executor.test.js` | Request body omitted `variantMode` | Authenticated host request includes `variantMode: all` and `maxVariants`. |
| UI exposes the option | `test/marketplace-ui.test.js` | Required controls absent | Capture dialog exposes mode and maximum-combination fields. |

## Operational limits

- Only native Etsy `<select>` controls are safely selected; Quantity is
  excluded by label.
- No CAPTCHA solving or bot-bypass is performed. A blocked page stays blocked
  and does not produce product metrics.
- The saved HTML is the final selected page state; the per-combination prices
  and selections are retained in `parsedData.variants`.
