'use strict';

/**
 * src/security/auth.middleware.js — Authentication & RBAC Middleware (Milestone M1)
 * Extracts credentials (cookies, Bearer token, x-api-key) and enforces access control.
 */

/**
 * Lightweight, zero-dependency cookie parser resilient to malformed/corrupted cookies.
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  const pairs = cookieHeader.split(';');
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i].trim();
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    if (eqIdx !== -1) {
      const key = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (key) cookies[key] = val;
    } else {
      cookies[pair] = '';
    }
  }
  return cookies;
}

/**
 * Helper to set session cookie on response.
 */
function setSessionCookie(res, sessionToken, options = {}) {
  const isProd = process.env.NODE_ENV === 'production' || options.secure;
  const maxAge = options.maxAgeSeconds || 7 * 24 * 60 * 60;
  const cookieVal = `crawler_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookieVal);
}

/**
 * Helper to clear session cookie on logout.
 */
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'crawler_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
}

/**
 * Factory creating auth middleware bound to an authService instance.
 * Accepts either authService directly or { authService }.
 */
function createAuthMiddleware(optionsOrService) {
  const authService = optionsOrService && typeof optionsOrService.validateApiKey === 'function'
    ? optionsOrService
    : (optionsOrService && optionsOrService.authService
        ? optionsOrService.authService
        : require('./auth.service').getAuthService());

  if (!authService) {
    throw new Error('createAuthMiddleware requires a valid authService instance');
  }

  /**
   * Main authentication barrier middleware:
   * 1. Check x-api-key first (if present, validate)
   * 2. Check Authorization header (Bearer <key|token>)
   * 3. Check Session Cookie (crawler_session) or x-session-token
   * 4. Return 401 if missing or invalid
   */
  async function requireAuth(req, res, next) {
    // Ensure cookies dictionary is initialized
    if (!req.cookies) {
      req.cookies = parseCookies(req.headers.cookie);
    }

    // 1. Check x-api-key header
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader !== undefined && apiKeyHeader !== null) {
      if (typeof apiKeyHeader !== 'string' || !apiKeyHeader.trim()) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Empty API key provided' });
      }

      const keyVal = apiKeyHeader.trim();
      if (!keyVal.startsWith('cp_live_') && !keyVal.startsWith('cp_adm_')) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Unrecognized API key prefix' });
      }

      const keyResult = await authService.validateApiKey(keyVal);
      if (!keyResult) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid, revoked, or expired API key' });
      }

      req.user = {
        id: keyResult.user.id,
        email: keyResult.user.email,
        role: keyResult.user.role,
        authMethod: 'api_key',
        apiKeyId: keyResult.apiKey.id,
      };
      req.authType = 'api_key';
      req.apiKey = keyResult.apiKey;
      return next();
    }

    // 2. Check Authorization header (e.g. Bearer <token>)
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Unsupported authorization scheme' });
      }

      const bearerToken = authHeader.slice(7).trim();
      if (!bearerToken) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Malformed Authorization header' });
      }

      // If bearerToken has API key prefix (cp_...)
      if (bearerToken.startsWith('cp_')) {
        if (!bearerToken.startsWith('cp_live_') && !bearerToken.startsWith('cp_adm_')) {
          return res.status(401).json({ error: 'Unauthorized', message: 'Unrecognized API key prefix' });
        }
        const keyResult = await authService.validateApiKey(bearerToken);
        if (!keyResult) {
          return res.status(401).json({ error: 'Unauthorized', message: 'Invalid, revoked, or expired API key' });
        }

        req.user = {
          id: keyResult.user.id,
          email: keyResult.user.email,
          role: keyResult.user.role,
          authMethod: 'api_key',
          apiKeyId: keyResult.apiKey.id,
        };
        req.authType = 'api_key';
        req.apiKey = keyResult.apiKey;
        return next();
      }

      // Otherwise treat bearerToken as a session token
      const sessionResult = await authService.validateSession(bearerToken);
      if (!sessionResult) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired session' });
      }

      req.user = {
        id: sessionResult.user.id,
        email: sessionResult.user.email,
        role: sessionResult.user.role,
        authMethod: 'session',
      };
      req.authType = 'session';
      req.session = sessionResult.session;
      return next();
    }

    // 3. Check Session Cookie or x-session-token header
    const sessionToken = req.cookies.crawler_session || req.headers['x-session-token'];
    if (sessionToken) {
      const sessionResult = await authService.validateSession(sessionToken);
      if (!sessionResult) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired session' });
      }

      req.user = {
        id: sessionResult.user.id,
        email: sessionResult.user.email,
        role: sessionResult.user.role,
        authMethod: 'session',
      };
      req.authType = 'session';
      req.session = sessionResult.session;
      return next();
    }

    // 4. No credentials provided
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }

  /**
   * Role authorization middleware:
   * Enforces requiredRole or admin. Case-sensitive matching.
   */
  function requireRole(requiredRole) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      }
      // Strict case-sensitive check; 'admin' satisfies any required role
      if (req.user.role !== requiredRole && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden', message: `Requires ${requiredRole} role permissions` });
      }
      next();
    };
  }

  const requireAdmin = requireRole('admin');

  /**
   * Optional authentication middleware:
   * Populates req.user if credentials are valid, but continues even if unauthenticated.
   */
  async function optionalAuth(req, res, next) {
    if (!req.cookies) {
      req.cookies = parseCookies(req.headers.cookie);
    }

    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader) {
      const keyResult = await authService.validateApiKey(apiKeyHeader.trim());
      if (keyResult) {
        req.user = {
          id: keyResult.user.id,
          email: keyResult.user.email,
          role: keyResult.user.role,
          authMethod: 'api_key',
          apiKeyId: keyResult.apiKey.id,
        };
        req.authType = 'api_key';
        return next();
      }
    }

    const sessionToken = req.cookies.crawler_session || req.headers['x-session-token'];
    if (sessionToken) {
      const sessionResult = await authService.validateSession(sessionToken);
      if (sessionResult) {
        req.user = {
          id: sessionResult.user.id,
          email: sessionResult.user.email,
          role: sessionResult.user.role,
          authMethod: 'session',
        };
        req.authType = 'session';
        req.session = sessionResult.session;
      }
    }

    next();
  }

  /**
   * CSRF protection middleware for state-changing requests using cookie session.
   */
  function csrfProtection(req, res, next) {
    const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    const isExcluded = [
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/bootstrap',
      '/livez',
      '/readyz',
    ].includes(req.path);

    if (isStateChanging && !isExcluded && req.authType === 'session') {
      const csrfHeader = req.headers['x-csrf-token'] || req.headers['x-requested-with'];
      if (!csrfHeader) {
        return res.status(403).json({
          error: 'CSRF Forbidden',
          message: 'Missing CSRF verification header (x-csrf-token or x-requested-with)',
        });
      }
    }
    next();
  }

  return {
    parseCookies,
    setSessionCookie,
    clearSessionCookie,
    requireAuth,
    requireRole,
    requireAdmin,
    optionalAuth,
    csrfProtection,
  };
}

module.exports = {
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createAuthMiddleware,
};
