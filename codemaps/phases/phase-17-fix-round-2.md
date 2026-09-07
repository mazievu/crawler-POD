# Phase 17: Fix Round 2 — Architecture Correctness Audit & Repair

## Goal
Audit Fix Round 1's scheduler/database/social-bots/reliability implementation against the original spec, fix confirmed architectural bugs (backend hard-coding, RAM over-commit, unsafe resource learning, unattributed windowed deltas, wrong weekly math, fake social platform mapping, in-memory-only scheduling state, unsafe stuck-run recovery, capped restart recovery query), and produce evidence-backed benchmarks/stress tests instead of claims.

## Root-cause finding not in the original audit
`src/database.js` `updateRun()` never persisted `input_options` (the SQL SET clause omitted it). This silently broke every `attempt` counter and (once added) `executionToken` lease field across retries, stuck recovery, and restart recovery — fixed as a prerequisite for P0-8/P0-9.

## Architectural Changes
- `src/scheduler/execution-planner.js` (NEW): calls the real `BackendRouter.selectBackend()` so backend/pool selection is never scheduler-guessed.
- `src/scheduler/resource-monitor.js`: added `reserve()/release()/getReservedTotalMB()`, `effectiveHeadroomMB` in every snapshot; fixed `ParseFloat` crash typo.
- `src/scheduler/resource-profile.js`: added `confident` sample flag — a low-confidence (concurrent) sample can only raise the memory estimate, never lower it.
- `src/scheduler/scheduler.js`: wired planner + RAM reservation + confidence tracking + execution lease token issuance into `tick()`/`dispatchRun()`.
- `src/reliability/execution-lease.js` (NEW): `issueExecutionToken`/`isCurrentOwner` — stuck-detector and restart-recovery issue a new token on requeue; `runs.service.js` refuses to write final results if its token is stale.
- `src/database.js`: added `getRunsByStatus()` (direct SQL, no row cap) for restart-recovery; added `social_bot_state` table + CRUD for persistent bot scheduling.
- `src/database/schema-v2.js`: `delta_3h_*`/`delta_24h_*` made nullable (safe table rebuild migration); `weekly_summary` gained `sample_count`/`sum_price`/`first_*`/`last_*` columns (safe ADD COLUMN migration).
- `src/database/product-current.js`: real windowed 3h/24h deltas computed from `daily_packed_history` with a 30-minute tolerance window; returns `null` (not 0) when no historical point qualifies.
- `src/database/weekly-summary.js`: `avg_price = sum/count`, `delta_* = last - first`, `growth_rate` divide-by-zero guarded; added `recomputeWeeklySummaryFromHistory()` to rebuild all weeks from Tier 2 without touching it.
- `src/social-bots/bot-config.js`: TikTok bot disabled (`platform: null`, `unsupportedReason` set) — no `tiktok_videos` channel exists, only the unrelated paid `tiktok_shop` product-listing channel; `update()` refuses to enable a bot with no mapped channel.
- `src/social-bots/social-scheduler.js`: dedupe/schedule state moved from in-memory Map/Set to SQLite (`social_bot_state`, UNIQUE(bot_key, scheduled_window, query_key)); query rotation derived deterministically from the window slot number (also restart-safe).
- `src/ranking/product-ranker.js`: added `isProvisional`/`getStatus()`; weights are explicitly PROVISIONAL/TEST unless `businessWeights` or `RANKING_WEIGHTS_JSON` is supplied.
- `scripts/stress-test-scheduler.js` (NEW), `scripts/social-bot-integration-test.js` (NEW): real evidence-producing scripts (not test-suite mocks) for P1-3/P1-4.
- `src/database/benchmark-10m.js`: extended to cover date-range history, weekly history, and latest-items-by-platform queries, plus hardware/SQLite-version reporting.

## Verification Evidence
- `npm test`: 146 passed, 0 failed (up from 134 baseline).
- `node scripts/stress-test-scheduler.js`: 50 concurrent submissions, zero pool-capacity violations, zero duplicate dispatch, zero leaked RAM reservation.
- `node src/database/benchmark-10m.js` (BENCH_PRODUCT_COUNT=100000 BENCH_OBS_PER_ITEM=100): 10,000,000 logical observations, ingested in 12.25s, all query patterns P99 < 0.25ms.
- `node scripts/social-bot-integration-test.js`: real 6-second wall-clock scheduling window, full pipeline write verified, restart simulation confirmed no duplicate dispatch.
- `node scripts/verify-apify.js --platform facebook_posts --json`: correctly reports `missing_token` (no fake PASS) since this environment has no live APIFY_TOKEN.
