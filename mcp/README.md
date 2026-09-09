# crawler-POD MCP servers

Two transports, for two different jobs:

| File | Transport | Reach | Use it for |
|---|---|---|---|
| `crawler-pod-server.mjs` | stdio | this machine only | local work in Claude Code; queries PostgreSQL directly |
| `crawler-pod-http-server.mjs` | Streamable HTTP | LAN | another machine driving this one; goes through the crawler API |

They are independent — running one does not affect the other.

---

# 1. stdio server (local)

Exposes this project's operations as MCP tools, so an MCP client can inspect and
drive crawler-POD directly instead of you running commands by hand.

## Enabling it

`.mcp.json` in the project root already registers it:

```json
{
  "mcpServers": {
    "crawler-pod": {
      "command": "node",
      "args": ["mcp/crawler-pod-server.mjs"],
      "env": { "PG_MODE": "pglite", "PGLITE_DIR": "data/pgdata" }
    }
  }
}
```

Reopen the project in Claude Code and approve the server when prompted. Check it
with `/mcp` — `crawler-pod` should list 8 tools.

## Tools

| Tool | What it does |
|---|---|
| `health` | PostgreSQL size and row counts, whether the HTTP server responds, scheduler snapshot |
| `db_tables` | Every table with its current row count |
| `db_query` | Run a **read-only** SQL query (single `SELECT`/`WITH` only) |
| `runs_list` | Recent runs, filterable by status or platform |
| `run_get` | One run in full, with the items it collected |
| `schedules_list` | Marketplace capture schedules and their latest summary |
| `server_control` | `status` / `start` / `stop` the HTTP server (start is detached, logs to `logs/server.log`) |
| `logs_tail` | Last lines of that log |

## Pointing at a real PostgreSQL server

The `env` block above uses PGlite (PostgreSQL compiled to WASM, stored in
`data/pgdata`). To use a PostgreSQL server instead, drop `PG_MODE`/`PGLITE_DIR`
and let the process inherit the same variables the app uses:

```
PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE      # or a single DATABASE_URL
```

Set them in your shell or machine environment — do **not** put a password in
`.mcp.json`, which is committed to the repository.

## Security posture — read before exposing this

The transport is **stdio**. The client starts this process and talks to it over
a pipe: no port is opened, and nothing outside this machine can reach it. That
is the right default for a tool that can read your database and start processes.

Three limits are deliberate:

- **`db_query` is read-only.** A single `SELECT`/`WITH` only; writes, DDL and
  multi-statement input are refused, so a mis-generated query cannot damage the
  database.
- **There is no "run any shell command" tool.** An arbitrary exec endpoint is
  precisely what turns a convenience server into a remote shell, and it adds
  nothing your own terminal does not already give you.
- **No tool starts a crawl,** so no tool can reach a paid provider.

For driving this from another machine, see the HTTP server below.

---

# 2. Streamable HTTP server (LAN)

```
another machine  ->  LAN  ->  http://<crawler-machine-ip>:20130/mcp
                          ->  crawler-POD API on 127.0.0.1:20129
                          ->  Scheduler -> crawler -> PostgreSQL
```

Its own process, independent of crawler-POD. It opens **no database connection**:
every operation goes through the crawler's HTTP API, so runs are created and
cancelled by the Scheduler rather than by writing rows, and no scraper is called
directly. That independence is what lets it stay up while the crawler is
stopped — which is what makes `start_crawler` reachable remotely at all.

## Running it

```bash
# On the crawler machine. A token is required unless you opt out explicitly.
MCP_HTTP_TOKEN=<your-token> npm run mcp:http
```

Then from the other machine:

```
endpoint: http://<crawler-machine-ip>:20130/mcp
header:   Authorization: Bearer <your-token>
```

`GET /health` answers without an MCP handshake, which is the quickest way to
confirm the other machine can reach the port at all.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` | `0.0.0.0` | Interface to bind |
| `MCP_HTTP_PORT` | `20130` | Port to listen on |
| `MCP_HTTP_TOKEN` | — | Bearer token required on every request |
| `MCP_HTTP_ALLOW_ANON` | — | `1` runs with no token (not recommended) |
| `CRAWLER_BASE_URL` | `http://127.0.0.1:20129` | Crawler API to drive |
| `CRAWLER_PORT` | `20129` | Port used when starting the crawler |

Nothing about PostgreSQL is configured here. The crawler is started with this
process's environment inherited, so it connects to whatever PostgreSQL it
normally uses — set `PGHOST`/`PGPASSWORD`/… or `DATABASE_URL` in the environment
you launch from. (`PG_MODE=pglite` is for tests only; production must not pin it.)

## Tools

| Tool | What it does |
|---|---|
| `get_system_status` | Crawler up? plus scheduler + PostgreSQL health. Answers while the crawler is stopped. |
| `start_crawler` / `stop_crawler` / `restart_crawler` | Crawler lifecycle; start waits until the API answers |
| `list_platforms` | Platforms and their compatibility status |
| `start_collect` | Submit a collection run **through the API**, so the Scheduler admits it |
| `get_run_status` | Status/metadata of one run |
| `get_run_results` | Items a run collected |
| `cancel_run` | Cancel via the API, which aborts the live execution token first |
| `list_schedules` | Marketplace capture schedules |
| `run_schedule_now` | Trigger one schedule immediately |

## Security

This listens on the LAN by design, so **anything that can reach the port can do
everything these tools do**, including starting and stopping the crawler. The
server refuses to start without `MCP_HTTP_TOKEN` unless you pass
`MCP_HTTP_ALLOW_ANON=1`, and warns when running open.

A token over plain HTTP is enough for a trusted LAN, not for anything wider. If
this ever needs to leave the LAN, put it behind a VPN/SSH tunnel or terminate
TLS in front of it — the token is sent in clear text otherwise. And keep the
port off any interface facing the internet.
