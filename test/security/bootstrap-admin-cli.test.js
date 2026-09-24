'use strict';

/**
 * test/security/bootstrap-admin-cli.test.js
 *
 * Unit tests for scripts/bootstrap-admin.js (gap #2): CLI to create the
 * initial Super Admin, refusing to run if an admin already exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { runBootstrapAdmin, parseArgs } = require('../../scripts/bootstrap-admin');

function createFakeDb({ admins = 0 } = {}) {
  const users = [];
  let adminCount = admins;
  return {
    async countAdmins() { return adminCount; },
    async getUserByEmail(email) {
      return users.find((u) => u.email === email.trim().toLowerCase()) || null;
    },
    async createUser({ email, passwordHash, role, status }) {
      const user = { id: users.length + 1, email: email.trim().toLowerCase(), passwordHash, role, status };
      users.push(user);
      if (role === 'admin') adminCount += 1;
      return user;
    },
  };
}

test('parseArgs: reads --email/--password as separate flags', () => {
  const parsed = parseArgs(['--email', 'a@b.com', '--password', 'Secret123!']);
  assert.deepEqual(parsed, { email: 'a@b.com', password: 'Secret123!' });
});

test('parseArgs: reads --email=/--password= as single tokens', () => {
  const parsed = parseArgs(['--email=a@b.com', '--password=Secret123!']);
  assert.deepEqual(parsed, { email: 'a@b.com', password: 'Secret123!' });
});

test('runBootstrapAdmin: creates admin when none exists (env vars)', async () => {
  const database = createFakeDb({ admins: 0 });
  const result = await runBootstrapAdmin({
    env: { ADMIN_EMAIL: 'root@system.local', ADMIN_PASSWORD: 'RootPassword123!' },
    args: [],
    database,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.email, 'root@system.local');
  assert.equal(await database.countAdmins(), 1);
});

test('runBootstrapAdmin: creates admin when none exists (CLI args take precedence)', async () => {
  const database = createFakeDb({ admins: 0 });
  const result = await runBootstrapAdmin({
    env: { ADMIN_EMAIL: 'env@system.local', ADMIN_PASSWORD: 'EnvPassword123!' },
    args: ['--email', 'cli@system.local', '--password', 'CliPassword123!'],
    database,
  });
  assert.equal(result.ok, true);
  assert.equal(result.email, 'cli@system.local');
});

test('runBootstrapAdmin: refuses when an admin already exists', async () => {
  const database = createFakeDb({ admins: 1 });
  const result = await runBootstrapAdmin({
    env: { ADMIN_EMAIL: 'root@system.local', ADMIN_PASSWORD: 'RootPassword123!' },
    args: [],
    database,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.match(result.message, /already exists/i);
});

test('runBootstrapAdmin: fails fast without email/password', async () => {
  const database = createFakeDb({ admins: 0 });
  const result = await runBootstrapAdmin({ env: {}, args: [], database });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.match(result.message, /ADMIN_EMAIL/);
});

test('runBootstrapAdmin: whitespace-only password is treated as missing', async () => {
  const database = createFakeDb({ admins: 0 });
  const result = await runBootstrapAdmin({
    env: { ADMIN_EMAIL: 'root@system.local', ADMIN_PASSWORD: '   ' },
    args: [],
    database,
  });
  assert.equal(result.ok, false);
});

test('runBootstrapAdmin: requires a database instance', async () => {
  const result = await runBootstrapAdmin({ env: { ADMIN_EMAIL: 'a@b.com', ADMIN_PASSWORD: 'x' }, args: [] });
  assert.equal(result.ok, false);
  assert.match(result.message, /database/i);
});

test('CLI spawn: node scripts/bootstrap-admin.js creates admin via pglite and exits 0', async () => {
  const repoRoot = path.join(__dirname, '..', '..');
  // Hermetic: use a unique PGLITE_DIR under the OS temp dir per run, so a
  // leftover admin from a prior run (or a shared repo-local directory)
  // never causes a false "admin already exists" failure. Also strip any
  // real Postgres connection env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/
  // PGDATABASE/DATABASE_URL) the outer test runner may have exported (CI
  // sets these for the Postgres-backed suites) so the spawned process
  // cannot accidentally fall through to the shared Postgres database.
  const pgliteDir = path.join(
    os.tmpdir(),
    `crawler-pod-bootstrap-cli-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );

  const env = { ...process.env };
  delete env.PGHOST;
  delete env.PGPORT;
  delete env.PGUSER;
  delete env.PGPASSWORD;
  delete env.PGDATABASE;
  delete env.DATABASE_URL;
  delete env.PG_CONNECTION_STRING;
  env.PG_MODE = 'pglite';
  env.PGLITE_DIR = pgliteDir;
  env.ADMIN_EMAIL = 'cli-spawn-admin@system.local';
  env.ADMIN_PASSWORD = 'CliSpawnAdminPassword123!';

  try {
    const result = spawnSync(process.execPath, ['scripts/bootstrap-admin.js'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /Super Admin account created: cli-spawn-admin@system\.local/);
  } finally {
    // Clean up the temp dir this test created — never touch anything under
    // the repo's real data/ directory.
    fs.rmSync(pgliteDir, { recursive: true, force: true });
  }
});
