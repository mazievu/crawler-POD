# Anti-Bot Scraping Plan: 14 Nền Tảng Free

**Status:** Planning  
**Date:** 2026-06-23  
**Target:** Thay thế hoàn toàn Apify paid actors → scraping free + tự động

---

## 1. Tổng Quan Chiến Lược

### 1.1 Nguyên Tắc
- **Free API trước → Playwright stealth sau → Fallback CDP**
- **Proxy rotation + fingerprint spoofing** cho nền tảng khó
- **Vòng lặp auto-retry**: code → test → detect block → fix → retry
- **Logging đầy đủ**: detect chính xác block reason (captcha, rate limit, fingerprint)

### 1.2 Tech Stack Scraping
```
Layer              Technology
────────────────────────────────────────────────────
HTTP Client        axios + axios-retry + got-scraping
Playwright         playwright + playwright-extra + puppeteer-extra-plugin-stealth
Proxy              rotating proxies (free: pubProxy, paid: brightdata/oxylabs)
Fingerprint        playwright-extra-stealth + fingerprint-injector
CAPTCHA            captcha-solving (2captcha, capsolver) — only khi forced
Data Extraction    cheerio (HTML) + JSON.parse (API)
DB                 SQLite (giữ nguyên)
```

---

## 2. Phân Tích Từng Nền Tảng

### 2.1 Facebook Posts (danek/facebook-search-ppr — PAID)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🔴 RẤT CAO — Meta có fingerprinting, rate limit, IP block |
| Free API | ❌ Graph API chỉ cho page/content bạn own, không search |
| Playwright | ⚠️ Cần Facebook account + proxy + stealth plugin |
| CDP (Toidispy) | ✅ **ĐÃ CÓ — free, không cần thay thế** |
| **Khả thi free?** | 🟢 CÓ — qua Toidispy CDP (đã chạy) |

**Chiến lược:** Giữ nguyên Toidispy CDP. Không cần Apify.

### 2.2 Facebook Ads (apify/facebook-ads-scraper — FREE/Pay-per-event)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🟡 TRUNG BÌNH — Meta Ad Library ít chặt hơn |
| Free API | ✅ **Meta Ad Library API — hoàn toàn miễn phí** |
| Playwright | ✅ Có thể scrape https://www.facebook.com/ads/library |
| CDP (Toidispy) | ✅ **ĐÃ CÓ — qua Ads Library section** |
| **Khả thi free?** | 🟢 CÓ — dùng Meta Ad Library API hoặc Toidispy |

**Chiến lược:** Toidispy CDP (đã có) + Meta Ad Library API làm fallback.

### 2.3 Facebook Groups (hiện chưa có trong code)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🔴 RẤT CAO |
| Free API | ❌ |
| **Khả thi free?** | 🔴 CẦN Facebook account + proxy |

### 2.4 Pinterest (automation-lab/pinterest-scraper — FREE-ish)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🟡 TRUNG BÌNH |
| Free API | ✅ **Pinterest API (free tier) — 10 calls/sec** |
| Playwright | ✅ Có thể scrape với stealth |
| **Khả thi free?** | 🟢 CÓ — dùng Pinterest API free |

```javascript
// Pinterest API — free, không cần proxy
GET https://api.pinterest.com/v5/search/pins?query={keyword}
Headers: Authorization: Bearer {access_token}
```

### 2.5 Amazon (automation-lab/amazon-scraper — FREEish)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🔴 RẤT CAO — Amazon có Captcha, fingerprint, IP tracking |
| Free API | ❌ Product Advertising API (limited, chỉ affiliate) |
| Playwright | 🟡 Cần proxy + stealth + user-agent rotation + delay 3-5s |
| **Khả thi free?** | 🟡 KHÓ — cần proxy pool + fingerprint rotation |

**Chiến lược:**
1. Playwright stealth với proxy rotation
2. Dùng `got-scraping` cho HTTP requests cơ bản
3. Fallback: serpapi (paid) hoặc giữ Apify actor

### 2.6 Reddit (automation-lab/reddit-scraper — FREE)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🟢 THẤP — Reddit thoáng |
| Free API | ✅ **Reddit API hoàn toàn free — 60 req/min** |
| Playwright | ✅ Quá dễ |
| **Khả thi free?** | 🟢 CÓ — cực kỳ dễ |

```javascript
// Reddit API — free, 60 requests/minute
GET https://www.reddit.com/search.json?q={keyword}&limit=100
Headers: User-Agent: "Mozilla/5.0..."
```

### 2.7 Google Shopping (automation-lab/google-shopping-scraper — FREE)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🟡 CAO — Google chống scraping mạnh |
| Free API | ❌ Google Shopping API không public |
| Playwright | 🟡 Cần stealth + proxy |
| **Khả thi free?** | 🟡 CÓ THỂ — dùng Playwright với stealth |

**Chiến lược:** Playwright stealth + google-chrome thật + delay.

### 2.8 Shopify (automation-lab/shopify-scraper — FREE)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🟢 THẤP — Shopify stores thường public data |
| Free API | ✅ **Shopify Storefront API (free, không cần token cho public products)** |
| Playwright | ✅ Dễ |
| **Khả thi free?** | 🟢 CÓ — cực kỳ dễ |

```javascript
// Shopify Storefront API — free
POST https://{store}.myshopify.com/api/2024-01/graphql.json
Body: { query: "{ products(first: 50) { edges { node { title priceRange } } } }" }
```

### 2.9 TikTok Shop (clockworks/tiktok-scraper — PAID)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🔴 RẤT CAO — TikTok fingerprinting + device ID |
| Free API | ❌ |
| Playwright | 🟡 Cần mobile emulation + proxy |
| **Khả thi free?** | 🟡 KHÓ — cần fingerprint injection |

**Chiến lược:** Playwright mobile emulation + `playwright-extra-stealth` + proxy.  
Fallback: giữ Apify actor (chỉ khi thực sự cần).

### 2.10 Etsy (epctex/etsy-scraper — PAID)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🟡 TRUNG BÌNH |
| Free API | ✅ **Etsy API (free tier) — 10 requests/sec, 10K listings/day** |
| Playwright | ✅ |
| **Khả thi free?** | 🟢 CÓ — dùng Etsy API |

```javascript
// Etsy API — free, 10K listings/day
GET https://openapi.etsy.com/v3/application/listings/search?keywords={keyword}
Headers: x-api-key: {api_key}
```

### 2.11 Twitter/X (xquik/x-tweet-scraper — PAID)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🟡 CAO — Twitter/X hạn chế API free |
| Free API | 🟡 **Free tier: 1500 posts/month, 1 app only** |
| Playwright | 🟡 Cần account + proxy |
| **Khả thi free?** | 🟡 GIỚI HẠN — 1500 posts/tháng hoặc Playwright |

**Chiến lược:** Free API cho basic needs, Playwright nếu cần nhiều hơn.

### 2.12 eBay Sold (caffein.dev/ebay-sold-listings — DISABLED/PAID)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🟢 THẤP — eBay có API free |
| Free API | ✅ **eBay Browse API (free) — 5000 calls/day** |
| Playwright | ✅ |
| **Khả thi free?** | 🟢 CÓ — dùng eBay API |

```javascript
// eBay Browse API — free, 5000 calls/day
GET https://api.ebay.com/buy/browse/v1/item_summary/search?q={keyword}&filter=buyingOptions:{FIXED_PRICE}
Headers: Authorization: Bearer {access_token}
```

### 2.13 Instagram (apify/instagram-search-scraper — PAID)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🔴 RẤT CAO — Meta, fingerprinting, login required |
| Free API | ❌ Basic Display API (chỉ own media) |
| Playwright | 🟡 Cần Instagram account + proxy + stealth |
| **Khả thi free?** | 🟡 KHÓ — cần account + proxy |

**Chiến lược:** Playwright stealth với Instagram account. Fallback: giữ Apify.

### 2.14 TikTok Ads (crawlerbros/tiktok-ads-library-scraper-pro — PAID)

| Yếu tố | Đánh giá |
|--------|----------|
| Anti-bot | 🔴 RẤT CAO |
| Free API | ❌ |
| Playwright | 🟡 TikTok Ads Library có thể scrape với mobile emulation |
| **Khả thi free?** | 🟡 KHÓ — cần fingerprint + proxy |

---

## 3. Tổng Hợp Độ Khó & Ưu Tiên

```
Tier 0: DỄ NHẤT (Free API, không anti-bot)
├── Reddit        🟢 Done trong 1 buổi
├── eBay          🟢 Done trong 1 buổi
├── Shopify       🟢 Done trong 1 buổi
├── Etsy          🟢 Done trong 1 buổi
└── Pinterest     🟢 Done trong 1 buổi

Tier 1: TRUNG BÌNH (Cần API key / stealth cơ bản)
├── Facebook Ads (Meta Ad Library API)   🟡
├── Twitter/X (Free API + Playwright)    🟡
├── Google Shopping (Playwright stealth) 🟡

Tier 2: KHÓ (Cần proxy + fingerprint)
├── Amazon        🟡🔴
├── TikTok Shop   🟡🔴
├── Instagram     🟡🔴
└── TikTok Ads    🟡🔴

Tier 3: ĐÃ CÓ (Không cần làm gì thêm)
└── Facebook Posts/Ads → Toidispy CDP ✅
```

---

## 4. Kiến Trúc Auto-Retry Loop

### 4.1 Vòng Lặp Chính

```
┌─────────────────────────────────────────────────────────────────┐
│                   scraper-factory.js                            │
│                                                                 │
│  strategy = selectStrategy(platform)                            │
│  ──────────────────────────────────                             │
│  API strategy:   HTTP GET → parse JSON                          │
│  Playwright:     browser → stealth → navigate → extract         │
│  CDP (Toidispy): connect Chrome → filter → scrape              │
│                                                                 │
│  loop {                                                         │
│    try {                                                        │
│      data = await scrape(strategy, query)                       │
│      validate(data)                                             │
│      saveToDB(data)                                             │
│      break  // success                                          │
│    } catch (err) {                                              │
│      reason = diagnoseError(err)                                │
│      strategy = escalate(reason, strategy)                      │
│      // proxy: swap proxy                                       │
│      // fingerprint: rotate UA + viewport                       │
│      // rate limit: increase delay                              │
│      // captcha: solve or skip                                  │
│      log(reason, attempt)                                       │
│      wait(backoff(attempt))                                     │
│      retry                                                      │
│    }                                                            │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Strategy Selector

```javascript
// strategies.json
{
  "reddit": {
    "method": "api",
    "baseUrl": "https://www.reddit.com/search.json",
    "rateLimit": "60/min",
    "headers": { "User-Agent": "..." },
    "retry": { "max": 3, "backoff": "exponential" }
  },
  "etsy": {
    "method": "api",
    "baseUrl": "https://openapi.etsy.com/v3/application/listings/search",
    "auth": "x-api-key",
    "rateLimit": "10/sec",
    "retry": { "max": 5, "backoff": "exponential" }
  },
  "amazon": {
    "method": "playwright",
    "fingerprint": "stealth+rotation",
    "proxy": "required",
    "delay": { "min": 3000, "max": 7000 },
    "retry": { "max": 10, "backoff": "linear+random" }
  },
  "tiktok_shop": {
    "method": "playwright",
    "mobileEmulation": true,
    "fingerprint": "full",
    "proxy": "required",
    "delay": { "min": 5000, "max": 10000 },
    "retry": { "max": 15, "backoff": "exponential+jitter" }
  },
  "toidispy": {
    "method": "cdp",
    "connectUrl": "http://localhost:9222",
    "fallback": "playwright"
  }
}
```

### 4.3 Error Diagnosis Engine

```javascript
function diagnoseError(err) {
  const patterns = [
    // HTTP Status Codes
    { match: /403/,         reason: 'BLOCKED_IP',       action: 'swap_proxy' },
    { match: /429/,         reason: 'RATE_LIMITED',     action: 'increase_delay' },
    { match: /503/,         reason: 'TEMP_BLOCK',       action: 'wait_longer' },
    { match: /401/,         reason: 'AUTH_REQUIRED',    action: 'renew_token' },
    { match: /200/,         reason: 'EMPTY_RESULT',     action: 'change_query' },

    // Captcha & Challenge
    { match: /captcha/i,    reason: 'CAPTCHA',          action: 'solve_captcha' },
    { match: /challenge/i,  reason: 'CHALLENGE',        action: 'solve_captcha' },
    { match: /cf-/i,        reason: 'CLOUDFLARE',       action: 'use_playwright' },

    // Amazon specific
    { match: /robodog/i,    reason: 'AMAZON_BOT_DETECT', action: 'rotate_fingerprint' },
    { match: /sorry/i,      reason: 'AMAZON_BLOCK',     action: 'swap_proxy+delay' },

    // Playwright specific
    { match: /TimeoutError/, reason: 'TIMEOUT',          action: 'increase_timeout' },
    { match: /TargetClosed/, reason: 'BROWSER_CRASH',   action: 'restart_browser' },
    { match: /detected/i,   reason: 'PLAYWRIGHT_DETECT', action: 'rotate_fingerprint' },
    { match: /blocked/i,    reason: 'BLOCKED',           action: 'swap_proxy+ua' },

    // Network
    { match: /ECONNRESET/,  reason: 'CONNECTION_RESET', action: 'retry_different_proxy' },
    { match: /ETIMEDOUT/,   reason: 'TIMEOUT',          action: 'increase_timeout' },
    { match: /ENOTFOUND/,   reason: 'DNS_FAIL',         action: 'change_dns' },
  ];

  for (const p of patterns) {
    if (p.match.test(err.message || '')) return p;
  }
  return { reason: 'UNKNOWN', action: 'escalate_to_human' };
}
```

### 4.4 Escalation Ladder

```
attempt 1:  [basic attempt]                    → delay 1s
attempt 2:  [swap user-agent]                  → delay 2s
attempt 3:  [swap proxy + UA]                  → delay 3s
attempt 4:  [rotate viewport + headers]         → delay 5s
attempt 5:  [add stealth plugins]               → delay 8s
attempt 6:  [change fingerprint completely]     → delay 10s
attempt 7:  [use mobile emulation]              → delay 15s
attempt 8:  [change proxy region]               → delay 20s
attempt 9:  [solve captcha if needed]           → delay 30s
attempt 10: [log failure, skip platform]        → report
```

---

## 5. Implementation Roadmap

### Phase 1: Low-Hanging Fruit (Tier 0) — Ngày 1-2

```
┌────────────────────────────────────────────────────────┐
│ Mục tiêu: Hoàn thành 5 nền tảng dễ nhất, mỗi nền tảng │
│ có auto-retry loop hoàn chỉnh                          │
├────────────────────────────────────────────────────────┤
│ 1. scaffold: scraper-factory.js + strategy-selector    │
│ 2. src/scrapers/reddit.js — Reddit API                │
│ 3. src/scrapers/ebay.js — eBay Browse API             │
│ 4. src/scrapers/shopify.js — Shopify Storefront API   │
│ 5. src/scrapers/etsy.js — Etsy API                    │
│ 6. src/scrapers/pinterest.js — Pinterest API           │
│ 7. server.js route: POST /api/scrape (unified)        │
│ 8. test: node test/anti-bot/phase1-test.js            │
└────────────────────────────────────────────────────────┘
```

### Phase 2: Medium Difficulty (Tier 1) — Ngày 3-5

```
┌────────────────────────────────────────────────────────┐
│ Mục tiêu: Meta Ad Library API + Twitter + Google Shop  │
├────────────────────────────────────────────────────────┤
│ 1. src/scrapers/meta-ads.js — Meta Ad Library API      │
│ 2. src/scrapers/twitter.js — Twitter API + Playwright  │
│ 3. src/scrapers/google-shopping.js — Playwright stealth│
│ 4. anti-bot/proxy-pool.js — proxy rotation manager     │
│ 5. anti-bot/fingerprint.js — fingerprint rotation      │
│ 6. anti-bot/stealth-launcher.js — Playwright stealth   │
│ 7. test: node test/anti-bot/phase2-test.js             │
└────────────────────────────────────────────────────────┘
```

### Phase 3: Hard Mode (Tier 2) — Ngày 6-10

```
┌────────────────────────────────────────────────────────┐
│ Mục tiêu: Amazon + TikTok Shop + Instagram + TikTok Ads│
├────────────────────────────────────────────────────────┤
│ 1. src/scrapers/amazon.js — Playwright + proxy + stealth│
│ 2. src/scrapers/tiktok-shop.js — mobile + fingerprint   │
│ 3. src/scrapers/instagram.js — account + stealth        │
│ 4. src/scrapers/tiktok-ads.js — mobile emulation        │
│ 5. anti-bot/captcha-solver.js — captcha handling        │
│ 6. anti-bot/session-manager.js — cookie persistence     │
│ 7. test: node test/anti-bot/phase3-test.js             │
└────────────────────────────────────────────────────────┘
```

### Phase 4: Integration + Dashboard — Ngày 11-12

```
┌────────────────────────────────────────────────────────┐
│ Mục tiêu: Gắn tất cả vào dashboard, UI monitoring      │
├────────────────────────────────────────────────────────┤
│ 1. Tích hợp scrapers vào server.js routes              │
│ 2. Dashboard hiển thị live scraping status             │
│ 3. Schedule auto-scrape (daily/weekly)                │
│ 4. Export báo cáo tổng hợp                             │
│ 5. document: docs/SCRAPING_RESULTS.md                  │
└────────────────────────────────────────────────────────┘
```

---

## 6. File Structure Mới

```
apify-collector/
├── server.js                       # + scrape routes
├── src/
│   ├── database.js                 # (giữ nguyên)
│   ├── platform-config.js          # + freeMethod field
│   └── apify-client.js             # (giữ nguyên fallback)
│
├── anti-bot/                       # ★ MỚI
│   ├── scraper-factory.js          # Strategy pattern
│   ├── strategies.json             # Config mỗi platform
│   ├── error-diagnose.js           # Error → reason → action
│   ├── proxy-pool.js               # Proxy rotation
│   ├── fingerprint.js              # UA + viewport + headers
│   ├── stealth-launcher.js         # Playwright stealth
│   ├── captcha-solver.js           # Captcha handling
│   └── backoff.js                  # Exponential backoff
│
├── src/scrapers/                   # ★ MỚI
│   ├── reddit.js
│   ├── ebay.js
│   ├── shopify.js
│   ├── etsy.js
│   ├── pinterest.js
│   ├── meta-ads.js
│   ├── twitter.js
│   ├── google-shopping.js
│   ├── amazon.js
│   ├── tiktok-shop.js
│   ├── instagram.js
│   └── tiktok-ads.js
│
├── scripts/
│   ├── toidispy-cdp.js             # (giữ nguyên)
│   ├── batch-processor.js          # (giữ nguyên)
│   └── self-healing.js             # ★ MỚI — auto test loop
│
├── test/
│   ├── test.js                     # (giữ nguyên)
│   └── anti-bot/
│       ├── phase1-test.js
│       ├── phase2-test.js
│       └── phase3-test.js
│
└── docs/
    ├── ANTI_BOT_PLAN.md            # File này
    └── SCRAPING_RESULTS.md         # Kết quả thực tế từng platform
```

---

## 7. Self-Healing Script (auto loop)

File `scripts/self-healing.js` — đây là core của "tự code tự test":

```javascript
/**
 * Self-Healing Scraper
 * Tự động: code → test → detect lỗi → fix strategy → retry → log kết quả
 * 
 * Usage: node scripts/self-healing.js [platform] [keyword]
 *        node scripts/self-healing.js all "press on nail"
 *        node scripts/self-healing.js --loop (auto tuần tự từng platform)
 */

const PHASES = [
  // Phase 1: Dễ
  ['reddit', 'ebay', 'shopify', 'etsy', 'pinterest'],
  // Phase 2: Trung bình
  ['meta-ads', 'twitter', 'google-shopping'],
  // Phase 3: Khó
  ['amazon', 'tiktok-shop', 'instagram', 'tiktok-ads'],
];

async function selfHeal(platform, keyword) {
  let attempt = 0;
  const maxAttempts = 10;
  const log = [];

  while (attempt < maxAttempts) {
    attempt++;
    console.log(`\n[${platform}] Attempt ${attempt}/${maxAttempts}`);

    try {
      const result = await scrapeWithStrategy(platform, keyword, attempt);

      // Validate: đủ data không?
      const valid = validateResult(platform, result);
      if (!valid) throw new Error('VALIDATION_FAILED: empty data');

      // Success!
      await saveResult(platform, keyword, result, log);
      printSuccess(platform, attempt, result);
      return result;

    } catch (err) {
      const diagnosis = diagnoseError(err);
      log.push({ attempt, error: err.message, diagnosis });

      console.log(`  ❌ ${diagnosis.reason} → action: ${diagnosis.action}`);

      // Apply the fix
      await applyFix(diagnosis, attempt);

      // Exponential backoff with jitter
      const wait = calculateBackoff(attempt);
      console.log(`  ⏳ Waiting ${wait}ms...`);
      await sleep(wait);
    }
  }

  // All attempts failed
  console.error(`\n[${platform}] FAILED after ${maxAttempts} attempts`);
  await logFailure(platform, keyword, log);
  return null;
}
```

---

## 8. Metrics & Success Criteria

### 8.1 Mỗi Platform Cần Đạt

| Metric | Target |
|--------|--------|
| Success rate | >80% requests thành công |
| Data quality | >90% items có title + url hợp lệ |
| Speed | <30s cho 50 items |
| Cost | $0 (ngoại trừ proxy nếu cần) |

### 8.2 Scoring System

```javascript
const SCORE = {
  successRate: {
    '>90%':  '🟢 A',   // Free API, never blocked
    '70-90%': '🟡 B',   // Occasional blocks
    '50-70%': '🟠 C',   // Needs proxy
    '<50%':   '🔴 D',   // Not feasible free → keep Apify
  },
  implementationEffort: {
    '1-2h':  '🟢 Easy',
    '3-6h':  '🟡 Medium',
    '1-2d':  '🟠 Hard',
    '>2d':   '🔴 Very Hard',
  }
};
```

---

## 9. Kết Luận Dự Kiến

| Platform | Phương Pháp Free | Độ Khó | Thời Gian | Khả Thi? |
|----------|-----------------|--------|-----------|---------|
| Reddit | API | 🟢 | 1h | ✅ |
| eBay | API | 🟢 | 1h | ✅ |
| Shopify | API | 🟢 | 1h | ✅ |
| Etsy | API | 🟢 | 1h | ✅ |
| Pinterest | API | 🟢 | 1h | ✅ |
| Facebook Ads | Toidispy CDP / Meta API | 🟢 | 0h (đã có) | ✅ |
| Facebook Posts | Toidispy CDP | 🟢 | 0h (đã có) | ✅ |
| Twitter/X | API + Playwright | 🟡 | 3h | ✅ |
| Google Shopping | Playwright stealth | 🟡 | 4h | ⚠️ Cần test |
| Amazon | Playwright + proxy | 🟠🔴 | 2d | ⚠️ Cần proxy |
| TikTok Shop | Playwright mobile | 🔴 | 2d | ⚠️ Cần proxy |
| Instagram | Playwright + account | 🔴 | 1d | ⚠️ Cần account |
| TikTok Ads | Playwright mobile | 🔴 | 2d | ⚠️ Cần proxy |

**Tổng: 10/14 khả thi free, 4/14 cần proxy hoặc giữ Apify**

---

## 10. Ngay Bây Giờ — Bắt Đầu Từ Đâu?

**Bước 1:** Tạo `anti-bot/` folder với các module core

**Bước 2:** Code scraper đầu tiên (Reddit — dễ nhất) để test auto-retry loop

**Bước 3:** Chạy `node scripts/self-healing.js reddit "press on nail"` — verify loop hoạt động

**Bước 4:** Tuần tự từng platform theo Phase 1 → 2 → 3

**Bước 5:** Mỗi platform xong → `node test/anti-bot/phaseX-test.js` — auto verify
