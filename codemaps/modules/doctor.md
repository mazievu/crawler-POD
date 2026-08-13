# Module: Doctor


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


**Files:** `src/doctor/index.js`


## Agent-Reach Parity Updates
The doctor module now powers a setup wizard (`scripts/setup-capabilities.js`) and UI health gating. It provides structured diagnostics that the `BackendRouter` uses to throw `NoHealthyBackendError` when no backends are viable.