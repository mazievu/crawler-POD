'use strict';

const express = require('express');
const { parseCookies } = require('./auth.middleware');

/**
 * Creates Express Router mounting all authentication and API key management
 * routes. Super Admin bootstrap is intentionally NOT an HTTP route — it
 * happens at server boot from ADMIN_EMAIL/ADMIN_PASSWORD (see
 * bootstrapDatabase() in server.js) or via `npm run bootstrap:admin`
 * (scripts/bootstrap-admin.js), both of which refuse once an admin exists.
 */
function createAuthRouter(options = {}) {
  const router = express.Router();
  const authService = options.authService || require('./auth.service').getAuthService();
  const authMiddleware = options.authMiddleware || require('./auth.middleware').createAuthMiddleware(authService);
  const loginRateLimiter = options.loginRateLimiter || require('./rate-limit.middleware').createLoginRateLimiter();
  const { requireAuth, requireAdmin, csrfProtection } = authMiddleware;
  // Defensive fallback only — every real caller (server.js, and every test
  // that builds authMiddleware via createAuthMiddleware()) provides a real
  // csrfProtection function, since createAuthMiddleware() always returns one.
  const applyCsrf = typeof csrfProtection === 'function' ? csrfProtection : (req, res, next) => next();
  const isProd = process.env.NODE_ENV === 'production';

  // 1. User Login (Public, Throttled via Feature 9)
  router.post(['/login', '/api/auth/login'], loginRateLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};

      // Input validation (Boundary B1.3)
      if (!email || !password || (typeof password === 'string' && !password.trim())) {
        return res.status(400).json({ error: 'Bad Request', message: 'Email and password required' });
      }

      const result = await authService.authenticateCredentials(email, password, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      if (!result) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password' });
      }

      // Set HttpOnly, SameSite=Lax session cookie
      res.setHeader(
        'Set-Cookie',
        `crawler_session=${result.sessionToken}; Path=/; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`
      );

      res.status(200).json({
        message: 'Login successful',
        user: { id: result.user.id, email: result.user.email, role: result.user.role },
        sessionToken: result.sessionToken,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
  });


  // 3. User Logout (Authenticated)
  router.post(['/logout', '/api/auth/logout'], requireAuth, async (req, res) => {
    try {
      const cookies = req.cookies || parseCookies(req.headers.cookie);
      const token = cookies.crawler_session || req.headers['x-session-token'] || req.session?.sessionToken;
      if (token) {
        await authService.revokeSession(token);
      }
      res.setHeader(
        'Set-Cookie',
        'crawler_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax'
      );
      res.status(200).json({ message: 'Logged out successfully' });
    } catch (err) {
      res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
  });

  // 4. Current User Profile (Authenticated)
  router.get(['/me', '/api/auth/me'], requireAuth, (req, res) => {
    res.status(200).json({ user: req.user });
  });

  // 5. List API Keys (Admin-only)
  router.get(['/api-keys', '/api/auth/api-keys'], requireAuth, requireAdmin, async (req, res) => {
    try {
      const keys = await authService.listApiKeys();
      res.status(200).json({ apiKeys: keys });
    } catch (err) {
      res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
  });

  // 6. Generate API Key (Admin-only, CSRF-protected — state-changing)
  router.post(['/api-keys', '/api/auth/api-keys'], requireAuth, requireAdmin, applyCsrf, async (req, res) => {
    try {
      const { name, role = 'member', prefix = 'cp_live_', expiresInDays = 30 } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Bad Request', message: 'Key name is required' });
      }

      const result = await authService.generateApiKey({
        userId: req.user.id,
        name: name.trim(),
        role: role && role.toLowerCase() === 'admin' ? 'admin' : 'member',
        prefix,
        expiresInDays: parseInt(expiresInDays, 10) || 30,
      });

      res.status(201).json({
        message: 'API Key issued successfully',
        rawKey: result.rawKey,
        id: result.record.id,
        role: result.record.role,
        expiresAt: result.record.expires_at || result.record.expiresAt,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
  });

  // 7. Revoke API Key (Admin-only, CSRF-protected — state-changing)
  router.delete(['/api-keys/:id', '/api/auth/api-keys/:id'], requireAuth, requireAdmin, applyCsrf, async (req, res) => {
    try {
      const keyId = parseInt(req.params.id, 10);
      if (isNaN(keyId)) {
        return res.status(400).json({ error: 'Bad Request', message: 'Invalid key ID' });
      }

      const success = await authService.revokeApiKey(keyId);
      if (!success) {
        return res.status(404).json({ error: 'API key not found' });
      }

      res.status(200).json({ message: 'API key revoked' });
    } catch (err) {
      res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
