#!/usr/bin/env node
/**
 * crawler-POD MCP server
 * ======================
 *
 * Exposes this project's operations as MCP tools so an MCP client (Claude Code,
 * or any other) can inspect and drive the system directly.
 *
 * TRANSPORT: stdio. The client launches this process and talks to it over the
 * pipe, so nothing is bound to a network port and nothing outside this machine
 * can reach it. Driving this from a REMOTE machine needs a different transport
 * (streamable HTTP) plus authentication — see mcp/README.md.
 *
 * DELIBERATE LIMITS
 *   - db_query accepts read-only statements only (SELECT / WITH …). Writes,
 *     DDL and multi-statement input are refused, so a mis-generated query
 *     cannot damage the database.
 *   - There is no generic "run any shell command" tool. Server lifecycle is a
 *     narrow start/stop/status tool instead; an arbitrary exec endpoint is the
 *     one thing that turns a convenience server into a remote shell, and it
 *     adds nothing a local terminal does not already give you.
 *   - No tool starts a crawl, so no tool can reach a paid provider.
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(PROJECT_ROOT, 'logs', 'server.log');
const PID_FILE = path.join(PROJECT_ROOT, 'logs', 'server.pid');

/** src/database is CommonJS and opens the pool on first require — load it lazily
 *  so a tool that never touches the database does not force a connection. */
let dbPromise = null;
function db() {
  // Memoise the PROMISE, not the module: tool calls arrive concurrently, and
  // memoising only the module lets a second call start querying while the
  // first is still creating the schema and seeding platforms — which returned
  // empty tables in testing.
  if (!dbPromise) {
    dbPromise = (async () => {
      const loaded = require(path.join(PROJECT_ROOT, 'src', 'database'));
      await loaded.initDatabase();
      return loaded;
    })();
  }
  return dbPromise;
}

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// ==================== Tool definitions ====================

const TOOLS = [
  {
    name: 'health',
    description:
      'Overall health of crawler-POD: PostgreSQL size and row counts, whether the HTTP server is responding, and the scheduler snapshot it reports.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'number', description: 'Port the app listens on (default 3000).' } },
    },
  },
  {
    name: 'db_tables',
    description: 'Every table in PostgreSQL with its current row count.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'db_query',
    description:
      'Run a READ-ONLY SQL query against PostgreSQL and return the rows. Only a single SELECT or WITH statement is accepted; writes and DDL are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT or WITH statement.' },
        limit: { type: 'number', description: 'Maximum rows to return (default 100, max 1000).' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'runs_list',
    description: 'Recent crawl runs, newest first, optionally filtered by status or platform.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many runs to return (default 20).' },
        status: { type: 'string', description: 'Filter by status: queued, running, done, failed, stuck.' },
        platform: { type: 'string', description: 'Filter by platform, e.g. etsy, ebay, reddit.' },
      },
    },
  },
  {
    name: 'run_get',
    description: 'One run in full, including the items it collected.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'number', description: 'The run id.' },
        includeItems: { type: 'boolean', description: 'Include collected items (default true).' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'schedules_list',
    description: 'Marketplace capture schedules with their next/last run times and latest summary.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'server_control',
    description:
      'Start, stop or check the crawler-POD HTTP server on this machine. Start runs `node server.js` detached, writing stdout/stderr to logs/server.log.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop'], description: 'What to do.' },
        port: { type: 'number', description: 'Port for start/status (default 3000).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'logs_tail',
    description: 'Last lines of the server log written by server_control start.',
    inputSchema: {
      type: 'object',
      properties: { lines: { type: 'number', description: 'How many lines (default 50, max 500).' } },
    },
  },
];

// ==================== Tool implementations ====================

/** Single read-only statement, no writes, no stacking. */
function assertReadOnlySql(sql) {
  const stripped = String(sql)
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');

  if (!/^\s*(select|with)\b/i.test(stripped)) {
    throw new Error('db_query accepts only SELECT or WITH statements.');
  }
  if (stripped.includes(';')) {
    throw new Error('db_query accepts a single statement; remove the extra ";".');
  }
  const forbidden = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|do)\b/i;
  if (forbidden.test(stripped)) {
    throw new Error('db_query refused: the statement contains a write or DDL keyword.');
  }
  return stripped;
}

async function httpJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, status: response.status, body: await response.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

const handlers = {
  async health({ port = 3000 }) {
    const database = await db();
    const dbHealth = await database.getDatabaseHealth();
    const scheduler = await httpJson(`http://127.0.0.1:${port}/api/scheduler/status`);
    return text({
      database: dbHealth,
      httpServer: scheduler.ok
        ? { reachable: true, port }
        : { reachable: false, port, detail: scheduler.error || `HTTP ${scheduler.status}` },
      scheduler: scheduler.ok ? scheduler.body : null,
    });
  },

  async db_tables() {
    const database = await db();
    const connection = database._connection;
    const tables = await connection
      .prepare(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
         ORDER BY table_name`
      )
      .all();

    const rows = [];
    let total = 0;
    for (const t of tables) {
      const { count } = await connection.prepare(`SELECT COUNT(*) AS count FROM "${t.table_name}"`).get();
      const n = Number(count);
      total += n;
      rows.push({ table: t.table_name, rows: n });
    }
    return text({ tables: rows, totalTables: rows.length, totalRows: total });
  },

  async db_query({ sql, limit = 100 }) {
    const safeSql = assertReadOnlySql(sql);
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const database = await db();
    const rows = await database._connection.prepare(`SELECT * FROM (${safeSql}) AS q LIMIT ${cap}`).all();
    return text({ rowCount: rows.length, cappedAt: cap, rows });
  },

  async runs_list({ limit = 20, status = null, platform = null }) {
    const database = await db();
    const cap = Math.min(Math.max(Number(limit) || 20, 1), 200);
    let runs = status ? await database.getRunsByStatus(status) : await database.getAllRuns(cap * 3);
    if (platform) runs = runs.filter((r) => r.platform === platform);
    return text(
      runs.slice(0, cap).map((r) => ({
        id: r.id,
        platform: r.platform,
        query: r.query,
        status: r.status,
        items: r.items_count,
        backend: r.active_backend,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        error: r.error_message,
      }))
    );
  },

  async run_get({ runId, includeItems = true }) {
    const database = await db();
    const run = await database.getRunById(Number(runId));
    if (!run) return failure(`Run ${runId} not found.`);
    const items = includeItems ? await database.getRunItems(Number(runId)) : undefined;
    return text({ run, itemCount: items ? items.length : undefined, items });
  },

  async schedules_list() {
    const database = await db();
    return text(await database.getMarketplaceCaptureSchedules());
  },

  async server_control({ action, port = 3000 }) {
    if (action === 'status') {
      const probe = await httpJson(`http://127.0.0.1:${port}/api/platforms`);
      const pid = fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, 'utf8').trim() : null;
      return text({
        running: probe.ok,
        port,
        pid,
        detail: probe.ok ? 'responding' : probe.error || `HTTP ${probe.status}`,
      });
    }

    if (action === 'start') {
      const already = await httpJson(`http://127.0.0.1:${port}/api/platforms`);
      if (already.ok) return text({ started: false, reason: 'already running', port });

      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      const out = fs.openSync(LOG_FILE, 'a');
      const child = spawn(process.execPath, ['server.js'], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, PORT: String(port) },
        detached: true,
        stdio: ['ignore', out, out],
      });
      child.unref();
      fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');

      // Give it a moment, then report whether it actually came up.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const probe = await httpJson(`http://127.0.0.1:${port}/api/platforms`);
      return text({ started: true, pid: child.pid, port, reachable: probe.ok, log: LOG_FILE });
    }

    if (action === 'stop') {
      if (!fs.existsSync(PID_FILE)) return failure('No pid file — this tool only stops a server it started.');
      const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      try {
        process.kill(pid);
        fs.unlinkSync(PID_FILE);
        return text({ stopped: true, pid });
      } catch (err) {
        return failure(`Could not stop pid ${pid}: ${err.message}`);
      }
    }

    return failure(`Unknown action "${action}".`);
  },

  async logs_tail({ lines = 50 }) {
    if (!fs.existsSync(LOG_FILE)) return failure(`No log file at ${LOG_FILE} yet.`);
    const cap = Math.min(Math.max(Number(lines) || 50, 1), 500);
    const all = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    return text(all.slice(-cap).join('\n'));
  },
};

// ==================== Wire-up ====================

const server = new Server({ name: 'crawler-pod', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = handlers[request.params.name];
  if (!handler) return failure(`Unknown tool: ${request.params.name}`);
  try {
    return await handler(request.params.arguments || {});
  } catch (err) {
    return failure(`${request.params.name} failed: ${err.message}`);
  }
});

await server.connect(new StdioServerTransport());
// stdout is the MCP channel — diagnostics must go to stderr.
console.error('[crawler-pod-mcp] ready on stdio');
