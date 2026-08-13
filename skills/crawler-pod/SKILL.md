---
name: crawler-pod-intelligence
description: Query the POD Intelligence capability layer for e-commerce, social, and ad data.
---

# Crawler-POD Intelligence Skill

This skill allows agents to programmatically query the `crawler-POD` system. The system uses a dynamic Backend Router to fetch data across various channels (Facebook Ads, Shopify, Pinterest, etc.) via Apify, local scrapers, or CDP scripts.

## Capabilities

1. **Check System Health (Doctor)**
   - API: `GET /api/doctor?json=true`
   - Purpose: Determine which channels and backends are currently healthy and available.

2. **Trigger Intelligence Run**
   - API: `POST /api/runs`
   - Body:
     ```json
     {
       "platform": "<channel_name>",
       "query": "<search_keyword_or_url>",
       "options": {
         "maxItems": 50,
         "country": "US"
       }
     }
     ```
   - Purpose: Start a scraping job.
   - Returns: Run metadata (including `id`).

3. **Check Run Status**
   - API: `GET /api/runs/:id`
   - Purpose: Poll until `status` becomes `done` or `failed`.

4. **Retrieve Normalized Items**
   - API: `GET /api/runs/:id` (contains `snapshots`)
   - Alternatively: `GET /api/items` for latest across all.
   - Purpose: Get normalized intelligence items (products, ads, posts).

## Usage Instructions

- **When to use**: Whenever you need structured data about competitors, products, ads, or social trends.
- **Workflow**:
  1. Always run the `Doctor` endpoint first to ensure the requested platform is healthy.
  2. Start a run via `POST /api/runs`.
  3. Poll `GET /api/runs/:id` every 3-5 seconds.
  4. Once done, read the `snapshots` array from the run object.
