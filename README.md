# 🚀 Apify Collector

Multi-platform data collection dashboard with free-first scraping paths and Apify fallback support.

## Supported Platforms

| Platform | Actor | Description |
|----------|-------|-------------|
| 📘 Facebook Posts | `apify/facebook-posts-scraper` | Scrape posts from Facebook pages |
| 👥 Facebook Groups | `apify/facebook-groups-scraper` | Scrape posts from Facebook groups |
| 📢 Facebook Ads | `apify/facebook-ads-scraper` | Scrape ads from Meta Ad Library |
| 🎵 TikTok Ads | `crawlerbros/tiktok-ads-library-scraper-pro` | Scrape TikTok Ad Library |
| 🛒 TikTok Shop | `clockworks/tiktok-scraper` | Scrape TikTok Shop products |
| 📌 Pinterest | `epctex/pinterest-scraper` | Scrape Pinterest pins and boards |
| 🧡 Etsy | `epctex/etsy-scraper` | Scrape Etsy product listings |
| 📦 Amazon | `apify/amazon-product-scraper` | Scrape Amazon product data |
| 🔴 Reddit | `apify/reddit-scraper` | Scrape Reddit posts and comments |
| 🛍️ Google Shopping | `epctex/google-shopping-scraper` | Scrape Google Shopping results |
| 🏪 Shopify | `gluon-jurcak/shopify-scraper` | Scrape Shopify store products |

## Setup

### 1. Install dependencies
```bash
cd "D:\tools GTF\apify-collector"
npm install
```

### 2. Configure environment
```bash
copy .env.example .env
```
Apify is optional for legacy actor fallback. Free-first discovery uses local SearXNG and CDP:
```
SEARXNG_URL=http://localhost:8888
CDP_URL=http://localhost:9222
```
Set `APIFY_TOKEN` when using normal dashboard submissions through `/api/runs`.
The local free-first probes, SearXNG discovery scripts, and Toidispy CDP flow
can run without it, but dashboard run routing has not yet been fully moved off
Apify actors.

### Marketplace HTML capture

Amazon, eBay, and Etsy can use an optional Playwright browser storage-state
export for an authenticated capture. Set a unique encryption key before saving
any session in **Marketplace Accounts**:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put the generated value in `.env` as `CREDENTIAL_ENCRYPTION_KEY`. The app stores
the browser state and captured HTML encrypted; it does not store raw passwords.
Use **Capture HTML** to save a rendered product page and receive normalized
price, rating, review-count, availability, image, and listing-ID data.

To create the browser-state export interactively, run the local helper and sign
in in the browser it opens:

```bash
node scripts/save-marketplace-session.js amazon "US research account"
```

### 3. Run
```bash
npm start
```

`npm start` auto-starts local dependencies:
- SearXNG on `http://localhost:8888` via Docker if it is not already running. The container is bound to `127.0.0.1` and generated with JSON output enabled.
- A visible Chrome/Edge/Chromium CDP browser on `http://localhost:9222` for Toidispy login/session scraping.

To check the local runtime:
```bash
npm run doctor
```
The doctor follows the Agent-Reach-style capability model: each platform has
ordered free/local/login backends first and paid API fallbacks last. It reports
the currently active backend plus any paid fallback candidates.

To run the Express server without starting local scraping dependencies:
```bash
npm run server
```

### 4. Open dashboard
http://localhost:3000

## Docker (recommended for LAN use)

Docker Compose runs the collector and an internal SearXNG instance. SQLite data is
kept in the `collector_data` Docker volume; images remain remote URLs in the
database and are not stored as files.

```bash
copy .env.example .env
# Edit .env: set APIFY_TOKEN and replace SEARXNG_SECRET.
docker compose up --build -d
```

Open `http://<LAN-IP>:9999`. Change `HOST_PORT` in `.env` before starting if
port 9999 is already in use. SearXNG is available only to the collector service,
not published to the LAN.

For a locally running Chrome/CloakBrowser CDP profile, set `DOCKER_CDP_URL` to
`http://host.docker.internal:9222`; keep CDP private and do not publish port 9222.

```bash
docker compose ps
docker compose logs -f collector
docker compose down
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/platforms` | List all platforms |
| GET | `/api/jobs` | List jobs (filter: `?status=done&platform=amazon`) |
| GET | `/api/jobs/:id` | Get job with items |
| POST | `/api/jobs` | Create new job |
| DELETE | `/api/jobs/:id` | Delete job |
| GET | `/api/stats` | Get statistics |
| GET | `/api/export/:jobId` | Export job data as JSON |

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (via better-sqlite3)
- **Scraping**: Free-first scrapers, SearXNG discovery, Toidispy CDP, Apify fallback
- **Frontend**: Vanilla JS (no framework)

## Agent-Reach pattern adopted

See `docs/AGENT_REACH_LEARNINGS.md`. The collector now keeps a capability
registry so adding a new platform means adding ordered backends and probes,
then verifying real data, instead of defaulting straight to paid APIs.
"# crawler-POD" 
