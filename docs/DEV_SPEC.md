# Development Specification — Apify Collector

**Version:** 1.0.0
**Date:** 2026-06-21

---

## 1. Tech Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Runtime | Node.js | 22.x | Server runtime |
| Framework | Express.js | 4.x | HTTP server |
| Database | SQLite | 3.x | Local data storage |
| DB Driver | better-sqlite3 | latest | SQLite binding |
| Frontend | Vanilla JS | ES6+ | No framework dependency |
| Styling | Custom CSS | - | Dark theme |
| API Client | apify-client | latest | Apify API integration |
| Config | dotenv | latest | Environment variables |

**Why this stack:**
- **Node.js + Express:** Lightweight, fast to develop, no build step needed
- **SQLite + better-sqlite3:** Zero-config, file-based, synchronous (simpler code)
- **Vanilla JS:** No framework overhead, instant load, easy to debug
- **No TypeScript:** Single-user internal tool, simplicity > type safety

## 2. Project Structure

```
apify-collector/
├── server.js                  # Express entry point, route definitions
├── package.json               # Dependencies and scripts
├── .env.example               # Environment template
├── .env                       # Local config (gitignored)
│
├── src/
│   ├── database.js            # SQLite connection, schema, CRUD helpers
│   ├── platform-config.js     # Platform definitions (name, actor, color, etc.)
│   └── apify-client.js        # Apify API wrapper, input builders per platform
│
├── public/
│   ├── index.html             # Main HTML (dashboard + modal)
│   ├── style.css              # All styles (dark theme)
│   └── app.js                 # Frontend logic, API calls, DOM manipulation
│
├── data/
│   └── collector.db           # SQLite database (auto-created)
│
├── docs/
│   ├── REQUIREMENTS.md        # Product requirements
│   ├── DEV_SPEC.md            # This file
│   ├── ARCHITECTURE.md        # System architecture
│   ├── UI_DESIGN.md           # UI/UX design specs
│   ├── NAMING_CONVENTIONS.md  # Naming rules
│   └── API_SPEC.md            # REST API specification
│
└── README.md                  # Project overview
```

## 3. Database Schema

### 3.1 Table: `platforms`

```sql
CREATE TABLE platforms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,          -- e.g. 'facebook_posts'
  display_name TEXT NOT NULL,          -- e.g. 'Facebook Posts'
  description TEXT,                    -- e.g. 'Scrape organic posts from Facebook'
  query_type TEXT DEFAULT 'keyword',  -- 'keyword' | 'url'
  actor_id TEXT NOT NULL,             -- e.g. 'apify/facebook-posts-scraper'
  country_support INTEGER DEFAULT 0,  -- 0=no, 1=yes
  icon TEXT DEFAULT '🔗',             -- emoji icon
  color TEXT DEFAULT '#888888'        -- hex color for UI
);
```

### 3.2 Table: `jobs`

```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,              -- FK → platforms.name
  query TEXT NOT NULL,                 -- keyword or URL
  status TEXT DEFAULT 'pending',       -- pending | running | done | failed
  apify_run_id TEXT,                   -- Apify run ID for polling
  apify_dataset_id TEXT,               -- Apify dataset ID for fetching items
  items_count INTEGER DEFAULT 0,       -- total items collected
  error_message TEXT,                  -- error details if failed
  max_items INTEGER DEFAULT 100,       -- max items to collect
  country TEXT,                        -- country code (optional)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3.3 Table: `items`

```sql
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,             -- FK → jobs.id
  raw_data TEXT NOT NULL,              -- JSON string of collected item
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
```

## 4. API Endpoints

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|--------------|----------|
| GET | `/api/platforms` | List all platforms | - | `Platform[]` |
| GET | `/api/jobs` | List jobs (newest first) | - | `Job[]` |
| GET | `/api/jobs/:id` | Get job detail + items | - | `Job + Item[]` |
| POST | `/api/jobs` | Create new job | `{platform, query, options}` | `Job` |
| DELETE | `/api/jobs/:id` | Delete job + items | - | `{success: true}` |
| GET | `/api/export/:jobId` | Export job data | - | JSON file download |
| GET | `/api/stats` | Get total jobs/items | - | `{totalJobs, totalItems}` |

**See `docs/API_SPEC.md` for full request/response examples.**

## 5. Apify Integration Flow

```
1. User fills form → clicks Start
2. Frontend POST /api/jobs { platform, query, options }
3. Backend saves job (status=pending) to SQLite
4. Backend calls Apify API to start actor:
   - Uses INPUT_BUILDERS[platform] to format input
   - Gets runId and datasetId from Apify response
   - Updates job status=running, saves apifyRunId
5. Frontend polls GET /api/jobs/:id every 3 seconds
6. Backend checks Apify run status:
   - RUNNING → return status=running
   - SUCCEEDED → fetch items from dataset, save to SQLite, status=done
   - FAILED/ABORTED → save error message, status=failed
7. Frontend shows result when status=done/failed
```

## 6. Actor Mapping

Each platform maps to a specific Apify Actor. The actor defines the input format.

| Platform | Actor | Input Builder |
|----------|-------|---------------|
| facebook_posts | `apify/facebook-posts-scraper` | `{ startUrls, maxItems }` |
| facebook_groups | `apify/facebook-groups-scraper` | `{ startUrls, maxItems }` |
| facebook_ads | `apify/facebook-ads-scraper` | `{ startUrls, maxItems }` |
| tiktok_ads | `crawlerbros/tiktok-ads-library-scraper-pro` | `{ searchTerms, maxItems }` |
| tiktok_shop | `clocklink/tiktok-shop-scraper` | `{ searchTerms, maxItems }` |
| pinterest | `epctex/pinterest-scraper` | `{ searchTerms, maxItems }` |
| etsy | `apify/etsy-scraper` | `{ searchTerms, maxItems }` |
| amazon | `apify/amazon-scraper` | `{ searchTerms, maxItems }` |
| reddit | `apify/reddit-scraper` | `{ searchTerms, maxItems }` |
| google_shopping | `streamr/google-shopping-scraper` | `{ searchTerms, maxItems }` |
| shopify | `apify/shopify-scraper` | `{ startUrls, maxItems }` |

## 7. Dependencies

```json
{
  "apify-client": "^2.9.0",
  "better-sqlite3": "^11.0.0",
  "cors": "^2.8.5",
  "dotenv": "^16.4.0",
  "express": "^4.18.0"
}
```

## 8. Environment Variables

```env
APIFY_TOKEN=your_apify_api_token_here
PORT=3000
```

## 9. Scripts

```json
{
  "start": "node server.js",
  "dev": "node --watch server.js"
}
```

## 10. Error Handling Strategy

| Error Type | Handling |
|------------|----------|
| Apify token missing | Return 500 with clear message |
| Invalid platform | Return 400 "Unknown platform" |
| Apify API error | Log error, update job status=failed, return error |
| Apify rate limit | Return 429 with retry-after info |
| Missing query | Return 400 "Query is required" |
| Job not found | Return 404 "Job not found" |
| DB error | Log error, return 500 "Database error" |

## 11. Development Rules

### Code Style
- **No TypeScript:** Plain JavaScript (ES modules not used, CommonJS)
- **Immutability:** Use spread operator, never mutate objects directly
- **Error handling:** Every async call wrapped in try/catch
- **No console.log in production:** Use console.error for errors
- **Functions < 50 lines:** Extract helpers when functions grow
- **No nested callbacks:** Use async/await

### Git Conventions
- Commit format: `<type>: <description>`
- Types: feat, fix, docs, style, refactor, test
- One logical change per commit

### Testing
- Manual testing via browser
- API testing via curl or browser devtools
- No automated test framework (single-user internal tool)
