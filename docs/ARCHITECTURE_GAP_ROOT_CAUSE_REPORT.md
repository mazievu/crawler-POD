# Architecture Gap Root-Cause Report

Date: 2026-08-26
Method: read current source directly, traced production call paths, wrote and ran standalone reproduction scripts against the real `ResourceScheduler`/`database.js` (not mocks-only assertions). No production code was changed in this round — investigation only, per instruction.

Reproduction scripts (not part of `npm test`, run manually, referenced below):
- `repro-gap1-multi-slot-retry-race.js`
- `repro-gap5-marketplace-completion-race.js`

---

## 1. Executive Summary

| Gap | Verdict |
|---|---|
| #1 Retry queued before old attempt settles (multi-slot race) | **CONFIRMED** — reproduced live |
| #2 Channel crawlers don't register with ExecutionControlRegistry | **CONFIRMED** — proven by absence of any call site |
| #3 History parity is count-parity, not observation-level metric parity | **CONFIRMED** — read the full `checkV2Parity()` implementation |
| #4 Restart recovery doesn't reconcile external processes (CDP/Toidispy child) | **CONFIRMED** — proven by absence of any child-PID tracking |
| #5 Marketplace final `markComplete` race — return value ignored | **CONFIRMED** — reproduced live |
| #6 No-orphan checker coverage is partial | **CONFIRMED** — checker (written last round, by this same investigation) only covers pool/RAM/lock, not 5 other orphan classes |

The previous round's fix (§5 of the prior "Final Architecture Closure" report) was **necessary but not sufficient**: it correctly stops a *retried attempt from reusing the exact same slot A held*, but does nothing to stop a *different* free slot in the same pool from being handed to a retry of the same Run while A is still physically unsettled. That is Gap #1, and it is the load-bearing finding of this round.

---

## 2. System Lifecycle As-Is

```
CREATE (RunQueue.enqueue → db.createRun, status='pending'/'queued')
  → QUEUE (queue.peek() surfaces it to Scheduler.tick())
  → ADMIT (ExecutionPlanner.plan() + WorkerPoolManager.canAdmit() + ResourceMonitor.canAdmit())
  → ACTIVE (queue.markRunning(); dispatchRun() calls executeFn — either runs.service.executeRun for
    channel jobs, or a runManaged()-wrapped function for non-channel jobs)
  → SUCCESS/FAILURE (executeFn's promise resolves/rejects)
  → SETTLE (dispatchRun()'s .finally(): await waitForSettled(token, grace))
  → RELEASE (pools.releaseAllForToken(token); monitor.release(token))
  → next tick can admit a new attempt
```

Separately and asynchronously, `StuckDetector.checkStuckRuns()` runs on its own 15s timer, reading the in-memory heartbeat registry, and can flip a **still-ACTIVE** Run's DB row back to `queued` (with a new token) *independently* of whether `dispatchRun()`'s own SETTLE/RELEASE steps above have happened yet for the old token. This is the seam where Gap #1 lives — **two different mechanisms (`StuckDetector` and `dispatchRun()`'s own settlement wait) both react to the same "attempt is stuck" fact, on independent timers, without a shared "is this runId still occupied" barrier.**

---

## 3. Gap #1 — Retry Queued Before Old Attempt Settles

### Source trace

1. `StuckDetector.checkStuckRuns()` (`stuck-detector.js:131`) reads `getActiveHeartbeats()` every 15s.
2. On liveness/progress staleness, calls `recoverExecution(hb, reasonCode, reasonMessage)` (`stuck-detector.js:87`).
3. `recoverExecution()`:
   ```js
   await abortExecution(hb.executionToken, reasonCode);
   const settledInTime = await waitForSettled(hb.executionToken, this.cleanupGraceMs);
   if (!settledInTime) {
     console.warn(...); // logs only
   }
   if (this.retryPolicy.shouldRetry(attempt, new Error(reasonCode))) {
     const nextAttempt = attempt + 1;
     const updatedOptions = { ...options, attempt: nextAttempt, executionToken: issueExecutionToken(hb.runId, nextAttempt) };
     this.db.updateRun(hb.runId, { status: 'queued', errorMessage: ..., inputOptions: JSON.stringify(updatedOptions) });
   }
   ```
   **`settledInTime` is read into a variable and only used for a `console.warn` — the subsequent `db.updateRun(..., status:'queued', ...)` call happens unconditionally**, whether `settledInTime` is `true` or `false`.
4. On the next `ResourceScheduler.tick()` (every 2s), `this.queue.peek(20)` returns this now-`queued` Run as a candidate.
5. `tick()`'s admission logic:
   ```js
   const executionToken = issueExecutionToken(run.id, attempt); // token B
   const poolCheck = this.pools.canAdmit(poolName, requiredLocks, executionToken);
   ```
   `WorkerPoolManager.canAdmit()` (`worker-pool.js:101`) checks **only pool-level capacity** (`this.activeWorkers[p].size < this.capacities[p]`) and **lock ownership by key** — it has **zero knowledge of `runId`**. It cannot see "token A, which belongs to this same runId, is still occupying a slot in this pool."
6. If the pool has more than one slot, and slot #1 (A) is still held (my prior round's fix correctly keeps it held when unsettled), slot #2 is still free from the pool's perspective → B is admitted and dispatched.

### Reproduction (live, not simulated)

`repro-gap1-multi-slot-retry-race.js`, `localConcurrency: 2`, Attempt A's `executeRun` returns a promise that **never resolves** (the "A truly never settles" case §5/§15.E already covers for the *same*-slot case). Output:

```
After A dispatched: pool status = {"running":1,"capacity":2}
StuckDetector-style requeue applied WITHOUT waiting for A to settle. ...
After tick() following requeue:
Dispatched total: [{"runId":1,"attempt":1,...},{"runId":1,"attempt":2,...}]

=== VERDICT ===
GAP #1 CONFIRMED: Attempt B was dispatched into a second free slot while Attempt A
(never settled, still holding slot #1) is still running.
```

### Root cause

**Two different notions of "is this Run's retry allowed" are conflated as one, and only one of them is actually enforced.**
- *Physical resource ownership* (which exact slot/lock/RAM does token A hold) — enforced correctly, keyed by `executionToken`, in `WorkerPoolManager`/`ResourceMonitor`.
- *Logical Run-retry gate* (is there ANY still-unsettled attempt for THIS runId, anywhere in the pool, on any slot) — **not represented anywhere in the codebase**. `canAdmit()` operates purely per-pool-capacity; nothing consults `runId` during admission.

`StuckDetector.recoverExecution()` conflates the two: it treats "I asked A to abort and waited a bounded grace period" as sufficient justification to unconditionally re-queue the Run, because it assumes (incorrectly) that the *physical resource* protection downstream (my prior fix) is *also* a *Run-level* retry gate. It is not — it only protects the one specific slot A happened to occupy.

### Violated invariant

**C (RETRY)** — "Attempt B không được bắt đầu khi Attempt A chưa settle hoàn toàn," and by extension **A (OWNERSHIP)**, since for a window both A and B are simultaneously live executions of the same Run.

### Why prior round's test/fix did not catch this

The prior round's regression test (`ResourceScheduler does not release or double-allocate a resource when Attempt A never confirms settlement`) used `poolOptions: { localConcurrency: 1 }` — **deliberately, to prove the same-slot-reuse fix**, which is a real and necessary fix. But with concurrency=1, there is no second slot for B to be admitted into, so the test's own admission-blocking assertion (`dispatchedRunIds.length, 1`) passed for the *wrong reason*: not because the Scheduler enforces a Run-level gate, but because the pool had no spare capacity to expose the gap. The test's scenario, by construction, could never have revealed Gap #1.

### Closure design (not implemented this round)

Distinguish "resource is free" from "this Run is eligible for a new attempt." Minimal enforcement point: `ResourceScheduler.tick()`, immediately after computing `executionToken` for a candidate, before `poolCheck`:

```js
const hasLiveAttempt = Array.from(this.activeRunMetrics.values()).some(m => m.runId === run.id)
  || Array.from(this.cleanupFailedTokens.values()).some(m => m.runId === run.id);
if (hasLiveAttempt) continue; // hold in queue: an unsettled attempt for this runId already exists
```

This works because, after last round's fix, `activeRunMetrics` for a token is now only deleted at the moment its resources are *actually* released (post-confirmed-settlement) — so `activeRunMetrics`'s `runId` field is already the authoritative "is any attempt for this runId still physically unresolved" signal; it is simply never consulted during admission today. No new registry, no new framework — reuses data that already exists.

This closes the gap *regardless* of pool concurrency, and does not require `StuckDetector` to change its own bounded-wait behavior (it may still log-and-move-on after its own grace period; the Scheduler's admission gate is what now actually blocks B, not the DB status field).

---

## 4. Gap #2 — Channel Crawlers Don't Use Execution Control

### Source trace

```
grep 'registerExecution|registerCleanup' src/**/*.js
  → only src/reliability/managed-execution.js, src/reliability/execution-control.js (the definition itself)
```

`runs.service.js:executeRun()` — the entire channel-crawler execution path (Etsy, Amazon, Shopify, Reddit, Apify, all local/CDP/browser channel backends routed through `BackendRouter`) — never calls `registerExecution()`. It only:
- creates a `HeartbeatTracker` (liveness/progress reporting only — no abort capability)
- checks `isCurrentOwner()` before each write (data-safety only — see impact below)

`grep signal src/router/backend-router.js` → **zero matches**. No `AbortSignal` is threaded anywhere through `router.run()` into any scraper.

Consequence, traced through `execution-control.js`:
```js
function abortExecution(token, reason) {
  const entry = registry.get(token);
  if (!entry) return;   // channel token was never registered -> no-op, no abort.
  ...
}
function waitForSettled(token, timeoutMs) {
  const entry = registry.get(token);
  if (!entry || entry.settled) return Promise.resolve(true); // unregistered -> instantly "true"
  ...
}
```
When `StuckDetector` calls `abortExecution(channelToken)`, it silently does nothing. When it (or `dispatchRun()`'s `.finally()`) calls `waitForSettled(channelToken)`, it resolves `true` **instantly** — not because the work stopped, but because there was never anything registered to report otherwise.

### Impact, precisely

This does **not** cause the double-slot-allocation of Gap #1 by itself: `dispatchRun()`'s `.finally()` only fires when the *actual* `executeFn` promise (i.e. `runs.service.executeRun`, i.e. `router.run()` under the hood) settles — `waitForSettled()`'s instant-true is a red herring here because there is nothing gating *release* on it for channel jobs; the slot is correctly held until the real promise naturally resolves/rejects. **The real damage is responsiveness and resource-lifetime**: a channel crawler wedged on a hung TCP connection, a browser page that never resolves `page.goto()`, or an Apify poll loop that never terminates **cannot be forcibly stopped**. It occupies its pool slot until it naturally finishes (or the process hosting it is killed), regardless of how many times `StuckDetector` "recovers" it — each recovery only rewrites the DB row and issues a token that will be rejected by `isCurrentOwner()` once the original crawler eventually (if ever) tries to write. Combined with Gap #1, this is exactly what makes a stuck channel crawler dangerous: the DB says "queued, ready for retry" while the real slot is still consumed, and — pre-Gap-#1-fix — a second attempt can be admitted into a sibling slot regardless.

### Violated invariant

**B (RESOURCE)** — "Execution chưa thật sự dừng thì resource của nó chưa được coi là free" is honored only by *accident* (the promise-based `.finally()` gating), not by *design* (no actual abort capability exists for this path), and **C (RETRY)** is compounded by it: retries proceed on a purely bounded-timeout basis with no verified stop signal.

### Why prior tests didn't catch this

Every existing `ManagedExecution` test (`ManagedExecution enforces a real wall-clock timeout...`, `...stops User Journey and closes the browser it owns...`) exclusively exercises the `runManaged()` wrapper — used only by non-channel jobs (`user_journey`, `marketplace_capture`, `marketplace_discovery`). No test exists that dispatches a *channel* job through `ResourceScheduler` and then asserts anything about `ExecutionControlRegistry` state for its token, because until this investigation, no one had framed "does the channel path even participate in execution control" as a testable question — the two paths were implicitly assumed equivalent.

### Closure design (not implemented this round)

Do not build a second framework. `runs.service.js:executeRun()` should call `registerExecution(executionToken, new AbortController())` at the top (mirroring `managed-execution.js`'s pattern exactly) and pass `abortController.signal` into `router.run(platform, query, { ...options, signal })`. `BackendRouter.run()` needs one parameter threaded through to whichever backend adapter is selected; each backend adapter (`local-scraper.backend.js`, `cdp.backend.js`, Apify client calls) needs its own outermost network/process call to accept and honor that `signal` (already partially present in `search-discovery.js`/`web-reader.js`, per the earlier grep — these would need to become the *same* signal, not an independent one). `runs.service.js` must also call `markExecutionSettled`/`unregisterExecution` in its own `finally`, exactly as `managed-execution.js` does. This is additive (same registry, same API, second call site) — not a new abstraction.

---

## 5. Gap #3 — History Parity Is Count-Parity, Not Observation-Level Metric Parity

### Source trace

Read `checkV2Parity()` end-to-end (`database.js:1320-1456`). It computes exactly two independent things:

1. **Tier-1 ("current") parity**: for each `item_uid` in legacy `snapshots`, find `product_current`'s row and the *single latest* legacy snapshot row, and compare metric-by-metric (`V2_PARITY_METRIC_FIELDS`). This is real, per-field parity — but only against the **current/latest** state, one comparison per item, not per historical observation.
2. **Tier-2 ("history") parity**: `legacyObsCountByUid` (aggregate `COUNT(*)` per uid from `snapshots`) vs `packedObsCountByUid` (aggregate `SUM(observation_count)` per uid from `daily_packed_history`) — **a sum comparison only**. Separately, within `daily_packed_history` alone, it checks for duplicate `observationId`/`time` keys and malformed entries (missing required fields) — **entirely internal to the V2 side**, never cross-referencing the legacy `snapshots` row that a given packed observation was supposedly migrated from.

**There is no code path anywhere that**, for a given legacy `snapshots.id = 123`, computes the expected identity `legacy:123`, locates that exact observation inside `daily_packed_history.observations_json`, and compares its `price`/`likes`/`views`/etc. against the legacy row's own columns.

### Reproduction (by construction, not run — the code path to do this doesn't exist to reproduce against)

The described scenario is directly derivable from the code, not merely suspected:
```
legacy snapshot #A: likes=100
legacy snapshot #B: likes=200
packed observations (after some backfill bug): likes=999, likes=888

legacyObsCountByUid = 2
packedObsCountByUid = 2   ->  missingHistoricalObservations = 0 (2 !< 2)
no duplicate observationIds, no malformed entries
-> parityOk = true
```
This is a direct reading of the arithmetic at `database.js:1359-1365` (`if (packedCount < legacyCount) ...`) — a `packedCount === legacyCount` with wrong *values* inside cannot trip any check in the function. This is not speculative; it follows mechanically from the code as written.

### Violated invariant

**F (HISTORY)** — "Mỗi observation có identity xác định, idempotent và parity được tới từng metric" is only half-true: identity and idempotency (§4 of the prior closure round, `appendObservation`'s replace-by-`observationId` logic) are real and tested. **Metric-level parity against the legacy source-of-truth is not implemented**, despite `checkV2Parity()`'s name and the existing tests' description (`checkV2Parity detects a full-metric mismatch beyond price/likes`) referring only to the Tier-1 current-state check, not history.

### Why prior tests didn't catch this

The existing test `checkV2Parity detects a full-metric mismatch beyond price/likes (#13/#20.O)` mutates `product_current.current_views` directly and asserts a `current.metricMismatches` entry — it is exercising the **Tier-1** path exclusively and never touches `daily_packed_history`'s observation content. `checkV2Parity detects missing historical observations (packed count < legacy count) (#13/#20.P)` only ever deletes/withholds an entire observation (changing the *count*), never corrupts a *value inside* an existing observation while preserving the count — so no test was ever constructed to probe exactly the scenario this gap describes.

### Reviews gap (verified directly, confirming the prompt's suspicion)

`daily-history.js`'s `appendObservation()` observation object is:
```js
{ observationId, runId, time, price, likes, comments, shares, views, sold, rating }
```
**No `reviews` field.** `product_current.delta_reviews` (used by the export-growth fix in the prior round) is computed directly from `item.reviews`/`existing.current_reviews` in `product-current.js` — a Tier-1-only computation, never touching `daily_packed_history`. So a `reviews` growth/parity figure derived strictly from packed history (as §10 of the prior round's prompt implied) is structurally impossible today; the schema would need widening.

### Closure design (not implemented this round)

Minimal, additive parity function (not a rewrite of `checkV2Parity()`): for a bounded/sampled set of legacy `snapshots` rows (full parity gate should eventually cover all, but a diagnostic function can start bounded), compute `legacy:<snapshot.id>`, look it up inside the corresponding `daily_packed_history` row's `observations_json` by `observationId`, and diff every field in `REQUIRED_OBSERVATION_FIELDS` (extended, see below) plus `price/likes/comments/shares/views/sold`. Roll missing-observation-by-identity (not just by count) and metric-mismatch-by-identity into the existing `history` section of the parity report, gated into `parityOk` the same way the other counters already are. Widening the observation schema to add `reviews` is a separate, larger migration-affecting change and should be scoped as its own follow-up, not bundled into the parity-function fix.

---

## 6. Gap #4 — Restart Recovery Only Recovers DB State

### Source trace

`recoverOrphanedRuns()` (`restart-recovery.js`) does exactly one thing: `db.getRunsByStatus('running')` → `db.updateRun(id, {status: 'queued'|'failed', ...})`. **No reference anywhere in this file (or anywhere in `src/reliability/`) to a child PID, a CDP session, or a browser process.**

Per execution class:

| Class | Launch mechanism | Survives Node crash? | Evidence |
|---|---|---|---|
| LOCAL_HTTP | in-process `fetch`/HTTP client | **A. Dies with Node** (no separate OS process) | no `child_process`/`spawn` in `local-scraper.backend.js`'s network path |
| CLOUD_API (Apify) | Apify's own hosted infra, polled over HTTP | **C. Continues independently** — the Apify actor run keeps executing on Apify's servers regardless of this Node process | Apify jobs are remote by definition; nothing here can or should kill them |
| BROWSER (Playwright) | in-process `chromium.launch()`/`launchPersistentContext()` (confirmed in `reddit.js`, `ebay.js`, `pinterest.js`, `everbee-executor.js`) | **A, mostly** — a Playwright-launched Chromium is usually a child of the Node process without `detached:true`; a hard Node crash typically also kills it, but **not guaranteed** on all platforms/launch configs, and there is no explicit reconciliation/probe either way | grep found no `detached`/session-persistence flags on these launches |
| CDP (Toidispy) | `child_process.spawn('node', spawnArgs, { stdio: [...] })` in `cdp.backend.js:87`, itself driving a **separate** browser session over `CDP_URL` (an already-running Chrome the CDP script *connects to*, does not launch itself) | **C. Continues independently** — neither the spawned Toidispy Node child (no `detached`, but Node does not auto-kill non-detached children on an unclean parent exit either) nor the Chrome instance it connects to via `CDP_URL` (an entirely separate, long-lived process this codebase never launches or owns) has any relationship to `RestartRecovery` | `cdp.backend.js:87`; no PID persisted anywhere; `restart-recovery.js` has no knowledge of this child at all |

### Violated invariant

**G (RESTART)** — "Process crash không được để lại Run/resource/external execution mồ côi." The Run row is reconciled; the underlying Toidispy child process (and the Chrome instance it talks to over CDP) is not touched at all by any startup code path — it is a true orphan from the application's perspective even though it is not an orphan at the OS level (it may well keep scraping to completion, unaware the Run that spawned it now has a brand-new `executionToken`, or has already been marked `failed`).

### Why prior tests didn't catch this

`RestartRecovery re-queues retryable orphaned runs upon boot` (existing test) uses a mock DB with plain in-memory run objects — there is no child process, no CDP session, nothing to reconcile in the test's own world, so the test can only ever prove the DB-reconciliation half of the invariant. This is not a test bug; it is a scope gap — no test (or production code) was ever written to address the external-resource half.

### Closure design (not implemented this round)

Do not attempt PID tracking/kill logic for every execution class — most (LOCAL_HTTP, and Playwright in the common case) already die with the parent by construction (Category A), and adding process-management code for them would be pure risk with no benefit. Scope the fix to what's provably needed: Category C (Toidispy/CDP). Minimal, additive: `cdp.backend.js` should persist the spawned child's PID (and the target `CDP_URL`) into the Run's row (e.g. `healthSnapshot` or a small dedicated column) at spawn time; `RestartRecovery`, on boot, for any recovered `running` Run whose plan was `executionClass==='CDP'`, should attempt a best-effort probe/kill of that PID if still alive (Node's `process.kill(pid, 0)` to check liveness, `process.kill(pid)` to terminate) before re-queuing — and if the probe/kill cannot be confirmed, mark the Run `RECOVERY_FAILED` rather than blindly re-queuing a fresh attempt that might now race a zombie child still scraping. This mirrors the same "confirm before re-admitting" principle as the Gap #1 closure design, applied to external-process reconciliation instead of in-memory resource reconciliation.

---

## 7. Gap #5 — Marketplace Final `markComplete` Race

### Source trace

`capture-scheduler.js:134-136`:
```js
try {
  await assertClaimOwnership(schedule.id, claimToken, renewClaim);
} catch (claimErr) { ...; return summary; }
// §3: claim_token-protected at the DB layer too — belt and suspenders.
await markComplete(schedule.id, summary, claimToken);
return summary;
```
`markComplete` (production wiring: `completeMarketplaceCaptureSchedule` in `database.js:1067`) returns `false` when `changes === 0` (i.e. the claim no longer matches — `WHERE ... claim_token IS @claimToken`). **This return value is never read.** The `assertClaimOwnership` call right before it only proves the claim was valid *at the moment of that renewal* — it does not, and structurally cannot, guarantee the claim is still valid microseconds later when the actual `UPDATE ... WHERE claim_token IS @claimToken` runs.

### Reproduction (live)

`repro-gap5-marketplace-completion-race.js`, using the **real** `database.js` against the real `data/collector.db`:
```
db.completeMarketplaceCaptureSchedule(scheduleId, summary, now, tokenA) returned: false
Schedule row after A's stale completeMarketplaceCaptureSchedule call: {"last_summary":null}

GAP #5 CONFIRMED: ... capture-scheduler.js line 135 ... NEVER inspects markComplete's return value.
The CALLER of run() receives {"discovered":1,"captured":1,"blocked":0,"failed":0} with no claimLost
flag ... indistinguishable from a real, current-owner success.
```
The DB row itself is correctly protected (`last_summary` stayed `null` — no corruption). The gap is purely in the **result semantics returned to the caller of `run()`**, not in data integrity.

### Violated invariant

**E (SCHEDULE)** — not violated at the *data* level (the DB write correctly no-ops), but violated at the *lifecycle-result* level: "Stale marketplace claim holder không được... complete owner mới" is satisfied for the DB row, but the *reported outcome* of that stale attempt falsely claims success, which is exactly the "DB safety vẫn đúng, nhưng lifecycle result có thể nói thành công sai" scenario named in the prompt.

### Why prior tests didn't catch this

Existing test `claimMarketplaceCaptureSchedule is atomic...` and `a stale claim holder (A) cannot renew or release...` test the **DB layer functions directly** (`completeMarketplaceCaptureSchedule`'s return value, or the raw claim/release/renew primitives) — they correctly prove `false` is returned. No test exists that drives it through `createMarketplaceCaptureScheduler().run()` (the actual production caller) and inspects **`run()`'s own return value** for this exact timing — the DB-layer test and the scheduler-orchestration test were never combined for this specific race.

### Closure design (not implemented this round)

One-line change at the exact call site (`capture-scheduler.js:135`):
```js
const completed = await markComplete(schedule.id, summary, claimToken);
if (completed === false) {
  summary.error = 'MARKETPLACE_CLAIM_LOST';
  summary.claimLost = true;
}
return summary;
```
This mirrors the exact `claimLost` shape already used by the two earlier exit paths in the same function — no new pattern, no new field name, purely closing the one call site that was missed when those other paths were written.

---

## 8. Gap #6 — No-Orphan Checker Coverage

### Entity/ownership map

| Entity | Source of truth | Owner | Created at | Destroyed at | What makes it orphaned | Covered by `assertSystemInvariants()`? |
|---|---|---|---|---|---|---|
| Worker slot | `WorkerPoolManager.activeWorkers` (in-memory Set) | `ResourceScheduler` | `pools.acquireSlot()` in `tick()` | `pools.releaseAllForToken()` in `dispatchRun().finally()` | Token in a pool Set with no corresponding `activeRunMetrics`/`cleanupFailedTokens` entry | **YES** |
| Exclusive lock | `WorkerPoolManager.locks` (in-memory Map) | `ResourceScheduler` | `pools.acquireLock()` | `pools.releaseAllForToken()` | Same as above | **YES** |
| RAM reservation | `ResourceMonitor.reservations` (in-memory Map) | `ResourceScheduler` | `monitor.reserve()` | `monitor.release()` | Same as above | **YES** |
| `runs.status`/`executionToken` | `runs` table (`input_options.executionToken`) | `execution-lease.js` (`isCurrentOwner`) | Run creation / every retry | Terminal transition | A `running` Run whose token has no corresponding live execution anywhere (in-memory OR external process) | **NO** |
| `ExecutionControlRegistry` entry | in-memory `Map` in `execution-control.js` | `ManagedExecution` (registers), `StuckDetector` (aborts) | `registerExecution()` | `unregisterExecution()` | An entry left registered after its owning `runManaged()` call has already returned (e.g. an early-throw path that misses the `finally`'s fallback unregister) | **NO** |
| `HeartbeatTracker` | in-memory `activeTrackers` Map (`heartbeat.js`) | whichever `getOrCreateTracker()` caller | tracker creation | `removeTracker(token)` | A tracker whose Run has already reached a terminal DB status but is never explicitly removed (relies on the owning code path calling `removeTracker` — a crash before that point leaks it in-memory until process restart) | **NO** |
| Marketplace `claim_token` | `marketplace_capture_schedules.claim_token`/`claimed_until` | DB-layer (`claimMarketplaceCaptureSchedule` et al.) | `claimMarketplaceCaptureSchedule()` | `releaseMarketplaceCaptureScheduleClaim()` / lease expiry | A claim whose holder crashed before releasing and whose `claimed_until` lease hasn't yet naturally expired — a real, TTL-bounded, self-healing orphan (not indefinite, since `claimed_until` still expires) | **NO** |
| Toidispy/CDP child process | OS process table (Gap #4) | nothing in this codebase | `child_process.spawn()` in `cdp.backend.js` | never (no code closes it) | The Run is terminal/retried in the DB, but the OS process is still alive and scraping | **NO** |

### Conclusion

`assertSystemInvariants()` (added last round) covers **3 of 7** identified orphan classes — the ones most directly tied to the exact bug it was written to catch (the §5 resource-release timing fix). It does not cover DB-vs-execution consistency, registry/heartbeat leaks on abnormal exit paths, marketplace claim orphans, or external-process orphans. This is not a defect in the function itself (it does what it says, correctly, for its stated scope) — it is a **scope-communication gap**: the prior report's §13 section did not make clear that "no-orphan" was being asserted only for the Scheduler's own bookkeeping, not system-wide.

---

## 9. Shared Root Causes

Tracing all six gaps back to concrete source-level causes (not speculation):

1. **Two independent timers (StuckDetector's 15s check, dispatchRun's own settlement wait) both mutate/observe the same Run's lifecycle without a shared gate.** (Gap #1) This is a direct consequence of `StuckDetector` and `ResourceScheduler` being separate classes that each hold their own partial view of "is this attempt really over" — `StuckDetector` only sees the heartbeat registry + a bounded wait it performs itself; `ResourceScheduler` only sees pool/RAM state. Neither consults the other's state before acting.
2. **Two execution paths (`ManagedExecution` for non-channel jobs, `runs.service.executeRun` for channel jobs) were built at different times to satisfy the same requirement, and only one of them was wired into `ExecutionControlRegistry`.** (Gap #2) Confirmed directly: `registerExecution` has exactly one call site (`managed-execution.js`). This is a straightforward "the newer abstraction wasn't retrofitted onto the older, already-shipped path" gap, not a design flaw in the registry itself — the registry's API is generic enough to serve both.
3. **"Parity" was implemented and tested for the layer that was being actively migrated at the time (Tier-1 current state, for the live-readiness cutover), and the history/Tier-2 side only ever got count-level checks because no historical-data corruption bug had yet been observed to motivate a deeper check.** (Gap #3) This is evidenced by the test names themselves (`#13/#20.O`, `#13/#20.P`) referencing specific numbered "rounds" that were scoped narrowly at the time.
4. **Restart recovery was scoped to "the database's view of the world" because that is what actually causes user-visible symptoms (a Run stuck forever in the UI) — the external-process half was never a forcing function until this investigation asked the question directly.** (Gap #4)
5. **A defensive DB-layer protection (`claim_token`-gated UPDATE) was added and correctly tested in isolation, but the orchestration layer that calls it (`capture-scheduler.js`) was written earlier/separately and never updated to consume the protection's signal.** (Gap #5) This is the same shape as Gap #2: a safety mechanism exists at one layer, but the caller one layer up doesn't check it.
6. **The no-orphan checker was written, tested, and reported as closing "§13: No-Orphan Invariant" without an explicit inventory of every orphan-capable entity in the system — it solved the specific bug that motivated it (§5) rather than the general problem its name implies.** (Gap #6) This is a direct instance of "tests kiểm helper chứ chưa kiểm production wiring/scope" — the checker's own scope was never audited against the full state inventory until this round did so in §8.

**Meta-pattern across all six:** every gap is a *seam between two mechanisms that each behave correctly in isolation* — a bounded wait and a DB update; a registry and a caller that doesn't register; a per-field diff and a per-count sum; a DB reconciliation and an OS process; a claim-protected write and a caller that ignores its result; a bug-specific checker and an unstated broader scope. None of the six is a single function with an outright logic error — each is a **missing connection** between two already-correct pieces. This matches the investigation prompt's own candidate causes: "lifecycle bị chia ở nhiều module" and "resource ownership và Run ownership là hai hệ khác nhau" are the two that concretely explain the largest number of gaps (§1, §2, §5 are all instances of exactly this).

---

## 10. Proposed Closed Lifecycle (design only, not implemented)

| Question | Answer (as designed, pending implementation) |
|---|---|
| WHO OWNS THE RUN? | `executionToken`, via `isCurrentOwner()` — unchanged, already correct |
| WHO OWNS THE RESOURCE? | `ResourceScheduler`, keyed by token — unchanged, already correct |
| WHO CAN STOP IT? | `ExecutionControlRegistry` — correct for non-channel jobs; **must be extended to channel jobs (Gap #2 closure)** |
| WHO CAN WRITE DATA? | current execution owner only, via `isCurrentOwner()`/`assertOwner` — unchanged, already correct |
| WHEN CAN RETRY START? | **only after `activeRunMetrics`/`cleanupFailedTokens` show no live attempt for this `runId`, checked at admission time (Gap #1 closure) — not implemented yet** |
| WHAT IF IT CANNOT SETTLE? | `RECOVERY_CLEANUP_FAILED`, no retry admitted — correct for the same-slot case (prior round); **needs the Gap #1 admission-time check to also cover the multi-slot case** |
| WHAT HAPPENS ON PROCESS CRASH? | `RestartRecovery` for DB state — correct; **external-process reconciliation for CDP/Toidispy not implemented (Gap #4)** |
| HOW IS HISTORY PROVEN? | exact observation identity + idempotency — correct; **full per-observation metric parity against legacy source not implemented (Gap #3)** |

---

## 11. Minimal Fix Set (for the next round — not applied now)

1. **Gap #1**: one `continue`-guard in `ResourceScheduler.tick()` checking `activeRunMetrics`/`cleanupFailedTokens` by `runId` before admission. ~5 lines.
2. **Gap #5**: check `markComplete`'s return value at `capture-scheduler.js:135`, set `claimLost`/`error` on `false`. ~4 lines, reusing the existing `claimLost` shape.
3. **Gap #2**: register `runs.service.executeRun()` with `ExecutionControlRegistry`; thread a real `AbortSignal` through `BackendRouter.run()` into backend adapters. This is the largest of the minimal fixes (touches `runs.service.js`, `backend-router.js`, and at least the most commonly used backend adapters) but still additive — no new abstraction, reuse of the existing registry API.
4. **Gap #3**: add an identity-mapped per-observation metric diff to `checkV2Parity()`'s history section, additive to the existing counters.
5. **Gap #4**: persist Toidispy child PID + `CDP_URL` on the Run row at spawn time; `RestartRecovery` probes/kills it for `CDP`-class recovered runs before re-queuing.
6. **Gap #6**: no code fix required — this round's finding is a documentation/scope correction (§8's table now makes the checker's actual coverage explicit); a future round may choose to extend `assertSystemInvariants()` to additional entity classes if a concrete bug in one of them is found.

---

## 12. Required Regression Tests (for the next round)

- Gap #1: a `scheduler.test.js` test using `localConcurrency: 2`+, A never settles, StuckDetector-style requeue applied, assert B is NOT dispatched (inverse of `repro-gap1-multi-slot-retry-race.js`'s current confirmed-bad output).
- Gap #5: a `marketplace-scheduler.test.js` test driving `createMarketplaceCaptureScheduler().run()` (not just the DB layer) through the exact steal-after-last-renew sequence, asserting `summary.claimLost === true`.
- Gap #2: a test dispatching a channel job through `ResourceScheduler`, then calling `abortExecution(token)` and asserting the real underlying (mocked) fetch/backend call actually observes `signal.aborted`.
- Gap #3: a `db-cutover.test.js` test that corrupts one metric value inside an existing packed observation (not the count) and asserts the (extended) `checkV2Parity()` catches it.
- Gap #4: cannot be fully reproduced without a real child process in CI; at minimum, a unit test asserting `RestartRecovery` attempts a liveness probe for any recovered Run whose plan was `CDP`-class, using a fake/injectable process-liveness function.

---

## 13. Risk of Each Fix

| Fix | Risk | Why |
|---|---|---|
| Gap #1 | **Low** | Pure additive read-check on existing data, no new state, no change to release semantics |
| Gap #5 | **Low** | One `if` branch on an already-returned value; shape matches existing sibling paths exactly |
| Gap #2 | **Medium-High** | Touches the most-used execution path (every channel crawl); threading a real signal into every backend adapter risks subtly breaking a scraper that doesn't expect a signal parameter, or leaving one adapter unwired (partial coverage would be worse than the current, at-least-consistent "no coverage") |
| Gap #3 | **Medium** | Iterating every legacy snapshot row for parity is more expensive than the current O(distinct-uids) count query; needs a bounded/sampled mode for a large `snapshots` table, or it becomes a new performance risk |
| Gap #4 | **Medium** | Process liveness probing/killing is inherently platform-sensitive (Windows vs POSIX signal semantics) and touches a code path (`cdp.backend.js`) that is also relied on for live Toidispy captures — must not accidentally kill a legitimately-still-running capture that IS the current attempt |
| Gap #6 | **None** | Documentation-only this round |

---

## 14. What Does NOT Need Redesign

- `WorkerPoolManager`/`ResourceMonitor` token-keyed reservation model — correct, none of the six gaps point at it.
- `execution-lease.js`'s `isCurrentOwner()` data-write protection — correct and consistently applied everywhere it's checked.
- The 3-tier DB write model (`product_current`/`daily_packed_history`/`runs.result_items_json`) — structurally sound; Gap #3 is about the *parity verification* over it, not the model itself.
- `claim_token`-protected marketplace DB writes — correct; Gap #5 is about the *caller* ignoring a correct signal, not the DB protection itself.
- The prior round's §5 same-slot settlement fix — still correct and still necessary; it is a strict subset of what Gap #1's full fix requires, not something to undo.

---

## 15. Architecture Freeze Criteria

Per the investigation's own instruction, freeze is **NOT YET** warranted. Of the seven criteria:

1. No retry before prior attempt settles. → **NOT MET** (Gap #1, confirmed live)
2. Every production Run execution participates in unified abort/cleanup/settlement control. → **NOT MET** (Gap #2, confirmed by absence)
3. Stale attempts cannot write data. → **MET** (unchanged from prior round, still verified)
4. Full historical observation metric parity exists. → **NOT MET** (Gap #3, confirmed by code reading)
5. Restart cannot blindly duplicate an externally-running execution. → **NOT MET** (Gap #4, confirmed by absence, specifically for CDP/Toidispy)
6. Marketplace completion cannot report success after ownership loss. → **NOT MET** (Gap #5, confirmed live)
7. No orphan Run/execution/resource/claim lifecycle remains. → **PARTIALLY MET** (Gap #6 — 3 of 7 entity classes covered; the other 4 are self-healing-with-delay (claim TTL) or narrow-window (registry/heartbeat leak only on abnormal exit), not proven safe)

**Conclusion: architecture is NOT frozen.** Four of seven criteria fail outright, confirmed by reading and, for #1 and #5, live reproduction — not by assumption. The next round should implement the six minimal fixes in §11, each with its own regression test from §12, before re-evaluating freeze criteria.
