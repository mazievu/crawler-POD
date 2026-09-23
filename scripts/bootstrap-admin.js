#!/usr/bin/env node
'use strict';

/**
 * scripts/bootstrap-admin.js — CLI to create the initial Super Admin account.
 *
 * Usage:
 *   node scripts/bootstrap-admin.js --email admin@example.com --password 'S3curePass!'
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='S3curePass!' node scripts/bootstrap-admin.js
 *
 * Refuses to create a second admin if one already exists — this is meant to
 * be the explicit, operator-driven alternative to the implicit env-var boot
 * bootstrap in server.js, for deployments that want bootstrap decoupled from
 * "first time the server process starts".
 */

/**
 * Parses `--email <value>` / `--password <value>` (also accepts `--email=value`).
 * @param {string[]} argv
 * @returns {{ email?: string, password?: string }}
 */
function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eqMatch = /^--(email|password)=(.*)$/.exec(arg);
    if (eqMatch) {
      out[eqMatch[1]] = eqMatch[2];
      continue;
    }
    const flagMatch = /^--(email|password)$/.exec(arg);
    if (flagMatch) {
      out[flagMatch[1]] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/**
 * Core bootstrap logic, decoupled from process.exit/console so it is unit
 * testable with a fake database/authService.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   args?: string[],
 *   database: object,
 *   getAuthServiceFn?: (db: object) => { bootstrapSuperAdmin: Function },
 * }} options
 * @returns {Promise<{ ok: boolean, code: number, message: string, email?: string }>}
 */
async function runBootstrapAdmin({ env = process.env, args = [], database, getAuthServiceFn } = {}) {
  if (!database) {
    return { ok: false, code: 1, message: 'A database instance is required.' };
  }

  const parsed = parseArgs(args);
  const email = (parsed.email || env.ADMIN_EMAIL || '').trim();
  const password = parsed.password !== undefined ? parsed.password : env.ADMIN_PASSWORD;

  if (!email || !password || (typeof password === 'string' && !password.trim())) {
    return {
      ok: false,
      code: 1,
      message: 'ADMIN_EMAIL and ADMIN_PASSWORD are required (via --email/--password flags or env vars).',
    };
  }

  const adminCount = await database.countAdmins();
  if (adminCount > 0) {
    return {
      ok: false,
      code: 1,
      message: 'Refusing to bootstrap: an admin account already exists. Use the admin UI/API to manage users instead.',
    };
  }

  const getAuthService = getAuthServiceFn || require('../src/security/auth.service').getAuthService;
  const authService = getAuthService(database);
  const result = await authService.bootstrapSuperAdmin({ email, password });

  if (!result.success) {
    return { ok: false, code: 1, message: `Bootstrap failed: ${result.reason || 'unknown error'}` };
  }

  if (!result.created) {
    // Race: another process created the admin between our countAdmins() check
    // and the bootstrap call. Treat this as a refusal, not a success, so the
    // caller doesn't believe THIS invocation is what created the account.
    return {
      ok: false,
      code: 1,
      message: `Refusing to bootstrap: an admin account (${result.user.email}) already exists.`,
    };
  }

  return { ok: true, code: 0, message: `Super Admin account created: ${result.user.email}`, email: result.user.email };
}

async function main() {
  const database = require('../src/database');
  await database.initDatabase();

  const outcome = await runBootstrapAdmin({ env: process.env, args: process.argv.slice(2), database });
  if (outcome.ok) {
    console.log(`[bootstrap-admin] ${outcome.message}`);
  } else {
    console.error(`[bootstrap-admin] ${outcome.message}`);
  }
  process.exit(outcome.code);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[bootstrap-admin] Unexpected error:', err.message);
    process.exit(1);
  });
}

module.exports = { runBootstrapAdmin, parseArgs };
