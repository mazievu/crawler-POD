'use strict';

/**
 * src/database/auth-ops.js — Database operations for Authentication & RBAC (Milestone M1)
 * Provides prepared statements and helper queries for users, user_sessions, and api_keys.
 */

function createAuthOps(db) {
  // ==================== Prepared Statements ====================

  const stmt = {
    // --- Users ---
    insertUser: db.prepare(`
      INSERT INTO users (email, password_hash, role, status, created_at, updated_at)
      VALUES (@email, @passwordHash, @role, @status, now(), now())
      ON CONFLICT (email) DO NOTHING
    `),
    findUserByEmail: db.prepare(`
      SELECT id, email, password_hash, role, status, created_at, updated_at
      FROM users
      WHERE lower(trim(email)) = lower(trim(?))
    `),
    findUserById: db.prepare(`
      SELECT id, email, password_hash, role, status, created_at, updated_at
      FROM users
      WHERE id = ?
    `),
    updateUserPassword: db.prepare(`
      UPDATE users
      SET password_hash = @passwordHash, updated_at = now()
      WHERE id = @id
    `),
    updateUserRole: db.prepare(`
      UPDATE users
      SET role = @role, updated_at = now()
      WHERE id = @id
    `),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    listUsers: db.prepare(`
      SELECT id, email, role, status, created_at, updated_at
      FROM users
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `),
    countUsers: db.prepare('SELECT COUNT(*) as total FROM users'),
    countAdmins: db.prepare("SELECT COUNT(*) as total FROM users WHERE role = 'admin'"),

    // --- User Sessions ---
    insertSession: db.prepare(`
      INSERT INTO user_sessions (user_id, session_token, expires_at, ip_address, user_agent, created_at)
      VALUES (@userId, @sessionToken, @expiresAt, @ipAddress, @userAgent, now())
    `),
    findSessionWithUser: db.prepare(`
      SELECT s.id AS session_id, s.user_id, s.session_token, s.expires_at, s.last_seen_at, s.created_at,
             u.id AS user_id, u.email, u.role, u.status AS user_status
      FROM user_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.session_token = ? AND s.expires_at > now()
    `),
    touchSession: db.prepare('UPDATE user_sessions SET last_seen_at = now() WHERE session_token = ?'),
    deleteSession: db.prepare('DELETE FROM user_sessions WHERE session_token = ?'),
    deleteSessionsByUserId: db.prepare('DELETE FROM user_sessions WHERE user_id = ?'),
    deleteExpiredSessions: db.prepare('DELETE FROM user_sessions WHERE expires_at <= now()'),

    // --- API Keys ---
    insertApiKey: db.prepare(`
      INSERT INTO api_keys (user_id, name, key_hash, prefix, role, expires_at, is_revoked, created_at)
      VALUES (@userId, @name, @keyHash, @prefix, @role, @expiresAt, FALSE, now())
    `),
    findApiKeyWithUser: db.prepare(`
      SELECT k.id, k.user_id, k.name, k.key_hash, k.prefix, k.role, k.expires_at, k.is_revoked, k.last_used_at, k.created_at,
             u.email AS user_email, u.role AS user_role, u.status AS user_status
      FROM api_keys k
      LEFT JOIN users u ON k.user_id = u.id
      WHERE k.key_hash = ? AND k.is_revoked = FALSE AND (k.expires_at IS NULL OR k.expires_at > now())
    `),
    touchApiKeyLastUsed: db.prepare('UPDATE api_keys SET last_used_at = now() WHERE id = ?'),
    revokeApiKey: db.prepare('UPDATE api_keys SET is_revoked = TRUE WHERE id = ? AND is_revoked = FALSE'),
    findApiKeyById: db.prepare(`
      SELECT id, user_id, name, prefix, role, expires_at, is_revoked, last_used_at, created_at
      FROM api_keys
      WHERE id = ?
    `),
    listApiKeys: db.prepare(`
      SELECT k.id, k.user_id, k.name, k.prefix, k.role, k.expires_at, k.is_revoked, k.last_used_at, k.created_at,
             u.email AS user_email
      FROM api_keys k
      LEFT JOIN users u ON k.user_id = u.id
      ORDER BY k.created_at DESC
      LIMIT ? OFFSET ?
    `),
    listApiKeysByUserId: db.prepare(`
      SELECT id, user_id, name, prefix, role, expires_at, is_revoked, last_used_at, created_at
      FROM api_keys
      WHERE user_id = ?
      ORDER BY created_at DESC
    `),
    deleteApiKey: db.prepare('DELETE FROM api_keys WHERE id = ?'),
  };

  // ==================== Helper Methods ====================

  async function createUser({ email, passwordHash, role = 'member', status = 'active' }) {
    if (!email || !passwordHash) {
      throw new Error('email and passwordHash are required to create a user');
    }
    const cleanEmail = email.trim().toLowerCase();
    const res = await stmt.insertUser.run({
      email: cleanEmail,
      passwordHash,
      role: role.toLowerCase() === 'admin' ? 'admin' : 'member',
      status,
    });

    if (res.lastInsertRowid) {
      return await stmt.findUserById.get(res.lastInsertRowid);
    }
    return await stmt.findUserByEmail.get(cleanEmail);
  }

  async function findUserByEmail(email) {
    if (!email || typeof email !== 'string') return null;
    return await stmt.findUserByEmail.get(email.trim().toLowerCase());
  }

  async function findUserById(id) {
    if (!id) return null;
    return await stmt.findUserById.get(Number(id));
  }

  async function updateUserPassword(id, passwordHash) {
    if (!id || !passwordHash) return false;
    const res = await stmt.updateUserPassword.run({ id: Number(id), passwordHash });
    return res.changes > 0;
  }

  async function updateUserRole(id, role) {
    if (!id || !role) return false;
    const res = await stmt.updateUserRole.run({
      id: Number(id),
      role: role.toLowerCase() === 'admin' ? 'admin' : 'member',
    });
    return res.changes > 0;
  }

  async function deleteUser(id) {
    if (!id) return false;
    const res = await stmt.deleteUser.run(Number(id));
    return res.changes > 0;
  }

  async function listUsers({ limit = 50, offset = 0 } = {}) {
    return await stmt.listUsers.all(Number(limit) || 50, Number(offset) || 0);
  }

  async function countUsers() {
    const row = await stmt.countUsers.get();
    return Number(row?.total || 0);
  }

  async function countAdmins() {
    const row = await stmt.countAdmins.get();
    return Number(row?.total || 0);
  }

  // --- Session Operations ---

  async function createSession({ userId, sessionToken, expiresAt, ipAddress = null, userAgent = null }) {
    if (!userId || !sessionToken || !expiresAt) {
      throw new Error('userId, sessionToken, and expiresAt are required to create a session');
    }
    const res = await stmt.insertSession.run({
      userId: Number(userId),
      sessionToken,
      expiresAt: typeof expiresAt === 'string' ? expiresAt : new Date(expiresAt).toISOString(),
      ipAddress,
      userAgent,
    });
    return {
      id: res.lastInsertRowid,
      userId: Number(userId),
      sessionToken,
      expiresAt,
    };
  }

  async function findSessionByToken(token) {
    if (!token || typeof token !== 'string') return null;
    return await stmt.findSessionWithUser.get(token.trim());
  }

  async function touchSession(token) {
    if (!token) return false;
    const res = await stmt.touchSession.run(token.trim());
    return res.changes > 0;
  }

  async function deleteSession(token) {
    if (!token) return { changes: 0 };
    return await stmt.deleteSession.run(token.trim());
  }

  async function deleteSessionsByUserId(userId) {
    if (!userId) return { changes: 0 };
    return await stmt.deleteSessionsByUserId.run(Number(userId));
  }

  async function cleanExpiredSessions() {
    const res = await stmt.deleteExpiredSessions.run();
    return res.changes;
  }

  // --- API Key Operations ---

  async function createApiKey({ userId, name, keyHash, prefix = 'cp_live_', role = 'member', expiresAt = null }) {
    if (!name || !keyHash) {
      throw new Error('name and keyHash are required to create an API key');
    }
    const cleanRole = role && role.toLowerCase() === 'admin' ? 'admin' : 'member';
    const expiresIso = expiresAt ? (typeof expiresAt === 'string' ? expiresAt : new Date(expiresAt).toISOString()) : null;

    const res = await stmt.insertApiKey.run({
      userId: userId ? Number(userId) : null,
      name: name.trim(),
      keyHash,
      prefix,
      role: cleanRole,
      expiresAt: expiresIso,
    });

    return await stmt.findApiKeyById.get(res.lastInsertRowid);
  }

  async function findApiKeyByHash(keyHash) {
    if (!keyHash || typeof keyHash !== 'string') return null;
    const record = await stmt.findApiKeyWithUser.get(keyHash.trim());
    if (record) {
      // Async touch last_used_at
      stmt.touchApiKeyLastUsed.run(record.id).catch(() => {});
    }
    return record;
  }

  async function revokeApiKey(id) {
    if (!id) return false;
    const res = await stmt.revokeApiKey.run(Number(id));
    return res.changes > 0;
  }

  async function findApiKeyById(id) {
    if (!id) return null;
    return await stmt.findApiKeyById.get(Number(id));
  }

  async function listApiKeys({ limit = 100, offset = 0 } = {}) {
    return await stmt.listApiKeys.all(Number(limit) || 100, Number(offset) || 0);
  }

  async function listApiKeysByUserId(userId) {
    if (!userId) return [];
    return await stmt.listApiKeysByUserId.all(Number(userId));
  }

  async function deleteApiKey(id) {
    if (!id) return false;
    const res = await stmt.deleteApiKey.run(Number(id));
    return res.changes > 0;
  }

  return {
    stmt,
    createUser,
    findUserByEmail,
    findUserById,
    updateUserPassword,
    updateUserRole,
    deleteUser,
    listUsers,
    countUsers,
    countAdmins,
    createSession,
    findSessionByToken,
    touchSession,
    deleteSession,
    deleteSessionsByUserId,
    cleanExpiredSessions,
    createApiKey,
    findApiKeyByHash,
    revokeApiKey,
    findApiKeyById,
    listApiKeys,
    listApiKeysByUserId,
    deleteApiKey,
  };
}

module.exports = { createAuthOps };
