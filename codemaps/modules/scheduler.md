# Scheduler Module

## Responsibility
Enforce RAM-aware admission control, historical memory learning, worker pool concurrency limits, and exclusive resource locks.

## Public API
- `ResourceMonitor.getSnapshot()`: Returns physical memory snapshot and pressure state (GREEN/YELLOW/RED).
- `ResourceMonitor.canAdmit(estimatedMB)`: Checks if memory headroom permits run admission.
- `ResourceProfileManager.getProfile(platform, backend, mode)`: Returns learned memory/duration profile.
- `WorkerPoolManager.canAdmit(poolName, locks, runId)`: Checks pool capacity and resource locks.
- `ResourceScheduler.submitRun(payload)`: Enqueues run and triggers reactive dispatch.
- `ResourceScheduler.getStatus()`: Returns live scheduler telemetry.
