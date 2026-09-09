# Project Objective

crawler-POD (Apify Collector) là hệ thống thu thập, chuẩn hóa, phân tích biến động và theo dõi dữ liệu sản phẩm / bài đăng / quảng cáo đa nền tảng (E-commerce, Social Media, Meta Ads).

---

# Current Architecture

1. **Web Interface & API Server**: `server.js` chạy Express trên cổng `20129` (`http://localhost:20129`).
2. **Scheduler & Resource Admission**: `src/scheduler/scheduler.js`, `worker-pool.js`, `resource-monitor.js`, `execution-planner.js` quản lý slot chạy (LOCAL, BROWSER, CDP, CLOUD) và RAM reservation.
3. **Multi-Backend Routing**: `src/channels/*.channel.js` định tuyến backend:
   - LOCAL / Browser Stealth: Miễn phí, ưu tiên hàng đầu.
   - Apify / Cloud: Fallback có phí (cần explicit token/entitlement).
4. **Apify Token Pool Manager**: `src/apify-token-pool.js` quản lý xoay vòng đa token Apify (Round-Robin & Auto-Failover), tự động nhận diện lỗi 401/402/429 để chuyển token kế tiếp và cách ly token hết tiền.
5. **Database & Dual-Write Architecture**: SQLite (`data/collector.db`) qua `better-sqlite3` ở chế độ WAL:
   - Bảng hiện tại: `product_current`, `runs`, `snapshots`, `daily_packed_history`, `weekly_product_summary`.

---

# Current Functional Status

- **eBay Sold**: Functional PASS + Data Quality Confirmed. Bóc tách tỷ lệ Positive Feedback %, feedback score, sold count, watchers.
- **Facebook Ads**: Functional PASS + Data Quality Confirmed. Bóc tách Fanpage Likes, Meta Platforms (Facebook, Instagram, Threads), ngày chạy, nút CTA, link Meta Ad Library.
- **Pinterest**: Functional PASS + Data Quality Confirmed. Tích hợp bóc tách GraphQL `enrichPinMetrics` lấy 100% chỉ số thật: Comments, Shares (Saves/Repins), Reactions/Likes, Views, Pinner name.
- **Reddit**: Functional PASS + Data Quality Confirmed. Tích hợp bóc tách Subreddit (`r/...`), Upvote Score, Comments; loại bỏ favicon giả; đặt local-scraper làm Primary (Priority 10).
- **TikTok Shop**: Functional PASS + Data Quality Confirmed. Bóc tách và hiển thị chuẩn các chỉ số thương mại điện tử: Số lượng đã bán (Sold Count / 📦 {soldCount} đã bán), Điểm đánh giá (Rating / ⭐ ★ {rating}), và Số lượng review (Reviews / 💬 {reviews} reviews).
- **Apify Token Pool**: Functional PASS + Auto-Failover Confirmed. Tự động xoay vòng đa token khi token hiện tại hết tiền (402), sai token (401), hoặc bị rate limit (429).

---

# Current Data/DB Status

- DB: `data/collector.db` (SQLite WAL mode).
- Số lượng items hiện có: 616 items (bao gồm Amazon, eBay, Etsy, Facebook Ads, Facebook Posts, Google Shopping, Instagram, Pinterest, Reddit, Shopify, TikTok Shop, Twitter).
- Tất cả schema cột chuẩn hóa được bảo toàn.

---

# Provider Priority Decisions

1. **Reddit**:
   - Primary: `local-scraper` (Priority 10, free JSON API / Stealth browser).
   - Fallback: `apify` (Priority 20, automation-lab/reddit-scraper).
2. **Pinterest**:
   - Primary: `local` (Priority 10, native fetch + GraphQL enricher).
   - Fallback: `apify` (Priority 20, automation-lab/pinterest-scraper).
3. **Facebook Ads**:
   - Primary: `apify` (Priority 10, apify/facebook-ads-scraper).
4. **eBay**:
   - Primary: `local` / `browser` (Priority 10).

---

# Worker / Resource Decisions

- **CDP Slot**: Bounded hard cap = 1.
- **LOCAL / BROWSER**: Elastic bursting phụ thuộc RAM headroom reservation.
- **Paid Provider Safety**: Không tự động gọi Apify actor nếu local scraper khả dụng.

---

# Known Issues

1. **SearXNG Discovery**: Local SearXNG instance phụ thuộc service background cục bộ nếu được bật.
2. **Live Probe paid fallback**: Các platform chưa có token paid sẽ báo `BLOCKED_CONFIGURATION` trong doctor/live probe (hành vi dự kiến an toàn).

---

# Latest Meaningful Changes (29/08/2026)

1. `src/social-bots/bot-config.js` & `data/social-bots.json`: Vô hiệu hóa tự cào ngầm mặc định (`enabled: false`), chuyển toàn bộ quyền kiểm soát lên lịch cho user.
2. `src/marketplaces/capture-scheduler.js`: Mở rộng `normalizeScheduleInput` hỗ trợ toàn bộ 12 platform keys với giới hạn `maxListings` / `maxItems` linh hoạt.
3. `src/database.js` & `server.js`: Thêm `toggleMarketplaceCaptureSchedule`, endpoint `/toggle`, `/run-now`, và kết nối `scheduler.submitRun` qua ResourceScheduler an toàn RAM.
4. `public/index.html` & `public/app.js`: Nâng cấp giao diện Schedules đa nền tảng, dọn dẹp các thẻ modal lồng lấn.
5. `src/apify-token-pool.js`: Xây dựng module quản lý đa token Apify (Round-robin + Auto-Failover khi gặp 401/402/429).
6. `src/channels/reddit.channel.js`: Swap priority để `local-scraper` làm Priority 10, `apify` làm Priority 20.
7. `src/scrapers/reddit.js`: Bổ sung `extractRedditImage`, nâng cấp `scrapePublic` lấy Upvotes, Comments, Subreddit.
8. `src/normalize/social-post.js`: Xóa bỏ favicon giả, map chuẩn chỉ số Reddit & Pinterest.
9. `src/scrapers/pinterest.js`: Thêm `enrichPinMetrics` GraphQL parser.
10. `public/app.js` & `server.js`: Hiển thị riêng biệt metrics cho TikTok Shop, X/Twitter, Facebook Ads, Pinterest, Reddit.

---

# Verification Status

- **Unit Tests**: 263/263 PASS (`node --test --test-concurrency=1 "test/**/*.js"`).
- **UI / Playwright Evidence**:
  - `schedules_modal.png` (Multi-platform Universal Schedules UI & scheduler management)
  - `topbar_hidden.png`, `collect_modal_hidden.png` (Hidden topbar buttons & toidispy collect option)
  - `twitter_cards.png`, `twitter_modal.png` (X / Twitter metrics & media image extraction)
  - `tiktok_cards.png`, `tiktok_modal.png`
  - `reddit_cards.png`, `reddit_modal.png`
  - `pinterest_cards.png`, `pinterest_modal_comments.png`
  - `fb_ads_cards.png`, `fb_ads_modal.png`
- **Server**: Đang chạy trên `http://localhost:20129` (Task ID `task-8360`).

---

# Open Risks

- Cần tuân thủ tuyệt đối quy tắc backup trước khi sửa code (`docs/BACKUPS/YYYY-MM-DD/<task-id>/`).
- Mọi can thiệp vào shared components (database, scheduler, worker-pool, execution-planner) phải chạy regression test toàn bộ.

---

# Next Steps

- Tuân thủ toàn bộ 33 điều khoản trong `docs/AI_RULES/CRAWLER_POD_AGENT_RULES.md`.
- Trước khi thực hiện bất kỳ task mới nào:
  1. Đọc `docs/AI_RULES/CRAWLER_POD_AGENT_RULES.md`.
  2. Đọc `docs/AI_RULES/HANDOFF.md`.
  3. Tạo backup file trong `docs/BACKUPS/YYYY-MM-DD/<task-id>/` trước khi sửa.
  4. Thực hiện trace flow, verification và cập nhật snapshot.

---

# Continuation Guide

Khi tiếp nhận task:
1. Xác định rõ Task ID và Scope.
2. Tạo thư mục backup: `docs/BACKUPS/YYYY-MM-DD/<task-id>/`.
3. Kiểm tra tính toàn vẹn hệ thống và chạy test baseline.
4. Triển khai giải pháp tối thiểu, an toàn cục bộ (platform-local first).
5. Xác thực runtime và ghi nhận bằng chứng vào snapshot handoff.
