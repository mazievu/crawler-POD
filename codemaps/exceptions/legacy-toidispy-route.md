# Legacy Toidispy Route Exception

## Route
`POST /api/toidispy/run`

## Bypasses BackendRouter
Yes, this route directly triggers the CDP collection logic.

## Reason
The Toidispy workflow has a unique browser-login/CDP lifecycle that was preserved to avoid breaking existing released behavior.

## Impact
Most collection jobs now go through BackendRouter, but this route remains a controlled legacy exception. Run metadata for this specific job might not be fully normalized through runs.service.

## Future Migration Path
Move `/api/toidispy/run` logic into `src/backends/cdp.backend.js` and normalize its execution through `src/runs.service.js` after the CDP lifecycle is fully mapped to the probe/run adapter contract.


## Agent-Reach Parity Updates
Legacy routes are preserved to ensure backwards compatibility as per the strict non-breaking update rules. Toidispy routing now includes a check-login endpoint to avoid creating legacy or failed runs when login is required.