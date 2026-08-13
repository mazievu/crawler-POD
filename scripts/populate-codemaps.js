const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'codemaps');

function writeContent(subPath, content) {
  fs.writeFileSync(path.join(root, subPath), content.trim() + '\n', 'utf8');
}

// README
writeContent('README.md', `
# Crawler-POD Codemaps

This directory contains the definitive, granular documentation for the crawler-POD capability layer upgrade.

- \`phases/\`: Documentation of the 12-phase capability upgrade.
- \`modules/\`: Deep-dives into individual system components.
- \`api/\`: Details of API contract changes.
- \`database/\`: Schema migrations and metadata additions.
- \`exceptions/\`: Documented architectural exceptions and legacy routes.
`);

// PHASES
const phaseHeadings = `
## Goal
Describe the objective of this phase.
## Files Added
List of new files.
## Files Modified
List of changed files.
## Behavior Changes
Before and after behaviors.
## API Changes
API modifications.
## Database Changes
Schema additions.
## Tests Added
Coverage introduced.
## Verification Evidence
Proof of success.
## Risks / Notes
Potential edge cases.
`;

const phaseData = [
  { name: 'phase-01-codemaps-gate', title: 'Phase 01: Codemaps Gate', content: 'Gate to ensure all work is documented via Codemaps.' },
  { name: 'phase-02-channel-registry', title: 'Phase 02: Channel Registry', content: 'Implement `src/channels/registry.js` and move platform configs to `.channel.js` files.' },
  { name: 'phase-03-backend-adapters', title: 'Phase 03: Backend Adapters', content: 'Implement `src/backends/base.backend.js`, `apify.backend.js`, `local-scraper.backend.js`, `cdp.backend.js`, `mock.backend.js`. Define probe/run contract.' },
  { name: 'phase-04-backend-router', title: 'Phase 04: Backend Router', content: 'Implement `src/router/backend-router.js` to select active backend based on priority and health.' },
  { name: 'phase-05-doctor-system', title: 'Phase 05: Doctor System', content: 'Implement `src/doctor/index.js` to probe channels and return health status.' },
  { name: 'phase-06-database-migration', title: 'Phase 06: Database Migration', content: 'Add backend metadata fields to database (`active_backend`, `health_snapshot`, etc).' },
  { name: 'phase-07-normalizer-layer', title: 'Phase 07: Normalizer Layer', content: 'Implement data normalizers in `src/normalize/`.' },
  { name: 'phase-08-run-service-refactor', title: 'Phase 08: Run Service Refactor', content: 'Refactor `src/runs.service.js` to write backend metadata and use the BackendRouter.' },
  { name: 'phase-09-ui-additions', title: 'Phase 09: UI Additions', content: 'Update frontend to show backend info and doctor diagnostics.' },
  { name: 'phase-10-agent-skill', title: 'Phase 10: Agent Skill', content: 'Create `skills/crawler-pod/SKILL.md` for AI agent instructions.' },
  { name: 'phase-11-tests', title: 'Phase 11: Tests', content: 'Add unit tests for backends, router, doctor, and registry.' },
  { name: 'phase-12-release-e2e-regression', title: 'Phase 12: Release E2E Regression', content: 'Add `scripts/e2e-test.js` covering scenarios A-H.' }
];

phaseData.forEach((p, idx) => {
  const file = `phases/${p.name}.md`;
  const content = `
# ${p.title}

${phaseHeadings}

**Details for this phase:**
${p.content}
`;
  writeContent(file, content);
});

// MODULES
const moduleHeadings = `
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
`;

const moduleData = [
  { name: 'channels', title: 'Module: Channels', files: '`src/channels/*`' },
  { name: 'backends', title: 'Module: Backends', files: '`src/backends/*`' },
  { name: 'router', title: 'Module: Router', files: '`src/router/backend-router.js`' },
  { name: 'doctor', title: 'Module: Doctor', files: '`src/doctor/index.js`' },
  { name: 'database', title: 'Module: Database', files: '`src/database.js`' },
  { name: 'normalizers', title: 'Module: Normalizers', files: '`src/normalize/*`' },
  { name: 'run-service', title: 'Module: Run Service', files: '`src/runs.service.js`' },
  { name: 'ui', title: 'Module: UI', files: '`public/*`' },
  { name: 'agent-skill', title: 'Module: Agent Skill', files: '`skills/crawler-pod/SKILL.md`' },
  { name: 'e2e', title: 'Module: E2E', files: '`scripts/e2e-test.js`' }
];

moduleData.forEach(m => {
  const file = `modules/${m.name}.md`;
  const content = `
# ${m.title}

${moduleHeadings}

**Files:** ${m.files}
`;
  writeContent(file, content);
});

// API
writeContent('api/api-changes.md', `
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
`);

// DATABASE
writeContent('database/migrations.md', `
# Database Migrations

## Migration File
\`001_run_backend_metadata.js\` (logical, handled in database.js setup).

## Columns Added to \`runs\` table
- \`active_backend\` (TEXT)
- \`backend_kind\` (TEXT)
- \`backend_status\` (TEXT)
- \`backend_version\` (TEXT)
- \`backend_run_id\` (TEXT)
- \`health_snapshot\` (TEXT)
- \`cost_estimate\` (REAL)

## Idempotency
Implemented with \`PRAGMA table_info\` check to ensure columns are only added if they do not exist.

## Rollback/Compatibility Notes
No rollback needed. Data is preserved. Old clients ignore new columns.

## Expected Fields
- \`active_backend\`: 'apify', 'local-scraper', 'cdp', 'mock'
- \`backend_kind\`: 'apify', 'local', 'cdp', 'mock'
- \`health_snapshot\`: JSON string of probe results/warnings
`);

// EXCEPTIONS
writeContent('exceptions/legacy-toidispy-route.md', `
# Legacy Toidispy Route Exception

## Route
\`POST /api/toidispy/run\`

## Bypasses BackendRouter
Yes, this route directly triggers the CDP collection logic.

## Reason
The Toidispy workflow has a unique browser-login/CDP lifecycle that was preserved to avoid breaking existing released behavior.

## Impact
Most collection jobs now go through BackendRouter, but this route remains a controlled legacy exception. Run metadata for this specific job might not be fully normalized through runs.service.

## Future Migration Path
Move \`/api/toidispy/run\` logic into \`src/backends/cdp.backend.js\` and normalize its execution through \`src/runs.service.js\` after the CDP lifecycle is fully mapped to the probe/run adapter contract.
`);
