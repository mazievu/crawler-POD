# Crawler POD Data MCP Server (Read-only) — Implementation Notes & Manual

## 1. Overview

**Crawler POD Data MCP Server** is a standalone, read-only Model Context Protocol (MCP) server that exposes crawled multi-platform e-commerce and social trend data to GTF's AI Agents, OpenClaw, and LLMs.

### Architectural Diagram

```text
Crawler POD (Collector)
    │ WRITE (Existing flow untouched)
    ▼
SQLite Database (data/collector.db)
    ▲
    │ READ ONLY (readonly: true, PRAGMA query_only = ON)
Crawler POD Data MCP (Process riêng, stdio JSON-RPC)
    ▲
    │ MCP Protocol (Tools & Prompts)
OpenClaw / GTF's AI Agent
```

---

## 2. Hard Safety & Security Guarantees

* **Strict Read-Only Connection**: All SQLite database handles are created with `readonly: true`, `fileMustExist: true`, and immediate enforcement of `PRAGMA query_only = ON;`.
* **Zero Database Modifications**: No migrations, no `CREATE`, `ALTER`, `DROP`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, or `VACUUM` queries exist anywhere in the MCP codebase.
* **Table Whitelist**: MCP only interacts with `snapshots`, `runs`, and `platforms`.
* **SQL Injection Immunity**: 100% of parameterized values use prepared statements (`@paramName` / `?`). Zero string concatenation into SQL clauses.
* **No Impact on Crawler POD**: The collector runs as a separate process. Concurrency is fully supported via SQLite WAL mode.
* **Prompt Injection Boundary**: All crawled text fields (`title`, `author`, `url`, `query`) are explicitly flagged as `UNTRUSTED EXTERNAL DATA`.
* **Redaction Layer**: Complete removal of `raw_data`, `actor_id`, `apify_run_id`, `apify_dataset_id`, `error_message`, credentials, cookies, tokens, and sessions before transmission.
* **Currency Rule**: If no explicit currency was captured in the record, `currency` is strictly set to `null`. Currency is never guessed.

---

## 3. The 6 MCP Tools & Contracts

### 1. `list_data_sources`
Lists all platforms with item counts, most recent successful crawl time, and data freshness.
* **Inputs**:
  * `only_with_data` (boolean, optional): Filter only sources with > 0 items.
* **Outputs**:
  * `sources`: Array of `{ platform, display_name, description, query_type, country_support, icon, color, item_count, last_successful_crawl_at, data_as_of }`.
  * `total_sources`: Total platforms listed.
  * `generated_at`: ISO timestamp.

### 2. `describe_item_schema`
Returns full documentation of the Item Contract, data types, null vs. 0 semantics, and safety boundary warnings.
* **Inputs**: None (`{}`).
* **Outputs**: Contract specification JSON object.

### 3. `search_items`
Searches current active items across platforms using multi-criteria filters, sorting, and keyset cursor pagination.
* **Inputs**:
  * `keyword` (string, optional)
  * `platform` (string, optional)
  * `author` (string, optional)
  * `price_min` / `price_max` (number, optional)
  * `likes_min` / `comments_min` / `shares_min` / `views_min` (number, optional)
  * `country` (string, optional)
  * `collected_at_from` / `collected_at_to` (string, optional)
  * `sort` (enum, optional, default: `collected_at:desc`)
  * `limit` (integer, default: 50, maximum: 100)
  * `cursor` (string, optional)
* **Outputs**:
  * `items`: Array of standard Item Contracts.
  * `next_cursor`: Base64 cursor for next page (or null).
  * `total_returned`: Count in current page.
  * `data_as_of`: Collection timestamp.
  * `generated_at`: ISO timestamp.

### 4. `get_item`
Retrieves the complete Item Contract for a single item by `item_uid`.
* **Inputs**:
  * `item_uid` (string, required)
* **Outputs**:
  * If found and active: `{ item: ItemContract, status: "active" | "new", generated_at: string }`
  * If dropped or non-existent: `{ item: null, status: "not_current", generated_at: string }`

### 5. `get_item_history`
Retrieves chronological snapshots and calculated diffs (price change, likes change, status change) across time.
* **Inputs**:
  * `item_uid` (string, required)
  * `from` / `to` (string, optional)
  * `limit` (integer, default: 50, maximum: 100)
  * `cursor` (string, optional)
* **Outputs**:
  * `item_uid`: string
  * `total_snapshots`: integer
  * `history`: Array of `{ snapshot_id, run_id, status, prev_snapshot_id, collected_at, title, url, price, engagement, metrics_diff }`
  * `disclaimer`: Explicit note on `dropped` status meaning.

### 6. `get_items_insights_summary`
Aggregates quantitative statistical metrics across crawled items.
* **Inputs**:
  * `platform` (string, optional)
  * `keyword` (string, optional)
  * `from` / `to` (string, optional)
* **Outputs**:
  * `overview`: `{ total_snapshots, unique_items_count, earliest_crawl, latest_crawl }`
  * `platform_distribution`: Array of `{ platform, snapshot_count, unique_items_count, percentage }`
  * `status_distribution`: Array of `{ status, count, percentage }`
  * `price_statistics`: `{ min, max, avg, known_count, unknown_or_zero_count, currency_note }`
  * `engagement_distribution`: Detailed stats for `likes`, `comments`, `shares`, `views`.

---

## 4. Item Contract Reference

```json
{
  "item_uid": "etsy:https://www.etsy.com/listing/4500967226/blooming-lilies",
  "platform": "etsy",
  "title": "Blooming Lilies Handmade Press On Nails",
  "url": "https://www.etsy.com/listing/4500967226/blooming-lilies",
  "image": "https://picsum.photos/seed/etsy-20/400/400",
  "author": "JJStunningNails",
  "price": {
    "amount": 24.99,
    "currency": null
  },
  "engagement": {
    "likes": 0,
    "comments": 0,
    "shares": 0,
    "views": 0
  },
  "status": "active",
  "first_seen_at": "2026-07-28 07:18:01",
  "last_seen_at": "2026-08-13 03:58:02",
  "provenance": {
    "platform": "etsy",
    "url": "https://www.etsy.com/listing/4500967226/blooming-lilies",
    "query": "handmade press on nails",
    "run_id": "524",
    "snapshot_id": "89077",
    "collected_at": "2026-08-13 03:58:02"
  },
  "freshness": {
    "data_as_of": "2026-08-13 03:58:02",
    "stale": true
  }
}
```

---

## 5. How to Run and Configure

### Command Line
```bash
# Using npm script
npm run mcp

# Using direct node execution
node src/mcp/index.js

# Using binary launcher
./bin/crawler-pod-mcp.js
```

### Environment Variables
* `CRAWLER_DB_PATH` or `DB_PATH`: Custom path to `collector.db` (defaults to `./data/collector.db`).

### OpenClaw / AI Agent Configuration (`openclaw.json`)

```json
{
  "mcpServers": {
    "crawler-pod-data": {
      "command": "sudo",
      "args": [
        "-n",
        "-u",
        "crawler_mcp_ro",
        "/home/server/.nvm/versions/node/v24.18.0/bin/node",
        "/mnt/Data-ReadOnly/GTFTools/crawler-POD/src/mcp/index.js"
      ],
      "env": {
        "CRAWLER_DB_PATH": "/mnt/Data-ReadOnly/GTFTools/crawler-POD/data/collector.db"
      },
      "toolFilter": {
        "include": [
          "list_data_sources",
          "describe_item_schema",
          "search_items",
          "get_item",
          "get_item_history",
          "get_items_insights_summary"
        ]
      }
    }
  }
}
```

## 6. Phase Security Lock — OpenClaw Read-Only Hardening

### Isolation & Permission Boundaries:
1. **Zero External Write Access**: OpenClaw process does NOT receive database credentials, file paths, or shell commands. It only interacts via stdio JSON-RPC.
2. **Dedicated OS User (`crawler_mcp_ro`)**:
   - System user with no sudo/admin privileges and `/sbin/nologin` shell.
   - Database directory permissions set to `755` (non-writable by `crawler_mcp_ro`), preventing creation, unlinking, and renaming of `collector.db`, `collector.db-wal`, and `collector.db-shm`.
3. **Database Engine Enforcement**:
   - `readonly = true`
   - `fileMustExist = true`
   - `PRAGMA query_only = ON;`
   - If read-only connection fails to open: server immediately aborts startup without fallback.
4. **Tool Whitelist**: Exactly 6 MCP tools registered. No SQL execution, no arbitrary command execution, no filesystem read/write tools.
5. **Redaction Layer**: Strips all sensitive fields (`raw_data`, `actor_id`, `token`, `cookie`, `session`, `password`, `proxy`, `authorization`, `apify_run_id`, `error_message`).

---

## 7. Hardening Verification Checklist

* **MCP tools exposed**: exactly 6
* **Arbitrary SQL**: DISABLED
* **Shell/filesystem tool**: DISABLED
* **Direct OpenClaw DB access**: DENIED
* **SQLite write protection**: PASS
* **Filesystem write protection**: PASS
* **Filesystem delete protection**: PASS
* **Collector write operation**: PASS
* **MCP read operation**: PASS
* **Database changes**: NONE
* **Collector data loss**: NONE

