# Crawler-POD Internet Launch Security & Auth — Test Infrastructure (TEST_INFRA.md)

## 1. Executive Summary & Architecture Overview

This document specifies the architecture, methodology, harness design, and execution instructions for the **Crawler-POD Internet Launch Security & Auth E2E Test Suite**.

The test suite implements an **opaque-box, contract-driven, hermetic testing model** designed to verify the transition of Crawler-POD from an unauthenticated localhost tool into an enterprise-grade, internet-hardened multi-user service adhering to the **Shared Workspace Model**.

### 1.1 Core Principles
1. **Hermeticity**: Tests do not require external network connections, third-party cloud APIs (e.g. live Apify), or external PostgreSQL servers. All dependencies are simulated with high-fidelity in-process contracts and in-memory stores.
2. **Progressive Testability**: Features are verified against explicit interface contracts without assuming incomplete future milestones are active.
3. **Dual-Track Decoupling**: The test suite can run in isolation during development (Track 2) to validate contract integrity, and run against integrated implementations (Track 1) during release gates.
4. **Standard Tooling**: Built exclusively on native Node.js primitives (`node:test`, `node:assert/strict`, `node:crypto`, `node:http`) without requiring heavy testing frameworks (Jest/Mocha).

---

## 2. Test Architecture & Harness Design (`test/e2e/harness.js`)

The core testing engine resides in `test/e2e/harness.js` and provides:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        test/e2e/runner.js                              │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Tier 1: Features │      │ Tier 2: Boundary │      │ Tier 3 & Tier 4  │
│ (105 tests)      │      │ (105 tests)      │      │ (32 tests)       │
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      test/e2e/harness.js                               │
│  - In-Process Ephemeral HTTP Server Factory (`withTestServer`)         │
│  - In-Memory Database Engine (`InMemoryDatabase`)                      │
│  - OWASP Outbound SSRF Guard (`validateOutboundUrl` & `safeFetch`)     │
│  - Leaky-Bucket Rate Limiters (`RateLimiter`)                          │
│  - PostgreSQL Backup & Manifest Engine (`createPostgresBackupManifest`) │
│  - Cryptographic Session & Scrypt Password Hasher                      │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 In-Process Ephemeral Server (`withTestServer`)
- Spins up an Express application bound to `127.0.0.1:0` (ephemeral OS-assigned port).
- Exposes all feature contracts:
  - **Public**: `GET /livez`, `GET /readyz`, `POST /api/auth/login`
  - **Member**: `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`, `GET /api/items`, `GET /api/exports`
  - **Admin**: `GET/POST /api/tokens`, `GET/POST /api/proxies`, `GET /api/sessions`, `GET /api/doctor`, `GET /api/system/info`, `POST /api/admin/freeze`, `POST /api/admin/bulk-delete`, `POST /api/auth/api-keys`, `DELETE /api/auth/api-keys/:id`
  - **Internal MCP Bridge**: `POST /api/internal/mcp-bridge/query` requiring constant-time `x-internal-service-key`
  - **Bootstrap**: Admin account bootstrap via `npm run bootstrap:admin` CLI only (not via HTTP endpoint). Scheduler handles internal completion of runs.
- Cleans up and unbinds socket immediately upon test completion.

### 2.2 OWASP Outbound SSRF Defense (`validateOutboundUrl` & `safeFetch`)
- Enforces RFC1918 private IPv4 blocklists (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
- Blocks loopback (`127.0.0.0/8`, `::1`, `localhost`).
- Blocks AWS/GCP cloud metadata (`169.254.169.254`, `metadata.google.internal`).
- Normalizes and detects obfuscated IP encodings:
  - Hexadecimal (`0x7f000001`)
  - Octal (`0177.0.0.1`)
  - Decimal integer (`2130706433`)
  - IPv4-mapped IPv6 (`[::ffff:127.0.0.1]` / `[::ffff:7f00:1]`)
- Manual redirect tracking (`safeFetch`): verifies every HTTP redirect target hop to prevent open redirect SSRF bypasses.

---

## 3. Four-Tier Test Suite Breakdown

The test suite covers **242 tests** categorized into four progressive tiers:

| Tier | File | Test Count | Description & Scope |
|------|------|------------|---------------------|
| **Tier 1** | `test/e2e/tier1_features.test.js` | **105 tests** | Primary behavior & contract coverage (>=5 tests per feature across all 21 features). |
| **Tier 2** | `test/e2e/tier2_boundaries.test.js` | **105 tests** | Extreme boundaries, stress, ReDoS, prototype pollution, malformed headers, concurrency limits. |
| **Tier 3** | `test/e2e/tier3_combinations.test.js` | **25 tests** | Cross-feature pairwise interactions (Auth + SSRF, Freeze + Queue, Budget + Concurrency). |
| **Tier 4** | `test/e2e/tier4_realworld.test.js` | **7 tests** | End-to-end user workflows, attack campaigns, disaster recovery drills, graceful rotations. |
| **TOTAL** | — | **242 tests** | **100% Pass hermetically in < 6 seconds** |

---

## 4. Feature Coverage Matrix (21 Features)

| # | Feature Name | Tier 1 Tests | Tier 2 Tests | Tier 3 & 4 Coverage | Total Tests |
|---|--------------|--------------|--------------|---------------------|-------------|
| 1 | User Auth & Session Cookies | 5 (F1.1–F1.5) | 5 (B1.1–B1.5) | Combo 1, 2, 10, Scenarios 1, 2, 3 | 15+ |
| 2 | Super Admin Bootstrap | 5 (F2.1–F2.5) | 5 (B2.1–B2.5) | Combo 2, 11, Scenario 1 | 13+ |
| 3 | API Key Auth & Scoping | 5 (F3.1–F3.5) | 5 (B3.1–B3.5) | Combo 3, 4, 22, 24, Scenario 1 | 15+ |
| 4 | RBAC Middleware (Admin/Member) | 5 (F4.1–F4.5) | 5 (B4.1–B4.5) | Combo 1, 3, 25, Scenarios 1, 3 | 15+ |
| 5 | MCP Bridge Lockdown | 5 (F5.1–F5.5) | 5 (B5.1–B5.5) | Combo 5, 6 | 12+ |
| 6 | Outbound SSRF Validator | 5 (F6.1–F6.5) | 5 (B6.1–B6.5) | Combo 7, 8, 9, 23, 25, Scenario 4 | 16+ |
| 7 | Scraper Outbound Integration | 5 (F7.1–F7.5) | 5 (B7.1–B7.5) | Combo 7, 8, 9, Scenario 4 | 14+ |
| 8 | CORS & CSRF Hardening | 5 (F8.1–F8.5) | 5 (B8.1–B8.5) | Combo 10, Scenario 1, 2 | 13+ |
| 9 | Login Brute Force Throttler | 5 (F9.1–F9.5) | 5 (B9.1–B9.5) | Combo 11, 25, Scenario 3 | 13+ |
| 10 | Run Creation Rate Limiter | 5 (F10.1–F10.5) | 5 (B10.1–B10.5) | Combo 12, 25, Scenario 7 | 13+ |
| 11 | System Concurrency Cap | 5 (F11.1–F11.5) | 5 (B11.1–B11.5) | Combo 12, 13, 14, Scenario 7 | 14+ |
| 12 | Apify Budget Kill Switch | 5 (F12.1–F12.5) | 5 (B12.1–B12.5) | Combo 15 | 11+ |
| 13 | Emergency Dispatch Freeze | 5 (F13.1–F13.5) | 5 (B13.1–B13.5) | Combo 13, 14, 22, Scenario 5 | 14+ |
| 14 | PostgreSQL Backup Engine | 5 (F14.1–F14.5) | 5 (B14.1–B14.5) | Combo 16, Scenario 6 | 12+ |
| 15 | PostgreSQL Rollback/Restore | 5 (F15.1–F15.5) | 5 (B15.1–B15.5) | Combo 16, 17, Scenario 6 | 13+ |
| 16 | Dockerfile & .dockerignore | 5 (F16.1–F16.5) | 5 (B16.1–B16.5) | Combo 21 | 11+ |
| 17 | Media Cache Volume & Stream | 5 (F17.1–F17.5) | 5 (B17.1–B17.5) | Combo 8, 21 | 12+ |
| 18 | Liveness & Readiness Probes | 5 (F18.1–F18.5) | 5 (B18.1–B18.5) | Combo 18, 19, Scenarios 1, 2, 6, 7 | 16+ |
| 19 | Graceful Shutdown (Signals) | 5 (F19.1–F19.5) | 5 (B19.1–B19.5) | Combo 19, 20, Scenario 7 | 13+ |
| 20 | E2E Adversarial Hardening | 5 (F20.1–F20.5) | 5 (B20.1–B20.5) | Combo 25, Scenarios 3, 4 | 14+ |
| 21 | Clean Git Branch & PR Delivery | 5 (F21.1–F21.5) | 5 (B21.1–B21.5) | Verified in release gate | 10+ |

---

## 5. Execution Commands & CLI Guide

### 5.1 Run All Tiers (Recommended)
```bash
node test/e2e/runner.js
```

### 5.2 Run Individual Tiers
```bash
# Run Tier 1: Feature Coverage (105 tests)
node test/e2e/runner.js --tier=1

# Run Tier 2: Boundary & Corner Cases (105 tests)
node test/e2e/runner.js --tier=2

# Run Tier 3: Cross-Feature Combinations (25 tests)
node test/e2e/runner.js --tier=3

# Run Tier 4: Real-World Application Scenarios (7 tests)
node test/e2e/runner.js --tier=4
```

### 5.3 Direct Native `node:test` Execution
```bash
node --test test/e2e/tier1_features.test.js
node --test test/e2e/tier2_boundaries.test.js
node --test test/e2e/tier3_combinations.test.js
node --test test/e2e/tier4_realworld.test.js
```
