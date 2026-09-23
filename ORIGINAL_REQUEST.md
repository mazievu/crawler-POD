# Original User Request

## 2026-09-22T09:10:12Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview
> Requested team: Full team (multi-phase build & verification)

Hệ thống theo dõi dữ liệu hai lớp độc lập về nghiệp vụ (Discovery theo từ khóa và Monitoring theo Shop/Author) trên nền tảng crawler-POD, bảo đảm an toàn ghi đồng thời trên PostgreSQL và điều phối tài nguyên qua ResourceScheduler.

Working directory: d:\tools GTF\crawler-POD
Integrity mode: development

**Tài liệu đặc tả bắt buộc (SSOT)**: Mọi kiến trúc, quy tắc nghiệp vụ, mô hình dữ liệu, cơ chế khóa đồng thời, tiêu chuẩn adapter và quy trình kiểm chứng BẮT BUỘC phải luôn dựa vào và tuân thủ tuyệt đối tài liệu:
`d:\tools GTF\crawler-POD\docs\DISCOVERY_MONITORING_PLAN_REVISED.md`

## Requirements

### R1. Mô hình dữ liệu và Định danh Thực thể (Identity & Schema)
Triển khai đúng theo Mục 3.1 & Mục 4 của tài liệu SSOT:
- Xây dựng các bảng PostgreSQL mới: `monitoring_entities`, `monitoring_items`, `monitoring_jobs`, `monitoring_entity_observations`, `monitoring_limiter`.
- Khóa thực thể composite duy nhất: `(platform, entity_type, external_id)` với `entity_type = shop | author`. Ưu tiên ID nền tảng hoặc URL canonical đã xác thực; không gộp theo display name hay chuỗi tự do.
- Item chưa xác định được entity đưa vào `pending_identity`. Giữ nguyên `item_uid` và trạng thái `product_current.status` của Discovery; không được dùng `product_current.status = dropped` để dừng Monitoring.
- Migration PostgreSQL idempotent, an toàn trên cả DB mới và DB đang chạy.

### R2. Cơ chế theo dõi Shop và Tín hiệu Sales 30 ngày (E-commerce Lifecycle)
Triển khai đúng theo Mục 3.2 của tài liệu SSOT:
- Tổng sales là metric cấp shop tại `monitoring_entities`, không đưa vào `current_sold` của từng listing.
- Kiểm tra shop một lần mỗi chu kỳ 5 ngày, sau đó xử lý tuần tự các listing đến hạn.
- Chỉ chuyển `tracking_status = stopped` (lý do `shop_sales_unchanged_30d`) sau một quan sát **mới, hợp lệ, bằng baseline**, khi chuỗi quan sát hợp lệ đã phủ ít nhất 30 ngày và khoảng hở quan sát hợp lệ không quá `MAX_VALID_OBSERVATION_GAP = 7 ngày`.
- Không dừng trước khi cào; không suy diễn khi crawl lỗi/thiếu data; không tự ý gán `sales = 0`.
- Label hiển thị UI: "Không quan sát thấy sales tăng trong 30 ngày" (phản ánh đúng bản chất dữ liệu sàn).

### R3. Cơ chế theo dõi Social theo Author (30/60 ngày)
Triển khai đúng theo Mục 3.3 của tài liệu SSOT:
- Thời hạn tính theo phiên: `expires_at = monitoring_started_at + (is_starred ? 60 : 30) ngày` (UTC).
- Star là trạng thái cấp Author. Star ở ngày 20 kéo dài đến ngày 60 kể từ đầu phiên; unstar ở ngày 40 làm hết hạn ngay lập tức; star lại trong cửa sổ 60 ngày khôi phục trạng thái active.
- Hết hạn khi `now >= expires_at` với timer quét định kỳ mỗi tick, không chờ nhịp 5 ngày. Không tự gia hạn vô hạn khi Discovery thấy post mới.

### R4. An toàn ghi đồng thời và Patch Writer (Concurrency & Data Integrity)
Triển khai đúng theo Mục 5 của tài liệu SSOT:
- Xây dựng shared patch writer (`applyMonitoringObservation`) với field presence: không reset trường vắng mặt về 0, không xóa media/URL cũ.
- Bảo vệ bằng transaction advisory lock / row lock theo `item_uid` cho cả Discovery và Monitoring.
- Dedupe bằng observation ID ổn định; bảo vệ trước quan sát tới muộn; không gọi `insertSnapshots()` cho một item refresh đơn lẻ.
- Mở rộng `daily_packed_history` hỗ trợ explicit observation ID mà vẫn tương thích ngược định dạng cũ.

### R5. Điều phối tài nguyên, Global Limiter và Hàng đợi (Resource Scheduling & Throttling)
Triển khai đúng theo Mục 6 & Mục 10 của tài liệu SSOT:
- Tích hợp qua `ResourceScheduler`, Discovery luôn được ưu tiên tuyệt đối tại khâu admission.
- Giới hạn tối đa **1 capture Monitoring đang thực thi toàn hệ thống** với khoảng nghỉ tối thiểu `MONITOR_ITEM_DELAY_MS = 20000` quản trị bằng lease bền vững trong bảng `monitoring_limiter` (chống split-brain đa tiến trình).
- Retry có exponential backoff + jitter, phân loại lỗi rõ ràng. Shutdown SIGINT/SIGTERM giải phóng lease an toàn.
- Bật cờ `MONITORING_ENABLED=false` mặc định ban đầu; triển khai tuần tự qua 6 giai đoạn (Giai đoạn 0 đến 5) theo Mục 8.

## Acceptance Criteria

### Data Layer & Migration
- [ ] Migration PostgreSQL idempotent: chạy lại nhiều lần trên DB hiện có và DB trắng đều thành công và không ảnh hưởng dữ liệu cũ.
- [ ] Bảng theo dõi độc lập hoàn toàn với Discovery lifecycle; không sửa `query`, `first_seen_at` hay `product_current.status`.
- [ ] Patch writer merge đúng các trường đo được; các trường không có trong payload giữ nguyên giá trị cũ, không bị gán về 0.

### Lifecycle & Policy Verification
- [ ] Shop lifecycle: Shop không bị dừng khi chưa có quan sát mới; dừng chính xác khi chuỗi quan sát bằng baseline kéo dài đủ 30 ngày (khoảng hở <= 7 ngày); reset baseline khi sales tăng.
- [ ] Social lifecycle: Tính hạn chót chính xác theo `monitoring_started_at` (30 ngày và 60 ngày); unstar sau ngày 30 làm hết hạn ngay; timer quét expiry tự động độc lập với nhịp crawl 5 ngày.

### Concurrency & Scheduler
- [ ] Test ghi đồng thời (Discovery run + Monitoring refresh trên cùng `item_uid`): advisory lock ngăn chặn race condition, không mất update, không deadlock.
- [ ] Global limiter bảo đảm không bao giờ có quá 1 capture Monitoring chạy đồng thời và luôn tuân thủ khoảng nghỉ tối thiểu 20s.
- [ ] Feature flag `MONITORING_ENABLED=false` vô hiệu hóa hoàn toàn dispatcher Monitoring mà không tác động tới Discovery.
- [ ] Đáp ứng đầy đủ ma trận 8 nhóm kiểm thử bắt buộc tại Mục 9 của tài liệu SSOT (`docs/DISCOVERY_MONITORING_PLAN_REVISED.md`).

## 2026-09-22T09:17:31Z

**Yêu cầu bổ sung từ User**:
Thêm luồng tích hợp và cài đặt **Camoufox** (https://camoufox.com/ - stealth browser engine dựa trên Firefox chống DataDome/Cloudflare).
Quy tắc fallback:
- Ưu tiên 1: CloakBrowser
- Dự phòng (Fallback): Nếu luồng CloakBrowser thất bại (bị block / lỗi / không khả dụng), tự động fallback sang Camoufox (`camoufox-js` hoặc Camoufox Playwright instance).

Hãy cập nhật yêu cầu này vào scope của Teamwork Project Orchestrator và adapter stealth browser.

## 2026-09-22T09:19:50Z

**Yêu cầu bổ sung từ User**:
Xây dựng giao diện và endpoint quản trị **/admindashboard**:
1. **Theo dõi tác vụ (Task Monitor)**:
   - Hiển thị danh sách các task đang chạy (`running`).
   - Hiển thị danh sách các task chuẩn bị chạy / xếp hàng (`queued` / `pending` / `scheduled`).
2. **Chỉ số hiệu năng & độ tin cậy Browser (Camoufox vs CloakBrowser)**:
   - Thời gian chạy trung bình (Average duration / execution time) của từng loại trình duyệt.
   - Tỉ lệ lỗi / thất bại / bị chặn (Error / Block rate %).
3. **Điều khiển tác vụ (Task Controls)**:
   - Có thể sắp xếp thứ tự ưu tiên các task.
   - Có thể bật/tắt (Enable / Disable) từng task hoặc từng adapter/engine.
4. **Cập nhật mã nguồn (Repo Auto-update)**:
   - Có nút bấm để tự cập nhật repo (Trigger git pull / update script trực tiếp từ dashboard).

Hãy cập nhật yêu cầu này vào scope của Project Orchestrator và các UI/API tracks.

## 2026-09-23T02:43:40Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview
> Requested team: Làm 1 team riêng (Dedicated Team for Internet Launch Security & Auth)

Dự án triển khai toàn diện hệ thống Xác thực, Phân quyền (RBAC), Bảo vệ SSRF/MCP Bridge, Quota/Rate Limiting, Backup PostgreSQL và cấu hình phát hành an toàn lên Internet cho Crawler-POD theo mô hình Shared Workspace, kèm tạo Pull Request (PR) hoàn chỉnh khi hoàn tất.

Working directory: d:\tools GTF\crawler-POD
Integrity mode: development

**Tài liệu đặc tả bắt buộc (SSOT)**: Mọi rà soát lỗ hổng P0/P1, threat model, ma trận phân quyền và điều kiện nghiệm thu BẮT BUỘC phải dựa vào tài liệu:
`d:\tools GTF\crawler-POD\docs\INTERNET_LAUNCH_PLAN_2026-09-22.md`

## Requirements

### R1. Xác thực & Phân quyền RBAC (Shared Workspace Model)
- Xây dựng hệ thống người dùng và phiên đăng nhập: Email / Mật khẩu (băm bằng bcrypt/argon2) với Session Cookie an toàn (`HttpOnly`, `Secure`, `SameSite=Lax`).
- Cơ chế phân quyền hai cấp:
  - **Admin**: Quản lý toàn bộ hệ thống, cấu hình Apify tokens, proxies, marketplace accounts/sessions, xem logs/doctor, xóa hàng loạt dữ liệu (`bulk delete`), quản lý tài khoản người dùng và sinh/thu hồi API Key.
  - **Member**: Tạo và theo dõi các run/job cào dữ liệu, xem báo cáo, quản lý lịch cào cá nhân; bị chặn (HTTP 403) khi truy cập các route cấu hình hệ thống, token, proxy, hoặc xóa hàng loạt.
- Hỗ trợ **API Key** (`x-api-key` hoặc `Bearer`) có thời hạn và quyền tương ứng cho các tác vụ tự động/Admin/MCP.
- Tự động khởi tạo tài khoản Super Admin khi khởi động lần đầu qua cấu hình môi trường (`ADMIN_EMAIL`, `ADMIN_PASSWORD`), không để lộ mật khẩu trong logs.

### R2. Bảo vệ Ingress, Chống SSRF & Đóng MCP Bridge
- **Bảo vệ MCP Bridge**: Đóng toàn bộ đường `/api/internal/*` khỏi internet công cộng. Yêu cầu khóa xác thực dịch vụ nội bộ (`INTERNAL_SERVICE_KEY`), loại bỏ việc chỉ tin tưởng lỏng lẻo vào loopback socket (vì reverse proxy trên cùng host sẽ forward làm socket upstream thành 127.0.0.1).
- **Phòng chống SSRF (OWASP Standard)**: Xây dựng module kiểm tra URL dùng chung (`validateOutboundUrl`):
  - Chặn triệt để mọi dải IP nội bộ/private (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16), AWS/GCP cloud metadata (`169.254.169.254`).
  - Kiểm tra IP sau phân giải DNS, chống DNS rebinding và kiểm tra toàn bộ redirect chain (chặn redirect từ public IP về private IP). Áp dụng ngay cho Shopify storeUrl và mọi URL capture.
- **CORS & CSRF**: Giới hạn CORS origin theo môi trường triển khai, bảo vệ CSRF cho các yêu cầu thay đổi trạng thái (POST/PUT/DELETE/PATCH).

### R3. Rate Limiting, Quota & Chống Cạn Kiệt Tài Nguyên (Cost Protection)
- Rate limiting bảo vệ: giới hạn tần suất thử đăng nhập sai (chống brute-force) và giới hạn tần suất gọi API tạo run (`/api/runs`, `/api/jobs`).
- Kiểm soát tài nguyên & ngân sách:
  - Giới hạn số lượng run đang chạy đồng thời toàn hệ thống.
  - Chốt chặn ngân sách Apify: tự động dừng tạo paid actor nếu tài khoản đạt ngưỡng chi phí hoặc số token khả dụng xuống thấp.
  - Cung cấp công tắc dừng khẩn cấp (Emergency Dispatch Freeze) cho Admin trên `/admindashboard`.

### R4. Chuẩn Hóa Backup/Restore PostgreSQL, Docker Production & Vận Hành
- Sửa đổi toàn diện `scripts/backup-manager.js` và `scripts/rollback.js` để sao lưu và khôi phục trực tiếp trên PostgreSQL runtime (`pg_dump` / SQL dump kèm hash SHA-256 integrity), loại bỏ hoàn toàn các đoạn code hướng về SQLite `collector.db` cũ.
- Tối ưu Dockerfile và `.dockerignore`:
  - Loại bỏ hoàn toàn các file nhạy cảm khỏi build context (`.env`, `proxies.txt`, `.backup/`, `logs/`, `data/`).
  - Cấu hình persistent volume cho thư mục media cache.
- Bổ sung các endpoint giám sát vòng đời chuẩn:
  - `GET /livez`: Liveness probe tối giản (xác nhận tiến trình Node.js đang sống).
  - `GET /readyz`: Readiness probe kiểm tra kết nối cơ sở dữ liệu PostgreSQL.
- Xử lý graceful shutdown an toàn (SIGINT/SIGTERM): ngừng nhận request mới, giải phóng các browser lock/limiter lease và đợi các run đang persist hoàn tất trước khi thoát.

### R5. Đóng Gói và Tạo Pull Request (PR) Toàn Diện
- Sau khi toàn bộ các mốc triển khai và kiểm thử hermetic / adversarial đạt 100% nghiệm thu:
  - Tạo nhánh git chuyên dụng (ví dụ: `feat/internet-launch-security-auth`).
  - Commit toàn bộ các thay đổi một cách ngăn nắp, có cấu trúc và thông điệp commit rõ ràng.
  - Đóng gói tài liệu mô tả Pull Request (PR) đầy đủ chi tiết bao gồm: bối cảnh, các vấn đề P0/P1 đã giải quyết, kiến trúc bảo mật mới, các lệnh kiểm thử và hướng dẫn vận hành khi triển khai.

## Acceptance Criteria

### Authentication & RBAC
- [ ] Truy cập các route bảo vệ khi chưa đăng nhập trả về HTTP 401.
- [ ] Member truy cập các API nhạy cảm (token, proxy, session, system config, bulk delete) trả về HTTP 403.
- [ ] Admin thực hiện đầy đủ các quyền quản trị; đăng nhập thành công cấp session cookie `HttpOnly`, `Secure`, `SameSite`.
- [ ] Gọi API với header API Key hợp lệ được xác thực đúng quyền; API Key sai/hết hạn bị từ chối 401.

### Ingress & SSRF Protection
- [ ] Request gửi tới `/api/internal/*` không có `INTERNAL_SERVICE_KEY` hợp lệ bị từ chối 403/404 ngay cả khi gửi qua reverse proxy trên loopback.
- [ ] Nhập URL trỏ về `127.0.0.1`, `localhost`, `10.x.x.x`, `169.254.169.254` hoặc URL public redirect về private IP đều bị từ chối trước khi thiết lập kết nối mạng.

### Rate Limiting & Cost Safety
- [ ] Thử đăng nhập sai quá số lần quy định bị khóa tạm thời (HTTP 429).
- [ ] Khi bật công tắc dừng khẩn cấp (Emergency Freeze), mọi yêu cầu tạo job mới đều bị chặn và thông báo rõ ràng.

### Database Backup & Deployment
- [ ] Chạy `backup-manager.js` tạo bản sao lưu PostgreSQL hợp lệ và khôi phục thử nghiệm thành công vào DB sạch.
- [ ] Docker build context sạch, không chứa tệp chứa secret hay proxies.
- [ ] Endpoint `/livez` và `/readyz` phản hồi chính xác trạng thái của service và cơ sở dữ liệu.
- [ ] Tín hiệu SIGINT/SIGTERM kích hoạt quy trình shutdown an toàn mà không để lại orphaned lock hay corrupt dữ liệu.

### Pull Request & Delivery
- [ ] Nhánh git được tạo sạch sẽ, không sót file rác/untracked test data.
- [ ] Tạo Pull Request đầy đủ tài liệu kiểm chứng (verification evidence) cho toàn bộ thay đổi.

## 2026-09-23T03:27:02Z

Báo cáo tiến độ hiện tại: đang ở milestone nào, bao nhiêu task đã xong, bao nhiêu còn lại? Có lỗi nào không?

## 2026-09-23T03:40:05Z

Cập nhật tiến độ: Worker M1-1 đã hoàn thành task nào rồi? Còn bao nhiêu task trong M1? Ước tính khi nào xong M1?

## 2026-09-23T03:48:05Z

M1 handoff đã xong chưa? Đã bắt đầu M2 chưa? Cập nhật trạng thái hiện tại.

## 2026-09-23T03:56:05Z

Gate 1 đã đóng chưa? M2 đã bắt đầu chưa? Cập nhật nhanh.

## 2026-09-23T04:00:07Z

Gate 1 đã PASSED chưa? M2 worker đã được dispatch chưa? Trạng thái hiện tại?
