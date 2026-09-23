'use strict';

/**
 * test/security/startup-config.test.js
 *
 * Unit tests for src/security/startup-config.js — fail-closed boot validation
 * for production deployments (gap #1 in the internet-launch security audit).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateStartupConfig,
  assertStartupConfig,
  StartupConfigError,
  REQUIRED_PRODUCTION_ENV_VARS,
} = require('../../src/security/startup-config');

const FULL_PROD_ENV = {
  NODE_ENV: 'production',
  CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64),
  INTERNAL_SERVICE_KEY: 'internal-service-key-value',
  ALLOWED_ORIGINS: 'https://app.example.com',
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'SuperSecurePassword123!',
};

test('validateStartupConfig: non-production env is always ok, even with nothing configured', () => {
  const result = validateStartupConfig({ env: { NODE_ENV: 'development' }, adminCount: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateStartupConfig: non-production env is ok in test mode too', () => {
  const result = validateStartupConfig({ env: { NODE_ENV: 'test' }, adminCount: null });
  assert.equal(result.ok, true);
});

test('validateStartupConfig: production env with everything configured is ok', () => {
  const result = validateStartupConfig({ env: FULL_PROD_ENV, adminCount: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateStartupConfig: production env missing CREDENTIAL_ENCRYPTION_KEY fails', () => {
  const env = { ...FULL_PROD_ENV, CREDENTIAL_ENCRYPTION_KEY: '' };
  const result = validateStartupConfig({ env, adminCount: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('CREDENTIAL_ENCRYPTION_KEY')));
});

test('validateStartupConfig: production env missing INTERNAL_SERVICE_KEY fails', () => {
  const env = { ...FULL_PROD_ENV, INTERNAL_SERVICE_KEY: undefined };
  const result = validateStartupConfig({ env, adminCount: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('INTERNAL_SERVICE_KEY')));
});

test('validateStartupConfig: production env missing ALLOWED_ORIGINS fails', () => {
  const env = { ...FULL_PROD_ENV, ALLOWED_ORIGINS: '   ' };
  const result = validateStartupConfig({ env, adminCount: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('ALLOWED_ORIGINS')));
});

test('validateStartupConfig: production env, no admin exists yet, missing ADMIN_EMAIL/ADMIN_PASSWORD fails', () => {
  const env = { ...FULL_PROD_ENV, ADMIN_EMAIL: '', ADMIN_PASSWORD: '' };
  const result = validateStartupConfig({ env, adminCount: 0 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('ADMIN_EMAIL') && e.includes('ADMIN_PASSWORD')));
});

test('validateStartupConfig: production env, admin already exists, missing ADMIN_EMAIL/ADMIN_PASSWORD is fine', () => {
  const env = { ...FULL_PROD_ENV, ADMIN_EMAIL: '', ADMIN_PASSWORD: '' };
  const result = validateStartupConfig({ env, adminCount: 3 });
  assert.equal(result.ok, true);
});

test('validateStartupConfig: production env, ADMIN_PASSWORD whitespace-only counts as missing', () => {
  const env = { ...FULL_PROD_ENV, ADMIN_PASSWORD: '    ' };
  const result = validateStartupConfig({ env, adminCount: 0 });
  assert.equal(result.ok, false);
});

test('validateStartupConfig: collects multiple errors at once', () => {
  const env = { NODE_ENV: 'production' };
  const result = validateStartupConfig({ env, adminCount: 0 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= REQUIRED_PRODUCTION_ENV_VARS.length + 1);
});

test('assertStartupConfig: throws StartupConfigError with all reasons in production when invalid', () => {
  const env = { NODE_ENV: 'production' };
  assert.throws(
    () => assertStartupConfig({ env, adminCount: 0 }),
    (err) => {
      assert.ok(err instanceof StartupConfigError);
      assert.ok(err.errors.length > 0);
      assert.ok(/production/i.test(err.message));
      return true;
    }
  );
});

test('assertStartupConfig: does not throw when config is valid', () => {
  assert.doesNotThrow(() => assertStartupConfig({ env: FULL_PROD_ENV, adminCount: 1 }));
});

test('assertStartupConfig: does not throw outside production regardless of missing config', () => {
  assert.doesNotThrow(() => assertStartupConfig({ env: { NODE_ENV: 'development' }, adminCount: 0 }));
});
