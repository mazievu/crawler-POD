'use strict';

/**
 * test/helpers/hermetic-spawn-env.js
 *
 * Shared helper for tests that spawn a real `server.js` (or other script)
 * subprocess with PG_MODE=pglite. Without this, the spawned process falls
 * back to the default on-disk locations for its pglite data dir, Apify
 * token pool file, and social bot config file — all under the repo's real
 * `data/` directory — which pollutes that directory and leaks state
 * between unrelated test suites (and into a developer's local checkout).
 *
 * Usage:
 *   const { makeHermeticEnv, cleanupHermeticEnv } = require('../helpers/hermetic-spawn-env');
 *   const { env, paths } = makeHermeticEnv({ PORT: String(PORT), ... });
 *   const child = spawn(process.execPath, ['server.js'], { env, ... });
 *   try { ... } finally { child.kill('SIGKILL'); cleanupHermeticEnv(paths); }
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

function makeHermeticEnv(extraEnv = {}) {
  const runId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}-${Date.now()}`;
  const pgliteDir = path.join(os.tmpdir(), `crawler-pod-test-pglite-${runId}`);
  const apifyTokensPath = path.join(os.tmpdir(), `crawler-pod-test-apify-tokens-${runId}.json`);
  const socialBotsPath = path.join(os.tmpdir(), `crawler-pod-test-social-bots-${runId}.json`);
  const capturesDir = path.join(os.tmpdir(), `crawler-pod-test-captures-${runId}`);
  const everbeeProfileRoot = path.join(os.tmpdir(), `crawler-pod-test-everbee-profiles-${runId}`);

  const env = {
    ...process.env,
    ...extraEnv,
    PG_MODE: 'pglite',
    PGLITE_DIR: pgliteDir,
    APIFY_TOKENS_PATH: apifyTokensPath,
    SOCIAL_BOTS_CONFIG_PATH: socialBotsPath,
    CAPTURES_DIR: capturesDir,
    EVERBEE_PROFILE_ROOT: everbeeProfileRoot,
  };
  // Never let a hermetic pglite subprocess fall through to a real shared
  // Postgres just because the outer test runner had one configured (e.g.
  // CI env vars for the Postgres-backed suites).
  delete env.DATABASE_URL;
  delete env.PG_CONNECTION_STRING;

  return { env, paths: { pgliteDir, apifyTokensPath, socialBotsPath, capturesDir, everbeeProfileRoot } };
}

function cleanupHermeticEnv(paths) {
  if (!paths) return;
  for (const target of Object.values(paths)) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (_) {
      // best-effort cleanup only
    }
  }
}

module.exports = { makeHermeticEnv, cleanupHermeticEnv };
