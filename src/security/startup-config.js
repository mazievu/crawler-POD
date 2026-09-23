'use strict';

/**
 * src/security/startup-config.js — Fail-closed production boot validation.
 *
 * server.js used to log "skipped"/"bootstrap failed" and keep serving even
 * when required security configuration was missing in production. This
 * module centralises what "required" means so server.js (and the CLI
 * bootstrap script) can refuse to start instead of silently running with a
 * weaker security posture.
 *
 * Non-production environments (dev/test) are intentionally permissive here —
 * local/test convenience matters more than fail-closed behaviour outside of
 * production traffic.
 */

/**
 * Env vars that are unconditionally required once NODE_ENV=production,
 * because production code paths actually consume them:
 *   - CREDENTIAL_ENCRYPTION_KEY: src/security/encrypted-store.js encrypts/decrypts
 *     stored marketplace credentials; without it those features throw at
 *     request time instead of failing at boot.
 *   - INTERNAL_SERVICE_KEY: src/routes/mcp-bridge.js gates the internal MCP
 *     bridge; without it every request is a silent 403 (footgun, not fail-closed).
 *   - ALLOWED_ORIGINS: server.js corsOptions only allows same-origin/no-Origin
 *     requests once NODE_ENV=production, so an unset value quietly blocks
 *     every browser client. Better to refuse to boot than to ship broken CORS.
 */
const REQUIRED_PRODUCTION_ENV_VARS = [
  'CREDENTIAL_ENCRYPTION_KEY',
  'INTERNAL_SERVICE_KEY',
  'ALLOWED_ORIGINS',
];

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, adminCount?: number|null }} options
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateStartupConfig({ env = process.env, adminCount = null } = {}) {
  const errors = [];
  const isProduction = env.NODE_ENV === 'production';

  if (!isProduction) {
    return { ok: true, errors };
  }

  for (const key of REQUIRED_PRODUCTION_ENV_VARS) {
    if (isBlank(env[key])) {
      errors.push(`${key} is required in production (NODE_ENV=production) but is not configured.`);
    }
  }

  // Only demand bootstrap credentials when there is genuinely no admin yet —
  // once an admin exists, ADMIN_EMAIL/ADMIN_PASSWORD are no longer load-bearing.
  if (adminCount === 0) {
    const adminEmailMissing = isBlank(env.ADMIN_EMAIL);
    const adminPasswordMissing = isBlank(env.ADMIN_PASSWORD);
    if (adminEmailMissing || adminPasswordMissing) {
      errors.push(
        'ADMIN_EMAIL and ADMIN_PASSWORD are required in production when no admin account exists yet ' +
        '(bootstrap via env, or run `npm run bootstrap:admin` before starting the server).'
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

class StartupConfigError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'StartupConfigError';
    this.errors = errors;
  }
}

/**
 * Throws a StartupConfigError (with .errors) if the config is invalid.
 * Never throws outside production. Callers (server.js) decide what "invalid"
 * means operationally — for the real server that is process.exit(1).
 */
function assertStartupConfig(options) {
  const result = validateStartupConfig(options);
  if (!result.ok) {
    const message = [
      'Fatal: invalid startup configuration for production (NODE_ENV=production).',
      ...result.errors.map((e) => `  - ${e}`),
    ].join('\n');
    throw new StartupConfigError(message, result.errors);
  }
  return result;
}

module.exports = {
  validateStartupConfig,
  assertStartupConfig,
  StartupConfigError,
  REQUIRED_PRODUCTION_ENV_VARS,
};
