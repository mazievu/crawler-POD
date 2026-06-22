# API Specification — Apify Collector

**Version:** 1.0.0
**Date:** 2026-06-21
**Base URL:** `http://localhost:3000`

---

## 1. GET /api/platforms

List all supported platforms.

**Response:**
```json
[
  {
    "id": 1,
    "name": "facebook_posts",
    "display_name": "Facebook Posts",
    "description": "Scrape organic posts from Facebook pages and groups",
    "query_type": "url",
    "actor_id": "apify/facebook-posts-scraper",
    "country_support": 0,
    "icon": "📘",
    "color": "#4599ff"
  }
]
```

---

## 2. GET /api/jobs

List all jobs, newest first.

**Response:**
```json
[
  {
    "id": 1,
    "platform": "facebook_posts",
    "query": "https://facebook.com/nike",
    "status": "done",
    "apify_run_id": "abc123",
    "apify_dataset_id": "xyz789",
    "items_count": 45,
    "error_message": null,
    "max_items": 100,
    "country": null,
    "created_at": "2026-06-21T03:30:00.000Z",
    "updated_at": "2026-06-21T03:31:30.000Z"
  }
]
```

---

## 3. GET /api/jobs/:id

Get job detail with items.

**Response:**
```json
{
  "id": 1,
  "platform": "facebook_posts",
  "query": "https://facebook.com/nike",
  "status": "done",
  "apify_run_id": "abc123",
  "apify_dataset_id": "xyz789",
  "items_count": 45,
  "error_message": null,
  "max_items": 100,
  "country": null,
  "created_at": "2026-06-21T03:30:00.000Z",
  "updated_at": "2026-06-21T03:31:30.000Z",
  "items": [
    {
      "id": 1,
      "job_id": 1,
      "raw_data": "{\"text\":\"Great post about shoes...\",\"likes\":123}",
      "created_at": "2026-06-21T03:31:30.000Z"
    }
  ]
}
```

---

## 4. POST /api/jobs

Create a new scraping job.

**Request:**
```json
{
  "platform": "facebook_posts",
  "query": "https://facebook.com/nike",
  "options": {
    "maxItems": 100,
    "country": "US"
  }
}
```

**Validation:**
- `platform` (required): Must be a valid platform name
- `query` (required): Non-empty string
- `options.maxItems` (optional): Integer, default 100
- `options.country` (optional): Country code string

**Response (201):**
```json
{
  "id": 1,
  "platform": "facebook_posts",
  "query": "https://facebook.com/nike",
  "status": "pending",
  "apify_run_id": null,
  "apify_dataset_id": null,
  "items_count": 0,
  "error_message": null,
  "max_items": 100,
  "country": "US",
  "created_at": "2026-06-21T03:30:00.000Z",
  "updated_at": "2026-06-21T03:30:00.000Z"
}
```

**Error (400):**
```json
{
  "error": "Platform and query are required"
}
```

**Error (400):**
```json
{
  "error": "Unknown platform: invalid_platform"
}
```

---

## 5. DELETE /api/jobs/:id

Delete a job and all its items.

**Response:**
```json
{
  "success": true
}
```

**Error (404):**
```json
{
  "error": "Job not found"
}
```

---

## 6. GET /api/export/:jobId

Export job data as downloadable JSON file.

**Response:** JSON file download
```json
{
  "job": {
    "id": 1,
    "platform": "facebook_posts",
    "query": "https://facebook.com/nike",
    "status": "done",
    "items_count": 45,
    "created_at": "2026-06-21T03:30:00.000Z"
  },
  "items": [
    { "text": "...", "likes": 123 },
    { "text": "...", "likes": 456 }
  ]
}
```

**Error (404):**
```json
{
  "error": "Job not found"
}
```

---

## 7. GET /api/stats

Get total jobs and items count.

**Response:**
```json
{
  "totalJobs": 12,
  "totalItems": 345
}
```

---

## 8. Error Response Format

All errors follow this format:
```json
{
  "error": "Human-readable error message"
}
```

| HTTP Status | Meaning |
|-------------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad request (validation error) |
| 404 | Resource not found |
| 500 | Internal server error |
