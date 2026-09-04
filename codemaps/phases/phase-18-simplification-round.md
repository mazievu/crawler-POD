# Phase 18: Final Architecture Simplification & Hardening

## Goal
Simplify Fix Round 2's scheduler/database architecture: remove historical RAM learning, make every request plan its own resource envelope, bound large requests via sharding, key resource ownership by executionToken (not runId), route every crawler workload (including toidispy, user-journey, marketplace capture) through the shared Resource Scheduler, split heartbeat-alive from progress-made, and reduce the core data model to product_current + daily_packed_history (weekly_summary deprecated, not dropped).

## Architectural Changes
- `src/scheduler/execution-planner.js`: rewritten — no `ResourceProfileManager` dependency; computes a static per-execution-class envelope (`DEFAULT_CLASS_ENVELOPES_MB`) adjusted by THIS request's own shape (concurrency, image enrichment, browser fallback), never by prior-run history. Adds sharding fields (`shardSize`, `shardCount`) and non-channel job kinds (`user_journey`, `marketplace_capture`, `marketplace_discovery`).
- `src/scheduler/resource-profile.js`: `@deprecated`, no longer imported by the scheduler; kept only as a rollback artifact.
- `src/scheduler/job-sharder.js` (NEW): splits an oversized request into bounded shard runs (`parent_run_id` column added to `runs`), aggregates child results back onto the parent.
- `src/scheduler/worker-pool.js` / `scheduler.js`: ownership (pool slots, locks, RAM reservations) keyed by `executionToken`, not `runId` — a retried attempt cannot release or be confused with a sibling attempt's resources.
- `src/reliability/heartbeat.js`: `lastHeartbeatAt` (real periodic timer, process-alive signal) split from `lastProgressAt` (work advanced signal).
- `src/reliability/stuck-detector.js`: per-execution-class stuck timeouts (`DEFAULT_STUCK_TIMEOUTS_MS`) instead of one flat number for every backend.
- `src/runs.service.js`: execution-lease ownership re-checked at every write boundary (post-backend-run, pre-persist), not only at the final done/failed transition.
- `server.js`: `/api/toidispy/run`, `/api/user-journey/run`, `/api/html-captures` (both sync and batch branches) now submit through `scheduler.submitRun()`/`waitForCompletion()` instead of calling `executeRun`/`runUserJourney`/`runMarketplaceCapture` directly; marketplace schedule tick no longer `await`s captures (fire-and-forget dispatch, so a hung capture cannot wedge `marketplaceScheduleTickActive` forever).
- `src/database.js`: `weekly_summary` writes removed from the core path (table/data preserved, `getProductWeekly` marked deprecated); `getDatabaseHealth()` + `GET /api/database/health` added; `backfillSnapshotsToV2()` made idempotent via a `migration_checkpoints` table; V2 dual-write failures recorded in `v2_write_failures` and repaired at boot (`repairPendingV2WriteFailures`) instead of only logged.
- `src/social-bots/social-scheduler.js`: `recoverStalePendingSocialBotWindows()` sweeps abandoned 'pending' reservations (crash between reserve and dispatch-confirm) every tick.
- `src/social-bots/bot-config.js`: `load()` now persists the config file on first run instead of only claiming in-memory defaults are equivalent.
- `anti-bot/scraper-factory.js` + `src/reliability/retry-policy.js`: unified retry classification — `scrapeWithRetry`'s loop now stops on a non-retryable error (404, invalid schema) instead of always exhausting all attempts.
- `scripts/e2e-test.js`: assertion failures now throw and set `process.exitCode = 1` (previously `console.assert` never failed the process); external-dependency-blocked scenarios are explicitly logged as `SKIPPED_EXTERNAL_DEPENDENCY`, never folded into PASS.
- `package.json`: `test` script scoped to `test/**/*.js` — previously `node --test` (no path) scanned the whole repo and silently picked up `scripts/e2e-test.js` as a "test", which always looked like it passed because that script never used to set a nonzero exit code.
- `scripts/backup-manager.js`: verifies SHA-256(source)==SHA-256(backup) and, for `.db` files, `PRAGMA integrity_check`; throws (refusing to proceed) if verification fails.

## Known, disclosed limitations (not hidden)
- Sharding partitions requests by `maxItems`/`offset` hints, but not every channel/scraper honors `offset` for true pagination — shards correctly bound RAM/concurrency, but may not guarantee non-overlapping result sets for every platform.
- V2 read-path cutover (`READ_MODEL_V2` feature flag routing `/api/items` reads to `product_current`) was not implemented this round — no such route existed to cut over in the first place; noted as future work if/when such routes are added.

## Update: capture-scheduler.js per-listing loop now routed through the Scheduler
`server.js`'s `createMarketplaceCaptureScheduler({ capture: ... })` now injects `submitMarketplaceCaptureViaScheduler` instead of `runMarketplaceCapture` directly, so every discovered listing goes through the shared Resource Scheduler as its own `marketplace_capture` job (BROWSER pool + RAM admission applies per item). This closes the one remaining bypass identified during this round's audit.

## Verification Evidence
- `npm test`: 144 passed, 0 failed.
- `npm run validate:codemap`: passed.
- `node scripts/stress-test-scheduler.js`: 50 concurrent submissions, zero violations, using the new executionToken-keyed WorkerPoolManager.
- `node scripts/social-bot-integration-test.js`: real 6s interval, restart-safe.
- Live server verification: `/api/toidispy/run` and `/api/user-journey/run` both dispatch through the Scheduler (confirmed via `/api/scheduler/status` and real run records showing sharding + `executionToken`).
- `node scripts/backup-manager.js ...`: reports `verified=true` with hash + integrity_check.
- `node scripts/e2e-test.js` against a stopped server: exits with code 1 (previously exited 0).
