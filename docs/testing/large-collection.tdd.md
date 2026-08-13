# Large collection pipeline — TDD evidence

## Source and user journeys

No plan file was supplied. The journeys were derived from the request to collect
at a scale comparable to established market-research tools.

1. As a researcher, I can request up to 10,000 records for a collection run, so
   the UI does not impose the former 500-item ceiling.
2. As a researcher, I receive all records written to a paginated provider
   dataset up to my requested limit, rather than just the first page.
3. As an operator, collection stops after a short provider page, so exhausted
   datasets do not cause excess requests.
4. As an Amazon researcher, a request above one result page asks the selected
   provider for the corresponding number of search pages within its documented
   caps.

## RED / GREEN evidence

| Behaviour | RED evidence | GREEN evidence | Guarantee |
|---|---|---|---|
| Large collection limit | `node --test test\\large-collection.test.js` failed: `500 !== 10000` | Same suite passed | Input permits 1–10,000 records |
| Dataset pagination | Same RED suite failed: `paginateDatasetItems is not a function` | Same suite passed | Records are fetched with `offset`/`limit` pages of at most 1,000 |
| Dataset exhaustion | Same RED suite lacked a pagination implementation | Same suite passed | A short page ends the read loop |
| Amazon page depth | Added test failed: expected 5 pages but received 1 | Same suite passed | Page count follows requested products, capped at the actor's documented limit |
| Safe API client tests | Added injection test failed because the supplied mock was ignored | Same suite passed | Success paths are tested with a mock, without running a paid actor |

## Validation

- `node --test test\\large-collection.test.js test\\apify-client-coverage.test.js test\\collection-inputs.test.js test\\run-options.test.js`: 16 tests passed.
- Targeted coverage command for the same tests: `apify-client.js` 100.00% lines / 80.56% branches / 100.00% functions; `collection-inputs.js` 97.30% lines / 96.15% branches / 100.00% functions.
- `npm.cmd test`: 37 Node test cases passed. Its live diagnostics still report that several third-party sources are unavailable; no paid actor was started during validation.

## Scope and known limits

- This phase removes the application-level 100-item dataset read limit and opens a 10,000-item requested limit. It does not bypass platform, actor, account, rate-limit, or cost limits.
- The configured Amazon actor accepts at most 1,000 products and 20 pages per keyword. Public Reddit pagination is approximately 1,000 posts per source. Higher database scale therefore requires a scheduled campaign of multiple seeds/time slices, a deduplication key, and a provider/proxy budget.
- The next product phase is a persisted campaign queue: multiple query seeds/time windows, bounded worker concurrency, scheduled refresh, deduplication, cost cap, and analytics over the accumulated snapshots.

## Git checkpoint note

The required RED checkpoint commit was attempted but Git returned `Unable to create .git/index.lock: Permission denied`. No lock was removed and no unrelated worktree changes were altered.
