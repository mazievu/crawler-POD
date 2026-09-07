# Final 2-Patch Closure Report

Date: 2026-08-26
Scope: Final 2-Patch Closure Round - Closing the last 2 known small gaps before core freeze and live cutover.

---

## 1. Executive Summary

- **Final Status**: **FINAL 2 PATCHES CLOSED**
- **Test Suite (3x Consecutive Full Runs)**: **207/207 passed, 0 failed, 0 cancelled** on all 3 runs.
- **CodeMap Validation**: **PASS** (`validate:codemap` exit code 0).
- **Core Freeze**: All core mechanisms (Queue, Scheduler, Worker Pool, RAM Monitor, 3-tier DB model) remain intact with zero structural redesign.

---

## 2. Patch 1: Etsy Abort & Everbee AbortSignal Wiring

### 2.1 Etsy Abort Stop Fix
- **File Changed**: `src/scrapers/etsy.js`
- **Problem**: When an Etsy execution was aborted, SearXNG aborted correctly and threw an error, but `etsy.js` caught the error and treated it like a regular search discovery failure, continuing into Everbee host discovery and DB cache fallback.
- **Fix Implemented**: In all tiers of `etsy.js` (Tier 1 SearXNG discovery, Tier 2 Everbee host discovery, Tier 3 DB cache), if the error is an abort or `options.signal.aborted` is true, the error is immediately rethrown. The execution halts immediately without attempting Everbee or DB fallbacks.

### 2.2 Everbee AbortSignal Threading
- **File Changed**: `src/marketplaces/everbee-host-client.js`
- **Problem**: Everbee host client `fetchImpl` did not receive `signal`, leaving in-flight HTTP requests running after Run abort.
- **Fix Implemented**: Both `captureViaEverbeeHost` and `discoverMarketplaceListingsViaEverbeeHost` now accept `signal` and pass with signal directly to `fetchImpl`.

---

## 3. Patch 2: History Null Parity & SQLite UTC Timestamp Migration

### 3.1 Null Asymmetry Parity Fix
- **File Changed**: `src/database.js` (`checkV2Parity`)
- **Problem**: Previously, `legacyValue == null || obsValue == null` silently skipped cases where one side had a metric value and the other was null, hiding data loss.
- **Fix Implemented**:
  - `legacy == null && obs == null` -> equal (continue).
  - `legacy has value && obs == null` -> mismatch (`historyMetricMismatches += 1`, `parityOk = false`).
  - `legacy == null && obs has value` -> mismatch (`historyMetricMismatches += 1`, `parityOk = false`).
  - `both present` -> numeric equality check.
  - Applied to all metrics: price, views, likes, comments, shares, sold, rating, reviews for both current-state and historical parity.

### 3.2 SQLite UTC Timestamp Migration Fix
- **Files Changed**: `src/database/daily-history.js`, `src/database.js`
- **Problem**: SQLite CURRENT_TIMESTAMP stores timestamps as YYYY-MM-DD BH:mm:ss[ UTC, without Z]. Passing this to new Date() in Node.js on machines with non-UTC local timezones (e.g. UTC+7) causes V8 to parse it as local time, shifting migrated timestamps by 7 hours.
- **Fix Implemented**:
  - Created canonical helper normalizeLegacyUtcTimestamp(rawTimestamp) in daily-history.js (exported and reused in database.js).
  - Converts YYYY-MM-DD BH:mm:ss explicitly into canonical ISO UTC: YYYY-MM-DDTHH:mm:ss.000Z.
  - Used consistently across:
    - `backfillSnapshotsToV2(` for product_current and daily_packed_history
    - `appendObservation()` in daily-history.js
    - `checkV2Parity()` for snapshot vs observation timestamp comparisons.

---

## 4. Focused Regression Tests Evidence

```text
- normalizeLegacyUtcTimestamp interprets SQLite timestamp as UTC regardless of local timezone (Patch #2B): PASS
- checkV2Parity fails parity on asymmetric null metrics between legacy and V2 (Patch #2A): PASS
- Backfill with SQLite UTC timestamp string produces exact UTC observation and 0 timestamp mismatch (Patch #2B): PASS
- Etsy execution abort observes AbortSignal and does NOT fall back to Everbee or DB cache (Patch #1): PASS
- Everbee client discovery and capture observe threaded AbortSignal (Patch #1): PASS
Count: 5 pass, 0 fail
```

---

## 5. Full Test Suite Validation (3x Consecutive Runs)

```text
Run 1: 207/207 passed, 0 failed, 0 cancelled (15.87s)
Run 2: 207/207 passed, 0 failed, 0 cancelled (14.40s)
Run 3: 207/207 passed, 0 failed, 0 cancelled (15.78s)
```

---

## 6. CodeMap Validation

```text
$ node scripts/validate-codemap.js
CodeMap Validation Passed! Name: crawler-pod-capability-layer-root-manifest, Version: 1.0.0
```

---

## 7. Files Changed Summary

1. src/scrapers/etsy.js - Stop on abort across all tiers, prevent Everbee/DB fallbacks.
2. src/marketplaces/everbee-host-client.js - Thread signal into fetchImpl for discovery and capture.
3. src/database/daily-history.js - normalizeLegacyUtcTimestamp helper + UTC timestamp normalization in appendObservation.
4. src/database.js - Null asymmetry parity check in checkV2Parity + UTC timestamp normalization in backfillSnapshotsToV2 and parity checks.
5. test/reliability.test.js - Added regression tests for Etsy abort and Everbee AbortSignal.
6. test/db-cutover.test.js - Added regression tests for SQLite UTC timezone normalization, asymmetric null parity, and backfill parity.
