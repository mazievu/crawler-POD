'use strict';

/**
 * test/security/startup-admin-guard-spawn.test.js
 *
 * L1: when ADMIN_EMAIL belongs to an EXISTING non-admin user,
 * bootstrapSuperAdmin() reports success without creating an admin. In
 * production the server must then refuse to boot with zero admins instead of
 * serving traffic nobody can administer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { makeHermeticEnv, cleanupHermeticEnv } = require('../helpers/hermetic-spawn-env');

const ADMIN_EMAIL = 'taken-by-member@system.local';

/** Pre-creates a NON-admin user with ADMIN_EMAIL in the hermetic PGlite dir. */
function seedMemberUser(env) {
  const script = `
    const db = require('./src/database');
    (async () => {
      await db.initDatabase();
      await db.createUser({ email: ${JSON.stringify(ADMIN_EMAIL)}, passwordHash: 'not-a-real-hash', role: 'member' });
      const admins = await db.countAdmins();
      await db._connection.close();
      process.stdout.write('admins=' + admins);
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(2); });
  `;
  const out = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(), env: { ...env, NODE_ENV: 'development' }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(out.status, 0, `seeding failed: ${out.stderr}`);
  assert.match(out.stdout, /admins=0/);
}

function runServer(env, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => finish({ exited: true, code, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ exited: false, code: null, stdout, stderr });
    }, timeoutMs);
  });
}

test('Spawn: production boot exits when ADMIN_EMAIL is an existing non-admin user (zero admins)', async () => {
  const { env, paths } = makeHermeticEnv({
    PORT: '32211',
    NODE_ENV: 'production',
    ADMIN_EMAIL,
    ADMIN_PASSWORD: 'ProdSuperAdminPassword123!',
    CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64),
    INTERNAL_SERVICE_KEY: 'prod-internal-service-key',
    ALLOWED_ORIGINS: 'https://app.example.com',
  });

  try {
    seedMemberUser(env);
    const result = await runServer(env);
    assert.equal(result.exited, true, 'server must refuse to keep running with zero admins');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no admin|zero admin|0 admin/i, `stderr must explain, got: ${result.stderr}`);
  } finally {
    cleanupHermeticEnv(paths);
  }
});
