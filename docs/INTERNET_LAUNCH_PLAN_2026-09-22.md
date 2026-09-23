# Kế hoạch phát hành Crawler-POD lên internet

Ngày đánh giá: 22/09/2026. Checkout: `main`, commit `40fc263abb27a2a34d790a7f61bf0afb30522ef7`.

**Kết luận: chưa nên mở public. Mức sẵn sàng ước lượng 40/100 — Blocked.** Đây là điểm triage kỹ thuật từ phạm vi đã kiểm tra, không phải chứng nhận bảo mật hay xác suất an toàn. Phần crawler có scheduler và cơ chế phục hồi; lớp bảo vệ cho web nhiều người dùng và quy trình vận hành production cần được hoàn thiện trước.

Phạm vi theo xác nhận của chủ dự án: web chạy trên server, người dùng truy cập qua internet. Tài liệu này là kế hoạch; chưa sửa runtime, deploy, mở port, thay credentials hoặc chạy tác vụ Apify tính phí.

## 1. Căn cứ và độ tin cậy

- Đã dùng **codebase-memory-mcp**, qua CLI của bản 0.10.6 đang chạy trên máy. Bản 0.11.0 ở đường dẫn cấu hình bị xung đột phiên bản; không dừng process hay sửa cấu hình người dùng.
- Project: `D-tools-GTF-crawler-POD`; graph có 4.292 node, 9.804 edge, 340 File node. Đã gọi `list_projects`, `index_status`, `get_graph_schema`, `get_architecture`, `search_graph`, `trace_path` hai hướng, `get_code_snippet`, `query_graph`, `check_index_coverage`.
- Graph generation: `2026-09-22T08:31:38Z`; branch metadata trùng HEAD. Coverage báo `metadata_changed` cho các source đã kiểm tra, `.dockerignore` là `not_tracked` trong metadata của index, và parse partial ở Dockerfile/schema SQL. Vì vậy kết luận quan trọng đều đối chiếu source hiện tại; graph chỉ hỗ trợ tìm đường đi. Không coi số caller bằng 0 là không có caller: injection qua scheduler không được trace đầy đủ.
- Đã đọc Git status/log, cấu hình container, CI, đường API, DB, secrets, queue, mạng crawler, backup và các báo cáo cũ. File hướng dẫn `docs/CODEX-NAVIGATION-GUIDE.md` được yêu cầu trong supplement không có trong repo này.
- Các file untracked đã có trước audit được giữ nguyên. Không đọc nội dung `.env`, `proxies.txt`, token thật hay dữ liệu khách hàng.
- Chưa kiểm tra server production, DNS/TLS/firewall thực tế, full test suite, CI hiện tại từ remote, vulnerability scan dependency/image, tải thực, restore production hoặc luồng trình duyệt đầu-cuối. Báo cáo cũ “READY FOR LIVE TEST” không được dùng thay cho các kiểm tra này.

## 2. Kiến trúc hiện tại và tác động tới phát hành

```text
Browser → Express server.js → API + dashboard static
                            → Scheduler / queue / execution lease
                            → BackendRouter
                               ├─ Local scraper / browser
                               ├─ SearXNG / CDP / Everbee host executor
                               └─ Apify
                            → PostgreSQL hoặc PGlite
                            → ảnh cache public/media + browser profiles

MCP HTTP riêng → API crawler
MCP bridge trong Express → truy vấn SQL qua connection của app
```

Graph xác nhận `executeRun` liên quan tới cập nhật run, snapshots, normalization, heartbeat và media cache. Source bổ sung đường gọi động: API tạo run → scheduler → `executeRun` → `router.run` → adapter → scraper. Do đó một API tạo crawl không được bảo vệ có thể tác động đồng thời tới tài nguyên máy, dữ liệu và tài khoản dịch vụ.

## 3. Những việc phải giải quyết trước khi mở public

P0 = chặn phát hành; P1 = phải hoàn thành hoặc vô hiệu hóa tính năng liên quan trước beta bên ngoài. “Xác nhận” dưới đây chỉ áp dụng phạm vi source/mô phỏng đã ghi, không ngụ ý đã khai thác server thật.

| Mức | Phát hiện và bằng chứng | Hậu quả / công việc cần làm | Điều kiện nghiệm thu |
|---|---|---|---|
| P0 | **API nhạy cảm chưa có auth/RBAC.** [server.js:200](<D:/tools GTF/crawler-POD/server.js:200>) gắn middleware rồi mở routes; tạo run ở dòng 724, quản trị token ở 814, xóa hàng loạt item ở 1305 không kiểm tra danh tính/quyền trong các handler. | Người tới được origin có thể gọi trực tiếp API, không cần đi qua UI. Thêm đăng nhập và phân quyền server-side cho toàn bộ route; admin riêng cho tokens, proxies, sessions, doctor/system, bulk delete. CORS không thay thế auth. | Anonymous bị 401; user thường bị 403 ở admin API; admin được phép; test bằng HTTP trực tiếp. |
| P0 | **Chưa có ranh giới dữ liệu khách hàng trong schema đã kiểm tra.** [pg-schema.sql:43](<D:/tools GTF/crawler-POD/src/database/pg-schema.sql:43>) và bảng accounts/captures/schedules không có tenant/owner; `product_current` dùng `item_uid` làm khóa toàn cục. | Nếu phục vụ khách hàng độc lập, đăng nhập đơn thuần vẫn không tách dữ liệu. Thêm workspace/tenant vào runs, kết quả, lịch, sessions, proxies và history; xác định dữ liệu nào chủ đích dùng chung. Chỉnh unique keys, joins và cache theo mô hình đó. | User A không xem/xóa/export/dùng account/lịch của B bằng cách đổi ID; dữ liệu cũ được gán tenant rõ ràng. |
| P0 | **MCP bridge dựa vào loopback có thể bị mở qua reverse proxy.** [mcp-bridge.js:97](<D:/tools GTF/crawler-POD/src/routes/mcp-bridge.js:97>) kiểm tra raw socket và browser headers, không có service credential. | Nếu proxy trên cùng host forward route này, socket upstream là loopback. Mô phỏng nhận 200 và gọi DB stub. Chặn `/api/internal/*` ở ingress; thêm auth nội bộ và tốt hơn là tách listener/network. Không dựa vào `Origin`, `User-Agent` hoặc `X-Forwarded-For` làm danh tính. | Request ngoài internet qua proxy bị 403/404, kể cả không có browser headers; chỉ service được cấp quyền mới gọi được; truy vấn dùng DB role hạn chế. |
| P0 | **Đầu vào crawl có đường truy cập host nội bộ (SSRF).** [shopify.js:6](<D:/tools GTF/crawler-POD/src/scrapers/shopify.js:6>) nhận hostname tùy ý rồi fetch; mô phỏng ghi nhận gọi `https://127.0.0.1/products.json?limit=1`. | Thiết kế URL policy dùng chung: HTTP(S) hợp lệ, kiểm tra IP sau DNS, IPv4/IPv6, private/link-local/loopback và mỗi redirect; chống thay đổi DNS giữa kiểm tra và kết nối. Cô lập egress worker khỏi DB/admin/cloud metadata. Đường gọi SearXNG/host executor cần allowlist riêng. | Test URL private, redirect public→private, IPv6 và DNS rebinding bị từ chối trước kết nối; luồng crawl hợp lệ vẫn chạy. Chưa chứng minh truy xuất được tài nguyên nội bộ thật. |
| P0 | **Backup/rollback hiện không khớp DB runtime.** [database.js:10](<D:/tools GTF/crawler-POD/src/database.js:10>) dùng PG adapter; [backup-manager.js:34](<D:/tools GTF/crawler-POD/scripts/backup-manager.js:34>) và [rollback.js:1](<D:/tools GTF/crawler-POD/scripts/rollback.js:1>) vẫn hướng tới SQLite `collector.db`. | Chọn PostgreSQL làm cấu hình production; lập backup/restore đúng engine, gồm media/profiles cần thiết và khôi phục encryption key qua kênh riêng. Tách rollback app khỏi phục hồi dữ liệu. | Restore backup vào DB mới thành công; đối chiếu dữ liệu và giải mã session mẫu; có RPO/RTO và người chịu trách nhiệm. Không coi file SQLite cũ là backup PG. |
| P1 | **Giới hạn tài nguyên chưa thành quota theo khách hàng.** [collection-inputs.js:6](<D:/tools GTF/crawler-POD/src/collection-inputs.js:6>) có cap 10.000 item và 50 keyword; [scheduler.js:113](<D:/tools GTF/crawler-POD/src/scheduler/scheduler.js:113>) enqueue run, giới hạn thực thi/RAM không phải giới hạn tổng yêu cầu/chi phí của user. | Bổ sung rate limit, quota active/queued/daily theo tenant, cap toàn hệ thống và ngân sách Apify. Giữ chỗ quota nguyên tử trước enqueue, tính cả fan-out/retry/schedule; có công tắc dừng dispatch. | Burst nhiều request bị 429/giới hạn trước khi tạo hàng loạt run; chạy đồng thời không vượt quota; hết ngân sách không mở paid job mới. |
| P1 | **Compose đang mang giả định máy dev.** [docker-compose.yml:13](<D:/tools GTF/crawler-POD/docker-compose.yml:13>) phụ thuộc host executor, PG host mặc định, publish port và bind mount source. | Viết cấu hình production riêng: immutable image, private origin, DB explicit, healthcheck, CPU/RAM/PID/disk limits. SearXNG dùng version/digest cố định. Kiểm chứng từng backend trên Linux sạch, không phụ thuộc Chrome/session ở máy Windows. | Deploy trên máy staging mới từ tài liệu; chỉ ingress public; các backend đã công bố hoạt động hoặc báo unavailable rõ ràng. |
| P1 | **Cache ảnh xung đột với mount chỉ đọc.** [media-cache.js:36](<D:/tools GTF/crawler-POD/src/media-cache.js:36>) ghi `public/media`, Compose mount `/app/public:ro`. Download còn kiểm tra 8 MB sau khi đọc cả body vào RAM. | Dành writable persistent volume/object storage cho media; giới hạn byte trong lúc stream, timeout/concurrency, quota/retention; rà redirect theo URL policy. | Ảnh nguồn hết hạn vẫn hiển thị sau restart/redeploy; không lỗi EROFS; response quá lớn bị hủy sớm. |
| P1 | **Secrets có mức bảo vệ chưa đồng nhất và build context cần làm sạch.** Sessions dùng AES-256-GCM trong [encrypted-store.js:24](<D:/tools GTF/crawler-POD/src/security/encrypted-store.js:24>); [apify-token-pool.js:197](<D:/tools GTF/crawler-POD/src/apify-token-pool.js:197>) ghi token raw ra JSON. Dockerfile `COPY . ./`, nhưng `.dockerignore` chưa loại `proxies.txt`, `.backup`, `logs`, `public/media`. | Dùng secret store hoặc mã hóa token lưu đĩa; quyền file tối thiểu; backup/key rotation. Chuyển Docker COPY sang allowlist hoặc bổ sung ignore, tránh đóng gói dữ liệu máy dev. Đây là nguy cơ đóng gói, chưa kết luận image đã bị phát tán secrets. | Image/build context và logs không chứa config/proxy/session/token thật; kiểm thử mất key/rotation/restore có hành vi rõ ràng. |
| P1 | **Chưa có bằng chứng release gate production.** [ci.yml:1](<D:/tools GTF/crawler-POD/.github/workflows/ci.yml:1>) cài dependencies và chạy `npm test`; chưa thể hiện build image, auth/tenant/proxy E2E hay restore drill. | Thêm gate ở phần 6. Rà startup migrations/backfills và graceful shutdown. [server.js:1519](<D:/tools GTF/crawler-POD/server.js:1519>) log fatal exceptions nhưng chưa có lifecycle shutdown rõ ở entrypoint. | Artifact được kiểm thử chính là artifact deploy; restart giữa crawl không mất/nhân đôi dữ liệu hoặc bỏ quên paid execution. |

Lưu ý bổ sung: [pg-client.js:439](<D:/tools GTF/crawler-POD/src/database/pg-client.js:439>) có nhánh TLS với `rejectUnauthorized: false`; khi dùng DB qua mạng phải cấu hình xác thực certificate/CA đúng nhà cung cấp và kiểm thử thực tế. Không mặc định coi kết nối có TLS là đã xác thực danh tính DB.

## 4. Mô hình rollout đề xuất

**Bản đầu: beta theo lời mời, một app instance, một scheduler đang dispatch, PostgreSQL và browser workers trong mạng riêng.** Chưa tăng replica app khi chưa chứng minh scheduling/lease/recovery an toàn giữa nhiều process. Không cần đưa Kubernetes hay queue mới vào ngay chỉ để phát hành.

```text
Internet → HTTPS ingress → auth + API/dashboard
                            ├─ PostgreSQL private
                            └─ scheduler → worker/browser → internet qua egress policy

Admin/MCP/host executor → kênh nội bộ có auth, không route qua public ingress
Media → storage bền vững; kiểm soát truy cập nếu chứa dữ liệu riêng
Backup → nơi lưu tách biệt, có mã hóa và lịch kiểm thử restore
```

Nếu chỉ một nhóm tin cậy dùng chung workspace, có thể phát hành beta sau cổng đăng nhập với mô hình shared workspace được ghi rõ. Nếu nhiều khách hàng độc lập, hoàn tất tenant isolation trước khi tiếp nhận dữ liệu của họ. Không dùng một Apify token/browser profile chung như danh tính của mọi khách hàng.

## 5. Các gói công việc theo thứ tự thực hiện

Các khoảng thời gian là ước lượng ban đầu cho một kỹ sư quen repo, chưa phải cam kết; độ phức tạp multi-tenant và onboarding tài khoản marketplace có thể làm tăng đáng kể.

| Gói | Việc cần giao | Người phụ trách đề xuất | Phụ thuộc | Ước lượng |
|---|---|---|---|---|
| A — Chốt phạm vi beta | Chọn shared workspace hay khách hàng độc lập; số user/job đồng thời; nguồn crawl được hỗ trợ; ngân sách/ngày; vùng server; RPO/RTO. Viết threat model và ma trận route public/user/admin/internal. | Chủ sản phẩm + backend | Không | 0,5–1 ngày |
| B — Danh tính và dữ liệu | Auth/session, logout/revocation, RBAC; tenant schema/migration/query/cache nếu cần; audit log hành động nhạy cảm; cập nhật MCP client để tương thích auth mới. | Backend | A | 3–7 ngày; tenant có thể lâu hơn |
| C — Chống lạm dụng crawler | URL/egress policy, đóng internal bridge, quota/rate/budget, validation đồng nhất mọi entrypoint và schedules. Không cho user tự chỉ định CDP/executor nội bộ. | Backend + hạ tầng | A; quota tenant cần B | 2–4 ngày |
| D — Deploy và khôi phục | Production Compose/ingress/firewall, image sạch, secrets, PG/migrations, volume media, backup/restore, cấu hình Linux browser/executor, runbook rollback. | Hạ tầng + backend | A; B/C trước mở ngoài | 2–4 ngày |
| E — Staging và release gate | Unit/integration PG, E2E hai user, proxy tests, security/dependency/image checks, load/soak, recovery và restore drill. Sửa lỗi rồi chạy lại phần bị ảnh hưởng. | QA + backend + hạ tầng | B/C/D | 2–4 ngày chưa kể sửa lỗi |
| F — Beta hạn chế | Mời 5–10 user, quota thấp, theo dõi 48–72 giờ, tăng quy mô khi đạt gate; có owner xử lý incident. | Chủ sản phẩm + vận hành | E đạt | 2–3 ngày theo dõi |

Mốc hoàn tất dựa trên bằng chứng nghiệm thu, không chỉ thời gian đã trôi qua. Bước triển khai đầu tiên nên là ma trận route và auth/RBAC, đồng thời đóng đường `/api/internal/*` trong thiết kế ingress.

## 6. Checklist nghiệm thu trước phát hành

- [ ] **Access:** tất cả API được phân loại; anonymous/user/admin/internal tests pass; reset password/session expiry/revocation hoạt động nếu dùng tài khoản mật khẩu; cookie Secure/HttpOnly/SameSite và CSRF phù hợp cơ chế auth; CORS chỉ cho origin cần thiết.
- [ ] **Tenant:** hai account độc lập không truy cập chéo run/item/history/export/schedule/session/proxy/media; mọi background job mang tenant context; không collision ở khóa cache/unique key.
- [ ] **Mạng:** public ingress không forward internal/admin ngoài chính sách; không truy cập trực tiếp DB/CDP/MCP/host executor/origin từ ngoài; SSRF tests gồm redirects, DNS và IPv6. Cấu hình `trust proxy` khớp topology và không tin header do client tự gửi.
- [ ] **Tải và chi phí:** quota được kiểm tra trước paid action, bao gồm retry và 50-keyword fan-out; phân biệt limit của mỗi job với ngân sách tổng; đo tại tải dự kiến và 2 lần tải dự kiến, có ngưỡng latency/error/queue age đã chốt.
- [ ] **Tính đúng dữ liệu:** crawl → tiến độ → kết quả → history → export → cancel → schedule pass; không biến lỗi nguồn/CAPTCHA thành thành công hoặc số liệu suy đoán; hiển thị nguồn và thời điểm thu thập.
- [ ] **Khôi phục:** restart giữa crawl, DB tạm down và browser treo không gây job trùng hoặc ghi kết quả cũ; SIGTERM ngừng nhận/dispatch mới và xử lý execution còn chạy; thử restore trên máy/DB sạch.
- [ ] **Artifact:** `npm ci` từ lockfile, test với PostgreSQL tương ứng production, build image, smoke test image; dependency/license/image audit được xem xét; image gắn release SHA/version, không bind mount source dev.
- [ ] **Vận hành:** `/livez` tối giản; `/readyz` kiểm tra app/DB; health từng backend tách khỏi trạng thái sống của app; metrics cho queue age, fail/timeout, RAM/browser count, disk, DB pool, chi phí; cảnh báo và người nhận cụ thể.
- [ ] **Bảo mật trình duyệt/dữ liệu xuất:** rà stored XSS trong dữ liệu crawl và HTML capture, URL scheme/link rendering, CSP/security headers, CSV formula injection; không mở HTML thu thập với quyền của origin app.
- [ ] **Sản phẩm:** onboarding và hỗ trợ khi session marketplace hết hạn, giới hạn nguồn crawl được công bố, retention/xóa/export dữ liệu. Rà quyền sử dụng dữ liệu/ảnh và điều khoản từng nguồn trước phân phối; đây là việc cần quyết định riêng, chưa được xác minh pháp lý trong audit này.

RPO/RTO khởi điểm để thảo luận: mất tối đa 24 giờ dữ liệu, khôi phục trong 4 giờ ở beta. Nếu khách hàng trả tiền cần mức tốt hơn, phải thay bằng mục tiêu đã thống nhất và đo được. Không quảng cáo SLA khi chưa diễn tập và đo tải.

## 7. Triển khai, giám sát và rollback

1. Tạo staging sạch với secrets test; dùng account test và ngân sách crawl giới hạn. Chạy toàn bộ gate qua đúng HTTPS/proxy dự kiến.
2. Trước release: lưu image hiện tại, backup DB đã xác thực, record schema version; dùng migration tương thích hai phiên bản nếu có thể. Không đưa backfill lớn vào boot mà không đo thời gian/khóa DB.
3. Deploy artifact đã test; kiểm tra readiness, login, job nhỏ, history/export và media. Sau đó mới cấp quyền cho nhóm beta.
4. Khi có truy cập chéo tenant, nghi lộ session/token, hoặc paid dispatch vượt cap: khóa tính năng/dispatch liên quan và hạn chế ingress ngay. Thu hồi credential bị ảnh hưởng sau khi xác định phạm vi.
5. Nếu lỗi release: dừng dispatch mới, xác định run ngoài hệ thống còn chạy, quay lại image trước nếu schema tương thích. Nếu cần restore DB, dừng writes và reconcile run/paid action đã xảy ra sau backup; restore DB không hoàn tác phí Apify.
6. Chỉ mở rộng user khi P0 đã đóng, test gate đạt, restore drill thành công và beta không có incident nghiêm trọng chưa xử lý. Rollback app và restore DB phải có người vận hành được chỉ định.

## 8. Kiểm tra đã thực hiện trong lượt này

Lệnh test cục bộ, không mở DB thật:

```powershell
node --test --test-concurrency=1 test/routes/mcp-bridge.test.js test/collection-inputs.test.js test/marketplace-storage-state.test.js
```

Kết quả: **23 pass, 0 fail, 0 skipped**. Phạm vi là validator đầu vào, storage-state normalization và bridge với DB stub; không bao phủ auth/tenant vì các lớp đó chưa được triển khai trên các đường đã kiểm tra.

Hai mô phỏng bổ sung:

- Express bridge + reverse proxy đều bind loopback, DB hoàn toàn stub: request không có browser-origin headers được proxy chuyển tiếp nhận **HTTP 200**, DB stub được gọi **1 lần**. Kết luận có điều kiện: cấu hình production forward bridge qua loopback sẽ làm mất ranh giới dựa vào địa chỉ socket. Chưa biết topology production thực tế.
- Gọi scraper Shopify với `https://127.0.0.1`, thay `global.fetch` bằng stub ném lỗi trước mạng: ghi nhận URL **`https://127.0.0.1/products.json?limit=1`**. Chứng minh thiếu chặn đích ở đường scraper này; không chứng minh đã đọc dịch vụ nội bộ hay bypass firewall thật.

Không chạy toàn bộ `npm test` hoặc script E2E/live-backend chưa kiểm tra tác dụng phụ lên DB/tài khoản hiện hữu. Chưa chạy audit dependency gửi metadata ra dịch vụ bên ngoài; đó là release task còn lại, không được coi là đã pass.

## 9. Tài liệu chính thức dùng đối chiếu

- URL/redirect/DNS và egress protection dựa trên [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). Áp dụng cụ thể vào Shopify là kết luận từ source/mô phỏng ở trên.
- Reverse proxy và cấu hình IP/header cần khớp topology theo [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/) và [Express production reliability](https://expressjs.com/en/advanced/best-practice-performance/).

## 10. Tự rà chất lượng bản kế hoạch

Theo skill agent-self-evaluation: 4,0/5 trung bình; kế hoạch có thể triển khai, nhưng chưa thay thế kiểm thử staging.

| Trục | Điểm | Bằng chứng / phần có thể cải thiện |
|---|---|---|
| Chính xác | 4/5 | Finding chính có source hoặc mô phỏng; graph metadata thay đổi và topology production chưa biết, cần xác minh lại trên staging. |
| Đầy đủ | 4/5 | Bao phủ access/data/egress/cost/deploy/recovery; chưa chạy dependency scan, full E2E/load hoặc kiểm tra server thật. |
| Rõ ràng | 4/5 | Có severity và nghiệm thu; tenant/egress cần thống nhất với người triển khai để chuyển thành cấu hình cụ thể. |
| Hành động được | 4/5 | Có gói công việc, phụ thuộc, vai trò, gate; chưa có tên owner/ngân sách/tải mục tiêu do chủ dự án chưa cung cấp. |
| Ngắn gọn | 4/5 | Chi tiết được giữ trong tài liệu để giao việc; có thể rút gọn sau khi chốt shared workspace hay multi-tenant. |

Cải thiện ưu tiên: (1) chốt mô hình user/dữ liệu và ngân sách; (2) kiểm thử qua topology staging thật; (3) điền owner và số đo tải/RPO/RTO. Tự kiểm: đánh giá này phù hợp yêu cầu lập kế hoạch; không tuyên bố các lỗi đã được sửa hoặc phần mềm đã đủ an toàn để public.
