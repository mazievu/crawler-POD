/**
 * Apify Collector — Product Intelligence (Ad Lifecycle Tracking)
 * Shows: active/inactive status, growth, timeline comparison.
 */

let allPlatforms = [];
let allItems = [];
let activeFilter = 'all';
let collectPlatform = null;
let doctorReport = null;
let marketplaceLoginSessionId = null;
let marketplaceProxyProfiles = [];

document.addEventListener('DOMContentLoaded', async () => {
  feather.replace();
  await loadData();
  await loadMetricGroups();
  setupSearch();
});

// ==================== Data Loading ====================

async function loadData() {
  try {
    const [platforms, items, stats] = await Promise.all([
      apiFetch('/api/platforms'),
      apiFetch('/api/items?limit=100'),
      apiFetch('/api/stats').catch(() => ({ totalRuns: 0, totalSnapshots: 0, platformCounts: {} })),
    ]);
    allPlatforms = platforms;
    allItems = items;

    const counts = { ...(stats.platformCounts || {}) };
    for (const item of allItems) {
      if (counts[item.platform] === undefined) {
        counts[item.platform] = (counts[item.platform] || 0) + 1;
      }
    }
    renderFilterPills(platforms, counts);
    const totalCount = stats.totalSnapshots || Object.values(counts).reduce((a, b) => a + b, 0) || allItems.length;
    document.getElementById('stat-total').textContent = `${stats.totalRuns || 0} runs / ${totalCount} items`;
    renderItems(allItems);
  } catch (err) { console.error('Load failed:', err); }
}

// ==================== Filter Pills ====================

function renderFilterPills(platforms, counts) {
  const container = document.getElementById('filter-pills');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  let html = `<button class="pill active" onclick="filterByPlatform('all', this)">
    <span class="pill-dot" style="background:#666"></span> All <span class="pill-count">${total}</span>
  </button>`;
  for (const p of platforms) {
    const c = counts[p.name] || 0;
    if (c === 0) continue;
    html += `<button class="pill" onclick="filterByPlatform('${p.name}', this)">
      <span class="pill-dot" style="background:${p.color}"></span>
      ${p.icon} ${p.displayName} <span class="pill-count">${c}</span>
    </button>`;
  }
  container.innerHTML = html;
}

function filterByPlatform(platform, el) {
  activeFilter = platform;
  document.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
  el.classList.add('active');
  // The metric panel is per-platform, so a pill click has to move it too —
  // otherwise the panel keeps offering Amazon's metrics over Instagram rows.
  // Ticks are cleared because a metric belongs to one platform's vocabulary.
  if (platform !== 'all' && platformMetrics[platform] && platform !== metricPlatform) {
    metricPlatform = platform;
    const select = document.getElementById('metric-platform');
    if (select) select.value = platform;
    renderMetricBoxes();
  }
  applyFilters();
}

function setupSearch() {
  const input = document.getElementById('search-input');
  let debounce;
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(applyFilters, 200); });
}

// ==================== DB metric filter (Task 2) ====================
// The filter is per-platform and tick-based: pick a platform, tick the metrics
// that platform actually reports, choose a direction. There is no operator and
// no threshold to type — ticking "likes" means "the ones with the most likes".
//
// The metric list per platform comes from /api/item-metrics, never hardcoded
// here, so the panel can only ever offer what the server will accept and what
// that platform's scraper genuinely produces.
let platformMetrics = {};
let metricPlatform = '';

async function loadMetricGroups() {
  try {
    const spec = await apiFetch('/api/item-metrics');
    platformMetrics = spec.platforms || {};
  } catch (err) {
    console.error('Could not load metric list:', err);
    return;
  }
  renderMetricPlatformOptions();
  renderMetricBoxes();
}

// Only platforms that actually hold rows are offered, so the dropdown does not
// list twelve choices when four have data.
function renderMetricPlatformOptions() {
  const select = document.getElementById('metric-platform');
  if (!select) return;
  const available = allPlatforms
    .filter((p) => platformMetrics[p.name])
    .map((p) => ({ name: p.name, label: `${p.icon || ''} ${p.displayName || p.name}`.trim() }));
  if (available.length === 0) return;

  if (!metricPlatform || !available.some((p) => p.name === metricPlatform)) {
    // Follow the platform pill when one is active; otherwise start on the first.
    metricPlatform = available.some((p) => p.name === activeFilter) ? activeFilter : available[0].name;
  }
  select.innerHTML = available
    .map((p) => `<option value="${escapeAttr(p.name)}"${p.name === metricPlatform ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
    .join('');
}

function renderMetricBoxes() {
  const host = document.getElementById('metric-boxes');
  if (!host) return;
  const metrics = platformMetrics[metricPlatform] || [];
  if (metrics.length === 0) {
    host.innerHTML = '<span class="metric-boxes-empty">Nền tảng này chưa khai báo chỉ số nào.</span>';
    return;
  }
  host.innerHTML = metrics.map((m) => `
    <label class="metric-box">
      <input type="checkbox" value="${escapeAttr(m.name)}" onchange="applyMetricFilters()">
      <span>${escapeHtml(m.label)}</span>
    </label>`).join('');
}

// Switching platform also switches which pill is active, because a filter on
// Etsy's metrics is meaningless while the grid is showing Instagram.
function onMetricPlatformChange() {
  const select = document.getElementById('metric-platform');
  if (!select) return;
  metricPlatform = select.value;
  renderMetricBoxes();
  activeFilter = metricPlatform;
  document.querySelectorAll('.pill').forEach((pill) => {
    pill.classList.toggle('active', (pill.getAttribute('onclick') || '').includes(`'${metricPlatform}'`));
  });
  applyMetricFilters();
}

function collectMetricSelection() {
  return [...document.querySelectorAll('#metric-boxes input[type=checkbox]:checked')].map((el) => el.value);
}

function applyMetricFilters() { applyFilters(); }

// Single place that writes the panel's status line, so no path can leave the
// user without feedback after a click.
function setMetricMessage(text, kind) {
  const el = document.getElementById('metric-result');
  if (!el) return;
  el.className = `metric-result metric-result-${kind || 'info'}`;
  el.innerHTML = text;
}

function clearMetricFilters() {
  document.querySelectorAll('#metric-boxes input[type=checkbox]').forEach((el) => { el.checked = false; });
  const dir = document.getElementById('metric-sort-dir');
  if (dir) dir.value = 'desc';
  applyFilters();
}

function toggleMetricPanel(forceOpen) {
  const body = document.getElementById('metric-panel-body');
  const toggle = document.getElementById('metric-toggle');
  if (!body || !toggle) return;
  const open = forceOpen === undefined ? body.hidden : forceOpen;
  body.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.classList.toggle('open', open);
  if (open) {
    renderMetricPlatformOptions();
    renderMetricBoxes();
    // Opening the panel to a blank status line is what made the old one feel
    // dead; say what it is waiting for.
    if (!document.getElementById('metric-result')?.textContent) {
      setMetricMessage('Tích một hoặc nhiều chỉ số để lọc.', 'info');
    }
  }
}
async function applyFilters() {
  const query = document.getElementById('search-input').value.toLowerCase().trim();
  const sort = document.getElementById('sort-select').value;
  const params = new URLSearchParams({ limit: '200' });
  if (activeFilter !== 'all') params.set('platform', activeFilter);
  if (query) params.set('search', query);

  // Task 2: the ticked metrics and the direction are sent to the server, so
  // they apply to the whole table rather than to the 200 rows this page
  // happens to hold.
  const selected = collectMetricSelection();
  const dir = document.getElementById('metric-sort-dir')?.value || 'desc';
  if (selected.length > 0) {
    params.set('metrics', selected.join(','));
    params.set('dir', dir);
    // The ticked metrics belong to ONE platform's vocabulary, so the result set
    // has to be that platform. Without this, ticking Amazon's "rating" while
    // the pill still says All returns TikTok rows judged by Amazon's metrics.
    if (metricPlatform) params.set('platform', metricPlatform);
  }
  let filtered;
  try {
    filtered = await apiFetch(`/api/items?${params}`);
    allItems = filtered;
  } catch (err) {
    console.error('Search failed:', err);
    // A rejected condition must say so instead of silently showing unfiltered
    // data, which would look like "the filter matched everything".
    setMetricMessage(escapeHtml(err.message || 'filter rejected'), 'error');
    return;
  }

  const dirLabel = dir === 'asc' ? 'Thấp → Cao' : 'Cao → Thấp';
  const labelFor = (name) =>
    (platformMetrics[metricPlatform] || []).find((m) => m.name === name)?.label || name;

  // Every path writes the status line — an empty one after a click is exactly
  // what read as "the button does nothing".
  setMetricMessage(
    selected.length
      ? `${selected.map((n) => escapeHtml(labelFor(n))).join(' + ')} · ${dirLabel} → <strong>${filtered.length}</strong> sản phẩm`
      : `Chưa tích chỉ số nào — hiển thị toàn bộ <strong>${filtered.length}</strong> sản phẩm`,
    selected.length ? 'ok' : 'info'
  );

  // Mirror the active filter onto the collapsed toggle, so closing the panel
  // does not hide the fact that a filter is in effect.
  const summaryEl = document.getElementById('metric-toggle-summary');
  if (summaryEl) {
    summaryEl.textContent = selected.length
      ? `· ${selected.map(labelFor).join(' + ')} · ${dirLabel}`
      : '';
    summaryEl.classList.toggle('active', selected.length > 0);
  }

  // The server already returned the rows in the ranked order; re-sorting here
  // would silently override it.
  if (selected.length) { renderItems(filtered); return; }

  switch (sort) {
    case 'likes-desc': filtered.sort((a, b) => b.likes - a.likes); break;
    case 'comments-desc': filtered.sort((a, b) => b.comments - a.comments); break;
    case 'shares-desc': filtered.sort((a, b) => b.shares - a.shares); break;
    case 'price-asc': filtered.sort((a, b) => a.price - b.price); break;
    case 'price-desc': filtered.sort((a, b) => b.price - a.price); break;
    case 'growth': filtered.sort((a, b) => ((b.growth?.likes || 0) + (b.growth?.comments || 0)) - ((a.growth?.likes || 0) + (a.growth?.comments || 0))); break;
    default: filtered.sort((a, b) => parseServerTimestamp(b.created_at) - parseServerTimestamp(a.created_at)); break;
  }
  renderItems(filtered);
}

// ==================== Render Items ====================

function renderItems(items) {
  const grid = document.getElementById('items-grid');
  if (!items.length) {
    grid.innerHTML = `<div class="empty-state"><i data-feather="inbox" style="width:48px;height:48px" class="mb-2"></i><p>No items found.</p></div>`;
    feather.replace();
    return;
  }

  grid.innerHTML = items.map((item) => {
    const config = allPlatforms.find((p) => p.name === item.platform);
    const tagClass = `tag-${item.platform}`;
    const icon = config?.icon || '🔗';
    const platformLabel = config?.displayName || item.platform;
    // A post can be one image, a video, or a carousel of mixed media; the cover
    // image alone cannot express that, so the kind (and how many) is marked.
    const mediaCount = Number(item.mediaCount || 0);
    // For an ad the extra media are alternate VERSIONS of the same ad, not a
    // carousel of one post — Meta rotates which one it serves, so opening the
    // Ad Library link twice shows two different pictures. Saying how many
    // versions exist is what stops that looking like a broken link.
    const mediaBadge = item.mediaType === 'video'
      ? '<span class="item-media-badge" title="Video">▶ Video</span>'
      : item.mediaType === 'carousel'
        ? (item.platform === 'facebook_ads'
          ? `<span class="item-media-badge" title="Quảng cáo này có ${mediaCount} phiên bản khác nhau. Meta xoay vòng hiển thị, nên mở link Ad Library mỗi lần có thể ra ảnh khác.">▣ ${mediaCount} phiên bản</span>`
          : `<span class="item-media-badge" title="Carousel">▣ ${mediaCount || ''}</span>`)
        : '';
    const cardImage = item.image
      ? `<img src="${escapeAttr(item.image)}" alt="${escapeAttr(item.title || platformLabel)}" style="width:100%;height:100%;object-fit:cover" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'), { className: 'item-img-placeholder', textContent: 'No image' }))">${mediaBadge}`
      : `<div class="item-img-placeholder">No image</div>${mediaBadge}`;

    // Status badge
    const statusBadge = getStatusBadge(item.status, item);

    // Growth indicators
    const growthHtml = renderGrowth(item.growth);
    const isTiktokShop = item.platform === 'tiktok_shop';
    const isTwitter = item.platform === 'twitter';
    const isEcommerce = ['amazon', 'ebay', 'etsy', 'shopify', 'google_shopping', 'tiktok_shop'].includes(item.platform);

    const priceHtml = item.price > 0
      ? `<div class="item-price">$${item.price.toFixed(2)} ${growthHtml.priceChange}</div>`
      : '';

    const isFacebookAds = item.platform === 'facebook_ads';
    const isReddit = item.platform === 'reddit';

    const platformsList = Array.isArray(item.publisherPlatforms) && item.publisherPlatforms.length > 0 ? item.publisherPlatforms : ['FACEBOOK'];
    const platformBadgesHtml = isFacebookAds
      ? `<div class="mt-1 d-flex flex-wrap gap-1">${platformsList.map(p => `<span class="badge bg-secondary-subtle text-dark" style="font-size:10px">${p.replace(/_/g, ' ')}</span>`).join('')}</div>`
      : '';

    const startStr = isFacebookAds && item.startDate ? parseServerTimestamp(item.startDate).toLocaleDateString() : '';
    const dateHtml = startStr ? `<div class="fs-11 text-muted mt-1">📅 Bắt đầu: ${startStr}</div>` : '';

    // Task 4: ad count and active countries come straight from the provider.
    // Both render as SOURCE_NOT_AVAILABLE when it reported nothing — Meta only
    // publishes those for political / social-issue ads, and showing "0 ads" or
    // the search country instead would be inventing data.
    const adMetaHtml = isFacebookAds
      ? `<div class="fs-11 text-muted mt-1 d-flex flex-column gap-1">
           ${adFieldHtml('🧾', 'Số QC', adCountHtml(item))}
           ${adFieldHtml('👁', 'Views', Number(item.views) > 0 ? `<strong>${formatNum(item.views)}</strong>` : metaNotDisclosed())}
           ${adFieldHtml('🌍', 'Quốc gia', Array.isArray(item.activeCountries) && item.activeCountries.length
             ? `<strong>${item.activeCountries.map((c) => escapeHtml(c)).join(', ')}</strong>`
             : metaNotDisclosed())}
         </div>`
      : '';

    // Task 5.6: position movement and sales growth, the two things a daily
    // Top-20 job exists to surface. A POSITIVE returnPositionChange means the
    // product moved UP (its position number got smaller).
    const posChange = item.returnPositionChange;
    const posHtml = isTiktokShop && item.returnPosition
      ? `<div class="fs-11 text-muted mt-1">#${item.returnPosition} <span class="text-muted">return position</span>${
          posChange === null || posChange === undefined || posChange === 0
            ? ''
            : posChange > 0
              ? ` <span class="growth-up">▲ ${posChange}</span>`
              : ` <span class="growth-down">▼ ${Math.abs(posChange)}</span>`
        }${item.sold30d ? ` · <span title="Sold in the last 30 days">30d: ${formatNum(item.sold30d)}</span>` : ''}${
          item.gmv ? ` · <span title="Gross merchandise value">GMV $${formatNum(item.gmv)}</span>` : ''
        }</div>`
      : '';

    const engagementHtml = isTiktokShop
      ? `<div class="item-engagement">
          <div class="engagement-stat" title="Số Lượng Đã Bán"><i data-feather="shopping-bag"></i><span class="eng-val">${formatNum(item.sold_count || item.soldCount || 0)}</span> <span class="fs-10 text-muted">đã bán</span>${growthHtml.soldCount}</div>
          <div class="engagement-stat" title="Điểm Đánh Giá"><i data-feather="star"></i><span class="eng-val">${item.rating > 0 ? `★ ${Number(item.rating).toFixed(1)}` : '—'}</span>${growthHtml.rating}</div>
          <div class="engagement-stat commented" title="Số Lượng Review"><i data-feather="message-square"></i><span class="eng-val">${formatNum(item.reviews || item.reviewCount || 0)}</span> <span class="fs-10 text-muted">reviews</span>${growthHtml.reviews}</div>
        </div>`
      : isTwitter
      ? `<div class="item-engagement">
          <div class="engagement-stat liked" title="Số Likes"><i data-feather="heart"></i><span class="eng-val">${formatNum(item.likes || 0)}</span> <span class="fs-10 text-muted">likes</span>${growthHtml.likes}</div>
          <div class="engagement-stat commented" title="Số Replies"><i data-feather="message-circle"></i><span class="eng-val">${formatNum(item.comments || 0)}</span> <span class="fs-10 text-muted">replies</span>${growthHtml.comments}</div>
          <div class="engagement-stat" title="Số Views"><i data-feather="eye"></i><span class="eng-val">${formatNum(item.views || 0)}</span> <span class="fs-10 text-muted">views</span>${growthHtml.views}</div>
        </div>`
      : isEcommerce
      ? `<div class="item-engagement">
          <div class="engagement-stat liked" title="Yêu thích / Likes"><i data-feather="heart"></i><span class="eng-val">${formatNum(item.likes || item.reviews || 0)}</span>${growthHtml.likes}</div>
          <div class="engagement-stat" title="Tổng số Review"><i data-feather="message-square"></i><span class="eng-val">${formatNum(item.reviews || 0)}</span>${growthHtml.reviews}</div>
          <div class="engagement-stat" title="Điểm Đánh Giá / Feedback Score"><i data-feather="star"></i><span class="eng-val">${item.rating > 0 ? (item.rating > 5 ? `★ ${Number(item.rating).toFixed(1)}%` : `★ ${Number(item.rating).toFixed(1)}`) : '—'}</span>${growthHtml.rating}</div>
          ${(item.sold_count > 0 || item.soldCount > 0) ? `<div class="engagement-stat" title="Lượt Bán"><i data-feather="shopping-bag"></i><span class="eng-val">${formatNum(item.sold_count || item.soldCount)}</span>${growthHtml.soldCount}</div>` : ''}
        </div>`
      : isFacebookAds
      ? `<div class="item-engagement">
          <div class="engagement-stat liked" title="Lượt Thích Fanpage"><i data-feather="thumbs-up"></i><span class="eng-val">${formatNum(item.fanpageLikes || item.likes || 0)}</span> <span class="fs-10 text-muted">Fanpage Likes</span></div>
          ${item.cta ? `<div class="engagement-stat"><span class="badge bg-primary text-white" style="font-size:10px">${escapeHtml(item.cta)}</span></div>` : ''}
        </div>`
      : isReddit
      ? `<div class="item-engagement">
          <div class="engagement-stat" title="Subreddit"><i data-feather="hash"></i><span class="eng-val">${item.subreddit ? 'r/' + escapeHtml(item.subreddit) : '—'}</span></div>
          <div class="engagement-stat commented" title="Tổng số Comment"><i data-feather="message-circle"></i><span class="eng-val">${formatNum(item.comments || 0)}</span>${growthHtml.comments}</div>
          <div class="engagement-stat liked" title="Upvote Score"><i data-feather="arrow-up"></i><span class="eng-val">${formatNum(item.likes || 0)}</span>${growthHtml.likes}</div>
        </div>`
      : `<div class="item-engagement">
          <div class="engagement-stat liked" title="Likes / Reactions"><i data-feather="heart"></i><span class="eng-val">${formatNum(item.likes || 0)}</span>${growthHtml.likes}</div>
          <div class="engagement-stat commented" title="Comments"><i data-feather="message-circle"></i><span class="eng-val">${formatNum(item.comments || 0)}</span>${growthHtml.comments}</div>
          <div class="engagement-stat shared" title="Shares / Repins"><i data-feather="share-2"></i><span class="eng-val">${formatNum(item.shares || 0)}</span>${growthHtml.shares}</div>
          <div class="engagement-stat" title="Views"><i data-feather="eye"></i><span class="eng-val">${formatNum(item.views || 0)}</span>${growthHtml.views}</div>
        </div>`;

    return `
      <div class="item-card" onclick="showItemDetail('${escapeAttr(item.item_uid)}')">
        <div class="item-img">
          ${cardImage}
          <span class="platform-tag ${tagClass}">${platformLabel}</span>
          ${statusBadge}
          <button class="btn-card-delete" onclick="deleteSingleItem(event, '${escapeAttr(item.item_uid)}')" title="Xóa sản phẩm này">
            <i data-feather="trash-2" style="width:14px;height:14px"></i>
          </button>
        </div>
        <div class="item-body">
          <div class="item-title" title="${escapeAttr(item.title)}">${escapeHtml(item.title) || '<em>No title</em>'}</div>
          ${item.author ? `<div class="item-source fw-bold">${escapeHtml(item.author)}</div>` : ''}
          ${priceHtml}
          ${renderProductMetrics(item)}
          ${platformBadgesHtml}
          ${dateHtml}
          ${posHtml}
          ${adMetaHtml}
        </div>
        ${engagementHtml}
      </div>`;
  }).join('');
  feather.replace();
}

/**
 * `status` is OUR tracking state, not the item's state at the source:
 *
 *   new     first time this item was seen
 *   active  seen again in the latest crawl for this platform+query
 *   dropped it was in the previous crawl's results and is not in the latest one
 *
 * With maxItems=5 against an advertiser running hundreds of ads, "not in the
 * latest five" is routine — every crawl drops the previous crawl's five. So
 * rendering `dropped` as "STOPPED" made a false claim about the ad: run #782's
 * CurvLife ad showed STOPPED while Meta's own Ad Library said "Hoạt động"
 * (Active) for the same Library ID 1549200472421776.
 *
 * Where the provider reports the real thing — Facebook Ads carries `isActive`
 * straight from Meta — that is what the badge shows. The tracking state stays
 * useful but is now labelled for what it actually is.
 */
function getStatusBadge(status, item) {
  if (item && item.isActive !== undefined && item.platform === 'facebook_ads') {
    return item.isActive
      ? '<span class="ad-tag active-tag" title="Meta báo quảng cáo này đang chạy">ĐANG CHẠY</span>'
      : '<span class="ad-tag dropped-tag" title="Meta báo quảng cáo này đã kết thúc">ĐÃ KẾT THÚC</span>';
  }
  switch (status) {
    case 'active': return '<span class="ad-tag active-tag">ACTIVE</span>';
    case 'new': return '<span class="ad-tag new-tag">NEW</span>';
    case 'dropped':
      return '<span class="ad-tag missing-tag" title="Không xuất hiện trong lần crawl gần nhất. Mỗi lần crawl chỉ lấy một số lượng item giới hạn, nên điều này KHÔNG có nghĩa là sản phẩm/quảng cáo đã dừng.">NGOÀI TOP</span>';
    default: return '';
  }
}

/**
 * Thumbnail strip for a post whose media is more than one file — an Instagram
 * carousel returns each child separately, and a child can be a video while its
 * siblings are images. Clicking a video child swaps the main player's source so
 * every media the crawl captured is reachable, not just the cover. Renders
 * nothing for single media, where the main element already is that media.
 */
function renderMediaStrip(item) {
  const media = Array.isArray(item.mediaItems) ? item.mediaItems.filter((m) => m && (m.imageUrl || m.videoUrl)) : [];
  if (media.length < 2) return '';
  const cells = media.map((m) => {
    const thumb = m.imageUrl || '';
    const mark = m.videoUrl ? '<span class="media-strip-play">▶</span>' : '';
    const onclick = m.videoUrl
      ? ` onclick="const v=this.closest('.col-md-5').querySelector('video'); if(v){v.src='${escapeAttr(m.videoUrl)}';v.play();}" style="cursor:pointer"`
      : '';
    return `<div class="media-strip-cell"${onclick}>${thumb ? `<img src="${escapeAttr(thumb)}" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : ''}${mark}</div>`;
  }).join('');
  return `<div class="media-strip mt-2" title="${media.length} media">${cells}</div>`;
}

function renderGrowth(growth) {
  if (!growth) return { likes: '', comments: '', shares: '', views: '', priceChange: '', rating: '', reviews: '', soldCount: '' };
  return {
    likes: growth.likes > 0 ? `<span class="growth-up">+${growth.likes}</span>` : growth.likes < 0 ? `<span class="growth-down">${growth.likes}</span>` : '',
    comments: growth.comments > 0 ? `<span class="growth-up">+${growth.comments}</span>` : growth.comments < 0 ? `<span class="growth-down">${growth.comments}</span>` : '',
    shares: growth.shares > 0 ? `<span class="growth-up">+${growth.shares}</span>` : growth.shares < 0 ? `<span class="growth-down">${growth.shares}</span>` : '',
    views: growth.views > 0 ? `<span class="growth-up">+${growth.views}</span>` : growth.views < 0 ? `<span class="growth-down">${growth.views}</span>` : '',
    priceChange: growth.priceChange > 0 ? `<span class="growth-down ms-1">+${growth.priceChange.toFixed(2)}</span>` : growth.priceChange < 0 ? `<span class="growth-up ms-1">${growth.priceChange.toFixed(2)}</span>` : '',
    rating: growth.rating > 0 ? `<span class="growth-up ms-1">+${growth.rating.toFixed(1)}</span>` : growth.rating < 0 ? `<span class="growth-down ms-1">${growth.rating.toFixed(1)}</span>` : '',
    reviews: growth.reviews > 0 ? `<span class="growth-up ms-1">+${growth.reviews}</span>` : growth.reviews < 0 ? `<span class="growth-down ms-1">${growth.reviews}</span>` : '',
    soldCount: growth.soldCount > 0 ? `<span class="growth-up ms-1">+${growth.soldCount}</span>` : growth.soldCount < 0 ? `<span class="growth-down ms-1">${growth.soldCount}</span>` : '',
  };
}

function renderProductMetrics(item) {
  if (item.platform === 'facebook_ads') return '';
  const g = renderGrowth(item.growth);
  const metrics = [];
  if (item.platform === 'tiktok_shop') {
    metrics.push(`<span title="Số lượng đã bán">📦 ${formatNum(item.sold_count || item.soldCount || 0)} đã bán${g.soldCount}</span>`);
    metrics.push(`<span title="Điểm đánh giá">★ ${item.rating > 0 ? Number(item.rating).toFixed(1) : '—'}${g.rating}</span>`);
    metrics.push(`<span title="Tổng số review">💬 ${formatNum(item.reviews || item.reviewCount || 0)} reviews${g.reviews}</span>`);
    return `<div class="item-product-metrics">${metrics.join('<span class="metric-separator">·</span>')}</div>`;
  }
  if (item.rating > 0) {
    const rLabel = item.rating > 5 ? `★ ${Number(item.rating).toFixed(1)}%` : `★ ${Number(item.rating).toFixed(1)}`;
    metrics.push(`<span title="${item.platform === 'ebay' ? 'Điểm đánh giá tích cực' : 'Điểm đánh giá trung bình'}">${rLabel}${g.rating}</span>`);
  }
  if (item.reviews > 0) metrics.push(`<span title="${item.platform === 'ebay' ? 'Feedback / Phản hồi' : 'Tổng số review'}">${formatNum(item.reviews)} ${item.platform === 'ebay' ? 'feedback' : 'reviews'}${g.reviews}</span>`);
  if (item.sold_count > 0 || item.soldCount > 0) metrics.push(`<span title="Số lượng đã bán">📦 ${formatNum(item.sold_count || item.soldCount)} sold${g.soldCount}</span>`);
  if (item.likes > 0) metrics.push(`<span title="Số tym / Watchers">❤️ ${formatNum(item.likes)}${g.likes}</span>`);
  return metrics.length ? `<div class="item-product-metrics">${metrics.join('<span class="metric-separator">·</span>')}</div>` : '';
}

// ==================== Item Detail + Timeline ====================

async function showItemDetail(itemUid) {
  try {
    const history = await apiFetch(`/api/items/${encodeURIComponent(itemUid)}/history`);
    if (!history.length) return;

    const latest = history[history.length - 1];
    const config = allPlatforms.find((p) => p.name === latest.platform);
    const isEcommerce = ['amazon', 'ebay', 'etsy', 'shopify', 'google_shopping', 'tiktok_shop'].includes(latest.platform);

    document.getElementById('item-modal-title').innerHTML = `
      ${config?.icon || '🔗'} ${escapeHtml(latest.title || 'Untitled')}
      ${getStatusBadge(latest.status, latest)}
    `;

    // Timeline chart data
    const timelineHtml = renderTimeline(history, isEcommerce);
    const statsHtml = renderHistoryStats(history, isEcommerce);

    document.getElementById('item-modal-body').innerHTML = `
      <div class="row g-3">
        ${latest.videoUrl
          ? `<div class="col-md-5">
               <video src="${escapeAttr(latest.videoUrl)}" class="w-100 rounded" style="max-height:300px;object-fit:cover;background:#000" controls playsinline preload="metadata"${latest.image ? ` poster="${escapeAttr(latest.image)}"` : ''}></video>
               ${renderMediaStrip(latest)}
             </div>`
          : latest.image
            ? `<div class="col-md-5"><img src="${escapeAttr(latest.image)}" class="w-100 rounded" style="max-height:300px;object-fit:cover" referrerpolicy="no-referrer" onerror="this.parentElement.style.display='none'">${renderMediaStrip(latest)}</div>`
            : ''}
        <div class="${latest.image ? 'col-md-7' : 'col-12'}">
          <div class="mb-2">
            <span class="badge bg-primary me-1">${config?.displayName || latest.platform}</span>
            ${latest.subreddit ? `<span class="badge bg-danger-subtle text-danger border border-danger-subtle me-1">r/${escapeHtml(latest.subreddit)}</span>` : ''}
            ${latest.author ? `<span class="badge bg-light text-dark">${latest.platform === 'reddit' ? 'u/' : ''}${escapeHtml(latest.author.replace(/^u\//, ''))}</span>` : ''}
            ${getStatusBadge(latest.status, latest)}
          </div>
          <h6 class="fw-bold">${escapeHtml(latest.title)}</h6>
          ${latest.price > 0 ? `<p class="fs-4 fw-bold text-success mb-2">$${Number(latest.price).toFixed(2)}</p>` : ''}
          ${renderProductMetrics(latest)}
          <div class="mt-2 mb-3">
            ${latest.url ? `<a href="${escapeAttr(latest.url)}" target="_blank" class="btn btn-outline-primary btn-sm me-2">${latest.platform === 'facebook_ads' ? 'Xem trong Meta Ad Library ↗' : 'View Source →'}</a>` : ''}
            ${latest.landingUrl && latest.landingUrl !== latest.url ? `<a href="${escapeAttr(latest.landingUrl)}" target="_blank" class="btn btn-outline-secondary btn-sm">Website Đích ↗</a>` : ''}
          </div>
          ${latest.platform === 'tiktok_shop' ? `
            <div class="p-3 bg-light rounded mb-3 border fs-13">
              <div class="d-flex flex-wrap gap-3">
                <div><span class="fw-bold">📦 Số Lượng Đã Bán:</span> <span class="fw-bold text-success">${formatNum(latest.sold_count || latest.soldCount || 0)}</span></div>
                <div><span class="fw-bold">⭐ Đánh Giá (Rating):</span> <span class="fw-bold text-warning">${latest.rating > 0 ? `★ ${Number(latest.rating).toFixed(1)}` : '★ —'}</span></div>
                <div><span class="fw-bold">💬 Tổng Reviews:</span> <span class="fw-bold text-primary">${formatNum(latest.reviews || latest.reviewCount || 0)}</span></div>
              </div>
            </div>
          ` : ''}
          ${latest.platform === 'twitter' ? `
            <div class="p-3 bg-light rounded mb-3 border fs-13">
              <div class="d-flex flex-wrap gap-3">
                <div><span class="fw-bold">❤️ Số Likes:</span> <span class="fw-bold text-danger">${formatNum(latest.likes || 0)}</span></div>
                <div><span class="fw-bold">💬 Số Replies:</span> <span class="fw-bold text-primary">${formatNum(latest.comments || 0)}</span></div>
                <div><span class="fw-bold">👁️ Số Views:</span> <span class="fw-bold text-success">${formatNum(latest.views || 0)}</span></div>
              </div>
            </div>
          ` : ''}
          ${latest.platform === 'reddit' ? `
            <div class="p-3 bg-light rounded mb-3 border fs-13">
              <div class="d-flex flex-wrap gap-3">
                <div><span class="fw-bold">📁 Subreddit:</span> <span class="text-danger fw-bold">${latest.subreddit ? 'r/' + escapeHtml(latest.subreddit) : '—'}</span></div>
                <div><span class="fw-bold">🔺 Upvote Score:</span> <span class="fw-bold text-primary">${formatNum(latest.likes || 0)}</span></div>
                <div><span class="fw-bold">💬 Tổng Comments:</span> <span class="fw-bold text-success">${formatNum(latest.comments || 0)}</span></div>
              </div>
            </div>
          ` : ''}
          ${latest.platform === 'facebook_ads' ? `
            <div class="p-3 bg-light rounded mb-3 border">
              <div class="d-flex align-items-center mb-2">
                <span class="fw-bold me-2">👥 Lượt Thích Fanpage:</span>
                <span class="badge bg-primary fs-12">${formatNum(latest.fanpageLikes || latest.likes || 0)} likes</span>
              </div>
              <div class="mb-2">
                <span class="fw-bold me-2">📱 Nền Tảng Meta:</span>
                ${(Array.isArray(latest.publisherPlatforms) && latest.publisherPlatforms.length > 0 ? latest.publisherPlatforms : ['FACEBOOK']).map(p => `<span class="badge bg-dark text-white me-1">${p.replace(/_/g, ' ')}</span>`).join('')}
              </div>
              <div class="mb-2">
                <span class="fw-bold me-2">📅 Thời Gian Chạy:</span>
                <span>Bắt đầu: <strong>${latest.startDate ? parseServerTimestamp(latest.startDate).toLocaleDateString() : 'N/A'}</strong></span>
                <span class="ms-2">| Trạng thái: <span class="badge ${latest.isActive ? 'bg-success' : 'bg-secondary'}">${latest.isActive ? 'Đang chạy (Active)' : 'Đã kết thúc'}</span></span>
              </div>
              ${latest.cta ? `<div class="mt-2"><span class="fw-bold me-2">🔘 Nút CTA:</span><span class="badge bg-info text-dark">${escapeHtml(latest.cta)}</span></div>` : ''}
              <div class="mb-2 mt-2">
                <span class="fw-bold me-2">🌐 Website Đích:</span>
                ${latest.landingUrl
                  ? `<a href="${escapeAttr(latest.landingUrl)}" target="_blank" rel="noopener">${escapeHtml(latest.landingUrl)}</a>`
                  : '<span class="text-muted">—</span>'}
              </div>
              <!-- Task 4 additions. Rendered here as well as on the card so the
                   detail view is not the only place missing them. -->
              <div class="mb-2"><span class="fw-bold me-2">🧾 Số Lượng Quảng Cáo:</span>${adCountHtml(latest)}</div>
              <div class="mb-2"><span class="fw-bold me-2">👁 Views:</span>${Number(latest.views) > 0 ? `<strong>${formatNum(latest.views)}</strong>` : metaNotDisclosed()}</div>
              <div><span class="fw-bold me-2">🌍 Quốc Gia Đang Chạy:</span>${Array.isArray(latest.activeCountries) && latest.activeCountries.length
                ? latest.activeCountries.map((c) => `<span class="badge bg-secondary-subtle text-dark me-1">${escapeHtml(c)}</span>`).join('')
                : metaNotDisclosed()}</div>
            </div>
          ` : ''}
        </div>
      </div>
      <hr>
      <h6 class="fw-bold mb-2">📊 ${isEcommerce ? 'Biến Động Theo Thời Gian' : 'Engagement Over Time'}</h6>
      ${statsHtml}
      <div class="timeline-chart mb-3">${timelineHtml}</div>
      <hr>
      <h6 class="fw-bold mb-2">Lịch Sử Biến Động (${history.length} lần cào)</h6>
      <div class="table-responsive">
        <table class="table table-sm fs-13 align-middle">
          <thead>
            ${isEcommerce
              ? '<tr><th>Thời Gian</th><th>Trạng Thái</th><th>💵 Giá Hiện Tại</th><th>⭐ Điểm Đánh Giá</th><th>💬 Feedback / Reviews</th><th>📦 Đã Bán</th><th>❤️ Likes / Tym</th><th>Biến Động So Lượt Trước</th></tr>'
              : latest.platform === 'reddit'
              ? '<tr><th>Thời Gian</th><th>Trạng Thái</th><th>Subreddit</th><th>🔺 Upvote Score</th><th>💬 Comments</th><th>Biến Động</th></tr>'
              : latest.platform === 'twitter'
              ? '<tr><th>Thời Gian</th><th>Trạng Thái</th><th>❤️ Likes</th><th>💬 Replies</th><th>👁️ Views</th><th>Biến Động</th></tr>'
              : '<tr><th>Thời Gian</th><th>Trạng Thái</th><th>❤️ Likes</th><th>💬 Comments</th><th>🔄 Shares</th><th>👁️ Views</th><th>Biến Động</th></tr>'
            }
          </thead>
          <tbody>${history.map((h, i) => {
            const prev = i > 0 ? history[i - 1] : null;
            if (isEcommerce) {
              const gp = prev ? Number((h.price - prev.price).toFixed(2)) : 0;
              const gr = prev ? Number((h.rating - prev.rating).toFixed(1)) : 0;
              const grev = prev ? (h.reviews - prev.reviews) : 0;
              const gsold = prev ? ((h.sold_count || 0) - (prev.sold_count || 0)) : 0;
              const gl = prev ? (h.likes - prev.likes) : 0;
              const deltas = [];
              if (gp !== 0) deltas.push(`<span class="${gp < 0 ? 'text-success' : 'text-danger'}">Giá: ${gp > 0 ? '+' : ''}$${gp.toFixed(2)}</span>`);
              if (gr !== 0) deltas.push(`<span class="${gr > 0 ? 'text-success' : 'text-danger'}">Sao: ${gr > 0 ? '+' : ''}${gr.toFixed(1)}</span>`);
              if (grev !== 0) deltas.push(`<span class="${grev > 0 ? 'text-success' : 'text-danger'}">${h.platform === 'ebay' ? 'Feedback' : 'Reviews'}: ${grev > 0 ? '+' : ''}${grev}</span>`);
              if (gsold !== 0) deltas.push(`<span class="${gsold > 0 ? 'text-success' : 'text-danger'}">Đã bán: ${gsold > 0 ? '+' : ''}${gsold}</span>`);
              if (gl !== 0) deltas.push(`<span class="${gl > 0 ? 'text-success' : 'text-danger'}">Tym: ${gl > 0 ? '+' : ''}${gl}</span>`);

              return `<tr>
                <td>${parseServerTimestamp(h.run_date || h.created_at).toLocaleString()}</td>
                <td>${getStatusBadge(h.status)}</td>
                <td class="fw-bold">${h.price > 0 ? `$${Number(h.price).toFixed(2)}` : '—'}</td>
                <td>${h.rating > 0 ? (h.rating > 5 ? `★ ${Number(h.rating).toFixed(1)}%` : `★ ${Number(h.rating).toFixed(1)}`) : '—'}</td>
                <td>${h.reviews > 0 ? formatNum(h.reviews) : '0'}</td>
                <td>${(h.sold_count || 0) > 0 ? formatNum(h.sold_count) : '0'}</td>
                <td>${h.likes > 0 ? formatNum(h.likes) : '0'}</td>
                <td>${deltas.length ? deltas.join(' · ') : (i === 0 ? '<span class="text-muted">Lượt cào đầu tiên</span>' : '<span class="text-muted">Không đổi</span>')}</td>
              </tr>`;
            } else if (latest.platform === 'reddit') {
              const gl = prev ? (h.likes - prev.likes) : 0;
              const gc = prev ? (h.comments - prev.comments) : 0;
              const deltas = [];
              if (gl !== 0) deltas.push(`<span class="${gl > 0 ? 'text-success' : 'text-danger'}">Upvotes: ${gl > 0 ? '+' : ''}${gl}</span>`);
              if (gc !== 0) deltas.push(`<span class="${gc > 0 ? 'text-success' : 'text-danger'}">Comments: ${gc > 0 ? '+' : ''}${gc}</span>`);
              return `<tr>
                <td>${parseServerTimestamp(h.run_date || h.created_at).toLocaleString()}</td>
                <td>${getStatusBadge(h.status)}</td>
                <td><span class="text-danger fw-bold">${h.subreddit ? 'r/' + escapeHtml(h.subreddit) : (latest.subreddit ? 'r/' + escapeHtml(latest.subreddit) : '—')}</span></td>
                <td>${formatNum(h.likes || 0)}</td>
                <td>${formatNum(h.comments || 0)}</td>
                <td>${deltas.length ? deltas.join(' · ') : (i === 0 ? '<span class="text-muted">Lượt cào đầu tiên</span>' : '<span class="text-muted">Không đổi</span>')}</td>
              </tr>`;
            } else if (latest.platform === 'twitter') {
              const gl = prev ? (h.likes - prev.likes) : 0;
              const gc = prev ? (h.comments - prev.comments) : 0;
              const gv = prev ? (h.views - prev.views) : 0;
              const deltas = [];
              if (gl !== 0) deltas.push(`<span class="${gl > 0 ? 'text-success' : 'text-danger'}">Likes: ${gl > 0 ? '+' : ''}${gl}</span>`);
              if (gc !== 0) deltas.push(`<span class="${gc > 0 ? 'text-success' : 'text-danger'}">Replies: ${gc > 0 ? '+' : ''}${gc}</span>`);
              if (gv !== 0) deltas.push(`<span class="${gv > 0 ? 'text-success' : 'text-danger'}">Views: ${gv > 0 ? '+' : ''}${gv}</span>`);
              return `<tr>
                <td>${parseServerTimestamp(h.run_date || h.created_at).toLocaleString()}</td>
                <td>${getStatusBadge(h.status)}</td>
                <td>${formatNum(h.likes || 0)}</td>
                <td>${formatNum(h.comments || 0)}</td>
                <td>${formatNum(h.views || 0)}</td>
                <td>${deltas.length ? deltas.join(' · ') : (i === 0 ? '<span class="text-muted">Lượt cào đầu tiên</span>' : '<span class="text-muted">Không đổi</span>')}</td>
              </tr>`;
            } else {
              const g = prev ? { l: h.likes - prev.likes, c: h.comments - prev.comments, s: h.shares - prev.shares } : null;
              return `<tr>
                <td>${parseServerTimestamp(h.run_date || h.created_at).toLocaleString()}</td>
                <td>${getStatusBadge(h.status)}</td>
                <td>${h.likes}</td><td>${h.comments}</td><td>${h.shares}</td><td>${h.views}</td>
                <td>${g ? `<span class="${(g.l + g.c + g.s) > 0 ? 'text-success' : (g.l + g.c + g.s) < 0 ? 'text-danger' : 'text-muted'}">${g.l > 0 ? '+' : ''}${g.l} / ${g.c > 0 ? '+' : ''}${g.c} / ${g.s > 0 ? '+' : ''}${g.s}</span>` : '—'}</td>
              </tr>`;
            }
          }).join('')}</tbody>
        </table>
      </div>
      <div class="d-flex justify-content-between align-items-center mt-3 pt-3 border-top">
        <span class="text-muted fs-12 font-monospace">${escapeHtml(latest.item_uid || '')}</span>
        <button class="btn btn-outline-danger btn-sm px-3 d-flex align-items-center gap-1" onclick="deleteFromModal('${escapeAttr(latest.item_uid)}')">
          <i data-feather="trash-2" style="width:14px"></i> Xóa Sản Phẩm Này
        </button>
      </div>
    `;

    const modal = new bootstrap.Modal(document.getElementById('item-modal'));
    modal.show();
    feather.replace();
  } catch (err) { console.error('Detail failed:', err); }
}

function renderHistoryStats(history, isEcommerce = false) {
  if (history.length < 2) return '<p class="text-muted fs-13 mb-3">Lượt cào đầu tiên — hệ thống sẽ hiển thị biểu đồ và bảng so sánh biến động ở các lần cào tiếp theo.</p>';
  const first = history[0];
  const last = history[history.length - 1];
  const days = Math.max(1, Math.round((parseServerTimestamp(last.run_date || last.created_at) - parseServerTimestamp(first.run_date || first.created_at)) / 86400000));

  if (isEcommerce) {
    const priceDiff = Number((last.price - first.price).toFixed(2));
    const ratingDiff = Number((last.rating - first.rating).toFixed(1));
    const reviewsDiff = last.reviews - first.reviews;
    const soldDiff = (last.sold_count || 0) - (first.sold_count || 0);

    return `<div class="row g-2 mb-3">
      <div class="col-3"><div class="info-card"><div class="label">Lần đầu thấy</div><div class="value fs-13">${parseServerTimestamp(first.run_date || first.created_at).toLocaleDateString()}</div></div></div>
      <div class="col-3"><div class="info-card"><div class="label">Lần cào mới nhất</div><div class="value fs-13">${parseServerTimestamp(last.run_date || last.created_at).toLocaleDateString()}</div></div></div>
      <div class="col-3"><div class="info-card"><div class="label">Số lượt quan sát</div><div class="value">${history.length}</div></div></div>
      <div class="col-3"><div class="info-card"><div class="label">💵 Biến động Giá</div><div class="value ${priceDiff < 0 ? 'text-success' : priceDiff > 0 ? 'text-danger' : ''}">${priceDiff !== 0 ? (priceDiff > 0 ? '+' : '') + '$' + priceDiff.toFixed(2) : '0'}</div></div></div>
      <div class="col-3"><div class="info-card"><div class="label">⭐ Biến động Sao</div><div class="value ${ratingDiff > 0 ? 'text-success' : ratingDiff < 0 ? 'text-danger' : ''}">${ratingDiff !== 0 ? (ratingDiff > 0 ? '+' : '') + ratingDiff.toFixed(1) : '0'}</div></div></div>
      <div class="col-3"><div class="info-card"><div class="label">💬 Tăng Reviews</div><div class="value ${reviewsDiff > 0 ? 'text-success' : reviewsDiff < 0 ? 'text-danger' : ''}">${reviewsDiff > 0 ? '+' : ''}${reviewsDiff}</div></div></div>
      <div class="col-3"><div class="info-card"><div class="label">📦 Tăng Đã bán</div><div class="value ${soldDiff > 0 ? 'text-success' : soldDiff < 0 ? 'text-danger' : ''}">${soldDiff > 0 ? '+' : ''}${soldDiff}</div></div></div>
      <div class="col-3"><div class="info-card"><div class="label">❤️ Likes/Tym</div><div class="value text-primary">${formatNum(last.likes || last.reviews || 0)}</div></div></div>
    </div>`;
  }

  const totalGrowth = {
    likes: last.likes - first.likes,
    comments: last.comments - first.comments,
    shares: last.shares - first.shares,
    views: last.views - first.views,
  };

  return `<div class="row g-2 mb-3">
    <div class="col-3"><div class="info-card"><div class="label">First Seen</div><div class="value fs-13">${parseServerTimestamp(first.run_date || first.created_at).toLocaleDateString()}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">Last Seen</div><div class="value fs-13">${parseServerTimestamp(last.run_date || last.created_at).toLocaleDateString()}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">Days Tracked</div><div class="value">${days}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">Snapshots</div><div class="value">${history.length}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">❤️ Growth</div><div class="value ${totalGrowth.likes > 0 ? 'text-success' : totalGrowth.likes < 0 ? 'text-danger' : ''}">${totalGrowth.likes > 0 ? '+' : ''}${totalGrowth.likes}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">💬 Growth</div><div class="value ${totalGrowth.comments > 0 ? 'text-success' : totalGrowth.comments < 0 ? 'text-danger' : ''}">${totalGrowth.comments > 0 ? '+' : ''}${totalGrowth.comments}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">🔄 Growth</div><div class="value ${totalGrowth.shares > 0 ? 'text-success' : totalGrowth.shares < 0 ? 'text-danger' : ''}">${totalGrowth.shares > 0 ? '+' : ''}${totalGrowth.shares}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">📈 Avg/Day</div><div class="value">${((totalGrowth.likes + totalGrowth.comments + totalGrowth.shares) / days).toFixed(1)}</div></div></div>
  </div>`;
}

function renderTimeline(history, isEcommerce = false) {
  if (history.length < 2) return '<p class="text-muted fs-13">Thực hiện cào lại lần 2 để xem biểu đồ tăng trưởng.</p>';

  if (isEcommerce) {
    const maxReviews = Math.max(...history.map((h) => h.reviews || h.likes || 1), 1);
    return `<div style="display:flex;align-items:flex-end;gap:4px;height:80px;padding:8px 0">
      ${history.map((h) => {
        const hR = ((h.reviews || h.likes || 0) / maxReviews) * 100;
        const date = parseServerTimestamp(h.run_date || h.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:1px" title="${date}: $${h.price} | ★${h.rating} | ${h.reviews} reviews">
          <div style="display:flex;gap:1px;align-items:flex-end;width:100%;height:100%">
            <div style="flex:1;background:var(--primary);height:${Math.max(hR, 5)}%;border-radius:2px 2px 0 0;opacity:0.85"></div>
          </div>
          <span style="font-size:9px;color:var(--text-3);white-space:nowrap">${date}</span>
        </div>`;
      }).join('')}
    </div>
    <div class="d-flex gap-3 fs-12 text-muted">
      <span><span style="display:inline-block;width:8px;height:8px;background:var(--primary);border-radius:2px"></span> Reviews / Engagement</span>
    </div>`;
  }

  const maxVal = Math.max(...history.map((h) => Math.max(h.likes, h.comments, h.shares)), 1);

  return `<div style="display:flex;align-items:flex-end;gap:2px;height:80px;padding:8px 0">
    ${history.map((h, i) => {
      const hL = (h.likes / maxVal) * 100;
      const hC = (h.comments / maxVal) * 100;
      const hS = (h.shares / maxVal) * 100;
      const date = parseServerTimestamp(h.run_date || h.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric' });
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:1px" title="${date}: ❤️${h.likes} 💬${h.comments} 🔄${h.shares}">
        <div style="display:flex;gap:1px;align-items:flex-end;width:100%;height:100%">
          <div style="flex:1;background:var(--primary);height:${Math.max(hL, 2)}%;border-radius:2px 2px 0 0;opacity:0.8"></div>
          <div style="flex:1;background:var(--warning);height:${Math.max(hC, 2)}%;border-radius:2px 2px 0 0;opacity:0.8"></div>
          <div style="flex:1;background:var(--success);height:${Math.max(hS, 2)}%;border-radius:2px 2px 0 0;opacity:0.8"></div>
        </div>
        <span style="font-size:9px;color:var(--text-3);white-space:nowrap">${date}</span>
      </div>`;
    }).join('')}
  </div>
  <div class="d-flex gap-3 fs-12 text-muted">
    <span><span style="display:inline-block;width:8px;height:8px;background:var(--primary);border-radius:2px"></span> Likes</span>
    <span><span style="display:inline-block;width:8px;height:8px;background:var(--warning);border-radius:2px"></span> Comments</span>
    <span><span style="display:inline-block;width:8px;height:8px;background:var(--success);border-radius:2px"></span> Shares</span>
  </div>`;
}

// ==================== Facebook Ads fields (Task 4) ====================

function adFieldHtml(icon, label, valueHtml) {
  return `<div><span class="ad-field-label">${icon} ${label}:</span> ${valueHtml}</div>`;
}

/**
 * Meta publishes impressions, spend and reach-by-country ONLY for political and
 * social-issue ads; commercial ads carry none of it. Verified again on run #653
 * (2026-09-08, dataset 13Zk7clhgR3YTA7CR): all 5 ads returned
 * impressionsWithIndex={impressionsText:null,impressionsIndex:-1},
 * targetedOrReachedCountries=[], reachEstimate=null, spend=null.
 *
 * So the field is empty at the source, not unimplemented — which is what the
 * bare "SOURCE_NOT_AVAILABLE" tag failed to convey.
 */
function metaNotDisclosed() {
  return '<span class="src-na" title="Meta chỉ công bố reach và danh sách quốc gia cho quảng cáo có phục vụ trong EU (minh bạch theo DSA). Quảng cáo chỉ chạy ngoài EU không có dữ liệu này ở nguồn.">Chỉ có với QC chạy EU</span>';
}

/**
 * `collationCount` counts the ads sharing this creative and text. It is null
 * when the ad belongs to no collation (collationId is null too) — the Ad
 * Library shows such an ad on its own, i.e. exactly one ad uses this creative.
 * That is reported as 1 and marked "riêng lẻ", so the number is never confused
 * with a real collation of size 1 (which the provider does report, e.g. ad4 of
 * run #653 returned collationCount=1 with a collationId).
 */
function adCountHtml(item) {
  if (item.adCount === null || item.adCount === undefined || item.adCount === 0) {
    return '<span class="src-na">chưa lấy được</span>';
  }
  return `<strong>${formatNum(item.adCount)}</strong> <span class="ad-field-note">QC của trang này</span>`;
}

// ==================== Crawl-time filter (Task 3) ====================
// A "Bộ lọc" button that opens the metrics THIS platform can report, as tick
// boxes. Ticking one means "crawl the highest by this metric"; ticking two
// means an item has to satisfy both. There is no direction control here — the
// crawl is always after the top, which is why only the DB filter has one.
//
// The server evaluates these in the pipeline (raw -> normalize -> select ->
// persist), so a rejected item never reaches product_current at all.

let crawlFilterMetrics = [];

function renderCrawlFilterBoxes(platformName) {
  const host = document.getElementById('crawl-filter-boxes');
  const hint = document.getElementById('crawl-filter-hint');
  if (!host) return;

  crawlFilterMetrics = platformMetrics[platformName] || [];
  const label = allPlatforms.find((p) => p.name === platformName)?.displayName || platformName;

  if (crawlFilterMetrics.length === 0) {
    host.innerHTML = '<span class="metric-boxes-empty">Nền tảng này chưa khai báo chỉ số nào.</span>';
  } else {
    host.innerHTML = crawlFilterMetrics.map((m) => `
      <label class="metric-box">
        <input type="checkbox" value="${escapeAttr(m.name)}" onchange="onCrawlFilterChange()">
        <span>${escapeHtml(m.label)}</span>
      </label>`).join('');
  }
  if (hint) {
    hint.innerHTML = `Chỉ số của <strong>${escapeHtml(label)}</strong>. Tích ô nào thì crawl theo tiêu chí đó, lấy cao nhất trước. `
      + 'Tích nhiều ô = sản phẩm phải đạt tất cả. Bỏ trống = crawl như bình thường.';
  }
  updateCrawlFilterSummary();
  setCrawlFilterMessage('', 'info');
}

function collectCrawlSelection() {
  return [...document.querySelectorAll('#crawl-filter-boxes input[type=checkbox]:checked')].map((el) => el.value);
}

function onCrawlFilterChange() {
  updateCrawlFilterSummary();
  setCrawlFilterMessage('', 'info');
}

// The count rides on the collapsed button, so closing the panel never hides
// the fact that a filter is armed for the next crawl.
function updateCrawlFilterSummary() {
  const el = document.getElementById('crawl-filter-summary');
  if (!el) return;
  const selected = collectCrawlSelection();
  const labelFor = (n) => crawlFilterMetrics.find((m) => m.name === n)?.label || n;
  el.textContent = selected.length ? `· ${selected.map(labelFor).join(' + ')}` : '';
  el.classList.toggle('active', selected.length > 0);
}

function toggleCrawlFilter(forceOpen) {
  const body = document.getElementById('crawl-filter-body');
  const toggle = document.getElementById('crawl-filter-toggle');
  if (!body || !toggle) return;
  const open = forceOpen === undefined ? body.hidden : forceOpen;
  body.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.classList.toggle('open', open);
}

function setCrawlFilterMessage(text, kind) {
  const el = document.getElementById('crawl-filter-msg');
  if (!el) return;
  el.className = `crawl-filter-msg metric-result-${kind || 'info'}`;
  el.innerHTML = text;
}

// Reads back what the server actually did, rather than re-deriving it in the
// browser: the run row is the record of truth.
function renderCrawlFilterOutcome(run) {
  let options = run?.input_options;
  if (typeof options === 'string') { try { options = JSON.parse(options); } catch { options = null; } }
  const outcome = options?.crawlFilter;
  if (!outcome) return;

  const labelFor = (n) => crawlFilterMetrics.find((m) => m.name === n)?.label || n;
  const summary = (outcome.metrics || []).map((n) => escapeHtml(labelFor(n))).join(' + ');
  const rejects = (outcome.rejectedReasons || []).slice(0, 5)
    .map((r) => `<li>${escapeHtml(r.reasons.join('; '))}</li>`)
    .join('');

  setCrawlFilterMessage(
    `Lọc theo <strong>${summary || 'điều kiện'}</strong>: crawl ${outcome.fetched} → giữ <strong>${outcome.kept}</strong>, loại ${outcome.rejected}.`
    + (rejects ? `<ul class="crawl-filter-rejects">${rejects}</ul>` : ''),
    outcome.kept > 0 ? 'ok' : 'warn'
  );
}

// ==================== Collect ====================

async function showCollectModal() {
  collectPlatform = null;
  document.getElementById('collect-query').value = '';
  document.getElementById('collect-query-label').textContent = 'Search Query';
  document.getElementById('collect-platform-fields').innerHTML = '';
  document.getElementById('collect-hint').textContent = '';
  document.getElementById('collect-start').disabled = true;
  document.getElementById('collect-status').innerHTML = '<small class="text-muted">Checking platform health...</small>';
  new bootstrap.Modal(document.getElementById('collect-modal')).show();

  try {
    doctorReport = await apiFetch('/api/doctor?json=true');
    document.getElementById('collect-status').innerHTML = '';
  } catch (err) {
    document.getElementById('collect-status').innerHTML = '<small class="text-danger">Failed to check platform health.</small>';
  }

  renderPlatformGrid();
}

function renderPlatformGrid() {
  document.getElementById('platform-grid').innerHTML = allPlatforms
    .filter((p) => p.name !== 'toidispy')
    .map((p) => {
    let healthBadge = '';
    let isFailed = false;
    if (doctorReport && doctorReport.channels && doctorReport.channels[p.name]) {
      const channelHealth = doctorReport.channels[p.name];
      if (channelHealth.status === 'failed') {
        isFailed = true;
        healthBadge = '<span class="badge bg-danger text-white ms-1" style="font-size:9px">FAILED</span>';
      } else if (channelHealth.status === 'warn') {
        let isNeedsSetup = false;
        let isUnverified = false;
        for (const b of channelHealth.backends) {
           if (b.status === 'warn') {
             if (b.missing && b.missing.length > 0) isNeedsSetup = true;
             if (b.warnings && b.warnings.some(w => w.toLowerCase().includes('unverified'))) isUnverified = true;
           }
        }
        if (isNeedsSetup) healthBadge = '<span class="badge bg-warning text-dark ms-1" style="font-size:9px">NEEDS SETUP</span>';
        else if (isUnverified) healthBadge = '<span class="badge bg-secondary text-white ms-1" style="font-size:9px">UNVERIFIED</span>';
        else healthBadge = '<span class="badge bg-warning text-dark ms-1" style="font-size:9px">WARN</span>';
      } else if (channelHealth.status === 'ok') {
        healthBadge = '<span class="badge bg-success text-white ms-1" style="font-size:9px">READY</span>';
      } else if (channelHealth.status === 'disabled') {
        isFailed = true;
        healthBadge = '<span class="badge bg-dark text-white ms-1" style="font-size:9px">UNSUPPORTED</span>';
      }
    }
    return `<div class="platform-option ${isFailed ? 'disabled text-muted' : ''}" data-platform="${p.name}" onclick="selectCollectPlatform('${p.name}', this)">
      <span class="po-icon">${p.icon}</span> ${p.displayName}
      ${p.paid ? '<span class="badge bg-warning text-dark ms-1" style="font-size:9px">PAID</span>' : ''}
      ${healthBadge}
    </div>`;
  }).join('');
}

function selectCollectPlatform(name, el) {
  collectPlatform = name;
  document.querySelectorAll('.platform-option').forEach((o) => o.classList.remove('selected'));
  el.classList.add('selected');
  const config = allPlatforms.find((p) => p.name === name);
  const queryField = config?.queryField || { label: 'Search Query', placeholder: config?.queryType === 'url' ? 'Enter store URL...' : 'Enter keyword...' };
  document.getElementById('collect-query-label').textContent = queryField.label || 'Search Query';
  document.getElementById('collect-query').type = queryField.type || 'text';
  document.getElementById('collect-query').placeholder = queryField.placeholder || 'Enter keyword...';
  renderPlatformFields(config, queryField.id);
  // Task 3: the crawl filter offers the metric set this platform's normalizer
  // actually produces, so an e-commerce crawl is never asked to filter on
  // "shares" and a social crawl is never asked to filter on "sold".
  // Task 3: the filter offers exactly the metrics this platform's normalizer
  // produces, so an Etsy crawl is never asked to filter on "shares".
  renderCrawlFilterBoxes(name);
  toggleCrawlFilter(false);
  document.getElementById('collect-query').focus();

  const checklist = document.getElementById('toidispy-checklist');
  if (checklist) {
    if (name === 'toidispy') {
      checklist.classList.remove('d-none');
      feather.replace();
    } else {
      checklist.classList.add('d-none');
    }
  }

  // Health gating checks
  let explanationHtml = config?.description || '';
  if (doctorReport && doctorReport.channels && doctorReport.channels[name]) {
    const ch = doctorReport.channels[name];
    if (ch.status === 'failed') {
       explanationHtml = `<div class="text-danger mt-1"><strong>${config?.displayName || name} cannot run yet.</strong><br>Reason: No healthy backend.</div>`;
       for (const b of ch.backends) {
         if (b.missing && b.missing.length > 0) explanationHtml += `<div class="text-muted ms-2 mt-1">- ${b.missing.join('<br>- ')}</div>`;
         if (b.warnings && b.warnings.length > 0) explanationHtml += `<div class="text-muted ms-2 mt-1">- ${b.warnings.join('<br>- ')}</div>`;
         if (b.actions && b.actions.length > 0) explanationHtml += `<div class="text-primary ms-2 mt-1">Action: ${b.actions.join(' or ')}</div>`;
       }
    } else if (ch.status === 'warn') {
       explanationHtml = `<div class="text-warning mt-1"><strong>${config?.displayName || name} has warnings.</strong></div>`;
       for (const b of ch.backends) {
         if (b.warnings && b.warnings.length > 0) explanationHtml += `<div class="text-muted ms-2 mt-1">- ${b.warnings.join('<br>- ')}</div>`;
         if (b.actions && b.actions.length > 0) explanationHtml += `<div class="text-primary ms-2 mt-1">Action: ${b.actions.join(' or ')}</div>`;
       }
    }
  }
  document.getElementById('collect-hint').innerHTML = explanationHtml;

  updateCollectBtn();
}

function renderPlatformFields(config, queryFieldId) {
  const container = document.getElementById('collect-platform-fields');
  const fields = (config?.inputFields || []).filter((field) => field.id !== queryFieldId);
  container.innerHTML = fields.map((field) => {
    const label = `${escapeHtml(field.label)}${field.required ? ' <span class="text-danger">*</span>' : ''}`;
    const help = field.help ? `<small class="text-muted d-block mt-1">${escapeHtml(field.help)}</small>` : '';
    const id = `collect-field-${escapeAttr(field.id)}`;
    if (field.type === 'select') {
      const options = (field.options || []).map((option) => `<option value="${escapeAttr(option)}" ${option === field.default ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('');
      return `<div class="col-12"><label class="filter-label" for="${id}">${label}</label><select class="form-select" id="${id}" data-collection-field="${escapeAttr(field.id)}">${options}</select>${help}</div>`;
    }
    return `<div class="col-12"><label class="filter-label" for="${id}">${label}</label><input class="form-control" id="${id}" data-collection-field="${escapeAttr(field.id)}" type="${escapeAttr(field.type || 'text')}" placeholder="${escapeAttr(field.placeholder || '')}" ${field.required ? 'required' : ''}>${help}</div>`;
  }).join('');
}

function getPlatformFieldValues() {
  const values = {};
  document.querySelectorAll('[data-collection-field]').forEach((field) => {
    values[field.dataset.collectionField] = field.value.trim();
  });
  return values;
}

function updateCollectBtn() {
  const query = document.getElementById('collect-query').value.trim();
  let hasHealthyBackend = true;
  if (doctorReport && collectPlatform && doctorReport.channels && doctorReport.channels[collectPlatform]) {
     if (doctorReport.channels[collectPlatform].status === 'failed') {
        hasHealthyBackend = false;
     }
  }
  document.getElementById('collect-start').disabled = !collectPlatform || !query || !hasHealthyBackend;
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('collect-query').addEventListener('input', updateCollectBtn);
  document.getElementById('collect-platform-fields').addEventListener('input', updateCollectBtn);
  document.getElementById('collect-platform-fields').addEventListener('change', updateCollectBtn);
});

async function startCollect() {
  if (!collectPlatform) return;
  const query = document.getElementById('collect-query').value.trim();
  const maxItems = parseInt(document.getElementById('collect-max').value) || 20;
  const country = document.getElementById('collect-country').value;

  // Task 3: a tick box cannot be half-filled, so there is nothing to refuse
  // here — the panel just states what is about to be applied.
  const crawlMetrics = collectCrawlSelection();
  const crawlMetricLabel = (n) => crawlFilterMetrics.find((m) => m.name === n)?.label || n;
  setCrawlFilterMessage(
    crawlMetrics.length
      ? `Sẽ chỉ lưu item có: ${crawlMetrics.map((n) => escapeHtml(crawlMetricLabel(n))).join(' + ')} (cao nhất trước)`
      : '',
    'info'
  );

  const btn = document.getElementById('collect-start');
  const status = document.getElementById('collect-status');
  btn.disabled = true;
  btn.querySelector('.btn-text').classList.add('d-none');
  btn.querySelector('.btn-loading').classList.remove('d-none');
  status.innerHTML = `<small class="text-primary">Starting...</small>`;

  try {
    const optionsPayload = { maxItems, country, ...getPlatformFieldValues() };
    // Sent only when the user ticked something, so an untouched panel keeps
    // the exact previous behaviour (everything crawled is kept).
    if (crawlMetrics.length > 0) optionsPayload.metrics = crawlMetrics;
    if (collectPlatform === 'toidispy') {
      optionsPayload.section = optionsPayload.section || 'posts';
      optionsPayload.filters = {};
    }

    const result = await apiFetch('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ platform: collectPlatform, query, options: optionsPayload }),
    });
    status.innerHTML = `<small class="text-success">✅ Run #${result.id} started. Polling...</small>`;

    const poll = setInterval(async () => {
      try {
        const run = await apiFetch(`/api/runs/${result.id}`);
        if (run.status === 'done' || run.status === 'failed') {
          clearInterval(poll);
          if (run.status === 'done') {
            status.innerHTML = `<small class="text-success">✅ Done! ${run.items_count} items (${run.new_count} new, ${run.active_count} active, ${run.dropped_count} dropped)</small>`;
            // The run records what the crawl filter did (runs.input_options
            // .crawlFilter). Showing it here answers "why did 5 crawled items
            // become 2 stored" without opening the database.
            renderCrawlFilterOutcome(run);
          } else {
            let errorHtml = `❌ ${escapeHtml(run.error_message || 'Failed')}`;
            try {
              if (run.health_snapshot) {
                const snapshot = typeof run.health_snapshot === 'string' ? JSON.parse(run.health_snapshot) : run.health_snapshot;
                if (snapshot.error) {
                  errorHtml = `❌ <strong>Script failed.</strong> Message: ${escapeHtml(snapshot.error)}<br>`;
                  if (snapshot.code === 'TOIDISPY_LOGIN_REQUIRED' || snapshot.error.includes('TOIDISPY_LOGIN_REQUIRED')) {
                    errorHtml = `❌ <strong>Toidispy login required.</strong> Open Chrome CDP profile, login to Toidispy, then retry.<br>`;
                  }
                  const url = snapshot.stderrDiagnostic?.currentUrl || snapshot.stdoutJson?.error?.currentUrl;
                  const title = snapshot.stderrDiagnostic?.title || snapshot.stdoutJson?.error?.title;
                  if (url) errorHtml += `Page: <a href="${escapeAttr(url)}" target="_blank">${escapeHtml(title || url)}</a><br>`;
                  if (snapshot.actions) errorHtml += `Action: ${escapeHtml(snapshot.actions.join(' / '))}<br>`;
                  if (snapshot.stderrDiagnostic?.screenshotPath) errorHtml += `Debug: ${escapeHtml(snapshot.stderrDiagnostic.screenshotPath)}`;
                }
              }
            } catch(e) {}
            status.innerHTML = `<small class="text-danger" style="display:block;line-height:1.4">${errorHtml}</small>`;
          }
          btn.querySelector('.btn-text').classList.remove('d-none');
          btn.querySelector('.btn-loading').classList.add('d-none');
          btn.disabled = false;
          await loadData();
        }
      } catch (e) { console.error(e); }
    }, 3000);
  } catch (err) {
    status.innerHTML = `<small class="text-danger">❌ ${err.message}</small>`;
    btn.querySelector('.btn-text').classList.remove('d-none');
    btn.querySelector('.btn-loading').classList.add('d-none');
    btn.disabled = false;
  }
}

async function checkToidispyLogin() {
  const btn = document.getElementById('btn-check-toidispy-login');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Checking...`;

  try {
    const result = await apiFetch('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        platform: 'toidispy',
        query: 'login_check',
        options: { maxItems: 1, section: 'posts', filters: {} }
      }),
    });

    const poll = setInterval(async () => {
      try {
        const run = await apiFetch(`/api/runs/${result.id}`);
        if (run.status === 'done' || run.status === 'failed') {
          clearInterval(poll);
          let isLoggedOut = false;
          if (run.health_snapshot) {
             const snapshot = typeof run.health_snapshot === 'string' ? JSON.parse(run.health_snapshot) : run.health_snapshot;
             if (snapshot.code === 'TOIDISPY_LOGIN_REQUIRED' || (snapshot.error && snapshot.error.includes('TOIDISPY_LOGIN_REQUIRED'))) isLoggedOut = true;
          }
          if (isLoggedOut) {
            btn.innerHTML = `<i data-feather="x-circle" style="width: 12px;"></i> Login Required`;
            btn.classList.replace('btn-outline-warning', 'btn-danger');
          } else if (run.status === 'done' || (run.status === 'failed' && !isLoggedOut)) {
            // Even if failed for another reason (e.g., timeout on results), it means login was successful
            btn.innerHTML = `<i data-feather="check-circle" style="width: 12px;"></i> Logged In`;
            btn.classList.replace('btn-outline-warning', 'btn-success');
          }
          feather.replace();
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = originalText;
            btn.className = 'btn btn-outline-warning btn-sm py-1 w-100';
            feather.replace();
          }, 4000);

          await apiFetch(`/api/runs/${result.id}`, { method: 'DELETE' }).catch(()=>{});
        }
      } catch(e) { clearInterval(poll); btn.disabled = false; btn.innerHTML = originalText; feather.replace(); }
    }, 1500);
  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = originalText;
    feather.replace();
  }
}

// ==================== Export ====================

function exportAll() {
  if (!allItems || allItems.length === 0) {
    alert('No items to export.');
    return;
  }
  const headers = [
    'Crawled Date/Time (Ngày giờ cào)', 'Platform (Nền tảng)', 'Title (Tên sản phẩm)',
    'Author/Shop (Tên Shop)', 'Price ($) (Giá bán)', 'Price Change ($) (Biến động giá)',
    'Sold Count (Số lượt bán)', 'Sold Growth (Tăng trưởng lượt bán)',
    'Reviews (Số đánh giá)', 'Reviews Growth (Tăng trưởng đánh giá)',
    'Rating (Điểm đánh giá)', 'Likes (Lượt thích)', 'Likes Growth (Tăng trưởng Like)',
    'Status (Trạng thái)', 'URL (Link sản phẩm)'
  ];
  const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
  const headerLine = headers.join(',');
  const rows = allItems.map((i) => {
    const g = typeof i.growth === 'object' && i.growth ? i.growth : {};
    return [
      escapeCsv(i.created_at || i.createdAt || ''), escapeCsv(i.platform), escapeCsv(i.title),
      escapeCsv(i.author), escapeCsv(i.price), escapeCsv(g.priceChange || 0),
      escapeCsv(i.sold_count || i.soldCount || 0), escapeCsv(g.soldCount || 0),
      escapeCsv(i.reviews || 0), escapeCsv(g.reviews || 0),
      escapeCsv(i.rating || 0), escapeCsv(i.likes || 0), escapeCsv(g.likes || 0),
      escapeCsv(i.status || 'active'), escapeCsv(i.url)
    ].join(',');
  });
  const csvContent = '\uFEFF' + [headerLine, ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `apify-collector-${Date.now()}.csv`;
  a.click();
}

// ==================== Jobs History ====================

async function showHistoryModal() {
  new bootstrap.Modal(document.getElementById('jobs-modal')).show();
  await loadJobs();
}

async function loadJobs() {
  const tbody = document.getElementById('jobs-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4">Loading...</td></tr>';
  try {
    const jobs = await apiFetch('/api/runs');
    if (!jobs.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-muted">No jobs found.</td></tr>';
      return;
    }
    tbody.innerHTML = jobs.map((j) => {
      const config = allPlatforms.find((p) => p.name === j.platform);
      const icon = config?.icon || '🔗';
      const pName = config?.displayName || j.platform;
      const statusBadge =
        j.status === 'done' ? `<a href="/run-detail.html?id=${j.id}" target="_blank" class="btn btn-sm btn-success py-0 px-2 fs-12 text-white d-inline-flex align-items-center gap-1 shadow-sm" title="Bấm để xem chi tiết kết quả"><i data-feather="check-circle" style="width: 12px;"></i> Done &nearr;</a>` :
        j.status === 'running' ? `<a href="/run-detail.html?id=${j.id}" target="_blank" class="btn btn-sm btn-primary py-0 px-2 fs-12 text-white d-inline-flex align-items-center gap-1 shadow-sm" title="Bấm để theo dõi tiến trình"><i data-feather="loader" style="width: 12px;"></i> Running &nearr;</a>` :
        j.status === 'failed' ? `<a href="/run-detail.html?id=${j.id}" target="_blank" class="btn btn-sm btn-danger py-0 px-2 fs-12 text-white d-inline-flex align-items-center gap-1 shadow-sm" title="Bấm để xem chi tiết nguyên nhân lỗi"><i data-feather="alert-octagon" style="width: 12px;"></i> Failed &nearr;</a>` :
        j.status === 'stuck' ? `<a href="/run-detail.html?id=${j.id}" target="_blank" class="btn btn-sm btn-danger py-0 px-2 fs-12 text-white d-inline-flex align-items-center gap-1 shadow-sm" title="Bấm để xem chi tiết lỗi kẹt"><i data-feather="alert-triangle" style="width: 12px;"></i> Stuck &nearr;</a>` :
        `<a href="/run-detail.html?id=${j.id}" target="_blank" class="btn btn-sm btn-secondary py-0 px-2 fs-12 text-white d-inline-flex align-items-center gap-1 shadow-sm">Pending &nearr;</a>`;

      return `<tr>
        <td>#${j.id}</td>
        <td>${icon} ${pName}</td>
        <td style="max-width:300px;">
          <div class="text-truncate" title="${escapeAttr(j.query)}">${escapeHtml(j.query)}</div>
        </td>
        <td>${j.active_backend ? `<span class="badge bg-secondary">${j.active_backend}</span>` : '-'}</td>
        <td>${statusBadge}</td>
        <td>${j.items_count}</td>
        <td>${parseServerTimestamp(j.created_at).toLocaleString()}</td>
        <td>
          <a href="/api/export/${j.id}?format=csv" class="btn btn-sm btn-outline-primary py-0 px-2 fs-12 me-1" target="_blank">Export CSV</a>
          <button class="btn btn-sm btn-outline-danger py-0 px-2 fs-12" onclick="deleteJob(${j.id})">Delete</button>
        </td>
      </tr>`;
    }).join('');
    if (window.feather) feather.replace();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-danger">Error: ${err.message}</td></tr>`;
  }
}

async function deleteJob(id) {
  if (!confirm(`Are you sure you want to delete job #${id} and all its data?`)) return;
  try {
    await apiFetch(`/api/runs/${id}`, { method: 'DELETE' });
    await loadJobs(); // reload jobs table
    await loadData(); // reload main grid to remove deleted items
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

// ==================== Helpers ====================

async function apiFetch(endpoint, options = {}) {
  const res = await fetch(endpoint, { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    if (!res.ok) throw new Error(`Lỗi máy chủ (${res.status}): Yêu cầu bị gián đoạn hoặc quá thời gian xử lý.`);
    throw new Error('Dữ liệu từ máy chủ không phải định dạng JSON hợp lệ.');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }
function escapeAttr(t) { return String(t || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// UI-BUG-04: the API returns SQLite's default CURRENT_TIMESTAMP format —
// "YYYY-MM-DD HH:MM:SS", UTC, but with NO 'Z'/offset marker. Passed straight
// to `new Date(...)`, browsers parse a space-separated (non-'T') timestamp
// with no timezone marker as LOCAL time, not UTC — so a UTC value gets
// re-interpreted as if it were already local, shifting every displayed
// timestamp by the viewer's UTC offset (e.g. -7h for ICT/Vietnam). Every
// place in this file that turns a server timestamp into a Date must go
// through this one helper instead of calling `new Date(...)` directly on
// the raw string, so the whole UI stays consistent.
function parseServerTimestamp(value) {
  if (!value) return new Date(NaN);
  const str = String(value);
  // Already has a 'T'+timezone marker (ISO 8601) or is otherwise explicit —
  // leave it alone. Only the bare "YYYY-MM-DD HH:MM:SS" shape is ambiguous.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(str)) {
    return new Date(str.replace(' ', 'T') + 'Z');
  }
  return new Date(str);
}
function formatNum(n) { if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1000) return (n / 1000).toFixed(1) + 'K'; return String(n); }

// ==================== Marketplace Sessions + HTML Capture ====================

async function showMarketplaceAccountsModal() {
  document.getElementById('marketplace-account-label').value = '';
  document.getElementById('marketplace-account-state').value = '';
  document.getElementById('marketplace-account-status').textContent = '';
  document.getElementById('marketplace-login-status').textContent = '';
  document.getElementById('marketplace-login-confirm').classList.add('d-none');
  document.getElementById('marketplace-login-cancel').classList.add('d-none');
  new bootstrap.Modal(document.getElementById('marketplace-accounts-modal')).show();
  await loadMarketplaceProxyProfiles();
  await loadMarketplaceAccounts();
  await loadApifyTokens();
  feather.replace();
}

// UI-BUG-05: this hint used to be hardcoded to "Một cookie Etsy được tự gán
// domain .etsy.com", regardless of which platform is actually selected in
// the dropdown right above it — misleading for Amazon/eBay accounts.
const MARKETPLACE_COOKIE_DOMAINS = { amazon: '.amazon.com', ebay: '.ebay.com', etsy: '.etsy.com' };
function updateMarketplaceCookieHint(platform) {
  const hint = document.getElementById('marketplace-account-cookie-hint');
  if (!hint) return;
  const domain = MARKETPLACE_COOKIE_DOMAINS[platform] || `.${platform}.com`;
  const label = allPlatforms?.find((p) => p.name === platform)?.displayName || platform;
  hint.innerHTML = `Một cookie ${escapeHtml(label)} được tự gán domain <code>${escapeHtml(domain)}</code>; không cần dán cả storage state.`;
}

async function loadMarketplaceAccounts() {
  const platform = document.getElementById('marketplace-account-platform').value;
  updateMarketplaceCookieHint(platform);
  const list = document.getElementById('marketplace-accounts-list');
  list.textContent = 'Loading...';
  try {
    const accounts = await apiFetch(`/api/marketplace-accounts?platform=${encodeURIComponent(platform)}`);
    list.innerHTML = accounts.length ? accounts.map((account) => `
      <div class="border rounded p-2 mb-2">
        <div class="d-flex justify-content-between align-items-start gap-2"><span><strong>${escapeHtml(account.label)}</strong><br><span class="text-muted">${escapeHtml(account.platform)} · saved ${parseServerTimestamp(account.updated_at).toLocaleString()}</span></span><button class="btn btn-outline-danger btn-sm" onclick="deleteMarketplaceAccount(${Number(account.id)})">Remove</button></div>
        <div class="d-flex gap-2 align-items-center mt-2"><select id="marketplace-account-proxy-${Number(account.id)}" class="form-select form-select-sm">${marketplaceProxyOptions(account.proxy_id)}</select><button class="btn btn-outline-primary btn-sm text-nowrap" onclick="assignMarketplaceAccountProxy(${Number(account.id)})">Use proxy</button></div>
      </div>`).join('') : '<span class="text-muted">No saved accounts for this platform.</span>';
  } catch (err) { list.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`; }
}

async function saveMarketplaceAccount() {
  const platform = document.getElementById('marketplace-account-platform').value;
  const label = document.getElementById('marketplace-account-label').value.trim();
  const storageState = document.getElementById('marketplace-account-state').value.trim();
  const proxyId = document.getElementById('marketplace-account-proxy').value;
  const status = document.getElementById('marketplace-account-status');
  try {
    await apiFetch('/api/marketplace-accounts', { method: 'POST', body: JSON.stringify({ platform, label, storageState, proxyId: proxyId || null }) });
    document.getElementById('marketplace-account-label').value = '';
    document.getElementById('marketplace-account-state').value = '';
    status.innerHTML = '<span class="text-success">Encrypted session saved.</span>';
    await loadMarketplaceAccounts();
  } catch (err) { status.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`; }
}

function marketplaceProxyOptions(selectedId = null) {
  const selected = Number(selectedId);
  return ['<option value="">No proxy</option>', ...marketplaceProxyProfiles.map((proxy) =>
    `<option value="${Number(proxy.id)}"${Number(proxy.id) === selected ? ' selected' : ''}>${escapeHtml(proxy.label)} · SOCKS5 ${escapeHtml(proxy.host)}:${Number(proxy.port)}</option>`,
  )].join('');
}

async function loadMarketplaceProxyProfiles() {
  const list = document.getElementById('marketplace-proxies-list');
  try {
    marketplaceProxyProfiles = await apiFetch('/api/marketplace-proxies');
    document.getElementById('marketplace-account-proxy').innerHTML = marketplaceProxyOptions();
    list.innerHTML = marketplaceProxyProfiles.length ? marketplaceProxyProfiles.map((proxy) => `
      <div class="d-flex justify-content-between align-items-center border rounded p-2 mb-1"><span><strong>${escapeHtml(proxy.label)}</strong> <span class="text-muted">SOCKS5 ${escapeHtml(proxy.host)}:${Number(proxy.port)}</span></span><button class="btn btn-outline-danger btn-sm" onclick="deleteMarketplaceProxy(${Number(proxy.id)})">Remove</button></div>`,
    ).join('') : '<span class="text-muted">No saved SOCKS5 proxy profiles.</span>';
  } catch (err) { list.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`; }
}

async function saveMarketplaceProxy() {
  const status = document.getElementById('marketplace-proxy-status');
  const payload = {
    label: document.getElementById('marketplace-proxy-label').value.trim(),
    host: document.getElementById('marketplace-proxy-host').value.trim(),
    port: Number(document.getElementById('marketplace-proxy-port').value),
    username: document.getElementById('marketplace-proxy-username').value,
    password: document.getElementById('marketplace-proxy-password').value,
  };
  try {
    await apiFetch('/api/marketplace-proxies', { method: 'POST', body: JSON.stringify(payload) });
    for (const id of ['marketplace-proxy-label', 'marketplace-proxy-host', 'marketplace-proxy-username', 'marketplace-proxy-password']) document.getElementById(id).value = '';
    document.getElementById('marketplace-proxy-port').value = '1080';
    status.innerHTML = '<span class="text-success">SOCKS5 proxy saved encrypted.</span>';
    await loadMarketplaceProxyProfiles();
    await loadMarketplaceAccounts();
  } catch (err) { status.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`; }
}

async function assignMarketplaceAccountProxy(accountId) {
  const proxyId = document.getElementById(`marketplace-account-proxy-${Number(accountId)}`).value;
  try {
    await apiFetch(`/api/marketplace-accounts/${Number(accountId)}/proxy`, { method: 'PUT', body: JSON.stringify({ proxyId: proxyId || null }) });
    await loadMarketplaceAccounts();
  } catch (err) { alert(`Could not assign proxy: ${err.message}`); }
}

async function deleteMarketplaceProxy(id) {
  if (!confirm('Remove this proxy profile? Assigned accounts will switch to no proxy.')) return;
  try {
    await apiFetch(`/api/marketplace-proxies/${Number(id)}`, { method: 'DELETE' });
    await loadMarketplaceProxyProfiles();
    await loadMarketplaceAccounts();
  } catch (err) { alert(`Could not remove proxy: ${err.message}`); }
}

async function startMarketplaceBrowserLogin() {
  const platform = document.getElementById('marketplace-account-platform').value;
  const label = document.getElementById('marketplace-account-label').value.trim();
  const status = document.getElementById('marketplace-login-status');
  if (!label) {
    status.innerHTML = '<span class="text-danger">Enter an account label before signing in.</span>';
    return;
  }
  try {
    status.innerHTML = '<span class="text-muted">Opening a local browser…</span>';
    const session = await apiFetch('/api/marketplace-login-sessions', { method: 'POST', body: JSON.stringify({ platform }) });
    marketplaceLoginSessionId = session.id;
    status.innerHTML = '<span class="text-primary">Sign in in the browser window, finish MFA/CAPTCHA, then click “I have signed in”.</span>';
    document.getElementById('marketplace-login-confirm').classList.remove('d-none');
    document.getElementById('marketplace-login-cancel').classList.remove('d-none');
    feather.replace();
  } catch (err) { status.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`; }
}

async function confirmMarketplaceBrowserLogin() {
  const status = document.getElementById('marketplace-login-status');
  if (!marketplaceLoginSessionId) return;
  try {
    const label = document.getElementById('marketplace-account-label').value.trim();
    await apiFetch(`/api/marketplace-login-sessions/${encodeURIComponent(marketplaceLoginSessionId)}/complete`, { method: 'POST', body: JSON.stringify({ label }) });
    marketplaceLoginSessionId = null;
    document.getElementById('marketplace-account-label').value = '';
    document.getElementById('marketplace-login-confirm').classList.add('d-none');
    document.getElementById('marketplace-login-cancel').classList.add('d-none');
    status.innerHTML = '<span class="text-success">Signed-in session encrypted and saved.</span>';
    await loadMarketplaceAccounts();
  } catch (err) { status.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`; }
}

async function cancelMarketplaceBrowserLogin() {
  if (!marketplaceLoginSessionId) return;
  try { await apiFetch(`/api/marketplace-login-sessions/${encodeURIComponent(marketplaceLoginSessionId)}`, { method: 'DELETE' }); }
  catch (err) { console.error('Could not cancel browser login:', err); }
  marketplaceLoginSessionId = null;
  document.getElementById('marketplace-login-confirm').classList.add('d-none');
  document.getElementById('marketplace-login-cancel').classList.add('d-none');
  document.getElementById('marketplace-login-status').textContent = 'Browser login cancelled.';
}

async function deleteMarketplaceAccount(id) {
  if (!confirm('Remove this saved browser session? Captures already saved will be kept.')) return;
  try {
    await apiFetch(`/api/marketplace-accounts/${id}`, { method: 'DELETE' });
    await loadMarketplaceAccounts();
  } catch (err) { alert(`Could not remove session: ${err.message}`); }
}

// ==================== Apify Token Pool UI ====================

async function loadApifyTokens() {
  const list = document.getElementById('apify-tokens-list');
  const badge = document.getElementById('apify-pool-summary-badge');
  if (!list) return;
  list.innerHTML = '<span class="text-muted">Đang tải danh sách token...</span>';

  try {
    const data = await apiFetch('/api/apify-tokens');
    const tokens = data.tokens || [];
    if (badge) {
      badge.textContent = `${tokens.length} token (${data.healthyCount || 0} active)`;
      badge.className = (data.healthyCount > 0) ? 'badge bg-success' : 'badge bg-warning text-dark';
    }

    if (!tokens.length) {
      list.innerHTML = '<span class="text-muted">Chưa có token nào trong pool. Vui lòng thêm token bên trên.</span>';
      return;
    }

    const stateBadgeMap = {
      HEALTHY: '<span class="badge bg-success">HEALTHY</span>',
      COOLDOWN: '<span class="badge bg-warning text-dark">COOLDOWN</span>',
      EXHAUSTED: '<span class="badge bg-danger">EXHAUSTED / CAP REACHED</span>',
      INVALID: '<span class="badge bg-secondary">INVALID</span>',
      DISABLED: '<span class="badge bg-dark">DISABLED</span>'
    };

    list.innerHTML = tokens.map((t) => `
      <div class="border rounded p-2 mb-2 bg-light">
        <div class="d-flex justify-content-between align-items-center">
          <div>
            <strong>${escapeHtml(t.label || t.id)}</strong>
            <span class="ms-2">${stateBadgeMap[t.state] || escapeHtml(t.state)}</span>
            <br>
            <small class="text-muted font-monospace">ID: ${escapeHtml(t.id)} | Lượt dùng: ${t.usageCount || 0}${t.consecutiveFailures > 0 ? ` | Lỗi liên tiếp: ${t.consecutiveFailures}` : ''}${t.lastBlockReason ? ` | Lý do: ${escapeHtml(t.lastBlockReason)}` : ''}</small>
          </div>
          <button class="btn btn-outline-danger btn-sm" onclick="deleteApifyToken('${escapeAttr(t.id)}')">
            <i data-feather="trash-2" style="width:14px"></i> Xóa
          </button>
        </div>
      </div>
    `).join('');
    feather.replace();
  } catch (err) {
    list.innerHTML = `<span class="text-danger">Lỗi tải token: ${escapeHtml(err.message)}</span>`;
  }
}

async function saveApifyToken() {
  const tokenInput = document.getElementById('apify-token-input');
  const labelInput = document.getElementById('apify-token-label');
  const status = document.getElementById('apify-token-status');
  const tokenVal = tokenInput ? tokenInput.value.trim() : '';
  const labelVal = labelInput ? labelInput.value.trim() : '';

  if (!tokenVal) {
    status.innerHTML = '<span class="text-danger">Vui lòng nhập Apify API token.</span>';
    return;
  }

  status.innerHTML = '<span class="text-muted">Đang lưu token vào pool...</span>';
  try {
    const res = await apiFetch('/api/apify-tokens', {
      method: 'POST',
      body: JSON.stringify({ token: tokenVal, label: labelVal || null })
    });
    tokenInput.value = '';
    if (labelInput) labelInput.value = '';
    status.innerHTML = `<span class="text-success">Đã lưu thành công ${res.count || 1} token vào pool!</span>`;
    await loadApifyTokens();
  } catch (err) {
    status.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
  }
}

async function deleteApifyToken(id) {
  if (!confirm('Bạn có chắc chắn muốn xóa token này khỏi pool không?')) return;
  const status = document.getElementById('apify-token-status');
  try {
    await apiFetch(`/api/apify-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
    status.innerHTML = '<span class="text-success">Đã xóa token khỏi pool.</span>';
    await loadApifyTokens();
  } catch (err) {
    status.innerHTML = `<span class="text-danger">Lỗi xóa token: ${escapeHtml(err.message)}</span>`;
  }
}

function parseTokensFromText(text) {
  if (!text) return [];
  if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => (typeof item === 'string' ? item.trim() : (item.token || ''))).filter(Boolean);
      }
      if (parsed.tokens && Array.isArray(parsed.tokens)) {
        return parsed.tokens.map((item) => (typeof item === 'string' ? item.trim() : (item.token || ''))).filter(Boolean);
      }
    } catch (_e) {}
  }
  return text.split(/[,;\r\n]+/)
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => Boolean(s) && !s.startsWith('#') && !s.startsWith('//'));
}

function updateBulkTokenCountHint() {
  const textarea = document.getElementById('apify-bulk-tokens');
  const hint = document.getElementById('apify-bulk-count-hint');
  if (!textarea || !hint) return;
  const tokens = parseTokensFromText(textarea.value);
  hint.textContent = `${tokens.length} token phát hiện`;
}

function clearBulkApifyInput() {
  const textarea = document.getElementById('apify-bulk-tokens');
  const fileInput = document.getElementById('apify-token-file');
  const fileName = document.getElementById('apify-file-name');
  if (textarea) textarea.value = '';
  if (fileInput) fileInput.value = '';
  if (fileName) fileName.textContent = '';
  updateBulkTokenCountHint();
}

function handleApifyTokenFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const fileNameSpan = document.getElementById('apify-file-name');
  if (fileNameSpan) fileNameSpan.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result || '';
    const textarea = document.getElementById('apify-bulk-tokens');
    if (textarea) {
      textarea.value = (textarea.value ? textarea.value.trim() + '\n' : '') + content.trim();
      updateBulkTokenCountHint();
    }
  };
  reader.readAsText(file);
}

async function saveBulkApifyTokens() {
  const textarea = document.getElementById('apify-bulk-tokens');
  const status = document.getElementById('apify-token-status');
  if (!textarea) return;

  const tokens = parseTokensFromText(textarea.value);
  if (!tokens.length) {
    status.innerHTML = '<span class="text-danger">Không tìm thấy token hợp lệ nào trong ô nhập hoặc file tải lên.</span>';
    return;
  }

  status.innerHTML = `<span class="text-muted">Đang tải lên và lưu ${tokens.length} token vào pool...</span>`;
  try {
    const res = await apiFetch('/api/apify-tokens', {
      method: 'POST',
      body: JSON.stringify({ tokens })
    });
    status.innerHTML = `<span class="text-success">Đã thêm thành công ${res.count || tokens.length} token mới vào pool! (Tổng cộng: ${res.status?.total || 'N/A'} token)</span>`;
    clearBulkApifyInput();
    await loadApifyTokens();
  } catch (err) {
    status.innerHTML = `<span class="text-danger">Lỗi khi thêm hàng loạt: ${escapeHtml(err.message)}</span>`;
  }
}

async function cleanupApifyTokens() {
  if (!confirm('Dọn dẹp và xóa tất cả các token đã cạn kiệt (EXHAUSTED) hoặc không hợp lệ (INVALID) khỏi pool?')) return;
  const status = document.getElementById('apify-token-status');
  status.innerHTML = '<span class="text-muted">Đang dọn dẹp token lỗi...</span>';
  try {
    const res = await apiFetch('/api/apify-tokens/cleanup', { method: 'POST' });
    status.innerHTML = `<span class="text-success">Đã dọn dẹp ${res.removedCount || 0} token lỗi/hết hạn khỏi pool.</span>`;
    await loadApifyTokens();
  } catch (err) {
    status.innerHTML = `<span class="text-danger">Lỗi dọn dẹp: ${escapeHtml(err.message)}</span>`;
  }
}

function toggleCaptureModeUI() {
  const mode = document.getElementById('capture-mode').value;
  const singleWrap = document.getElementById('capture-mode-single-wrap');
  const ujWrap = document.getElementById('capture-mode-uj-wrap');
  if (mode === 'user_journey') {
    singleWrap.classList.add('d-none');
    ujWrap.classList.remove('d-none');
  } else {
    singleWrap.classList.remove('d-none');
    ujWrap.classList.add('d-none');
  }
}

async function showCaptureHtmlModal() {
  document.getElementById('capture-url').value = '';
  document.getElementById('capture-html-status').textContent = '';
  document.getElementById('capture-html-result').innerHTML = '';
  if (document.getElementById('capture-mode')) document.getElementById('capture-mode').value = 'single';
  toggleCaptureModeUI();
  updateCaptureVariantOptions();
  new bootstrap.Modal(document.getElementById('capture-html-modal')).show();
  await loadCaptureAccounts();
  feather.replace();
}

async function runUserJourneyFromCaptureModal() {
  const platform = document.getElementById('capture-platform').value;
  const keyword = document.getElementById('uj-mode-keyword').value.trim();
  const zipCode = document.getElementById('uj-mode-zipcode').value.trim() || '90210';
  const maxProducts = Number(document.getElementById('uj-mode-maxproducts').value) || 5;
  const statusDiv = document.getElementById('capture-html-status');
  const resultDiv = document.getElementById('capture-html-result');
  const btn = document.getElementById('uj-mode-submit');

  if (!keyword) {
    alert('Vui lòng nhập từ khóa tìm kiếm!');
    return;
  }

  btn.disabled = true;
  statusDiv.innerHTML = `<span class="text-warning"><div class="spinner-border spinner-border-sm me-1" role="status"></div>Đang chạy Kịch bản User Journey (${platform.toUpperCase()})...</span>`;
  resultDiv.innerHTML = `<div class="p-3 bg-light border rounded small">
    <div class="fw-bold mb-2">Tiến trình User Journey Execution:</div>
    <ul class="mb-0 text-muted ps-3" style="font-size:12px;">
      <li>1. Mở phiên Stealth Browser -> Điều hướng trang chủ ${platform.toUpperCase()}</li>
      <li>2. Thiết lập mã ZIP/Location (${zipCode})</li>
      <li>3. Nhập từ khóa '${escapeHtml(keyword)}' -> Bấm Search &amp; Filter</li>
      <li>4. Quét sản phẩm -> Mở Tab Chi tiết -> Click đổi Biến thể -> Chụp HTML Snapshots</li>
    </ul>
  </div>`;

  try {
    const summary = await apiFetch('/api/user-journey/run', {
      method: 'POST',
      body: JSON.stringify({
        platform,
        keyword,
        zipCode,
        maxProducts
      })
    });

    const isSuccess = summary.status === 'COMPLETED';
    statusDiv.innerHTML = `<span class="text-success"><i data-feather="check-circle" style="width:14px"></i> Phiên User Journey hoàn tất!</span>`;
    resultDiv.innerHTML = `<div class="border rounded bg-light p-3 small">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <strong class="text-success">User Journey Session: ${escapeHtml(summary.sessionId)}</strong>
        <span class="badge ${isSuccess ? 'bg-success' : 'bg-warning text-dark'}">${escapeHtml(summary.status)}</span>
      </div>
      <div class="mb-1"><strong>Nền tảng:</strong> ${platform.toUpperCase()} | <strong>Từ khóa:</strong> ${escapeHtml(keyword)} | <strong>ZIP:</strong> ${zipCode}</div>
      <div class="mb-1"><strong>File HTML Checkpoints đã chụp:</strong> ${summary.checkpointsCount} file HTML</div>
      <div class="mb-2"><strong>Số sản phẩm bóc tách lưu vào DB:</strong> ${summary.productsCollectedCount} sản phẩm</div>
      <div class="d-flex gap-2 mt-2">
        <button class="btn btn-outline-primary btn-sm" onclick="loadData(); loadJobs();">
          <i data-feather="refresh-cw" style="width:14px"></i> Tải lại danh sách sản phẩm
        </button>
        <button class="btn btn-success btn-sm" onclick="exportAll()">
          <i data-feather="download" style="width:14px"></i> Xuất file Excel/CSV
        </button>
      </div>
    </div>`;

    feather.replace();
    await loadData();
    await loadJobs();
  } catch (err) {
    statusDiv.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

async function showSavedCapturesModal() {
  const list = document.getElementById('saved-captures-list');
  list.textContent = 'Loading...';
  new bootstrap.Modal(document.getElementById('saved-captures-modal')).show();
  try {
    const captures = await apiFetch('/api/html-captures?limit=100');
    const successfulCaptures = captures.filter((capture) => capture.parsedData?.capture?.status === 'ok');
    if (!successfulCaptures.length) {
      list.innerHTML = '<div class="text-muted py-3">No successful captures saved yet.</div>';
      return;
    }
    const rows = successfulCaptures.map((capture) => {
      const metrics = capture.parsedData?.metrics || {};
      const title = metrics.title || 'Untitled product';
      const mode = capture.variant_mode === 'all' ? `All variants (${Number(capture.max_variants)})` : 'Base product';
      return `<tr><td>${escapeHtml(capture.platform)}</td><td><strong>${escapeHtml(title)}</strong><br><a href="${escapeAttr(capture.url)}" target="_blank" rel="noreferrer" class="text-muted text-break">${escapeHtml(capture.url)}</a></td><td>${escapeHtml(mode)}</td><td>${escapeHtml(parseServerTimestamp(capture.created_at).toLocaleString())}</td><td><button class="btn btn-outline-primary btn-sm" onclick="window.open('/api/html-captures/${Number(capture.id)}', '_blank')">Open data</button></td></tr>`;
    }).join('');
    list.innerHTML = `<div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead><tr><th>Platform</th><th>Product</th><th>Capture</th><th>Saved</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (err) {
    list.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
  }
  finally { feather.replace(); }
}

function onSchedulePlatformChange() {
  const platform = document.getElementById('marketplace-schedule-platform').value;
  const isEtsy = platform === 'etsy';
  const accountWrap = document.getElementById('marketplace-schedule-account-wrap');
  const variantWrap = document.getElementById('marketplace-schedule-variant-wrap');
  const maxVariantsWrap = document.getElementById('marketplace-schedule-max-variants-wrap');
  
  if (accountWrap) accountWrap.classList.toggle('d-none', !isEtsy);
  if (variantWrap) variantWrap.classList.toggle('d-none', !isEtsy);
  if (maxVariantsWrap) {
    const isAll = isEtsy && document.getElementById('marketplace-schedule-variant-mode')?.value === 'all';
    maxVariantsWrap.classList.toggle('d-none', !isAll);
  }

  const keywordLabel = document.getElementById('marketplace-schedule-keyword-label');
  const keywordInput = document.getElementById('marketplace-schedule-keyword');
  if (platform === 'shopify') {
    keywordLabel.textContent = 'Store Domain / URL hoặc Từ khóa';
    keywordInput.placeholder = 'e.g. colourpop.com hoặc gymshark.com';
  } else {
    keywordLabel.textContent = 'Từ khóa tìm kiếm (Keyword / Query)';
    keywordInput.placeholder = 'e.g. vintage hoodie, custom mug, shoes...';
  }
}

function updateScheduleVariantControls() {
  const isEtsy = document.getElementById('marketplace-schedule-platform').value === 'etsy';
  const mode = document.getElementById('marketplace-schedule-variant-mode').value;
  const maxVariantsWrap = document.getElementById('marketplace-schedule-max-variants-wrap');
  if (maxVariantsWrap) {
    maxVariantsWrap.classList.toggle('d-none', !isEtsy || mode !== 'all');
  }
}

async function showMarketplaceSchedulesModal() {
  document.getElementById('marketplace-schedule-keyword').value = '';
  document.getElementById('marketplace-schedule-status').textContent = '';
  document.getElementById('marketplace-schedule-max-items').value = '30';
  updateMarketplaceScheduleTimeFields();
  onSchedulePlatformChange();
  new bootstrap.Modal(document.getElementById('marketplace-schedules-modal')).show();
  
  const accountSelect = document.getElementById('marketplace-schedule-account');
  if (accountSelect) {
    accountSelect.innerHTML = '<option value="">Public / no login</option>';
    try {
      for (const account of await apiFetch('/api/marketplace-accounts?platform=etsy')) {
        accountSelect.add(new Option(account.label, account.id));
      }
    } catch (err) { console.error('Could not load Etsy accounts:', err); }
  }

  await loadMarketplaceSchedules();
  feather.replace();
}

function updateMarketplaceScheduleTimeFields() {
  const type = document.getElementById('marketplace-schedule-type').value;
  const daily = type === 'daily';
  const once = type === 'once';
  document.getElementById('marketplace-schedule-hours-wrap').classList.toggle('d-none', daily || once);
  document.getElementById('marketplace-schedule-time-wrap').classList.toggle('d-none', !daily);
  document.getElementById('marketplace-schedule-once-wrap').classList.toggle('d-none', !once);
}

async function saveMarketplaceSchedule() {
  const status = document.getElementById('marketplace-schedule-status');
  const platform = document.getElementById('marketplace-schedule-platform').value;
  const keyword = document.getElementById('marketplace-schedule-keyword').value.trim();
  const maxItems = Number(document.getElementById('marketplace-schedule-max-items').value) || 30;
  const accountId = document.getElementById('marketplace-schedule-account')?.value || null;
  const everyHours = Number(document.getElementById('marketplace-schedule-every-hours').value) || 3;
  const scheduleType = document.getElementById('marketplace-schedule-type').value;
  const dailyTime = document.getElementById('marketplace-schedule-daily-time').value;
  const runAt = document.getElementById('marketplace-schedule-once-datetime').value;
  const variantMode = platform === 'etsy' ? (document.getElementById('marketplace-schedule-variant-mode')?.value || 'base') : 'base';
  const maxVariants = Number(document.getElementById('marketplace-schedule-max-variants')?.value) || 150;

  if (!keyword) {
    status.innerHTML = '<span class="text-danger">Vui lòng nhập từ khóa tìm kiếm.</span>';
    return;
  }

  try {
    await apiFetch('/api/marketplace-capture-schedules', {
      method: 'POST',
      body: JSON.stringify({
        platform,
        keyword,
        maxItems,
        maxListings: maxItems,
        accountId: platform === 'etsy' ? accountId : null,
        everyHours,
        scheduleType,
        dailyTime,
        runAt,
        variantMode,
        maxVariants
      })
    });
    status.innerHTML = '<span class="text-success fw-bold">✓ Đã lưu lịch crawl thành công!</span>';
    document.getElementById('marketplace-schedule-keyword').value = '';
    await loadMarketplaceSchedules();
  } catch (err) {
    status.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
  }
}

async function toggleMarketplaceSchedule(id) {
  try {
    await apiFetch(`/api/marketplace-capture-schedules/${Number(id)}/toggle`, { method: 'POST' });
    await loadMarketplaceSchedules();
  } catch (err) {
    alert(`Không thể đổi trạng thái lịch: ${err.message}`);
  }
}

async function runMarketplaceScheduleNow(id) {
  if (!confirm('Bạn có muốn kích hoạt cào ngay theo lịch này không?')) return;
  try {
    await apiFetch(`/api/marketplace-capture-schedules/${Number(id)}/run-now`, { method: 'POST' });
    alert('Đã gửi lệnh cào vào bộ điều phối ResourceScheduler thành công!');
    await loadMarketplaceSchedules();
  } catch (err) {
    alert(`Không thể kích hoạt lịch cào: ${err.message}`);
  }
}

async function loadMarketplaceSchedules() {
  const list = document.getElementById('marketplace-schedules-list');
  try {
    const schedules = await apiFetch('/api/marketplace-capture-schedules');
    if (!schedules.length) {
      list.innerHTML = '<div class="alert alert-light border text-muted py-2 mb-0">Chưa có lịch crawl nào được thiết lập. Hãy tạo lịch mới ở trên!</div>';
      return;
    }

    const platformLabels = {
      amazon: '📦 Amazon',
      ebay: '🏷️ eBay Sold',
      etsy: '🧶 Etsy',
      shopify: '🛍️ Shopify',
      tiktok_shop: '🎵 TikTok Shop',
      google_shopping: '🛒 Google Shopping',
      facebook_ads: '📢 Facebook Ads',
      facebook_posts: '👥 Facebook Posts',
      instagram: '📷 Instagram',
      pinterest: '📌 Pinterest',
      reddit: '🔴 Reddit',
      twitter: '🐦 X / Twitter'
    };

    list.innerHTML = schedules.map((schedule) => {
      const timing = schedule.schedule_type === 'daily'
        ? `Hàng ngày lúc ${schedule.daily_time} (VN)`
        : schedule.schedule_type === 'once'
          ? `Chạy 1 lần lúc ${schedule.run_at} (VN)`
          : `Lặp lại mỗi ${Number(schedule.every_minutes) / 60} giờ`;
      
      const isEnabled = Boolean(schedule.enabled);
      const statusBadge = isEnabled
        ? '<span class="badge bg-success">ĐANG CHẠY</span>'
        : '<span class="badge bg-secondary">TẠM DỪNG</span>';

      const next = isEnabled
        ? `Lần chạy kế tiếp: ${parseServerTimestamp(schedule.next_run_at).toLocaleString()}`
        : 'Lịch đang tạm dừng';

      const latest = schedule.last_run_at
        ? `Lần chạy gần nhất (${parseServerTimestamp(schedule.last_run_at).toLocaleString()}): ${formatMarketplaceScheduleSummary(schedule.last_summary)}`
        : 'Chưa có lượt chạy nào.';

      const id = Number(schedule.id);
      const platformDisplay = platformLabels[schedule.platform] || schedule.platform.toUpperCase();

      return `<div class="card border mb-2 shadow-sm">
        <div class="card-body p-3">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div>
              <div class="d-flex align-items-center gap-2 mb-1">
                <span class="badge bg-primary px-2 py-1">${escapeHtml(platformDisplay)}</span>
                <strong class="text-dark fs-6">${escapeHtml(schedule.keyword)}</strong>
                ${statusBadge}
              </div>
              <div class="text-muted small">
                <span>Số lượng: <strong>${schedule.max_listings || 30} items</strong></span> · 
                <span>${escapeHtml(timing)}</span> · 
                <span class="text-primary">${escapeHtml(next)}</span>
              </div>
              <div class="text-muted small mt-1">
                <i data-feather="activity" style="width:12px" class="me-1"></i>${escapeHtml(latest)}
              </div>
            </div>
            <div class="d-flex gap-1 align-items-center">
              <button class="btn btn-sm btn-outline-success" title="Chạy ngay" onclick="runMarketplaceScheduleNow(${id})">
                <i data-feather="zap" style="width:13px"></i> Chạy ngay
              </button>
              <button class="btn btn-sm ${isEnabled ? 'btn-outline-warning' : 'btn-outline-primary'}" onclick="toggleMarketplaceSchedule(${id})">
                ${isEnabled ? 'Tạm dừng' : 'Kích hoạt'}
              </button>
              <button class="btn btn-sm btn-outline-secondary" onclick="toggleMarketplaceScheduleRunHistory(${id})">
                Lịch sử
              </button>
              <button class="btn btn-sm btn-outline-danger" title="Xóa lịch" onclick="deleteMarketplaceSchedule(${id})">
                <i data-feather="trash-2" style="width:13px"></i>
              </button>
            </div>
          </div>
          <div id="marketplace-schedule-run-history-${id}" class="d-none mt-3 pt-2 border-top"></div>
        </div>
      </div>`;
    }).join('');

    feather.replace();
  } catch (err) {
    list.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
  }
}

function formatMarketplaceScheduleSummary(summary) {
  if (!summary) return 'Chưa có tóm tắt kết quả.';
  const result = `Tìm thấy ${Number(summary.discovered) || 0} items, Đã lưu ${Number(summary.captured) || 0} items`;
  return summary.error ? `${result} (Lỗi: ${summary.error})` : result;
}

async function toggleMarketplaceScheduleRunHistory(id) {
  const panel = document.getElementById(`marketplace-schedule-run-history-${Number(id)}`);
  if (!panel) return;
  if (!panel.classList.contains('d-none')) {
    panel.classList.add('d-none');
    return;
  }
  panel.classList.remove('d-none');
  panel.textContent = 'Đang tải lịch sử chạy...';
  try {
    const runs = await apiFetch(`/api/marketplace-capture-schedules/${Number(id)}/runs`);
    panel.innerHTML = runs.length ? `<div class="table-responsive"><table class="table table-sm table-bordered mb-0"><thead><tr class="table-light"><th>Thời Gian Hoàn Tất</th><th>Tìm Thấy</th><th>Đã Lưu</th><th>Thất Bại</th><th>Chi Tiết</th></tr></thead><tbody>${runs.map((run) => `<tr><td>${escapeHtml(parseServerTimestamp(run.completed_at).toLocaleString())}</td><td>${Number(run.summary?.discovered) || 0}</td><td>${Number(run.summary?.captured) || 0}</td><td>${Number(run.summary?.failed) || 0}</td><td>${escapeHtml(run.summary?.error || 'Thành công')}</td></tr>`).join('')}</tbody></table></div>` : '<span class="text-muted">Chưa có lượt chạy nào hoàn tất.</span>';
  } catch (err) {
    panel.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
  }
}

async function deleteMarketplaceSchedule(id) {
  if (!confirm('Bạn có chắc chắn muốn xóa lịch crawl này không?')) return;
  try {
    await apiFetch(`/api/marketplace-capture-schedules/${Number(id)}`, { method: 'DELETE' });
    await loadMarketplaceSchedules();
  } catch (err) {
    alert(`Không thể xóa lịch: ${err.message}`);
  }
}

function updateCaptureVariantOptions() {
  const isEtsy = document.getElementById('capture-platform').value === 'etsy';
  const controls = document.getElementById('capture-variant-controls');
  const mode = document.getElementById('capture-variant-mode');
  const maxVariants = document.getElementById('capture-max-variants');
  controls.classList.toggle('d-none', !isEtsy);
  mode.disabled = !isEtsy;
  maxVariants.disabled = !isEtsy || mode.value !== 'all';
  if (!isEtsy) mode.value = 'base';
}

function renderCapturedVariants(variants, variantMeta) {
  if (!variants?.length) {
    return '<div class="mt-2 text-warning">No selectable Etsy dropdown prices were captured. Open the saved data to verify the page was not blocked or changed.</div>';
  }
  const rows = variants.map((variant) => {
    const selections = (variant.selections || []).map((selection) => `${selection.label}: ${selection.text}`).join(' · ');
    const price = variant.price;
    const sale = price?.salePrice ? `${price.salePrice} ${price.currency || ''}` : 'Not available';
    const original = price?.originalPrice ? `${price.originalPrice} ${price.currency || ''}` : '—';
    return `<tr><td>${escapeHtml(selections || 'Default')}</td><td>${escapeHtml(sale)}</td><td>${escapeHtml(original)}</td><td>${variant.available === false ? 'Unavailable' : 'Available'}</td></tr>`;
  }).join('');
  return `<div class="mt-3"><strong>Variant prices${variantMeta?.truncated ? ' (limited)' : ''}</strong><div class="table-responsive"><table class="table table-sm mt-2 mb-0"><thead><tr><th>Dropdown selection</th><th>Sale price</th><th>Original price</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

async function loadCaptureAccounts() {
  const platform = document.getElementById('capture-platform').value;
  const select = document.getElementById('capture-account');
  select.innerHTML = '<option value="">Public / no login</option>';
  try {
    const accounts = await apiFetch(`/api/marketplace-accounts?platform=${encodeURIComponent(platform)}`);
    for (const account of accounts) {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.label;
      select.appendChild(option);
    }
  } catch (err) { console.error('Could not load marketplace accounts:', err); }
}

async function captureMarketplaceHtml() {
  const platform = document.getElementById('capture-platform').value;
  const url = document.getElementById('capture-url').value.trim();
  const accountId = document.getElementById('capture-account').value;
  const variantMode = document.getElementById('capture-variant-mode').value;
  const maxVariants = Number(document.getElementById('capture-max-variants').value);
  const status = document.getElementById('capture-html-status');
  const resultElement = document.getElementById('capture-html-result');
  const submitButton = document.getElementById('capture-html-submit');
  status.innerHTML = `<span class="text-muted">${variantMode === 'all' ? 'Capturing each Etsy variant…' : 'Capturing rendered HTML…'}</span>`;
  resultElement.innerHTML = '';
  submitButton.disabled = true;
  try {
    const response = await apiFetch('/api/html-captures', { method: 'POST', body: JSON.stringify({ platform, url, accountId: accountId || null, variantMode, maxVariants }) });
    const result = response.job
      ? await waitForCaptureJob(response.job.id, status)
      : response;
    status.innerHTML = `<span class="text-success">${result.cached ? 'Loaded saved capture.' : 'Capture saved and parsed.'}</span>`;
    const metrics = result.metrics;
    const captureStatus = result.captureStatus || { status: 'ok' };
    const statusClass = captureStatus.status === 'blocked' ? 'text-danger' : 'text-success';
    const statusText = captureStatus.status === 'blocked'
      ? 'Possible anti-bot / CAPTCHA page — do not use this snapshot as product data.'
      : 'Product page captured successfully.';
    const openCaptureButton = result.capture
      ? `<button class="btn btn-outline-primary btn-sm" onclick="window.open('/api/html-captures/${Number(result.capture.id)}', '_blank')">Open HTML + data</button>`
      : '';
    resultElement.innerHTML = `<div class="border rounded bg-light p-3 small">
      <div class="d-flex justify-content-between gap-2"><strong>${escapeHtml(metrics.title || 'Untitled product')}</strong>${openCaptureButton}</div>
      <div class="${statusClass} mt-2">${escapeHtml(statusText)}</div>
      <div class="mt-2">Price: ${escapeHtml(String(metrics.price || 0))} ${escapeHtml(metrics.currency || '')}${metrics.priceMax ? ` (range ${escapeHtml(String(metrics.priceMin))}–${escapeHtml(String(metrics.priceMax))})` : ''} · Rating: ${escapeHtml(String(metrics.rating || 0))} · Reviews: ${escapeHtml(String(metrics.reviewCount || 0))}</div>
      <div>Availability: ${escapeHtml(metrics.availability || 'unknown')} · Listing: ${escapeHtml(metrics.listingId || '—')}</div>
      ${variantMode === 'all' ? renderCapturedVariants(result.variants, captureStatus.variantMeta) : ''}
    </div>`;
  } catch (err) { status.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`; }
  finally { submitButton.disabled = false; }
}

// ==================== User Journey Modal UI ====================

function showUserJourneyModal() {
  new bootstrap.Modal(document.getElementById('user-journey-modal')).show();
}

async function startUserJourneyRun() {
  const platform = document.getElementById('uj-platform').value;
  const keyword = document.getElementById('uj-keyword').value.trim();
  const zipCode = document.getElementById('uj-zipcode').value.trim() || '90210';
  const maxProducts = Number(document.getElementById('uj-maxproducts').value) || 5;
  const freeShipping = document.getElementById('uj-freeshipping').value === 'true';
  const statusDiv = document.getElementById('uj-status');
  const btn = document.getElementById('uj-start-btn');

  if (!keyword) {
    alert('Vui lòng nhập từ khóa tìm kiếm!');
    return;
  }

  btn.disabled = true;
  statusDiv.innerHTML = `<div class="p-3 bg-light border rounded small">
    <div class="d-flex align-items-center gap-2 mb-2 text-warning">
      <div class="spinner-border spinner-border-sm" role="status"></div>
      <strong>Đang thực thi Kịch bản User Journey (${platform.toUpperCase()})...</strong>
    </div>
    <ul class="mb-0 text-muted ps-3" style="font-size:12px;">
      <li>J1: Mở phiên Stealth Browser -> Điều hướng trang chủ ${platform.toUpperCase()}</li>
      <li>J2: Cài đặt mã ZIP/Location (${zipCode})</li>
      <li>J3-J4: Gõ từ khóa '${escapeHtml(keyword)}' -> Lọc điều kiện</li>
      <li>J5-J7: Mở các sản phẩm -> Tương tác biến thể -> Chụp HTML Snapshots</li>
    </ul>
  </div>`;

  try {
    const summary = await apiFetch('/api/user-journey/run', {
      method: 'POST',
      body: JSON.stringify({
        platform,
        keyword,
        zipCode,
        maxProducts,
        filters: { freeShipping }
      })
    });

    const isSuccess = summary.status === 'COMPLETED';
    const statusBadge = isSuccess
      ? `<span class="badge bg-success">COMPLETED</span>`
      : `<span class="badge bg-warning text-dark">${escapeHtml(summary.status)}</span>`;

    statusDiv.innerHTML = `<div class="p-3 bg-light border rounded small">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <strong class="text-success"><i data-feather="check-circle" class="me-1"></i>Phiên User Journey hoàn tất!</strong>
        ${statusBadge}
      </div>
      <div class="mb-1"><strong>Session ID:</strong> <code>${escapeHtml(summary.sessionId)}</code></div>
      <div class="mb-1"><strong>Số lượng HTML Checkpoints đã chụp:</strong> ${summary.checkpointsCount} file HTML</div>
      <div class="mb-2"><strong>Số lượng sản phẩm trích xuất vào DB:</strong> ${summary.productsCollectedCount} sản phẩm</div>
      <div class="d-flex gap-2 mt-2">
        <button class="btn btn-sm btn-outline-primary" onclick="loadData(); loadJobs();">
          <i data-feather="refresh-cw" class="me-1"></i>Tải lại danh sách sản phẩm
        </button>
        <button class="btn btn-sm btn-success" onclick="exportAll()">
          <i data-feather="download" class="me-1"></i>Xuất file Excel/CSV
        </button>
      </div>
    </div>`;

    feather.replace();
    await loadData();
    await loadJobs();
  } catch (err) {
    statusDiv.innerHTML = `<div class="p-3 bg-light border rounded text-danger small">
      <strong><i data-feather="alert-triangle" class="me-1"></i>Phiên User Journey có thông báo:</strong> ${escapeHtml(err.message)}
    </div>`;
    feather.replace();
  } finally {
    btn.disabled = false;
  }
}

async function waitForCaptureJob(jobId, statusElement) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const job = await apiFetch(`/api/html-capture-jobs/${encodeURIComponent(jobId)}`);
    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') throw new Error(job.error || 'Capture failed');
    statusElement.innerHTML = '<span class="text-muted">Capturing each Etsy variant… this can take a few minutes. You can keep this dialog open while it finishes.</span>';
  }
}

// ==================== Product Deletion Handlers ====================

async function deleteSingleItem(event, itemUid) {
  if (event) event.stopPropagation();
  if (!confirm('Bạn có chắc chắn muốn xóa sản phẩm này khỏi cơ sở dữ liệu?')) return;
  try {
    await apiFetch(`/api/items/${encodeURIComponent(itemUid)}`, { method: 'DELETE' });
    await loadData();
    await loadJobs();
  } catch (err) {
    alert('Xóa sản phẩm thất bại: ' + err.message);
  }
}

async function deleteFromModal(itemUid) {
  if (!confirm('Bạn có chắc chắn muốn xóa sản phẩm này khỏi cơ sở dữ liệu?')) return;
  try {
    await apiFetch(`/api/items/${encodeURIComponent(itemUid)}`, { method: 'DELETE' });
    const modalEl = document.getElementById('item-modal');
    const modalInstance = bootstrap.Modal.getInstance(modalEl);
    if (modalInstance) modalInstance.hide();
    await loadData();
    await loadJobs();
  } catch (err) {
    alert('Xóa sản phẩm thất bại: ' + err.message);
  }
}

async function deleteAllProducts() {
  const p = currentFilter === 'all' ? '' : `?platform=${currentFilter}`;
  const msg = currentFilter === 'all'
    ? 'Bạn có chắc chắn muốn xóa TOÀN BỘ sản phẩm đã cào không?'
    : `Bạn có chắc chắn muốn xóa tất cả sản phẩm của ${currentFilter.toUpperCase()} không?`;
  if (!confirm(msg)) return;
  try {
    await apiFetch(`/api/items${p}`, { method: 'DELETE' });
    await loadData();
    await loadJobs();
  } catch (err) {
    alert('Xóa toàn bộ sản phẩm thất bại: ' + err.message);
  }
}

