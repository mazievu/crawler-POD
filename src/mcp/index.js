#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { createReadOnlyDb } = require('./db');
const { createMcpServer, SERVER_INFO } = require('./server');

// Redirect all standard console logging to stderr to prevent corrupting stdio JSON-RPC protocol
const log = {
  info: (...args) => process.stderr.write(`[MCP INFO] ${args.join(' ')}\n`),
  warn: (...args) => process.stderr.write(`[MCP WARN] ${args.join(' ')}\n`),
  error: (...args) => process.stderr.write(`[MCP ERROR] ${args.join(' ')}\n`),
};

function main() {
  log.info(`Starting ${SERVER_INFO.name} v${SERVER_INFO.version} (read-only mode)...`);

  let db;
  try {
    db = createReadOnlyDb();
    log.info(`Connected to read-only database: ${db.dbPath}`);
  } catch (err) {
    log.error(`Fatal startup error: ${err.message}`);
    process.exit(1);
  }

  const server = createMcpServer(db);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Handle incoming line from stdin
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (parseError) {
      log.error(`JSON parse error: ${parseError.message}`);
      const errResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      };
      process.stdout.write(JSON.stringify(errResponse) + '\n');
      return;
    }

    try {
      const response = await server.handleMessage(request);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (handlerError) {
      log.error(`Handler error: ${handlerError.message}`);
      const errResponse = {
        jsonrpc: '2.0',
        id: request?.id ?? null,
        error: { code: -32603, message: 'Internal server error' },
      };
      process.stdout.write(JSON.stringify(errResponse) + '\n');
    }
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    log.info(`Received ${signal}. Shutting down MCP server...`);
    rl.close();
    if (db) {
      db.close();
      log.info('Database connection closed.');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  rl.on('close', () => {
    if (db) db.close();
    process.exit(0);
  });

  log.info(`${SERVER_INFO.name} ready for JSON-RPC messages on stdio.`);
}

if (require.main === module) {
  main();
}

module.exports = { main };
