# Biên bản kiểm chứng kế hoạch Discovery/Monitoring

22/09/2026 — HEAD `40fc263abb27a2a34d790a7f61bf0afb30522ef7`.

## Phương pháp và giới hạn

Đã sử dụng skill codebase-memory, mức Verify, qua CLI của **codebase-memory-mcp** tại `C:/Users/admin/AppData/Local/Programs/codebase-memory-mcp/codebase-memory-mcp.exe` phiên bản 0.10.6. Đây là công cụ graph thật, không phải generic Memory MCP hoặc việc đọc `.codegraph` rồi tự gọi là MCP.

Trong phiên này native tools không xuất hiện trực tiếp trong danh sách callable. Binary 0.11.0 tại `.local/bin` báo conflict với daemon 0.10.6; dùng đúng binary daemon đã truy vấn thành công. Không sửa config, không kill phiên MCP của người dùng.

- `list_projects`: project `D-tools-GTF-crawler-POD`, root `D:/tools GTF/crawler-POD`, branch main, 4.292 nodes/9.804 edges.
- `index_status`: ready. `get_graph_schema`: đã đọc node/edge types.
- `check_index_coverage`: generation/indexed_at `2026-09-22T08:31:38Z`, full, recording complete, generation_matches=true. Các file chính báo `freshness=metadata_changed`, nên graph chỉ dùng dẫn đường, mọi kết luận quan trọng có source fallback.
- `pg-schema.sql` parse_partial tại nhiều dòng DDL; `public/index.html` partial dòng663. Đã yêu cầu đọc source thay vì suy luận từ graph thiếu node.
- Coverage paths: `src/database.js`, `src/database/{pg-schema.sql,schema-v2.js,pg-client.js,product-current.js,daily-history.js}`, `src/runs.service.js`, `src/marketplaces/html-capture.js`, `server.js`, `public/{app.js,index.html}`.
- Coverage scopes: `src/normalize`, `src/marketplaces`, `src/reliability`, `src/scheduler`, `src/channels`, `src/backends`, `src/social-bots`; không ghi nhận issue trong các scope, không có trang tiếp theo. Điều đó không chứng minh toàn bộ graph đầy đủ.
- Đã gọi coverage bổ sung cho 18 file evidence của subagent: parser/validation/capture scheduler, scheduler/worker pool, execution lease/managed execution, social scheduler, ranker, normalizers, search discovery, variant pricing và các channel Etsy/eBay/Amazon/Shopify/TikTok Shop. Các file báo no_recorded_issue nhưng metadata_changed; đã dùng source fallback.
- Hai truy vấn `search_graph` tìm các symbol liên quan trả 10 và8 kết quả, đều `has_more=false`. Đã trace hai chiều độ sâu 1 các hàm `executeRun`, `insertSnapshots`, `captureMarketplaceHtml`, không có trang tiếp theo ở các kết quả này. Đã dùng `get_code_snippet` cho capture và upsert.
- Graph trace xác nhận `executeRun → insertSnapshots`, và `runMarketplaceCapture → captureMarketplaceHtml`. Trace báo0 caller cho vài function được gọi qua object/factory trong source: **không diễn giải thành dead code hoặc không có caller**.
- Ba subagent GPT‑5.5 kiểm tra độc lập storage, runtime và policy/API/UI; dùng source fallback. Parent thực hiện graph queries, tổng hợp và đối chiếu chéo.
- `docs/CODEX-NAVIGATION-GUIDE.md` mà hướng dẫn ECC yêu cầu không tồn tại trong repo kiểm tra.

Không chạy collector, không đọc secrets `.env`, không thay DB thật và không chạy test hệ thống/live. Đây là kiểm chứng tĩnh bản kế hoạch; chỉ tạo tài liệu. `.codegraph/` là thư mục untracked có sẵn trước khi làm việc.

## Các bằng chứng chính

Các đường dẫn/dòng dưới đây neo vào HEAD nói trên; line có thể thay đổi khi triển khai.

| Kết luận | Bằng chứng mã nguồn |
|---|---|
| Live DB PostgreSQL, schema-v2 SQLite không được import | `src/database.js:22`, `src/database.js:80`; `pg-client.js:23` mô tả timestamps TEXT |
| Insert current có status new; update reset active | `src/database/product-current.js:49`, `:134` |
| Dropped hiện là vắng khỏi kết quả query trước | `src/database.js:836` |
| Writer biến field thiếu thành 0, ghi đè một số metadata | `src/database/product-current.js:155`, `:237`; `src/database/daily-history.js:104` |
| Pipeline upsert trước append, không dùng full insertSnapshots cho refresh một item | `src/database.js:663`, `:718`; `src/database/product-current.js:150` |
| History packed read-modify-write và observation identity theo run/legacy | `src/database/daily-history.js:29`, `:98`, `:142`, `:169` |
| Identity item theo URL, author/shop URL không đủ làm entity key | `src/database.js:1326`, `:1383`, `:1461` |
| HTML parser chưa lấy tổng shop sales | `src/marketplaces/html-parser.js:5`–`:34` (đọc return fields); source search scope marketplaces |
| Capture có validate, cleanup; URL detail chỉ amazon/ebay/etsy | `src/marketplaces/html-capture.js:8`; `src/marketplaces/validation.js:1` |
| Scheduler đã có pool/lock/admission và managed execution | `server.js:118`; `src/scheduler/scheduler.js:101`, `:285`; `src/reliability/managed-execution.js:33` |
| Etsy capture schedule đang chạy song song tới 4 item, không sequential 20 s | `src/marketplaces/capture-scheduler.js:109` |
| Keyword schedule đã có lease, khác với entity lifecycle | `src/database/pg-schema.sql:235`; `src/database.js:266`; `server.js:504` |
| Cache lookup chưa ràng buộc độ tuổi capture | `src/database.js:1170` |
| Social bot scheduler là seed-query discovery | `src/social-bots/social-scheduler.js:105` |
| Window deltas cần mẫu gần mốc, rank hiện provisional | `src/database/product-current.js:38`, `:217`; `src/ranking/product-ranker.js:4` |
| API items/status/history có đường đọc riêng cần tích hợp | `server.js:1112`, `:1259` |
| CORS rộng và bind 0.0.0.0, admin trigger cần guard thật | `server.js:203`, `:1527` |

Những module/bảng/API `monitoring_*` trong kế hoạch sửa là **đề xuất mới**, không phải chức năng tìm thấy trong repo. Claims không có tính năng được giới hạn ở các schema, router, capture và scheduler source đã kiểm tra, không dựa chỉ vào graph search rỗng.

## Bằng chứng ngoài repo

Đã kiểm tra [Etsy Help: tổng sales công khai](https://help.etsy.com/hc/en-us/articles/360024112734-Where-Can-I-Find-My-Total-Number-of-Sales). Tài liệu nói bộ đếm công khai không tính đơn bị hủy. Do đó kế hoạch không dùng bộ đếm như một ledger đơn hàng tuyệt đối, và không khẳng định một shop không có đơn chỉ vì số quan sát bằng nhau. Chưa chạy thử scraper trên shop live.

## Kết quả kiểm chứng

Giữ mục tiêu hai lớp và chu kỳ mục tiêu5 ngày. Thay lifecycle dùng chung status bằng entity/item state riêng; đưa adapter proof, partial-data contract, idempotency và chống ghi đồng thời thành điều kiện trước khi bật Monitoring. Bản sửa chốt mặc định về Star theo author, deadline theo phiên, không tự resume từ Discovery, chính sách sales dựa trên quan sát và rollout theo capability.

## Review lại bản sửa và tự đánh giá

Subagent reviewer GPT‑5.5 đã đọc lại hai tài liệu, không tìm thấy blocker kiến trúc còn lại; một mâu thuẫn “limiter tùy chọn” so với “sequential toàn hệ thống” đã được sửa thành yêu cầu bắt buộc. Đây là đánh giá thiết kế tĩnh, không thay thế nghiệm thu khi có implementation.

Theo skill agent-self-evaluation: chính xác4/5 (có graph và source, chưa kiểm thử live adapter); đầy đủ4/5 (đã có policy/schema/write contract/runtime/UI/tests, DDL chi tiết nằm ở giai đoạn triển khai); rõ ràng4/5 (tách kết luận và evidence, bản kỹ thuật vẫn dài); khả năng hành động4/5 (có thứ tự và gate, throughput/capability còn cần đo); ngắn gọn4/5 (hai tài liệu tách mục đích, vẫn có lặp để bản kế hoạch tự đủ). Trung bình4,0/5. Ưu tiên tiếp theo khi triển khai: chứng minh adapter bằng fixture/live có kiểm soát; cụ thể hóa migration và test PostgreSQL concurrent writers. Người dùng có thể kiểm tra từng kết luận qua bảng evidence.

Kiểm tra artifact: hai file Markdown UTF-8 đọc được, không ký tự thay thế, không trailing whitespace, liên kết tương đối giữa hai tài liệu tồn tại. Git status chỉ có hai tài liệu mới và `.codegraph/` có sẵn; chưa commit hoặc thay mã ứng dụng.
