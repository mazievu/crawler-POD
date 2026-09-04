# Crawler-POD — Final Architecture Simplification & Hardening Report

Date: 2026-08-24

## 1. Executive Result

**READY FOR MERGE.**

An earlier draft of this report flagged `capture-scheduler.js`'s per-listing loop as a disclosed bypass (calling `runMarketplaceCapture` directly instead of going through the Scheduler). That gap was small and scoped, so it was closed before finalizing this report rather than merged with a known bypass: `createMarketplaceCaptureScheduler({ capture: ... })` in `server.js` now injects `submitMarketplaceCaptureViaScheduler` instead of `runMarketplaceCapture` directly — every discovered listing is submitted as its own `marketplace_capture` job through the shared Resource Scheduler, so BROWSER pool/RAM admission applies per item, not just per top-level schedule tick. Full suite re-run after the change: 144/144 still passing.

Everything in this round is complete and verified: historical RAM learning is removed, every request gets its own resource plan, large requests are sharded, resource ownership is attempt-scoped (`executionToken`), all identified bypass endpoints (`/api/toidispy/run`, `/api/user-journey/run`, `/api/html-captures`, and the marketplace schedule tick's per-listing capture loop) now go through the Scheduler, heartbeat/progress are split, execution lease guards every write boundary, the marketplace tick no longer blocks, weekly_summary is deprecated from the core write path without data loss, backfill is idempotent, dual-write failures are durably repairable, social bot scheduling survives a crash mid-reservation, retry classification is unified, the E2E harness fails for real, and backups are hash+integrity verified. `npm test`: 144/144 passing.

## 2. Architecture Before / After

**Before (Fix Round 2):** `ExecutionPlanner` called `ResourceProfileManager` to look up a moving-average RAM estimate learned from prior runs of the same (platform, backend, mode); RAM/pool/lock ownership was keyed by `runId`; `toidispy`, user-journey, and marketplace-capture endpoints called their execution functions directly, bypassing the Scheduler entirely; `weekly_summary` was written on every crawl; stuck detection used one flat idle timeout for every backend; heartbeat only updated on stage change.

**After (this round):**
```
API / Social Bot
      |
      v
ExecutionPlanner (request-specific ResourcePlan, no history)
      |
      v
LargeJobSharder (splits oversized requests into bounded shards)
      |
      v
ResourceScheduler.tick(): pool admission + RAM admission (physical - committed)
      |
   reserve RAM + pool slot + locks under a fresh executionToken
      |
      v
executeRun / user_journey / marketplace_capture executor (pluggable)
      |
   execution-lease re-checked before every write boundary
      |
      v
product_current (Tier 1) + daily_packed_history (Tier 2)
      (weekly_summary: read-only, deprecated, preserved)
```

## 3. Historical RAM Learning Removal

- `src/scheduler/resource-profile.js` is marked `@deprecated` and is no longer imported by `src/scheduler/scheduler.js` or `src/scheduler/execution-planner.js` (confirmed by `grep` — zero references outside the deprecated file itself and its old unit test coverage). It is kept in the tree, unused, as a rollback artifact — not deleted, per the round's own instruction.
- Proof the scheduler no longer uses prior runs: `ExecutionPlanner.plan()` computes `estimatedEnvelopeMB` purely from `DEFAULT_CLASS_ENVELOPES_MB` (a static, configurable per-execution-class baseline) and the CURRENT request's own options (`internalConcurrency`, `imageEnrichment`, `browserFallbackPossible`, etc.) — see `test/scheduler.test.js`'s "produces a request-specific plan from the CURRENT request only" test, which submits a small (maxItems=20) and a large/heavy (maxItems=1000, imageEnrichment, concurrency=3) request to the SAME platform+backend and asserts the large one gets a materially larger envelope, purely from its own declared shape.
- `data/resource-profiles.json` is no longer written by the live scheduler path.

## 4. Request-Specific Resource Planning

Fields produced by `ExecutionPlanner.plan()`: `platform, backend, backendName, executionClass, mode, maxItems, shardSize, shardCount, internalConcurrency, browserRequired, browserFallbackPossible, estimatedEnvelopeMB, confidence ('STATIC_ENVELOPE'), pool, jobKind, options`.

Formula: `estimatedEnvelopeMB = baseEnvelope[executionClass] * max(1, internalConcurrency)`, then multiplied by 1.4/1.3/1.2 for `imageEnrichment`/`variantCrawling`/`heavyRawHtml` respectively, and further multiplied by `parallelTabs` if set. If `browserFallbackPossible` is true and the class isn't already BROWSER, the envelope is raised to at least the BROWSER baseline (worst-case reservation up front — see Section 6).

Example (from the live test): `etsy/local, maxItems=20` → small envelope (~180MB with the 1.2x baseline default); `etsy/local, maxItems=1000, imageEnrichment=true, internalConcurrency=3` → envelope more than 2x larger AND `shardCount > 1` (sharded instead of run as one job) — asserted directly in `test/scheduler.test.js`.

## 5. Sharding

- `src/scheduler/job-sharder.js`: `planShards(run, plan)` splits `maxItems` into `ceil(maxItems / shardSize)` shards, each with its own `offset`; `shardSize` is configurable per execution class via `SHARD_SIZE_LOCAL_HTTP` / `SHARD_SIZE_CLOUD_API` / `SHARD_SIZE_BROWSER` / `SHARD_SIZE_CDP` env vars (defaults: 100 / 200 / 10 / 20).
- Parent/shard: `ResourceScheduler.shardIfNeeded()` creates N child `runs` rows (`parent_run_id` set, new column, safe `ALTER TABLE ADD COLUMN`) and parks the parent as `status='sharded'`. `reconcileShardedParents()` runs every tick, aggregates finished children's `items_count`/`new_count`/`active_count`/`dropped_count` onto the parent via `aggregateShardResults()`, and marks the parent `done` (if ≥1 shard succeeded) or `failed` (if all failed).
- **Live proof**: a real `/api/toidispy/run` request with the default `maxItems=100` was automatically split into 5 shards (CDP shard size = 20) on the running server — confirmed by querying `/api/runs/:id` and seeing `error_message: "All 5 shards failed"` (all 5 failed because no real CDP browser was listening in this environment — an environment limitation, not a sharding defect).
- **Disclosed limitation**: shard correctness (no overlapping/missing items) depends on the underlying scraper honoring the `offset` hint. This is documented in `job-sharder.js`'s header comment.

## 6. Scheduler Evidence

- **Current RAM**: `ResourceMonitor.getPhysicalSnapshot()` reads `os.totalmem()/os.freemem()` fresh on every check (or a fixed snapshot when injected for tests).
- **Reserve**: `monitor.reserve(executionToken, estimatedMB)` / `monitor.release(executionToken)`, keyed by executionToken.
- **Committed RAM**: `effectiveHeadroomMB = usableHeadroomMB - sum(all current reservations)` — deterministic test (`ResourceMonitor commits reservations...`) reproduces the spec's exact scenario: 5000MB headroom, two 2000MB admits succeed, a third is rejected with `effectiveHeadroomMB: 1000`, and releasing one frees the headroom for the third.
- **Attempt ownership**: `WorkerPoolManager`'s slots/locks are `Set<executionToken>`/`Map<lockKey, executionToken>`. Test `"WorkerPoolManager ownership is keyed by executionToken..."` proves attempt A holding a slot+lock cannot be displaced by attempt B until A explicitly releases, and a stale `releaseAllForToken('run50-attemptA')` call after A already released does not affect B's resources.
- **Pool limits**: unchanged from prior rounds — LOCAL=4, CLOUD=8, BROWSER=2, CDP=1 (env-overridable), re-verified by the 50-concurrent stress test below.
- **Browser escalation**: implemented as Option A from the spec (worst-case reservation up front via `browserFallbackPossible`), not Option B (runtime mid-execution escalation request) — chosen because the codebase's actual browser-fallback logic (`launchStealth` in `src/scrapers/*` and `journey/user-journey-runner.js`) lives in tools that are either explicitly out-of-scheduler diagnostic scripts (`live-data-loop.js`, documented since Fix Round 2) or are now themselves submitted as BROWSER-class jobs from the start (user-journey), not local jobs that escalate mid-flight. There is no code path today where a job admitted as LOCAL_HTTP silently opens a browser without the Scheduler already knowing.
- **50-concurrent stress test** (`node scripts/stress-test-scheduler.js`, real `ResourceScheduler`/`WorkerPoolManager`/`ResourceMonitor`, mocked DB+execution only): `maxObservedConcurrency` exactly equals pool capacities (LOCAL 4, CLOUD 8, BROWSER 2, CDP 1), zero duplicate dispatches, zero leaked RAM reservation, all 50 completed, `RESULT: PASS`.

## 7. Reliability Evidence

- **Heartbeat**: `HeartbeatTracker` now ticks `lastHeartbeatAt` on a real `setInterval` (default 15s, `HEARTBEAT_INTERVAL_MS`-configurable) independent of stage changes; `lastProgressAt` only updates on `setStage()`/`progress()`.
- **Stuck detection**: `StuckDetector` compares `idleSinceProgressMs` against `DEFAULT_STUCK_TIMEOUTS_MS[executionClass]` — LOCAL_HTTP=120s, BROWSER/CDP=180s, CLOUD_API=420s (Apify polling gets a much longer allowance), all env-configurable.
- **Retry**: unified — `anti-bot/scraper-factory.js`'s `scrapeWithRetry` now calls `defaultRetryPolicy.isRetryable(err)` and breaks immediately on a non-retryable error (404, invalid schema) instead of always exhausting `maxAttempts`; `'404'`, `'INVALID_SCHEMA'`, `'VALIDATION_FAILED'` added explicitly to `NON_RETRYABLE_ERROR_CODES`.
- **Lease**: `runs.service.js` now re-checks `isCurrentOwner()` immediately after `router.run()` returns (before writing backend metadata) AND immediately before the PERSISTING stage (before legacy snapshots / Current State / Daily History writes) — not only at the final done/failed transition.
- **Old attempt cannot release new attempt's resources**: proven by the WorkerPoolManager test in Section 6, and end-to-end by the existing "Execution lease prevents a stale (revoked) attempt from overwriting a newer attempt" test (`test/reliability.test.js`).
- **Marketplace auto-crawl**: `runDueMarketplaceSchedules()` no longer `await`s `marketplaceCaptureScheduler.run(schedule)` inside its due-schedule loop — it dispatches fire-and-forget with its own `.catch()`, so `marketplaceScheduleTickActive` is only held true for the fast discovery/dispatch phase, never for the duration of actual captures.
- **Restart recovery**: unchanged from Fix Round 2 (`getRunsByStatus('running')`, unbounded direct query) — still correct, re-verified passing.

## 8. Database Architecture

- **product_current**: unchanged schema from Fix Round 2 (1 row/item, `delta_price/likes/.../delta_3h_*/delta_24h_*`, `first_seen_at/last_seen_at/last_crawled_at`, `rank_score`).
- **daily_packed_history**: unchanged (1 row per item+day, packed observations JSON array).
- **weekly_summary deprecated**: `insertSnapshots()` and `backfillSnapshotsToV2()` no longer call `weeklySummaryOps.updateWeekly()` — confirmed via `grep` showing zero live call sites remaining (only the deprecated module's own definition and its existing unit tests, which directly exercise the module in isolation, not the core write path). The table and its 144 pre-existing rows are untouched. `getProductWeekly()` is marked `@deprecated` in its docstring; no route in `server.js` calls it.
- **History preservation**: `snapshots` (legacy) is still written on every run, unchanged. Daily History is append-only.
- **Dual-write safety**: a new `v2_write_failures` table records `{run_id, item_uid, error_message, status}` whenever the V2 write inside `insertSnapshots()` throws (previously only `console.warn`). `repairPendingV2WriteFailures()` re-attempts each pending failure from the still-intact `snapshots` row and marks it `repaired` on success; called automatically at server boot (`server.js`), alongside `recoverOrphanedRuns()`.
- **Backfill idempotency**: `backfillSnapshotsToV2()` now uses a `migration_checkpoints` table keyed on the highest `snapshots.id` processed. **Live-verified on the real database**: first run processed 110 snapshots; an immediate second run processed 0 (`IDEMPOTENCY OK: second run migrated 0 rows`).
- **V2 read cutover**: **not implemented this round** — there is no existing `/api/items`-style route reading from legacy `snapshots` to cut over; `getProductCurrent()`/`getProductHistory()` already exist as the V2 read API and are the only structured read path. No `READ_MODEL_V2` flag was added because there's nothing to flag between. Documented here as explicitly not done rather than silently skipped.

## 9. Database Health Metrics

`GET /api/database/health` (backed by `db.getDatabaseHealth()`) reports: `dbSizeMB`, `productCurrentRowCount`, `dailyPackedHistoryRowCount`, `avgObservationsPerDailyRow`, `maxObservationsInDailyRow`, `legacySnapshotRowCount`, `weeklySummaryRowCount` (deprecated table, visibility only), `representativeIndexedQueryLatencyMs`, `checkedAt`. No mandatory 10M benchmark is required for merge; the prior round's `benchmark-10m.js` remains available as an optional diagnostic tool, not a gate.

## 10. Social Bot Evidence

- **Persistent idempotency**: unchanged from Fix Round 2 (`social_bot_state`, `UNIQUE(bot_key, scheduled_window, query_key)`) — still passing.
- **Crash-safe pending recovery** (new this round): `recoverStalePendingSocialBotWindows(thresholdMs=5min)` deletes `'pending'` rows older than the threshold at the start of every `tick()`, so a window abandoned by a crash between "reserve" and "confirm dispatch" is retried instead of permanently stuck. Implemented with a correct SQLite-timestamp-format comparison (a real formatting bug — ISO `T`/`Z` vs SQLite's `CURRENT_TIMESTAMP` space-separated format — was caught and fixed during implementation, before it shipped).
- **Config file**: `BotConfigManager.load()` now calls `this.save()` when the config file doesn't exist on disk, so "the server regenerates defaults" is an on-disk fact, not just an in-memory claim (`data/social-bots.json` was confirmed missing from all backups taken this session — a Fix Round 2 cleanup mistake — and is now guaranteed to reappear on next boot with TikTok correctly disabled).
- **TikTok**: still disabled with `unsupportedReason` set — unchanged, re-verified live via `/api/social-bots`.

## 11. E2E Evidence

- `check()` replaces `console.assert()` — throws on failure, propagating to `process.exitCode = 1` in the top-level `.catch()`.
- External-dependency-blocked scenarios (no APIFY_TOKEN, SearXNG unreachable, real third-party network failure) are explicitly logged `⏭️ SKIPPED_EXTERNAL_DEPENDENCY: <reason>` and do not fail the run — verified live: sections D and H correctly skip with reasons `"HTTP 404: Not Found"` and `"No usable backend found for etsy"` respectively, while A/B/C/I/J1/K/L all assert-and-pass for real.
- **Server-unavailable test (required by spec)**: ran `node scripts/e2e-test.js` with nothing listening on port 3005 → `EXIT_CODE=1`. Previously this same scenario exited 0.
- **Side effect discovered and fixed**: `node --test` (no path argument) was silently scanning the entire repo and picking up `scripts/e2e-test.js` (matches Node's default `*-test.js` test-file pattern) as a unit test. Before this round, that script never set a nonzero exit code, so it always looked like it "passed" inside `npm test` even when the real E2E logic inside it failed. Fixed by scoping `"test"` in `package.json` to `"node --test \"test/**/*.js\""`.

## 12. Test Matrix

| Suite | Result | Evidence |
|---|---|---|
| `npm test` | 144 passed, 0 failed | Full `node --test` output |
| `npm run validate:codemap` | Passed | "CodeMap Validation Passed!" |
| `node scripts/stress-test-scheduler.js` | PASS | 50/50 completed, 0 violations, 0 leaks |
| `node scripts/social-bot-integration-test.js` | PASS | Real 6s window, restart-safe |
| `node scripts/backup-manager.js ...` | verified=true | Hash + integrity_check both pass |
| `node scripts/e2e-test.js` (server down) | exit 1 | Required negative test |
| `node scripts/e2e-test.js` (server up) | exit 0, all assertions pass, 2 sections correctly SKIPPED_EXTERNAL_DEPENDENCY | Full log in Section 11 |
| Backfill idempotency (live DB) | migrated 110 then 0 | Direct verification, Section 8 |

## 13. Backup / Rollback

- `.backup/20260824-141825/` — scheduler/reliability/ranking/runs.service/server.js + `data/collector.db` (pre this round's rewrites).
- `.backup/20260824-145253/` and subsequent timestamped folders — social-bots, retry-policy, e2e-test.js, package.json (pre later fixes in this round).
- All backups from this round were created with the upgraded `backup-manager.js` and report `verified=true` (SHA-256 match; `PRAGMA integrity_check` for `.db` files). Rollback: copy the file back from its timestamped folder; for the database, stop the server first.
- No legacy `snapshots` rows, no `weekly_summary` rows, and no prior round's backups were deleted.

## 14. Files Changed

Scheduler: `execution-planner.js` (rewritten), `resource-monitor.js` (unchanged API, executionToken semantics), `resource-profile.js` (deprecated), `worker-pool.js` (executionToken keys), `scheduler.js` (rewritten), `job-sharder.js` (new), `run-queue.js` (added `sharded` status).
Reliability: `heartbeat.js`, `stuck-detector.js`, `retry-policy.js`, `execution-lease.js` (unchanged API, reused).
Core: `src/runs.service.js`, `src/database.js`, `server.js`, `anti-bot/scraper-factory.js`.
Social: `src/social-bots/bot-config.js`, `src/social-bots/social-scheduler.js`.
Scripts: `scripts/e2e-test.js`, `scripts/backup-manager.js`, `scripts/stress-test-scheduler.js`, `scripts/social-bot-integration-test.js`.
Config: `package.json` (test script scoping).
Tests: `test/scheduler.test.js` (rewritten), `test/reliability.test.js`, `test/marketplace-api.test.js` (timing fix for the now-async capture path).
Docs: `codemaps/phases/phase-18-simplification-round.md`, `codemaps/index.json`, this report.

## 15. Remaining External Dependencies

- No live `APIFY_TOKEN` in this environment — paid channels report `missing_token`/`NO_HEALTHY_BACKEND` correctly; not faked as PASS.
- SearXNG (`localhost:8888`/`8080`) not running — local-scraper channels requiring it correctly report `NO_HEALTHY_BACKEND`.
- Real Chrome CDP not listening at `localhost:9222` in this environment — toidispy shards correctly fail with a diagnostic error rather than hanging.

## 16. Final Recommendation

**READY FOR MERGE.** Every acceptance criterion in this round's Definition of Done is met and verified with real, reproducible evidence (not claims), including the one gap (`capture-scheduler.js`'s per-listing loop) identified mid-audit and closed before finalizing this report (Section 1). The only open items are environmental (APIFY_TOKEN, SearXNG, live CDP — Section 15) and the explicitly-scoped-out V2 read-cutover (Section 8, N/A because no legacy read route exists to cut over).
