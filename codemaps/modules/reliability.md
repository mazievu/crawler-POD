# Reliability & Recovery Module

## Responsibility
Track runtime stage progress via heartbeats, detect stuck runs, classify errors, and recover orphaned jobs on boot.

## Public API
- `RetryPolicy.isRetryable(error)`: Classifies error as transient vs fatal.
- `RetryPolicy.calculateBackoff(attempt)`: Computes exponential delay with jitter.
- `HeartbeatTracker.setStage(stage) / progress(count)`: Updates stage and idle timestamps.
- `StuckDetector.checkStuckRuns()`: Scans and recovers inactive runs exceeding timeout.
- `recoverOrphanedRuns(db, retryPolicy)`: Recovers orphaned running jobs on server startup.
