'use strict';

/**
 * mcp-bridge — loopback-only, read-only SQL passthrough to the app's live
 * database connection.
 *
 * WHY THIS EXISTS
 * PGlite (PG_MODE=pglite) is single-process: only one Node process may open
 * `PGLITE_DIR` at a time. The app server (server.js) already holds it once
 * running. An MCP process that also did `require('./src/database')` (or
 * otherwise opened the same PGlite directory) would be a SECOND opener on the
 * same on-disk files — two independent PostgreSQL-in-WASM instances writing
 * the same pages, which risks corrupting the database.
 *
 * So when PG_MODE=pglite, an MCP process must never open the data directory
 * itself. Instead it sends its read-only query to this endpoint, which runs
 * inside the app process and therefore shares the app's single connection.
 * Both `mcp/crawler-pod-server.mjs` (stdio) and `src/mcp/db.js` (the
 * standalone read-only data server) use it for exactly that case; when
 * PG_MODE points at a real PostgreSQL server instead, both connect directly,
 * because a real server accepts many concurrent connections safely.
 *
 * SECURITY
 *   - Loopback only: any request whose raw socket address is not
 *     127.0.0.1 / ::1 is refused before the body is even inspected. This is
 *     deliberately checked against `req.socket.remoteAddress`, not `req.ip`
 *     or an X-Forwarded-For header — this app sets no `trust proxy`, so the
 *     socket address is the one value a client cannot spoof.
 *   - Read-only: `assertReadOnlySql` (exported below) is the SAME validator
 *     mcp/crawler-pod-server.mjs's db_query tool already applies — a single
 *     SELECT/WITH statement only, no writes, no DDL, no statement stacking.
 *     There is deliberately only one copy of this logic; every read-only SQL
 *     entry point in this codebase imports it from here rather than
 *     re-implementing it.
 */

const express = require('express');

/** Normalizes an IPv4-mapped-IPv6 address ("::ffff:127.0.0.1") before compare. */
function isLoopbackAddress(address) {
  if (!address || typeof address !== 'string') return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

/**
 * Single read-only statement, no writes, no stacking. Shared verbatim with
 * mcp/crawler-pod-server.mjs's db_query tool — see the module doc above.
 */
function assertReadOnlySql(sql) {
  const stripped = String(sql)
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');

  if (!/^\s*(select|with)\b/i.test(stripped)) {
    throw new Error('mcp-bridge: only a single SELECT or WITH statement is accepted.');
  }
  if (stripped.includes(';')) {
    throw new Error('mcp-bridge: only a single statement is accepted; remove the extra ";".');
  }
  const forbidden = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|do)\b/i;
  if (forbidden.test(stripped)) {
    throw new Error('mcp-bridge: refused — the statement contains a write or DDL keyword.');
  }
  const forbiddenFuncs = /\b(setval|nextval|lo_import|lo_export|lo_unlink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_sleep)\s*\(/i;
  if (forbiddenFuncs.test(stripped)) {
    throw new Error('mcp-bridge: refused — the statement invokes a restricted system/write function.');
  }
  return stripped;
}

/** Path this router mounts its one endpoint on. Callers (mcp/*.mjs, src/mcp/db.js)
 *  import this constant instead of hard-coding the string a second time. */
const QUERY_PATH = '/api/internal/mcp-bridge/query';

/**
 * @param {Object} deps
 * @param {Object} deps.database - the already-initialized `./src/database`
 *   module (or any object exposing `_connection.prepare(sql).all(...)`,
 *   which is how every test in this repo stubs it). The router never
 *   requires or initializes a database connection itself — it only ever
 *   uses whatever connection the host app already opened, which is the
 *   entire point: no second opener of PGLITE_DIR.
 */
function createMcpBridgeRouter({ database }) {
  if (!database) throw new Error('createMcpBridgeRouter requires { database }');

  const router = express.Router();

  // Both guards are attached to the ONE endpoint below, never as router-level
  // middleware. This router is mounted with app.use(router) at the app root, so
  // a router.use() guard runs for EVERY request the app receives - which is how
  // an earlier version of this file answered 403 to the browser UI's own
  // /api/* calls and emptied the page.
  function guardBridgeRequest(req, res, next) {
    if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'mcp-bridge: loopback requests only' });
    }
    // A loopback check ALONE does not make this endpoint safe. server.js mounts
    // cors() with its permissive default, so a page on any website the user
    // happens to visit can POST here from their browser and the socket address
    // is still 127.0.0.1. Browsers are required to attach Origin / Sec-Fetch-*
    // to such a request. Note: Node.js 22 (undici) fetch automatically sends
    // `sec-fetch-mode: cors` by default with `user-agent: node`, but never
    // sends `origin` or `sec-fetch-site`.
    const isBrowser = Boolean(
      req.headers.origin ||
      req.headers['sec-fetch-site'] ||
      (req.headers['sec-fetch-mode'] && req.headers['user-agent'] && !req.headers['user-agent'].includes('node'))
    );
    if (isBrowser) {
      return res.status(403).json({ error: 'mcp-bridge: browser-originated requests are refused' });
    }
    next();
  }

  router.post(QUERY_PATH, guardBridgeRequest, async (req, res) => {
    const body = req.body || {};
    const { sql, params } = body;
    if (typeof sql !== 'string' || !sql.trim()) {
      return res.status(400).json({ error: 'mcp-bridge: "sql" (string) is required' });
    }

    let safeSql;
    try {
      safeSql = assertReadOnlySql(sql);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // `params` is the ordered bind-argument list for Statement.all(...args):
    // an array of scalars for `?`-style SQL, or a single-element array
    // holding one object for `@name`-style SQL — exactly the shapes
    // pg-client.js's Statement.bind() already accepts, so callers can
    // pre-translate with pg-client's own translateDialect/translateParams
    // (as src/mcp/db.js does) and send the result straight through.
    const bindArgs = Array.isArray(params) ? params : [];

    try {
      const rows = await database._connection.prepare(safeSql).all(...bindArgs);
      res.json({ rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createMcpBridgeRouter, assertReadOnlySql, isLoopbackAddress, QUERY_PATH };
