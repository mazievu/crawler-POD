# Collection inputs and URL-only image storage — TDD evidence

## Source and user journeys

No plan file was supplied. The implementation was derived from these journeys:

1. As a collector user, I can see fields that are relevant to the platform I select, so I can submit a valid collection request.
2. As a collector user, my selected options are retained with the run, so a result remains reproducible.
3. As a data owner, collected items retain remote image URLs but do not persist inline/base64 image files.

## RED/GREEN evidence

| Behaviour | RED evidence | GREEN evidence | Guarantee |
|---|---|---|---|
| Platform input contracts | `node --test test\\collection-inputs.test.js` failed because `src/collection-inputs` did not exist | Same test: 6 tests passed | Shopify requires a URL, Reddit exposes sort/proxy/CDP, defaults and CDP validation work |
| Run option persistence | `node --test test\\collection-inputs.test.js test\\run-options.test.js` failed because `run.input_options` was absent | Same target: 7 tests passed | Options are stored in `runs.input_options` |
| URL-only image data | The added media-caption assertion failed because sanitization cleared non-image metadata | Same target: 7 tests passed | Inline image payloads are removed while media captions and remote URLs are retained |

## Validation

- `npm.cmd test`: passed, 28 runner cases; the diagnostic live probes reported unavailable third-party sources but did not fail the test suite.
- `node --test --experimental-test-coverage test\\collection-inputs.test.js test\\run-options.test.js`: passed. New/changed modules: `collection-inputs.js` 97.26% lines / 92.59% branches; `image-utils.js` 100% lines / 81.25% branches.
- Full-repository coverage remains below 80% because several pre-existing browser, scraper, and router modules are not covered by the legacy test suite; this change did not disable or skip tests.

## Environment checks

- SearXNG responded on `http://127.0.0.1:8080`.
- No local CDP endpoint was listening on `127.0.0.1:9222`.
- `cloakbrowser` is not installed in the workspace. The implementation accepts a local CloakBrowser CDP endpoint, but does not install it or expose CDP remotely.

## Git checkpoint note

The RED checkpoint commit could not be created because Git returned `Unable to create .git/index.lock: Permission denied`. No attempt was made to override the lock or alter unrelated worktree changes.
