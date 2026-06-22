# Architecture — Apify Collector

**Version:** 1.0.0
**Date:** 2026-06-21

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (Frontend)                       │
│  index.html + style.css + app.js                            │
│  Vanilla JS, no build step                                  │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP (fetch API)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                     Express Server                           │
│  server.js — Routes + Static files                          │
├─────────────────────────────────────────────────────────────┤
│  src/database.js     │ SQLite CRUD (better-sqlite3)         │
│  src/platform-config │ Platform definitions (11 platforms)  │
│  src/apify-client.js │ Apify API wrapper                    │
└──────────┬──────────┴───────────────┬───────────────────────┘
           │                          │
           ▼                          ▼
    ┌─────────────┐          ┌─────────────────┐
    │  SQLite DB  │          │   Apify Cloud    │
    │  (local)    │          │   (REST API)     │
    └─────────────┘          └─────────────────┘
```

## 2. Data Flow

### 2.1 Create Job Flow

```
User fills form
       │
       ▼
Browser: POST /api/jobs { platform, query, options }
       │
       ▼
Express: validate platform → save job to DB (status=pending)
       │
       ▼
Express: call Apify API → start actor with input
       │
       ▼
Express: get runId + datasetId → update job (status=running)
       │
       ▼
Express: return job to browser
       │
       ▼
Browser: start polling GET /api/jobs/:id every 3s
```

### 2.2 Poll Status Flow

```
Browser: GET /api/jobs/:id (every 3s)
       │
       ▼
Express: read job from DB
       │
       ▼
If status=running:
  │
  ├── Call Apify API: GET /runs/{runId}
  │
  ├── If RUNNING → return job (status=running)
  │
  ├── If SUCCEEDED:
  │     ├── Call Apify API: GET /datasets/{datasetId}/items
  │     ├── Save items to DB
  │     └── Update job (status=done, items_count=N)
  │
  └── If FAILED/ABORTED:
        └── Update job (status=failed, error_message=...)
       │
       ▼
Browser: update UI based on status
```

## 3. Module Responsibilities

### 3.1 server.js
- Express app setup (CORS, JSON, static files)
- Route definitions (7 endpoints)
- Request validation
- Error handling middleware

### 3.2 src/database.js
- SQLite connection management
- Schema initialization (CREATE TABLE IF NOT EXISTS)
- CRUD operations:
  - `getAllPlatforms()` → Platform[]
  - `createJob(data)` → Job
  - `getJobById(id)` → Job
  - `getAllJobs(limit)` → Job[]
  - `updateJob(id, data)` → void
  - `deleteJob(id)` → void
  - `insertItems(jobId, items)` → void
  - `getItemsByJobId(jobId)` → Item[]
  - `getStats()` → { totalJobs, totalItems }

### 3.3 src/platform-config.js
- Platform definitions array (11 platforms)
- Each platform: name, displayName, description, queryType, actorId, countrySupport, icon, color
- Export: `PLATFORMS` array, `getPlatform(name)` helper

### 3.4 src/apify-client.js
- ApifyClient initialization with token
- `startActor(platform, input)` → { runId, datasetId }
- `getRunStatus(runId)` → { status }
- `getDatasetItems(datasetId, limit)` → Item[]
- INPUT_BUILDERS: per-platform input formatting functions

### 3.5 public/app.js
- DOM event bindings
- API calls (fetch wrapper)
- UI rendering functions:
  - `renderPlatformOptions(platforms)`
  - `renderJobsList(jobs)`
  - `renderJobDetail(job)`
- Job polling logic (setInterval)
- Helper functions (getPlatformIcon, escapeHtml, etc.)

### 3.6 public/style.css
- CSS custom properties (design tokens)
- Layout (header, main grid, panels)
- Components (buttons, cards, badges, modals)
- Platform-specific colors
- Responsive breakpoints

## 4. Design Decisions

### D-1: SQLite over PostgreSQL
**Decision:** Use SQLite (better-sqlite3) for local storage
**Reason:** Zero-config, file-based, single-user tool, no server needed
**Trade-off:** No concurrent access, limited query capabilities

### D-2: Vanilla JS over Framework
**Decision:** No frontend framework (React, Vue, etc.)
**Reason:** No build step, instant load, simple debugging, single-user app
**Trade-off:** More DOM manipulation code, no component reuse

### D-3: Polling over WebSocket
**Decision:** Poll status every 3 seconds instead of WebSocket
**Reason:** Simpler implementation, sufficient for single-user, Apify doesn't push events
**Trade-off:** 3-second delay in status updates, more HTTP requests

### D-4: JSON Export only
**Decision:** Export as JSON only, no CSV
**Reason:** JSON is native format, preserves data structure, simpler to implement
**Trade-off:** Users need tools to convert JSON to other formats

### D-5: No Authentication
**Decision:** No auth/login system
**Reason:** Single-user, local-only, localhost only
**Trade-off:** Anyone on the machine can access (acceptable risk)

### D-6: Raw Data as JSON String
**Decision:** Store Apify items as JSON string in SQLite TEXT column
**Reason:** Flexible schema, no need to normalize, Apify items vary by platform
**Trade-off:** Harder to query specific fields, larger storage

## 5. Security Considerations

- **API Token:** Stored in .env, never in source code
- **XSS Prevention:** All user input escaped before DOM insertion
- **SQL Injection:** All queries use prepared statements (better-sqlite3 default)
- **CORS:** Only enabled for development (localhost:3000)
- **No External Exposure:** Server binds to localhost only

## 6. Scalability Notes

This is a **single-user, local-first** tool. Not designed for:
- Multiple concurrent users
- Large-scale data collection (10K+ items)
- Production deployment

If scaling needed:
- Add PostgreSQL for concurrent access
- Add WebSocket for real-time updates
- Add authentication and rate limiting
- Deploy to cloud with proper infrastructure
