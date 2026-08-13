# Module: Backends


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


**Files:** `src/backends/*`


## Agent-Reach Parity Updates
Backends are now subjected to a real verification suite (`scripts/verify-real-backends.js`) which checks actual endpoints instead of just mocking. Paid Apify backends are verified via `scripts/verify-apify.js` to check actor entitlements.