# Database Migrations

## Migration File
`001_run_backend_metadata.js` (logical, handled in database.js setup).

## Columns Added to `runs` table
- `active_backend` (TEXT)
- `backend_kind` (TEXT)
- `backend_status` (TEXT)
- `backend_version` (TEXT)
- `backend_run_id` (TEXT)
- `health_snapshot` (TEXT)
- `cost_estimate` (REAL)

## Idempotency
Implemented with `PRAGMA table_info` check to ensure columns are only added if they do not exist.

## Rollback/Compatibility Notes
No rollback needed. Data is preserved. Old clients ignore new columns.

## Expected Fields
- `active_backend`: 'apify', 'local-scraper', 'cdp', 'mock'
- `backend_kind`: 'apify', 'local', 'cdp', 'mock'
- `health_snapshot`: JSON string of probe results/warnings
