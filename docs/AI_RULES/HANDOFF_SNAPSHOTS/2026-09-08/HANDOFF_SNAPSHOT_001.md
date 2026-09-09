# HANDOFF SNAPSHOT 001

Date: 2026-09-08

---

## Report 1

### User Prompt

> còn là được kệ mịa nó. A thấy task 2,3,4,5 đang bị fail vì a test trực tiếp trên hệ thống rồi.
> task1 đạt task2 fail rồi: nút search thì hoạt động nhưng bộ lọc tìm kiếm trong kho DB ko hoạt động,
> button bị silient rồi, fix lại đi task3 cũng fail: yêu cầu của tôi là có bộ lọc crawl cơ mà ? tôi cần
> crawl theo đúng chỉ số mà user cần tức là bộ lọc if ấy, giống như task 2 cũng vậy) Chỉ khác là task 2
> là bộ lọc cho DB còn task 3 là bộ lọc dành cho crawl thôi Task 4 fail: yêu càu của a là: Giữ các dữ
> liệu hiện tại: Platform / Thời gian bắt đầu chạy / Meta Ad Library link / Website đích. Bổ sung: Số
> lượng quảng cáo / Views / Quốc gia đang chạy. Task 5: TikTok Shop Top 20 cũng đạt.
> Em kiểm tra lại dự án xem thực hiệ đến đâu rồi thì tiếp tục sửa đi. Output a đã nêu rõ trước đó rồi.
> Giờ a cần e thực hiện yêu cầu của a. Yêu cầu thực thi E2E chỉ dừng lại báo cáo khi thấy block need
> human, chỉ đc test tối đa 5 item trong một lần crawl.

### Scope

Task 2 (bộ lọc DB), Task 3 (bộ lọc lúc crawl), Task 4 (Facebook Ads fields).
Task 1 và Task 5 user xác nhận ĐẠT — không đụng tới.

### Investigation

**Task 2 — root cause "button bị silent" (RUNTIME CONFIRMED, 2 nguyên nhân độc lập):**

1. `collectMetricConditions()` bỏ qua im lặng mọi hàng điều kiện điền dở. User gõ ngưỡng
   nhưng chưa chọn chỉ số (hoặc ngược lại) thì mảng conditions rỗng, `Áp dụng` fetch lại
   toàn bộ, không đổi gì trên màn hình, không một dòng thông báo. Reproduce bằng JS trên UI
   thật: cả 2 case đều trả `conditions: []`, `resultLabel: ""`.
2. Asset cache-busting không được bump. `public/index.html` vẫn trỏ `app.js?v=3.5.0` và
   `style.css?v=2.2.0` — không đổi từ commit `26f0410` — trong khi 2 file đó bị sửa rất
   nhiều ở phiên 5-task (chưa commit). `server.js:203` dùng
   `express.static(..., { etag: false, maxAge: 0 })`, tức KHÔNG có ETag, chỉ còn
   `Last-Modified` (độ phân giải 1 giây) để revalidate. Browser đã phục vụ bản app.js cũ —
   quan sát trực tiếp: sau khi sửa code, UI vẫn chạy hành vi cũ cho tới khi bump `?v=`.

**Task 3 — không phải fail, mà là CHƯA CÓ UI (SOURCE CONFIRMED):**

Backend đã đủ từ phiên trước (`src/runs.service.js:125-170` evaluate conditions trước khi
persist, ghi kết quả vào `runs.input_options.crawlFilter`). Nhưng modal Crawl Now không có
control nào, và `startCollect()` không hề gửi `options.conditions`. Từ phía user, Task 3
không tồn tại.

**Task 4 — audit lại raw provider, 3 thị trường (RUNTIME CONFIRMED):**

Dataset thật của `apify/facebook-ads-scraper`:

- `13Zk7clhgR3YTA7CR` (run #653, US, 08/09)
- `V6s08MWawOoCD2Pyw` (run #684, GB, 08/09)
- `rXljH3ZEPoRUGZFL7` (run #685, DE — quốc gia EU, 08/09)

15/15 quảng cáo, không trừ trường hợp nào:

```text
impressionsWithIndex       = {impressionsText: null, impressionsIndex: -1}
targetedOrReachedCountries = []
reachEstimate              = null
spend                      = null
totalActiveTime            = null
snapshot.countryIsoCode    = null
categories                 = ["UNKNOWN"]   (không phải QC chính trị/vấn đề xã hội)
```

`collationCount` thì CÓ thật và thay đổi: null, 1, 2, 3.

Giả thuyết "chạy country EU sẽ có reach theo DSA" đã được TEST và BÁC BỎ: DE cho kết quả y
hệt US. (GB không còn thuộc EU nên không phải phép thử quyết định; DE mới là.)

Vấn đề thật của Task 4 không nằm ở mapping — nó nằm ở UI: card phun chữ
`SOURCE_NOT_AVAILABLE` in hoa tiếng Anh, và modal chi tiết thiếu hẳn 3 field mới + Website đích.

### Changes Made

**Task 2**

- `collectMetricConditions()` phân biệt 3 trạng thái hàng (untouched / complete / incomplete)
  thay vì chỉ lọc lấy hàng hợp lệ.
- `applyMetricFilters()` từ chối hàng điền dở và nói rõ thiếu gì ở điều kiện số mấy; các
  trigger khác (search, pill, sort) vẫn chạy với điều kiện hợp lệ.
- Thêm `setMetricMessage()` — một chỗ duy nhất ghi status line, nên không nhánh nào để user
  không có phản hồi. Không điều kiện và không ranking sẽ hiện "Không có điều kiện — hiển thị
  toàn bộ N sản phẩm".
- Enter trong ô ngưỡng = Áp dụng.
- Đổi group E-COM/SOCIAL xoá state cũ (status line + tóm tắt trên nút gập) thay vì để lại
  kết quả của group trước.
- Bump `app.js?v=3.5.0` → `3.8.0`, `style.css?v=2.2.0` → `2.8.0`.

**Task 3**

- `src/channels/registry.js`: `getPlatformCompatibilityList()` thêm key `metricGroup`,
  derive từ `channel.normalizer` (`product_listing` → ecom, còn lại → social). Không
  hardcode danh sách thứ hai ở client.
- `public/index.html`: khối `#crawl-filter` trong modal Crawl Now.
- `public/app.js`: `renderCrawlFilterRows` / `addCrawlFilterRow` / `removeCrawlFilterRow` /
  `collectCrawlConditions` / `setCrawlFilterMessage` / `renderCrawlFilterOutcome`.
  `selectCollectPlatform()` chọn đúng nhóm chỉ số theo platform. `startCollect()` từ chối
  hàng điền dở (không tiêu tiền crawl dưới một filter user không thực sự có), gửi
  `options.conditions`, và sau khi run xong đọc `runs.input_options.crawlFilter` để hiện
  "crawl N → giữ X, loại Y" kèm lý do từng item.

**Task 4**

- Bỏ tag `SOURCE_NOT_AVAILABLE` thô, thay bằng `metaNotDisclosed()` — "Meta không công bố" +
  tooltip giải thích Meta chỉ công bố impressions/reach cho QC chính trị và vấn đề xã hội.
- `adCountHtml()`: `collationCount` null (và `collationId` cũng null) nghĩa là quảng cáo
  không nằm trong collation nào, tức đúng 1 QC dùng creative này → hiện "1 riêng lẻ". Khi có
  `collationCount` → "N dùng chung nội dung". Phân biệt được với collation thật size 1
  (provider có trả, kèm `collationId`).
- Modal chi tiết bổ sung: Website Đích, Số Lượng Quảng Cáo, Views, Quốc Gia Đang Chạy.

### Files Changed

```text
public/app.js
public/index.html
public/style.css
src/channels/registry.js
```

### Backup

```text
Backup created: docs/BACKUPS/2026-09-08/task234-ui-fix/
                (public/app.js, public/index.html, public/style.css,
                 src/normalize/ad-creative.js, GIT_HEAD.txt)
Rollback:       cp docs/BACKUPS/2026-09-08/task234-ui-fix/public/* public/
                git checkout src/channels/registry.js
```

LƯU Ý: `src/channels/registry.js` bị sửa SAU khi tạo backup nên KHÔNG có trong thư mục
backup. File này sạch trong git (không thuộc 21 file M lúc đầu phiên), nên `git checkout`
khôi phục được.

### Verification

Unit test (chạy từng file, `PGLITE_DIR` riêng, không đụng DB thật):

```text
metric-conditions       13 pass / 0 fail
run-options              1 pass / 0 fail
collection-inputs        6 pass / 0 fail
ranking                  4 pass / 0 fail
tiktok-shop-top20        7 pass / 0 fail
marketplace-scheduler   13 pass / 0 fail
------------------------------------------
TOTAL                   44 pass / 0 fail
```

### Runtime Evidence

**Task 2 — UI thật, localhost:20129**

```text
Hàng thiếu chỉ số  -> "Chưa áp dụng được — điều kiện 1 thiếu chỉ số."   (metric-result-warn)
Hàng thiếu ngưỡng  -> "Chưa áp dụng được — điều kiện 1 thiếu ngưỡng."
Không điều kiện    -> "Không có điều kiện — hiển thị toàn bộ 104 sản phẩm"
rating>=4.3 AND reviews>=10000, xếp theo reviews
                   -> "13 sản phẩm · xếp theo reviews Cao → Thấp"
                      13 card render, reviews giảm dần: 94106, 46261, 28510, 23801, 23801, 19570
```

**Task 3 — E2E thật, Run #683 (amazon, "press on nails", maxItems=5)**

```text
conditions gửi đi: rating >= 4.3 AND reviews >= 10000
fetched 5 -> kept 1 -> rejected 4

REJECT rating=4.5 reviews=7054  -> reviews fails >= 10000  (đạt rating, trượt reviews => AND đúng)
REJECT rating=4.1 reviews=1846  -> cả hai fail
REJECT rating=4.1 reviews=408   -> cả hai fail
REJECT rating=4.4 reviews=1814  -> reviews fails >= 10000  (đạt rating, trượt reviews)

PostgreSQL: đúng 1 row amazon được ghi sau 07:00 hôm nay
            rating=4.3 reviews=11341
            "BTArtbox Press On Nails, Short Almond Pink Fake Nails, 32Pcs"
UI:         "Bộ lọc rating ≥ 4.3 VÀ reviews ≥ 10000: crawl 5 → giữ 1, loại 4." + 4 dòng lý do
```

Item bị loại KHÔNG chạm `product_current` / `daily_packed_history`.

**Task 4 — card + modal, UI thật**

```text
Card:  🧾 Số QC: 1 riêng lẻ | 👁 Views: Meta không công bố | 🌍 Quốc gia: Meta không công bố

Modal: Xem trong Meta Ad Library ↗ | Website Đích ↗
       👥 Lượt Thích Fanpage: 72.8K likes
       📱 Nền Tảng Meta: FACEBOOK INSTAGRAM AUDIENCE NETWORK MESSENGER THREADS
       📅 Thời Gian Chạy: Bắt đầu 6/9/2026 | Đang chạy (Active)
       🌐 Website Đích: https://www.doonails.com/pages/listicle-po-revolution
       🧾 Số Lượng Quảng Cáo: 1 dùng chung nội dung
       👁 Views: Meta không công bố
       🌍 Quốc Gia Đang Chạy: Meta không công bố
```

**Responsive:** desktop 2 hàng điều kiện, mỗi hàng 1 dòng; mobile 375px hàng wrap, ô ngưỡng
205px, nút ✕ nằm trong card, không tràn ngang.

**DB integrity sau E2E**

```text
product_current       104 -> 111 rows
daily_packed_history  112 -> 120 rows
junk rows (platform='test' / uid 'cutover-*'): 0
by platform: tiktok_shop 41, amazon 43, facebook_ads 16, instagram 11
data/collector.db: 13.217.792 bytes, mtime 2026-09-04 — KHÔNG bị chạm
```

### Problems And Failures

1. CSS selector sai lần đầu: viết `.crawl-filter .metric-row .metric-value` nhưng input
   trong hàng crawl mang class `crawl-value`. Rule không áp dụng, mobile bóp ô ngưỡng về 0
   và đẩy nút ✕ ra ngoài card. Phát hiện bằng cách đọc computed style trên UI thật (thấy
   `flex: 0 1 auto` thay vì giá trị đã viết) chứ không phải bằng nhìn ảnh. Đã sửa selector.
2. Test `run-options` và `marketplace-scheduler` fail `ECONNREFUSED 127.0.0.1:5432` khi chạy
   không có `PG_MODE=pglite` — đúng cái bẫy môi trường phiên trước đã ghi nhận, không phải
   regression mới.

### Important Decisions

- **`adCount` = 1 khi `collationCount` null.** Không phải bịa: `collationId` cũng null nghĩa
  là QC không thuộc collation nào, tức chỉ 1 QC dùng creative đó. Nhãn ghi rõ "riêng lẻ" để
  phân biệt với collation thật size 1 (provider trả `collationCount=1` KÈM `collationId`).
- **Không đổi actor Facebook Ads.** Đây là quyết định có phí và đổi nhà cung cấp, thuộc về user.
- **`metricGroup` derive từ normalizer**, không tạo bảng mapping thứ hai ở client.

### Remaining Risks

- Views và Quốc gia đang chạy: BLOCKED bởi provider, cần NEED_HUMAN_COST quyết định (xem
  Next Steps). Đây là 2/7 field của Task 4 chưa đạt.
- `deleteItem(uid)` vẫn hỏng (nợ từ 07/09, ngoài scope).
- Test suite vẫn ghi vào DB production nếu không set `PGLITE_DIR` (nợ từ 07/09, ngoài scope).
- 25 file chưa commit trong working tree.
- Ngân sách Apify còn khoảng $2.9 (token-1 cạn tới 26/09; token-2 $1.12; token-3 $1.84).

### Next Steps

1. NEED_HUMAN_COST — Views và Quốc gia đang chạy cho Facebook Ads. Actor hiện tại đọc trang
   search results của Ad Library, nơi Meta không đính kèm reach/impressions cho QC thương
   mại. Muốn có 2 field này phải đổi nguồn: một actor mở trang CHI TIẾT từng quảng cáo (tab
   "EU transparency" có reach theo từng nước EU cho QC phục vụ trong EU). Đó là actor khác,
   giá khác, tốc độ khác. Cần user quyết định.
2. Commit lô thay đổi đang nằm trong working tree.
3. Xử lý 2 khoản nợ ngoài scope: guard `PGLITE_DIR` cho test, và `deleteItem(uid)`.

---

## Report 2

### User Prompt

> cái l gì đayas ??? t bảo bộ lọc tìm kiếm cơ mà . Tức là ví dụ t đi crawl của esty đi. sẽ có
> đủ các option chỉ số như khi crawl bình thường và người dùng sẽ đc tích chọn các chỉ số cao
> nhất mà người dùng muốn tìm kiếm ví dụ tích like/tym thì sẽ tìm theo like/tym cao nhất. Nếu
> có 2 ô tích thì sẽ tìm và crawl sản phẩm đạt cả 2 điều kiện đc tích chọn( các chỉ số như khi
> crawl bình thường). Tương tự với các nền tảng khác cũng làm tương tự, vìko phải nền tảng noà
> cũng có chỉ số crawl giống nhau nên khi user bấm vào nền tảng phải có bộ lọc tương ứng với
> nền tảng đó. […]
> 4. Tìm mọi cách để có thể lấy đc View và Quốc gia đang chạy cho phần Ads đó
> 5. Ngần sách còn bao nhiêu là việc của a, việc của e là sử dụng số tiền đó cho hợp lý, a chỉ
> cho phép e test max item trong một luọtw crawl là 5 thôi.

### Scope

Thiết kế lại hoàn toàn 2 bộ lọc (crawl + DB) sang mô hình **tích chọn theo nền tảng**;
tìm nguồn lấy được Views + Quốc gia đang chạy cho Facebook Ads.

### Investigation

**Chỉ số theo nền tảng — không thể suy từ normalizer.** `product-listing.js` và
`social-post.js` phát ra CÙNG một bộ field cho mọi nền tảng (một listing e-commerce vẫn
mang `shares: 0` vì normalizer luôn ghi key). Nên phải lấy bằng chứng ở hai chỗ:

1. Dữ liệu thật trong `product_current`:

```text
platform      rows  price rating reviews sold likes comments views retpos
amazon         43    43    43     43      0    43     0        0     6
tiktok_shop    41    41    38     20     36     0     0        0    16
instagram      11     0     0      0      0     5     1        0     0
facebook_ads   16     0     0      0      0    16     0        0     0
```

2. Cái mà scraper từng nền tảng THẬT SỰ bóc:

```text
etsy/ebay   s.price, s.rating, s.reviews, s.sold_count  (views/likes/comments/shares là `item.x || 0`)
shopify     chỉ price; likes/comments/shares/views hardcode 0
pinterest   enrichPinMetrics: reactions, commentCount, repinCount, viewCount
reddit      d.ups, d.num_comments; shares/views hardcode 0
```

**Task 4 — actor cũ sai, không phải Meta chặn.** `apify/facebook-ads-scraper` đọc endpoint
*search results* của Ad Library. Tìm trong Apify store thấy
`memo23/facebook-ads-library-scraper-ppe` có input `includeAdReach` mô tả đúng
"Include Ad Reach and EU transparency in output" — nó mở **trang chi tiết từng quảng cáo**.

### Changes Made

**Bộ lọc — mô hình mới (thay hoàn toàn mô hình ngưỡng)**
- `src/filters/metric-conditions.js`: thêm `PLATFORM_METRICS`, `metricsForPlatform()`,
  `parseMetricSelection()`, `evaluateSelection()`, `applySelection()`,
  `buildSqlSelectionFilter()`, `buildSqlSelectionOrder()`. Mọi export cũ giữ nguyên.
- `server.js`: `/api/item-metrics` thêm key `platforms`; `/api/items` nhận
  `?metrics=likes,comments&dir=`. Tick chuyển thành `col > 0` nên đi đúng đường SQL
  whitelist sẵn có, không có gì mới chạm DB.
- `src/collection-inputs.js`: whitelist `options.metrics` (đây là chỗ đã âm thầm nuốt
  `metrics` ở lần chạy đầu — xem Problems).
- `src/runs.service.js`: `applySelection()` sau `applyConditions()`; `crawlFilter` ghi thêm
  `metrics`.
- `public/*`: bộ lọc DB = dropdown nền tảng + checkbox + chiều xếp hạng; bộ lọc crawl =
  nút "Bộ lọc" mở ra checkbox của đúng nền tảng đang chọn, không có chiều.

**Task 4 — Views + Quốc gia**
- `src/apify-client.js`: builder cho `memo23/facebook-ads-library-scraper-ppe`
  (`includeAdReach`, `includeTotalActiveAds`, RESIDENTIAL proxy).
- `src/channels/facebook_ads.channel.js`: actor mới priority 10, actor cũ xuống 20.
- `src/normalize/ad-creative.js`: `withCamelAliases()` cho `snapshot` (actor mới snake_case),
  `readEuTransparency()`, map views ← `eu_total_reach`, activeCountries ←
  `location_audience[].name`, adCount ← `total_ads_count`.

### Files Changed

```text
public/app.js            public/index.html          public/style.css
server.js                src/apify-client.js        src/collection-inputs.js
src/channels/facebook_ads.channel.js                src/channels/registry.js
src/filters/metric-conditions.js                    src/normalize/ad-creative.js
src/runs.service.js
```

### Backup

```text
Backup: docs/BACKUPS/2026-09-08/task234-ui-fix/ (public/* + ad-creative.js, tạo đầu phiên)
Các file sửa sau backup (registry.js, metric-conditions.js, server.js, runs.service.js,
collection-inputs.js, apify-client.js, facebook_ads.channel.js) — dùng `git checkout <file>`
hoặc `git diff` để soát; không file nào trong số đó bị xoá/đổi tên.
```

### Verification

```text
metric-conditions      13 pass / 0 fail      large-collection        4 pass / 0 fail
collection-inputs       6 pass / 0 fail      apify-client-coverage   5 pass / 0 fail
ranking                 4 pass / 0 fail      marketplace-scheduler  13 pass / 0 fail
tiktok-shop-top20       7 pass / 0 fail
```

### Runtime Evidence

**Bộ lọc DB — UI thật**

```text
mở panel            -> "Tích một hoặc nhiều chỉ số để lọc."
tiktok_shop         -> checkbox: Current price, Rating, Reviews, Sold
tick Sold, Cao→Thấp -> "Sold · Cao → Thấp → 36 sản phẩm"
                       chỉ trả platform tiktok_shop; 202530, 201380, 160230, 73110, 58091
đổi sang instagram  -> checkbox đổi thành Likes, Comments, Views; tick bị xoá; 11 sản phẩm
bấm pill Instagram  -> panel tự đổi theo nền tảng của pill
amazon price desc   -> 37.5, 32, 30.78, 28.08, 26.99   |  đổi Thấp→Cao: 3.75, 4.99, 5.69…
```

AND + "không báo cáo = loại", kiểm bằng API trên dữ liệu thật:

```text
amazon      + tick sold             -> 0    (amazon không báo cáo sold: 0/43 rows)
tiktok_shop + tick sold             -> 36
tiktok_shop + tick reviews          -> 20
tiktok_shop + tick sold AND reviews -> 20
/api/items?metrics=bogus            -> HTTP 400 "Unknown metric(s)"
```

**Bộ lọc crawl — UI thật**

```text
Etsy      -> Current price, Rating, Reviews, Sold
Reddit    -> Likes, Comments
Instagram -> Likes, Comments, Views
tích 2 ô  -> nút "Bộ lọc" hiện "· Likes + Comments"
```

**E2E crawl, Run #750** (amazon, "press on nails", maxItems=5, tick Reviews + Rating):

```text
metrics: ["reviews","rating"] | fetched 5, kept 5, rejected 0
thứ tự lưu (cao nhất trước): reviews 20439 -> 13503 -> 2640 -> 1847 -> 1660
UI hiện: "Lọc theo Reviews + Rating: crawl 5 → giữ 5, loại 0."
```

**Task 4 — E2E Run #782** (facebook_ads, "press on nails", country DE, maxItems=5),
`active_backend = apify-reach`, đọc lại từ PostgreSQL qua `/api/items`:

```text
Doonails   adCount=76  views=3,014,085  countries=[Austria, Germany]
Doonails   adCount=76  views=2,622,368  countries=[Austria, Germany]
NAILD      adCount=—   views=1,468,513  countries=[Austria, Germany]
Roxy Nails adCount=10  views=  389,709  countries=[]
CurvLife   adCount=60  views=  129,556  countries=[Italy, France, Germany]
```

Card + modal đều hiện đủ 7 field (Platform, Bắt đầu, Meta Ad Library, Website Đích,
Số QC, Views, Quốc gia).

**Chi phí:** run thử actor mới $0.05 (5 item) + run #750/#782. Mọi run đều maxItems = 5.

### Problems And Failures

1. **`options.metrics` bị nuốt im lặng ở lần chạy đầu.** `buildCollectionOptions()` trong
   `src/collection-inputs.js` whitelist option theo `getPlatformInputFields()`, nên
   `metrics` không tới được `runs.service`. Run #716 chạy xong, `crawlFilter` không được
   ghi, 5/5 item được lưu — trông như "bộ lọc không có tác dụng". Phát hiện bằng cách đọc
   `runs.input_options` chứ không tin vào việc run báo done.
2. **Proxy datacenter không dùng được với actor mới.** Lần chạy đầu dính Facebook rate limit
   `1675004` ở mọi request, retry ~7 phút không ra item nào, tốn $0.05. Đổi sang
   RESIDENTIAL là ra ngay.
3. **CSS selector sai** (`.metric-value` trong khi hàng crawl dùng class `crawl-value`) —
   phát hiện bằng cách đọc computed style trên UI thật.
4. Run #716 (instagram) trả 5 post đều likes=0/comments=0 nên không chứng minh được thứ tự;
   phải đổi sang amazon (Run #750) mới có độ chênh để chứng minh.

### Important Decisions

- **`total_ads_count = 0` coi là "chưa lấy được", không phải 0 quảng cáo.** Quảng cáo đang
  nằm trong Ad Library thì trang phải có ≥1. Bằng chứng: run #782 NAILD trả 0 trong khi
  20 phút trước cùng page đó trả 82.
- **Chỉ số không được báo cáo = LOẠI, không coi như 0.** Item không biết likes thì không thể
  là "likes cao nhất".
- **Giữ nguyên đường `conditions` (ngưỡng) cũ** song song với `metrics`, không xoá.
- **Giữ actor cũ làm fallback** priority 20 — rẻ hơn và vẫn đúng cho mọi field trừ 3 field kia.

### Remaining Risks

- Views/Quốc gia **chỉ có với quảng cáo phục vụ trong EU** (phạm vi DSA). QC chỉ chạy ngoài
  EU vẫn trống — UI ghi "Chỉ có với QC chạy EU".
- Actor mới cần RESIDENTIAL proxy → tốn quota residential (free tier 20GB/tháng).
- `PLATFORM_METRICS` cho ebay/etsy/shopify/google_shopping/twitter/facebook_posts/pinterest
  suy từ source, **chưa có runtime evidence** vì chưa có row nào của các nền tảng đó trong DB.
- `deleteItem(uid)` vẫn hỏng; test suite vẫn ghi vào DB production nếu thiếu `PGLITE_DIR`.

### Next Steps

1. Crawl thử các nền tảng chưa có dữ liệu (etsy, ebay, pinterest, reddit, twitter) để xác
   nhận `PLATFORM_METRICS` bằng runtime evidence.
2. Commit toàn bộ working tree.
3. Cân nhắc: bộ lọc crawl hiện xếp hạng **sau khi** provider trả kết quả. Muốn provider tự
   trả về đúng "cao nhất" thì phải truyền tham số sort của từng actor — memo23 có `sortBy`,
   các actor khác cần kiểm riêng.
