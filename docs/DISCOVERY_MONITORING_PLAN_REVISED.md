# Kế hoạch đã hiệu chỉnh: Discovery và Monitoring

Ngày kiểm chứng: 22/09/2026. Mã nguồn: `40fc263abb27a2a34d790a7f61bf0afb30522ef7`.

Đây là bản thay thế kế hoạch được gửi trong `Pasted text.txt`, chưa phải tính năng đã triển khai. Đã đối chiếu bằng codebase-memory-mcp và đọc mã nguồn; xem [biên bản kiểm chứng](./DISCOVERY_MONITORING_VERIFICATION.md).

## 1. Kết luận và phạm vi

Mục tiêu hai lớp hợp lý, nhưng bản gốc chưa thể đưa thẳng vào triển khai. Các lỗi chính là dùng nhầm trạng thái Discovery, giả định scraper đã lấy được shop sales, dừng shop trước khi kiểm tra dữ liệu mới, và chưa bảo vệ ghi đồng thời.

- **Discovery** tiếp tục tìm dữ liệu theo từ khóa, dùng quy tắc lọc và kết quả như hiện tại.
- **Monitoring** có chính sách, lịch, hàng đợi và trạng thái riêng; theo dõi lại các item đã biết, gom theo shop/author có định danh xác thực.
- Hai lớp **độc lập về nghiệp vụ**, dùng chung bộ điều phối tài nguyên và hợp đồng ghi dữ liệu. Không hứa “độc lập hoàn toàn” khi vẫn dùng chung DB, browser, account, proxy và CPU.
- Thay câu “giữ nguyên 100% code” bằng “giữ nguyên hành vi Discovery”. Cho phép sửa hạ tầng ghi và admission để tránh xung đột, có regression tests. Nếu bắt buộc không sửa bất kỳ đường ghi Discovery nào, Monitoring chỉ được ghi kho quan sát riêng, chưa được cập nhật `product_current`/history dùng chung.
- Giai đoạn đầu: nền tảng dữ liệu và Etsy listing theo URL; tự dừng shop chỉ mở sau khi adapter shop sales đạt kiểm thử. Social triển khai theo từng adapter đã chứng minh đọc lại được post chính xác. Không mặc định tất cả nền tảng đều hỗ trợ.

## 2. Những thay đổi bắt buộc so với bản gốc

| Vấn đề bản gốc | Quyết định sửa |
|---|---|
| Dùng `product_current.status = dropped` để ngừng Monitoring | Giữ nguyên trạng thái Discovery. Lifecycle nằm ở bảng theo dõi riêng. Item `new` vẫn đủ điều kiện đăng ký. |
| Shop table chỉ “tùy chọn”, shop sales lặp trên từng sản phẩm | Entity là nguồn dữ liệu duy nhất cho shop/author. Item chỉ tham chiếu entity. |
| Quá 30 ngày thì dừng trước khi cào | Lấy quan sát shop mới và hợp lệ, rồi mới xét dừng. Không dừng từ timestamp cũ hoặc crawl lỗi. |
| Không thấy sales mới tương đương không phát sinh đơn | Đây chỉ là tín hiệu “không quan sát thấy bộ đếm sales tăng”, không chứng minh không có đơn. |
| Sales thiếu mặc định `0` | Thiếu/không hỗ trợ/ước lượng/lỗi phải phân biệt với số 0 thật. |
| Cào một listing chắc chắn lấy được shop sales và variants | Cần capability riêng; parser hiện chưa có shop sales. Variants là tác vụ tốn chi phí riêng, không mặc định quét toàn bộ. |
| Social theo author nhưng Star/deadline theo từng post | Chính sách 30/60 ngày đặt tại author. Nút trên post thể hiện rõ “Theo dõi tác giả”. |
| `first_seen_at + 30 d` làm dữ liệu cũ hết hạn ngay khi bật | Tính từ thời điểm bắt đầu một phiên theo dõi entity (`monitoring_started_at`). |
| Sleep 20 s đủ đảm bảo không cạnh tranh với Discovery | Qua scheduler chung, giới hạn một capture Monitoring đang chạy, kiểm soát account/CDP, cooldown bền vững và ưu tiên Discovery. |
| Tái dùng trực tiếp writer hiện tại | Thêm writer nhận patch và field presence; writer cũ biến nhiều field thiếu thành 0 và tự đổi status. |
| `next_crawl_at DEFAULT NOW()` nhưng test đòi +5 ngày | Không default NOW cho mọi item. Đăng ký lịch rõ ràng, giãn tải, và chỉ lập chu kỳ thành công sau capture thật. |
| Sửa `schema-v2.js` như schema đang chạy | Live DB là PostgreSQL; cập nhật schema/migration PG. SQLite legacy không thuộc đường chạy chính. |

## 3. Quy tắc nghiệp vụ đã chốt cho bản kế hoạch

### 3.1 Identity và phân loại

Khóa entity: `(platform, entity_type, external_id)`; `entity_type = shop | author`. Ưu tiên ID nền tảng; nếu chưa có ID, chỉ dùng URL canonical đã được adapter xác nhận là shop/author, lưu nguồn và độ tin cậy. Không gộp theo display name, tên shop tự do hoặc chuỗi `author`.

Item tiếp tục giữ `item_uid` hiện có; không đổi thuật toán UID hàng loạt. URL canonical mới dùng cho identity entity phải có mapping tới UID cũ, tránh nhân đôi dữ liệu. Chưa xác định được entity thì đưa item vào `pending_identity`, không tự gộp và không áp dụng ngừng theo shop.

Phân loại qua cấu hình channel/adapter rõ ràng, không `DEFAULT ecommerce` cho mọi dữ liệu. Product listing, social post, ad creative và trend signal không có cùng chính sách. Ads/trend chưa hỗ trợ được ghi rõ `unsupported`, không âm thầm coi là shop hoặc author.

### 3.2 Shop và tín hiệu sales 30 ngày

Tổng sales là metric cấp shop, không được đưa vào `current_sold`, `delta_sold` của từng listing. Kiểm tra shop **một lần mỗi chu kỳ**, sau đó xử lý tuần tự các listing đến hạn. Không xem một listing đại diện là đủ, trừ khi adapter chứng minh đó là tổng sales của đúng shop.

Mỗi quan sát ghi `value`, `observed_at`, `source`, `metric_scope`, `quality` và identity shop. Quy tắc:

1. Lần đầu có số hợp lệ: lập baseline; bắt đầu `unchanged_since = observed_at`, không suy diễn shop đã im lặng trước đó.
2. Số tăng: ghi `last_increase_observed_at`, thay baseline, đặt lại `unchanged_since`.
3. Số bằng: duy trì cửa sổ nếu các quan sát đủ gần nhau. Mặc định đề xuất `MAX_VALID_OBSERVATION_GAP = 7 ngày` cho nhịp 5 ngày. Khoảng hở dài hơn làm bắt đầu lại cửa sổ từ lần hợp lệ mới.
4. Số giảm, số làm tròn/ước lượng, đổi nguồn không tương đương, hoặc identity không chắc: đánh dấu chất lượng, không dùng để tự dừng. Số giảm có thể là hiệu chỉnh; tạo baseline/cửa sổ mới sau khi xác thực, không chờ vượt một đỉnh cũ mãi mãi.
5. Crawl lỗi/blocked/login/cache cũ không tạo quan sát thành công, không tăng số ngày bằng chứng. Khi thiếu dữ liệu kéo dài, hiển thị stale/needs_attention và retry có backoff.
6. Chỉ chuyển `tracking_status = stopped`, `reason = shop_sales_unchanged_30 d` sau một quan sát **mới, hợp lệ, bằng baseline**, khi chuỗi quan sát hợp lệ đã phủ ít nhất 30 ngày. Dừng các tác vụ Monitoring của entity; không sửa trạng thái Discovery, không xóa item/history.

Etsy xác nhận sales công khai không tính đơn đã hủy. Vì vậy bộ đếm không phải bằng chứng đơn điệu tuyệt đối và không thể suy ra chắc chắn “không có đơn mới” chỉ từ hai giá trị bằng nhau. UI phải nói “Không quan sát thấy sales tăng trong 30 ngày”, không nói “30 ngày không ra đơn”. [Nguồn Etsy](https://help.etsy.com/hc/en-us/articles/360024112734-Where-Can-I-Find-My-Total-Number-of-Sales).

Nền tảng không cung cấp tổng sales shop đáng tin cậy vẫn có thể theo dõi giá/reviews nếu detail adapter hỗ trợ; **tắt riêng chính sách tự dừng theo sales**, không đặt sales = 0. Star shop chỉ ưu tiên lịch; không mặc nhiên miễn quy tắc dừng 30 ngày.

### 3.3 Social theo author, 30/60 ngày

- `expires_at = monitoring_started_at + (is_starred ? 60 : 30) ngày`, tính UTC.
- Một author có một deadline trong mỗi phiên theo dõi; post phát hiện sau kế thừa deadline đó. Không tự gia hạn vô hạn khi Discovery gặp post mới.
- Star là trạng thái author. Click từ một post cập nhật author và hiển thị tác động tới các post liên quan. Bookmark riêng từng post, nếu cần sau này, là tính năng khác.
- Star ở ngày 20 kéo deadline tới ngày 60 kể từ đầu phiên, không phải thêm 60 ngày từ lúc bấm. Bỏ Star ở ngày 40 làm hết hạn ngay theo mốc 30 ngày.
- Entity `expired` ở ngày 35 có thể trở lại `active` khi Star nếu còn trong cửa sổ 60 ngày của chính phiên đó. Sau ngày 60 phải dùng hành động “Theo dõi lại” để bắt đầu phiên mới; không xóa history cũ.
- Manual pause không bị Star, Discovery hay retry tự hủy. Resume không âm thầm reset deadline; muốn reset dùng “Theo dõi lại”.
- Hết hạn khi `now >= expires_at`; kiểm tra trước capture và trước commit nếu quyền theo dõi đã thay đổi. Timer expiry riêng chạy mỗi tick, không chờ tới lần crawl thứ 5 ngày.
- Phạm vi v1: refresh các post đã biết thuộc author. Phát hiện post mới vẫn thuộc Discovery; quét toàn bộ feed author là capability/phạm vi bổ sung.

### 3.4 Kích hoạt lại

Mặc định đề xuất: **không tự kích hoạt lại entity đã stopped/expired/paused chỉ vì gặp lại trong Discovery**. UI có “Theo dõi lại” với lý do và thời điểm rõ ràng. Discovery vẫn được ingest dữ liệu theo hành vi hiện có.

Tùy chọn sau v1: tự kích hoạt entity dừng vì sales nếu quan sát mới, đáng tin, cùng identity và cùng metric cho thấy tăng; cần event provenance/idempotency và không áp dụng cho manual pause. Không bật mặc định vì Discovery hiện chưa cung cấp đủ bằng chứng shop sales.

## 4. Mô hình dữ liệu đề xuất

Tên dưới đây là thiết kế mới, không phải bảng đã tồn tại. Thiết kế ở mức hợp đồng để lập migration cụ thể.

| Bảng | Trách nhiệm và trường chính |
|---|---|
| `monitoring_entities` | `id`, platform, entity_type, external_id, canonical_url, display_name, identity_source/confidence; tracking_status (`active/paused/stopped/expired`), reason, is_starred; session_id, monitoring_started_at, expires_at; entity_next_due_at, last_success_at; sales nullable, sales_observed_at, unchanged_since, last_increase_observed_at; policy_version, state_version. Unique identity composite. |
| `monitoring_items` | `id`, `item_uid` FK current, `entity_id` nullable FK entity; eligibility (`ready/pending_identity/unsupported`), item_status (`active/paused/unavailable`); next_due_at, last_attempt_at, last_success_at, consecutive_failures. Unique item trong v1, một owner đã xác thực. |
| `monitoring_jobs` | `id`, entity/item target, kind (`shop_probe/item_refresh`), session_id, scheduled_for, status, attempt_count, retry_at, claimed_until, claim_token, execution_token/run_id nếu dùng scheduler; observation_id, state_version lúc claim, started/finished/error. Unique dedup key cho target+kind+session+scheduled_for. |
| `monitoring_entity_observations` | Quan sát append-only: entity_id, session_id, observation_id UNIQUE, observed_at, metric_name/value nullable, source, quality, raw capture reference. Chưa cần thêm engine packed history riêng cho entity ở v1. |

Job FK phải xác định chính xác một target phù hợp với kind; index jobs sẵn sàng/retry theo due time, partial index entities active theo due time, items theo entity+due time. Pagination bằng keyset, không load toàn bộ kho vào RAM.

`is_starred`, trạng thái shop và sales không lặp lại trên từng row `product_current`. Trạng thái hiển thị hiệu lực được join từ entity, item và job; một lỗi capture không tự biến lifecycle thành stopped. **Bắt buộc** có trạng thái limiter bền vững cho global Monitoring slot/cooldown: ví dụ `monitoring_limiter(key PRIMARY KEY, owner_token, leased_until, next_allowed_at)`. Claim/renew/release phải kiểm tra token; bảng không có id phải dùng SQL `RETURNING` tường minh tương thích pg-client. Không được chỉ dùng mutex trong RAM để nghiệm thu giới hạn toàn hệ thống.

Hợp đồng provenance của writer cần nơi lưu `observed_at/source/quality` theo từng metric của item, ví dụ bảng `item_metric_state` hoặc JSONB có schema kiểm soát; metadata này phục vụ cả hai lớp, không chỉ item đã đăng ký Monitoring. Quan sát legacy không có field presence được đánh dấu legacy/unknown, không suy ngược số0 thành phép đo xác thực. Chọn cách lưu cụ thể và lập migration tương ứng ở giai đoạn 2 trước khi bật concurrent writes.

Migration PostgreSQL phải chạy được trên **DB mới và DB đang có**, idempotent; `CREATE TABLE IF NOT EXISTS` không tự thêm cột vào bảng cũ. Khi cần đổi bảng hiện hữu, dùng additive `ALTER ... IF NOT EXISTS` và migration có version/check rõ ràng. Đặt DDL baseline trong `pg-schema.sql`, nối migration vào bootstrap hiện tại; không giả định thư mục migrations đã tự chạy.

Dùng `TIMESTAMPTZ` cho bảng Monitoring mới và ISO UTC ở biên API. Các timestamp cũ vẫn là TEXT: không đổi ngầm. `pg-client.js` dịch `CURRENT_TIMESTAMP` thành TEXT, nên repository mới dùng SQL PG rõ kiểu (`now()`/parameter timestamp) và kiểm thử `.prepare/.run` có `RETURNING` phù hợp; không để adapter tự thêm `RETURNING id` vào bảng không có id.

Backfill entity/item theo batch có checkpoint, chỉ đăng ký nền tảng đủ capability, thiếu identity đưa vào pending. Dữ liệu cũ bắt đầu phiên Monitoring từ lúc opt-in/backfill, không suy ra 30 ngày lịch sử từ `first_seen_at`. Baseline shop mới phải lấy thật. Với item chưa có observation phù hợp, enqueue baseline có giãn tải; còn item đã có observation hợp lệ gần đây thì due = observation đó +5 ngày. Không enqueue mọi item ngay tại thời điểm migration.

## 5. Adapter và hợp đồng ghi dữ liệu

Registry mới tách các capability: `resolveEntity`, `refreshItem`, `readShopSales`, `enumerateVariants`. Chỉ bật từng capability sau fixture tests và thử nghiệm có kiểm soát; tên platform không đủ để suy ra capability.

Mỗi kết quả adapter chứa item/entity identity, observed_at, capture_id/source, chất lượng, các field **thực sự đo được**, currency/price semantics và lỗi phân loại. Capture `ok` hiện tại chưa đủ chứng minh đã vào đúng product; phải kiểm tra identity/field validity riêng. Kết quả cache cũ không phải quan sát mới; Monitoring yêu cầu refresh/bypass cache, ghi cả captured_at và fetched_at.

**Không truyền payload thiếu field trực tiếp vào `upsertItem()` hiện tại.** Writer này mặc định nhiều metric về 0 và reset discovery status. Cần phương thức `applyMonitoringObservation` hoặc shared writer nhận patch với field presence:

1. Validate identity, timestamps và current state/lease token.
2. Mở transaction ngắn, lấy khóa theo `item_uid`; **mọi writer Discovery và Monitoring** phải cùng tuân thủ khóa này. Có thể dùng transaction advisory lock trước khi row tồn tại, theo thứ tự khóa nhất quán. Không giữ transaction trong lúc cào hoặc sleep.
3. Dedupe bằng observation ID ổn định trước khi thay current/delta/count: retry cùng kết quả không được tính lại delta thành 0, tăng count hay thêm history lần nữa. Capture mới ở một attempt khác có observation ID mới; job completion vẫn idempotent.
4. Merge chỉ field có giá trị hợp lệ. Thiếu không xóa `shop_url`, media hoặc metric cũ. Giá đổi currency/variant basis không được trừ delta trực tiếp.
5. Quan sát tới muộn có thể ghi history theo thời điểm thật nhưng không ghi đè giá trị mới hơn. Field-level observed_at/quality hoặc hợp đồng ordering tương đương phải có trước khi bật chung hai writer.
6. Tính delta/window từ các mẫu thực đã đo, rồi cập nhật current và append history trong cùng transaction. History Monitoring phải lưu field presence/source; không sao chép giá trị cũ thành một phép đo mới hoặc để phép tính min/max coi missing là 0.
7. Commit current/history và xác nhận job/lease theo fencing token; lỗi commit không được báo thành công.

`daily-history.js` hiện chỉ hỗ trợ identity `run:`/`legacy:` và fallback theo giây; mở rộng explicit `observationId`, giữ format cũ đọc được. Cần đồng bộ các consumer history/window/summary/UI/MCP với sparse observations trước khi phát hành; fixture lịch sử cũ vẫn đọc được.

Không gọi `insertSnapshots()` cho một item refresh: hàm đó so sánh cả tập kết quả theo query và có thể đánh dấu các item còn lại dropped. Monitoring không sửa `query`, `first_seen_at`, discovery status hay giả mạo một keyword run hoàn chỉnh. Shop sales ghi ở entity observations, không làm tăng rank listing. Rank hiện dùng trọng số provisional; không tự đổi công thức hoặc tuyên bố rank 5 ngày tương đương vận tốc 24h. Không có mẫu hợp lệ gần mốc 3h/24h thì delta cửa sổ phải unknown.

## 6. Worker, lịch và tài nguyên

Một dispatcher Monitoring chạy sau DB bootstrap, quét mỗi 5 phút; không gọi scraper trực tiếp ngoài scheduler. Reuse ResourceScheduler/managed-execution/URL validation/account-CDP locks, nhưng bổ sung run kind/metadata Monitoring để recovery và UI không lẫn với Discovery. Không reuse keyword capture schedule như thể đó là entity monitor.

Quy trình:

1. Reconcile đăng ký item mới theo batch và quét expiry; không phụ thuộc `product_current.status = active`.
2. Chọn entity/item đến hạn, thêm ưu tiên Star có giới hạn và aging để item thường không bị đói. Đây là hàng đợi ưu tiên có fairness, không gọi là FIFO tuyệt đối.
3. Claim job bằng transaction (`FOR UPDATE SKIP LOCKED` hoặc atomic update tương đương), lease có token, hạn, heartbeat. Trigger thủ công đi chung đường claim, không tạo vòng lặp thứ hai.
4. Shop probe trước: quan sát mới → cập nhật policy. Nếu stopped thì hủy/bỏ qua job con chưa chạy. Nếu probe lỗi, không dừng shop; retry probe, các item refresh vẫn có thể chạy nếu policy không yêu cầu probe thành công.
5. Submit một đơn vị capture hữu hạn vào scheduler. Kiểm tra entity/session/state_version và item status trước dispatch, trước commit. Worker mất lease hoặc entity vừa pause/expire không được ghi kết quả mới vào current hay complete job.
6. Sau thành công, `next_due_at = successful_observed_at + 5 ngày + jitter không âm nhỏ`. Jitter v1 đề xuất 0–6 giờ và phải hiển thị rõ đây là chu kỳ mục tiêu, không cam kết giờ cố định. Không đẩy lịch thành công khi capture lỗi.
7. Lỗi retry qua exponential backoff + jitter, giới hạn attempts, phân biệt blocked/login/timeout/unavailable/unsupported. Thử lại vẫn chịu throttling; hết retry chuyển needs_attention, không giả kết luận không bán được.

V1 giới hạn **một capture Monitoring đang thực thi toàn hệ thống**, kể cả nhiều tiến trình. `MONITOR_ITEM_DELAY_MS=20000` là khoảng nghỉ tối thiểu từ khi capture kết thúc tới lần bắt đầu kế tiếp. Không giữ browser slot khi nghỉ. Global slot/cooldown cần lease bền vững, không chỉ mutex RAM; nếu chưa triển khai multi-instance an toàn thì chặn tiến trình Monitoring thứ hai rõ ràng.

Discovery được ưu tiên và có ngân sách tài nguyên dự phòng. Scheduler phải enforce tại admission, không chỉ producer nhìn “đang rảnh”. Account/browser/proxy limiter cần được dùng chung với Discovery khi dùng chung tài nguyên; tốc độ 20 s riêng của Monitoring không bảo đảm tổng request rate hoặc tránh bị chặn. Ban đầu `variantMode=base`; quét variants toàn bộ là tác vụ tùy chọn có timeout/budget riêng.

Ước lượng để sizing: 10.000 item ×20 s nghỉ ≈55,6 giờ, chưa tính thời gian cào. Nếu capture trung bình 10 s thì khoảng 83,3 giờ, chưa tính shop probe/retry/Discovery. 20.000 item với tổng 30 s/item mất 166,7 giờ >5 ngày. Cần hiển thị backlog age, throughput, due vs completed, projected drain time; vượt năng lực thì giảm phạm vi hoặc điều chỉnh SLA, không cam kết cứng 5 ngày.

Shutdown SIGINT/SIGTERM: ngừng nhận job, abort/drain hữu hạn, close resources, nhả lease có token hoặc để hết hạn để recovery tiếp quản. Tránh sleep dài trong transaction hoặc gom cả nghìn item vào managed job timeout 5 phút.

## 7. API và UI

- `PATCH /api/monitoring/entities/:id` với `{isStarred: true|false}`: idempotent, có state version để xử lý thao tác đồng thời. Không dùng POST toggle vì retry có thể đảo ngược thao tác.
- `POST /api/monitoring/entities/:id/pause`, `/resume`, `/restart`: hành vi theo §3, audit reason/session và idempotency key cho restart.
- `GET /api/monitoring/status`: entity/item active, pending identity, unsupported, paused/stopped/expired, queued/inflight/retry/needs_attention, số capture mới thành công, backlog age và độ mới dữ liệu.
- `POST /api/monitoring/trigger`: admin/local operator, trả 202 và tick/job ID; bounded batch, không chờ toàn bộ crawl trong HTTP request; không bỏ qua throttling/lease.
- Extend read API đang dùng để join trạng thái Monitoring và lọc/paginate trong SQL. Không chỉ thêm cột vào DB rồi kỳ vọng UI tự thấy. Dùng UID được URL-encode cho API item hiện hữu.

Server hiện bind `0.0.0.0` và dùng CORS rộng; chưa thể gọi endpoint là “admin” chỉ bằng tên. Trước khi bật API điều khiển, xác định auth/access guard cho deployment, restrict origin theo môi trường, validate body/IDs, bảo vệ URL fetch khỏi host ngoài allowlist/redirect tới địa chỉ nội bộ và không cho trigger tự nhận URL tùy ý. Không đưa account/proxy credentials vào response/log.

UI có hai trạng thái rõ: “Trong kết quả Discovery” và “Theo dõi định kỳ”. Filter Monitoring không tái dùng filter discovery status. Trên post, nút Star ghi rõ tác giả và thời hạn; trên listing hiển thị shop, lần quan sát sales gần nhất và mức tin cậy. Không viết “Đơn mới 2 ngày trước” từ thời điểm crawler thấy bộ đếm tăng; viết “Ghi nhận sales tăng ở lần kiểm tra 2 ngày trước”. Hiển thị pending/unsupported/stale, thời điểm crawl tiếp và lý do dừng.

## 8. Thứ tự triển khai và điều kiện qua giai đoạn

| Giai đoạn | Công việc | Điều kiện hoàn thành |
|---|---|---|
| 0 — Chứng minh adapter | Fixture/shop identity/sales availability, URL post support, price basis, capture freshness | Ma trận capability có bằng chứng. Adapter chưa đạt giữ disabled, không tự dừng shop. |
| 1 — Schema/policy | Bảng mới, migration DB cũ/mới, entity mapping, policy thuần, backfill dry-run | Boundary tests 30/60 d, unknown/reset sales, idempotent migration và báo cáo pending. |
| 2 — Tính đúng khi ghi | Patch writer, idempotency, ordering, khóa chung, history sparse readers | Test PG concurrency Discovery+Monitoring không mất dữ liệu; Discovery regression đạt. Đây là prerequisite, không hoãn tới cuối. |
| 3 — Điều phối an toàn | Queue, lease/fencing, scheduler admission, cooldown, retry, shutdown; Etsy base refresh | Crash/restart/2  workers/manual trigger không cào trùng hoặc stale-write; disable feature không ảnh hưởng Discovery. |
| 4 — API/UI và canary | Guards, filters, Star/expiry/restart, dashboard; canary tập nhỏ Etsy | Hiển thị dữ liệu đúng, rollback flag được kiểm chứng, không bật bulk mặc định. |
| 5 — Chính sách shop và Social | Bật sales stop cho capability đủ bằng chứng; thêm từng social adapter | Mỗi adapter có fixture, identity và fresh capture test; không dựa vào keyword discovery để giả URL recrawl. |

Các điểm sửa chính: `src/database/pg-schema.sql`, `src/database.js`, `src/database/pg-client.js`, `src/database/product-current.js`, `src/database/daily-history.js`, history consumers, `src/scheduler/*`, `src/reliability/*`, `src/marketplaces/*`, `server.js`, `public/app.js`, `public/index.html`; thêm `src/monitoring/{repository,policy,adapters,dispatcher,service}.js` hoặc module tương đương. Không mở rộng schema-v2 legacy chỉ để khớp bản kế hoạch cũ.

## 9. Verification bắt buộc khi triển khai

1. **Policy:** baseline lần đầu, 29d23h59m/30 d/60 d, tăng/bằng/giảm/unknown/rounded, khoảng hở >7 d, probe cuối thất bại hoặc tăng đúng hạn, không nhân sales cho từng listing; Star/unstar/expired/restart/manual pause theo author.
2. **Identity:** trùng display name khác shop/platform, URL alias/query params, thiếu seller/author ID, mapping item cũ, post mới cùng author không reset expiry.
3. **Storage:** DB có sẵn/mới, migrate hai lần, timezone UTC+7, rollback transaction; sparse fields không về 0, shop sales không thành item sold, currency khác không tạo delta sai; history cũ và mới đọc được.
4. **Idempotency/order:** retry cùng observation không tăng count/đổi delta; hai quan sát khác trong cùng giây không mất nhau; observation muộn không đè current mới; concurrent Discovery+Monitoring cùng item và cùng ngày không lost update, kể cả chưa có row history.
5. **Scheduling:** hai worker cùng claim, lease hết hạn, stale worker, crash sau capture/trước commit/sau commit; pause/expire khi đang chạy; global sequential và cooldown qua restart; trigger song song không bypass giới hạn; Star không gây starvation.
6. **Capture:** dùng fixture hợp lệ/challenge/login/404/partial/no-shop-sales/cached-result/redirect; xác thực đúng listing/author, freshness; variants không mặc định quét toàn bộ.
7. **Integration/UI:** Discovery mới vẫn xuất hiện `new`; ingest lại không tự resume Monitoring; filters SQL/pagination đúng trên tập lớn; API auth/input/idempotency; label phản ánh chất lượng bằng chứng.
8. **Operations:** feature flag mặc định off, dry-run không crawl/ghi metrics, canary giới hạn, stop/shutdown/recovery, backlog vượt 5 ngày được báo thật. Không dùng toàn bộ `npm test` mù quáng trước khi phân biệt test local và test gọi mạng; chạy tập deterministic rồi PG integration trong DB test tách biệt.

Kiểm thử tay cuối: keyword Discovery → reconcile đúng identity → baseline hợp lệ → job due bằng fake clock/test DB → capture mới → current/history/policy đúng → Star author → deadline đúng → pause/restart → không ghi sau mất lease. Kiểm tra thời hạn bằng clock injection, không cần chờ30 ngày hoặc sửa clock production.

## 10. Rollout và giới hạn còn lại

Flag `MONITORING_ENABLED=false` ban đầu; dry-run trước, canary một nhóm nhỏ rồi mở rộng theo throughput. Dừng feature chỉ ngừng dispatch và drain/abort có kiểm soát; giữ các bảng và history để điều tra. Không rollback bằng cách xóa dữ liệu hoặc phục hồi `product_current` từ snapshot cũ đè lên Discovery mới.

Chưa xác minh bằng crawler live: độ phủ shop identity/sales, khả năng từng social backend đọc lại URL, chất lượng nguồn thực tế và throughput máy. Đây là điều kiện nghiệm thu adapter, không phải khả năng đã có. Bản kế hoạch này không cam kết tránh chặn IP nhờ một con số sleep.
