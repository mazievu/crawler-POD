# Architecture Closure Report — Final Architecture Closure Round

Date: 2026-08-26
Scope: Run lifecycle state machine, resource ownership, stuck recovery, retry, marketplace claim lifecycle, DB V2 read/write model, restart recovery, no-orphan invariants.
Method: read current source directly (not prior reports), ran the full test suite before and after changes, fixed two confirmed invariant violations with regression tests, added a no-orphan diagnostic.

---

## 1. Executive Result

**ARCHITECTURE CLOSED — for everything verifiable in this repository/session.**
**§17 (Production DB Rebuild) and §19 (Cutover) are NOT executed** — they require running destructive/irreversible operations against a real production database, which is outside a code-review session and was not requested explicitly. Everything below that is a code/test claim has been read from current source and re-verified by running the tests, not carried over from any prior report.

Two real invariant violations were found and fixed this round (both previously untested):

1. **§5 CRITICAL — resource release on unconfirmed settlement.** `ResourceScheduler.dispatchRun()` was releasing a stuck attempt's worker slot/RAM/lock unconditionally after the grace period elapsed, regardless of whether `waitForSettled()` actually confirmed the real work had stopped. This is exactly the double-allocation hazard §5 prohibits. Fixed in [scheduler.js](../src/scheduler/scheduler.js): the resource is now held indefinitely (with an honest `RECOVERY_CLEANUP_FAILED` record) until settlement is actually confirmed.
2. **§11 — export growth degrading to 0 under V2.** `/api/export/:runId` unconditionally read legacy `getSnapshotHistory()` for growth, which returns nothing once `LEGACY_SNAPSHOT_WRITE=false` stops legacy rows from accumulating. Fixed in [server.js](../server.js): under `READ_MODEL_V2=true`, growth is now read from `product_current`'s already-computed `delta_*` fields (the same "vs. previous crawl" semantics the legacy path used).

A third change closes an accounting gap in the diagnostics layer itself (§13, below).

---

## 2. Final Run State Machine

The codebase does not use the exact `WAITING/ACTIVE/TERMINAL` label set from the prompt; it uses a flatter, already-consistent set enforced by a single `runs.status` column:

| DB status | Group | Resource-holding? |
|---|---|---|
| `pending`, `queued`, `sharded` | WAITING | No — enforced by construction: a run only holds a slot/RAM/lock from the moment `dispatchRun()` runs (`markRunning`) until its `.finally()` releases them. |
| `running` | ACTIVE | Yes — exactly one `executionToken` per attempt (see §3). |
| `done`, `failed`, `stuck` | TERMINAL | No. |

There is no persisted `aborting`/`recovering` DB status — that distinction lives in the in-memory `HeartbeatTracker.stage` (`INIT/ROUTING/SCRAPING/NORMALIZING/PERSISTING/COMPLETED/FAILED`) and the Execution Control Registry's `settled` flag, not in the `runs` table. This is architecturally sound: restart recovery only needs to reconcile `status='running'` rows (§12) because that is the only status under which a resource can be held, regardless of which internal stage it crashed in.

---

## 3. Ownership Map

| Concern | Owner | File |
|---|---|---|
| Run lifecycle status | `runs.service.js` / `ResourceScheduler` / `StuckDetector` / `ManagedExecution`, all gated by execution-lease | [runs.service.js](../src/runs.service.js), [scheduler.js](../src/scheduler/scheduler.js) |
| Queue + dispatch | `ResourceScheduler` | [scheduler.js](../src/scheduler/scheduler.js) |
| Worker slot / RAM / lock | `WorkerPoolManager` + `ResourceMonitor`, keyed by `executionToken` (never `runId`) | [worker-pool.js](../src/scheduler/worker-pool.js), [resource-monitor.js](../src/scheduler/resource-monitor.js) |
| Execution abort/cleanup/settlement | `ExecutionControlRegistry` | [execution-control.js](../src/reliability/execution-control.js) |
| Execution business ownership | `executionToken` via `isCurrentOwner()` | [execution-lease.js](../src/reliability/execution-lease.js) |
| Marketplace schedule ownership | `claimToken`, DB-layer protected | [database.js](../src/database.js) (`claimMarketplaceCaptureSchedule` et al.), [capture-scheduler.js](../src/marketplaces/capture-scheduler.js) |
| Current business state | `product_current` | [product-current.js](../src/database/product-current.js) |
| Historical observations | `daily_packed_history` | [daily-history.js](../src/database/daily-history.js) |
| Per-Run result/export | `runs.result_items_json` | [database.js](../src/database.js) `getRunItems` |

No module writes `runs.status` without first checking `isCurrentOwner()` for a stale-attempt scenario, except the two "owner-of-record" transitions themselves (`ResourceScheduler.queue.markRunning`, `StuckDetector.recoverExecution`, `restart-recovery`) — these are the deliberate single owners for their respective transitions and are the only places that legitimately issue a *new* token.

---

## 4. Resource Lifecycle

Ownership keyed by `executionToken`, not `runId` — verified by test (`WorkerPoolManager ownership is keyed by executionToken...`). Admission → reservation → dispatch → release is a straight line in `tick()`/`dispatchRun()`; release now (post-fix) only happens after `waitForSettled()` confirms real settlement (§5).

---

## 5. Execution Control

`ExecutionControlRegistry` (`execution-control.js`) is the bridge between DB-level ownership revocation and the actual live process (AbortController + cleanup callbacks). `ManagedExecution` (`managed-execution.js`) registers every non-channel execution; channel-based runs (`runs.service.js`) do not register (their abort story is simpler — see §6).

---

## 6. Stuck Recovery — FIXED THIS ROUND

Before: `StuckDetector.recoverExecution()` called `abortExecution()` + a *bounded* `waitForSettled()`, logged a warning if it timed out, but proceeded with retry bookkeeping regardless. Separately, `ResourceScheduler.dispatchRun()`'s `.finally()` also awaited `waitForSettled()` but then **released the slot/RAM/lock unconditionally** even when it returned `false`.

After: `dispatchRun()` now branches on the result:
- `settled === true` (including the common case where the token was never registered, e.g. plain channel runs) → release immediately, as before.
- `settled === false` → record the token in `cleanupFailedTokens` (visible via `getStatus()`), log `RECOVERY_CLEANUP_FAILED`, and keep polling `waitForSettled()` until it actually returns `true` — the slot/RAM/lock are **never** released on a fake/assumed settlement.

Regression test: `ResourceScheduler does not release or double-allocate a resource when Attempt A never confirms settlement (#5/§15.E)` in [scheduler.test.js](../test/scheduler.test.js) — proves B is not dispatched while A is unsettled, and is dispatched only after real settlement lands (however late).

---

## 7. Retry Lifecycle

`RetryPolicy` + `classifyFailureReason()` distinguish deterministic config failures (never retried) from transient/dependency failures (bounded retry with backoff). Every retry issues a fresh `executionToken` via `issueExecutionToken()`, which invalidates the old attempt's write access (`isCurrentOwner()` becomes false for it). Verified by existing tests (`Execution lease prevents a stale (revoked) attempt from overwriting a newer attempt (P0-8)`).

---

## 8. Marketplace Schedule Lifecycle

`claimToken` is threaded through `discover → assertClaimOwnership (post-discovery) → per-item assertClaimOwnership → capture → assertClaimOwnership (pre-completion) → markComplete`. `markComplete`'s DB write (`completeMarketplaceCaptureSchedule`) is itself `claim_token`-protected (`WHERE id = @id AND claim_token IS @claimToken`), so a stale attempt cannot fake a successful completion even if all the JS-level assertions were somehow bypassed — belt and suspenders, matching §18's requirement. Verified by existing tests (`claimMarketplaceCaptureSchedule is atomic...`, `a stale claim holder (A) cannot renew or release...`).

---

## 9/10. DB Write Model / Read Model

Confirmed the 3-tier model is real and wired: `product_current` (current), `daily_packed_history` (history), `runs.result_items_json` (per-run result). `/api/items`, `/api/items/:uid/history`, `/api/database/parity` already branch correctly on `READ_MODEL_V2`. **`/api/export/:runId` did not — fixed this round** (§1 above, §11 below).

---

## 11. History Identity / Idempotency / Full Parity — verified, one export bug fixed

- Observation identity: `run:<runId>:<itemUid>` (live) / `legacy:<snapshotId>` (migrated) — never timestamp-only. Confirmed in `daily-history.js`.
- Idempotency: `appendObservation()` replaces-by-identity, `observation_count` always derived from final array length. Verified by existing tests (`Daily Packed History appendObservation is idempotent by observationId`).
- Parity: `checkV2Parity()` checks per-metric mismatches (not just price/likes), missing/duplicate/malformed observations. Verified by existing tests (`checkV2Parity detects a full-metric mismatch...`, `...missing historical observations...`, `...a duplicate observation makes parityOk false...`).
- **Gap found and fixed:** export growth (`/api/export/:runId`) read legacy history unconditionally, silently degrading to `growth=0` under V2 cutover. Now reads `product_current.delta_*` under `READ_MODEL_V2=true`. Regression test added: `getProductCurrentByUid exposes real non-zero growth across two sequential crawls... (#11)` in [db-cutover.test.js](../test/db-cutover.test.js).
- **Known residual gap (not fixed this round, flagged honestly):** `daily_packed_history` observations do not carry a `reviews` field (only `rating`); `product_current.delta_reviews` is computed from raw item counts, not from `daily_packed_history`, so a `reviews` growth figure computed strictly from packed history (as the literal §10 schema implies) is not yet possible. The export fix above uses `product_current.delta_reviews`, which is correct and non-zero, but is a different V2 source than "compute from daily_packed_history" — flagged here rather than silently declared closed. Widening `daily_packed_history`'s observation schema to include `reviews` is a larger, riskier migration/parity change that was judged out of scope for this round's risk budget.

---

## 12. Restart Recovery

`recoverOrphanedRuns()` scans `status='running'` directly via `getRunsByStatus`, unbounded by row-limit. Every recovered run gets a fresh `executionToken`, invalidating the original process if it wakes up later. Since only `running` ever holds a resource (§2), this single status check covers a crash at any internal stage (SCRAPING/PERSISTING/etc.) without needing separate handling. Verified by existing test (`RestartRecovery re-queues retryable orphaned runs upon boot`).

---

## 13. No-Orphan Verification — new diagnostic added

Added `assertSystemInvariants(scheduler)` in [system-invariants.js](../src/reliability/system-invariants.js) — deliberately small (one function, ~35 lines), checks that every worker-pool slot/lock/RAM-reservation token is accounted for by `activeRunMetrics` or `cleanupFailedTokens`. Also fixed a related honesty gap: `activeRunMetrics.delete(executionToken)` was previously called at the *start* of the release `.finally()`, before settlement was confirmed — meaning `getStatus()` would report a token as "not active" while its resource was still genuinely held. Moved to fire only immediately before the actual release. Regression test: `assertSystemInvariants reports no orphans while a resource is held pending settlement, and after release (#13)`.

---

## 14. Failure Injection Matrix

Covered by existing + new tests: dead heartbeat (`EXECUTION_LOST`), stalled progress (`EXECUTION_STALLED`), managed-execution timeout with a non-cooperating workFn, browser/CDP resource cleanup on timeout, stale execution writes rejected, claim lost mid-capture / immediately before completion, server restart with orphaned `running` rows, duplicate observation idempotency, and (new) an execution that never settles. Not separately injected this round: DB busy/locked, live network timeout against a real backend, live CDP process hang — these require a running dependency stack and were not exercised in this dev-only session.

---

## 15. 7-Transition Test Matrix

| Transition | Status |
|---|---|
| A. CREATE→QUEUE | Covered (`RunQueue.enqueue`, existing tests) |
| B. QUEUE→ACTIVE | Covered (`ResourceScheduler admits jobs within capacity...`) |
| C. ACTIVE→DONE | Covered (existing `insertSnapshots`/`executeRun` tests) |
| D. ACTIVE→RETRY | Covered (`Execution lease prevents a stale attempt...`, retry-policy tests) |
| E. ACTIVE→RETRY, A never settles | **Newly covered this round** (§6) |
| F. ACTIVE→FAILED | Covered (retry-policy/`shouldRetry` exhaustion tests) |
| G. server crash→RECOVERED/FAILED | Covered (`RestartRecovery re-queues retryable orphaned runs`) |

---

## 16. DB End-to-End Test Matrix

Existing tests already cover: two sequential runs with active/dropped/new item classification under `LEGACY_SNAPSHOT_WRITE=false`, legacy row count staying flat, and `/api/items`/`/api/items/:uid/history` reading correctly under V2. Export growth is now included (§11). Full black-box HTTP-level exercise of `/api/runs/:id` and `/api/export/:runId` against a live server process was not performed in this session (would require booting `server.js`, which starts background schedulers) — the underlying data-layer logic those routes depend on (`getRunItems`, `getProductCurrentByUid`) was verified directly instead.

---

## 17. Production DB Rebuild

**Not performed.** This requires stopping writers, backing up the real production DB, running `PRAGMA integrity_check`, and rebuilding V2 tables from legacy — an irreversible-in-effect, live-environment operation. Doing this without an explicit, separate user request and confirmation would violate the "don't take risky/destructive actions unprompted" rule. The rebuild/backfill code (`backfillSnapshotsToV2`, idempotent by `legacy:<snapshotId>` identity) already exists and is exercised by unit tests; running it against the real `data/collector.db` is a deliberate operational step for the user to request explicitly.

---

## 18. Full Parity Gate

`checkV2Parity()` exists and is exercised by tests for every failure mode listed in the prompt (missing/duplicate/malformed/mismatch). Running it against the real production DB (as opposed to test fixtures) is part of §17 and was not performed for the same reason.

---

## 19. Cutover Evidence

Not performed — depends on §17/§18 having run against the real DB first. `READ_MODEL_V2`/`LEGACY_SNAPSHOT_WRITE` env flags exist and are individually exercised by tests; a live phased cutover against production is an operational action for the user to trigger.

---

## 20. npm test x3 / Codemap Validation

```
npm test  → 187 passed, 0 failed, 0 cancelled   (run 1)
npm test  → 187 passed, 0 failed, 0 cancelled   (run 2)
npm test  → 187 passed, 0 failed, 0 cancelled   (run 3)
npm run validate:codemap → ✅ CodeMap Validation Passed
```
(Baseline before this round's fixes was 184/184; +3 new regression tests added this round.)

---

## 21. Architecture Closure Checklist

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Every Run always has a known lifecycle state? | YES | `runs.status` CHECK-equivalent set, §2 |
| 2 | Can an ACTIVE Run have >1 current owner? | NO | `isCurrentOwner()` gate on every write path (§3) |
| 3 | Can WAITING/TERMINAL Run hold resource? | NO | Resource acquired only in `dispatchRun`, released before/at terminal (§2, §4) |
| 4 | Can stale execution write business state? | NO | `assertStillOwner`/`assertOwner` checks in `runs.service.js` and `managed-execution.js`, tested |
| 5 | Can a stuck execution's resource be released before real settlement? | NO (fixed this round) | §6 |
| 6 | Can retry B start while stuck A still owns the resource? | NO (fixed this round) | §6, test §15.E |
| 7 | Can stale Marketplace execution complete a newer claim? | NO | `claim_token`-protected DB write (§8) |
| 8 | Can legacy writes be disabled while all production routes still work? | YES | `LEGACY_SNAPSHOT_WRITE=false` tests pass; export route fixed this round (§11) |
| 9 | Can DB migration run twice without changing result? | YES | `appendObservation` idempotent-by-identity tests |
| 10 | Can server restart leave Runs permanently running? | NO | `recoverOrphanedRuns` (§12) |

**All ten answers are in the required direction.** Architecture is closed at the code level.

---

## 22. Architecture Freeze Decision

**FREEZE GRANTED** for the core Scheduler/Worker/Execution-Control/DB-V2 architecture. Future issues found during UI/live testing should be triaged first as implementation/integration/platform/config bugs, per the prompt's own definition-of-done — not as license to redesign this layer again, unless a NEW invariant violation is proven (as §5 was proven and fixed this round).

Explicitly NOT frozen / still open, and intentionally left to the user to schedule:
- §17 Production DB rebuild against the real database.
- §19 Live phased cutover.
- The `daily_packed_history` `reviews` field gap noted in §11.

---

## 23. Files Changed This Round

- [src/scheduler/scheduler.js](../src/scheduler/scheduler.js) — §5/§13 fix: honest resource retention on unconfirmed settlement; `cleanupFailedTokens` bookkeeping; `activeRunMetrics` cleared only at actual release time; `getStatus()` exposes `cleanupFailed`.
- [src/reliability/system-invariants.js](../src/reliability/system-invariants.js) — new: `assertSystemInvariants()`.
- [src/database.js](../src/database.js) — new `getProductCurrentByUid()` export.
- [server.js](../server.js) — `/api/export/:runId` growth now reads V2 (`product_current.delta_*`) under `READ_MODEL_V2=true`.
- [test/scheduler.test.js](../test/scheduler.test.js) — 2 new tests (§5/§15.E, §13).
- [test/db-cutover.test.js](../test/db-cutover.test.js) — 1 new test (§11).
