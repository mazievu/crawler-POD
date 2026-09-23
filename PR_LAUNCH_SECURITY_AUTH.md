# Pull Request: Crawler-POD Internet Launch Security & Authentication Hardening (R1–R5)

**Target Branch**: `main`  
**Source Branch**: `feat/internet-launch-security-auth`  
**Author**: Engineering Teamwork Agent (Worker M6)  
**Date**: September 23, 2026  
**Status**: Ready for Production Review & Merge  
**Specification References**:  
- `docs/INTERNET_LAUNCH_PLAN_2026-09-22.md` (SSOT Architecture & Threat Model)  
- `ORIGINAL_REQUEST.md` (§ 2026-09-23T02:43:40Z Requirements R1–R5)  
- `.agents/orchestrator_launch_1/PROJECT.md`  

---

## 1. Executive Summary

Crawler-POD was originally architected as a single-user data collection engine intended solely for local network execution on `127.0.0.1`. In order to transition Crawler-POD into an internet-accessible, enterprise-grade multi-user platform, a comprehensive architectural overhaul was undertaken across five primary security and operational domains:

1. **Shared Workspace Authentication & RBAC (R1)**: Replaced unauthenticated access with a secure two-tier role-based access model (`admin` vs `member`), backed by scrypt/bcrypt credential hashing, high-entropy cryptographic session cookies (`HttpOnly`, `Secure`, `SameSite=Lax`), scoped API Keys, and idempotent zero-trust Super Admin bootstrapping.
2. **Ingress Protection, SSRF Defenses & MCP Bridge Lockdown (R2)**: Eliminated reverse proxy loopback bypass vulnerabilities by enforcing constant-time `INTERNAL_SERVICE_KEY` verification for all internal MCP bridge endpoints, stripping browser origins, and enforcing AST-verified read-only SQL queries. Implemented an OWASP-compliant outbound SSRF guard (`validateOutboundUrl` and `safeFetch`) that blocks all RFC 1918 private subnets, loopback, link-local, cloud metadata (`169.254.169.254`), decimal/hex/octal obfuscations, DNS rebinding, and redirect hops across Shopify, Web Reader, and Media Cache scrapers.
3. **Concurrency, Rate Limiting & Cost Protection (R3)**: Installed sliding-window brute force login throttlers, per-user run creation rate limiters, global scheduler concurrency ceilings (`MAX_CONCURRENT_RUNS`), an atomic Apify budget kill switch (`APIFY_BUDGET_EXCEEDED`), and an Emergency Dispatch Freeze toggle (`DISPATCH_FROZEN`) accessible from `/admindashboard`.
4. **PostgreSQL Backup & Rollback, Docker Hardening & Lifecycle Operations (R4)**: Overhauled backup and rollback utilities to operate on PostgreSQL runtime (`pg_dump` with transactional client fallback), enforcing SHA-256 cryptographic manifest verification, pre-flight `--dry-run` inspection, and strict path containment against CWE-22/CWE-23 path traversal. Hardened container deployment with non-root Playwright users (`pwuser`), a strict `.dockerignore`, persistent volumes for cached media, operational health probes (`/livez`, `/readyz`), and graceful shutdown sequences with a 30-second watchdog.
5. **Hermetic Test Verification (R5)**: Validated against a complete suite of **563 automated tests with a 100% pass rate**, comprising a 4-Tier opaque-box E2E test suite (242 tests), an adversarial stress suite across 12 feature suites (137 tests), and Tier 5 adversarial security and systems suites (50 tests).

---

## 2. Architecture & Threat Model Breakdown

### 2.1 Shared Workspace Model & RBAC Matrix
Crawler-POD operates under the **Shared Workspace Model**: team members collaborate on a common catalog of crawled products, shops, and market observations while access to sensitive credentials, system configurations, and destructive operations is strictly governed by server-side role enforcement.

```
Internet Clients (Browser / External API / MCP Client)
                 │
                 ▼
       Reverse Proxy Ingress (TLS Termination, Nginx / Traefik)
                 │
  ┌──────────────┼──────────────────────────────┬─────────────────────────────┐
  ▼              ▼                              ▼                             ▼
[Public]     [Internal]                   [Member Tier]                 [Admin Tier]
/livez       /api/internal/*              /api/runs, /api/jobs          /api/admin/*
/readyz      Header:                      /api/items, /api/exports      /admindashboard
/api/auth/*    x-internal-service-key     /api/schedules                /api/doctor
             AST Read-Only SQL            Browse Catalog                Tokens, Proxies, Sessions
             No Browser Origin            Rate Limited (10/min)         Emergency Freeze, Bulk Delete
```

- **Authentication Vectors**:
  - **Session Cookie**: Issued upon successful login (`POST /api/auth/login`). Generated using 256-bit entropy (`crypto.randomBytes(32)`). Stored in PostgreSQL table `user_sessions`. Cookie configuration: `HttpOnly; SameSite=Lax; Secure` (automatically enabled when `NODE_ENV=production` or HTTPS). Active sessions are tracked and refreshed (`last_seen_at`) on each request.
  - **API Key**: Scoped bearer keys passed via `x-api-key: <key>` or `Authorization: Bearer <key>`. Prefixed as `cp_live_<token>` for member-level integrations and `cp_adm_<token>` for administrative automation. Validated against `api_keys` table with expiration checking and user deactivation checks.
- **Role Permissions (69 Endpoints)**:
  - **Member Permissions**: Can initiate crawls (`POST /api/runs`, `POST /api/jobs`), monitor run status, query product catalogs (`GET /api/items`), download export archives, and view capture schedules.
  - **Admin-Only Permissions**: All member permissions plus: token pool management (`/api/apify/tokens`), proxy configuration (`/api/proxies`), marketplace account/session cookies (`/api/marketplaces/sessions`), diagnostic system logs (`/api/doctor`, `/api/system/info`), Emergency Dispatch Freeze toggle (`/api/admin/emergency-freeze`), user account administration (`/api/admin/users`), API key generation/revocation (`/api/admin/api-keys`), and unconstrained bulk item deletion (`DELETE /api/items` without an explicit item identifier).
  - **Unauthorized Enforcement**: Unauthenticated callers receive `HTTP 401 Unauthorized` with `WWW-Authenticate` headers. Authenticated members attempting to access admin endpoints are blocked with `HTTP 403 Forbidden` (`FORBIDDEN_ADMIN_REQUIRED`).

### 2.2 Ingress Security & MCP Bridge Lockdown
The internal Model Context Protocol (MCP) bridge exposed database querying endpoints at `/api/internal/*`. In a containerized or proxied deployment, reverse proxies forwarding to `127.0.0.1` make remote internet callers appear as loopback sockets, bypassing naive IP checks.

- **Dual-Factor Service Verification**:
  1. All endpoints under `/api/internal/*` strictly mandate an `INTERNAL_SERVICE_KEY` passed via `x-internal-service-key` or `Authorization: Bearer <key>`. Validation is conducted using constant-time comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.
  2. Browser origin rejection: Any incoming request carrying browser-specific headers (`Origin`, `Sec-Fetch-Mode`, `Sec-Fetch-Site`) is rejected immediately with `HTTP 403 Forbidden` regardless of credentials, eliminating cross-site request forgery and malicious iframe abuse.
- **AST-Verified Read-Only SQL (`assertReadOnlySql`)**:
  - Direct SQL evaluation is constrained exclusively to read operations.
  - The query validator permits only single statements beginning with `SELECT` or `WITH`.
  - Smuggled commands via statement chaining (`; DROP TABLE ...`) or writable CTEs (`WITH ins AS (INSERT INTO ...) SELECT ...`) are rejected.
  - Restrictive system functions that read or alter disk/catalog state (`pg_read_file`, `lo_import`, `setval`, `system`, `exec`) are denied.
- **Internal Callers**: Internal tools (`src/mcp/db.js` and `mcp/crawler-pod-server.mjs`) have been upgraded to supply `INTERNAL_SERVICE_KEY` from environment context.

### 2.3 Outbound SSRF Defenses (`validateOutboundUrl` & `safeFetch`)
Web scrapers and media processors fetch remote HTTP targets based on user input (e.g. Shopify store URLs, web reader targets, CDN images). Without guardrails, attackers can pivot through the crawler to access internal services, database ports, or cloud provider metadata engines.

- **Unified Outbound Guard (`src/security/outbound-guard.js`)**:
  - Validates protocol strictly to `http:` or `https:`. Blocks all other URI schemes (`file:`, `gopher:`, `ftp:`, `ws:`, `data:`).
  - Rejects embedded user authority credentials (`http://admin:secret@host/`).
  - Rejects null byte character injection (`%00`).
- **Comprehensive IP Blacklist**:
  - **Loopback**: `127.0.0.0/8`, `::1`
  - **RFC 1918 Private**: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
  - **Carrier-Grade NAT**: `100.64.0.0/10`
  - **Link-Local & Cloud Metadata**: `169.254.0.0/16`, AWS/GCP/Azure IMDS endpoint `169.254.169.254`, and cloud provider internal hostnames (`metadata.google.internal`, `instance-data`).
  - **Multicast / Broadcast**: `224.0.0.0/4`, `255.255.255.255`
  - **IPv6 Private**: Link-local (`fe80::/10`), Unique Local (`fc00::/7`).
- **Obfuscation Normalization**:
  - Standardizes and detects hex IP addresses (e.g. `0x7f000001`, `0x7f.0.0.1`).
  - Standardizes and detects octal IP notations (e.g. `0177.0.0.1`).
  - Standardizes decimal integer (DWORD) notation (e.g. `2130706433`).
  - Normalizes IPv4-mapped IPv6 formats (e.g. `::ffff:127.0.0.1`, `::ffff:7f00:1`).
- **DNS Rebinding & Redirect Defense (`safeFetch`)**:
  - Performs pre-connection DNS resolution (`dns.promises.lookup`) and asserts every resolved A/AAAA record against IP blacklists.
  - Disables standard fetch redirect following (`redirect: 'manual'`). Inspects each redirect target sequentially (up to 5 hops), validating the destination IP before making the subsequent request. Aborts immediately if a public URL attempts to redirect to a private or loopback destination.
  - Streaming size enforcement: Inspects `Content-Length` headers immediately, and streams response data through a counting stream to truncate payloads exceeding 8 MB, preventing denial-of-service via memory exhaustion.

### 2.4 Rate Limiting, Concurrency & Cost Controls
- **Sliding-Window Login Throttler**:
  - Keyed by client IP and normalized target email.
  - Bounded memory store with automatic sweep intervals and LRU eviction (capped at 10,000 keys) to prevent memory leakage under distributed attacks.
  - Limits failed login attempts to 5 failures per 15-minute window. Returning `HTTP 429 Too Many Requests` with a `Retry-After` header. Successful authentication instantly resets the failure counter.
- **Run Creation Rate Limiter**:
  - Applies to `/api/runs` and `/api/jobs`.
  - Enforces a ceiling of 10 requests per minute per user/session. Key resolution hierarchy: API Key ID > User ID > Session ID > Client IP.
- **System Concurrency Cap (`MAX_CONCURRENT_RUNS`)**:
  - Managed by `ResourceScheduler` queue admission logic (`canAdmitRun`).
  - Enforces an upper limit (default: 10) on simultaneous running scrapers. Underflow protection ensures active counters cannot become negative under abnormal termination conditions.
- **Apify Budget Kill Switch**:
  - `ApifyTokenPool` tracks spend and token exhaustion atomically.
  - When balance falls below reserve threshold or daily budget is depleted, creation of paid actors is halted immediately, returning `HTTP 402 Payment Required` (`APIFY_BUDGET_EXCEEDED`). Free and local scrapers remain unaffected.
- **Emergency Dispatch Freeze**:
  - Admin toggle on `/admindashboard` instantly freezes the dispatcher.
  - Queued runs remain in queue without being dispatched; incoming run creation attempts return `HTTP 503 Service Unavailable` with error code `DISPATCH_FROZEN`.

### 2.5 PostgreSQL Backup Engine & Safe Rollback
- **Dual-Engine Architecture**:
  - Primary: Native PostgreSQL execution via `pg_dump` binary.
  - Fallback: Client-side Node.js SQL dumper extracting table schemas and data rows using PostgreSQL connection pools when external CLI binaries are not installed.
  - Backwards-compatible SQLite adapter preserved for local development mode.
- **Cryptographic Integrity Verification**:
  - Backups write an atomic `manifest.json` containing SHA-256 cryptographic hashes of every dumped database file and metadata file.
  - Rollback requires pre-flight verification: every file is re-hashed against the manifest before execution. Any discrepancy, file corruption, or truncation aborts the rollback immediately before any database mutation occurs.
- **Security & Path Confinement**:
  - Rollback inputs are strictly validated against CWE-22/CWE-23 path traversal vulnerabilities.
  - Backup target IDs are sanitized against `..`, UNC shares (`\\host\share`), device namespaces (`\\.\`, `\\?\`), absolute roots (`C:\`, `/etc/passwd`), and null bytes.
  - Two-way containment assertion confirms the resolved target path remains inside the designated `.backup/` root.
- **Safety Flags & Retention**:
  - Rollback supports `--dry-run` to simulate validation and file inspection without executing SQL scripts.
  - Collision-safe directory naming appends incremental suffixes (`_1`, `_2`) when backups are created within the same second.
  - Retention logic supports pruning down to `0`, removing stale historical backups safely.

### 2.6 Container Operations & Process Lifecycle
- **Container Hardening**:
  - `.dockerignore` denies secrets (`.env*`, `proxies.txt`), backups (`.backup/`), runtime databases (`data/`), log dumps (`logs/`), agent workspaces (`.agents/`), and ephemeral media (`public/media/`).
  - Dockerfile executes under non-root user `pwuser`, ensures permissions on required cache directories, and defines a standard container `HEALTHCHECK` targeting `/livez`.
  - `docker-compose.yml` mounts a dedicated persistent volume `media_data` to `/app/public/media`, resolving read-only filesystem (`EROFS`) errors while allowing the container root filesystem to run read-only.
- **Liveness & Readiness Probes**:
  - `GET /livez`: Fast-path process probe returning `HTTP 200 { status: 'ok', uptime: <seconds> }`.
  - `GET /readyz`: Database connectivity probe executing `SELECT 1`. Returns `HTTP 200 { status: 'ok', database: 'connected' }` when operational; returns `HTTP 503 { status: 'error', error: <message> }` when disconnected or during active shutdown.
- **Graceful Shutdown**:
  - Traps `SIGINT` and `SIGTERM`.
  - Execution sequence:
    1. Stops HTTP listener and terminates idle sockets.
    2. Stops background timers (`ResourceScheduler`, `StuckDetector`, `SocialScheduler`).
    3. Drains in-flight scraper executions (up to 5 seconds).
    4. Releases distributed lease locks in `monitoring_limiter` to prevent split-brain conditions.
    5. Drains and closes the PostgreSQL database connection pool.
    6. 30-second hard watchdog deadline timer forces exit with code 1 if any cleanup task hangs; normal termination exits cleanly with code 0.

---

## 3. Complete File Inventory & Changelog

### 3.1 Security & Authentication Modules
| File Path | Status | Summary of Changes |
|---|---|---|
| `src/database/pg-schema.sql` | Modified | Added tables: `users` (id, email, password_hash, role, status), `user_sessions` (token, user_id, expires_at, last_seen_at), and `api_keys` (token, user_id, role, expires_at). Added indices for fast lookups. |
| `src/database/auth-ops.js` | New | High-performance prepared statements and operations for user management, session management, and API key verification. |
| `src/security/auth.service.js` | New | Credential validation (scrypt/bcrypt), session creation, token generation, API key lifecycle management, and idempotent Super Admin bootstrapping. |
| `src/security/auth.middleware.js` | New | Express middleware for session cookies and Bearer/x-api-key parsing. Enforces `requireAuth` (401) and `requireRole('admin')` (403). |
| `src/security/auth.routes.js` | New | Public auth routes: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, and `POST /api/auth/bootstrap`. |
| `src/security/outbound-guard.js` | New | SSRF prevention engine: `validateOutboundUrl` and `safeFetch` with IP blacklists, hex/octal/DWORD normalization, DNS rebinding defenses, manual redirect tracking, and streaming size caps. |
| `src/security/rate-limit.middleware.js` | New | Sliding-window memory stores for brute force login prevention (5 attempts / 15 min) and run creation rate limiting (10 req / min). |

### 3.2 Ingress, Routes & Scrapers
| File Path | Status | Summary of Changes |
|---|---|---|
| `src/routes/mcp-bridge.js` | Modified | Enforced `INTERNAL_SERVICE_KEY` verification using `timingSafeEqual`, blocked browser origins, restricted SQL execution to AST-verified read-only statements via `assertReadOnlySql`. |
| `src/mcp/db.js` | Modified | Updated internal client queries to include `INTERNAL_SERVICE_KEY` header. |
| `mcp/crawler-pod-server.mjs` | Modified | Updated MCP standalone server to supply internal authentication credentials. |
| `src/scrapers/shopify.js` | Modified | Integrated `validateOutboundUrl` before making requests to remote Shopify stores. |
| `src/scrapers/web-reader.js` | Modified | Integrated `validateOutboundUrl` before fetching target pages and reader endpoints. |
| `src/media-cache.js` | Modified | Replaced unsafe fetch with `safeFetch`, preventing SSRF pivots and streaming image downloads up to 8 MB. |

### 3.3 Scheduler, Admin & Cost Controls
| File Path | Status | Summary of Changes |
|---|---|---|
| `src/scheduler/scheduler.js` | Modified | Enforced `MAX_CONCURRENT_RUNS` cap, emergency dispatch freeze checks, underflow protection on active execution counters, and graceful drain capabilities. |
| `src/scheduler/execution-planner.js` | Modified | Added freeze state awareness to execution planning logic. |
| `src/apify-token-pool.js` | Modified | Added `checkBudget()` safeguards returning `APIFY_BUDGET_EXCEEDED` when account funds or token balances fall below safety limits. |
| `src/admin/dashboard.js` | New | Administrative dashboard API endpoints for system metrics, browser reliability, priority controls, and Emergency Dispatch Freeze. |
| `src/admin/dashboard.html` | New | Administrative interface providing visual status of active tasks, browser reliability metrics, and emergency controls. |

### 3.4 Operational Scripts & Container Infrastructure
| File Path | Status | Summary of Changes |
|---|---|---|
| `scripts/backup-manager.js` | Modified | Refactored for PostgreSQL (`pg_dump` and client fallback) with SHA-256 manifest generation, retention policy handling, and directory collision avoidance. |
| `scripts/rollback.js` | Modified | Added SHA-256 manifest integrity verification, `--dry-run` pre-flight validation, and strict CWE-22/CWE-23 path confinement checks. |
| `Dockerfile` | Modified | Configured Playwright non-root user `pwuser`, writeable directories for media cache, and `/livez` health check probe. |
| `.dockerignore` | Modified | Comprehensive exclusion of sensitive configuration files (`.env*`, `proxies.txt`), backups, database dumps, logs, and agent metadata. |
| `docker-compose.yml` | Modified | Configured dedicated `media_data` persistent volume for `/app/public/media`. |
| `server.js` | Modified | Integrated auth middleware across all 69 routes, mounted `/livez` and `/readyz` probes, and implemented `createShutdownManager` for graceful teardown. |
| `src/server.js` | New | Module forwarder linking `src/server.js` to root `server.js` for architectural modularity. |

---

## 4. Test Verification Matrix

### 4.1 Automated Test Execution Summary
All test suites execute hermetically without external network dependencies, live external databases, or paid cloud APIs:

| Test Suite Category | File Path | Total Tests | Passed | Failed | Status | Execution Time |
|---|---|---|---|---|---|---|
| **Tier 1: Feature Coverage** | `test/e2e/tier1_features.test.js` | 105 | 105 | 0 | **PASS** | 2.32s |
| **Tier 2: Boundary & Corner** | `test/e2e/tier2_boundaries.test.js` | 105 | 105 | 0 | **PASS** | 1.49s |
| **Tier 3: Combinations** | `test/e2e/tier3_combinations.test.js` | 25 | 25 | 0 | **PASS** | 1.15s |
| **Tier 4: Real-World Scenarios** | `test/e2e/tier4_realworld.test.js` | 7 | 7 | 0 | **PASS** | 0.69s |
| **Adversarial Suites 1–12** | `test/adversarial/runner.js` | 137 | 137 | 0 | **PASS** | 11.8s |
| **Tier 5 Security Adversarial** | `test/adversarial/m5_security_adversarial.test.js` | 36 | 36 | 0 | **PASS** | 1.21s |
| **Tier 5 Systems Adversarial** | `test/adversarial/m5_systems_adversarial.test.js` | 14 | 14 | 0 | **PASS** | 1.71s |
| **Unit: Auth & RBAC** | `test/auth-m1.test.js` | 12 | 12 | 0 | **PASS** | 0.42s |
| **Unit: Outbound Guard SSRF** | `test/outbound-guard.test.js` | 29 | 29 | 0 | **PASS** | 0.08s |
| **Unit: Rate Limiting** | `test/rate-limit.test.js` | 13 | 13 | 0 | **PASS** | 0.05s |
| **Unit: MCP Bridge** | `test/routes/mcp-bridge.test.js` | 25 | 25 | 0 | **PASS** | 0.12s |
| **Unit: Scheduler Concurrency** | `test/scheduler-concurrency.test.js` | 9 | 9 | 0 | **PASS** | 0.04s |
| **Unit: Apify Budget** | `test/apify-budget.test.js` | 14 | 14 | 0 | **PASS** | 0.03s |
| **Unit: Backup & Rollback** | `test/backup-rollback.test.js` | 10 | 10 | 0 | **PASS** | 0.15s |
| **Unit: Docker Hardening** | `test/dockerignore.test.js` | 4 | 4 | 0 | **PASS** | 0.05s |
| **Unit: Probes & Shutdown** | `test/health-shutdown.test.js` | 7 | 7 | 0 | **PASS** | 0.32s |
| **Integration: RBAC Adversarial** | `test/challenger-m1-2-rbac-adversarial.test.js` | 10 | 10 | 0 | **PASS** | 5.95s |
| **Integration: Live Server Auth** | `test/server-auth-live.test.js` | 1 | 1 | 0 | **PASS** | 0.74s |
| **TOTAL** | **Entire Test Repository** | **563** | **563** | **0** | **100% PASS** | **~26.5s** |

### 4.2 Reproduction & Verification Commands
To reproduce and verify the entire test matrix independently:

```bash
# 1. Execute 4-Tier Opaque-Box E2E Suite (242 tests)
node test/e2e/runner.js

# 2. Execute Adversarial Stress Suite (137 tests across Suites 1–12)
node test/adversarial/runner.js

# 3. Execute Tier 5 Security Adversarial Hardening (36 tests)
node --test test/adversarial/m5_security_adversarial.test.js

# 4. Execute Tier 5 Systems & Lifecycle Adversarial Hardening (14 tests)
node --test test/adversarial/m5_systems_adversarial.test.js

# 5. Execute all Unit & Integration Suites (134 tests)
node --test test/auth-m1.test.js test/outbound-guard.test.js test/rate-limit.test.js \
  test/apify-budget.test.js test/scheduler-concurrency.test.js test/backup-rollback.test.js \
  test/dockerignore.test.js test/health-shutdown.test.js test/routes/mcp-bridge.test.js \
  test/challenger-m1-2-rbac-adversarial.test.js test/server-auth-live.test.js
```

---

## 5. Operations Runbook

### 5.1 Environment Variables Reference

| Variable Name | Type | Required | Default | Security Description |
|---|---|---|---|---|
| `PORT` | Integer | Optional | `3000` | HTTP port on which the Express server listens. |
| `NODE_ENV` | String | Optional | `development` | Setting to `production` enforces HTTPS cookies and production error handling. |
| `DATABASE_URL` | String | Required | N/A | PostgreSQL connection string (`postgresql://user:pass@host:5432/dbname`). |
| `ADMIN_EMAIL` | String | Required | N/A | Email for the Super Admin bootstrap account. Must be valid email. |
| `ADMIN_PASSWORD` | String | Required | N/A | Initial password for the Super Admin bootstrap account. Never logged. |
| `INTERNAL_SERVICE_KEY`| String | Required | N/A | Secret key for MCP internal endpoints (`/api/internal/*`). Minimum 32 chars recommended. |
| `SESSION_SECRET` | String | Optional | Auto-generated | Secret used for cookie signing and session token generation. |
| `MAX_CONCURRENT_RUNS` | Integer | Optional | `10` | Maximum number of simultaneous active scraper runs allowed across the system. |
| `LOGIN_MAX_ATTEMPTS` | Integer | Optional | `5` | Maximum failed login attempts before temporary lockout. |
| `LOGIN_WINDOW_MS` | Integer | Optional | `900000` | Sliding window duration for login brute-force tracking (15 minutes). |
| `RUN_MAX_REQUESTS` | Integer | Optional | `10` | Maximum crawl run creations permitted per window per user. |
| `RUN_WINDOW_MS` | Integer | Optional | `60000` | Sliding window duration for run creations (1 minute). |
| `APIFY_SPEND_LIMIT_USD`| Float | Optional | `50.0` | Maximum aggregate spend threshold before paid actor creation is halted. |
| `CORS_ALLOWED_ORIGINS` | String | Optional | `*` | Comma-separated allowlist of permitted origins for browser CORS headers. |
| `BACKUP_RETENTION_COUNT`| Integer | Optional | `10` | Number of recent backup directories to retain before automated pruning. |
| `SHUTDOWN_TIMEOUT_MS` | Integer | Optional | `30000` | Maximum grace period for background jobs to drain before forced shutdown. |

### 5.2 Super Admin Bootstrap & Migration Setup
1. Apply the updated schema to the database:
   ```bash
   psql "$DATABASE_URL" -f src/database/pg-schema.sql
   ```
2. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your production environment or container secrets.
3. Start the application (`node server.js` or `npm start`). On initialization, `bootstrapSuperAdmin()` will create the admin account idempotently if no admin exists. Credentials are removed from memory immediately after hashing.

### 5.3 Backup & Rollback CLI Guide
The backup utility provides transactional safety and SHA-256 cryptographic verification:

- **Create a Backup**:
  ```bash
  node scripts/backup-manager.js backup
  ```
  Generates a timestamped backup directory in `.backup/YYYYMMDD-HHMMSS` containing SQL dump and `manifest.json`.
- **List Backups**:
  ```bash
  node scripts/backup-manager.js list
  ```
- **Prune Old Backups**:
  ```bash
  node scripts/backup-manager.js prune --keep 5
  ```
- **Pre-flight Integrity Simulation (`--dry-run`)**:
  ```bash
  node scripts/rollback.js --backup 20260923-120000 --dry-run
  ```
  Validates manifest hashes and path safety without modifying the database.
- **Execute Rollback**:
  ```bash
  node scripts/rollback.js --backup 20260923-120000
  ```

### 5.4 Docker Deployment Instructions
Deploy using the production Docker Compose profile:

```bash
# 1. Build and launch services in detached mode
docker-compose up -d --build

# 2. Inspect running container health status
docker-compose ps

# 3. Stream server operational logs
docker-compose logs -f crawler-pod
```

### 5.5 Health & Monitoring Endpoints
- **Liveness Probe**:
  ```bash
  curl -i http://localhost:3000/livez
  # HTTP/1.1 200 OK
  # {"status":"ok","uptime":342}
  ```
- **Readiness Probe**:
  ```bash
  curl -i http://localhost:3000/readyz
  # HTTP/1.1 200 OK
  # {"status":"ok","database":"connected"}
  ```

### 5.6 Emergency Dispatch Freeze Procedure
In the event of an upstream provider malfunction, unexpected billing surge, or crawl runaway:
1. Navigate to `/admindashboard` as an Admin user.
2. Toggle the **Emergency Dispatch Freeze** switch to **ENABLED**.
3. Alternatively, invoke the API directly:
   ```bash
   curl -X POST http://localhost:3000/api/admin/emergency-freeze \
     -H "Content-Type: application/json" \
     -H "x-api-key: <ADMIN_API_KEY>" \
     -d '{"frozen": true}'
   ```
4. All candidate crawler dispatches halt immediately with `HTTP 503 Service Unavailable (DISPATCH_FROZEN)`. Active executions will complete cleanly without starting new tasks.

---

## 6. Reviewer Checklist & Verification Sign-Off

- [x] **Access Control**: Anonymous requests to protected routes receive 401; Members attempting admin actions receive 403; Admins have full access.
- [x] **Ingress & MCP**: `/api/internal/*` is locked down with timing-safe `INTERNAL_SERVICE_KEY`; browser origins rejected; read-only SQL AST enforced.
- [x] **SSRF Defenses**: `validateOutboundUrl` and `safeFetch` block all private IPs, cloud metadata, DNS rebinding, redirect hops, and streams >8 MB.
- [x] **Rate Limiting & Cost**: Sliding-window login throttler (5/15 min) and run creator limiter (10/min) return 429; concurrency capped; Apify budget kill switch active.
- [x] **Database & Backup**: PostgreSQL `pg_dump` and client fallback with SHA-256 integrity verification, `--dry-run`, and CWE-22 path containment.
- [x] **Container Operations**: Hardened `.dockerignore`, non-root user `pwuser`, `/livez` & `/readyz` probes, and 30s graceful shutdown sequence.
- [x] **Test Verification**: 563/563 tests passing (242 E2E, 187 adversarial, 134 unit/integration).
- [x] **Zero Dirty State**: Working tree clean, branches isolated, and conventional commits structured.
