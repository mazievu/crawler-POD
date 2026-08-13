# API Changes

## GET /api/doctor
Added. Returns JSON health status of all channels and backends.

## GET /api/platforms
Preserved. Backwards compatibility maintained. Returns list of available platforms.

## POST /api/runs
Preserved but heavily refactored. Now routes execution through BackendRouter instead of hardcoded Apify client.

## GET /api/runs/:id
Now includes backend metadata fields (active_backend, health_snapshot, backend_kind, etc).

## GET /api/export/:runId
Preserved.

## Compatibility Notes
Older clients will still work as the old fields (apify_run_id, status) are preserved and correctly populated by adapters.


## Agent-Reach Parity Updates
- `POST /api/runs` now performs a pre-flight check and may return a 400 `NO_HEALTHY_BACKEND` error with structured diagnostics if no backends are available.
- Added `GET /api/toidispy/check-login` and `POST /api/toidispy/check-login` to verify Toidispy CDP connection and login state without polluting run history.