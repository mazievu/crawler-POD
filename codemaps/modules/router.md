# Module: Router


## Responsibility
What this module does.
## Public API
Exposed functions/classes.
## Files
Files belonging to this module.
## Dependencies
What this module imports.
## Before
How things worked previously.
## After
How things work now.
## Failure Modes
What happens when it breaks.
## Test Coverage
Associated tests.
## Known Limitations
Current gaps or technical debt.


**Files:** `src/router/backend-router.js`


## Agent-Reach Parity Updates
`BackendRouter` now performs pre-flight checks and throws a structured `NoHealthyBackendError` if no viable backends are found. This error includes the detailed `diagnostic` report from the doctor module, allowing the API to return a structured error response instead of a raw stack trace.