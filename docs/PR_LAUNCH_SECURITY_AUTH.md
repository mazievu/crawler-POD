# Internet Launch — Security & Authentication

**Target Branch:** `feat/discovery-monitoring`  
**Base Branch:** `main`  
**Date:** 2026-09-24  
**Status:** Draft — security hardening in progress

## Overview

This PR addresses the critical security and authentication barriers to internet-facing deployment identified in [INTERNET_LAUNCH_PLAN_2026-09-22.md](./INTERNET_LAUNCH_PLAN_2026-09-22.md). It implements admin bootstrap via CLI, fixes SSRF/DNS rebinding vulnerabilities, refactors budget enforcement, and removes public-facing administrative endpoints.

## Scope

**Deployment Model:** Shared-workspace beta only. This implementation is suitable for a **trusted team with unified identity and shared data**. Multi-tenant data isolation is not implemented; do not use this version for independent customers without tenant boundary implementation (see [INTERNET_LAUNCH_PLAN_2026-09-22.md § 2](./INTERNET_LAUNCH_PLAN_2026-09-22.md)).

## Key Changes

### 1. Bootstrap via CLI, not Public Endpoint

- **OLD:** `POST /api/auth/bootstrap` mounted without auth; accepts email/password from request body.
- **NEW:** Admin bootstrap only via `npm run bootstrap:admin` CLI command at startup.
  - Requires `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables.
  - No public endpoint for credential enrollment.
  - Prevents arbitrary admin creation by external requests.

### 2. DNS Rebinding & SSRF Protection

- Fixed `outbound-guard.js` to bind transport to verified IP, not just resolve-then-forward hostname.
- Validates redirects and enforces URL policy at each hop.
- Prevents DNS rebinding between check and connect phases.

### 3. Apify Budget Enforcement

- Renamed env var: `APIFY_SPEND_LIMIT_USD` → `APIFY_BUDGET_LIMIT_USD`
- Added new budget controls:
  - `APIFY_MIN_BALANCE_USD` — stop dispatch if remaining balance below threshold
  - `APIFY_INITIAL_BALANCE_USD` — for testing and demo environments
  - `APIFY_DEFAULT_RUN_COST_USD` — estimated cost per run for quota planning
- Budget now deducted before paid actions; quota checked atomically.

### 4. CORS and Allowed Origins

- Renamed env var: `CORS_ALLOWED_ORIGINS` → `ALLOWED_ORIGINS`
- Configure via comma-separated list: `http://localhost:3000,https://yourdomain.com`
- CORS does not substitute for authentication; all API routes require session/key validation.

### 5. Internal Service Authentication

- `INTERNAL_SERVICE_KEY` — shared secret for MCP bridge and internal admin routes.
- Not for user-facing API; separate from session/login credentials.
- Required for `/api/internal/*` access.

### 6. Concurrency Limits

- `MAX_CONCURRENT_RUNS` — maximum number of concurrent executions.
- Prevents resource exhaustion; coordinated with quota and rate limiting.

## Environment Variables Reference

| Variable | Purpose | Example | Required |
|---|---|---|---|
| `ADMIN_EMAIL` | Admin account email for CLI bootstrap | `admin@example.com` | Yes (for bootstrap) |
| `ADMIN_PASSWORD` | Admin account password for CLI bootstrap | (long random string) | Yes (for bootstrap) |
| `ALLOWED_ORIGINS` | CORS allowed origins (comma-separated) | `http://localhost:3000,https://app.example.com` | No (defaults to localhost) |
| `APIFY_BUDGET_LIMIT_USD` | Spend limit per deployment | `1000` | No (default: Infinity) |
| `APIFY_MIN_BALANCE_USD` | Minimum balance to allow new runs | `10` | No (default: 0) |
| `APIFY_INITIAL_BALANCE_USD` | Starting balance for demo/test | `100` | No |
| `APIFY_DEFAULT_RUN_COST_USD` | Estimated cost per run for quota | `1.0` | No (default: 1.0) |
| `INTERNAL_SERVICE_KEY` | Shared secret for internal routes | (long random string) | Yes (for internal bridge) |
| `MAX_CONCURRENT_RUNS` | Max concurrent executions | `5` | No (default: 10) |
| `APIFY_TOKEN` | Primary Apify API token | (your token) | Yes |
| `APIFY_TOKENS` | Pool of tokens for failover | (token1,token2,token3) | No |
| `CREDENTIAL_ENCRYPTION_KEY` | 32-byte base64 key for session encryption | (base64 key) | Yes (for session storage) |

**Bootstrap:** Use `npm run bootstrap:admin` to create admin account with `ADMIN_EMAIL` and `ADMIN_PASSWORD`:

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=SecurePass123 npm run bootstrap:admin
```

## Removed Public Endpoints

The following endpoints are **no longer publicly accessible**:

- ~~`POST /api/auth/bootstrap`~~ → Use `npm run bootstrap:admin` CLI instead
- ~~`POST /api/runs/:id/complete`~~ → Scheduler handles completion internally

## Test Status

**To be updated after remediation.** Test suite status is tracked on PR #19; see CI logs for current coverage. Remediation of critical findings (P0) required before merging.

## Checklist Before Merge

- [ ] P0 security findings closed (bootstrap, SSRF, budget, MCP bridge)
- [ ] P1 items addressed or deferred with documented plan
- [ ] Environment variable documentation updated in README
- [ ] `.env.example` includes all required vars with placeholders
- [ ] Admin bootstrap via CLI tested on clean DB
- [ ] CORS and internal auth tested end-to-end
- [ ] Budget enforcement verified with Apify mock
- [ ] CI passing; no new security warnings from dependency audit

## Additional Documentation

- [Internet Launch Plan 2026-09-22](./INTERNET_LAUNCH_PLAN_2026-09-22.md) — detailed security assessment and deployment phases
- [Discovery & Monitoring Plan Revised](./DISCOVERY_MONITORING_PLAN_REVISED.md) — concurrent feature scope and data model
- [PR #19 Review 2026-09-23](./PR_19_REVIEW_2026-09-23.md) — detailed findings and remediation evidence (not edited here)

## Notes

- Shared-workspace model requires all users to share the same Apify token/accounts/proxies and cookies. Suitable for a small trusted team only.
- For multi-customer deployment, implement tenant isolation in schema, query filters, and cache keys before accepting external users.
- No claims of SLA, uptime, or data protection are valid until all checklist items pass and staging deployment is validated.
