# Naming Conventions — Apify Collector

**Version:** 1.0.0
**Date:** 2026-06-21

---

## 1. File Naming

| Type | Convention | Example |
|------|-----------|---------|
| JS modules | `kebab-case.js` | `apify-client.js`, `platform-config.js` |
| HTML files | `kebab-case.html` | `index.html` |
| CSS files | `kebab-case.css` | `style.css` |
| Docs | `UPPER_SNAKE_CASE.md` | `REQUIREMENTS.md`, `DEV_SPEC.md` |
| Config | `lowercase` | `package.json`, `.env` |

## 2. Database

### Table Names
- Plural, lowercase: `platforms`, `jobs`, `items`

### Column Names
- snake_case: `created_at`, `apify_run_id`, `query_type`, `items_count`, `raw_data`

## 3. JavaScript — Backend

### Variables
- camelCase: `platformConfig`, `apifyClient`, `jobData`
- Boolean: `is` prefix: `isValid`, `isLoading`
- Constants: UPPER_SNAKE_CASE for true constants: `APIFY_TOKEN`, `DEFAULT_PORT`

### Functions
- Verb-noun pattern: `createJob()`, `getJobById()`, `getAllPlatforms()`
- Boolean returns: `isValidPlatform()`, `hasToken()`
- Async prefix: `startActor()`, `fetchDatasetItems()`

### Module Exports
- Named exports: `exports.createJob = ...`
- No default exports (CommonJS)

## 4. JavaScript — Frontend

### Variables
- camelCase: `currentJobId`, `pollInterval`, `statusBar`
- DOM references: descriptive names: `platformSelect`, `queryInput`, `startBtn`

### Functions
- Event handlers: `onPlatformChange()`, `onQueryInput()`
- Render functions: `renderJobsList()`, `renderJobDetail()`, `renderPlatformOptions()`
- API calls: `loadPlatforms()`, `loadJobs()`, `loadStats()`
- Actions: `startJob()`, `openJob()`, `closeModal()`, `exportJob()`, `deleteJob()`
- Helpers: `getPlatformIcon()`, `getPlatformColor()`, `escapeHtml()`, `setButtonLoading()`

### DOM IDs
- kebab-case: `platform-select`, `query-input`, `max-items`, `start-btn`
- Modal: `detail-modal`, `modal-title`, `modal-close`, `modal-info`, `modal-items`
- Status: `job-status`, `status-text`

### CSS Classes
- kebab-case: `.job-card`, `.job-platform`, `.job-status-badge`
- BEM-like for components: `.job-card`, `.job-info`, `.job-query`, `.job-meta`
- State classes: `.running`, `.done`, `.failed`, `.pending`
- Platform classes: `.facebook`, `.tiktok`, `.pinterest`, etc.

## 5. API

### Endpoints
- kebab-case, plural nouns: `/api/jobs`, `/api/platforms`
- ID parameter: `/api/jobs/:id`
- Nested: `/api/export/:jobId`

### Request Body
- camelCase: `{ platform, query, options: { maxItems, country } }`

### Response Fields
- camelCase: `{ id, platform, status, itemsCount }`

## 6. Platform Identifiers

Internal names (used in code, DB, API):
```
facebook_posts
facebook_groups
facebook_ads
tiktok_ads
tiktok_shop
pinterest
etsy
amazon
reddit
google_shopping
shopify
```

Display names (shown in UI):
```
Facebook Posts
Facebook Groups
Facebook Ads
TikTok Ads
TikTok Shop
Pinterest
Etsy
Amazon
Reddit
Google Shopping
Shopify
```

## 7. CSS Custom Properties

Prefix with `--`, lowercase kebab-case:
```css
--bg-primary
--bg-secondary
--bg-card
--bg-input
--border
--text-primary
--text-secondary
--text-muted
--accent
--accent-hover
--success
--warning
--danger
--radius
--radius-sm
--transition
```

## 8. JSON Format

### API Response (Standard)
```json
{
  "key1": "value1",
  "key2": 123,
  "nestedKey": { ... }
}
```

### API Response (Error)
```json
{
  "error": "Error message here"
}
```
