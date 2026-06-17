/* ═══════════════════════════════════════════════════════
   NJL Product Catalogue — script.js  (v4.0 — BOM Enriched schema)
   Column mapping from old → new:
     ITEMNUMBER       → ITEMID_SNQ
     DESIGNTHEME      → THEME CODE
     ITEMNUMBER Image → ITEMID_SNQ URL
     IS Set           → Is set
     Set colleague N  → Set collegue N  (source typo preserved)
     PWC_PRODUCTGROUP → (removed)
     + new: PRODUCTIONSTATUS, PWC_DESIGNPURITY, DESIGNNUMBER
═══════════════════════════════════════════════════════ */

const API = '';  // same origin

// ─── State ────────────────────────────────────────────────────────────────────
let currentPage   = 1;
const PAGE_SIZE   = 20;
let totalPages    = 1;
let searchTimer   = null;
let activeFilters = {};
let selectedSKUs  = new Set();
let currentModalSKU = null;

// Filter column definitions
const FILTER_COLS = [
  { key: 'PRODUCTIONSTATUS',   label: 'Status' },
  { key: 'Is set',             label: 'Is Set?' },
  { key: 'WORKSTYLECODE',      label: 'Work Style' },
  { key: 'PWC_GENDER',         label: 'Gender' },
  { key: 'PWC_SUBPRODUCTGROUP',label: 'Sub-Product Group' },
];

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  showLoading(true);
  await loadFilterValues();
  await fetchCatalogue();
  showLoading(false);

  document.getElementById('globalSearch').addEventListener('input', e => {
    clearTimeout(searchTimer);
    document.getElementById('searchClear').classList.toggle('visible', e.target.value.length > 0);
    searchTimer = setTimeout(() => { currentPage = 1; fetchCatalogue(); }, 400);
  });
});

// ─── Loading ──────────────────────────────────────────────────────────────────
function showLoading(v) {
  document.getElementById('loadingOverlay').classList.toggle('active', v);
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', dur = 3000) {
  const tc = document.getElementById('toastContainer');
  const t  = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  tc.appendChild(t);
  setTimeout(() => t.remove(), dur);
}

// ─── Filter UI ────────────────────────────────────────────────────────────────
async function loadFilterValues() {
  try {
    const res  = await fetch(`${API}/api/filter-values`);
    const data = await res.json();
    const container = document.getElementById('filtersContainer');
    container.innerHTML = '';

    FILTER_COLS.forEach(({ key, label }) => {
      if (!data[key] || data[key].length === 0) return;
      if (!activeFilters[key]) activeFilters[key] = new Set();

      const block = document.createElement('div');
      block.className = 'filter-block';
      block.innerHTML = `
        <div class="filter-label">${label}
          <button class="filter-clear-btn" onclick="clearFilter('${key}')">Clear</button>
        </div>
        <div class="active-chips" id="chips-${key}"></div>
        <div class="filter-search">
          <svg class="fs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input type="text" placeholder="Search…" oninput="filterList('${key}', this.value)"/>
        </div>
        <div class="filter-list" id="list-${key}"></div>
        <div class="sidebar-divider"></div>
      `;
      container.appendChild(block);

      renderFilterList(key, data[key], '');
      window[`_filterData_${key}`] = data[key];
    });
  } catch (e) {
    console.error('Filter load error', e);
  }
}

function renderFilterList(key, values, query) {
  const container = document.getElementById(`list-${key}`);
  if (!container) return;
  const q    = query.toLowerCase();
  const filt = values.filter(v => !q || v.toLowerCase().includes(q));
  container.innerHTML = filt.slice(0, 60).map(v => {
    const selected = activeFilters[key] && activeFilters[key].has(v);
    const safeVal  = v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `
      <div class="filter-item ${selected ? 'selected' : ''}" data-key="${key}" data-value="${safeVal}">
        <input type="checkbox" ${selected ? 'checked' : ''} data-key="${key}" data-value="${safeVal}"/>
        <span class="filter-item-label" title="${safeVal}">${safeVal}</span>
      </div>`;
  }).join('');
}

function filterList(key, q) {
  renderFilterList(key, window[`_filterData_${key}`] || [], q);
}

function toggleFilter(key, value, el) {
  if (!activeFilters[key]) activeFilters[key] = new Set();
  const set = activeFilters[key];
  if (set.has(value)) { set.delete(value); el.classList.remove('selected'); }
  else                { set.add(value);    el.classList.add('selected');    }
  const cb = el.querySelector('input[type="checkbox"]');
  if (cb) cb.checked = set.has(value);
  updateChips(key);
  currentPage = 1;
  fetchCatalogue();
}

function updateChips(key) {
  const chips = document.getElementById(`chips-${key}`);
  if (!chips) return;
  const set = activeFilters[key] || new Set();
  chips.innerHTML = [...set].map(v => {
    const sv = v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<span class="chip">${sv}<span class="chip-remove" data-key="${key}" data-value="${sv}">✕</span></span>`;
  }).join('');
}

function removeChip(key, value) {
  activeFilters[key] && activeFilters[key].delete(value);
  updateChips(key);
  renderFilterList(key, window[`_filterData_${key}`] || [], '');
  currentPage = 1;
  fetchCatalogue();
}

function clearFilter(key) {
  activeFilters[key] = new Set();
  updateChips(key);
  renderFilterList(key, window[`_filterData_${key}`] || [], '');
  currentPage = 1;
  fetchCatalogue();
}

function clearAllFilters() {
  FILTER_COLS.forEach(({ key }) => {
    activeFilters[key] = new Set();
    updateChips(key);
    renderFilterList(key, window[`_filterData_${key}`] || [], '');
  });
  currentPage = 1;
  fetchCatalogue();
}

function clearSearch() {
  document.getElementById('globalSearch').value = '';
  document.getElementById('searchClear').classList.remove('visible');
  currentPage = 1;
  fetchCatalogue();
}

// ─── Event delegation ─────────────────────────────────────────────────────────
document.addEventListener('click', function (e) {
  const chipRemove = e.target.closest('.chip-remove');
  if (chipRemove) {
    const key = chipRemove.dataset.key, val = chipRemove.dataset.value;
    if (key && val !== undefined) removeChip(key, val);
    return;
  }
  const filterItem = e.target.closest('.filter-item');
  if (filterItem) {
    e.stopPropagation();
    const key = filterItem.dataset.key, val = filterItem.dataset.value;
    if (key && val !== undefined) toggleFilter(key, val, filterItem);
    return;
  }
});

// ─── Catalogue Fetch ──────────────────────────────────────────────────────────
async function fetchCatalogue() {
  showLoading(true);
  const q = document.getElementById('globalSearch').value.trim();
  const params = new URLSearchParams({ page: currentPage, page_size: PAGE_SIZE, q });

  FILTER_COLS.forEach(({ key }) => {
    if (key === 'Is set') return;  // handled manually below
    const set = activeFilters[key];
    if (set && set.size > 0) params.set(key, [...set].join('|'));
  });

  try {
    let url = `${API}/api/catalogue?${params.toString()}`;
    const isSetSet = activeFilters['Is set'];
    if (isSetSet && isSetSet.size > 0) {
      url += `&Is%20set=${[...isSetSet].join('|')}`;
    }
    const res  = await fetch(url);
    const data = await res.json();
    renderCards(data.data || []);
    totalPages = data.total_pages || 1;
    renderPagination(data.total_filtered, data.total_skus);
    document.getElementById('statTotal').textContent   = (data.total_skus || 0).toLocaleString();
    document.getElementById('statShowing').textContent = (data.total_filtered || 0).toLocaleString();
    document.getElementById('badgeCount').textContent  = (data.total_filtered || 0).toLocaleString();
  } catch (e) {
    console.error('Catalogue fetch error', e);
    showToast('Failed to load catalogue', 'error');
  } finally {
    showLoading(false);
  }
}

// ─── Card Rendering ───────────────────────────────────────────────────────────
function renderCards(items) {
  const grid = document.getElementById('catalogueGrid');
  if (!items.length) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">💎</div>
      <div class="empty-title">No SKUs Found</div>
      <div class="empty-sub">Try adjusting your search or filters</div>
    </div>`;
    return;
  }

  grid.innerHTML = items.map(item => {
    const sku        = item.ITEMID_SNQ || '';
    const isSelected = selectedSKUs.has(sku);
    const imgUrl     = item['ITEMID_SNQ URL'] || '';
    const status    = item.PRODUCTIONSTATUS || '';
    const stageCls  = status.toLowerCase() === 'active' ? 'active' : 'inactive';
    const netWt      = item.NET_WEIGHT ? parseFloat(item.NET_WEIGHT).toFixed(3) : '–';
    // NET WT  = sum of raw metal GMS lines (GRG/PRG/SRG prefix) only
    // GROSS WT = NET WT + stone weight (CTS lines × 0.2 g/ct)
    const _RAW = ['GRG','PRG','SRG','CRX'];
    let _netCg = 0, _stCg = 0;
    if (Array.isArray(item.BOM) && item.BOM.length) {
      item.BOM.forEach(row => {
        const _q = parseFloat(row.QTY);
        const _u = (row.INVENTUNIT || '').trim().toUpperCase();
        const _p = (row.ITEMID_BOM || '').trim().substring(0, 3).toUpperCase();
        if (!isNaN(_q)) {
          if (_u === 'GMS' && _RAW.includes(_p)) _netCg += _q;
          else if (_u === 'CTS') _stCg += _q * 0.2;
        }
      });
    }
    const grossWt = _netCg > 0
      ? (_netCg + _stCg).toFixed(3)
      : (item.GROSS_WEIGHT ? parseFloat(item.GROSS_WEIGHT).toFixed(3) : '–');
    const metalLabel = [item.METALPURITY, item.METALTYPE].filter(Boolean).join(' · ');
    const colorLabel = item.PWC_METALCOLOR || '';
    const genderLabel= item.PWC_GENDER || '';

    return `
    <div class="sku-card ${isSelected ? 'selected' : ''}" id="card-${sku}" onclick="toggleCardSelect(event, '${esc(sku)}')">
      <div class="card-select-check">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
      </div>

      <div class="card-img-wrap">
        ${imgUrl
          ? `<img src="${imgUrl}" alt="${esc(item['THEME CODE'] || sku)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=card-img-placeholder>💎</div>'"/>`
          : `<div class="card-img-placeholder">💎</div>`}
        ${status ? `<span class="card-stage-badge ${stageCls}">${status}</span>` : ''}
      </div>

      <div class="card-body">
        <div class="card-sku">${esc(sku)}</div>
        <div class="card-theme">${esc(item['THEME CODE'] || '—')}</div>
        <div class="card-subname">${esc(item.PRODUCTSUBNAME || '—')}</div>

        <div class="card-tags">
          ${metalLabel   ? `<span class="card-tag metal">${esc(metalLabel)}</span>`   : ''}
          ${colorLabel   ? `<span class="card-tag color">${esc(colorLabel)}</span>`   : ''}
          ${genderLabel  ? `<span class="card-tag gender">${esc(genderLabel)}</span>` : ''}
        </div>

        <div class="card-weights">
          <div class="wt-box"><div class="wt-label">Net Wt.</div><div class="wt-value">${netWt}<span class="wt-unit"> g</span></div></div>
          <div class="wt-box"><div class="wt-label">Gross Wt.</div><div class="wt-value">${grossWt}<span class="wt-unit"> g</span></div></div>
        </div>

        <div class="card-footer">
          <button class="btn-expand" onclick="openModal(event, '${esc(sku)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
            View Details / PIS
          </button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ─── Selection ────────────────────────────────────────────────────────────────
function toggleCardSelect(event, sku) {
  if (event.target.closest('.btn-expand')) return;
  if (selectedSKUs.has(sku)) selectedSKUs.delete(sku);
  else                        selectedSKUs.add(sku);
  const card = document.getElementById(`card-${sku}`);
  if (card) card.classList.toggle('selected', selectedSKUs.has(sku));
  updateFloatBar();
}

function updateFloatBar() {
  const count = selectedSKUs.size;
  document.getElementById('floatBarCount').textContent = count;
  document.getElementById('statSelected').textContent  = count;
  document.getElementById('floatBar').classList.toggle('visible', count > 0);
}

function clearSelection() {
  selectedSKUs.forEach(sku => {
    const card = document.getElementById(`card-${sku}`);
    if (card) card.classList.remove('selected');
  });
  selectedSKUs.clear();
  updateFloatBar();
}

// ─── Pagination ───────────────────────────────────────────────────────────────
function renderPagination(total, totalAll) {
  const pag = document.getElementById('pagination');
  if (totalPages <= 1) { pag.innerHTML = ''; return; }

  const pages = [];
  pages.push(`<button class="page-btn" ${currentPage===1?'disabled':''} onclick="goPage(${currentPage-1})">‹ Prev</button>`);
  const range = getPageRange(currentPage, totalPages);
  let last = 0;
  range.forEach(p => {
    if (p - last > 1) pages.push(`<span class="page-info">…</span>`);
    pages.push(`<button class="page-btn ${p===currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`);
    last = p;
  });
  pages.push(`<span class="page-info">Page ${currentPage} / ${totalPages}</span>`);
  pages.push(`<button class="page-btn" ${currentPage===totalPages?'disabled':''} onclick="goPage(${currentPage+1})">Next ›</button>`);
  pag.innerHTML = pages.join('');
}

function getPageRange(cur, total) {
  const delta = 2, range = [];
  for (let i = Math.max(2, cur-delta); i <= Math.min(total-1, cur+delta); i++) range.push(i);
  range.unshift(1); range.push(total);
  return [...new Set(range)].sort((a,b)=>a-b);
}

function goPage(p) {
  currentPage = p;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  fetchCatalogue();
}

// ─── Modal / PIS View ─────────────────────────────────────────────────────────
async function openModal(event, sku) {
  event.stopPropagation();
  showLoading(true);
  try {
    const res  = await fetch(`${API}/api/sku/${encodeURIComponent(sku)}`);
    const data = await res.json();
    currentModalSKU = data;
    renderPIS(data);
    document.getElementById('modalOverlay').classList.add('active');
    document.body.style.overflow = 'hidden';
  } catch (e) {
    showToast('Could not load SKU details', 'error');
  } finally {
    showLoading(false);
  }
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
  document.body.style.overflow = '';
  currentModalSKU = null;
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
}

function v(val) {
  if (val === null || val === undefined || val === '' || val === 'nan' || val === 'NaN' || val === 'NA') return '—';
  return String(val);
}

function renderPIS(d) {
  // Title bar
  document.getElementById('pisSkuRef').textContent = `SKU: ${v(d.ITEMID_SNQ)}`;

  // ── INFO TABLE FIELDS (new schema columns) ──
  const infoFields = [
    ['Item Number',        d.ITEMID_SNQ],
    ['Alternate Active SKU', d.ALTERNATE_ACTIVE_SKU],
    ['Theme Code',         d['THEME CODE']],
    ['Design Number',      d.DESIGNNUMBER],
    ['Production Status',  d.PRODUCTIONSTATUS],
    ['Design Source',      d.DESIGNSOURCE],
    ['Finish / Findings',  d.FINISH],
    ['Finish Type',        d.FINISHTYPECODE],
    ['Metal Purity',       d.METALPURITY],
    ['Design Purity',      d.PWC_DESIGNPURITY],
    ['Metal Type',         d.METALTYPE],
    ['Metal Color',        d.PWC_METALCOLOR],
    ['Primary Design Lang.',d.PRIMARYDESIGNLANGUAGE],
    ['Vendor Account',     d.PRIMARYVENDORACCOUNTNUMBER],
    ['Product Group ID',   d.PRODUCTGROUPID],
    ['Product Type',       d.PRODUCTTYPECODE],
    ['Design Motif',       d.PWC_DESIGNMOTIF],
    ['Gender',             d.PWC_GENDER],
    ['Item Stage',         d.PWC_ITEMSTAGE],
    ['Occasion',           d.PWC_OCCASION],
    ['Sub-Product Group',  d.PWC_SUBPRODUCTGROUP],
    ['Work Style',         d.WORKSTYLECODE],
    ['Collection',         d.COLLECTIONCODE],
    ['Vendor Item ID',     d.VENDORITEMID],
    ['Is Set?',            d['Is set']],
    ['Set Code',           d['Set Code']],
    ['Set Colleague 1',    d['Set collegue 1']],
    ['Set Colleague 2',    d['Set collegue 2']],
    ['Set Colleague 3',    d['Set collegue 3']],
    ['Set Colleague 4',    d['Set collegue 4']],
    ['Set Colleague 5',    d['Set collegue 5']],
    ['Set Colleague 6',    d['Set collegue 6']],
    ['Set Colleague 7',    d['Set collegue 7']],
    ['Set Colleague 8',    d['Set collegue 8']],
    ['Set Colleague 9',    d['Set collegue 9']],
  ];

  const mid     = Math.ceil(infoFields.length / 2);
  const left    = infoFields.slice(0, mid);
  const right   = infoFields.slice(mid);
  const maxLen  = Math.max(left.length, right.length);

  let leftHTML = '', rightHTML = '';
  for (let i = 0; i < maxLen; i++) {
    const lf = left[i]  || ['', ''];
    const rf = right[i] || ['', ''];
    leftHTML  += `<div class="pis-row"><div class="pis-cell-header">${lf[0]}</div><div class="pis-cell-value">${v(lf[1])}</div></div>`;
    rightHTML += `<div class="pis-row"><div class="pis-cell-header">${rf[0]}</div><div class="pis-cell-value">${v(rf[1])}</div></div>`;
  }

  document.getElementById('pisInfoGrid').innerHTML = `
    <div class="pis-table-col">${leftHTML}</div>
    <div class="pis-table-col">${rightHTML}</div>
  `;

  // Full-width PRODUCTSUBNAME
  document.getElementById('pisSubnameRow').innerHTML = `
    <div class="pis-fullrow">
      <div class="pis-cell-header" style="display:flex;align-items:center;">Product Sub Name</div>
      <div class="pis-cell-value">${v(d.PRODUCTSUBNAME)}</div>
    </div>
  `;

  // ── IMAGES ──
  const imgRow = document.getElementById('pisImagesRow');
  imgRow.innerHTML = '';

  const mainImg  = d['ITEMID_SNQ URL'];
  const mainItem = document.createElement('div');
  mainItem.className = 'pis-img-item';
  mainItem.innerHTML = `
    <div class="pis-img-main">
      ${mainImg && mainImg !== '—'
        ? `<img src="${mainImg}" alt="${v(d.ITEMID_SNQ)}" onerror="this.parentElement.innerHTML='<div class=pis-img-placeholder>💎</div>'"/>`
        : `<div class="pis-img-placeholder">💎</div>`}
    </div>
    <div class="pis-img-label" title="${v(d.ITEMID_SNQ)}">${v(d.ITEMID_SNQ)}</div>
  `;
  imgRow.appendChild(mainItem);

  // Set colleague images — new schema uses "Set collegue N URL"
  for (let i = 1; i <= 9; i++) {
    const collSku = d[`Set collegue ${i}`];
    const collUrl = d[`Set collegue ${i} URL`];
    if (!collUrl || v(collUrl) === '—') continue;
    const setItem = document.createElement('div');
    setItem.className = 'pis-img-item';
    setItem.innerHTML = `
      <div class="pis-img-set">
        <img src="${collUrl}" alt="${v(collSku)}" onerror="this.parentElement.innerHTML='<div class=pis-img-placeholder style=font-size:16px>💎</div>'"/>
      </div>
      <div class="pis-img-label" title="${v(collSku)}">${v(collSku)}</div>
    `;
    imgRow.appendChild(setItem);
  }

  // ── BOM TABLE ──
  // New schema BOM: { ITEMID_BOM, QTY, INVENTUNIT, INGREDIENT_DESCRIPTION, PDSCWQTY }
  const bom   = d.BOM || [];
  const tbody = document.getElementById('pisBomBody');
  if (!bom.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#9aaec7;padding:20px;">No BOM data available</td></tr>`;
  } else {
    tbody.innerHTML = bom.map((row, i) => `
      <tr>
        <td>${v(row.ITEMID_BOM)}</td>
        <td>${v(row.INGREDIENT_DESCRIPTION)}</td>
        <td>${v(row.INVENTUNIT)}</td>
        <td class="num">${row.QTY !== null && row.QTY !== undefined ? parseFloat(row.QTY).toFixed(4) : '—'}</td>
        <td class="num">${row.PDSCWQTY !== null && row.PDSCWQTY !== undefined ? parseFloat(row.PDSCWQTY).toFixed(4) : '—'}</td>
      </tr>
    `).join('');

    // ── NET WT + GROSS WT + STONE QTY TOTAL ROWS ──
    // NET WT  = sum of raw metal GMS lines (GRG/PRG/SRG/CRX prefix) only
    // GROSS WT = NET WT + stone weight (CTS lines × 0.2 g/ct)
    // STONE QTY = sum of PDSCWQTY across all BOM lines
    const _RAW_PFX = ['GRG','PRG','SRG','CRX'];
    let calcNetWt = 0, calcStoneWt = 0, calcStoneQty = 0;
    bom.forEach(row => {
      const qty  = parseFloat(row.QTY);
      const unit = (row.INVENTUNIT || '').trim().toUpperCase();
      const pfx  = (row.ITEMID_BOM || '').trim().substring(0, 3).toUpperCase();
      if (isNaN(qty)) return;
      if (unit === 'GMS' && _RAW_PFX.includes(pfx)) calcNetWt   += qty;
      else if (unit === 'CTS')                       calcStoneWt += qty * 0.2;
      // Sum PDSCWQTY (stone quantity) — skip null/undefined/NaN
      const cwQty = parseFloat(row.PDSCWQTY);
      if (!isNaN(cwQty)) calcStoneQty += cwQty;
    });
    const calcGrossWt      = calcNetWt + calcStoneWt;
    const netWtDisplay     = calcNetWt    > 0 ? calcNetWt.toFixed(4)    + ' g' : '—';
    const grossWtDisplay   = calcGrossWt  > 0 ? calcGrossWt.toFixed(4)  + ' g' : '—';
    const stoneQtyDisplay  = calcStoneQty > 0 ? calcStoneQty.toFixed(4) : '—';
    tbody.innerHTML += `
      <tr style="background:linear-gradient(135deg,#f0f4fb,#f8faff);border-top:2px solid var(--border);">
        <td colspan="3" style="font-weight:700;color:var(--royal-deep);font-size:12px;letter-spacing:.04em;text-transform:uppercase;padding:9px 14px;">
          Net Weight
          <span style="font-size:9px;font-weight:400;color:var(--text-muted);margin-left:6px;">(GRG / PRG / SRG metal lines only)</span>
        </td>
        <td class="num" style="font-weight:700;font-size:13px;color:var(--royal-deep);padding:9px 14px;">${netWtDisplay}</td>
        <td class="num" style="font-weight:700;font-size:13px;color:var(--royal-deep);padding:9px 14px;">${stoneQtyDisplay}</td>
      </tr>
      <tr style="background:linear-gradient(135deg,#fdf6e3,#fef9ed);border-top:2px solid var(--gold-border);">
        <td colspan="3" style="font-weight:700;color:var(--royal-deep);font-size:12px;letter-spacing:.04em;text-transform:uppercase;padding:9px 14px;">
          Gross Weight
          <span style="font-size:9px;font-weight:400;color:var(--text-muted);margin-left:6px;">(Net Wt + stones CTS × 0.2)</span>
        </td>
        <td class="num" style="font-weight:700;font-size:14px;color:var(--royal-deep);padding:9px 14px;">${grossWtDisplay}</td>
        <td></td>
      </tr>
    `;
  }
}

// ─── PDF Generation ───────────────────────────────────────────────────────────
async function downloadCurrentPIS() {
  if (!currentModalSKU) return;
  showToast('Preparing PDF…', 'info');
  await generatePISPDF([currentModalSKU]);
}

async function downloadSelectedPDF() {
  if (!selectedSKUs.size) return;
  showToast(`Fetching ${selectedSKUs.size} SKU(s)…`, 'info');
  showLoading(true);
  try {
    const items = [...selectedSKUs].join(',');
    const res   = await fetch(`${API}/api/skus?items=${encodeURIComponent(items)}`);
    const data  = await res.json();
    await generatePISPDF(data);
    showToast('PDF downloaded!', 'success');
  } catch (e) {
    showToast('PDF generation failed', 'error');
  } finally {
    showLoading(false);
  }
}

async function fetchImageAsBase64(url) {
  if (!url || url === '—' || url === 'nan' || url === 'NA') return null;
  try {
    const proxyUrl = `${API}/api/proxy-image?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result || null);
      reader.onerror  = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

async function generatePISPDF(skus) {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { showToast('PDF library not loaded', 'error'); return; }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210, H = 297, M = 14;

  // Colour palette (matches web UI)
  const ROYAL      = [26, 58, 107];
  const ROYAL_DEEP = [15, 35, 71];
  const GOLD       = [201, 150, 26];
  const GOLD_LIGHT = [245, 204, 90];
  const WHITE      = [255, 255, 255];
  const PALE       = [240, 244, 251];
  const TEXT       = [44, 62, 107];
  const MUTED      = [107, 127, 163];

  for (let si = 0; si < skus.length; si++) {
    const d = skus[si];
    if (si > 0) doc.addPage();

    // ─── HEADER BAR ───────────────────────────────────────────────
    doc.setFillColor(...ROYAL_DEEP);
    doc.rect(0, 0, W, 30, 'F');
    doc.setFillColor(...GOLD);
    doc.rect(0, 30, W, 1.2, 'F');

    doc.setFillColor(...GOLD);
    doc.circle(M + 10, 15, 9, 'F');
    doc.setTextColor(...ROYAL_DEEP);
    doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    doc.text('NJL', M + 10, 16.5, { align: 'center' });

    doc.setTextColor(...GOLD_LIGHT);
    doc.setFontSize(13); doc.setFont('helvetica', 'bold');
    doc.text('Proto Information Sheet', W / 2, 12, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.setTextColor(200, 210, 230);
    doc.text(`SKU: ${v(d.ITEMID_SNQ)}`, W / 2, 20, { align: 'center' });

    doc.setTextColor(...GOLD_LIGHT);
    doc.setFontSize(9); doc.setFont('helvetica', 'bold');
    doc.text('Novel Jewels Ltd.', W - M, 13, { align: 'right' });
    doc.setFontSize(7); doc.setFont('helvetica', 'normal');
    doc.setTextColor(180, 195, 220);
    doc.text('Aditya Birla Group · INDRIYA', W - M, 20, { align: 'right' });

    // ─── PRODUCT IMAGE (placed top-right after header) ─────────────
    let y = 36;
    const IMG_W = 55, IMG_H = 55;
    const imgX  = W - M - IMG_W;

    const imgUrl   = v(d['ITEMID_SNQ URL']);
    let imgEmbedded = false;
    if (imgUrl && imgUrl !== '—') {
      const imgData = await fetchImageAsBase64(imgUrl);
      if (imgData) {
        try {
          const mimeMatch = imgData.match(/^data:image\/(\w+);base64,/);
          const fmt = mimeMatch ? mimeMatch[1].toUpperCase().replace('JPG','JPEG') : 'JPEG';
          doc.setDrawColor(...ROYAL); doc.setLineWidth(0.5);
          doc.rect(imgX - 2, y - 2, IMG_W + 4, IMG_H + 4);
          doc.addImage(imgData, fmt, imgX, y, IMG_W, IMG_H, undefined, 'FAST');
          doc.setFontSize(7); doc.setFont('helvetica','italic'); doc.setTextColor(...MUTED);
          doc.text(v(d.ITEMID_SNQ), imgX + IMG_W / 2, y + IMG_H + 5, { align: 'center' });
          imgEmbedded = true;
        } catch (err) { console.error('[PDF] addImage failed:', err); }
      }
    }
    if (!imgEmbedded) {
      doc.setDrawColor(...ROYAL); doc.setFillColor(...PALE);
      doc.rect(imgX - 2, y - 2, IMG_W + 4, IMG_H + 4, 'FD');
      doc.setFontSize(7); doc.setFont('helvetica','italic'); doc.setTextColor(...MUTED);
      doc.text('No image', imgX + IMG_W / 2, y + IMG_H / 2 + 2, { align: 'center' });
    }

    // ─── INFO TABLE (left column, beside image) ────────────────────
    const infoFields = [
      ['Item Number',         d.ITEMID_SNQ],
      ['Alternate Active SKU', d.ALTERNATE_ACTIVE_SKU],
      ['Theme Code',          d['THEME CODE']],
      ['Design Number',       d.DESIGNNUMBER],
      ['Production Status',   d.PRODUCTIONSTATUS],
      ['Design Source',       d.DESIGNSOURCE],
      ['Finish / Findings',   d.FINISH],
      ['Finish Type',         d.FINISHTYPECODE],
      ['Metal Purity',        d.METALPURITY],
      ['Design Purity',       d.PWC_DESIGNPURITY],
      ['Metal Type',          d.METALTYPE],
      ['Metal Color',         d.PWC_METALCOLOR],
      ['Design Language',     d.PRIMARYDESIGNLANGUAGE],
      ['Vendor Account',      d.PRIMARYVENDORACCOUNTNUMBER],
      ['Product Group ID',    d.PRODUCTGROUPID],
      ['Product Type',        d.PRODUCTTYPECODE],
      ['Design Motif',        d.PWC_DESIGNMOTIF],
      ['Gender',              d.PWC_GENDER],
      ['Item Stage',          d.PWC_ITEMSTAGE],
      ['Occasion',            d.PWC_OCCASION],
      ['Sub-Product Group',   d.PWC_SUBPRODUCTGROUP],
      ['Work Style',          d.WORKSTYLECODE],
      ['Collection',          d.COLLECTIONCODE],
      ['Vendor Item ID',      d.VENDORITEMID],
      ['Is Set?',             d['Is set']],
      ['Set Code',            d['Set Code']],
      ['Set Colleague 1',     d['Set collegue 1']],
      ['Set Colleague 2',     d['Set collegue 2']],
      ['Set Colleague 3',     d['Set collegue 3']],
      ['Set Colleague 4',     d['Set collegue 4']],
      ['Set Colleague 5',     d['Set collegue 5']],
      ['Set Colleague 6',     d['Set collegue 6']],
      ['Set Colleague 7',     d['Set collegue 7']],
      ['Set Colleague 8',     d['Set collegue 8']],
      ['Set Colleague 9',     d['Set collegue 9']],
    ];

    // Two-column layout — available width is narrowed while image is beside us
    // Switch to full width once we've passed the image height
    const cellH  = 6;
    const tableW = imgX - M - 4;   // width left of image
    const hdrFrac = 0.42;

    // Left half of table (single-column beside the image)
    const colW_half  = tableW;
    const hdrW_half  = colW_half * hdrFrac;

    // How many rows fit beside the image?
    const rowsBesideImg = Math.floor((IMG_H + 4) / cellH);

    doc.setFontSize(7);
    let rowY = y;

    // Rows that sit beside the image (single column)
    const besideRows  = infoFields.slice(0, rowsBesideImg);
    const belowRows   = infoFields.slice(rowsBesideImg);

    besideRows.forEach((field, i) => {
      const ry = rowY + i * cellH;
      doc.setFillColor(...PALE);
      doc.rect(M, ry, hdrW_half, cellH, 'F');
      doc.setFillColor(...WHITE);
      doc.rect(M + hdrW_half, ry, colW_half - hdrW_half, cellH, 'F');
      doc.setDrawColor(214, 223, 240);
      doc.rect(M, ry, colW_half, cellH);
      doc.setFont('helvetica','bold'); doc.setTextColor(...ROYAL);
      doc.text(String(field[0]), M + 2, ry + 4, { maxWidth: hdrW_half - 3 });
      doc.setFont('helvetica','normal'); doc.setTextColor(...TEXT);
      doc.text(v(field[1]), M + hdrW_half + 2, ry + 4, { maxWidth: colW_half - hdrW_half - 3 });
    });

    // Position y after image (whichever is lower: image bottom or table of beside rows)
    y = Math.max(y + IMG_H + 8, rowY + besideRows.length * cellH) + 3;

    // Remaining rows — now use full width, two columns
    if (belowRows.length > 0) {
      const fullW  = W - 2 * M;
      const colW2  = fullW / 2;
      const hdrW2  = colW2 * hdrFrac;
      const half2  = Math.ceil(belowRows.length / 2);
      const left2  = belowRows.slice(0, half2);
      const right2 = belowRows.slice(half2);
      const rows2  = Math.max(left2.length, right2.length);

      for (let i = 0; i < rows2; i++) {
        const lf = left2[i]  || ['', ''];
        const rf = right2[i] || ['', ''];
        const ry = y + i * cellH;

        // Check page overflow
        if (ry + cellH > H - 20) { doc.addPage(); y = M; }

        doc.setFillColor(...PALE);
        doc.rect(M, ry, hdrW2, cellH, 'F');
        doc.setFillColor(...WHITE);
        doc.rect(M + hdrW2, ry, colW2 - hdrW2, cellH, 'F');
        doc.setFillColor(...PALE);
        doc.rect(M + colW2, ry, hdrW2, cellH, 'F');
        doc.setFillColor(...WHITE);
        doc.rect(M + colW2 + hdrW2, ry, colW2 - hdrW2, cellH, 'F');
        doc.setDrawColor(214, 223, 240);
        doc.rect(M, ry, colW2, cellH);
        doc.rect(M + colW2, ry, colW2, cellH);

        doc.setFont('helvetica','bold'); doc.setTextColor(...ROYAL);
        doc.text(String(lf[0]), M + 2, ry + 4, { maxWidth: hdrW2 - 3 });
        doc.text(String(rf[0]), M + colW2 + 2, ry + 4, { maxWidth: hdrW2 - 3 });
        doc.setFont('helvetica','normal'); doc.setTextColor(...TEXT);
        doc.text(v(lf[1]), M + hdrW2 + 2, ry + 4, { maxWidth: colW2 - hdrW2 - 3 });
        doc.text(v(rf[1]), M + colW2 + hdrW2 + 2, ry + 4, { maxWidth: colW2 - hdrW2 - 3 });
      }
      y += rows2 * cellH + 3;
    }

    // ─── PRODUCT SUB NAME (full-width highlight row) ───────────────
    if (y + 9 > H - 20) { doc.addPage(); y = M; }
    const psnH = 8;
    doc.setFillColor(253, 246, 227);
    doc.rect(M, y, W - 2 * M, psnH, 'F');
    doc.setDrawColor(...GOLD);
    doc.rect(M, y, W - 2 * M, psnH);
    doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...ROYAL_DEEP);
    doc.text('Product Sub Name', M + 3, y + 5.2);
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
    doc.text(v(d.PRODUCTSUBNAME), M + 52, y + 5.2, { maxWidth: W - 2 * M - 55 });
    y += psnH + 5;

    // ─── SET COLLEAGUE IMAGES ──────────────────────────────────────
    const collImages = [];
    for (let i = 1; i <= 9; i++) {
      const collSku = d[`Set collegue ${i}`];
      const collUrl = d[`Set collegue ${i} URL`];
      if (collUrl && v(collUrl) !== '—') collImages.push({ sku: collSku, url: collUrl });
    }

    if (collImages.length > 0) {
      if (y + 8 > H - 20) { doc.addPage(); y = M; }
      doc.setFillColor(...ROYAL_DEEP);
      doc.rect(M, y, W - 2 * M, 7, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...WHITE);
      doc.text('Set Colleague Images', M + 3, y + 5);
      y += 9;

      const CI_W = 36, CI_H = 36, CI_GAP = 4;
      let cx = M;
      for (const coll of collImages) {
        if (cx + CI_W > W - M) { cx = M; y += CI_H + 12; }
        if (y + CI_H > H - 20) { doc.addPage(); y = M; cx = M; }
        const cData = await fetchImageAsBase64(coll.url);
        if (cData) {
          try {
            const mm = cData.match(/^data:image\/(\w+);base64,/);
            const fmt = mm ? mm[1].toUpperCase().replace('JPG','JPEG') : 'JPEG';
            doc.setDrawColor(...ROYAL); doc.setLineWidth(0.3);
            doc.rect(cx, y, CI_W, CI_H);
            doc.addImage(cData, fmt, cx, y, CI_W, CI_H, undefined, 'FAST');
          } catch {}
        } else {
          doc.setDrawColor(...ROYAL); doc.setFillColor(...PALE);
          doc.rect(cx, y, CI_W, CI_H, 'FD');
        }
        doc.setFontSize(6); doc.setFont('helvetica','normal'); doc.setTextColor(...MUTED);
        doc.text(v(coll.sku), cx + CI_W / 2, y + CI_H + 4, { align: 'center', maxWidth: CI_W });
        cx += CI_W + CI_GAP;
      }
      y += CI_H + 12;
    }

    // ─── BOM TABLE ─────────────────────────────────────────────────
    const bom = d.BOM || [];
    if (bom.length > 0) {
      if (y + 16 > H - 20) { doc.addPage(); y = M; }

      doc.setFillColor(...ROYAL_DEEP);
      doc.rect(M, y, W - 2 * M, 7, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...WHITE);
      doc.text('Bill of Materials (BOM)', M + 3, y + 5);
      y += 7;

      // Col widths: Ingredient=36, Description=72(wider, no cut), Unit=16, Net Wt=28(right), Stone Qty=30(right)
      const bomCols = [
        { label: 'Ingredient Item', w: 36 },
        { label: 'Description',     w: 72 },
        { label: 'Unit',            w: 16 },
        { label: 'Net Wt',         w: 28, align: 'right' },
        { label: 'Stone Qty',       w: 30, align: 'right' },
      ];
      const bomH = 6.5;

      // Header row
      let bx = M;
      doc.setFillColor(...ROYAL);
      doc.rect(M, y, W - 2 * M, bomH, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...GOLD_LIGHT);
      bomCols.forEach(col => {
        col.align === 'right'
          ? doc.text(col.label, bx + col.w - 2, y + 4.5, { align: 'right' })
          : doc.text(col.label, bx + 2, y + 4.5);
        bx += col.w;
      });
      y += bomH;

      bom.forEach((row, ri) => {
        // Description: split into lines to avoid clipping
        doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
        const descText  = v(row.INGREDIENT_DESCRIPTION);
        const descLines = doc.splitTextToSize(descText, bomCols[1].w - 4);
        const rowH      = Math.max(bomH, descLines.length * 5.2);

        if (y + rowH > H - 20) { doc.addPage(); y = M; }
        doc.setFillColor(ri % 2 === 0 ? 255 : 240, ri % 2 === 0 ? 255 : 244, ri % 2 === 0 ? 255 : 251);
        doc.rect(M, y, W - 2 * M, rowH, 'F');
        doc.setDrawColor(214, 223, 240);
        doc.rect(M, y, W - 2 * M, rowH);

        let bx2 = M;
        doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(...TEXT);
        const vals = [
          v(row.ITEMID_BOM),
          descLines,   // array of wrapped lines
          v(row.INVENTUNIT),
          row.QTY !== null && row.QTY !== undefined ? parseFloat(row.QTY).toFixed(4) : '—',
          row.PDSCWQTY !== null && row.PDSCWQTY !== undefined ? parseFloat(row.PDSCWQTY).toFixed(4) : '—',
        ];
        const midY = y + rowH / 2 + 2;  // vertical centre of row
        bomCols.forEach((col, ci) => {
          if (ci === 1) {
            // Description: render each line, top-aligned
            doc.text(vals[ci], bx2 + 2, y + 4.5);
          } else if (col.align === 'right') {
            doc.text(vals[ci], bx2 + col.w - 2, midY, { align: 'right' });
          } else {
            doc.text(vals[ci], bx2 + 2, midY);
          }
          bx2 += col.w;
        });
        y += rowH;
      });

      // ── Net Wt / Gross Wt / Stone Qty summary rows ──
      if (y + bomH > H - 20) { doc.addPage(); y = M; }
      const _RAW_PDF = ['GRG','PRG','SRG','CRX'];
      let pdfNetWt = 0, pdfStoneWt = 0, pdfStoneQty = 0;
      bom.forEach(row => {
        const q = parseFloat(row.QTY);
        const u = (row.INVENTUNIT || '').trim().toUpperCase();
        const p = (row.ITEMID_BOM || '').trim().substring(0,3).toUpperCase();
        if (!isNaN(q)) {
          if (u === 'GMS' && _RAW_PDF.includes(p)) pdfNetWt   += q;
          else if (u === 'CTS')                     pdfStoneWt += q * 0.2;
        }
        const cw = parseFloat(row.PDSCWQTY);
        if (!isNaN(cw)) pdfStoneQty += cw;
      });
      const pdfGrossWt = pdfNetWt + pdfStoneWt;

      // Net Wt row (blue tint) — also shows Stone Qty sum in the Stone Qty column
      doc.setFillColor(240, 244, 251);
      doc.rect(M, y, W - 2 * M, bomH, 'F');
      doc.setDrawColor(...ROYAL);
      doc.rect(M, y, W - 2 * M, bomH);
      doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...ROYAL_DEEP);
      doc.text('Net Weight  (GRG / PRG / SRG metal lines)', M + 2, y + 4.5);
      const netWtStr = pdfNetWt > 0 ? pdfNetWt.toFixed(4) + ' g' : '—';
      // Net Wt under col 4 (Net Wt): x = M + 36+72+16 = M+124, width 28
      doc.text(netWtStr, M + 124 + 28 - 2, y + 4.5, { align: 'right' });
      // Stone Qty sum under col 5 (Stone Qty): x = M+152, width 30 — no unit suffix
      const stoneQtyStr = pdfStoneQty > 0 ? pdfStoneQty.toFixed(4) : '—';
      doc.text(stoneQtyStr, M + 152 + 30 - 2, y + 4.5, { align: 'right' });
      y += bomH;

      // Gross Wt row (gold tint)
      if (y + bomH > H - 20) { doc.addPage(); y = M; }
      doc.setFillColor(253, 246, 227);
      doc.rect(M, y, W - 2 * M, bomH, 'F');
      doc.setDrawColor(...GOLD);
      doc.rect(M, y, W - 2 * M, bomH);
      doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...ROYAL_DEEP);
      doc.text('Gross Weight  (Net Wt + Stones CTS x 0.2)', M + 2, y + 4.5);
      const grossWtStr = pdfGrossWt > 0 ? pdfGrossWt.toFixed(4) + ' g' : '—';
      doc.text(grossWtStr, M + 124 + 28 - 2, y + 4.5, { align: 'right' });
      y += bomH;
    }

    // ─── FOOTER ───────────────────────────────────────────────────
    doc.setFillColor(...ROYAL_DEEP);
    doc.rect(0, H - 10, W, 10, 'F');
    doc.setFillColor(...GOLD);
    doc.rect(0, H - 10, W, 0.8, 'F');
    doc.setFont('helvetica','normal'); doc.setFontSize(7);
    doc.setTextColor(...MUTED.map(c => Math.min(c + 80, 255)));
    doc.text(`Novel Jewels Ltd. — INDRIYA | Generated ${new Date().toLocaleDateString()}`, W / 2, H - 3.5, { align: 'center' });
  }

  const filename = skus.length === 1
    ? `PIS_${v(skus[0].ITEMID_SNQ)}.pdf`
    : `PIS_Batch_${skus.length}_SKUs.pdf`;
  doc.save(filename);
}