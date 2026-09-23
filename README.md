# 🚀 crawler-POD — Tài Liệu Dự Án & Bàn Giao Công Việc (Handover Guide)

> **Hệ thống thu thập, chuẩn hóa, phân tích biến động và theo dõi dữ liệu sản phẩm / bài đăng / quảng cáo đa nền tảng (E-commerce, Social Media, Meta Ads) phục vụ nghiên cứu thị trường POD & Dropshipping.**

---

## 📌 MỤC LỤC
1. [Tổng Quan Dự Án & Nền Tảng Hỗ Trợ](#1-tổng-quan-dự-án--nền-tảng-hỗ-trợ)
2. [Kiến Trúc Kỹ Thuật (Architecture & Tech Stack)](#2-kiến-trúc-kỹ-thuật-architecture--tech-stack)
3. [Cấu Trúc Thư Mục Dự Án](#3-cấu-trúc-thư-mục-dự-án)
4. [Hướng Dẫn Cài Đặt & Chạy Nhanh (Quick Start)](#4-hướng-dẫn-cài-đặt--chạy-nhanh-quick-start)
5. [Cấu Hình Môi Trường (.env)](#5-cấu-hình-môi-trường-env)
6. [Các Tính Năng Trọng Yếu & Luồng Hoạt Động](#6-các-tính-năng-trọng-yếu--luồng-hoạt-động)
7. [Quản Trị Cơ Sở Dữ Liệu & Sao Lưu (PostgreSQL / PGlite)](#7-quản-trị-cơ-sở-dữ-liệu--sao-lưu-postgresql--pglite)
8. [Quy Trình Kiểm Thử & Độ Tin Cậy (Testing & Reliability)](#8-quy-trình-kiểm-thử--độ-tin-cậy-testing--reliability)
9. [Bảng Tra Cứu API Endpoints](#9-bảng-tra-cứu-api-endpoints)
10. [Lưu Ý Kỹ Thuật Khi Tiếp Nhận Bàn Giao (Gotchas & Checklist)](#10-lưu-ý-kỹ-thuật-khi-tiếp-nhận-bàn-giao-gotchas--checklist)

---

## 1. TỔNG QUAN DỰ ÁN & NỀN TẢNG HỖ TRỢ

**crawler-POD** là hệ thống data intelligence độc lập giúp tự động hóa quá trình thu thập thông tin sản phẩm thịnh hành (winning products), quảng cáo và xu hướng mạng xã hội. Dữ liệu sau khi thu thập được chụp snapshot theo ngày, tự động tính toán tăng trưởng (Delta 24h/7d về views, sold count, favorites, likes, reviews) và hiển thị trực quan theo dạng thẻ Etsy-Spy format.

### 🌐 12 Nền tảng được tích hợp:

| Nền tảng | Kênh | Phương thức thu thập ưu tiên | Cơ chế dự phòng (Fallback) |
|---|---|---|---|
| **Etsy** | E-Commerce | `local-scraper` (CloakBrowser Stealth / Direct API) | Apify Actor (`epctex/etsy-scraper`) |
| **eBay** | E-Commerce | `local-scraper` (CloakBrowser eBay Sold Listings) | SearXNG / Historical Cache |
| **Amazon** | E-Commerce | `local-scraper` (Playwright Session Storage) | Apify Actor (`apify/amazon-product-scraper`) |
| **Shopify** | E-Commerce | `local-scraper` (Public `/products.json` API) | Apify Actor (`gluon-jurcak/shopify-scraper`) |
| **TikTok Shop** | E-Commerce | `local-scraper` / Apify Actor | Apify Token Pool (`clockworks/tiktok-scraper`) |
| **TikTok Videos**| Social Media | `local-scraper` / Apify (Likes, Saves, Comments, Music) | Apify Actor (`clockworks/tiktok-scraper`) |
| **Pinterest** | Social Media | `local` (GraphQL `enrichPinMetrics` lấy chỉ số thật) | Apify Actor (`epctex/pinterest-scraper`) |
| **Reddit** | Social Media | `local-scraper` (Public Search JSON API - Free 100%) | Apify Actor (`apify/reddit-scraper`) |
| **Facebook Ads** | Ads Library | `apify` (Meta Ad Library - Fanpage Likes, CTA, Platforms) | Apify Actor Pool |
| **Facebook Posts**| Social Media | `apify` (Trang cá nhân / Fanpage / Groups) | Apify Actor Pool |
| **Twitter / X** | Social Media | `apify` / Public API | Apify Actor Pool |
| **Google Shopping**| Search Ads | `local-scraper` qua SearXNG Cục bộ | Apify Actor (`epctex/google-shopping-scraper`) |

---

## 2. KIẾN TRÚC KỸ THUẬT (ARCHITECTURE & TECH STACK)

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND DASHBOARD                              │
│         Single Page App (Bootstrap 5, Feather Icons, Etsy-Spy UI)      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP REST API (Port 20129)
┌───────────────────────────────────▼────────────────────────────────────┐
│                        SERVER.JS (EXPRESS CORE)                        │
│    Routes, Middlewares, SSE Progress, Graceful Shutdown, API Handlers  │
└──────┬────────────────────────────┬─────────────────────────────┬──────┘
       │                            │                             │
┌──────▼──────────────┐   ┌─────────▼──────────────┐   ┌──────────▼───────┐
│  COLLECTION INPUTS  │   │   RESOURCE SCHEDULER   │   │ DATABASE LAYER   │
│  - Multi-keyword    │   │  - WorkerPool (4 Pools)│   │  - PostgreSQL    │
│    (phẩy / \n)      │   │  - RAM Admission Guard │   │    (PGlite WASM) │
│  - Auto-Fan-Out     │   │  - Stuck Run Detector  │   │  - Schema V2     │
│  - Whitelist Sanitiz│   │  - Heartbeat & Lease   │   │  - Snapshot Engine│
└─────────────────────┘   └─────────┬──────────────┘   └──────────────────┘
                                    │ Dispatches to
                 ┌──────────────────┴──────────────────┐
                 │                                     │
      ┌──────────▼──────────┐               ┌──────────▼──────────┐
      │  LOCAL ENGINES      │               │   PAID CLOUD ENGINE │
      │  - CloakBrowser     │               │   - Apify Token Pool│
      │  - Playwright       │               │     (Auto-Failover, │
      │  - Direct APIs      │               │      Rotate on 402) │
      └─────────────────────┘               └─────────────────────┘
```

- **Backend Runtime**: Node.js (hỗ trợ v20 LTS và v24), Express framework.
- **Cổng dịch vụ mặc định**: `http://localhost:20129` (có thể đổi qua biến môi trường `PORT`).
- **Cơ sở dữ liệu (Database)**: 
  - Môi trường Local / Dev: Sử dụng **PostgreSQL PGlite** (PostgreSQL chạy bằng WebAssembly in-process lưu tại `data/pgdata`), không cần cài đặt PostgreSQL server rườm rà.
  - Môi trường Production / Server thật: Chuyển đổi mượt mà sang PostgreSQL server chỉ bằng cách set `PG_MODE=postgres` và cung cấp `DATABASE_URL`.
  - Bộ chuyển đổi `pg-client.js`: Cung cấp giao diện tương thích SQLite (`prepare`, `get`, `all`, `run`, `transaction`) nhưng chạy trên cú pháp chuẩn PostgreSQL (`$1, $2`, `RETURNING id`, `ON CONFLICT`).
- **Resource Scheduler & Điều Phối**:
  - Quản lý tài nguyên an toàn bộ nhớ (RAM-aware), ngăn chặn tràn bộ nhớ khi cào song song.
  - Hệ thống 4 hồ chứa tác vụ (Worker Pools): `LOCAL`, `BROWSER`, `CDP`, `CLOUD`.
  - **Stuck Detector**: Tự động phát hiện tác vụ bị đơ/treo và giải phóng slot tài nguyên.
  - **Heartbeat & Lease**: Đảm bảo mỗi run chỉ do một worker sở hữu, tự động khôi phục nếu worker gặp sự cố.
- **Cơ chế Phân Tách Nhiều Từ Khóa (Multi-Keyword Fan-Out)**:
  - Cho phép người dùng nhập danh sách từ khóa ngăn cách bởi **dấu phẩy `,`** hoặc **xuống dòng `\n`**.
  - Hệ thống tự động phân tách thành các run con độc lập, **mỗi run con nhận trọn vẹn số lượng `maxItems` ban đầu** (không bị chia nhỏ).
  - Tích hợp cho cả **Crawl Now (Collect)** và **Lập lịch (Schedules)**.

---

## 3. CẤU TRÚC THƯ MỤC DỰ ÁN

```bash
crawler-POD/
├── public/                       # Frontend Dashboard (Static Assets)
│   ├── index.html                # Giao diện chính Dashboard (Bootstrap 5)
│   ├── app.js                    # Toàn bộ logic Client, Gọi API, Etsy Spy Card
│   ├── style.css                 # CSS phong cách Etsy Spy card layout
│   └── item-metric-rows.js       # Xây dựng các dòng chỉ số trực quan
├── src/                          # Mã nguồn Backend Core
│   ├── database/                 # Tầng Cơ Sở Dữ Liệu PostgreSQL
│   │   ├── pg-client.js          # Adapter kết nối PGlite & PostgreSQL server
│   │   ├── pg-schema.sql         # File DDL Schema hoàn chỉnh
│   │   ├── product-current.js    # Bảng sản phẩm hiện tại (product_current)
│   │   └── daily-history.js      # Bảng lịch sử nén ngày (daily_packed_history)
│   ├── scheduler/                # Bộ điều phối tài nguyên & Hàng đợi
│   │   ├── scheduler.js          # ResourceScheduler cốt lõi
│   │   ├── worker-pool.js        # Quản lý giới hạn concurrency theo pool
│   │   └── execution-planner.js  # Lập kế hoạch phân bổ RAM & Sharding
│   ├── reliability/              # Cơ chế tự phục hồi & Giám sát tác vụ
│   │   ├── stuck-detector.js     # Phát hiện tác vụ treo/chết
│   │   ├── heartbeat.js          # Bộ đếm nhịp tim worker
│   │   └── execution-lease.js    # Khóa độc quyền run execution
│   ├── scrapers/                 # Các scraper cục bộ (Local Scrapers)
│   │   ├── etsy.js / etsy-cloakbrowser.js  # Scraper Etsy
│   │   ├── ebay.js / ebay-cloakbrowser.js  # Scraper eBay Sold items
│   │   ├── shopify.js            # Scraper Shopify qua products.json
│   │   └── reddit.js             # Scraper Reddit JSON API
│   ├── marketplaces/             # Quản lý Capture HTML & Lập lịch
│   │   └── capture-scheduler.js  # Bộ lập lịch cào tự động đa nền tảng
│   ├── apify-token-pool.js       # Quản lý xoay vòng đa token Apify
│   ├── collection-inputs.js      # Chuẩn hóa & bóc tách từ khóa (Fan-Out)
│   └── database.js               # Database Gateway Module
├── test/                         # Bộ Test Suite (Node Test Runner)
│   ├── multi-keyword-fanout.test.js  # Test phân tách nhiều từ khóa Crawl Now
│   ├── schedule-multi-keyword.test.js# Test phân tách nhiều từ khóa Schedules
│   ├── reliability.test.js       # Test độ tin cậy Heartbeat & Stuck Detector
│   └── marketplace-scheduler.test.js # Test lập lịch và gia hạn Claim Token
├── data/                         # Thư mục chứa dữ liệu vật lý
│   ├── pgdata/                   # Thư mục database PGlite PostgreSQL (Active)
│   └── pgdata.healthy-backup-852mb/ # Bản sao lưu an toàn 89.600+ sản phẩm
├── docs/                         # Tài liệu kỹ thuật, kiến trúc & báo cáo
│   └── AI_RULES/                 # Tài liệu quy chuẩn kỹ thuật & HANDOFF.md
├── server.js                     # Điểm khởi động chính ứng dụng Express
└── package.json                  # Cấu hình dự án và dependencies
```

---

## 4. HƯỚNG DẪN CÀI ĐẶT & CHẠY NHANH (QUICK START)

### Yêu cầu hệ thống:
- **Node.js**: Phiên bản `>= 20.0.0` (Khuyến nghị Node.js v20 hoặc v24 LTS).
- **Hệ điều hành**: Windows 10/11, macOS, hoặc Ubuntu Linux.
- **Git** đã được cài đặt.

### Bước 1: Clone và Cài đặt thư viện
```bash
git clone https://github.com/mazievu/crawler-POD.git
cd crawler-POD
npm install
```

### Bước 2: Thiết lập file môi trường
Tạo file `.env` từ file mẫu:
```bash
# Trên Windows PowerShell:
Copy-Item .env.example .env

# Trên Linux/macOS:
cp .env.example .env
```

### Bước 3: Khởi động hệ thống
Khởi động server ứng dụng:
```bash
npm start
# Hoặc:
node server.js
```

Sau khi khởi động thành công, terminal sẽ thông báo:
```text
Apify Collector running at http://0.0.0.0:20129
[SystemInfo] pid=... startedAt=... version=1.0.0 port=20129
[Scheduler] Started resource-aware scheduler ticker
[StuckDetector] Started stuck run detector
[SocialScheduler] Started social listening scheduler
```

### Bước 4: Mở Dashboard trên trình duyệt
Truy cập: **[http://localhost:20129](http://localhost:20129)**

---

## 5. CẤU HÌNH MÔI TRƯỜNG (.ENV)

Bảng các biến môi trường quan trọng:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `20129` | Cổng HTTP mà server lắng nghe |
| `PG_MODE` | `pglite` | Chế độ DB: `pglite` (chạy WASM cục bộ) hoặc `postgres` (server ngoài) |
| `PGLITE_DIR` | `data/pgdata` | Đường dẫn thư mục lưu trữ dữ liệu PGlite |
| `DATABASE_URL` | *(trống)* | Chuỗi kết nối PostgreSQL (dùng khi `PG_MODE=postgres`) |
| `APIFY_TOKEN` | *(tuỳ chọn)* | Token chính gọi Apify API khi dùng fallback có phí |
| `SEARXNG_URL` | `http://localhost:8888` | URL SearXNG cho local search engine (nếu có) |
| `CDP_URL` | `http://localhost:9222` | Cổng Chrome DevTools Protocol cho browser automation |
| `CREDENTIAL_ENCRYPTION_KEY` | *(bắt buộc nếu lưu acc)* | Khóa 32-byte Base64 dùng để mã hóa Session Cookie |

> 💡 **Tạo nhanh khóa mã hóa session cookie**:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
> ```

---

## 6. CÁC TÍNH NĂNG TRỌNG YẾU & LUỒNG HOẠT ĐỘNG

### 1. Thu thập dữ liệu (Crawl Now / Collect)
- **Vị trí**: Nút **Crawl Now** trên đầu trang.
- **Tính năng Multi-Keyword**: Người dùng có thể nhập 1 hoặc nhiều từ khóa, cách nhau bằng dấu phẩy `,` hoặc xuống dòng `\n`.
  - *Ví dụ*: `vintage hoodie, custom mug, embroidered sweatshirt`
- **Bộ điều phối (Fan-Out)**:
  - Nếu nhập 1 từ khóa: Chạy trực tiếp 1 run duy nhất.
  - Nếu nhập `N` từ khóa: Hệ thống tự động tạo 1 Parent Run (trạng thái pending) và sinh ra `N` Child Runs độc lập chạy qua WorkerPool.
  - Mỗi run con nhận **nguyên vẹn `maxItems`** ban đầu. Kết quả được Parent Run tự động tổng hợp.

### 2. Lập lịch tự động (Marketplace Schedules)
- **Vị trí**: Nút **Schedules** trên thanh điều hướng.
- **Cơ chế**:
  - Hỗ trợ lập lịch theo chu kỳ giờ (`Interval`), theo giờ cố định hàng ngày (`Daily`), hoặc chạy một lần (`Once`).
  - Ô nhập từ khóa hỗ trợ textarea nhiều dòng hoặc phân tách bằng dấu phẩy. Có thanh preview tự động tính toán: *"X từ khoá → tự động tách thành X run độc lập khi chạy"*.
  - Nút **"Cào ngay" (Run Now)** trên từng lịch giúp kích hoạt ngay lập tức mà không cần chờ đến giờ hẹn.

### 3. Khám phá & Lọc dữ liệu thông minh (Database Explorer)
- **Bố cục thẻ Etsy Spy**: Hiển thị ảnh kèm badge nhãn, giá tiền, rating 5 sao, tên shop và bảng 5 dòng chỉ số màu:
  - **Đỏ**: Lượt xem (Views), Doanh số (Sold), Biến động hàng ngày (Daily sales).
  - **Xanh dương**: Người yêu thích (Favorers/Watchers), Likes.
  - **Xanh ngọc**: Thời gian tạo (Created), Cập nhật gần nhất (Updated).
- **Bộ lọc đa điều kiện**: Hỗ trợ lọc đồng thời nhiều tiêu chí theo logic AND: Lọc theo nền tảng, khoảng giá, lượt bán, lượt thích, đánh giá sao, và sắp xếp theo tăng trưởng 24h.
- **Modal chi tiết sản phẩm**: Click vào bất kỳ thẻ sản phẩm nào để xem toàn bộ thông tin gốc, lịch sử biến động theo từng ngày và snapshot raw JSON.

### 4. Hệ thống Quản trị Token Apify (Token Pool)
- **Vị trí**: Quản lý tại `src/apify-token-pool.js` và modal cấu hình token.
- **Tính năng**:
  - Hỗ trợ nạp danh sách hàng loạt token.
  - Tự động luân phiên (Round-Robin).
  - Tự động cách ly token khi gặp lỗi: `401 Unauthorized` (token sai), `402 Payment Required` (hết tiền/hết quota), hoặc `429 Too Many Requests` (bị giới hạn tần suất), chuyển mượt mà sang token tiếp theo mà không làm gián đoạn tác vụ crawl.

---

## 7. QUẢN TRỊ CƠ SỞ DỮ LIỆU & SAO LƯU (POSTGRESQL / PGLITE)

### ⚠️ QUY TẮC CỐT TỬ VỀ PGLITE (SINGLE-PROCESS LOCK):
1. **PGlite chạy dạng in-process single-connection**: Tại một thời điểm, **CHỈ CÓ DUY NHẤT 1 tiến trình Node.js** được phép mở thư mục `data/pgdata`.
2. Khi `server.js` đang chạy, **KHÔNG ĐƯỢC** chạy các script ngoài trực tiếp gọi `require('./src/database')` trỏ vào cùng `data/pgdata` (sẽ gây lỗi `RuntimeError: Aborted()` do lock tranh chấp).
3. Muốn truy vấn dữ liệu khi server đang chạy: Gọi qua HTTP API (`http://127.0.0.1:20129/...`).

### Vị trí các bản sao lưu an toàn (Safe Backups):
Hệ thống có sẵn các bản backup toàn vẹn của database với hơn 89.600 sản phẩm:
- `data/pgdata.healthy-backup-852mb`
- `docs/BACKUPS/2026-09-16/db-cleanup-empty-items/pgdata`

### Cách xử lý khi PGlite báo lỗi `could not locate a valid checkpoint` hoặc lock file:
Nếu server bị tắt đột ngột (tắt nguồn / kill process đột ngột) khiến file `postmaster.pid` bị kẹt:
```powershell
# Bước 1: Dừng các tiến trình node đang chạy ngầm
Stop-Process -Name node -Force -ErrorAction SilentlyContinue

# Bước 2: Xóa lock file thừa nếu có
Remove-Item "data/pgdata/postmaster.pid" -Force -ErrorAction SilentlyContinue

# Bước 3 (Nếu WAL bị hỏng): Khôi phục nhanh từ backup sạch
Remove-Item -Path "data/pgdata" -Recurse -Force
Copy-Item -Path "data/pgdata.healthy-backup-852mb" -Destination "data/pgdata" -Recurse

# Bước 4: Khởi động lại server bình thường
node server.js
```

---

## 8. QUY TRÌNH KIỂM THỬ & ĐỘ TIN CẬY (TESTING & RELIABILITY)

Hệ thống sử dụng **Node.js Native Test Runner** (`node --test`), tuân thủ nghiêm ngặt chuẩn TDD (Test-Driven Development).

### Các lệnh kiểm thử chính:

```bash
# Chạy bộ test tính năng tách từ khóa (Crawl Now & Schedules)
node --test test/multi-keyword-fanout.test.js test/schedule-multi-keyword.test.js

# Chạy bộ test độ tin cậy Heartbeat, Stuck Run Detector & Lease
node --test test/reliability.test.js

# Chạy bộ test Marketplace Schedules & Token Renewal
node --test test/marketplace-scheduler.test.js

# Chạy toàn bộ test suite (lưu ý dừng server chính trước khi chạy test đụng DB)
npm test
```

> **Lưu ý**: Đối với các file test cần DB thật (`require('../src/database')`), test runner tự động khởi tạo database scratch tạm thời để không gây tranh chấp lock với database chính.

---

## 9. BẢNG TRA CỨU API ENDPOINTS

Hệ thống cung cấp đầy đủ REST API cho toàn bộ các chức năng:

| Phương thức | Endpoint | Chức năng |
|---|---|---|
| `GET` | `/api/system/info` | Kiểm tra thông tin server, uptime, PID, commit git |
| `GET` | `/api/doctor` | Báo cáo tình trạng sức khỏe của 12 channels và backends |
| `GET` | `/api/platforms` | Danh sách 12 platforms được hỗ trợ |
| `POST`| `/api/runs` | Tạo lượt cào mới (hỗ trợ phân tách từ khóa tự động) |
| `GET` | `/api/runs` | Lấy lịch sử các lượt cào (lọc theo status, platform) |
| `GET` | `/api/runs/:id` | Xem chi tiết 1 run và danh sách sản phẩm thu thập |
| `GET` | `/api/items` | Truy vấn danh sách sản phẩm trong DB (hỗ trợ lọc đa điều kiện) |
| `GET` | `/api/items/:uid` | Lấy chi tiết lịch sử 1 sản phẩm kèm snapshots theo ngày |
| `POST`| `/api/marketplace-capture-schedules` | Tạo lịch cào tự động |
| `GET` | `/api/marketplace-capture-schedules` | Lấy danh sách các lịch cào hiện tại |
| `POST`| `/api/marketplace-capture-schedules/:id/run-now` | Kích hoạt chạy ngay một lịch cào |
| `POST`| `/api/marketplace-capture-schedules/:id/toggle` | Bật/Tắt kích hoạt một lịch cào |
| `DELETE`| `/api/marketplace-capture-schedules/:id` | Xóa một lịch cào |
| `GET` | `/api/apify/tokens` | Lấy danh sách và trạng thái các token Apify |
| `POST`| `/api/apify/tokens` | Thêm token Apify mới vào Token Pool |

---

## 10. LƯU Ý KỸ THUẬT KHI TIẾP NHẬN BÀN GIAO (GOTCHAS & CHECKLIST)

Khi tiếp nhận dự án, lập trình viên mới cần đặc biệt lưu ý các điểm sau:

1. **Cổng chạy ứng dụng là 20129**: Dashboard chạy tại `http://localhost:20129`, không phải cổng 3000 cũ.
2. **Không commit file `.env` và thư mục `data/`**: `.gitignore` đã cấu hình bỏ qua `data/pgdata` và `.env` để bảo vệ dữ liệu và khóa bí mật.
3. **Graceful Shutdown**: Server đã tích hợp handler bắt tín hiệu tắt (`SIGINT`, `SIGTERM`) để gọi `db.close()` đóng PGlite an toàn. Nên tắt server bằng `Ctrl + C` thay vì tắt nóng terminal để tránh lỗi checkpoint WAL.
4. **Trình duyệt Client Cache**: Khi chỉnh sửa `public/app.js`, cần tăng query string version trong thẻ `<script src="/app.js?v=5.x.x"></script>` tại `public/index.html` để người dùng không bị kẹt cache trình duyệt.
5. **Định dạng thẻ Etsy-Spy**: Hàm `renderItems` trong `public/app.js` dùng biến `cardImage` phục vụ backward compatibility cho các file kiểm thử tự động, tuyệt đối không tự ý xóa biến này.
6. **Nhánh Git & Pull Request**:
   - Nhánh chính làm việc: `main`.
   - Các tính năng mới nhất về phân tách nhiều từ khóa nằm tại PR **[#17](https://github.com/mazievu/crawler-POD/pull/17)** trên nhánh `fix/heartbeat-result-clobber`.

---

*Tài liệu được lập ngày 23/09/2026 bởi Đội ngũ Kỹ thuật crawler-POD.*
