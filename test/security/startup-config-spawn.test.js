'use strict';

/**
 * test/security/startup-config-spawn.test.js
 *
 * Spawn-level verification that server.js actually refuses to start in
 * production when required security configuration is missing (gap #1).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { makeHermeticEnv, cleanupHermeticEnv } = require('../helpers/hermetic-spawn-env');

function runServer(env, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
      // Server did not exit in time — treat as "kept running" and kill it.
      child.kill('SIGKILL');
      finish({ exited: false, code: null, stdout, stderr });
    }, timeoutMs);
  });
}

test('Spawn: server.js exits non-zero in production when required config is missing', async () => {
  const { env, paths: hermeticPaths } = makeHermeticEnv({
    PORT: '32199',
    NODE_ENV: 'production',
  });
  delete env.ADMIN_EMAIL;
  delete env.ADMIN_PASSWORD;
  delete env.CREDENTIAL_ENCRYPTION_KEY;
  delete env.INTERNAL_SERVICE_KEY;
  delete env.ALLOWED_ORIGINS;

  try {
    const result = await runServer(env);

    assert.equal(result.exited, true, 'Server must exit rather than keep serving traffic');
    assert.notEqual(result.code, 0, 'Exit code must be non-zero');
    assert.ok(
      /CREDENTIAL_ENCRYPTION_KEY|INTERNAL_SERVICE_KEY|ALLOWED_ORIGINS|ADMIN_EMAIL/.test(result.stderr),
      `stderr must explain what is missing, got: ${result.stderr}`
    );
  } finally {
    cleanupHermeticEnv(hermeticPaths);
  }
});

test('Spawn: server.js starts normally in production once all required config is present', async () => {
  const PORT = 32200;
  const { env, paths: hermeticPaths } = makeHermeticEnv({
    PORT: String(PORT),
    NODE_ENV: 'production',
    ADMIN_EMAIL: 'prod-admin@system.local',
    ADMIN_PASSWORD: 'ProdSuperAdminPassword123!',
    CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64),
    INTERNAL_SERVICE_KEY: 'prod-internal-service-key',
    ALLOWED_ORIGINS: 'https://app.example.com',
  });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/livez`);
        if (res.ok) { ready = true; break; }
      } catch { /* still starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, 'Server with full production config must start within 15s');
  } finally {
    child.kill('SIGKILL');
    cleanupHermeticEnv(hermeticPaths);
  }
});
