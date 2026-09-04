# QUY TRÌNH HƯỚNG DẪN KIỂM THỬ THỦ CÔNG GIAO DIỆN WEB (UI MANUAL TEST PROCEDURE)
**Hệ thống:** Crawler-POD Web Dashboard  
**Đối tượng sử dụng:** Tester / QA / Vận hành viên không chuyên kỹ thuật  
**URL truy cập máy chủ:** `http://localhost:20129` (hoặc `http://localhost:3000`)

---

## I. TỔNG QUAN GIAO DIỆN WEB DASHBOARD

Giao diện Crawler-POD Dashboard được chia thành các khu vực chức năng chính:

1. **Thanh Header (Đầu trang):**
   - **Thống kê tổng quan (Stats Badges):** Hiển thị tổng số Runs đã chạy, tổng số sản phẩm trong cơ sở dữ liệu và số nền tảng hỗ trợ.
   - **Nút Doctor:** Kiểm tra sức khỏe kết nối các nền tảng cào dữ liệu.
   - **Nút Marketplace Accounts / Proxies:** Quản lý phiên đăng nhập và proxy tài khoản sàn.
   - **Nút Social Bots:** Quản lý và kích hoạt bot lắng nghe mạng xã hội.
   - **Nút Chuyển đổi Giao diện (Theme Toggle):** Sáng / Tối.

2. **Khu vực Tạo tác vụ cào dữ liệu mới (New Crawl Form):**
   - Chọn nền tảng (Platform Dropdown): Shopify, Reddit, eBay, Etsy, Amazon, TikTok, Facebook, Instagram...
   - Ô nhập Từ khóa / Đường dẫn Storefront (Query Input).
   - Thanh trượt / Ô nhập số lượng sản phẩm tối đa (Max Items).
   - Nút **"Bắt đầu Cào Dữ Liệu" (Start Crawl)**.

3. **Bảng Danh sách Tác vụ (Jobs / Runs Table):**
   - Hiển thị ID tác vụ, Nền tảng, Từ khóa, Trạng thái (QUEUED, RUNNING, DONE, FAILED), Thời gian bắt đầu, Số sản phẩm thu thập được.
   - Nút **Tải về JSON / Tải về CSV (Excel)**.
   - Nút **Xóa / Dừng tác vụ**.

4. **Lưới Hiển thị Sản phẩm (Product Grid / Items Table):**
   - Hiển thị từng sản phẩm dạng thẻ: Ảnh thumbnail, Tên sản phẩm, Giá bán, Lượt bán, Lượt đánh giá, Điểm sao, Tên Shop.
   - **Chỉ số Tăng trưởng (Growth Indicators):** Hiển thị biến động giá (xanh lá/đỏ), mức tăng lượt bán, mức tăng like/view so với lần cào trước.
   - Bấm vào sản phẩm để mở **Biểu đồ Lịch sử Biến động (Product History Modal)**.

---

## II. DANH SÁCH CÁC KỊCH BẢN KIỂM THỬ THỦ CÔNG (TESTCASES)

---

### TESTCASE 1: CÀO SẢN PHẨM SHOPIFY (HAPPY PATH)
- **Mục tiêu:** Kiểm tra quy trình cào dữ liệu hoàn chỉnh từ Storefront Shopify.
- **Các bước thực hiện:**
  1. Tại ô **Platform**, chọn `Shopify`.
  2. Tại ô **Store URL / Query**, nhập: `https://colourpop.com`.
  3. Tại ô **Max Items**, chọn `20`.
  4. Bấm nút **"Bắt đầu Cào Dữ Liệu" (Start Crawl)**.
- **Kết quả mong đợi:**
  - Một dòng tác vụ mới xuất hiện trong bảng Jobs với trạng thái `RUNNING` (hoặc `QUEUED` rồi chuyển sang `RUNNING`).
  - Sau khoảng 2-5 giây, trạng thái chuyển sang màu xanh `DONE`.
  - Cột Items hiển thị `20`.
  - Lưới sản phẩm bên dưới được cập nhật 20 sản phẩm mới của Colourpop kèm đầy đủ ảnh, giá tiền `$`, tên sản phẩm.

---

### TESTCASE 2: XEM BIỂU ĐỒ LỊCH SỬ & BIẾN ĐỘNG TĂNG TRƯỞNG (GROWTH DELTA)
- **Mục tiêu:** Kiểm tra khả năng hiển thị dữ liệu lịch sử quan sát đa mốc từ Database V2.
- **Các bước thực hiện:**
  1. Thực hiện lại Testcase 1 thêm 1 lần nữa với cùng URL `https://colourpop.com`.
  2. Chờ tác vụ thứ 2 hoàn thành (`DONE`).
  3. Quan sát các thẻ sản phẩm trên lưới:
     - Kiểm tra xem có hiển thị các thẻ biến động tăng trưởng (Delta badge) màu xanh lá hoặc xám hay không.
  4. Bấm chuột trực tiếp vào bất kỳ thẻ sản phẩm nào.
- **Kết quả mong đợi:**
  - Cửa sổ Modal **Product History** mở ra.
  - Hiển thị danh sách các mốc thời gian quan sát (Observations) của sản phẩm đó.
  - Không có thông báo lỗi `Cannot read properties of undefined` hoặc lỗi tải dữ liệu.

---

### TESTCASE 3: XUẤT BÁO CÁO CSV (EXCEL) VÀ JSON
- **Mục tiêu:** Đảm bảo file xuất ra mở được trên Microsoft Excel chuẩn tiếng Việt, không bị lỗi font.
- **Các bước thực hiện:**
  1. Tại bảng Jobs, tìm dòng tác vụ vừa hoàn thành.
  2. Bấm nút **"CSV"** (hoặc biểu tượng Excel).
  3. Mở file CSV vừa tải về bằng Microsoft Excel hoặc Notepad.
  4. Bấm nút **"JSON"** để tải file định dạng JSON.
- **Kết quả mong đợi:**
  - File CSV tải về có tên dạng: `shopify_https_colourpop_com_<timestamp>.csv`.
  - Mở trên Microsoft Excel: Các tiêu đề cột hiển thị rõ ràng tiếng Việt (Ví dụ: `Crawled Date/Time (Ngày giờ cào)`, `Price ($) (Giá bán)`, `Sold Growth (Tăng trưởng lượt bán)`).
  - Không có hiện tượng ký tự rác (lỗi mã hóa font UTF-8).
  - File JSON chứa cấu trúc object `{ run: {...}, items: [...] }` chuẩn xác.

---

### TESTCASE 4: TÌM KIẾM VÀ LỌC SẢN PHẨM TRÊN GIAO DIỆN
- **Mục tiêu:** Kiểm tra tính năng lọc sản phẩm theo nền tảng và từ khóa.
- **Các bước thực hiện:**
  1. Tại thanh tìm kiếm trên lưới sản phẩm, nhập từ khóa (ví dụ: `Lipstick` hoặc `Shadow`).
  2. Chọn bộ lọc nền tảng: `Shopify` hoặc `All Platforms`.
  3. Chọn sắp xếp theo: `Mới nhất` hoặc `Giá cao đến thấp`.
- **Kết quả mong đợi:**
  - Danh sách sản phẩm lập tức lọc theo đúng từ khóa.
  - Tốc độ hiển thị tức thì, mượt mà.

---

### TESTCASE 5: KIỂM TRA HỆ THỐNG DOCTOR (SYSTEM HEALTH CHECK)
- **Mục tiêu:** Xác minh tính năng tự chẩn đoán của hệ thống.
- **Các bước thực hiện:**
  1. Bấm nút **"Doctor"** trên thanh điều hướng đầu trang.
  2. Quan sát bảng chẩn đoán hiện ra.
- **Kết quả mong đợi:**
  - Bảng Doctor liệt kê đầy đủ 13 kênh nền tảng.
  - Nền tảng Shopify hiển thị trạng thái khả dụng với backend `local-scraper`.
  - Các nền tảng cần API Key (Amazon, Facebook, Instagram) hiển thị trạng thái cảnh báo thiếu Token một cách tường minh, kèm hướng dẫn bổ sung token.

---

### TESTCASE 6: QUẢN LÝ VÀ KÍCH HOẠT SOCIAL LISTENING BOT
- **Mục tiêu:** Kiểm tra modal cấu hình Bot mạng xã hội.
- **Các bước thực hiện:**
  1. Bấm nút **"Social Bots"** trên thanh Header.
  2. Xem danh sách các bot (Reddit, Twitter, Facebook, Instagram, TikTok).
  3. Bấm nút **"Trigger"** tại bot Reddit với từ khóa `tech`.
- **Kết quả mong đợi:**
  - Thông báo kích hoạt thành công hiển thị trên giao diện.
  - Hệ thống ghi nhận trạng thái chạy mà không gây gián đoạn hay treo trang web.

---

### TESTCASE 7: XÓA TÁC VỤ VÀ DỌN DẸP LỊCH SỬ
- **Mục tiêu:** Đảm bảo xóa tác vụ khỏi danh sách hiển thị hoạt động tốt.
- **Các bước thực hiện:**
  1. Tại bảng Jobs, chọn một tác vụ cũ.
  2. Bấm nút biểu tượng **Thùng rác (Delete/Remove)**.
  3. Xác nhận xóa khi có hộp thoại hỏi.
- **Kết quả mong đợi:**
  - Dòng tác vụ đó lập tức biến mất khỏi bảng Jobs.
  - Số lượng "Total Runs" trên thanh Header giảm đi 1 tương ứng.

---

## III. BẢNG CHECKLIST ĐÁNH GIÁ ĐẠT CHUẨN (PASS CRITERIA)

| Hạng mục kiểm tra | Tiêu chuẩn đạt | Kết quả thực tế |
| :--- | :--- | :--- |
| **Giao diện Dashboard** | Tải trang nhanh, không lỗi Javascript Console | [ ] Đạt / [ ] Chưa đạt |
| **Cào dữ liệu Shopify** | Chạy thành công, trả về đủ items và ảnh | [ ] Đạt / [ ] Chưa đạt |
| **Biến động tăng trưởng (Delta)** | Hiển thị chính xác sau 2 lần cào liên tiếp | [ ] Đạt / [ ] Chưa đạt |
| **Xuất file Excel CSV** | Mở trên Excel hiển thị tiếng Việt hoàn hảo | [ ] Đạt / [ ] Chưa đạt |
| **Lịch sử sản phẩm (Modal)** | Hiển thị đầy đủ các mốc thời gian quan sát | [ ] Đạt / [ ] Chưa đạt |
| **Bảng Doctor** | Chẩn đoán rõ ràng tình trạng kết nối | [ ] Đạt / [ ] Chưa đạt |
| **Quản lý Social Bots** | Thao tác kích hoạt và lưu cấu hình mượt mà | [ ] Đạt / [ ] Chưa đạt |

---
**Tài liệu được tạo tự động bởi Antigravity Engine sau khi vượt qua Full E2E System Validation.**
