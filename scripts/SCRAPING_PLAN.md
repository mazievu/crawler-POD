# Toidispy CDP Scraping Script
# Tích hợp SearXNG → Toidispy → Data collection

## TOIDISPY FEATURE MAP

### 📌 Posts Section (`/posts`)
**Filters:**
- Keywords: Free text search
- Page ID/Domain/Pixel: Specific identifiers
- Platforms: 22 platforms (TeeChip, Viralstyle, Shopify, Amazon, Etsy...)
- Categories: T-shirt, Hoodie, Mug, Sticker, Poster, Phone case...
- Created: Date range
- Following: Checkbox
- Reactions min: Minimum likes filter
- Sort: Latest, Trending, Newest, Oldest, Reaction, Comment, Share, Today Engagement

**Data per card:**
- Author name, Created time, Ad badge
- 👍 Reactions, 💬 Comments, 🔄 Shares
- Domain/shop name, Facebook Page ID
- Facebook Pixel ID, GTM ID, Google Ads ID

### 📌 Ads Library Section (`/libraries`)
**Filters:**
- Keywords: Free text search
- Page ID/Domain/Pixel: Specific identifiers
- Platforms: Same 22 platforms
- Categories: Same categories
- Created: Date range
- Following: Checkbox
- Adset number: Minimum adsets running
- Type: Photo/Video
- Status: Active/Inactive
- Sort: Latest, Created Time, Started Time, Total Adset, Today Adset

**Data per card:**
- Page name, Created time, Hide button
- Ad count (e.g., "1 Ad", "3 Ads")
- Ad ID
- Domain/shop name
- Facebook Page ID
- Ad account name

---

## SEARXNG INTEGRATION

### Search Queries for URL Discovery
```
1. "{keyword}" site:facebook.com/ads/library → Facebook Ads URLs
2. "{keyword}" shopify → Shopify store URLs
3. "{keyword}" tiktok shop → TikTok shop URLs
4. "{keyword}" etsy → Etsy product URLs
5. "{keyword}" instagram shop → Instagram shop URLs
```

### SearXNG API
```
GET http://localhost:20128/search?q={query}&format=json
```

---

## CDP SCRAPING SCRIPTS

### Script 1: Posts Scraping
```javascript
// Navigate to toidispy.com/posts
// Fill keyword
// Click Search
// Wait for results
// Scrape all cards with:
//   - author, time, isAd, reactions, comments, shares
//   - domain, pageId, pixelId, gtmId, googleAdsId
//   - imageUrl
// Save to database
```

### Script 2: Ads Library Scraping
```javascript
// Navigate to toidispy.com/libraries
// Fill keyword
// Click Search
// Wait for results
// Scrape all cards with:
//   - pageName, createdTime, adCount, adId
//   - domain, pageId, adAccount
//   - status (active/inactive)
//   - type (photo/video)
// Save to database
```

### Script 3: Multi-Keyword Batch
```javascript
// Read keywords from config
// For each keyword:
//   1. Search Posts
//   2. Search Ads Library
//   3. Save to database
//   4. Wait 2-3 seconds between searches
```

---

## DATABASE SCHEMA

### toidispy_posts
- id, keyword, author, domain, page_id
- reactions, comments, shares, is_ad
- image_url, created_time, scraped_at

### toidispy_ads
- id, keyword, page_name, domain, page_id
- ad_id, ad_count, ad_type, status
- created_time, scraped_at

### searxng_results
- id, keyword, query, url, title, content
- engine, score, scraped_at

---

## WORKFLOW

1. **User Input:** keyword
2. **SearXNG Discovery:** Find URLs across platforms
3. **Toidispy Posts:** Scrape Facebook posts/ads data
4. **Toidispy Ads Library:** Scrape active ad campaigns
5. **Data Merge:** Combine all sources into unified view
6. **Snapshot:** Save for growth tracking
7. **UI Display:** Show cards with engagement metrics
