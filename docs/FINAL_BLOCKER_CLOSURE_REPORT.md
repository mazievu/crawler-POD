# Crawler-POD — Final Blocker Fix Round Closure Report

Date: 2026-08-25
Scope: close the remaining blockers identified against CURRENT source (not trusting prior reports) — real execution-stop-on-stuck, real marketplace-claim enforcement, observation-level history parity, and DB read-path cutover coverage. Every claim below traces to a source read done this round and a test that exercises the real code path.

## 1. Executive Result

**NOT READY FOR LIVE TEST.**

All code-fixable blockers in this round's own Definition of Done are closed and proven with real, production-path tests. Two items remain open by design, not oversight: (a) a full deterministic DB rebuild against the real production database was **not attempted** this round — the two real parity gaps found in the prior round (2 items with missing historical observations, ~20+ items with duplicate observations) are pre-existing data debt that this round's rules ("never delete/rewrite legacy data without explicit backup+verify+STOP-on-any-doubt") make too risky to rush; (b) the export route's growth-vs-previous-observation calculation still reads legacy history and degrades to `growth=0` (not a crash, not fabricated data) under `READ_MODEL_V2=true` — a scoped, documented gap, not a hidden one.

## 2. Source Baseline

Read fresh, not trusted from prior reports:
- `src/reliability/managed-execution.js`: confirmed the reported bug — the hard-deadline timer was `unref()`'d despite being the ONLY thing that settles the `Promise.race()` the caller awaits. Fixed.
- `src/reliability/stuck-detector.js`: confirmed StuckDetector only ever touched the DB (`updateRun`) and the in-memory heartbeat map — it had **no mechanism** to actually reach into a live execution and stop it. "STUCK DETECTED != STUCK RECOVERED" was a real, structural gap, not a false claim.
- `src/marketplaces/capture-scheduler.js`: confirmed `renewClaim()`'s return value was awaited but never checked — a stale attempt whose claim was already lost kept capturing regardless.
- `src/database.js`: confirmed `completeMarketplaceCaptureSchedule()`'s SQL had no `claim_token` condition at all (`WHERE id=@id` only) — a stale attempt could clear a newer claim's ownership and advance `next_run_at` out from under it.
- `src/database/daily-history.js`: confirmed `observationsArray.push(observation)` was unconditional — no identity, no dedup, blind `observation_count + 1` in SQL regardless of whether anything was actually rejected.
- `src/database.js`'s `checkV2Parity()`: confirmed `duplicateHistoricalObservations` was computed but **not included** in the `parityOk` gate formula — the exact "53 duplicates -> parityOk=true" bug the round warned against.
- `server.js`: confirmed `/api/runs/:id` and `/api/export/:runId` called `db.getSnapshotsByRunId()` directly with **no `READ_MODEL_V2` gate at all** — after a real cutover (`LEGACY_SNAPSHOT_WRITE=false`), any Run created post-cutover would show an empty item list on both routes.

## 3. Execution Control Registry (§1.1)

**New:** `src/reliability/execution-control.js` — a minimal `Map`-based registry keyed by `executionToken` (or a `Symbol` fallback for callers without one, to avoid silently no-op-ing). API: `registerExecution`, `registerCleanup`, `abortExecution`, `markExecutionSettled`, `isExecutionSettled`, `waitForSettled`, `unregisterExecution`. No framework — ~100 lines.

**Wired into `runManaged()`:** registers its `AbortController` and (if supplied) its `onTimeout` cleanup callback under the registry. On timeout, calls `abortExecution()` (aborts the signal + runs registered cleanup) but — critically — **does not block its own rejection** on the full `workPromise` settling; that would have reintroduced the "reject fast" regression the prior round's own test locked in. Instead, `markExecutionSettled()`/`unregisterExecution()` are attached directly to `workPromise.finally()`, so the registry's "settled" signal reflects when the REAL work finishes, independent of when `runManaged()` itself resolves/rejects.

**Wired into `StuckDetector.recoverExecution()`:** now calls `abortExecution(hb.executionToken, reasonCode)` and a bounded `waitForSettled()` before finalizing DB requeue/mark-stuck bookkeeping — actually attempting to stop A's real work, not only flipping DB ownership while it keeps running unattended.

## 4. Stuck Recovery — Resources Actually Released Only After Real Settlement (§1.3, the core fix)

**The critical wiring:** `src/scheduler/scheduler.js`'s `dispatchRun()` — the `.finally()` that releases worker slot/RAM/lock previously fired the instant `executeFn`'s promise settled. For a `ManagedExecution` timeout, that promise now settles at ~`timeoutMs` (fast, by design — see §3) while the real underlying work (browser/network call) might still be running. Releasing resources at that moment would let a new Attempt B be admitted into the same slot/lock while A might still be using it.

**Fixed:** `dispatchRun()`'s `.finally()` now `await waitForSettled(executionToken, this.resourceReleaseGraceMs)` (default 5000ms) BEFORE releasing. For channel-based runs (not wrapped in `runManaged`), the token is never registered, so `waitForSettled()` resolves instantly — zero behavior change on the primary execution path. Only `runManaged()`-wrapped executions (user_journey, marketplace_capture, marketplace_discovery) get the new protection.

**Evidence (the single most important test this round):** `test/scheduler.test.js` — *"ResourceScheduler does not dispatch Attempt B into the same slot until Execution Control confirms A settled"*: a 1-slot LOCAL pool, Attempt A's `executeRun` registers with the registry then rejects immediately (simulating a ManagedExecution timeout) WITHOUT calling `markExecutionSettled`. Asserts the slot still shows `running:1` after A's promise rejects, asserts a submitted Attempt B is NOT dispatched while the slot appears held, then calls `markExecutionSettled()` manually (simulating the real work finishing) and asserts B is dispatched only then. **PASS.**

## 5. Abort Propagation (§9)

Confirmed already correct where it mattered most (User Journey — `signal` reaches `page.goto()`'s owning stealth session via an `abort` listener registered right after launch, both product loops check `signal?.aborted`; wired in a prior round, re-verified this round). Not re-audited this round: raw `fetch()` calls inside individual scrapers (reddit.js, etc.) — these are typically short (seconds) HTTP requests already covered by the outer `scrapeWithRetry` bounded-retry loop and Node's own default socket timeouts, not the long-running browser/CDP operations this round's stuck-recovery fixes target. Flagged as a smaller, lower-priority follow-up, not silently claimed as done.

## 6. Marketplace Claim Renewal Enforcement (§2)

**Before:** `capture-scheduler.js`'s `run()` called `await renewClaim(schedule.id, claimToken)` at 3 points but never checked the boolean result — a stale attempt whose claim renewal returned `false` kept capturing regardless.

**Fixed:** new `assertClaimOwnership(scheduleId, claimToken, renewClaim)` throws `MARKETPLACE_CLAIM_LOST` (with `.code`) when renewal fails. Called before the capture loop starts, before EVERY item (not just once), and before final completion — on any failure, the function returns immediately with `{...summary, error, claimLost: true}` and does **not** call `markComplete()` (a newer owner, or nobody, is responsible for that schedule's completion now).

Collateral fix: the default `renewClaim` no-op (`async () => {}`, for callers not using the claim system at all) resolved `undefined` — falsy — which `assertClaimOwnership` would have treated as "claim lost" for every caller that never passed a real `renewClaim`, breaking 2 existing tests immediately. Fixed the default to `async () => true`.

**Evidence:** `test/marketplace-scheduler.test.js` — *"assertClaimOwnership stops work immediately once a real DB claim renewal fails"* (real DB claim/release/claim sequence simulating B taking over from A, asserts A's `assertClaimOwnership` call rejects with `MARKETPLACE_CLAIM_LOST`). **PASS.** All 12 pre-existing tests in this file still pass unchanged.

## 7. Claim-Safe Completion (§3)

**Before:** `completeMarketplaceCaptureSchedule()`'s prepared statements had `WHERE id = @id` only — no `claim_token` condition whatsoever.

**Fixed:** both completion statements now include `AND claim_token IS @claimToken` (`IS`, not `=` — required for NULL-safe comparison: a never-claimed schedule has `claim_token IS NULL`, and completing it with no token supplied must still match, since `NULL = NULL` is `NULL`/never-true in SQL but `NULL IS NULL` is `true`). The function now checks `changes === 0` and returns `false` **without** inserting a completion-history row when the claim didn't match — restructured to UPDATE-then-check-then-INSERT-log, per the round's suggested transaction shape. `claimToken` threaded as a new 4th parameter (kept after the existing `now` parameter for backward compatibility with 2 existing tests that pass `now` positionally).

**Evidence:** `test/marketplace-scheduler.test.js` — *"a stale attempt cannot markComplete a schedule now claimed by a newer attempt"*: A claims, releases (simulating expiry), B claims fresh. A's stale `completeMarketplaceCaptureSchedule(..., tokenA)` call returns `false`, inserts zero completion-history rows, and leaves B's schedule state (`last_summary`) untouched; B's own completion with `tokenB` succeeds. **PASS.**

## 8. History Observation Identity (§4.1)

**New:** `src/database/daily-history.js`'s `buildObservationId({runId, legacySnapshotId, itemUid})` — `legacy:<snapshot_id>` for migrated observations (deterministic across repeated migration runs), `run:<runId>:<itemUid>` for live observations (the invariant is one observation per item per Run; never relies on timestamp alone, since two crawls can legitimately land in the same second). Wired into all 3 real call sites in `src/database.js` (the live `insertSnapshots()` path with `{runId}`, and both `repairPendingV2WriteFailures()`/`backfillSnapshotsToV2()` migration paths with `{legacySnapshotId: snap.id}`).

## 9. Idempotent History Writes (§4.2)

**Fixed:** `appendObservation()` now looks up an existing entry by `observationId` within the day's array and **replaces** it (rather than blindly pushing) when found. `observation_count` is always set from the final array length (`observationsArray.length`), never a blind SQL `+ 1` — a rejected/replaced duplicate cannot inflate the count.

**Evidence:** `test/database-v2.test.js` — *"Daily Packed History appendObservation is idempotent by observationId"*: calling `appendObservation()` 3 times with identical identity leaves the array at length 1 and `observation_count=1`; a genuinely different observation (different `runId`) still appends normally to length 2. *"...idempotent for legacy migration identity"*: same proof for `legacySnapshotId`. Both **PASS.**

## 10. Full Observation-Level History Parity (§4.3)

**Extended `checkV2Parity()`** (already extended in the prior round to compare legacy-vs-packed OBSERVATION COUNTS): this round adds:
- **Malformed detection**: a `daily_packed_history` row whose JSON doesn't parse, or whose array isn't an array, or whose entries are missing required fields (`time`, `price`, `likes`, `views`) is now counted separately (`history.malformedObservations`/`malformedObservationUids`), distinct from "duplicate".
- **Duplicate detection upgraded to observationId-based** where available (falls back to the weaker time-based check only for rows written before this round, which have no `observationId`) — correctly distinguishes two real observations landing in the same second from an actual duplicate.

What was **not** implemented this round: full per-observation metric-value comparison against the specific legacy row it corresponds to (the round's `4.3` example: legacy 10:00 likes=100 vs V2 10:00 likes=999 with matching COUNTS but wrong VALUES). The current check proves count-level parity (missing/duplicate/malformed) but not value-level parity of every individual historical observation. This is a real, acknowledged gap — flagged honestly rather than claimed done.

## 11. Bug Found and Fixed: `parityOk` Ignored Duplicates (§5)

Confirmed exactly as described: `duplicateHistoricalObservations` was computed but absent from the `parityOk` boolean formula. **Fixed:** `parityOk` now requires `missingCurrent.length === 0 && metricMismatches.length === 0 && missingHistoricalObservations === 0 && duplicateHistoricalObservations === 0 && malformedObservations === 0`.

**Evidence:** `test/db-cutover.test.js` — *"checkV2Parity: a duplicate observation makes parityOk false, not just visible in the count"*: injects a real duplicate observation (same `observationId`, same `time`) into a real `daily_packed_history` row via a raw connection, asserts `duplicateHistoricalObservations >= 1` AND `parityOk === false`. **PASS.**

## 12. V2 Run Result Storage (§6.1–6.3)

**New column:** `runs.result_items_json` (nullable TEXT) — a Run's own packed result array (`<=20-30 items` typically; explicitly NOT a new one-row-per-item table, per the round's row-explosion warning). Populated **unconditionally** by `insertSnapshots()` (independent of `LEGACY_SNAPSHOT_WRITE`), so it's always available for any Run created from this point forward regardless of cutover state.

**New helper:** `getRunItems(runId)` — `READ_MODEL_V2=false` reads legacy `getSnapshotsByRunId()` (unchanged behavior); `READ_MODEL_V2=true` reads `runs.result_items_json`. Wired into `/api/runs/:id` and `/api/export/:runId` (both previously called `db.getSnapshotsByRunId()` directly with no V2 gate at all).

**New idempotent backfill:** `backfillRunResultItems()` — only processes runs whose `result_items_json` is still `NULL`. Run against the real production DB this round: first run migrated 193/193 existing runs; a second run migrated 0/0 (fully idempotent).

**Evidence:** direct smoke test against the real DB — created a Run, called `insertSnapshots()`, confirmed `getRunItems()` returns the correct item under `READ_MODEL_V2=false` (legacy path) AND `READ_MODEL_V2=true` (new JSON-column path, verified in a separate child process since the flag is read once at module load). Both **PASS.** `npm test` remains 184/184 green after wiring.

**Known gap (documented, not hidden):** the export route's per-item "growth vs previous observation" calculation (`db.getSnapshotHistory(item_uid)`) was NOT ported to read `daily_packed_history` under `READ_MODEL_V2=true` — it degrades to `growth: {soldCount:0, reviews:0, likes:0, priceChange:0}` for any item with no legacy history, rather than crashing or fabricating data. This is flagged directly in the code with a `NOTE:` comment and here, not silently left as a surprise.

## 13. Legacy Read Audit (§6.4)

`grep -rn "getSnapshotsByRunId|findPreviousSnapshot|getSnapshotHistory" server.js src/` (excluding `database.js` itself, which legitimately owns these functions):
- `/api/items/:uid/history` (server.js ~line 646): **already correctly gated** — branches on `READ_MODEL_V2` above this line, only falls through to legacy `getSnapshotHistory()` in the legacy branch. No fix needed (confirmed by reading, not assumed).
- `/api/runs/:id`, `/api/export/:runId`: **fixed** in §12 above.
- Export route's growth calculation (2 call sites): **known gap**, documented in §12.

No other production runtime call site found reading legacy snapshots without either being migration/rollback tooling (`backfillSnapshotsToV2`, `repairPendingV2WriteFailures` — explicitly allowed per §6.4.A) or already correctly gated.

## 14. DB Rebuild / Repair (§11) — NOT Attempted This Round

The round's own instructions require: stop writers, backup, SHA256 verify, `PRAGMA integrity_check`, THEN rebuild V2 history from legacy deterministically, idempotently, without modifying legacy data. Given the real parity gaps already identified (2 items missing observations, ~20+ items with duplicates — all pre-existing, confirmed via direct row inspection in the prior round, not test pollution), a full rebuild is a legitimate next step, but attempting it within this round's remaining scope risked exactly the kind of rushed, unverified DB operation Section 0 and Section 19 explicitly forbid ("Do not say full parity if only counts match", "Do not say cutover ready"). **Deliberately not attempted.** `checkV2Parity()` now has the tooling (§10) to verify a rebuild's correctness whenever it is attempted; `backfillSnapshotsToV2()`'s existing idempotent migration logic (confirmed unchanged and still idempotent — re-verified via the checkpoint mechanism) would be the natural mechanism, now benefiting from §8/§9's identity-based idempotency, but the actual rebuild run itself is future work.

## 15. Full Parity After Rebuild (§12)

Not applicable — no rebuild was performed (§14). Current real parity status on `data/collector.db` (unchanged from the prior round, since no data was rewritten): `parityOk: false` (0 current-state mismatches; 4 missing + duplicate historical observations, unchanged counts from before — this round's fixes are about detection/gating correctness, not about resolving the underlying pre-existing data gaps).

## 16. Cutover Evidence (§13)

Not performed — correctly blocked by §15's `parityOk: false`, per the round's own STOP rule. `READ_MODEL_V2=false`, `LEGACY_SNAPSHOT_WRITE=true` remain at their current, safe, unmodified defaults.

## 17. Legacy Row Growth Evidence (§14, Phase B)

Mechanism proven (not currently active, since cutover hasn't happened): `test/db-cutover.test.js`'s `LEGACY_SNAPSHOT_WRITE=false` real-child-process test shows the `snapshots` table row count is byte-identical before/after a real crawl with the flag off. **PASS**, unchanged from the prior round, re-verified this round after the §12 `insertSnapshots()` changes.

## 18. new/active/dropped Evidence (§14, Phase C)

`test/db-cutover.test.js`'s two-sequential-Runs test (Run 1: A,B both new; Run 2 with legacy OFF: A=active, B=dropped, C=new) — **PASS**, re-verified this round, unaffected by the observation-identity changes (new/active/dropped is computed from `product_current`, a separate mechanism from `daily_packed_history`'s observation identity).

## 19. Canonical `npm Test` x3 (§8/§18)

**Fixed the reproducibility bug directly:** `package.json`'s `test` script changed from `node --test "test/**/*.js"` to `node --test --test-concurrency=1 "test/**/*.js"`. Root cause confirmed: all test files (plus this round's child-process-spawning DB tests) share ONE real, persistent SQLite file (`data/collector.db`, no per-test isolation in this repo), and Node's test runner's default parallel file execution caused genuine intermittent `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT` contention errors — never a wrong-result assertion failure, always a lock-contention error. Serializing eliminates the contention entirely (verified: `busy_timeout` alone, added in the prior round, was insufficient under full default parallelism).

```
Run 1: npm test -> tests 184, pass 184, fail 0, cancelled 0, exit 0
Run 2: npm test -> tests 184, pass 184, fail 0, cancelled 0, exit 0
Run 3: npm test -> tests 184, pass 184, fail 0, cancelled 0, exit 0
```

Also directly fixed the `unref()` bug in `managed-execution.js` (§3) that this round's spec identified as a likely cause of the "cancelled 3" symptom from a prior observation — could not independently reproduce that exact symptom in this environment (all runs during this round showed `cancelled: 0` even before the serial-execution fix), but the `unref()` bug was real and is fixed regardless, since it's a genuine correctness issue independent of whether it was the specific cause observed.

## 20. Codemap Validation

`npm run validate:codemap` -> `CodeMap Validation Passed!`, exit 0.

## 21. Files Changed This Round

| File | What changed |
|---|---|
| `src/reliability/execution-control.js` | **New** — minimal executionToken-keyed abort/cleanup/settlement registry |
| `src/reliability/managed-execution.js` | Removed the incorrect `unref()`; registers with execution-control; settled-signal now tied to `workPromise` itself, not `runManaged()`'s own exit |
| `src/reliability/stuck-detector.js` | `recoverExecution()` now `abortExecution()`s + bounded-waits for real settlement before finalizing recovery |
| `src/scheduler/scheduler.js` | `dispatchRun()`'s resource release now awaits `waitForSettled()` first — the core §1 fix |
| `src/marketplaces/capture-scheduler.js` | `assertClaimOwnership()` enforced at 3 points; default `renewClaim` no-op fixed to return `true` |
| `src/database.js` | `completeMarketplaceCaptureSchedule()` claim_token-protected; `checkV2Parity()` gains malformed-detection + observationId-based dup detection + duplicates/malformed now gate `parityOk`; `runs.result_items_json` column + `getRunItems()` + `backfillRunResultItems()`; observation identity threaded into all 3 `appendObservation()` call sites |
| `src/database/daily-history.js` | `buildObservationId()`; idempotent `appendObservation()` by identity; explicit `observation_count` (never blind increment) |
| `server.js` | `markComplete` passes `claimToken` through; `/api/runs/:id` and `/api/export/:runId` use `getRunItems()` instead of raw legacy reads |
| `package.json` | `test` script serialized (`--test-concurrency=1`) |
| `test/scheduler.test.js` | +1 test (§4 above — the core resource-release-timing proof) |
| `test/marketplace-scheduler.test.js` | +2 tests (§6, §7 above) |
| `test/database-v2.test.js` | +2 tests (§9 above) |
| `test/db-cutover.test.js` | +1 test (§11 above) |

## 22. Remaining External Dependencies

Unchanged: no `APIFY_TOKEN`, no SearXNG, no live CDP/Toidispy session in this environment. Environmental, not code defects.

## 23. Final Recommendation

**NOT READY FOR LIVE TEST.** All code-level blockers this round could verify against source are closed with real, production-path evidence — most importantly, the core "stuck detected != stuck recovered" gap (§4) now has a real, tested fix at the exact layer that matters (Scheduler resource release timing), not a superficial DB-status flip. The two remaining gaps (§14 DB rebuild not attempted; §12's export-growth degradation under V2) are both deliberately scoped out and explicitly documented here, not silently overclaimed. Recommended next step: a human decision on how to handle the pre-existing production data gaps found in the prior round (§15), followed by an explicit, carefully-verified rebuild attempt using the now-idempotent migration tooling, before revisiting cutover.
