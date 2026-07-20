# Marketplace accounts and HTML capture — TDD evidence

## Source and user journeys

No plan file was supplied. The implementation was derived from the request to
continue the collector with Amazon, eBay, and Etsy account storage, HTML
capture, and parsable product metrics.

1. As a researcher, I can save one browser-session profile per marketplace
   account without exposing its cookies or tokens in the dashboard/API list.
2. As a researcher, I can select an optional saved session, capture a rendered
   product page from its matching marketplace, and retain the capture locally.
3. As a researcher, I receive normalized listing data from saved HTML so that
   price, rating, reviews, availability, image, and listing identifiers can be
   used by later analysis.

## RED / GREEN evidence

| Behaviour | RED evidence | GREEN evidence | Guarantee |
|---|---|---|---|
| Encryption, domain validation, and parsing | `node --test test/marketplace-capture.test.js` failed because `encrypted-store` did not exist | Same target: 5 tests passed | AES-256-GCM encrypted storage rejects altered ciphertext; capture URLs are restricted to Amazon/eBay/Etsy; JSON-LD product data is normalized. |
| Account persistence and render capture | Same target failed because `html-capture` did not exist | Same target: 7 tests passed | Account lists never expose browser storage state; an injected browser context receives the selected state and returns parsed metrics. |
| Account API journey | `node --test test/marketplace-api.test.js` failed because the endpoint returned the dashboard HTML (404 fallback) | Same target: 1 test passed | The HTTP flow saves, lists, and deletes an encrypted session without returning its secret. |
| Dashboard controls | `node --test test/marketplace-ui.test.js` failed because the account/capture modal IDs were absent | Same target: 1 test passed | The dashboard exposes account management and HTML capture entry points. |

## Validation

- `npm.cmd test`: passed — 46 Node runner cases. Existing live diagnostics still
  reported unavailable external providers but intentionally did not fail the
  suite.
- `node --test test/marketplace-capture.test.js test/marketplace-api.test.js
  test/marketplace-ui.test.js`: passed — 9 focused tests.
- `node --test --experimental-test-coverage ...`: passed. The focused run
  reported 81.25% line coverage across loaded files. New parser/session code is
  exercised by unit, integration, and HTTP end-to-end coverage.

## Coverage and known gaps

The repository has no configured coverage thresholds. The targeted V8 report
does **not** meet the TDD skill's 80% threshold for every measure: it reported
68.58% branches and 56.79% functions across all loaded legacy files. The main
gaps are pre-existing database, scraper, browser-default, and router branches;
no tests were skipped or disabled. A real marketplace browser capture was not
run during validation because it would require a user-owned account/session and
could trigger third-party anti-bot controls.

## Git checkpoints

- `0aff657` — RED: parser/security reproducer.
- `a6689fb` — GREEN: secure parser primitives.
- `05c6dea` — RED: account and rendered-capture coverage.
- `0eced52` — RED: account API journey.
- `8ef1ae9` — RED: dashboard controls.

The final GREEN validation is the focused 9-test run recorded above. The
repository already had unrelated uncommitted edits in shared integration files,
so only newly created task files were staged for the final checkpoint; the
working-tree implementation was not mixed with those user edits.
