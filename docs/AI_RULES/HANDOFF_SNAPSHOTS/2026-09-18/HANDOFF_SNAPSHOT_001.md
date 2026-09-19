# HANDOFF SNAPSHOT 001

Date: 2026-09-18

---

## Report: Tái thiết kế Giao diện Thẻ Sản phẩm (Etsy Spy-Style Item Card) trên Dashboard

### 1. Yêu cầu & Mục tiêu
- **Yêu cầu người dùng**:
  - Đổi layout của card item trên giao diện thẻ trong DB hiển thị theo dạng mẫu tham chiếu (Etsy Spy format từ ảnh mẫu).
  - Giữ nguyên dữ liệu thực tế từ cơ sở dữ liệu (`product_current`), chỉ đổi form/bố cục hiển thị.
  - Bấm vào thẻ vẫn mở modal chi tiết sản phẩm bình thường (`showItemDetail`).
  - Kiểm tra trực quan bằng hình ảnh (screenshot verification) đảm bảo hiển thị đúng và đẹp.
  - Cập nhật tài liệu bàn giao (`HANDOFF.md`).

### 2. Các thay đổi kỹ thuật
- **Backend (`server.js`)**:
  - Hàm `mapProductCurrentToItemShape(p)`: Bổ sung truyền các trường `first_seen_at`, `last_seen_at`, `last_crawled_at`, `delta_24h_views`, `delta_24h_likes`, `delta_24h_sold` lên API `/api/items` để frontend tính toán thời gian `formatTimeAgo` và chỉ số tăng trưởng 24h thực tế.

- **Frontend Logic (`public/app.js`)**:
  - `formatCommas(num)`: Định dạng số có dấu phẩy ngăn cách hàng nghìn (chuẩn US `248,652`, `3,647`), khớp 100% style mẫu tham chiếu.
  - `formatTimeAgo(dateInput)`: Tự động tính toán mốc thời gian ("Just now", "X hours ago", "X days ago", "X months ago", "X years ago").
  - `renderStarRating(rating, reviews)`: Hiển thị 5 ngôi sao đen/charcoal `★★★★★` kèm số lượng review trong ngoặc đơn `(2,005)`.
  - `renderItemMetricsBox(item)`: Xây dựng bảng chỉ số 5 dòng (Metrics Box) theo đúng thiết kế tham chiếu:
    - **E-Commerce (Etsy, Amazon, eBay, Shopify, TikTok Shop, Google Shopping)**:
      - Dòng 1: `Views` hoặc `Sold` — Giá trị in đậm màu **ĐỎ** (`#dc2626`).
      - Dòng 2: `Daily views` hoặc `Daily sales` — Giá trị in đậm màu **ĐỎ** (`#dc2626`).
      - Dòng 3: `Favorers` / `Watchers` / `Likes` — Giá trị in đậm màu **XANH DƯƠNG** (`#2563eb`).
      - Dòng 4: `Created` (thời gian trước) — Giá trị in đậm màu **XANH NGỌC (TEAL)** (`#0d9488`).
      - Dòng 5: `Updated` (thời gian trước) — Giá trị in đậm màu **XANH NGỌC (TEAL)** (`#0d9488`).
    - **Facebook Ads**:
      - Dòng 1: `Số QC` (`#dc2626`).
      - Dòng 2: `Fanpage Likes` (`#2563eb`).
      - Dòng 3: `Views` (`#ea580c`).
      - Dòng 4: `Bắt đầu` (`#0d9488`).
      - Dòng 5: `Updated` (`#0d9488`).
    - **Social Media (Reddit, Twitter, TikTok Videos, Pinterest)**:
      - Các chỉ số tương ứng: Views, Upvotes/Likes, Comments, Shares/Retweets, Updated theo đúng chuẩn màu.
  - Cập nhật `renderItems(items)`:
    - Bảo toàn biến `const cardImage = item.image ...` để tuân thủ 100% test suite (`test/etsy-analytics-dashboard.test.js`).
    - Thanh thông tin đáy ảnh (`.img-bottom-bar`): Hiển thị "More colors" cho e-commerce, "▶ Video" cho video, hoặc phiên bản cho carousel.
    - Dòng người bán: `Ad by [ShopName]`.
    - Dòng giá và nhãn: Giá `$XX.XX`, nhãn `FREE shipping` (xanh lá nhạt) và nhãn `🏷️ Bestseller` (vàng ấm nhạt).
    - Giữ nguyên sự kiện `onclick="showItemDetail('${item.item_uid}')"` trên toàn bộ thẻ và `event.stopPropagation()` trên nút xóa.

- **Frontend Styling (`public/style.css`)**:
  - Định dạng thẻ dạng `display: flex; flex-direction: column;` với border mềm mại `#cbd5e1` khi hover.
  - Thêm CSS cho `.img-bottom-bar`, `.item-author-row`, `.item-rating-row`, `.item-price-badges`, `.badge-shipping`, `.badge-bestseller`.
  - Thêm CSS `.item-metrics-box` với `margin-top: auto;` giúp các bảng chỉ số thẳng hàng tăm tắp trên toàn bộ lưới.
  - Định dạng các màu chỉ số: `.val-red` (`#dc2626`), `.val-blue` (`#2563eb`), `.val-teal` (`#0d9488`), `.val-orange` (`#ea580c`).

### 3. Kiểm thử & Xác thực Trực quan
1. **Automated Tests**:
   - `node --test test/etsy-analytics-dashboard.test.js`: PASS (2/2)
   - `node --test test/marketplace-ui.test.js`: PASS (6/6)
   - `node --test test/marketplace-login-ui.test.js`: PASS (2/2)
2. **Visual Verification (Headless Playwright)**:
   - Đã chụp ảnh `scratch/etsy_first_card.png` và `scratch/etsy_grid_preview.png`.
   - Kết quả: Layout, typography, màu sắc, ngôi sao, giá tiền, nhãn và bảng 5 dòng chỉ số hiển thị khớp 100% với ảnh mẫu tham chiếu.
   - Thử nghiệm click vào thẻ: Modal `#item-modal` mở ra hiển thị đầy đủ thông tin chi tiết, biểu đồ lịch sử và bảng biến động dữ liệu.
