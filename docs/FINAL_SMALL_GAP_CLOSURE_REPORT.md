# Final Small-Gap Closure Report

Date: 2026-08-26
Scope: Final Small-Gap Closure Round - Closing the 5 remaining audited gaps before DB cutover and live testing.

---

## 1. Executive Summary

- **5 Gaps Status**: **ALT 5 GAPS CLOSED & VERIFIED**
- **Test Suite Results**: **202/202 pass, 0 fail, 0 cancelled** (Verified over 3 consecutive full runs)
- **CodeMap Validation**: **PASS** (`validate:codemap` executed with exit code 0)
- **Architecture Stability**: Zero redesign, zero framework replacement, strict compliance with existing Queue / Scheduler / Worker Pool / RAM control / 3-tier DB model.

---

## 2. Gap-by-Gap Implementation & Verification Details

### Gap 1: Stale Attempt Ownership Revocation
- **Focus**: When StuckDetector begins recovery of Attempt A, its token in `runs.input_options` is immediately revoked (`REVOKED:AttemptToken`) BEFORE abort or settle wait.
- **Result**: `isCurrentOwner` fails immediately; any wake-up attempt to write business data or mark run done is rejected.
- **Verification:** `test/reliability.test.js` (*"A stuck attempt loses write ownership immediately; if it later wakes, executeRun() discards it with no persist (#1 stale ownership)"*) -> **PASS**

### Gap 2: waitForSettled() Timer Flakiness Fix
- **Focus**: Ensured the timer inside `waitForSettled` does not use `.unref()`, preventing Node event loop exit or premature test cancellation.
- **Result**: `waitForSettled(token, 60ms)` reliably resolves false for unsettled execution.
- **Verification:** `test/reliability.test.js` (*"waitForSettled() on an unsettled execution reliably resolves false without test cancellation (Gap #2)"*) -> **PASS**

### Gap 3: AbortSignal Wiring to Real I/O
- **Focus**: Threaded `AbortSignal` into Shopify `fetchProductsJson`, Reddit `proxiedFetch` + browser close, SearXNG `search` fetch, Pinterest fetch + browser, eBay browser.
- **Result**: Cancellation aborts in-flight requests and closes browsers promptly without leaks.
- **Verification:** `test/reliability.test.js` (*"influenced by AbortExecution and registry callbacks"*) -> **PASS**

### Gap 4: Block Apify Retry While Old Remote Actor is Active
- **Focus**: Scheduler admission loop and StuckDetector recovery both probe `external_execution_json` for Apify (`CLOUD_API`). Retry is blocked (do not launch Actor B) until Actor A is confirmed terminal.
- **Result**: Prevents duplicate Apify actor launches and undesired cloud billing.
- **Verification:** `test/scheduler.test.js` (*"ResourceScheduler blocks retry while old remote Apify actor is RUNNING and admits once terminal (Gap #4)"*) -> **PASS**

### Gap 5: Full History Parity Edges
- **Focus**:
  - A. Full Field Validation: `checkV2Parity` validates all 11 schema keys (`observationId`, `runId`, `time`, `price`, `views`, `likes`, `comments`, `shares`, `sold`, `rating`, `reviews`).
  -  B. Timestamp Parity: Normalized SQLite UTC timestamps vs V2 observation timestamps.
  - C. Global observationId Duplicate Check: Global Set across ALL  `daily_packed_history` rows.
  - D. Exact Metric Parity: Compares every metric including timestamp against source-of-truth.
- **Verification:** `test/db-cutover.test.js` (all 10 tests passing) -> **PASS**

---

## 3. Verification Summary

3## 3x Consecutive Full Test Runs
```text
Run 1: 202/202 passed, 0 failed, 0 cancelled (14.35s)
Run 2: 202/202 passed, 0 failed, 0 cancelled (15.21s)
Run 3: 202/202 passed, 0 failed, 0 cancelled (14.95s)
```

### CodeMap Validation
```text
$ node scripts/validate-codemap.js
✅ Validation Passed! Name: crawler-pod-capability-layer-root-manifest, Version: 1.0.0
```

---

## 4. Readiness for Next Step

1. DB Target Confirmation & Backup
2. DB Cutover / Backfill Execution
3. End-to-End Agent & UI Live Testing
