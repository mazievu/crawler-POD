/**
 * Apify Collector — Product Intelligence (Ad Lifecycle Tracking)
 * Shows: active/inactive status, growth, timeline comparison.
 */

let allPlatforms = [];
let allItems = [];
let allCapabilities = [];
let activeFilter = 'all';
let collectPlatform = null;
let toidispyFilterConfig = [];

document.addEventListener('DOMContentLoaded', async () => {
  feather.replace();
  await loadData();
  setupSearch();
});

// ==================== Data Loading ====================

async function loadData() {
  try {
    const [platforms, items, capabilities] = await Promise.all([
      apiFetch('/api/platforms'),
      apiFetch('/api/items'),
      apiFetch('/api/capabilities'),
    ]);
    allPlatforms = platforms;
    allItems = items;
    allCapabilities = capabilities;

    const counts = {};
    for (const item of allItems) {
      counts[item.platform] = (counts[item.platform] || 0) + 1;
    }
    renderFilterPills(platforms, counts);
    document.getElementById('stat-total').textContent = `${allItems.length} items`;
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
      ${p.icon} ${p.display_name} <span class="pill-count">${c}</span>
    </button>`;
  }
  container.innerHTML = html;
}

function filterByPlatform(platform, el) {
  activeFilter = platform;
  document.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
  el.classList.add('active');
  applyFilters();
}

function setupSearch() {
  const input = document.getElementById('search-input');
  let debounce;
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(applyFilters, 200); });
}

function applyFilters() {
  const query = document.getElementById('search-input').value.toLowerCase().trim();
  const sort = document.getElementById('sort-select').value;
  let filtered = allItems;

  if (activeFilter !== 'all') filtered = filtered.filter((i) => i.platform === activeFilter);
  if (query) filtered = filtered.filter((i) =>
    (i.title || '').toLowerCase().includes(query) ||
    (i.author || '').toLowerCase().includes(query) ||
    i.platform.toLowerCase().includes(query)
  );

  switch (sort) {
    case 'likes-desc': filtered.sort((a, b) => b.likes - a.likes); break;
    case 'comments-desc': filtered.sort((a, b) => b.comments - a.comments); break;
    case 'shares-desc': filtered.sort((a, b) => b.shares - a.shares); break;
    case 'price-asc': filtered.sort((a, b) => a.price - b.price); break;
    case 'price-desc': filtered.sort((a, b) => b.price - a.price); break;
    case 'growth': filtered.sort((a, b) => ((b.growth?.likes || 0) + (b.growth?.comments || 0)) - ((a.growth?.likes || 0) + (a.growth?.comments || 0))); break;
    default: filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); break;
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
    const platformLabel = config?.display_name || item.platform;

    // Status badge
    const statusBadge = getStatusBadge(item.status);

    // Growth indicators
    const growthHtml = renderGrowth(item.growth);

    return `
      <div class="item-card" onclick="showItemDetail('${escapeAttr(item.item_uid)}')">
        <div class="item-img">
          ${item.image
            ? `<img src="${escapeAttr(item.image)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='<div class=no-image>${icon}</div>'">`
            : `<div class="no-image">${icon}</div>`
          }
          <span class="platform-tag ${tagClass}">${platformLabel}</span>
          ${statusBadge}
        </div>
        <div class="item-body">
          <div class="item-title" title="${escapeAttr(item.title)}">${escapeHtml(item.title) || '<em>No title</em>'}</div>
          ${item.author ? `<div class="item-source">${escapeHtml(item.author)}</div>` : ''}
          ${item.price > 0 ? `<div class="item-price">$${item.price.toFixed(2)}</div>` : ''}
        </div>
        <div class="item-engagement">
          <div class="engagement-stat liked"><i data-feather="heart"></i><span class="eng-val">${formatNum(item.likes)}</span>${growthHtml.likes}</div>
          <div class="engagement-stat commented"><i data-feather="message-circle"></i><span class="eng-val">${formatNum(item.comments)}</span>${growthHtml.comments}</div>
          <div class="engagement-stat shared"><i data-feather="share-2"></i><span class="eng-val">${formatNum(item.shares)}</span>${growthHtml.shares}</div>
          ${item.views > 0 ? `<div class="engagement-stat"><i data-feather="eye"></i><span class="eng-val">${formatNum(item.views)}</span></div>` : ''}
        </div>
      </div>`;
  }).join('');
  feather.replace();
}

function getStatusBadge(status) {
  switch (status) {
    case 'active': return '<span class="ad-tag active-tag">ACTIVE</span>';
    case 'new': return '<span class="ad-tag new-tag">NEW</span>';
    case 'dropped': return '<span class="ad-tag dropped-tag">STOPPED</span>';
    default: return '';
  }
}

function renderGrowth(growth) {
  if (!growth) return { likes: '', comments: '', shares: '' };
  return {
    likes: growth.likes > 0 ? `<span class="growth-up">+${growth.likes}</span>` : growth.likes < 0 ? `<span class="growth-down">${growth.likes}</span>` : '',
    comments: growth.comments > 0 ? `<span class="growth-up">+${growth.comments}</span>` : growth.comments < 0 ? `<span class="growth-down">${growth.comments}</span>` : '',
    shares: growth.shares > 0 ? `<span class="growth-up">+${growth.shares}</span>` : growth.shares < 0 ? `<span class="growth-down">${growth.shares}</span>` : '',
  };
}

// ==================== Item Detail + Timeline ====================

async function showItemDetail(itemUid) {
  try {
    const history = await apiFetch(`/api/items/${encodeURIComponent(itemUid)}/history`);
    if (!history.length) return;

    const latest = history[history.length - 1];
    const config = allPlatforms.find((p) => p.name === latest.platform);

    document.getElementById('item-modal-title').innerHTML = `
      ${config?.icon || '🔗'} ${escapeHtml(latest.title || 'Untitled')}
      ${getStatusBadge(latest.status)}
    `;

    // Timeline chart data
    const timelineHtml = renderTimeline(history);
    const statsHtml = renderHistoryStats(history);

    document.getElementById('item-modal-body').innerHTML = `
      <div class="row g-3">
        ${latest.image ? `<div class="col-md-5"><img src="${escapeAttr(latest.image)}" class="w-100 rounded" style="max-height:300px;object-fit:cover"></div>` : ''}
        <div class="${latest.image ? 'col-md-7' : 'col-12'}">
          <div class="mb-2">
            <span class="badge bg-primary me-1">${config?.display_name || latest.platform}</span>
            ${latest.author ? `<span class="badge bg-light text-dark">${escapeHtml(latest.author)}</span>` : ''}
            ${getStatusBadge(latest.status)}
          </div>
          <h6 class="fw-bold">${escapeHtml(latest.title)}</h6>
          ${latest.price > 0 ? `<p class="fs-4 fw-bold text-success mb-2">$${latest.price.toFixed(2)}</p>` : ''}
          ${latest.url ? `<a href="${escapeAttr(latest.url)}" target="_blank" class="btn btn-outline-primary btn-sm mb-3">View Source →</a>` : ''}
        </div>
      </div>
      <hr>
      <h6 class="fw-bold mb-2">📊 Engagement Over Time</h6>
      ${statsHtml}
      <div class="timeline-chart mb-3">${timelineHtml}</div>
      <hr>
      <h6 class="fw-bold mb-2">History (${history.length} snapshots)</h6>
      <div class="table-responsive">
        <table class="table table-sm fs-13">
          <thead><tr><th>Date</th><th>Status</th><th>❤️ Likes</th><th>💬 Comments</th><th>🔄 Shares</th><th>👁️ Views</th><th>Growth</th></tr></thead>
          <tbody>${history.map((h, i) => {
            const prev = i > 0 ? history[i - 1] : null;
            const g = prev ? { l: h.likes - prev.likes, c: h.comments - prev.comments, s: h.shares - prev.shares } : null;
            return `<tr>
              <td>${new Date(h.run_date || h.created_at).toLocaleDateString()}</td>
              <td>${getStatusBadge(h.status)}</td>
              <td>${h.likes}</td><td>${h.comments}</td><td>${h.shares}</td><td>${h.views}</td>
              <td>${g ? `<span class="${(g.l + g.c + g.s) > 0 ? 'text-success' : (g.l + g.c + g.s) < 0 ? 'text-danger' : 'text-muted'}">${g.l > 0 ? '+' : ''}${g.l} / ${g.c > 0 ? '+' : ''}${g.c} / ${g.s > 0 ? '+' : ''}${g.s}</span>` : '—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    `;

    const modal = new bootstrap.Modal(document.getElementById('item-modal'));
    modal.show();
  } catch (err) { console.error('Detail failed:', err); }
}

function renderHistoryStats(history) {
  if (history.length < 2) return '<p class="text-muted fs-13 mb-3">First snapshot — compare after next collection run.</p>';
  const first = history[0];
  const last = history[history.length - 1];
  const totalGrowth = {
    likes: last.likes - first.likes,
    comments: last.comments - first.comments,
    shares: last.shares - first.shares,
    views: last.views - first.views,
  };
  const days = Math.max(1, Math.round((new Date(last.run_date || last.created_at) - new Date(first.run_date || first.created_at)) / 86400000));

  return `<div class="row g-2 mb-3">
    <div class="col-3"><div class="info-card"><div class="label">First Seen</div><div class="value fs-13">${new Date(first.run_date || first.created_at).toLocaleDateString()}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">Last Seen</div><div class="value fs-13">${new Date(last.run_date || last.created_at).toLocaleDateString()}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">Days Tracked</div><div class="value">${days}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">Snapshots</div><div class="value">${history.length}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">❤️ Growth</div><div class="value ${totalGrowth.likes > 0 ? 'text-success' : totalGrowth.likes < 0 ? 'text-danger' : ''}">${totalGrowth.likes > 0 ? '+' : ''}${totalGrowth.likes}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">💬 Growth</div><div class="value ${totalGrowth.comments > 0 ? 'text-success' : totalGrowth.comments < 0 ? 'text-danger' : ''}">${totalGrowth.comments > 0 ? '+' : ''}${totalGrowth.comments}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">🔄 Growth</div><div class="value ${totalGrowth.shares > 0 ? 'text-success' : totalGrowth.shares < 0 ? 'text-danger' : ''}">${totalGrowth.shares > 0 ? '+' : ''}${totalGrowth.shares}</div></div></div>
    <div class="col-3"><div class="info-card"><div class="label">📈 Avg/Day</div><div class="value">${((totalGrowth.likes + totalGrowth.comments + totalGrowth.shares) / days).toFixed(1)}</div></div></div>
  </div>`;
}

function renderTimeline(history) {
  if (history.length < 2) return '<p class="text-muted fs-13">Run collection again to see engagement trend chart.</p>';

  const maxVal = Math.max(...history.map((h) => Math.max(h.likes, h.comments, h.shares)), 1);
  const barWidth = Math.max(100 / history.length, 5);

  return `<div style="display:flex;align-items:flex-end;gap:2px;height:80px;padding:8px 0">
    ${history.map((h, i) => {
      const hL = (h.likes / maxVal) * 100;
      const hC = (h.comments / maxVal) * 100;
      const hS = (h.shares / maxVal) * 100;
      const date = new Date(h.run_date || h.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric' });
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

// ==================== Collect ====================

async function showCollectModal() {
  if (!allPlatforms.length) await loadData();
  collectPlatform = null;
  renderPlatformGrid();
  document.getElementById('collect-query').value = '';
  document.getElementById('collect-hint').textContent = '';
  document.getElementById('collect-route').classList.add('d-none');
  document.getElementById('collect-route').innerHTML = '';
  document.getElementById('toidispy-section').value = 'posts';
  document.getElementById('toidispy-collect-options').classList.add('d-none');
  document.getElementById('toidispy-filter-grid').innerHTML = '';
  document.getElementById('collect-start').disabled = true;
  document.getElementById('collect-status').innerHTML = '';
  new bootstrap.Modal(document.getElementById('collect-modal')).show();
}

function renderPlatformGrid() {
  document.getElementById('platform-grid').innerHTML = allPlatforms.map((p) =>
    `<div class="platform-option" data-platform="${p.name}" onclick="selectCollectPlatform('${p.name}', this)">
      <span class="po-icon">${p.icon}</span> ${p.display_name}
      ${p.paid ? '<span class="badge bg-warning text-dark ms-1" style="font-size:9px">PAID</span>' : ''}
    </div>`
  ).join('');
}

function selectCollectPlatform(name, el) {
  collectPlatform = name;
  document.querySelectorAll('.platform-option').forEach((o) => o.classList.remove('selected'));
  el.classList.add('selected');
  const config = allPlatforms.find((p) => p.name === name);
  document.getElementById('collect-hint').textContent = config?.description || '';
  document.getElementById('collect-query').placeholder = config?.query_type === 'url' ? 'Enter store URL...' : 'Enter keyword...';
  renderCollectRoute(name);
  document.getElementById('toidispy-collect-options').classList.toggle('d-none', name !== 'toidispy');
  if (name === 'toidispy') loadToidispyFilters();
  document.getElementById('collect-query').focus();
  updateCollectBtn();
}

function renderCollectRoute(name) {
  const route = allCapabilities.find((capability) => capability.name === name);
  const el = document.getElementById('collect-route');
  if (!route) {
    el.classList.add('d-none');
    el.innerHTML = '';
    return;
  }

  el.classList.remove('d-none');
  el.innerHTML = `
    <div class="collect-route-title">Fallback route</div>
    <div class="collect-route-steps">
      ${route.backends.map((backend, index) => `
        <div class="collect-route-step">
          <span class="route-index">${index + 1}</span>
          <span class="route-label">${escapeHtml(backend.label)}</span>
          <span class="route-status route-${backend.status}">${escapeHtml(backend.status)}</span>
        </div>
      `).join('')}
    </div>`;
}

async function loadToidispyFilters() {
  if (collectPlatform !== 'toidispy') return;
  const section = document.getElementById('toidispy-section').value || 'posts';
  try {
    const data = await apiFetch(`/api/toidispy/filters?section=${encodeURIComponent(section)}`);
    toidispyFilterConfig = data.filters || [];
    renderToidispyFilters(toidispyFilterConfig);
  } catch (err) {
    document.getElementById('toidispy-filter-grid').innerHTML = `<div class="col-12"><small class="text-danger">${escapeHtml(err.message)}</small></div>`;
  }
}

function renderToidispyFilters(filters) {
  const skip = new Set(['keyword']);
  document.getElementById('toidispy-filter-grid').innerHTML = filters
    .filter((filter) => !skip.has(filter.id))
    .map(renderToidispyFilter)
    .join('');
}

function renderToidispyFilter(filter) {
  const id = `toidispy-filter-${filter.id}`;
  const label = escapeHtml(filter.label);
  const value = filter.default ?? '';

  if (filter.type === 'checkbox') {
    return `<div class="col-6">
      <label class="filter-label">${label}</label>
      <div class="form-check">
        <input class="form-check-input toidispy-filter" type="checkbox" id="${id}" data-filter-id="${filter.id}" data-filter-type="${filter.type}" ${value ? 'checked' : ''}>
        <label class="form-check-label fs-13" for="${id}">${label}</label>
      </div>
    </div>`;
  }

  if (filter.type === 'select' || filter.type === 'date-presets') {
    const options = filter.type === 'date-presets' ? filter.presets || [] : filter.options || [];
    const emptyLabel = filter.type === 'date-presets' ? 'Any time' : '';
    return `<div class="col-6">
      <label class="filter-label" for="${id}">${label}</label>
      <select class="form-select toidispy-filter" id="${id}" data-filter-id="${filter.id}" data-filter-type="${filter.type}">
        ${emptyLabel ? `<option value="">${emptyLabel}</option>` : ''}
        ${options.map((option) => `<option value="${escapeAttr(option.value)}" ${option.value === value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
    </div>`;
  }

  if (filter.type === 'multi-select') {
    return `<div class="col-12">
      <label class="filter-label">${label}</label>
      <div class="collect-check-grid" data-filter-id="${filter.id}" data-filter-type="${filter.type}">
        ${(filter.options || []).map((option) => {
          const optionId = `${id}-${String(option.value).replace(/[^a-z0-9]/gi, '-')}`;
          return `<label class="collect-check" for="${optionId}">
            <input class="toidispy-filter" type="checkbox" id="${optionId}" data-filter-id="${filter.id}" data-filter-type="${filter.type}" value="${escapeAttr(option.value)}">
            <span>${escapeHtml(option.label)}</span>
          </label>`;
        }).join('')}
      </div>
    </div>`;
  }

  return `<div class="col-6">
    <label class="filter-label" for="${id}">${label}</label>
    <input class="form-control toidispy-filter" id="${id}" data-filter-id="${filter.id}" data-filter-type="${filter.type}" type="${filter.type === 'number' ? 'number' : 'text'}" min="${filter.min ?? ''}" placeholder="${escapeAttr(filter.placeholder || '')}" value="${escapeAttr(value)}">
  </div>`;
}

function collectToidispyFilters(query) {
  const filters = { keyword: query };
  for (const filter of toidispyFilterConfig) {
    if (filter.id === 'keyword') continue;
    if (filter.type === 'multi-select') {
      filters[filter.id] = Array.from(document.querySelectorAll(`.toidispy-filter[data-filter-id="${filter.id}"]:checked`)).map((input) => input.value);
    } else if (filter.type === 'checkbox') {
      filters[filter.id] = Boolean(document.querySelector(`.toidispy-filter[data-filter-id="${filter.id}"]`)?.checked);
    } else if (filter.type === 'number') {
      filters[filter.id] = parseInt(document.querySelector(`.toidispy-filter[data-filter-id="${filter.id}"]`)?.value || '0', 10) || 0;
    } else {
      filters[filter.id] = document.querySelector(`.toidispy-filter[data-filter-id="${filter.id}"]`)?.value || '';
    }
  }
  return filters;
}

function updateCollectBtn() {
  document.getElementById('collect-start').disabled = !collectPlatform || !document.getElementById('collect-query').value.trim();
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('collect-query').addEventListener('input', updateCollectBtn);
});

async function startCollect() {
  if (!collectPlatform) return;
  const query = document.getElementById('collect-query').value.trim();
  const maxItems = parseInt(document.getElementById('collect-max').value) || 20;
  const country = document.getElementById('collect-country').value;
  const section = document.getElementById('toidispy-section').value || 'posts';
  const filters = collectPlatform === 'toidispy' ? collectToidispyFilters(query) : undefined;

  const btn = document.getElementById('collect-start');
  const status = document.getElementById('collect-status');
  btn.disabled = true;
  btn.querySelector('.btn-text').classList.add('d-none');
  btn.querySelector('.btn-loading').classList.remove('d-none');
  status.innerHTML = `<small class="text-primary">Starting...</small>`;

  try {
    const result = await apiFetch('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ platform: collectPlatform, query, options: { maxItems, country, section, filters } }),
    });
    status.innerHTML = `<small class="text-success">✅ Run #${result.id} started. Polling...</small>`;

    const poll = setInterval(async () => {
      try {
        const run = await apiFetch(`/api/runs/${result.id}`);
        if (run.status === 'done' || run.status === 'failed') {
          clearInterval(poll);
          if (run.status === 'done') {
            status.innerHTML = `<small class="text-success">✅ Done! ${run.items_count} items (${run.new_count} new, ${run.active_count} active, ${run.dropped_count} dropped)</small>`;
          } else {
            status.innerHTML = `<small class="text-danger">❌ ${run.error_message || 'Failed'}</small>`;
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

// ==================== Export ====================

function exportAll() {
  const data = allItems.map((i) => ({
    platform: i.platform, title: i.title, author: i.author, price: i.price,
    likes: i.likes, comments: i.comments, shares: i.shares, views: i.views,
    status: i.status, growth: i.growth, url: i.url,
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `apify-collector-${Date.now()}.json`;
  a.click();
}

// ==================== Helpers ====================

async function apiFetch(endpoint, options = {}) {
  const res = await fetch(endpoint, { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }
function escapeAttr(t) { return String(t || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function formatNum(n) { if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1000) return (n / 1000).toFixed(1) + 'K'; return String(n); }
