# CRAWLER-POD — QUY TẮC VẬN HÀNH AI AGENT

**Project root**

```text
D:\Tinh\Toolstartup\crawler-POD
```

**Thư mục rule / handoff**

```text
D:\Tinh\Toolstartup\crawler-POD\docs\AI_RULES
```

**Thư mục backup**

```text
D:\Tinh\Toolstartup\crawler-POD\docs\BACKUPS
```

Tài liệu này quy định **cách AI Agent được phép làm việc trên crawler-POD**.

Mục tiêu của rule là:

- ngăn Agent tự mở rộng scope;
- ngăn Agent sửa đúng “triệu chứng” nhưng làm sai kiến trúc;
- phân biệt rõ source truth, runtime truth và target design;
- bắt buộc backup trước khi sửa;
- ngăn gọi dịch vụ có phí ngoài ý muốn;
- ngăn thay đổi DB, routing, retry, proxy hoặc scheduler dùng chung mà không kiểm soát;
- bắt buộc runtime verification trước khi tuyên bố PASS;
- duy trì handoff đủ rõ để Agent khác tiếp tục công việc mà không phải đoán.

---

# 1. NGUỒN SỰ THẬT VÀ THỨ TỰ ƯU TIÊN

Trước mọi task, Agent phải phân biệt ba loại thông tin:

```text
SOURCE CONFIRMED
= hành vi đã đọc và xác nhận trực tiếp từ source hiện tại.

RUNTIME CONFIRMED
= hành vi đã chạy thật và quan sát được trên hệ thống/runtime.

TARGET DESIGN
= hành vi người dùng muốn hệ thống có, nhưng chưa chắc source hiện tại đã làm.
```

Agent **không được trộn ba loại trên với nhau**.

Ví dụ không được nói:

```text
"RAM-aware đã hoạt động"
```

chỉ vì source có `computeInternalConcurrency()`.

Nếu chưa chạy thật để chứng minh reservation/release thì phải ghi:

```text
SOURCE CONFIRMED: có implementation
RUNTIME CONFIRMED: chưa
```

Khi có mâu thuẫn, thứ tự tin cậy là:

```text
Runtime evidence
> Current source
> Canonical HANDOFF
> Snapshot history
> Report cũ / claim cũ
```

Report cũ không được dùng để phủ định source/runtime hiện tại.

---

# 2. ĐỌC BẮT BUỘC TRƯỚC KHI LÀM

Trước khi thay đổi code, configuration, DB, routing, proxy, scheduler hoặc dữ liệu, Agent bắt buộc:

1. Đọc file rule này.
2. Đọc canonical `HANDOFF.md` trong `docs\AI_RULES` nếu tồn tại.
3. Đọc đúng source liên quan đến task.
4. Xác định entry point thật của flow.
5. Xác định dependency dùng chung có thể bị ảnh hưởng.
6. Kiểm tra snapshot lịch sử chỉ khi task cần truy vết lỗi/decision cũ.
7. Kiểm tra backup gần nhất của các file sắp sửa nếu có.

Không bắt Agent đọc toàn bộ project nếu task chỉ liên quan một flow.

Nhưng không được sửa một flow chỉ dựa trên tên file hoặc report cũ.

---

# 3. BẮT BUỘC TRACE FLOW TRƯỚC KHI SỬA

Với task liên quan crawler/execution, trước khi sửa Agent phải trace:

```text
UI / API
↓
Run creation
↓
Scheduler / admission
↓
ExecutionPlanner
↓
BackendRouter
↓
Provider / scraper
↓
Discovery
↓
Pagination / continuation
↓
Task generation
↓
Worker / InternalTaskPool
↓
Proxy / Browser / CDP / Cloud resource
↓
Normalizer
↓
Persistence
↓
Terminal state
```

Không phải flow nào cũng có đầy đủ mọi tầng.

Agent phải ghi rõ tầng nào:

```text
APPLICABLE
NOT_APPLICABLE
BYPASSED_BY_DESIGN
BUG / DESIGN_MISMATCH
```

Không được gọi một flow là “đi qua Worker Pool đúng thiết kế” chỉ vì Run đã vào Scheduler.

Phải phân biệt:

```text
Run-level concurrency
Task/product-level concurrency
Browser-page concurrency
Provider-managed concurrency
```

---

# 4. ĐỊNH NGHĨA WORKER BẮT BUỘC DÙNG ĐÚNG

Trong crawler-POD:

```text
Run
= một job/request tổng.

Task
= đơn vị công việc độc lập bên trong Run
  ví dụ product, listing URL, capture URL, query.

Worker
= slot thực thi một Task hoặc một Run tùy layer.
```

Agent không được dùng từ `worker` chung chung.

Khi báo cáo phải ghi:

```text
Scheduler worker =
InternalTaskPool worker =
Browser page =
LOCAL request task =
CDP slot =
CLOUD provider execution =
```

Nếu một Run có 100 sản phẩm nhưng chỉ có 4 task lấy ảnh, không được báo:

```text
"100 sản phẩm được xử lý bởi product workers"
```

nếu source/runtime không chứng minh điều đó.

---

# 5. DESIGN CONTRACT HIỆN TẠI

## 5.1 Multi-Run + Multi-Task

Mục tiêu hệ thống:

```text
nhiều Run đồng thời
+
nhiều independent task trong từng Run đồng thời
```

Những bước có dependency thật phải giữ tuần tự.

Những task độc lập có thể chạy song song phải dùng bounded concurrency phù hợp.

Không parallelize mù.

## 5.2 RAM safety

Hệ thống phải giữ phần RAM dự phòng bắt buộc theo design hiện tại.

Agent không được:

- tăng concurrency bằng literal tùy tiện;
- bỏ reservation;
- để nhiều Run tự nhìn cùng một RAM snapshot rồi cùng mở worker vượt budget.

Khi sửa internal concurrency phải kiểm:

```text
compute
reserve
run
finally release
```

và phải xem reservation đó có đi vào **global resource accounting thật** hay không.

## 5.3 Resource class

Phải phân biệt:

```text
LOCAL
BROWSER
CDP
CLOUD
```

Không áp một concurrency rule cho tất cả.

`CDP=1` có thể là intentional exclusive nếu source resource thực sự chỉ có một endpoint/session.

Không gọi hard limit là bug nếu nó phản ánh constraint thật.

## 5.4 Target count / maxItems

Nếu UI/request gửi:

```text
maxItems = N
```

Agent phải xác định rõ semantic thật:

```text
target count
hay
upper bound
```

Nếu design yêu cầu cố lấy đủ N, crawler phải tiếp tục pagination/cursor/scroll cho đến khi:

```text
uniqueItems >= N
```

hoặc nguồn thật sự hết dữ liệu / bị external limit.

Không được báo request `100` là PASS chỉ vì nhận được 20 item từ page 1.

---

# 6. PROVIDER / FALLBACK RULE

Provider priority **không được tự suy đoán dùng chung cho mọi platform**.

Agent phải đọc source + canonical handoff để biết priority của platform đang sửa.

Với những flow đã được quyết định dùng direct browser làm primary, không được tự đưa SearXNG trở lại làm dependency bắt buộc.

Ví dụ các flow đã được quyết định theo pattern direct-browser-first phải giữ nguyên pattern đã được ghi trong handoff:

```text
Direct browser/CloakBrowser primary
↓
optional supplement/fallback
↓
paid/cloud fallback nếu được phép
```

Không được gọi dịch vụ paid chỉ để “verify fallback” nếu người dùng chưa cho phép.

Nếu fallback paid là cần thiết nhưng có khả năng phát sinh phí:

```text
NEED_HUMAN_COST
```

và dừng trước external paid execution.

---

# 7. CLOAKBROWSER / PLAYWRIGHT / BROWSER RULE

Không được tạo thêm browser framework mới nếu project đã có abstraction phù hợp.

Ưu tiên reuse:

```text
CloakBrowser session infrastructure
persistent profile
ProxyPool
executionToken ownership
cleanup
```

Nếu một platform cần parser/navigation riêng, chỉ tạo platform-specific adapter.

Không copy nguyên parser của platform khác rồi sửa sơ sài.

Không được đổi từ CloakBrowser về Playwright Stealth cũ nếu không có lý do + bằng chứng.

Nếu browser anti-bot fail deterministic:

```text
BLOCKED_BY_SITE
CAPTCHA
challenge page
```

không được retry hàng loạt cùng một phương pháp.

---

# 8. RETRY RULE — CẤM RETRY STORM

Agent phải kiểm cả retry bên trong scraper và retry ở Scheduler/Run level.

Không cho phép pattern:

```text
inner retry N
×
outer retry M
```

tạo hàng chục attempt giống hệt nhau cho deterministic failure.

Phải phân loại lỗi:

```text
TRANSIENT_NETWORK
→ retry có giới hạn.

BLOCKED_BY_SITE / CAPTCHA
→ chuyển provider hoặc fail rõ.

PARSER_CHANGED
→ không spam retry.

INVALID_INPUT
→ không retry.

AUTH / ENTITLEMENT
→ không retry mù.

PAID_PROVIDER_ERROR
→ không retry làm phát sinh chi phí ngoài ý muốn.
```

Mọi thay đổi trong global retry policy phải audit regression cho platform khác.

Không sửa generic error code chỉ để fix một platform nếu có thể xử lý cục bộ an toàn hơn.

---

# 9. PROXY RULE

ProxyPool là resource dùng chung.

Trước khi sửa proxy flow phải xác định:

```text
protocol: http / https / socks5
ownership: run-level / task-level
sticky requirement: yes/no
provider/session requirement
```

Không được giả định proxy string `host:port:user:pass` tự nói lên protocol.

Không hard-code protocol khi config/source đã có type.

Không được để một flow có proxy config nhưng sub-request quan trọng lại silently bypass proxy nếu design yêu cầu proxy coverage.

Khi test proxy:

- không log password/token đầy đủ vào report;
- không ghi credential vào snapshot;
- chỉ báo protocol, proxy id masked và result.

---

# 10. APIFY / PAID SERVICE SAFETY

Agent KHÔNG được tự gọi paid actor/service chỉ để test nếu chưa có explicit permission.

Trước external paid execution phải xác định:

```text
provider
actor/service
expected cost risk
number of calls
reason
```

Nếu có khả năng tính phí và user chưa cho phép:

```text
NEED_HUMAN_COST
```

Không được coi `APIFY_TOKEN configured` là quyền tự động tiêu tiền.

Không được thay local/free flow bằng Apify chỉ vì dependency phụ đang down nếu local primary vẫn hoạt động.

---

# 11. DATABASE SAFETY

Database hiện tại là dữ liệu cần bảo toàn.

Agent không được:

- rebuild DB;
- reset DB;
- delete history;
- truncate table;
- migrate schema;
- đổi persistence model;
- chạy destructive data cleanup;

trừ khi task yêu cầu rõ ràng và đã có backup/rollback plan.

Trước task có nguy cơ ảnh hưởng DB phải xác định:

```text
tables affected
write path
transaction boundary
history effect
rollback
```

Nếu chỉ cần test parser/flow, ưu tiên test không phá dữ liệu.

Nếu runtime test sẽ ghi Run/snapshot bình thường theo behavior hệ thống thì được phép, nhưng phải report Run ID và dữ liệu test chính.

Không dùng DB làm scratch storage.

---

# 12. BACKUP BẮT BUỘC TRƯỚC KHI SỬA

Mọi file sắp chỉnh sửa phải được backup trước.

Backup root:

```text
D:\Tinh\Toolstartup\crawler-POD\docs\BACKUPS
```

Cấu trúc:

```text
docs\BACKUPS\YYYY-MM-DD\<task-id>\
```

Backup phải giữ relative path đủ để rollback.

Không backup sau khi đã sửa.

Không overwrite backup cũ của task khác.

Trong report phải ghi:

```text
Backup created:
Rollback:
```

---

# 13. SCOPE CONTROL — QUAN TRỌNG

Mỗi instruction chỉ được sửa scope đã yêu cầu.

Ví dụ người dùng nói:

```text
"Sửa eBay Sold Collect"
```

Agent không được tiện tay:

- rewrite Etsy;
- thay Facebook Ads;
- đổi toàn bộ Scheduler;
- sửa UI ngoài phạm vi;
- đổi DB architecture.

Nếu phát hiện vấn đề ngoài scope:

```text
OUT_OF_SCOPE_FINDING
```

ghi lại và không sửa.

Nếu shared component bắt buộc phải sửa:

1. nói rõ shared file;
2. giải thích vì sao không thể fix cục bộ;
3. liệt kê consumer khác;
4. chạy regression tương ứng.

Không dùng “cleanup/refactor” để mở rộng scope.

---

# 14. SHARED COMPONENT CHANGE GATE

Các file/nhóm sau là high-impact shared components:

```text
scheduler
execution-planner
worker-pool
internal-task-pool
resource-monitor
backend-router
retry-policy
database
proxy-pool
server routes dùng chung
platform/channel registry
```

Trước khi sửa phải ghi:

```text
WHY SHARED CHANGE IS REQUIRED
AFFECTED FLOWS
PUBLIC CONTRACT PRESERVED
REGRESSION PLAN
ROLLBACK PLAN
```

Nếu có cách platform-local an toàn hơn, ưu tiên platform-local.

---

# 15. TESTING RULE

Agent phải tự động test mọi thứ có thể test an toàn.

Không bắt user manual test nếu Agent có thể tự chạy.

Chỉ để user test khi:

```text
NEED_HUMAN
NEED_HUMAN_COST
NEED_HUMAN_LOGIN
NEED_HUMAN_EXTERNAL_ACCESS
```

Mọi test phải ghi:

```text
Test case
Input
Expected
Observed
Result
Evidence
```

## 15.1 Runtime chính

Runtime:

```text
http://localhost:20129
```

Sau khi sửa Node source/module, Agent phải xác định có cần restart server để load code mới không.

Không test nhầm process cũ.

## 15.2 Functional PASS

Một flow chỉ được đánh dấu functional PASS khi:

```text
UI/API
↓
Run
↓
backend/provider
↓
result
↓
DB/UI output
```

đi hết end-to-end theo scope test.

Compile/unit test alone không đủ.

## 15.3 Test paid flow

Paid path không được live test nếu chưa cho phép.

Nếu cần paid runtime mới đủ bằng chứng:

```text
verification blocked: NEED_HUMAN_COST
```

---

# 16. KHÔNG SỬA TEST ĐỂ CHE BUG

Không được sửa assertion chỉ vì implementation mới làm test fail.

Chỉ sửa test khi contract thực sự thay đổi có chủ đích.

Khi sửa test phải báo:

```text
OLD CONTRACT
NEW CONTRACT
WHY TEST IS STALE
```

và phải có test chứng minh behavior mới.

---

# 17. VERIFICATION LEVELS

Dùng đúng nhãn:

```text
SOURCE CONFIRMED
RUNTIME CONFIRMED
HUMAN CONFIRMED
UNVERIFIED
BLOCKED
PARTIAL
```

`Completed` chỉ dùng khi acceptance criteria đã đạt.

Không nói “không còn blocker” nếu còn acceptance criterion chưa test.

---

# 18. BUG REPORT FORMAT

```text
ID:
Flow:
Severity:

EXPECTED:
ACTUAL:
REPRODUCTION:
ROOT CAUSE:
SOURCE EVIDENCE:
RUNTIME EVIDENCE:
SMALLEST SAFE FIX:
REGRESSION RISK:
STATUS:
```

Nếu root cause chưa xác nhận:

```text
ROOT CAUSE: UNCONFIRMED
```

---

# 19. FAILURE REPORT FORMAT

### Attempt
Đã thử gì.

### Result
Kết quả/lỗi chính xác.

### Cause
Nguyên nhân confirmed hoặc hypothesis.

### Lesson
Điều không nên lặp lại.

### Next Action
Bước tiếp theo.

Không lặp lại cùng cách làm nếu chưa có bằng chứng mới.

---

# 20. CANONICAL HANDOFF

Canonical handoff:

```text
D:\Tinh\Toolstartup\crawler-POD\docs\AI_RULES\HANDOFF.md
```

Trong project chỉ có một canonical file mang đúng tên `HANDOFF.md`.

Cấu trúc:

```text
# Project Objective
# Current Architecture
# Current Functional Status
# Current Data/DB Status
# Provider Priority Decisions
# Worker / Resource Decisions
# Known Issues
# Latest Meaningful Changes
# Verification Status
# Open Risks
# Next Steps
# Continuation Guide
```

Không dùng HANDOFF để dump toàn bộ logs.

---

# 21. HANDOFF SNAPSHOT

Snapshot history:

```text
D:\Tinh\Toolstartup\crawler-POD\docs\AI_RULES\HANDOFF_SNAPSHOTS\YYYY-MM-DD\
```

Tên file:

```text
HANDOFF_SNAPSHOT_001.md
HANDOFF_SNAPSHOT_002.md
...
```

Numbering reset mỗi ngày.

Mỗi snapshot tối đa 5 report.

Không overwrite report cũ.

Khi đủ 5 report:

```text
SEALED
```

Snapshot chưa đủ 5 chỉ được append report mới ở cuối.

---

# 22. KHI NÀO PHẢI GHI HANDOFF

Phải cập nhật HANDOFF + snapshot khi có thay đổi có ý nghĩa:

- code/config thay đổi;
- provider priority thay đổi;
- routing thay đổi;
- DB/persistence thay đổi;
- worker/concurrency thay đổi;
- retry/reliability thay đổi;
- proxy behavior thay đổi;
- bug/root cause quan trọng được xác nhận;
- verification status thay đổi;
- acceptance criteria thay đổi;
- architecture decision mới;
- implementation session kết thúc ở trạng thái meaningful.

Không cần tạo report cho trao đổi thuần túy không thay đổi state/decision.

---

# 23. SNAPSHOT REPORT FORMAT

```md
# HANDOFF SNAPSHOT xxx

Date: YYYY-MM-DD

---

## Report N

### User Prompt
<nguyên văn text prompt>

### Scope
...

### Investigation
...

### Changes Made
...

### Files Changed
...

### Backup
...

### Verification
...

### Runtime Evidence
...

### Problems And Failures
...

### Important Decisions
...

### Remaining Risks
...

### Next Steps
...
```

Không nhúng secret/token/full proxy credential.

---

# 24. SECRET / CREDENTIAL RULE

Không ghi plaintext vào report/handoff:

- APIFY_TOKEN;
- API key;
- cookie;
- password;
- full proxy credential;
- account auth secret.

Khi cần báo cáo:

```text
APIFY_TOKEN: configured
Proxy: proxy-07 / masked
Cookie: present
```

Không dump full `.env`.

---

# 25. INTERACTIVE LOGIN

Marketplace `Sign in with browser` là human-interactive flow.

Không mặc định coi việc nó nằm ngoài crawler WorkerPool là bug.

Audit theo:

```text
session lifecycle
profile lock
timeout
cleanup
credential persistence
```

Chỉ đưa vào Scheduler nếu có explicit architecture decision.

---

# 26. UI / API CONTRACT

Khi UI nhận:

```text
keyword
country
maxItems
proxy
```

backend adapter phải map đúng schema provider.

Không bắt user nhập low-level provider field như `startUrls` nếu UI contract là keyword-based, trừ khi UX được quyết định thay đổi.

Nếu provider schema thay đổi:

```text
UI contract
→ adapter
→ provider input
```

phải được kiểm lại.

---

# 27. DATA QUALITY TÁCH KHỎI FUNCTIONAL AVAILABILITY

Tách:

```text
Functional crawl
= Run chạy, URL/ảnh/core item về được.

Data quality
= price, currency, reviews, sold count, engagement, advertiser metadata...
```

Functional PASS không có nghĩa mọi metric đều chính xác.

Handoff phải ghi rõ level đã verify.

---

# 28. PERFORMANCE / STRESS TÁCH KHỎI FUNCTIONAL PASS

Functional PASS không tự động chứng minh:

- multi-run stress safe;
- RAM reservation đúng;
- proxy saturation safe;
- DB performance đủ;
- 100+ task concurrency tối ưu.

Phải có test riêng.

---

# 29. KHÔNG TỰ REFACTOR SAU KHI FIX

Sau khi target behavior PASS:

```text
dừng
→ review diff
→ regression
→ report
```

Không tiếp tục cleanup/rename/rewrite nếu user không yêu cầu.

---

# 30. CHECKLIST TRƯỚC KHI SỬA

```text
[ ] Đã đọc rule.
[ ] Đã đọc HANDOFF.
[ ] Đã xác định SOURCE/RUNTIME/TARGET.
[ ] Đã trace flow.
[ ] Đã xác định scope.
[ ] Đã xác định shared components có thể bị ảnh hưởng.
[ ] Đã xác định paid/external risk.
[ ] Đã xác định DB/data risk.
[ ] Đã backup file trước khi sửa.
[ ] Đã có rollback plan.
[ ] Đã có verification plan.
```

---

# 31. CHECKLIST TRƯỚC KHI BÁO COMPLETED

```text
[ ] Acceptance criteria đã đạt.
[ ] Source diff đã review.
[ ] Tests phù hợp đã PASS.
[ ] Runtime target flow đã PASS hoặc ghi rõ verification blocked.
[ ] Persisted/result data đã kiểm.
[ ] Failure path phù hợp đã kiểm.
[ ] Không gọi paid provider ngoài ý muốn.
[ ] Không có secret trong log/report.
[ ] Shared regression đã kiểm nếu sửa shared component.
[ ] Backup path đã ghi.
[ ] HANDOFF đã update nếu cần.
[ ] Snapshot đã append/create đúng rule.
[ ] Remaining risks đã ghi rõ.
```

Nếu thiếu verification bắt buộc:

```text
UNVERIFIED
```

hoặc:

```text
PARTIALLY COMPLETED
```

Không dùng `COMPLETED`.

---

# 32. OUTPUT TỐI THIỂU SAU MỖI IMPLEMENTATION TASK

```text
STATUS:
SCOPE:
FILES CHANGED:
BACKUP:
WHAT CHANGED:
VERIFICATION:
RUNTIME EVIDENCE:
REGRESSION:
KNOWN LIMITATIONS:
NEXT ACTION:
```

Nếu có lỗi mới:

```text
BUG / FINDING:
```

Nếu không có blocker:

```text
NO KNOWN BLOCKER IN TESTED SCOPE
```

Không được nói “toàn hệ thống hoàn toàn ổn” trừ khi toàn hệ thống đã được test theo acceptance criteria tương ứng.

---

# 33. NGUYÊN TẮC CUỐI

AI Agent phải tối ưu theo thứ tự:

```text
Correctness
> Evidence
> Safety
> Scope control
> Maintainability
> Speed
```

Khi chưa chắc:

```text
đọc source
→ chạy test
→ thu bằng chứng
→ rồi mới kết luận
```

Không đoán.
Không tự mở rộng scope.
Không tuyên bố PASS giả.
Không tiêu tiền ngoài ý muốn.
Không sửa shared architecture mà không kiểm regression.
Không phá dữ liệu để tiết kiệm thời gian.
