const crypto = require('crypto');

const KEY_NAME = 'CREDENTIAL_ENCRYPTION_KEY';

function getEncryptionKey() {
  const configured = process.env[KEY_NAME];
  if (!configured) {
    throw new Error(`${KEY_NAME} must contain a 32-byte base64 or 64-character hex key`);
  }

  const key = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');

  if (key.length !== 32) {
    throw new Error(`${KEY_NAME} must contain a 32-byte base64 or 64-character hex key`);
  }
  return key;
}

function encryptText(plaintext) {
  if (typeof plaintext !== 'string') throw new TypeError('plaintext must be a string');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptText(payload) {
  try {
    const [version, ivEncoded, tagEncoded, ciphertextEncoded] = String(payload).split('.');
    if (version !== 'v1' || !ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error('invalid payload');

    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivEncoded, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error(`Unable to decrypt stored value: ${error.message}`);
  }
}

module.exports = { decryptText, encryptText, getEncryptionKey };
