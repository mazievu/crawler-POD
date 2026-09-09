#!/usr/bin/env node
/**
 * crawler-POD MCP server — Streamable HTTP transport (LAN)
 * ========================================================
 *
 *   another machine  ->  LAN  ->  this server (0.0.0.0:20130/mcp)
 *                              ->  crawler-POD API (127.0.0.1:20129)
 *                              ->  Scheduler -> crawler -> PostgreSQL
 *
 * Runs as its own process, completely independent of crawler-POD:
 *
 *   - It opens NO database connection. Every operation goes through the
 *     crawler's HTTP API, so runs are created and cancelled by the Scheduler,
 *     never by writing rows directly, and no scraper is called directly.
 *   - It therefore stays up while crawler-POD is stopped, which is what makes
 *     start_crawler / restart_crawler reachable from another machine at all.
 *
 * The stdio server (mcp/crawler-pod-server.mjs) is untouched and still works;
 * this is an additional transport, not a replacement.
 *
 * SECURITY. This listens on the LAN by design. Anything that can reach the port
 * can do everything these tools do, including starting and stopping the crawler.
 * Set MCP_HTTP_TOKEN to require `Authorization: Bearer <token>` on every
 * request; the server refuses to start without it unless MCP_HTTP_ALLOW_ANON=1,
 * and warns when running open.
 *
 * Config (all optional):
 *   MCP_HTTP_HOST         default 0.0.0.0
 *   MCP_HTTP_PORT         default 20130
 *   MCP_HTTP_TOKEN        bearer token required on every request
 *   MCP_HTTP_ALLOW_ANON   set to 1 to run with no token (not recommended)
 *   CRAWLER_BASE_URL      default http://127.0.0.1:20129
 *   CRAWLER_PORT          port used when starting the crawler (default 20129)
 */

import express from 'express';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(PROJECT_ROOT, 'logs', 'crawler.log');
const PID_FILE = path.join(PROJECT_ROOT, 'logs', 'crawler.pid');

const HOST = process.env.MCP_HTTP_HOST || '0.0.0.0';
const PORT = Number(process.env.MCP_HTTP_PORT) || 20130;
const TOKEN = process.env.MCP_HTTP_TOKEN || null;
const ALLOW_ANON = process.env.MCP_HTTP_ALLOW_ANON === '1';
const CRAWLER_PORT = Number(process.env.CRAWLER_PORT) || Number(process.env.PORT) || 9999;
const CRAWLER_BASE = process.env.CRAWLER_BASE_URL || `http://127.0.0.1:${CRAWLER_PORT}`;

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// ==================== Crawler API client ====================

/**
 * Every crawl operation goes through here. Failure to reach the API is reported
 * as such rather than worked around by touching the database — that separation
 * is what keeps the Scheduler in charge of every Run.
 */
async function api(method, endpoint, body = null, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${CRAWLER_BASE}${endpoint}`, {
      method,
      signal: controller.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await response.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
    return { ok: response.ok, status: response.status, body: parsed };
  } catch (err) {
    return { ok: false, offline: true, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

const CRAWLER_OFFLINE =
  `crawler-POD is not responding at ${CRAWLER_BASE}. Start it first with the start_crawler tool.`;

/** Wraps an API call so an offline crawler produces one clear message. */
async function viaApi(method, endpoint, body = null) {
  const result = await api(method, endpoint, body);
  if (result.offline) throw new Error(CRAWLER_OFFLINE);
  if (!result.ok) {
    const detail = result.body && result.body.error ? result.body.error : `HTTP ${result.status}`;
    throw new Error(`${method} ${endpoint} failed: ${detail}`);
  }
  return result.body;
}

async function crawlerReachable() {
  const probe = await api('GET', '/api/platforms', null, 4000);
  return probe.ok === true;
}

async function waitForCrawler(deadlineMs = 45000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await crawlerReachable()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// ==================== Tools ====================

const TOOLS = [
  {
    name: 'get_system_status',
    description:
      'Whether crawler-POD is running, plus its scheduler and PostgreSQL health when it is. Works while the crawler is stopped.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_crawler',
    description:
      'Start crawler-POD on this machine (detached, logging to logs/crawler.log) and wait until its API answers.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'number', description: `Port to listen on (default ${CRAWLER_PORT}).` } },
    },
  },
  {
    name: 'stop_crawler',
    description: 'Stop the crawler-POD process started by this server.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'restart_crawler',
    description: 'Stop crawler-POD if it is running, then start it again and wait for its API.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'number', description: `Port to listen on (default ${CRAWLER_PORT}).` } },
    },
  },
  {
    name: 'list_platforms',
    description: 'Platforms crawler-POD can collect from, with their compatibility status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_collect',
    description:
      'Start a collection run. Submitted through the crawler API, so the Scheduler performs admission control — this never calls a scraper directly.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform key, e.g. etsy, ebay, reddit, shopify.' },
        query: { type: 'string', description: 'Keyword or URL to collect.' },
        maxItems: { type: 'number', description: 'How many items to target (default 30).' },
        country: { type: 'string', description: 'Country code, for platforms that support it.' },
        options: { type: 'object', description: 'Extra platform-specific options.' },
      },
      required: ['platform', 'query'],
    },
  },
  {
    name: 'get_run_status',
    description: 'Status and metadata of one run (without its items).',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'number', description: 'The run id.' } },
      required: ['runId'],
    },
  },
  {
    name: 'get_run_results',
    description: 'Items collected by one run.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'number', description: 'The run id.' },
        limit: { type: 'number', description: 'Maximum items to return (default 50).' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'cancel_run',
    description:
      'Cancel a run. Goes through the crawler API, which aborts the live execution token before removing the run — it does not just delete a database row.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'number', description: 'The run id.' } },
      required: ['runId'],
    },
  },
  {
    name: 'list_schedules',
    description: 'Marketplace capture schedules with their next/last run times.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_schedule_now',
    description: 'Trigger one marketplace capture schedule immediately, through the crawler API.',
    inputSchema: {
      type: 'object',
      properties: { scheduleId: { type: 'number', description: 'The schedule id.' } },
      required: ['scheduleId'],
    },
  },
];

const handlers = {
  async get_system_status() {
    const reachable = await crawlerReachable();
    const pid = fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, 'utf8').trim() : null;
    const mcp = { host: HOST, port: PORT, transport: 'streamable-http', authRequired: Boolean(TOKEN) };

    if (!reachable) {
      return text({
        crawler: { running: false, baseUrl: CRAWLER_BASE, lastKnownPid: pid },
        database: 'unknown — crawler is stopped, and this server holds no database connection of its own',
        scheduler: null,
        mcp,
      });
    }
    const [database, scheduler] = await Promise.all([
      api('GET', '/api/database/health'),
      api('GET', '/api/scheduler/status'),
    ]);
    return text({
      crawler: { running: true, baseUrl: CRAWLER_BASE, pid },
      database: database.ok ? database.body : `unavailable (${database.error || database.status})`,
      scheduler: scheduler.ok ? scheduler.body : null,
      mcp,
    });
  },

  async start_crawler({ port = CRAWLER_PORT }) {
    if (await crawlerReachable()) return text({ started: false, reason: 'already running', baseUrl: CRAWLER_BASE });

    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const out = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, ['server.js'], {
      cwd: PROJECT_ROOT,
      // Inherits this process's environment, so the crawler uses the SAME
      // PostgreSQL configuration it normally does — nothing is pinned here.
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');

    const up = await waitForCrawler();
    return text({ started: true, pid: child.pid, port, reachable: up, log: LOG_FILE });
  },

  async stop_crawler() {
    if (!fs.existsSync(PID_FILE)) {
      return failure('No pid file — this server only stops a crawler process it started.');
    }
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    try {
      process.kill(pid);
    } catch (err) {
      fs.unlinkSync(PID_FILE);
      return failure(`Could not stop pid ${pid}: ${err.message}`);
    }
    fs.unlinkSync(PID_FILE);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!(await crawlerReachable())) return text({ stopped: true, pid });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return text({ stopped: true, pid, note: 'signal sent, but the port still answers' });
  },

  async restart_crawler({ port = CRAWLER_PORT }) {
    // stop_crawler does not always answer in JSON: its failure paths (no pid
    // file, a stale pid whose process is already gone) return a plain text
    // message. Parsing that blindly threw SyntaxError and failed the whole
    // restart even though starting was still possible — so non-JSON answers
    // are carried through as-is instead of being parsed.
    const asResult = (handlerText) => {
      try { return JSON.parse(handlerText); } catch { return { message: handlerText }; }
    };
    const stopped = fs.existsSync(PID_FILE)
      ? asResult((await handlers.stop_crawler()).content[0].text)
      : { skipped: 'was not running' };
    const started = asResult((await handlers.start_crawler({ port })).content[0].text);
    return text({ stop: stopped, start: started });
  },

  async list_platforms() {
    return text(await viaApi('GET', '/api/platforms'));
  },

  async start_collect({ platform, query, maxItems, country, options }) {
    const payload = { platform, query };
    if (maxItems != null) payload.maxItems = Number(maxItems);
    if (country) payload.country = country;
    if (options) payload.options = options;
    const run = await viaApi('POST', '/api/runs', payload);
    return text({
      submitted: true,
      runId: run.id,
      platform: run.platform,
      query: run.query,
      status: run.status,
      note: 'Queued through the crawler API; the Scheduler decides when it is admitted.',
    });
  },

  async get_run_status({ runId }) {
    const run = await viaApi('GET', `/api/runs/${Number(runId)}`);
    const { snapshots, ...meta } = run;
    return text({ ...meta, itemCount: Array.isArray(snapshots) ? snapshots.length : 0 });
  },

  async get_run_results({ runId, limit = 50 }) {
    const run = await viaApi('GET', `/api/runs/${Number(runId)}`);
    const items = Array.isArray(run.snapshots) ? run.snapshots : [];
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return text({ runId: run.id, status: run.status, itemCount: items.length, items: items.slice(0, cap) });
  },

  async cancel_run({ runId }) {
    return text(await viaApi('DELETE', `/api/runs/${Number(runId)}`));
  },

  async list_schedules() {
    return text(await viaApi('GET', '/api/marketplace-capture-schedules'));
  },

  async run_schedule_now({ scheduleId }) {
    return text(await viaApi('POST', `/api/marketplace-capture-schedules/${Number(scheduleId)}/run-now`));
  },
};

// ==================== MCP wiring ====================

function buildServer() {
  const server = new Server({ name: 'crawler-pod-http', version: '1.0.0' }, { capabilities: { tools: {} } });
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
  return server;
}

if (!TOKEN && !ALLOW_ANON) {
  console.error(
    'Refusing to start: this transport listens on the LAN, so it needs MCP_HTTP_TOKEN set.\n' +
      'Set a token, or pass MCP_HTTP_ALLOW_ANON=1 to run it open on a network you trust.'
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  if (!TOKEN) return next();
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : null;
  // Constant-time comparison: `!==` short-circuits on the first differing
  // byte, which lets a caller on the LAN measure response times to recover
  // the token prefix by prefix. Length still leaks (timingSafeEqual requires
  // equal lengths), which reveals nothing useful on its own.
  const suppliedBuf = Buffer.from(supplied || '', 'utf8');
  const tokenBuf = Buffer.from(TOKEN, 'utf8');
  const authorized = suppliedBuf.length === tokenBuf.length && timingSafeEqual(suppliedBuf, tokenBuf);
  if (!authorized) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <MCP_HTTP_TOKEN>' },
      id: null,
    });
  }
  next();
});

/** Liveness probe that needs no MCP handshake — useful for checking
 *  reachability from another machine before wiring up a client. */
app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    mcp: { transport: 'streamable-http', endpoint: '/mcp', host: HOST, port: PORT, authRequired: Boolean(TOKEN) },
    crawler: { baseUrl: CRAWLER_BASE, reachable: await crawlerReachable() },
  });
});

/**
 * Stateless: a fresh Server + transport per request, torn down when the
 * response closes. There is no session state to lose if a client reconnects
 * from a different machine, which is the normal case over a LAN.
 */
app.post('/mcp', async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
    }
  }
});

// GET/DELETE on /mcp drive server-initiated streams and session teardown,
// neither of which exists in stateless mode.
const notAllowed = (req, res) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST /mcp' },
    id: null,
  });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

app.listen(PORT, HOST, () => {
  console.log(`[crawler-pod-mcp-http] listening on http://${HOST}:${PORT}/mcp`);
  console.log(`[crawler-pod-mcp-http] crawler API: ${CRAWLER_BASE}`);
  if (!TOKEN) {
    console.warn('[crawler-pod-mcp-http] WARNING: no MCP_HTTP_TOKEN — anyone who can reach this port has full control.');
  }
});
