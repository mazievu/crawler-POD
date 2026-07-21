# Async Etsy variant capture — TDD evidence

## Problem

`All dropdown variants` can take several minutes because the server opens every
valid Etsy variation combination. The former `POST /api/html-captures` held the
browser's HTTP request open for that entire time. A LAN/browser timeout then
appeared in the UI as the unhelpful `Failed to fetch` message, even while the
host capture executor was healthy.

## Red

Added job-queue tests which require an immediate acknowledgement, a completed
result, a safe failed state, and a missing-job result. The first run failed
because `src/marketplaces/capture-jobs.js` did not exist.

## Green

- `POST /api/html-captures` returns `202 { job }` immediately only for Etsy
  `variantMode: all`.
- The capture continues on the collector server; `GET /api/html-capture-jobs/:id`
  returns `running`, `completed`, or `failed`.
- The UI polls that endpoint every two seconds and keeps the capture dialog
  open. It disables the submit button while the job is active, preventing
  duplicate browser sessions.
- Single-page captures keep their existing synchronous `201` response.

## Verification

- Focused tests: 9/9 passed (`capture-jobs`, marketplace API, and UI).
- Queue coverage: lines 100%, functions 100%, branches 84.62%.
- Full suite: 88/88 tests passed. The project emits existing non-failing live
  probe diagnostics during this suite.
- Docker smoke test after a forced rebuild: a deliberately invalid Etsy URL
  returned HTTP 202 immediately, then the job reported the concrete validation
  error `URL does not belong to etsy` rather than a browser-level fetch error.
