# Requirements — Apify Collector

**Version:** 1.0.0
**Date:** 2026-06-21
**Status:** Draft

---

## 1. Product Overview

Apify Collector là web application cho phép người dùng thu thập dữ liệu từ nhiều nền tảng mạng xã hội và thương mại điện tử thông qua Apify API. Ứng dụng hoạt động như một dashboard quản lý việc thu thập dữ liệu, theo dõi tiến trình, và hiển thị kết quả.

## 2. Target User

- **Primary:** Ch一个人 (single user) cần thu thập dữ liệu ads, sản phẩm, trending content từ nhiều nền tảng
- **Use case:** Nghiên cứu thị trường, phân tích đối thủ, tìm sản phẩm trending, theo dõi giá

## 3. Supported Platforms

| # | Platform | Data Type | Actor |
|---|----------|-----------|-------|
| 1 | Facebook Posts | Organic posts, engagement | apify/facebook-posts-scraper |
| 2 | Facebook Groups | Group posts, members | apify/facebook-groups-scraper |
| 3 | Facebook Ads | Paid ads creatives | apify/facebook-ads-scraper |
| 4 | TikTok Ads | Ad creatives, spend data | crawlerbros/tiktok-ads-library-scraper-pro |
| 5 | TikTok Shop | Products, reviews | clocklink/tiktok-shop-scraper |
| 6 | Pinterest | Pins, boards | epctex/pinterest-scraper |
| 7 | Etsy | Products, reviews, shops | apify/etsy-scraper |
| 8 | Amazon | Products, reviews | apify/amazon-scraper |
| 9 | Reddit | Posts, comments | apify/reddit-scraper |
| 10 | Google Shopping | Products, prices | streamr/google-shopping-scraper |
| 11 | Shopify | Stores, products | apify/shopify-scraper |

## 4. User Stories

### US-01: Thu thập dữ liệu từ một platform
**As a** user
**I want to** chọn platform, nhập keyword/URL, nhấn nút Start
**So that** tôi có thể thu thập dữ liệu từ platform đó

**Acceptance Criteria:**
- Chọn platform từ dropdown
- Nhập keyword hoặc URL tùy platform
- Nhấn Start → job được tạo và chạy
- Thấy progress indicator trong khi chạy
- Khi xong, thấy items count và link đến data

### US-02: Xem danh sách jobs
**As a** user
**I want to** xem tất cả jobs đã tạo
**So that** tôi có thể theo dõi tình trạng thu thập

**Acceptance Criteria:**
- Hiển thị danh sách jobs mới nhất lên trên
- Mỗi job card hiển thị: platform, query, status, items count, thời gian
- Click vào job card → xem chi tiết

### US-03: Xem chi tiết job và items
**As a** user
**I want to** xem items đã thu thập được từ một job
**So that** tôi có thể kiểm tra chất lượng data

**Acceptance Criteria:**
- Modal hiển thị chi tiết job (platform, query, status, items count)
- Hiển thị danh sách items (tối đa 20 items đầu tiên)
- Mỗi item card hiển thị raw data (JSON format)

### US-04: Export data
**As a** user
**I want to** export data từ một job
**So that** tôi có thể sử dụng data cho phân tích

**Acceptance Criteria:**
- Nút Export trên chi tiết job
- Tải file JSON chứa tất cả items
- File name format: `{platform}_{query}_{date}.json`

### US-05: Xóa job
**As a** user
**I want to** xóa job và data của nó
**So that** tôi có thể dọn dẹp jobs không cần thiết

**Acceptance Criteria:**
- Nút Delete trên chi tiết job
- Confirm dialog trước khi xóa
- Xóa job và tất cả items liên quan

### US-06: Theo dõi tiến trình real-time
**As a** user
**I want to** thấy status cập nhật real-time khi job đang chạy
**So that** tôi biết khi nào job hoàn thành

**Acceptance Criteria:**
- Status bar hiển thị khi job đang chạy
- Auto-poll mỗi 3 giây để check status
- Khi done → hiển thị kết quả
- Khi failed → hiển thị lỗi

### US-07: Xem thống kê tổng quan
**As a** user
**I want to** xem tổng số jobs và items đã thu thập
**So that** tôi có cái nhìn tổng quan về việc thu thập

**Acceptance Criteria:**
- Header hiển thị total jobs và total items
- Cập nhật real-time khi có job mới hoàn thành

### US-08: Chọn options khi tạo job
**As a** user
**I want to** tùy chỉnh max items và country khi tạo job
**So that** tôi có thể kiểm soát phạm vi thu thập

**Acceptance Criteria:**
- Input max items (default 100)
- Dropdown country (optional)
- Options được gửi cùng với job request

## 5. Functional Requirements

### FR-01: Platform Configuration
- Hệ thống phải có sẵn config cho 11 platforms
- Mỗi platform có: name, display_name, description, query_type, icon, color
- Config được lưu trong source code, không cần database

### FR-02: Job Management
- Tạo job mới với: platform, query, options (maxItems, country)
- Job có 4 status: pending → running → done/failed
- Lưu job vào SQLite database
- Tự động update status khi Apify actor hoàn thành

### FR-03: Data Collection
- Gọi Apify API để chạy actor tương ứng platform
- Gửi input params theo platform config (keyword, URLs, maxItems, country)
- Poll status mỗi 3 giây
- Khi done → lấy items từ Apify dataset và lưu vào SQLite

### FR-04: Data Storage
- Lưu jobs và items vào SQLite (file-based, zero-config)
- Schema: platforms, jobs, items
- Items lưu raw_data dạng JSON

### FR-05: Export
- Export jobs và items dạng JSON
- File name format: `{platform}_{query}_{date}.json`

## 6. Non-Functional Requirements

### NFR-01: Performance
- Trang load trong 2 giây
- API response < 500ms (trừ Apify API calls)
- Không có memory leak khi chạy nhiều jobs

### NFR-02: Usability
- Dark theme, dễ nhìn
- Responsive trên desktop (>= 1024px)
- Không cần training để sử dụng

### NFR-03: Reliability
- Không crash khi Apify API lỗi
- Graceful error handling
- Auto-retry khi Apify rate limit

### NFR-04: Security
- API token lưu trong .env, không hardcode
- Không có XSS vulnerability
- Input validation trên cả frontend và backend

### NFR-05: Maintainability
- Code dễ đọc, dễ modify
- Tách module rõ ràng
- Có documentation đầy đủ

## 7. Constraints

- **Single user:** Không cần authentication/authorization
- **Local-first:** Chạy trên localhost, không cần deploy
- **Apify-dependent:** Cần Apify account và token để chạy
- **No real-time push:** Dùng polling (3s interval) thay vì WebSocket

## 8. Out of Scope

- Multi-user / authentication
- Scheduled / recurring jobs
- Data visualization / charts
- Price tracking alerts
- CSV export (chỉ JSON)
- Mobile responsive
