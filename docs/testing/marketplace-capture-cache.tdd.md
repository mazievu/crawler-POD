# Marketplace capture cache — TDD evidence

## Source and user journeys

Journeys were derived directly from the request in this task:

1. As a user, I want a successful Capture & Parse result encrypted and saved,
   so I can inspect it later.
2. As a user, I want the same product to use its saved result, so the server
   does not launch the marketplace browser again unnecessarily.
3. As a user, I want different account sessions or dropdown capture settings
   to remain separate, so a cached price is not shown for the wrong context.

## RED

`node --test test/marketplace-capture-cache.test.js test/marketplace-ui.test.js`
initially ran 7 tests: 4 passed and 3 failed. The intended failures were
`db.getCachedMarketplaceCapture is not a function` and missing Saved Captures
UI controls. The RED checkpoint is commit `24baf48`.

## GREEN behavior

- Successful captures are encrypted and persisted as before; blocked/CAPTCHA
  results are returned to the user but are not newly saved as reusable cache.
- Cache identity is platform + normalized product URL + account + Base/All
  dropdown mode + requested maximum variants.
- Etsy listing URLs ignore tracking query parameters; Amazon/eBay tracking
  parameters are removed while product options remain intact.
- The top bar now offers **Saved Captures**, a list of saved product data with
  direct access to each encrypted HTML/data record.
- A cached API response includes `cached: true`, and the capture dialog says
  `Loaded saved capture.`

## Verification

| Guarantee | Test / check | Result |
|---|---|---|
| Same canonical Etsy product and options reuse saved data | `marketplace-capture-cache.test.js` | PASS |
| Blocked pages and different variant options are not reused | `marketplace-capture-cache.test.js` | PASS |
| API returns cached data without a browser capture | `marketplace-api.test.js` | PASS |
| Saved Captures UI is present and cached result is labelled | `marketplace-ui.test.js` | PASS |
| Cache URL normalization coverage | targeted coverage command | 92% lines, 88.24% branches, 100% functions |
| Full regression suite | `npm.cmd test` | 93/93 PASS |
| Docker smoke test | POST existing capture to `:9999/api/html-captures` | HTTP 201, `cached: true`, same capture id |

The full suite prints existing non-failing diagnostics for unavailable local
port 3005 and live probe fallbacks; its process exit status was successful.
