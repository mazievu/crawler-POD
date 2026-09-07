# Pre-Live Architecture Closure Report

Date: 2026-08-26
Scope: implementation round closing all six CONFIRMED gaps from `ARCHITECTURE_GAP_ROOT_CAUSE_REPORT.md`. No redesign of RunQueue/ExecutionPlanner/WorkerPoolManager/ResourceMonitor/execution-lease/3-tier DB model/claim_token protection — every fix connects existing mechanisms, none replace them.

---

## 1. Executive Result

**CODE ARCHITECTURE: READY FOR LIVE TEST.**
**DB REBUILD / CUTOVER (§11–§12 of the prompt): NOT PERFORMED — STOPPED BY DESIGN, per the prompt's own instruction.**

`data/collector.db` is `.gitignore`d, holds 263 runs / 188 snapshots (dev/test scale), and nothing in this repository or session identifies it as the live-test target database. Per the prompt: *"DO NOT assume a small DB inside a ZIP is production... If DB identity is uncertain: STOP at this point and report exactly what DB is required."* This report stops there and asks: **which database (path/location) is the actual live-test target?** Once identified, §11's backup → integrity-check → deterministic-rebuild-twice → full-parity → §12's phased cutover can run against it following the exact steps already specified in the prompt — the code to do so (`backfillSnapshotsToV2`, `checkV2Parity`) already exists and is exercised by tests; only the *target* is unconfirmed.

---

## 2. Gap #1 Closure Evidence

Two layers, both implemented:

**Layer 1** ([stuck-detector.js](../src/reliability/stuck-detector.js) `recoverExecution()`): if `waitForSettled()` returns `false`, the function now `return`s immediately after recording `status: 'stuck'` with a `RECOVERY_CLEANUP_FAILED` message — it no longer proceeds to queue a retry/issue a new token regardless of settlement.

**Layer 2** ([scheduler.js](../src/scheduler/scheduler.js) `tick()`): before admission, every candidate Run is checked against `activeRunMetrics`/`cleanupFailedTokens` by `runId` (not just by pool slot) — `continue`s (holds in queue) if any unsettled attempt for that Run already exists anywhere in the pool.

Regression tests (all passing):
- `ResourceScheduler does not admit a same-runId retry into a second free slot while an earlier attempt is unsettled (#1, multi-slot)` — `localConcurrency: 2`, proves Layer 2 directly, inverse of the prior round's confirmed-bad reproduction.
- `StuckDetector withholds retry and records RECOVERY_CLEANUP_FAILED when the old attempt never confirms settlement (#1 Layer 1)` — proves Layer 1 directly.

---

## 3. Unified ExecutionControl Coverage Matrix

| Class | Registered with ExecutionControlRegistry? | Abort propagation | Classification |
|---|---|---|---|
| LOCAL_HTTP (channel) | **YES** (added — `runs.service.js`) | `AbortSignal` threaded into `router.run()` → `scrapeWithRetry()`: aborts between attempts AND during backoff sleep (`abortableSleep`) | **BOUNDED** (loop-level; individual in-flight per-scraper `fetch()` calls are not all individually wired — see §4 residual scope) |
| CLOUD_API (Apify, channel) | **YES** (same `runs.service.js` registration) | `AbortSignal` checked at the top of each poll iteration in `apify.backend.js`; stops OUR polling, does not (cannot) stop the remote Apify actor itself | **BOUNDED** — cancellation only affects local resource release timing, not the remote job (see Gap #4, which handles the remote job's lifecycle on restart instead) |
| BROWSER (Playwright, channel) | **YES** (same registration, path-agnostic) | No additional per-scraper Playwright signal wiring this round (out of the minimal fix set — see residual scope) | **BOUNDED** by the same registration + settlement mechanics; per-page cancellation not deepened this round |
| CDP (Toidispy) | **YES** (same registration) + **direct process kill** | `AbortSignal` → `cdp.backend.js` kills the spawned child (`child.kill()`) — the exact child this execution owns, never a sibling's | **CANCELLABLE** |
| Non-channel (`user_journey`, `marketplace_capture`, `marketplace_discovery`) | Already registered (`managed-execution.js`, prior rounds) | Already wired (unchanged) | **CANCELLABLE** (User Journey) |

**Residual scope note (honest, not hidden):** the registry-level fix (registration + settlement + admission gate) closes the load-bearing part of Gap #2 — StuckDetector can now reach every channel execution's registry entry, `waitForSettled()` is no longer a blind no-op for this path, and the Scheduler's slot/RAM/lock accounting is honest for it. Deep per-scraper `fetch(url, {signal})` wiring inside every individual platform scraper (Etsy/Amazon/Shopify/Reddit's own network calls) was **not** exhaustively audited/wired file-by-file this round — the root-cause report classified this as Medium-High risk specifically because partial per-scraper wiring could be worse than consistent non-wiring. What WAS added (the loop/poll-level abort checks) bounds the worst case to "at most one more attempt's network call before the loop-level check fires," which is a materially smaller window than before (previously: no bound at all, retries continued regardless of abort).

---

## 4. Abort Propagation Evidence

Mandatory test — dispatch a real channel-style execution through `runs.service.executeRun`, trigger `abortExecution(token)`:

```
test('Channel execution registers with ExecutionControlRegistry and downstream work
observes abortExecution() via the threaded signal (#2)')
```
Result: pass. The downstream (mocked backend) call receives the exact `AbortController.signal` created in `executeRun()`, `abortExecution()` fires the real `abort()` event, the downstream promise rejects, and `waitForSettled()` correctly reports `true` once it does — no longer an instant-true no-op.

CDP-specific: `cdp.backend.js`'s abort listener calls `child.kill()` only for the child this exact invocation spawned (closure-scoped `child` variable, no shared/global state) — matches "do not kill shared resources belonging to another Run."

---

## 5. External Restart Reconciliation — CDP / Apify

New metadata: `runs.external_execution_json` (additive column, migration guarded like existing `runColumns.has(...)` patterns) storing `{ executionClass, externalExecutionId, executionToken, startedAt }`, written via a `reportExternalExecution` callback threaded from `runs.service.js` into `router.run()` → backend adapters:
- `cdp.backend.js` reports `{ executionClass: 'CDP', externalExecutionId: String(child.pid) }` immediately after spawning.
- `apify.backend.js` reports `{ executionClass: 'CLOUD_API', externalExecutionId: runId }` immediately after `startActor()`.

`restart-recovery.js`'s `recoverOrphanedRuns()` (now `async`, backward-compatible 3rd `probeOptions` parameter) reads this metadata on boot and, before any normal DB-level recovery:
- **CDP**: probes PID liveness via injectable `isPidAlive` (default: `process.kill(pid, 0)` — never a kill call). Alive or inconclusive → `RECOVERY_FAILED` (`status: 'stuck'`), **no requeue, no duplicate dispatch**. Confirmed stopped → falls through to normal recovery.
- **CLOUD_API**: probes remote status via injectable `getApifyRunStatus` (default: real `apifyClient.getRunStatus()`). Non-terminal or unconfirmed (`'UNKNOWN'`, or the probe itself throws) → `RECOVERY_FAILED`, **no duplicate Actor launch**. Confirmed terminal (`SUCCEEDED`/`FAILED`/`ABORTED`/`TIMED-OUT`) → falls through to normal recovery.

Never kills a PID based on existence alone (per the explicit prohibition) — the CDP path only ever *probes*, consistent with "protect against PID reuse / wrong ownership."

Four mandatory regression tests (fake process/remote-status functions injected, no live CDP/Apify required), all passing:
- `RestartRecovery refuses to requeue a Run whose external CDP process is still alive (#4.G)`
- `RestartRecovery safely requeues once the external CDP process is confirmed stopped (#4.G)`
- `RestartRecovery refuses to requeue when the Apify remote run status is unknown/unconfirmed (#4.H)`
- `RestartRecovery safely requeues once the Apify remote run reports a terminal status (#4.H)`

---

## 6. Marketplace Completion Race — Closed

[capture-scheduler.js](../src/marketplaces/capture-scheduler.js) `run()`: `markComplete`'s return value is now inspected. `completed === false` → `summary.error = 'MARKETPLACE_CLAIM_LOST'`, `summary.claimLost = true` — no fake success reported, no schedule mutation (the DB layer was already safe; only the caller's reported result was wrong).

Mandatory regression (using the REAL `createMarketplaceCaptureScheduler().run()` orchestration + REAL `database.js`, not just isolated DB-layer calls): `run() reports claimLost, not fake success, when ownership is stolen right before the final markComplete (#5)` — simulates the exact "final renew succeeds, then B steals ownership, then markComplete fails" race. Pass.

---

## 7. Final History Observation Schema

[daily-history.js](../src/database/daily-history.js) `appendObservation()` now includes `reviews` in every packed observation: `{ observationId, runId, time, price, likes, comments, shares, views, sold, rating, reviews }`. Finalized once, before any DB rebuild — not deferred. Identity (`legacy:<snapshotId>` / `run:<runId>:<itemUid>`) and idempotent replace-by-identity behavior are unchanged (already correct from the prior round) and now cover the widened schema automatically.

---

## 8. Full Observation-Level Parity — Closed

[database.js](../src/database.js) `checkV2Parity()` extended (additive, same function, same single pass over `daily_packed_history` merged with the existing malformed/duplicate scan — no second table scan added):
- Builds `item_uid -> Map<observationId, observation>` index in the existing scan loop.
- For **every** legacy `snapshots` row, computes `legacy:<id>`, looks up the exact observation by that identity, and diffs `price/views/likes/comments/shares/sold_count↔sold/rating/reviews` — not just counts.
- Detects: `historyMissingByIdentity` (a legacy row with no matching migrated observation), `historyExtraObservations` (a `legacy:<id>`-tagged observation with no backing legacy row), `historyMetricMismatches` (exact value differences).
- All three gate `parityOk` alongside the pre-existing count/duplicate/malformed checks.

Mandatory regression: `checkV2Parity detects an exact metric mismatch inside a correctly-identified packed observation, including reviews (Gap #3)` — same observation count, same identity, corrupted `likes` AND `reviews` values inside the migrated observation → `parityOk === false`, both mismatches reported by field name with legacy vs. V2 values. Pass.

---

## 9. No-Orphan Lifecycle Evidence

Per this round's explicit instruction, the existing scoped checker (`assertSystemInvariants()` — slot/RAM/lock only) was left as-is; the other five entity classes identified in the root-cause report are now covered by targeted regression tests instead of a broader checker:

| Entity | Regression test proving no orphan |
|---|---|
| Terminal Run → no active execution | `ResourceScheduler does not admit a same-runId retry...` (a stuck/terminal Run's slot is never silently reused) |
| Settled execution → no heartbeat | Pre-existing `HeartbeatTracker.persist() refuses to write once its executionToken is no longer the current owner (#10)` + `removeTracker` calls in every `executeRun`/`runManaged` exit path (unchanged, verified still passing) |
| Released execution → no slot/RAM/lock | Pre-existing `WorkerPoolManager ownership is keyed by executionToken...` + this round's `assertSystemInvariants` test (unchanged, still passing) |
| Marketplace completion/loss → no stale claim mutation | This round's `run() reports claimLost...(#5)` — asserts `last_summary` stays `null` for the stale attempt |
| External execution recovery → no known old PID/remote job still active before retry | This round's four Gap #4 tests (§5 above) |
| ExecutionControl → no stale registry entry after settlement | This round's `Channel execution registers with ExecutionControlRegistry...(#2)` — asserts `waitForSettled()` returns `true` (registry entry cleared) after the downstream work rejects |

---

## 10. Legacy-Write-Off Evidence

Unchanged from the prior round, re-verified still passing this round: `LEGACY_SNAPSHOT_WRITE=false: legacy snapshot row count is unchanged by a real crawl`, `With legacy writes OFF, new/active/dropped stay correct across two sequential Runs`, `getProductCurrentByUid exposes real non-zero growth... under READ_MODEL_V2`. `/api/items`, `/api/items/:uid/history`, `/api/export/:runId` all read from V2 sources when `READ_MODEL_V2=true` (export fixed last round, confirmed still correct).

---

## 11. Production DB Rebuild Status

**NOT PERFORMED.** See §1 — DB identity unconfirmed. `data/collector.db` is `.gitignore`d (untracked), holds 263 runs / 188 snapshots. No path, ZIP, or explicit statement in this session identifies a separate production database. Following the prompt's own instruction, this is a STOP point, not a judgment call to proceed on assumption.

**What is needed to proceed:** the user should confirm — is `data/collector.db` in this working directory itself the live-test target, or does live test point at a different database (a server path, a mounted volume, a different `DB_PATH` env var, a separate deployment)? Once confirmed, §11/§12 of the prompt can run exactly as specified (backup → SHA256 → integrity_check → `backfillSnapshotsToV2()` run twice idempotently → `checkV2Parity()` full pass → phased `READ_MODEL_V2`/`LEGACY_SNAPSHOT_WRITE` cutover) using code that already exists and is tested.

---

## 12. Cutover Status

**NOT PERFORMED** — gated on §11.

---

## 13. npm test x3

```
npm test  -> 196 passed, 0 failed, 0 cancelled   (run 1)
npm test  -> 196 passed, 0 failed, 0 cancelled   (run 2)
npm test  -> 196 passed, 0 failed, 0 cancelled   (run 3)
```
(Baseline entering this round was 191; +5 net new regression tests directly covering Gaps #1/#2/#3/#4/#5, some gaps contributing multiple tests.)

---

## 14. Codemap Result

```
npm run validate:codemap -> CodeMap Validation Passed
```

---

## 15. Remaining EXTERNAL Dependencies Only

- A confirmed, real live-test/production database target (blocks §11/§12 only — not a code gap).
- Live CDP/Toidispy Chrome instance and Live Apify credentials for true end-to-end (not unit-mocked) verification of the reconciliation logic in §5 — the logic itself is proven with injected fakes per the prompt's own allowance ("Mandatory tests can inject fake process/remote-status functions. No need to require live Apify/CDP in unit tests").
- Deep per-scraper (`fetch`) AbortSignal wiring inside individual platform scrapers (Etsy/Amazon/Shopify/Reddit's own network layer) remains a residual, explicitly-scoped-out item (§3) — the loop/poll-level bound already closes the load-bearing part of Gap #2 (registry integration + admission-gate honesty); tightening individual in-flight network call cancellation further is a lower-risk follow-up, not a blocker, since it only affects how QUICKLY an aborted execution's real work stops, not whether the system can double-allocate its resources (Gap #1's fix is independent of this and closes that regardless).

---

## 16. Files Changed This Round

- [src/reliability/stuck-detector.js](../src/reliability/stuck-detector.js) — Gap #1 Layer 1.
- [src/scheduler/scheduler.js](../src/scheduler/scheduler.js) — Gap #1 Layer 2 (admission-time runId gate).
- [src/marketplaces/capture-scheduler.js](../src/marketplaces/capture-scheduler.js) — Gap #5.
- [src/database/daily-history.js](../src/database/daily-history.js) — Gap #3 schema (`reviews`).
- [src/database.js](../src/database.js) — Gap #3 parity extension; Gap #4 `external_execution_json` column/migration + `updateRun`/`getProductCurrentByUid` support (the latter already added last round).
- [src/runs.service.js](../src/runs.service.js) — Gap #2 (ExecutionControlRegistry registration + signal threading) + Gap #4 (`reportExternalExecution` callback).
- [src/backends/cdp.backend.js](../src/backends/cdp.backend.js) — Gap #2 (child-process abort) + Gap #4 (PID reporting).
- [src/backends/apify.backend.js](../src/backends/apify.backend.js) — Gap #2 (poll-loop abort) + Gap #4 (actor runId reporting).
- [anti-bot/scraper-factory.js](../anti-bot/scraper-factory.js) — Gap #2 (abortable retry loop/backoff).
- [src/reliability/restart-recovery.js](../src/reliability/restart-recovery.js) — Gap #4 (external execution probing, now `async`).
- [server.js](../server.js) — updated boot-time call site for the now-`async` `recoverOrphanedRuns`.
- [test/scheduler.test.js](../test/scheduler.test.js), [test/reliability.test.js](../test/reliability.test.js), [test/marketplace-scheduler.test.js](../test/marketplace-scheduler.test.js), [test/db-cutover.test.js](../test/db-cutover.test.js) — regression tests for all five code-level gaps.
