# HANDOFF SNAPSHOT 001

Date: 2026-09-16

---

## Report 1: Bóc tách ảnh bìa Video & Sinh thẻ SVG Capture Preview cho bài viết Text

### 1. Yêu cầu & Mục tiêu
- **Video**: Bắt buộc trích xuất ảnh bìa (thumbnail/poster cover), không để trống trường ảnh image.
- **Bài viết Text không có ảnh**: Tự động sinh thẻ SVG capture preview trực quan (data:image/svg+xml;base64,...) hiển thị theo thương hiệu nền tảng (Reddit, Twitter, Facebook, TikTok, Pinterest), avatar ký tự đầu, tiêu đề, trích đoạn nội dung tự ngắt dòng, chỉ số tương tác (Likes, Comments) và badge 📸 Post Capture.

### 2. Các file thay đổi
- `src/image-utils.js`:
  - `cleanImageUrl()`: Chấp nhận định dạng `data:image/svg+xml` data URI.
  - `extractVideoCover(raw)`: Quét hơn 20 trường metadata video thumbnail phổ biến.
  - `generateTextPostCapture(options)`: Sinh ảnh SVG capture 600x360 px với gradient màu nhận diện nền tảng.
  - `generateVideoCoverCapture(options)`: Sinh ảnh poster fallback kèm nút Play ▶ khi remote API không có thumbnail.
- `src/normalize/social-post.js`: Tự động tìm video cover cho video hoặc sinh SVG capture cho bài text không có ảnh.
- `src/database.js`: Cập nhật `parseItemData()` để lưu ảnh capture vào `product_current` và `snapshots`.
- `public/app.js`: Tích hợp `renderItemCapturePreview(item)` hiển thị card trực quan ngay trên lưới khi `!item.image` hoặc khi link ngoài bị lỗi tải (`img.onerror`).

---

## Report 2: Khôi phục cấu trúc nhị phân PGlite (PostgreSQL WAL Crash Recovery)

### 1. Nguyên nhân sự cố
- Khi tiến trình Node.js bị ngắt đột ngột (killed do tắt máy hoặc lệnh stop cưỡng bức), PostgreSQL WASM (PGlite) bị ngắt khi đang ghi dở file WAL `00000001000000000000001C`.
- File điều khiển `global/pg_control` trỏ vào LSN checkpoint dở dang `0/1C48ECA0` khiến PGlite báo lỗi `PANIC: could not locate a valid checkpoint record at 0/1C48ECA0` và abort.

### 2. Giải pháp kỹ thuật đã xử lý
- Quét cấu trúc nhị phân của file WAL `1C`, xác định bản ghi shutdown checkpoint hợp lệ cuối cùng tại LSN `0/1C48C488`.
- Viết script tính toán lại cấu trúc `CheckPointCopy` và mã kiểm tra CRC32C chuẩn Castagnoli (`0x82F63B78`) cho `global/pg_control`.
- Phục hồi thành công 100% dữ liệu gốc: **89.635 sản phẩm** và **362 runs** an toàn nguyên vẹn.
- Tạo thêm bản backup sạch tại `data/pgdata.healthy-backup-852mb`.

---

## Report 3: Lọc và dọn dẹp các Item rác trong Database theo yêu cầu

### 1. Tiêu chí lọc bỏ
Xóa bỏ các item thỏa mãn đồng thời TẤT CẢ các điều kiện thiếu dữ liệu (rác hoàn toàn):
- Không ảnh (`image IS NULL OR TRIM(image) = ''`)
- Không video (`video_url IS NULL OR TRIM(video_url) = ''` và `media_type != 'video'`)
- Không có bất kỳ chỉ số nào của nền tảng (Giá = 0, Rating = 0, Reviews = 0, Sold = 0, Likes = 0, Comments = 0, Shares = 0, Views = 0).

### 2. Dữ liệu sao lưu trước khi xóa (Tuân thủ Rule 12)
- **Thư mục backup**: `docs/BACKUPS/2026-09-16/db-cleanup-empty-items/`
  - `pgdata/`: Toàn bộ thư mục database vật lý trước khi can thiệp.
  - `candidate_deleted_items_product_current.json`: Danh sách 88 sản phẩm rác bị xóa.
  - `candidate_deleted_snapshots.json`: 607 bản ghi snapshots tương ứng.
  - `candidate_deleted_daily_packed_history.json`: 135 dòng lịch sử tương ứng.

### 3. Kết quả thực thi
- `product_current`: Đã xóa **88 items** (Reddit: 83, Amazon: 2, Ebay: 1, Facebook Posts: 1, Twitter: 1). Còn lại **89.567 items** có dữ liệu chuẩn.
- `snapshots`: Đã xóa **607 rows**, còn lại **94.925 rows**.
- `daily_packed_history`: Đã xóa **135 rows**.

---

## Verification Status

- **Database Health (`/api/database/health`)**:
  - `productCurrentRowCount`: 89.567
  - `legacySnapshotRowCount`: 94.925
  - `pendingV2RepairCount`: 0
- **Unit Tests**:
  - `test/social-media-extraction.test.js`: 19/19 PASS
  - `test/reddit-fallback.test.js`: 5/5 PASS
- **Server**: Đang chạy trên cổng `20129` (`http://localhost:20129`).
