# 🚀 Apify Collector

Multi-platform data collection dashboard powered by Apify.

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

### 2. Configure Apify token
```bash
copy .env.example .env
```
Edit `.env` and add your Apify API token:
```
APIFY_TOKEN=your_token_here
```
Get your token at: https://console.apify.com/account/integrations

### 3. Run
```bash
npm start
```

### 4. Open dashboard
http://localhost:3000

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
- **Scraping**: Apify Client
- **Frontend**: Vanilla JS (no framework)
