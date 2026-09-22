# HANDOFF SNAPSHOT 001

Date: 2026-09-19

---

## Report 1

### User Prompt
"xử lý nốt vấn đề đi đã compact xong rồi"
"xong comment trên #PR 15 đi nhé. sửa cgi thì note ra."

Tiếp nối phê duyệt trước đó ("ok") cho phương án: gộp PR #15 ngay, xử lý lỗi
flake CI ở một PR riêng.

### Scope
Chỉ một việc: tìm nguyên nhân gốc và sửa lỗi flake CI
`capture API returns a successful saved capture instead of starting a browser again`
(`test/marketplace-api.test.js:131`).

Không sửa: TikTok Shop, etsy imageless, checkpoint-store, UI.

### Investigation

Triệu chứng: một run `marketplace_capture` đạt `status='done'` nhưng
`health_snapshot` **không có key `result`**, nên
`submitMarketplaceCaptureViaScheduler()` (server.js:606) không có gì để trả về.
Trước đó Express trả `res.json(undefined)` nên body rỗng, và test báo
`SyntaxError: Unexpected end of JSON input`.

Các giả thuyết đã LOẠI TRỪ bằng bằng chứng source:
- `run-queue.js:61 markDone()` ghi 'done' mà không kèm result. `grep -rn markDone`
  cho thấy **không có caller nào**. Loại.
- Ghi status và ghi result đua nhau. Cả hai nằm trong **cùng một**
  `db.updateRun` ở `managed-execution.js:133`. Loại.
- Cache miss khiến chạy browser thật. Đường đó ném lỗi nên `status='failed'`
  và HTTP 400, không khớp triệu chứng. Loại.

ROOT CAUSE (SOURCE + RUNTIME CONFIRMED):

`HeartbeatTracker.persist()` ghi **cùng cột** `runs.health_snapshot` bằng
`JSON.stringify(this.getSnapshot())`, và snapshot đó **không hề có key `result`**.
`setStage()` gọi `persist()` **không await**, còn `persist()` lại `await` một
lượt đọc quyền sở hữu (`isCurrentOwner` -> `getRunById`) trước khi ghi.

Trong `managed-execution.js`:

```
132: tracker.setStage(STAGES.COMPLETED);   // bắn persist() chạy nền
133: await db.updateRun(runId, { status:'done', healthSnapshot: {result, ...} })
```

Hai lệnh ghi cùng một cột, không có thứ tự bảo đảm. Write nào về đích sau thì
thắng. Khi write của tracker về sau, `result` bị xoá sạch trong khi run vẫn
`status='done'`. Đó là một race, đúng lý do nó hỏng khoảng 50% số lần.

### Changes Made

1. `src/reliability/heartbeat.js`
   - Thêm `this.pendingWrites = new Set()`, tập các persist đang bay.
   - Tách thân `persist()` cũ thành `writeSnapshot()`. `persist()` trở thành hàm
     **không async** để giữ nguyên tính ghi đồng bộ (xem Important Decisions).
   - Thêm `whenPersisted()`, resolve khi mọi persist đã thực sự ghi xong.

2. `src/reliability/managed-execution.js`
   - Thêm `await tracker.whenPersisted();` ngay trước lệnh ghi `result`, để write
     mang `result` chắc chắn là write cuối cùng.

3. `test/reliability.test.js` - thêm 4 test hồi quy.

### Files Changed

```
src/reliability/heartbeat.js
src/reliability/managed-execution.js
test/reliability.test.js
```

### Backup

```
Backup created: docs/BACKUPS/2026-09-19/heartbeat-result-clobber/src/reliability/
Rollback: cp docs/BACKUPS/2026-09-19/heartbeat-result-clobber/src/reliability/*.js src/reliability/
```

### Verification

Test case: runManaged() giữ được `result` khi tracker cũng ghi health_snapshot
Input: fake DB có độ trễ 25ms ở `getRunById`, biến race xác suất thành **tất định**
Expected: `health_snapshot.result` bằng giá trị executor trả về
Observed (TRƯỚC khi sửa): `undefined`, hỏng 4/4 lần, không còn là flake
Observed (SAU khi sửa): đúng giá trị, `status='done'`, `stage='COMPLETED'`
Result: PASS
Evidence: `node --test --test-name-pattern="ManagedExecution" test/reliability.test.js`

Regression: toàn bộ `test/reliability.test.js` = **28/28 PASS** trên một PGlite
sạch, trong đó có test khoá contract
`HeartbeatTracker beats in memory frequently but only flushes DB after the
configured flush interval`. Test đó assert **đồng bộ** `writes.length` ngay sau
`beat()`, nên nó đã quyết định cách sửa (xem Important Decisions).

### Runtime Evidence

Local (PGlite sạch, `test/reliability.test.js`):

```
✔ ManagedExecution: the executor result survives the heartbeat tracker's own snapshot write
✔ ManagedExecution: a falsy-but-defined executor result is still readable back
✔ ManagedExecution: the last health_snapshot write of a successful run is the one carrying the result
✔ ManagedExecution: a failing executor still reports its error rather than a half-written snapshot
ℹ tests 28 | pass 28 | fail 0
```

CI (PostgreSQL thật, full suite, PR #16 — đây mới là môi trường tái hiện được
lỗi gốc, vì dưới PGlite test đó bị skip theo thiết kế):

```
ok 154 - capture API returns a successful saved capture instead of starting a browser again
ok 332 - ManagedExecution: the executor result survives the heartbeat tracker's own snapshot write
ok 333 - ManagedExecution: a falsy-but-defined executor result is still readable back
ok 334 - ManagedExecution: the last health_snapshot write of a successful run is the one carrying the result
ok 335 - ManagedExecution: a failing executor still reports its error rather than a half-written snapshot
# pass 445 | fail 0 | skipped 7
```

Test 154 chính là test hay hỏng. Log xác nhận nó **chạy thật**, không nằm trong
7 test bị skip.

### Problems And Failures

- Chạy `node --test test/reliability.test.js` trực tiếp sẽ mở PGlite **lần thứ
  hai** trên `data/pgdata`, vì file test `require('../src/database')` ở top level.
  Đúng kịch bản đã làm hỏng DB ngày 18/09. Phải chạy với `PGLITE_DIR` trỏ sang
  thư mục scratch, và bootstrap schema bằng `--import` một module ESM gọi
  `db.initDatabase()`. Trên Windows `--import` bắt buộc dùng URL dạng `file:///`.
- Lần chạy thứ hai vào **cùng** thư mục scratch bị treo vì PGlite còn giữ lock.
  Mỗi lần chạy phải dùng một thư mục mới.
- Tiến trình `node server.js` (PID 32468, khởi động 13:26) còn sống nhưng không
  bind cổng 20129. Không kill cưỡng bức, vì force-kill giữa lúc PGlite ghi chính
  là thứ đã làm hỏng data dir ngày 18/09.

### Important Decisions

- **Không** serialize `persist()` bằng promise chain. Cách đó đẩy lệnh ghi vào
  microtask và làm gãy test flush-throttle vốn assert đồng bộ. §16 cấm sửa test
  để che lỗi. Thay vào đó `persist()` vẫn chạy đồng bộ tới `await` đầu tiên, chỉ
  **thêm** khả năng chờ qua `whenPersisted()`.
- **Không** đụng đường channel crawl (`runs.service.js:220`). Lệnh ghi kết thúc ở
  đó là `status/dbCounts/inputOptions` và **không ghi `healthSnapshot`**, nên
  write muộn của tracker chỉ đụng dữ liệu chẩn đoán, không phá dữ liệu nghiệp vụ.
- **Không** đụng đường thất bại (`managed-execution.js:154`). Nó ghi
  `status/errorMessage`, khác cột, không bị clobber. Test thứ 4 chốt điều này.

### Remaining Risks

- Đây là sửa vào **shared component** (§14). Mọi executor không-channel đi qua
  đây: `user_journey`, `marketplace_capture`, `marketplace_discovery`. Hồi quy:
  reliability 28/28 local, và full suite 445/0 trên CI với PostgreSQL thật.
- Chạy full suite **local** không dùng làm bằng chứng được: nó treo vô hạn ở
  `test/amazon-user-journey-fix.test.js` (cần browser/mạng, `--test-timeout=0`).
  Không liên quan thay đổi này — CI chạy đúng file đó và pass.
- Lỗi gốc chỉ tái hiện trên CI với PostgreSQL thật. Dưới PGlite hai test
  cross-process bị skip theo thiết kế. Bằng chứng tất định đến từ test mới, không
  từ chính test hay hỏng.

### Next Steps

- OUT_OF_SCOPE_FINDING (chưa sửa): etsy 86.158/88.939 dòng không ảnh, 97%.
- OUT_OF_SCOPE_FINDING (chưa sửa): `checkpoint-store.js` tính `blocked` và
  `hasProductEvidence` nhưng không ai đọc, nên Amazon vẫn ghi được dòng rác.
- OUT_OF_SCOPE_FINDING (chưa sửa): `POST /api/runs` trả 500 thay vì 400 cho lỗi
  validation.
- Tuỳ chọn: bỏ `pull_request` khỏi trigger CI để mỗi commit chỉ chạy CI một lần.
  Hiện chạy hai lần vì trigger cả `push` lẫn `pull_request`.
