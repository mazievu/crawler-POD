# Phase 13: Resource-Aware Scheduler & Worker Pools

## Goal
Implement real-time RAM-aware admission control, historical resource learning profiles, worker pool concurrency limits, and single-tenant resource locking (CDP 9222, account logins) to prevent system memory exhaustion and uncontrolled concurrent browser processes.

## Architectural Changes
- Created `src/scheduler/resource-monitor.js`: Calculates usable RAM headroom with mandatory reserve (20%) and pressure states (GREEN, YELLOW, RED).
- Created `src/scheduler/resource-profile.js`: Dynamically learns and persists memory/duration metrics per (platform, backend, mode) tuple.
- Created `src/scheduler/worker-pool.js`: Enforces pool limits (Local: 4, Cloud: 8, Browser: 2, CDP: 1) and exclusive resource locks.
- Created `src/scheduler/run-queue.js`: Priority queue backed by SQLite `runs` table.
- Created `src/scheduler/scheduler.js`: Orchestrates admission control and reactive queue dispatch.
- Wired `server.js` and `src/runs.service.js` into the scheduler.

## Verification Evidence
- Unit test suite `test/scheduler.test.js` (5 test cases passed).
- Verified memory calculation, admission rejection under simulated memory exhaustion, and automatic draining of queued jobs as slots free up.
