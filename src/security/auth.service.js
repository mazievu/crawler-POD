'use strict';

const crypto = require('node:crypto');

const DEFAULT_SESSION_TTL_DAYS = 7;
const DEFAULT_KEY_EXPIRY_DAYS = 30;

/**
 * Hash password using standard scrypt KDF with random salt.
 * Format: scrypt:<saltHex>:<hashHex>
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Password must be a non-empty string');
  }
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

/**
 * Verify password against stored hash using constant-time comparison.
 * Supports scrypt format and optional bcrypt ($2a$/$2b$) autodetection.
 */
function verifyPassword(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== 'string') return false;

  // Format 1: scrypt:<salt>:<hash>
  if (storedHash.startsWith('scrypt:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const [, salt, originalHash] = parts;
    try {
      const testHash = crypto.scryptSync(password, salt, 32).toString('hex');
      const bufTest = Buffer.from(testHash, 'hex');
      const bufOrig = Buffer.from(originalHash, 'hex');
      if (bufTest.length !== bufOrig.length) return false;
      return crypto.timingSafeEqual(bufTest, bufOrig);
    } catch {
      return false;
    }
  }

  // Format 2: bcrypt format fallback ($2a$, $2b$, $2y$)
  if (/^\$2[aby]\$\d{2}\$/.test(storedHash)) {
    try {
      const bcrypt = require('bcryptjs');
      return bcrypt.compareSync(password, storedHash);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Hash API key using SHA-256 for secure database storage.
 */
function hashApiKey(rawKey) {
  if (typeof rawKey !== 'string' || !rawKey) return '';
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Generate raw API key with recognized prefix.
 */
function generateRawApiKey(prefix = 'cp_live_') {
  const randomPart = crypto.randomBytes(24).toString('hex');
  return `${prefix}${randomPart}`;
}

/**
 * Generate high-entropy session token.
 */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * AuthService Class providing User, Session, and API Key management.
 */
class AuthService {
  constructor(database) {
    this.db = database || require('../database');
  }

  // --- User Queries ---

  async getUserByEmail(email) {
    if (!email || typeof email !== 'string') return null;
    if (typeof this.db.findUserByEmail === 'function') {
      return await this.db.findUserByEmail(email);
    }
    if (typeof this.db.getUserByEmail === 'function') {
      return await this.db.getUserByEmail(email);
    }
    return null;
  }

  async getUserById(id) {
    if (!id) return null;
    if (typeof this.db.findUserById === 'function') {
      return await this.db.findUserById(id);
    }
    if (typeof this.db.getUserById === 'function') {
      return await this.db.getUserById(id);
    }
    return null;
  }

  // --- Password & Authentication ---

  async authenticateCredentials(email, password, context = {}) {
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string' || !password.trim()) {
      return null;
    }
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.getUserByEmail(normalizedEmail);

    if (!user) {
      // Execute dummy verify to protect against response timing side channels
      verifyPassword(password, 'scrypt:0000000000000000:00000000000000000000000000000000');
      return null;
    }

    if (user.status && user.status !== 'active') {
      return null;
    }

    const hashToVerify = user.password_hash || user.passwordHash;
    const isMatch = verifyPassword(password, hashToVerify);
    if (!isMatch) return null;

    const session = await this.createSession(user.id, context);
    return {
      user: { id: user.id, email: user.email, role: user.role },
      sessionToken: session.sessionToken,
      session,
    };
  }

  // --- Sessions ---

  async createSession(userId, options = {}) {
    const sessionToken = generateSessionToken();
    const ttlDays = options.ttlDays || DEFAULT_SESSION_TTL_DAYS;
    const durationMs = options.durationMs || ttlDays * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + durationMs).toISOString();

    const created = await this.db.createSession({
      userId,
      sessionToken,
      expiresAt,
      ipAddress: options.ip || options.ipAddress || null,
      userAgent: options.userAgent || null,
    });

    return {
      id: created.id,
      userId,
      sessionToken,
      expiresAt,
    };
  }

  async validateSession(sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') return null;
    const token = sessionToken.trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) return null;

    const row = typeof this.db.findSessionByToken === 'function'
      ? await this.db.findSessionByToken(token)
      : (typeof this.db.getSession === 'function' ? await this.db.getSession(token) : null);

    if (!row) return null;

    const expiresAt = row.expires_at || row.expiresAt;
    if (expiresAt && new Date() > new Date(expiresAt)) {
      if (typeof this.db.deleteSession === 'function') {
        await this.db.deleteSession(token);
      }
      return null;
    }

    if (row.user_status && row.user_status !== 'active') {
      return null;
    }

    // Touch session asynchronously
    if (typeof this.db.touchSession === 'function') {
      this.db.touchSession(token).catch(() => {});
    }

    return {
      user: {
        id: row.user_id !== undefined ? row.user_id : row.userId,
        email: row.email,
        role: row.role,
      },
      session: {
        id: row.session_id || row.id,
        sessionToken: row.session_token || row.sessionToken || token,
        expiresAt,
      },
    };
  }

  async revokeSession(sessionToken) {
    if (!sessionToken) return false;
    if (typeof this.db.deleteSession === 'function') {
      const res = await this.db.deleteSession(sessionToken);
      return res ? (res.changes !== undefined ? res.changes > 0 : true) : true;
    }
    return false;
  }

  async revokeAllUserSessions(userId) {
    if (!userId) return false;
    if (typeof this.db.deleteSessionsByUserId === 'function') {
      const res = await this.db.deleteSessionsByUserId(userId);
      return res ? res.changes > 0 : true;
    }
    return false;
  }

  async purgeExpiredSessions() {
    if (typeof this.db.cleanExpiredSessions === 'function') {
      return await this.db.cleanExpiredSessions();
    }
    return 0;
  }

  // --- API Keys ---

  async generateApiKey({ userId, name, role = 'member', prefix = 'cp_live_', expiresInDays = DEFAULT_KEY_EXPIRY_DAYS }) {
    return await this.createApiKey({ userId, name, role, prefix, expiresInDays });
  }

  async createApiKey({ userId, name, role = 'member', prefix = 'cp_live_', expiresInDays = DEFAULT_KEY_EXPIRY_DAYS }) {
    const validPrefixes = ['cp_live_', 'cp_adm_'];
    let chosenPrefix = prefix;
    if (!validPrefixes.includes(chosenPrefix)) {
      chosenPrefix = role === 'admin' ? 'cp_adm_' : 'cp_live_';
    }

    const cleanRole = role && role.toLowerCase() === 'admin' ? 'admin' : 'member';
    const rawKey = generateRawApiKey(chosenPrefix);
    const keyHash = hashApiKey(rawKey);
    const expiresAt = expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null;

    const record = await this.db.createApiKey({
      userId: userId || null,
      name: name || 'API Key',
      keyHash,
      prefix: chosenPrefix,
      role: cleanRole,
      expiresAt,
    });

    return {
      rawKey,
      record: {
        id: record.id,
        name: record.name,
        role: record.role,
        prefix: record.prefix,
        expiresAt: record.expires_at || record.expiresAt,
        expires_at: record.expires_at || record.expiresAt,
      },
    };
  }

  async validateApiKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return null;
    const trimmed = rawKey.trim();
    if (!trimmed.startsWith('cp_live_') && !trimmed.startsWith('cp_adm_')) {
      return null;
    }

    const candidateHash = hashApiKey(trimmed);
    const record = typeof this.db.findApiKeyByHash === 'function'
      ? await this.db.findApiKeyByHash(candidateHash)
      : (typeof this.db.getApiKey === 'function' ? await this.db.getApiKey(trimmed) : null);

    if (!record) return null;

    // Constant-time check if key_hash exists on record
    if (record.key_hash) {
      try {
        const bufCandidate = Buffer.from(candidateHash, 'hex');
        const bufStored = Buffer.from(record.key_hash, 'hex');
        if (bufCandidate.length !== bufStored.length || !crypto.timingSafeEqual(bufCandidate, bufStored)) {
          return null;
        }
      } catch {
        return null;
      }
    }

    if (record.is_revoked || record.isRevoked) {
      return null;
    }

    const expiresAt = record.expires_at || record.expiresAt;
    if (expiresAt && new Date() > new Date(expiresAt)) {
      return null;
    }

    if (record.user_status && record.user_status !== 'active') {
      return null;
    }

    return {
      user: {
        id: record.user_id !== undefined ? record.user_id : record.userId,
        email: record.user_email || record.email || null,
        role: record.role || 'member',
      },
      apiKey: record,
    };
  }

  async revokeApiKey(id) {
    if (!id) return false;
    if (typeof this.db.revokeApiKey === 'function') {
      return await this.db.revokeApiKey(Number(id));
    }
    return false;
  }

  async listApiKeys() {
    if (typeof this.db.listApiKeys === 'function') {
      return await this.db.listApiKeys();
    }
    return [];
  }

  // --- Bootstrap ---

  async bootstrapSuperAdmin({ email, password }) {
    if (!email || !password || (typeof password === 'string' && !password.trim())) {
      return { success: false, reason: 'MISSING_CREDENTIALS' };
    }
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await this.getUserByEmail(normalizedEmail);
    if (existing) {
      return {
        success: true,
        created: false,
        alreadyExists: true,
        user: { id: existing.id, email: existing.email, role: existing.role },
      };
    }

    const passwordHash = hashPassword(password);
    const newUser = await this.db.createUser({
      email: normalizedEmail,
      passwordHash,
      role: 'admin',
      status: 'active',
    });

    return {
      success: true,
      created: true,
      alreadyExists: false,
      user: { id: newUser.id, email: newUser.email, role: newUser.role },
    };
  }
}

let defaultAuthService = null;

function getAuthService(database) {
  if (database) return new AuthService(database);
  if (!defaultAuthService) {
    defaultAuthService = new AuthService();
  }
  return defaultAuthService;
}

function createAuthService(database) {
  return new AuthService(database);
}

module.exports = {
  AuthService,
  getAuthService,
  createAuthService,
  hashPassword,
  verifyPassword,
  hashApiKey,
  generateRawApiKey,
  generateSessionToken,
};
