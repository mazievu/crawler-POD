const fs = require('fs');
const path = require('path');

const updates = {
  'codemaps/modules/doctor.md': `\n\n## Agent-Reach Parity Updates\nThe doctor module now powers a setup wizard (\`scripts/setup-capabilities.js\`) and UI health gating. It provides structured diagnostics that the \`BackendRouter\` uses to throw \`NoHealthyBackendError\` when no backends are viable.`,
  'codemaps/modules/backends.md': `\n\n## Agent-Reach Parity Updates\nBackends are now subjected to a real verification suite (\`scripts/verify-real-backends.js\`) which checks actual endpoints instead of just mocking. Paid Apify backends are verified via \`scripts/verify-apify.js\` to check actor entitlements.`,
  'codemaps/modules/router.md': `\n\n## Agent-Reach Parity Updates\n\`BackendRouter\` now performs pre-flight checks and throws a structured \`NoHealthyBackendError\` if no viable backends are found. This error includes the detailed \`diagnostic\` report from the doctor module, allowing the API to return a structured error response instead of a raw stack trace.`,
  'codemaps/modules/ui.md': `\n\n## Agent-Reach Parity Updates\nThe UI Collect Modal now fetches \`/api/doctor\` to determine backend health. Platforms without healthy backends are disabled, and detailed setup actions (like Toidispy login or Apify token needs) are displayed directly in the UI.`,
  'codemaps/modules/e2e.md': `\n\n## Agent-Reach Parity Updates\nE2E tests have been expanded to include regression for the setup wizard, Facebook Posts unavailability (structured error checks), Toidispy check-login functionality, and the backend coverage map.`,
  'codemaps/modules/agent-skill.md': `\n\n## Agent-Reach Parity Updates\nThe agent skill has full parity for setup wizards, API validation, and UI health gating, enabling better reliability and user experience.`,
  'codemaps/api/api-changes.md': `\n\n## Agent-Reach Parity Updates\n- \`POST /api/runs\` now performs a pre-flight check and may return a 400 \`NO_HEALTHY_BACKEND\` error with structured diagnostics if no backends are available.\n- Added \`GET /api/toidispy/check-login\` and \`POST /api/toidispy/check-login\` to verify Toidispy CDP connection and login state without polluting run history.`,
  'codemaps/exceptions/legacy-toidispy-route.md': `\n\n## Agent-Reach Parity Updates\nLegacy routes are preserved to ensure backwards compatibility as per the strict non-breaking update rules. Toidispy routing now includes a check-login endpoint to avoid creating legacy or failed runs when login is required.`,
  'codemaps/exceptions/toidispy-login-state.md': `\n\n## Agent-Reach Parity Updates\nToidispy login state is now explicitly handled by the UI gating system and the \`/api/toidispy/check-login\` endpoint. The setup wizard and real backend verifier identify \`TOIDISPY_LOGIN_REQUIRED\` rather than reporting a generic failure.`,
  'codemaps/phases/phase-12-release-e2e-regression.md': `\n\n## Agent-Reach Parity Updates\nThe release regression phase encompasses the Agent-Reach Parity changes, including setup wizards, UI gating, structured errors, Apify verifiers, and Toidispy login checks.`
};

for (const [file, content] of Object.entries(updates)) {
  const fullPath = path.join(__dirname, '..', file);
  if (fs.existsSync(fullPath)) {
    fs.appendFileSync(fullPath, content);
    console.log(`Updated ${file}`);
  } else {
    fs.writeFileSync(fullPath, `# ${path.basename(file, '.md')}\n${content}`);
    console.log(`Created ${file}`);
  }
}
