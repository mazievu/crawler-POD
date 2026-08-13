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
  setupSearch();
});

// ==================== Data Loading ====================

async function loadData() {
  try {
    const [platforms, items, stats] = await Promise.all([
      apiFetch('/api/platforms'),
      apiFetch('/api/items?limit=200'),
      apiFetch('/api/stats').catch(() => ({ totalRuns: 0 })),
    ]);
    allPlatforms = platforms;
    allItems = items;

    const counts = {};
    for (const item of allItems) {
      counts[item.platform] = (counts[item.platform] || 0) + 1;
    }
    renderFilterPills(platforms, counts);
    document.getElementById('stat-total').textContent = `${stats.totalRuns} runs / ${allItems.length} items`;
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
  applyFilters();
}

function setupSearch() {
  const input = document.getElementById('search-input');
  let debounce;
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(applyFilters, 200); });
}

async function applyFilters() {
  const query = document.getElementById('search-input').value.toLowerCase().trim();
  const sort = document.getElementById('sort-select').value;
  const params = new URLSearchParams({ limit: '200' });
  if (activeFilter !== 'all') params.set('platform', activeFilter);
  if (query) params.set('search', query);
  let filtered;
  try {
    filtered = await apiFetch(`/api/items?${params}`);
    allItems = filtered;
  } catch (err) {
    console.error('Search failed:', err);
    return;
  }

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
    const platformLabel = config?.displayName || item.platform;
    const cardImage = item.image
      ? `<img src="${escapeAttr(item.image)}" alt="${escapeAttr(item.title || platformLabel)}" style="width:100%;height:100%;object-fit:cover" onerror="this.replaceWith(Object.assign(document.createElement('div'), { className: 'item-img-placeholder', textContent: 'No image' }))">`
      : '<div class="item-img-placeholder">No image</div>';

    // Status badge
    const statusBadge = getStatusBadge(item.status);

    // Growth indicators
    const growthHtml = renderGrowth(item.growth);

    return `
      <div class="item-card" onclick="showItemDetail('${escapeAttr(item.item_uid)}')">
        <div class="item-img">
          ${cardImage}
          <span class="platform-tag ${tagClass}">${platformLabel}</span>
          ${statusBadge}
        </div>
        <div class="item-body">
          <div class="item-title" title="${escapeAttr(item.title)}">${escapeHtml(item.title) || '<em>No title</em>'}</div>
          ${item.author ? `<div class="item-source">${escapeHtml(item.author)}</div>` : ''}
          ${item.price > 0 ? `<div class="item-price">$${item.price.toFixed(2)}</div>` : ''}
          ${renderProductMetrics(item)}
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

function renderProductMetrics(item) {
  const metrics = [];
  if (item.rating > 0) metrics.push(`<span title="Rating">★ ${Number(item.rating).toFixed(1)}</span>`);
  if (item.reviews > 0) metrics.push(`<span title="Reviews">${formatNum(item.reviews)} reviews</span>`);
  if (item.sold_count > 0 || item.soldCount > 0) metrics.push(`<span title="Sold">${formatNum(item.sold_count || item.soldCount)} sold</span>`);
  return metrics.length ? `<div class="item-product-metrics">${metrics.join('<span class="metric-separator">·</span>')}</div>` : '';
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
            <span class="badge bg-primary me-1">${config?.displayName || latest.platform}</span>
            ${latest.author ? `<span class="badge bg-light text-dark">${escapeHtml(latest.author)}</span>` : ''}
            ${getStatusBadge(latest.status)}
          </div>
          <h6 class="fw-bold">${escapeHtml(latest.title)}</h6>
          ${latest.price > 0 ? `<p class="fs-4 fw-bold text-success mb-2">$${latest.price.toFixed(2)}</p>` : ''}
          ${renderProductMetrics(latest)}
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
  document.getElementById('platform-grid').innerHTML = allPlatforms.map((p) => {
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

  const btn = document.getElementById('collect-start');
  const status = document.getElementById('collect-status');
  btn.disabled = true;
  btn.querySelector('.btn-text').classList.add('d-none');
  btn.querySelector('.btn-loading').classList.remove('d-none');
  status.innerHTML = `<small class="text-primary">Starting...</small>`;

  try {
    const optionsPayload = { maxItems, country, ...getPlatformFieldValues() };
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
        j.status === 'done' ? '<span class="badge bg-success">Done</span>' :
        j.status === 'running' ? '<span class="badge bg-primary">Running</span>' :
        j.status === 'failed' ? '<span class="badge bg-danger">Failed</span>' :
        '<span class="badge bg-secondary">Pending</span>';

      let errorDetails = '';
      if (j.status === 'failed' && j.health_snapshot) {
        try {
          const snapshot = typeof j.health_snapshot === 'string' ? JSON.parse(j.health_snapshot) : j.health_snapshot;
          if (snapshot.error) {
            errorDetails = `<div class="mt-2 p-2 bg-light border rounded text-danger" style="font-size:12px; max-width: 400px; white-space: pre-wrap; word-break: break-word;">
              <strong>Error:</strong> ${escapeHtml(snapshot.error)}<br>`;
            if (snapshot.code === 'TOIDISPY_LOGIN_REQUIRED' || snapshot.error.includes('TOIDISPY_LOGIN_REQUIRED')) {
              errorDetails = `<div class="mt-2 p-2 bg-light border rounded text-danger" style="font-size:12px; max-width: 400px; white-space: pre-wrap; word-break: break-word;">
              <strong>Error:</strong> Toidispy login required. Open Chrome CDP profile, login to Toidispy, then retry.<br>`;
            }
            const url = snapshot.stderrDiagnostic?.currentUrl || snapshot.stdoutJson?.error?.currentUrl;
            const title = snapshot.stderrDiagnostic?.title || snapshot.stdoutJson?.error?.title || 'Unknown Title';
            if (url) {
              errorDetails += `<strong>Page:</strong> <a href="${escapeAttr(url)}" target="_blank">${escapeHtml(title)}</a><br>`;
            }
            if (snapshot.actions && snapshot.actions.length) {
              errorDetails += `<strong>Action:</strong> ${escapeHtml(snapshot.actions.join(' / '))}<br>`;
            }
            if (snapshot.stderrDiagnostic?.screenshotPath) {
               errorDetails += `<strong>Debug:</strong> ${escapeHtml(snapshot.stderrDiagnostic.screenshotPath)}`;
            }
            errorDetails += `</div>`;
          }
        } catch(e) {}
      }

      return `<tr>
        <td>#${j.id}</td>
        <td>${icon} ${pName}</td>
        <td style="max-width:300px;">
          <div class="text-truncate" title="${escapeAttr(j.query)}">${escapeHtml(j.query)}</div>
          ${errorDetails}
        </td>
        <td>${j.active_backend ? `<span class="badge bg-secondary">${j.active_backend}</span>` : '-'}</td>
        <td>${statusBadge}</td>
        <td>${j.items_count}</td>
        <td>${new Date(j.created_at).toLocaleString()}</td>
        <td>
          <a href="/api/export/${j.id}?format=csv" class="btn btn-sm btn-outline-primary py-0 px-2 fs-12 me-1" target="_blank">Export CSV</a>
          <button class="btn btn-sm btn-outline-danger py-0 px-2 fs-12" onclick="deleteJob(${j.id})">Delete</button>
        </td>
      </tr>`;
    }).join('');
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
  feather.replace();
}

async function loadMarketplaceAccounts() {
  const platform = document.getElementById('marketplace-account-platform').value;
  const list = document.getElementById('marketplace-accounts-list');
  list.textContent = 'Loading...';
  try {
    const accounts = await apiFetch(`/api/marketplace-accounts?platform=${encodeURIComponent(platform)}`);
    list.innerHTML = accounts.length ? accounts.map((account) => `
      <div class="border rounded p-2 mb-2">
        <div class="d-flex justify-content-between align-items-start gap-2"><span><strong>${escapeHtml(account.label)}</strong><br><span class="text-muted">${escapeHtml(account.platform)} · saved ${new Date(account.updated_at).toLocaleString()}</span></span><button class="btn btn-outline-danger btn-sm" onclick="deleteMarketplaceAccount(${Number(account.id)})">Remove</button></div>
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
      return `<tr><td>${escapeHtml(capture.platform)}</td><td><strong>${escapeHtml(title)}</strong><br><a href="${escapeAttr(capture.url)}" target="_blank" rel="noreferrer" class="text-muted text-break">${escapeHtml(capture.url)}</a></td><td>${escapeHtml(mode)}</td><td>${escapeHtml(new Date(capture.created_at).toLocaleString())}</td><td><button class="btn btn-outline-primary btn-sm" onclick="window.open('/api/html-captures/${Number(capture.id)}', '_blank')">Open data</button></td></tr>`;
    }).join('');
    list.innerHTML = `<div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead><tr><th>Platform</th><th>Product</th><th>Capture</th><th>Saved</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (err) {
    list.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
  }
  finally { feather.replace(); }
}

async function showMarketplaceSchedulesModal() {
  document.getElementById('marketplace-schedule-keyword').value = '';
  document.getElementById('marketplace-schedule-status').textContent = '';
  updateMarketplaceScheduleTimeFields();
  new bootstrap.Modal(document.getElementById('marketplace-schedules-modal')).show();
  const accountSelect = document.getElementById('marketplace-schedule-account');
  accountSelect.innerHTML = '<option value="">Public / no login</option>';
  try {
    for (const account of await apiFetch('/api/marketplace-accounts?platform=etsy')) accountSelect.add(new Option(account.label, account.id));
  } catch (err) { console.error('Could not load Etsy accounts:', err); }
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
  try {
    await apiFetch('/api/marketplace-capture-schedules', { method: 'POST', body: JSON.stringify({
      platform: 'etsy', keyword: document.getElementById('marketplace-schedule-keyword').value,
      accountId: document.getElementById('marketplace-schedule-account').value || null,
      everyHours: Number(document.getElementById('marketplace-schedule-every-hours').value),
      scheduleType: document.getElementById('marketplace-schedule-type').value,
      dailyTime: document.getElementById('marketplace-schedule-daily-time').value,
      runAt: document.getElementById('marketplace-schedule-once-datetime').value,
      variantMode: document.getElementById('marketplace-schedule-variant-mode').value,
      maxVariants: Number(document.getElementById('marketplace-schedule-max-variants').value), maxListings: 30,
    }) });
    status.innerHTML = '<span class="text-success">Schedule saved.</span>';
    document.getElementById('marketplace-schedule-keyword').value = '';
    await loadMarketplaceSchedules();
  } catch (err) { status.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`; }
}

async function loadMarketplaceSchedules() {
  const list = document.getElementById('marketplace-schedules-list');
  try {
    const schedules = await apiFetch('/api/marketplace-capture-schedules');
    list.innerHTML = schedules.length ? schedules.map((schedule) => {
      const timing = schedule.schedule_type === 'daily' ? `daily at ${schedule.daily_time} (Vietnam)` : schedule.schedule_type === 'once' ? `one time at ${schedule.run_at} (Vietnam)` : `every ${Number(schedule.every_minutes) / 60}h`;
      const next = schedule.enabled ? `next ${new Date(schedule.next_run_at).toLocaleString()}` : 'completed';
      const latest = schedule.last_run_at ? `Last run ${new Date(schedule.last_run_at).toLocaleString()}: ${formatMarketplaceScheduleSummary(schedule.last_summary)}` : 'No completed runs yet.';
      const id = Number(schedule.id);
      return `<div class="border rounded p-2 mb-2"><div class="d-flex justify-content-between gap-2"><span><strong>${escapeHtml(schedule.keyword)}</strong><br><span class="text-muted">Etsy · up to 30 listings · ${escapeHtml(timing)} · ${escapeHtml(next)}</span><br><span class="text-muted">${escapeHtml(latest)}</span></span><div class="d-flex gap-1 align-items-start"><button class="btn btn-outline-primary btn-sm" onclick="toggleMarketplaceScheduleRunHistory(${id})">Run history</button><button class="btn btn-outline-danger btn-sm" onclick="deleteMarketplaceSchedule(${id})">Remove</button></div></div><div id="marketplace-schedule-run-history-${id}" class="d-none mt-2"></div></div>`;
    }).join('') : 'No schedules saved.';
  } catch (err) { list.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`; }
}

function formatMarketplaceScheduleSummary(summary) {
  if (!summary) return 'No result summary.';
  const result = `found ${Number(summary.discovered) || 0}, saved ${Number(summary.captured) || 0}, blocked ${Number(summary.blocked) || 0}, failed ${Number(summary.failed) || 0}`;
  return summary.error ? `${result} (${summary.error})` : result;
}

async function toggleMarketplaceScheduleRunHistory(id) {
  const panel = document.getElementById(`marketplace-schedule-run-history-${Number(id)}`);
  if (!panel) return;
  if (!panel.classList.contains('d-none')) {
    panel.classList.add('d-none');
    return;
  }
  panel.classList.remove('d-none');
  panel.textContent = 'Loading run history...';
  try {
    const runs = await apiFetch(`/api/marketplace-capture-schedules/${Number(id)}/runs`);
    panel.innerHTML = runs.length ? `<div class="table-responsive"><table class="table table-sm mb-0"><thead><tr><th>Completed</th><th>Found</th><th>Saved</th><th>Blocked</th><th>Failed</th><th>Details</th></tr></thead><tbody>${runs.map((run) => `<tr><td>${escapeHtml(new Date(run.completed_at).toLocaleString())}</td><td>${Number(run.summary?.discovered) || 0}</td><td>${Number(run.summary?.captured) || 0}</td><td>${Number(run.summary?.blocked) || 0}</td><td>${Number(run.summary?.failed) || 0}</td><td>${escapeHtml(run.summary?.error || '')}</td></tr>`).join('')}</tbody></table></div>` : '<span class="text-muted">No completed runs yet.</span>';
  } catch (err) {
    panel.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
  }
}

async function deleteMarketplaceSchedule(id) {
  if (!confirm('Remove this scheduled capture?')) return;
  try { await apiFetch(`/api/marketplace-capture-schedules/${Number(id)}`, { method: 'DELETE' }); await loadMarketplaceSchedules(); }
  catch (err) { alert(`Could not remove schedule: ${err.message}`); }
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
