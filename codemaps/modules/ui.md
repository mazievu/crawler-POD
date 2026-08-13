# Module: UI


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


**Files:** `public/*`


## Agent-Reach Parity Updates
The UI Collect Modal now fetches `/api/doctor` to determine backend health. Platforms without healthy backends are disabled, and detailed setup actions (like Toidispy login or Apify token needs) are displayed directly in the UI.