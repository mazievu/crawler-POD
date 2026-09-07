# Phase 16: Reliability, Heartbeat & Crash Recovery

## Goal
Implement end-to-end resilience: runtime stage heartbeat tracking, stuck scraper detection, intelligent retry classification with exponential backoff, and server boot crash recovery.

## Architectural Changes
- Created `src/reliability/retry-policy.js`: Error classification (retryable vs non-retryable) and backoff.
- Created `src/reliability/heartbeat.js`: Stage progress tracking and idle measurement.
- Created `src/reliability/stuck-detector.js`: Background daemon detecting stale runs.
- Created `src/reliability/restart-recovery.js`: Automatic re-queuing of orphaned running jobs on boot.
- Upgraded `scripts/live-data-loop.js` with continuous daemon mode.

## Verification Evidence
- Unit test suite `test/reliability.test.js` passed.
- Verified orphaned run re-queuing and graceful shutdown signals.
