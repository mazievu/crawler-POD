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
  const env = {
    ...process.env,
    PG_MODE: 'pglite',
    PGLITE_DIR: path.join(repoRoot, '.tmp-pglite-bootstrap-cli-test'),
    ADMIN_EMAIL: 'cli-spawn-admin@system.local',
    ADMIN_PASSWORD: 'CliSpawnAdminPassword123!',
  };

  const result = spawnSync(process.execPath, ['scripts/bootstrap-admin.js'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /Super Admin account created: cli-spawn-admin@system\.local/);
});
