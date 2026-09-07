# BÁO CÁO TOÀN DIỆN: XÁC NHẬN DB TARGET → BACKUP → DETERMINISTIC REBUILD → FULL PARITY → LIVE CUTOVER (V2)

> **Dự án**: Crawler-POD  
> **Trạng thái**: ✅ **DB CUTOVER PASS — READY FOR AGENT E2E**  
> **Thời gian thực hiện**: 2026-08-26  
> **Bộ Test Suite toàn hệ thống**: **207 passed / 0 failed / 0 cancelled** (100% Green)

---

## 1. BƯỚC 1: XÁC NHẬN DB TARGET THẬT

- **Target Database Path**: `D:\Tinh\Toolstartup\crawler-POD\data\collector.db`
- **Tệp tồn tại**: `true`
- **Dung lượng file trước cutover**: `3,112,960 bytes (~3.11 MB)`
- **Thống kê bảng trước cutover**:
  - `snapshots`: 188 rows (Legacy snapshots)
  - `runs`: 283 rows
  - `marketplace_captures`: 301 rows
  - `social_bot_state`: 68 rows
  - `platforms`: 13 rows
  - `weekly_summary`: 168 rows
  - `migration_checkpoints`: 1 rows
  - `marketplace_accounts`: 0 rows
  - `marketplace_capture_schedule_runs`: 0 rows
  - `marketplace_capture_schedules`: 0 rows
  - `marketplace_proxies`: 0 rows
  - `v2_write_failures`: 0 rows

---

## 2. BƯỚC 2: ĐÓNG TẤT CẢ TIẾN TRÌNH GHI + SAO LƯU & KIỂM TRA TOÀN VẸN

- **Đóng Writer**: Dừng toàn bộ tiến trình chạy ngầm, thực thi PRAGMA wal_checkpoint(TRUNCATE); và đóng kết nối DB.
- **Tạo bản sao lưu có gắn nhãn thời gian**:
  - Đường dẫn Backup: D:\Tinh\Toolstartup\crawler-POD\data\collector.pre-v2-cutover-20260826-162152.db
- **Khớp mã băm SHA256**:
  - Source DB SHA256: 464ab73fe222d59b28fca963c8e66aa8bd0bb0743b2eecf1da011281356f4a26
  - Backup DB SHA256: 464ab73fe222d59b28fca963c8e66aa8bd0bb0743b2eecf1da011281356f4a26
  - **Kết quả So khớp SHA256**: **100% Khớp (Match)**
- **Kiểm tra tính toàn vẹn (PRAGMA integrity_check)**:
  - Source DB: [{ integrity_check: 'ok' }]
  - Backup DB: [{ integrity_check: 'ok' }]
  - **Kết quả**: **PASS**

---

## 3. BƯỚC 3: DETERMINISTIC REBUILD (TÁI TẠO BẤT BIẾN TỪ SOURCE OF TRUTH)

Dữ liệu legacy snapshots (188 dòng) được tái tạo vào schema V2 (product_current và daily_packed_history) qua dbModule.backfillSnapshotsToV2() qua 2 vòng độc lập để chứng minh tính lũy biến (idempotence):

| Chỉ số kiểm tra | Rebuild Lần 1 | Rebuild Lần 2 (Idempotence) | Kết luận |
| :--- | :--- | :--- | :--- |
| **Số Snapshot xử lý** | 188 / 188 | 188 / 188 | Khớp 100% |
| **Số dòng product_current** | 68 | 68 | Khớp 100% |
| **Số dòng daily_packed_history** | 118 | 118 | Khớp 100% |
| **Tổng số observation count** | 188 | 188 | Khớp 100% |
| **Số observationId duy nhất** | 188 | 188 | Khớp 100% |
| **Số observation trùng lặp (duplicates)** | 0 | 0 | Không có |
| **Số observation dị dạng (malformed)** | 0 | 0 | Không có |

> **Đánh giá Rebuild**: **PASS (Idempotent 100%, 0 duplicate, 0 malformed, 0 data loss).**

---

## 4. BƯỚC 4: BÁO CÁO FULL PARITY TOÀN DIỆN

Kết quả chạy db.checkV2Parity() đối soát 1-1 giữa 188 legacy snapshots và cấu trúc dữ liệu V2:

`json
{
   parityOk: true,
  current: {
    checked: 68,
    totalSnapshotItemUids: 68,
    productCurrentItemUidCount: 68,
    missingCurrentCount: 0,
    missingCurrent: [],
    metricMismatchCount: 0,
    metricMismatches: []
  },
  history: {
    legacyObservations: 188,
    packedObservations: 188,
    missingHistoricalObservations: 0,
    missingHistoricalObservationUids: [],
    duplicateHistoricalObservations: 0,
    duplicateHistoricalObservationUids: [],
    malformedObservations: 0,
    malformedObservationUids: [],
    historyMissingByIdentity: 0,
    historyMissingByIdentityUids: [],
    historyExtraObservations: 0,
    historyExtraObservationUids: [],
    historyMetricMismatches: 0,
    historyMetricMismatchSamples: [],
    historyTimestampMismatches: 0,
    historyTimestampMismatchSamples: []
  },
  checkedAt: 2026-08-26T09:21:52.421Z
}
`

- missingCurrentCount: **0**
- metricMismatchCount: **0**
- missingHistoricalObservations: **0**
- duplicateHistoricalObservations: **0**
- malformedObservations: **0**
- historyMissingByIdentity: **0**
- historyExtraObservations: **0**
- historyMetricMismatches: **0**
- historyTimestampMismatches: **0**
- **Trạng thái Parity**: **parityOk: true (100% tương đương dữ liệu)**

---

## 5. BƯỚC 5: CUTOVER PHASE A (READ MODEL V2 = ON, DUAL WRITE = ON)

Cấu hình kiểm tra: READ_MODEL_V2=true, LEGACY_SNAPSHOT_WRITE=true.

1. **GET /api/items (thông qua db.getProductCurrent)**:
   - Trả về danh sách đầy đủ các item hiện hành với trường mapping chuẩn: item_uid, 	itle, platform, url, image, price, ating, eviews, sold_count, likes, comments, shares, iews, growth.
   - Kết quả: **PASS**
2. **GET /api/items/:uid/history (thông qua db.getProductHistory)**:
   - Trích xuất lịch sử biến động từ daily_packed_history, chuyển đổi các observation điểm mốc thời gian UTC sang timeline points chính xác.
   - Kết quả: **PASS**
3. **GET /api/runs/:id & GET /api/export/:runId (thông qua getRunItems và getProductCurrentByUid)**:
   - Đọc kết quả Run từ uns.result_items_json và tính toán tăng trưởng từ product_current.delta_*.
   - Kết quả: **PASS**

---

## 6. BƯỚC 6: CUTOVER PHASE B (DỪNG GHI VÀO BẢNG CŨ)

Cấu hình kiểm tra: READ_MODEL_V2=true, LEGACY_SNAPSHOT_WRITE=false.

- **LEGACY_SNAPSHOT_COUNT_BEFORE**: **188 dòng**
- **Thực thi Run 1 thật (Shopify crawl https://colourpop.com)**:
  - Số items cào được: 50 items (45 items mới, 5 items kích hoạt cập nhật).
  - Trạng thái Run: done.
  - Kết quả lưu trữ uns.result_items_json: 50 items.
- **LEGACY_SNAPSHOT_COUNT_AFTER_RUN1**: **188 dòng (Số lượng bảng cũ không đổi)**.
- **Biến động bảng V2**:
  - product_current: Tăng từ 68 lên 113 dòng (+45 items mới).
  - daily_packed_history: Tăng từ 118 lên 168 rows.
  - Tổng số observation: Tăng từ 188 lên 238 observations.

> **Đánh giá Phase B**: **PASS (Ghi V2 hoạt động độc lập, 0 snapshot cũ nào được ghi thêm, toàn bộ Run hoàn thành chu trình sống hợp lệ).**

---

## 7. BƯỚC 7: CUTOVER PHASE C (CHẠY LIÊN TỤC & ĐO LƯỜNG TĂNG TRƯỞNG DELTA)

- **Thực thi Run 2 thật (Shopify crawl https://colourpop.com lần 2)**:
  - Cào lại 50 items đang hoạt động (active items) để kiểm tra cơ chế tính delta/growth và gom nhóm observation trong ngày.
  - Trạng thái Run: done.
- **LEGACY_SNAPSHOT_COUNT_AFTER_RUN2**: **188 dòng (Số lượng bảng cũ tiếp tục giữ nguyên bất biến)**.
- **Biến động bảng V2**:
  - product_current: Duy trì 113 dòng, cập nhật trường delta_price, delta_likes, delta_sold và last_seen_at.
  - daily_packed_history: Duy trì 168 rows, mỗi row ngày hôm nay nhận thêm observation mới từ Run 2.
  - Tổng số observation: Tăng lên **288 observations**.
- **Xác thực toàn thể observation**:
  - Tổng số observationId duy nhất: **288**
  - Số observation trùng lặp (duplicates): **0**
  - Số observation dị dạng (malformed): **0**

> **Đánh giá Phase C**: **PASS (V2 vận hành mượt mà, không sinh duplicate observationId, cập nhật delta tăng trưởng chính xác).**

---

## 8. BƯỚC 8: KIỂM TRA TỔNG THỂ HỆ THỐNG SAU CUTOVER

1. **PRAGMA integrity_check;**:
   - Kết quả: [{ integrity_check: 'ok' }]
2. **Kiểm tra Parity lịch sử**:
   - historyMissingByIdentity: 0
   - historyMetricMismatches: 0
   - historyTimestampMismatches: 0
   - duplicateHistoricalObservations: 0
   - malformedObservations: 0
3. **Toàn bộ Test Suite tự động**:
   - Tổng cộng: **207 passed / 0 failed / 0 cancelled** (18.5 giây).

---

## 9. QUY TRÌNH ROLLBACK AN TOÀN (NẾU CẦN)

Nếu phát sinh bất kỳ sự cố nào ngoài dự kiến trong tương lai:
1. Đặt lại biến môi trường trong file .env:
   `ash
   READ_MODEL_V2=false
   LEGACY_SNAPSHOT_WRITE=true
   `
2. Khôi phục cơ sở dữ liệu từ file backup pre-cutover:
   - File backup: data/collector.pre-v2-cutover-20260826-162152.db
   - Khôi phục về: data/collector.db
3. Khởi động lại server (
pm.cmd start).

---

## 10. KẾT LUẬN & TRẠNG THÁI CUỐI CÙNG

Cơ sở dữ liệu V2 (product_current + daily_packed_history + uns.result_items_json) đã được:
1. Xác nhận target thật: data/collector.db.
2. Backup an toàn với SHA256 và integrity check hoàn hảo.
3. Rebuild bất biến (deterministic & idempotent) 100%.
4. Đạt Full Parity không mất mát dữ liệu (0 mismatches, 0 duplicates).
5. Hoàn tất Live Cutover qua cả Phase A, B và C thành công rực rỡ.
6. Cấu hình .env sẵn sàng cho môi trường chạy trực tiếp.

### 🎯 **DB CUTOVER PASS — READY FOR AGENT E2E**
