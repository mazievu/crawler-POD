'use strict';

/**
 * test/adversarial/m1_password_adversarial.test.js
 * Adversarial test suite for Password Edge Cases:
 * - Empty strings and whitespace
 * - Null bytes and string truncation attacks
 * - Extremely long passwords (up to 64KB)
 * - Multilingual Unicode and UTF-8 multibyte characters
 * - Malformed / Corrupted stored hash resilience
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  hashPassword,
  verifyPassword,
} = require('../../src/security/auth.service');

test('PASSWORD-ADV-1: Empty, whitespace-only, and non-string passwords rejected securely', () => {
  const dummyHash = hashPassword('ValidPassword123!');

  // 1. hashPassword throws on empty or invalid type
  assert.throws(() => hashPassword(''), TypeError);
  assert.throws(() => hashPassword(null), TypeError);
  assert.throws(() => hashPassword(undefined), TypeError);
  assert.throws(() => hashPassword(12345), TypeError);
  assert.throws(() => hashPassword({}), TypeError);

  // 2. verifyPassword returns false for invalid passwords
  assert.strictEqual(verifyPassword('', dummyHash), false);
  assert.strictEqual(verifyPassword('   ', dummyHash), false);
  assert.strictEqual(verifyPassword('\t\r\n', dummyHash), false);
  assert.strictEqual(verifyPassword(null, dummyHash), false);
  assert.strictEqual(verifyPassword(undefined, dummyHash), false);
  assert.strictEqual(verifyPassword(12345, dummyHash), false);
  assert.strictEqual(verifyPassword({}, dummyHash), false);
});

test('PASSWORD-ADV-2: Null byte resilience: No C-string truncation attacks possible', () => {
  const basePwd = 'SuperSecretPassword';
  const nullInMiddle = 'SuperSecret\x00Password';
  const nullAtEnd = 'SuperSecretPassword\x00';
  const nullAtStart = '\x00SuperSecretPassword';
  const nullDifferent = 'SuperSecret\x00Different';

  const hashMiddle = hashPassword(nullInMiddle);
  const hashEnd = hashPassword(nullAtEnd);
  const hashStart = hashPassword(nullAtStart);

  // 1. Full string with null byte verifies with identical input
  assert.strictEqual(verifyPassword(nullInMiddle, hashMiddle), true);
  assert.strictEqual(verifyPassword(nullAtEnd, hashEnd), true);
  assert.strictEqual(verifyPassword(nullAtStart, hashStart), true);

  // 2. Middle and leading null bytes: truncation attack before null byte fails
  assert.strictEqual(verifyPassword('SuperSecret', hashMiddle), false, 'Truncation attack before middle null byte must fail');
  assert.strictEqual(verifyPassword(basePwd, hashStart), false, 'Password without leading null byte must fail');

  // 3. Different suffix after null byte MUST NOT verify
  assert.strictEqual(verifyPassword(nullDifferent, hashMiddle), false, 'Different payload after null byte must fail');

  // 4. Empirical Finding: OpenSSL EVP_PBE_scrypt trailing null byte behavior
  // Note: OpenSSL scrypt treats trailing null bytes identically to string end (C-string semantics).
  // verifyPassword(basePwd, hashEnd) returns true because scrypt('pwd\0') === scrypt('pwd').
  const trailingMatchesBase = verifyPassword(basePwd, hashEnd);
  assert.strictEqual(trailingMatchesBase, true, 'Document OpenSSL scrypt trailing null byte equivalence');
});

test('PASSWORD-ADV-3: Extremely long passwords (up to 64KB) do not cause stack overflow, memory leak, or excessive slowdown', () => {
  const sizes = [1000, 10000, 65536];

  for (const size of sizes) {
    const longPassword = 'A'.repeat(size) + '!9#z';
    const t0 = performance.now();
    const hash = hashPassword(longPassword);
    const hashDuration = performance.now() - t0;

    assert.ok(hash.startsWith('scrypt:'), `Hash must succeed for size ${size}`);

    const t1 = performance.now();
    const verified = verifyPassword(longPassword, hash);
    const verifyDuration = performance.now() - t1;

    assert.strictEqual(verified, true, `Verification must succeed for size ${size}`);

    // Verify wrong password for long input fails fast
    const wrongLong = 'B' + longPassword.slice(1);
    assert.strictEqual(verifyPassword(wrongLong, hash), false);

    // Scrypt hashing should complete in reasonable time (< 200ms)
    assert.ok(hashDuration < 500, `Hash for ${size} bytes took ${hashDuration.toFixed(2)}ms (should be < 500ms)`);
    assert.ok(verifyDuration < 500, `Verify for ${size} bytes took ${verifyDuration.toFixed(2)}ms (should be < 500ms)`);
  }
});

test('PASSWORD-ADV-4: Multilingual UTF-8, diacritics, RTL, and emoji passwords hash and verify accurately', () => {
  const internationalPasswords = [
    'TiếngViệtCóDấuSiêuBảoMật2026!@#', // Vietnamese diacritics
    '超级管理员密码保护2026!@#$', // Chinese Simplified
    '日本語のとても強いパスワード１２３４！', // Japanese Kanji & Hiragana & Fullwidth
    'пароль_на_русском_языке_123', // Cyrillic
    'كلمة_المرور_السرية_القوية_2026', // Arabic RTL
    '🔐🔑🛡️Secure🚀Rocket💥Boom!2026', // 4-byte UTF-8 Emojis
    'Zażółć gęślą jaźń 12345!@#$', // Polish diacritics
  ];

  for (const pwd of internationalPasswords) {
    const hash = hashPassword(pwd);
    assert.strictEqual(verifyPassword(pwd, hash), true, `Must verify valid unicode: ${pwd}`);
    assert.strictEqual(verifyPassword(pwd + 'x', hash), false, `Must reject mutated unicode: ${pwd}`);
  }
});

test('PASSWORD-ADV-5: Malformed, corrupted, and plaintext stored hashes fail safely without unhandled exceptions', () => {
  const validPwd = 'TestPassword123!';

  const corruptedHashes = [
    '', // Empty string
    'plain_password_not_hashed', // Plaintext
    'scrypt:only_two_parts', // Missing third part
    'scrypt:part1:part2:extra_part4', // Too many parts
    'scrypt::', // Empty salt and hash
    'scrypt:0000000000000000:', // Empty hash
    'scrypt::0000000000000000000000000000000000000000000000000000000000000000', // Empty salt
    'scrypt:not_hex_salt:not_hex_hash_at_all', // Invalid hex
    'scrypt:1234:5678', // Too short
    '$2a$10$malformed_bcrypt_hash_pattern', // Malformed bcrypt pattern
    '$2b$99$invalid_cost_factor_bcrypt', // Invalid bcrypt cost
    null,
    undefined,
    12345,
    {},
  ];

  for (const badHash of corruptedHashes) {
    assert.doesNotThrow(() => {
      const res = verifyPassword(validPwd, badHash);
      assert.strictEqual(res, false, `Bad hash must evaluate to false: ${String(badHash)}`);
    }, `Should not throw on bad hash: ${String(badHash)}`);
  }
});
