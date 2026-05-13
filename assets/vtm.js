/**
 * vtm.js — Vidai to Mulai · Shared Behaviours
 * Single source of truth for: gig_setup.html, gig_eval.html
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   1. STAR RATING + SLIDER SYNC
   ═══════════════════════════════════════════════════════════════ */

function syncStars(name, val) {
  const radios = document.getElementsByName(name);
  radios.forEach(radio => {
    if (parseInt(radio.value) === parseInt(val)) radio.checked = true;
  });
  const slider = document.getElementById('sl-' + name);
  if (slider) slider.value = val;
  if (typeof calcScores === 'function') calcScores();
}

function syncSlider(name, val) {
  const slider = document.getElementById('sl-' + name);
  if (slider) slider.value = val;
}

function getVal(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? parseFloat(checked.value) : null;
}

function setRating(name, val) {
  const radio = document.getElementById(name + val);
  if (radio) radio.checked = true;
  const slider = document.getElementById('sl-' + name);
  if (slider) slider.value = val;
}

/* ═══════════════════════════════════════════════════════════════
   2. TOGGLE HELPERS
   ═══════════════════════════════════════════════════════════════ */

function getToggle(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : null;
}

function setToggle(name, value) {
  const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (radio) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
  }
}

/* ═══════════════════════════════════════════════════════════════
   3. WEIGHTS + CONSTANTS
   ═══════════════════════════════════════════════════════════════ */

const VTM_WEIGHTS = {
  field: { cost: 0.33, quality: 0.33, timeline: 0.34 },
  desk:  { cost: 0.00, quality: 0.50, timeline: 0.50 },
};

const STAR_TO_PCT = { 1: 0, 2: 40, 3: 70, 4: 100, 5: 150 };
const BASE_REWARD  = { minor: 300, major: 1000 };

function interpolatePct(score) {
  if (score === null || isNaN(score)) return null;
  const keys = [1, 2, 3, 4, 5];
  for (let i = 0; i < keys.length - 1; i++) {
    if (score >= keys[i] && score <= keys[i + 1]) {
      const t = (score - keys[i]) / (keys[i + 1] - keys[i]);
      return STAR_TO_PCT[keys[i]] + t * (STAR_TO_PCT[keys[i + 1]] - STAR_TO_PCT[keys[i]]);
    }
  }
  return STAR_TO_PCT[5];
}

/* ═══════════════════════════════════════════════════════════════
   4. SETTING CHANGE (Field / Desk)
      Handles: weight display, cost row visibility, budget block
   ═══════════════════════════════════════════════════════════════ */

function onSettingChange() {
  const setting = getToggle('tog-setting') || 'field';
  const w = VTM_WEIGHTS[setting];

  // Budget block (gig_setup and gig_eval)
  const budgetBlock = document.getElementById('budgetBlock');
  if (budgetBlock) {
    budgetBlock.style.display = setting === 'field' ? 'block' : 'none';
  }

  // Cost row (gig_eval)
  const costRow = document.getElementById('costRow');
  if (costRow) costRow.classList.toggle('hidden', setting === 'desk');

  // Weight labels (gig_eval)
  const wCost     = document.getElementById('wCost');
  const wQuality  = document.getElementById('wQuality');
  const wTimeline = document.getElementById('wTimeline');
  if (wCost)     wCost.textContent     = w.cost > 0 ? Math.round(w.cost * 100) + '%' : '—';
  if (wQuality)  wQuality.textContent  = Math.round(w.quality * 100) + '%';
  if (wTimeline) wTimeline.textContent = Math.round(w.timeline * 100) + '%';

  if (typeof calcScores === 'function') calcScores();
}

// Alias used by gig_setup's inline onchange attributes
function toggleBudgetBlock() { onSettingChange(); }

/* ═══════════════════════════════════════════════════════════════
   5. EVALUATION SCORING
      Individual cells  → raw pacer rating  e.g. "3 ★"
      Dimension rows    → weighted average  e.g. "3.45 ★"
      Final block       → combined score, reward %, reward ₹
   ═══════════════════════════════════════════════════════════════ */

function calcScores() {
  const setting = getToggle('tog-setting') || 'field';
  const scale   = getToggle('tog-scale')   || 'minor';
  const w    = VTM_WEIGHTS[setting];
  const base = BASE_REWARD[scale];

  // --- D2: Engagement ---
  const d2p1r = getVal('d2p1rover'), d2p1p = getVal('d2p1pacer');
  const d2p2r = getVal('d2p2rover'), d2p2p = getVal('d2p2pacer');
  const d2p3r = getVal('d2p3rover'), d2p3p = getVal('d2p3pacer');

  _setRawCell('d2p1score', d2p1p);
  _setRawCell('d2p2score', d2p2p);
  _setRawCell('d2p3score', d2p3p);

  const d2RoverAvg = (d2p1r !== null && d2p2r !== null && d2p3r !== null)
    ? d2p1r * 0.33 + d2p2r * 0.33 + d2p3r * 0.34 : null;
  const d2PacerAvg = (d2p1p !== null && d2p2p !== null && d2p3p !== null)
    ? d2p1p * 0.33 + d2p2p * 0.33 + d2p3p * 0.34 : null;

  _setAvgCell('d2rover-avg', d2RoverAvg);
  _setAvgCell('d2pacer-avg', d2PacerAvg);
  _setAvgCell('d2final',     d2PacerAvg);

  // --- D3: Effectiveness ---
  const d3p1r = getVal('d3p1rover'), d3p1p = getVal('d3p1pacer');
  const d3p2r = getVal('d3p2rover'), d3p2p = getVal('d3p2pacer');
  const d3p3r = getVal('d3p3rover'), d3p3p = getVal('d3p3pacer');

  _setRawCell('d3p1score', setting === 'desk' ? null : d3p1p);
  _setRawCell('d3p2score', d3p2p);
  _setRawCell('d3p3score', d3p3p);

  let d3RoverAvg = null;
  let d3PacerAvg = null;

  if (setting === 'desk') {
    if (d3p2r !== null && d3p3r !== null)
      d3RoverAvg = d3p2r * w.quality + d3p3r * w.timeline;
    if (d3p2p !== null && d3p3p !== null)
      d3PacerAvg = d3p2p * w.quality + d3p3p * w.timeline;
  } else {
    if (d3p1r !== null && d3p2r !== null && d3p3r !== null)
      d3RoverAvg = d3p1r * w.cost + d3p2r * w.quality + d3p3r * w.timeline;
    if (d3p1p !== null && d3p2p !== null && d3p3p !== null)
      d3PacerAvg = d3p1p * w.cost + d3p2p * w.quality + d3p3p * w.timeline;
  }

  _setAvgCell('d3rover-avg', d3RoverAvg);
  _setAvgCell('d3pacer-avg', d3PacerAvg);
  _setAvgCell('d3final',     d3PacerAvg);

  // --- Final Score ---
  const starsEl = document.getElementById('finalStarsDisplay');
  const pctEl   = document.getElementById('finalPct');
  const rsEl    = document.getElementById('finalRs');

  if (d2PacerAvg !== null && d3PacerAvg !== null) {
    const final = d2PacerAvg * 0.5 + d3PacerAvg * 0.5;
    const pct   = interpolatePct(final);
    const rs    = Math.round(base * pct / 100);
    if (starsEl) starsEl.textContent = final.toFixed(2) + ' ★';
    if (pctEl)   pctEl.textContent   = pct.toFixed(1) + '%';
    if (rsEl)    rsEl.textContent    = '₹ ' + rs.toLocaleString('en-IN');
  } else {
    if (starsEl) starsEl.textContent = '— ★';
    if (pctEl)   pctEl.textContent   = '—%';
    if (rsEl)    rsEl.textContent    = '₹ —';
  }
}

// Raw pacer rating for individual attribute cells: "3 ★" or "—"
function _setRawCell(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val !== null ? val + ' ★' : '—';
}

// Weighted average for dimension summary cells: "3.45 ★" or "—"
function _setAvgCell(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val !== null ? val.toFixed(2) + ' ★' : '—';
}

/* ═══════════════════════════════════════════════════════════════
   6. BUDGET TABLE
   ═══════════════════════════════════════════════════════════════ */

let vtmBudgetRowId = 0;
let vtmDelivRowId  = 0;

function addBudgetRow(data) {
  const tbody = document.getElementById('budget-body');
  if (!tbody) return;
  const id = ++vtmBudgetRowId;
  const d  = data || {};
  const tr = document.createElement('tr');
  tr.id = 'brow-' + id;
  tr.innerHTML = `
    <td><input type="text"   class="desc-input"   placeholder="Description" value="${_esc(d.description || '')}"></td>
    <td><input type="number" class="amount-input" placeholder="0"            value="${d.estimatedCost || ''}" oninput="recalcBudget()"></td>
    <td><input type="text"   class="notes-inline" placeholder="Notes"        value="${_esc(d.notes || '')}"></td>
    <td><button type="button" class="del-btn" onclick="removeBudgetRow('brow-${id}')">×</button></td>
  `;
  tbody.appendChild(tr);
  recalcBudget();
}

function removeBudgetRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) row.remove();
  recalcBudget();
}

function recalcBudget() {
  const tbody = document.getElementById('budget-body');
  if (!tbody) return;

  let total = 0;
  tbody.querySelectorAll('.amount-input').forEach(input => {
    total += parseFloat(input.value) || 0;
  });

  const totalEl = document.getElementById('budget-total');
  if (totalEl) totalEl.textContent = '₹ ' + total.toLocaleString('en-IN');

  const actualEl = document.getElementById('budget-total-actual');
  if (actualEl) {
    let actualTotal = 0;
    tbody.querySelectorAll('.actual-cost').forEach(input => {
      actualTotal += parseFloat(input.value) || 0;
    });
    actualEl.textContent = actualTotal > 0 ? '₹ ' + actualTotal.toLocaleString('en-IN') : '—';
  }
}

function getBudgetItems() {
  const tbody = document.getElementById('budget-body');
  if (!tbody) return [];
  return Array.from(tbody.querySelectorAll('tr')).map(row => ({
    description:   (row.querySelector('.desc-input')   || {}).value || '',
    estimatedCost: parseFloat((row.querySelector('.amount-input') || {}).value) || 0,
    actualCost:    parseFloat((row.querySelector('.actual-cost')  || {}).value) || 0,
    notes:         (row.querySelector('.notes-inline') || {}).value || '',
  })).filter(item => item.description || item.estimatedCost);
}

/* ═══════════════════════════════════════════════════════════════
   7. DELIVERABLES LIST
   ═══════════════════════════════════════════════════════════════ */

function addDeliverable(value) {
  const list = document.getElementById('deliverable-list');
  if (!list) return;
  const id = ++vtmDelivRowId;
  const li = document.createElement('li');
  li.id = 'deliv-' + id;
  li.innerHTML = `
    <input type="text" placeholder="Deliverable" value="${_esc(value || '')}">
    <button type="button" class="del-btn" onclick="removeDeliverable('deliv-${id}')">×</button>
  `;
  list.appendChild(li);
}

function removeDeliverable(rowId) {
  const el = document.getElementById(rowId);
  if (el) el.remove();
}

function getDeliverables() {
  const list = document.getElementById('deliverable-list');
  if (!list) return [];
  return Array.from(list.querySelectorAll('input'))
    .map(i => i.value.trim())
    .filter(Boolean);
}

/* ═══════════════════════════════════════════════════════════════
   8. ODS / DATA LOADERS
   Strategy: fetch relative path first (works on server / SharePoint /
   Teams). If fetch fails (local file://, CORS, or 404), inject a
   small file-picker inline so the user can browse to the file.
   The same HTML works in both environments — no changes needed.
   ═══════════════════════════════════════════════════════════════ */

// Parse an ODS/XLSX Blob or File → array of row objects
async function readODSFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb   = XLSX.read(data, { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(ws, { defval: '' }));
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// Populate a <select> from an array of row objects
function _populateRoverSelect(sel, rows) {
  sel.innerHTML = '<option value="">-- Select Rover --</option>';
  rows.forEach(row => {
    if (row.active === 'TRUE' || row.active === true) {
      const opt = document.createElement('option');
      opt.value       = row.rover_id;
      opt.textContent = `${row.rover_name} (${row.skill_level})`;
      sel.appendChild(opt);
    }
  });
  if (sel.options.length === 1)
    sel.innerHTML = '<option value="">-- No active rovers --</option>';
}

function _populatePacerSelect(sel, rows) {
  sel.innerHTML = '<option value="">-- Select Pacer --</option>';
  rows.forEach(row => {
    if (row.active === 'TRUE' || row.active === true) {
      const opt = document.createElement('option');
      opt.value       = row.pacer_id;
      opt.textContent = row.pacer_name;
      sel.appendChild(opt);
    }
  });
  if (sel.options.length === 1)
    sel.innerHTML = '<option value="">-- No active pacers --</option>';
}

// Inject a file-picker fallback next to the select element
function _injectFilePicker(sel, filename, onRows) {
  // Don't add a second picker if one already exists
  if (document.getElementById('vtm-picker-' + sel.id)) return;

  sel.innerHTML = `<option value="">-- Select file below --</option>`;

  const wrapper = document.createElement('div');
  wrapper.id    = 'vtm-picker-' + sel.id;
  wrapper.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:8px;';

  const label = document.createElement('label');
  label.style.cssText   = 'font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--stone);white-space:nowrap;';
  label.textContent     = filename;

  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.ods,.xlsx,.xls';
  input.style.cssText = 'font-size:12px;color:var(--mid);';
  input.addEventListener('change', async () => {
    if (!input.files[0]) return;
    try {
      const rows = await readODSFile(input.files[0]);
      onRows(sel, rows);
      wrapper.remove();
      showToast('Loaded ' + input.files[0].name, 'ok');
    } catch (err) {
      showToast('Could not read ' + filename, 'err');
    }
  });

  wrapper.appendChild(label);
  wrapper.appendChild(input);
  sel.insertAdjacentElement('afterend', wrapper);
}

async function loadRovers(selectId = 'gigRover') {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Loading... --</option>';
  try {
    const response = await fetch('data/rovers.ods');
    if (!response.ok) throw new Error('fetch failed');
    const rows = await readODSFile(await response.blob());
    _populateRoverSelect(sel, rows);
  } catch (e) {
    // Relative fetch failed — offer file picker instead
    _injectFilePicker(sel, 'rovers.ods', _populateRoverSelect);
    showToast('Select rovers.ods to continue', 'err');
  }
}

async function loadPacers(selectId = 'gigPacer') {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Loading... --</option>';
  try {
    const response = await fetch('data/pacers.ods');
    if (!response.ok) throw new Error('fetch failed');
    const rows = await readODSFile(await response.blob());
    _populatePacerSelect(sel, rows);
  } catch (e) {
    // Relative fetch failed — offer file picker instead
    _injectFilePicker(sel, 'pacers.ods', _populatePacerSelect);
    showToast('Select pacers.ods to continue', 'err');
  }
}

/* ═══════════════════════════════════════════════════════════════
   9. LOAD GIG INTO EVAL (gig_eval.html)
      Reads a _gig_data.xlsx exported by gig_setup and pre-fills
      the eval form: meta fields, toggles, rover/pacer display.
   ═══════════════════════════════════════════════════════════════ */

async function loadGigFromExcel(input) {
  const file = input.files[0];
  if (!file) return;

  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb  = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          const ws  = wb.Sheets['Gig'];
          if (!ws) throw new Error('No Gig sheet found');
          // Sheet is [[key, value], ...] — convert to object
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          const obj  = {};
          rows.forEach(([k, v]) => { if (k) obj[String(k).trim()] = v; });
          resolve(obj);
        } catch (err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });

    // --- Fill meta fields ---
    _setInputVal('gigCode', data.gig_code);
    _setInputVal('gigName', data.gig_name);
    _setInputVal('gigDesc', data.description);

    // Rover / Pacer — eval uses readonly text inputs
    _setInputVal('roverDisplay', data.rover_id);
    _setInputVal('pacerDisplay', data.pacer_id);

    // Set today's date if blank
    const dateEl = document.getElementById('gigDate');
    if (dateEl && !dateEl.value)
      dateEl.value = new Date().toISOString().slice(0, 10);

    // --- Set toggles ---
    if (data.scale)       setToggle('tog-scale',   data.scale);
    if (data.cadence)     setToggle('tog-cadence',  data.cadence);
    if (data.setting)     setToggle('tog-setting',  data.setting);
    if (data.skill_level) setToggle('tog-skill',    data.skill_level);

    onSettingChange();
    if (typeof updateTitle === 'function') updateTitle();

    // --- Visual confirmation on the bar ---
    const bar = document.getElementById('loadGigBar');
    if (bar) {
      bar.classList.add('loaded');
      const label = bar.querySelector('.load-gig-label');
      if (label) label.textContent = `Loaded \u00b7 ${data.gig_code} \u2014 ${data.gig_name}`;
      const hint = bar.querySelector('.load-gig-hint');
      if (hint) hint.textContent = '';
    }

    showToast('Gig loaded — ready to evaluate', 'ok');

  } catch (err) {
    showToast('Could not read gig file', 'err');
    console.error('loadGigFromExcel:', err);
  }
}

/* ═══════════════════════════════════════════════════════════════
   10. GIG SETUP: EXPORT + RESET
   ═══════════════════════════════════════════════════════════════ */

function exportGigToExcel() {
  const code    = document.getElementById('gigCode')?.value.trim();
  const name    = document.getElementById('gigName')?.value.trim();
  const rover   = document.getElementById('gigRover')?.value;
  const pacer   = document.getElementById('gigPacer')?.value;
  const setting = getToggle('tog-setting') || 'field';

  if (!code)  { showToast('Gig Code is required',  'err'); return; }
  if (!name)  { showToast('Gig Name is required',  'err'); return; }
  if (!rover) { showToast('Please select a Rover', 'err'); return; }
  if (!pacer) { showToast('Please select a Pacer', 'err'); return; }

  const gigData = {
    gig_code:     code,
    gig_name:     name,
    category:     document.getElementById('gigCategory')?.value  || '',
    description:  document.getElementById('gigDesc')?.value      || '',
    rover_id:     rover,
    pacer_id:     pacer,
    status:       document.getElementById('gigStatus')?.value    || 'Placed',
    scale:        getToggle('tog-scale')   || 'minor',
    cadence:      getToggle('tog-cadence') || 'oneoff',
    setting:      setting,
    skill_level:  getToggle('tog-skill')   || 'unskilled',
    date_placed:  document.getElementById('gigDatePlaced')?.value || '',
    date_start:   document.getElementById('gigDateStart')?.value  || '',
    date_due:     document.getElementById('gigDateDue')?.value    || '',
    has_budget:   (setting === 'field').toString().toUpperCase(),
    deliverables: getDeliverables().join(', '),
    notes:        document.getElementById('gigNotes')?.value      || '',
    budget_total: 0,
  };

  const budgetItems = getBudgetItems();
  gigData.budget_total = budgetItems.reduce((sum, item) => sum + item.estimatedCost, 0);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(Object.entries(gigData)), 'Gig');

  if (budgetItems.length) {
    const rows = [['description', 'estimated_cost', 'actual_cost', 'notes']];
    budgetItems.forEach(item =>
      rows.push([item.description, item.estimatedCost, '', item.notes])
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'BudgetItems');
  }

  XLSX.writeFile(wb, `${code}_gig_data.xlsx`);
  showToast(`Exported ${code}_gig_data.xlsx`, 'ok');
}

function resetGigForm() {
  ['gigCode','gigName','gigCategory','gigDesc','gigDatePlaced','gigDateStart','gigDateDue','gigNotes']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

  const statusEl = document.getElementById('gigStatus');
  if (statusEl) statusEl.value = 'Placed';

  ['setup-tog-minor','setup-tog-oneoff','setup-tog-field','setup-tog-unskilled'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = true;
  });

  const budgetBody = document.getElementById('budget-body');
  if (budgetBody) budgetBody.innerHTML = '';

  const deliverableList = document.getElementById('deliverable-list');
  if (deliverableList) deliverableList.innerHTML = '';

  vtmBudgetRowId = 0;
  vtmDelivRowId  = 0;

  onSettingChange();
  recalcBudget();
  addBudgetRow();
}

function validateGigForm() {
  const missing = [];
  if (!_val('gigCode'))          missing.push('Gig Code');
  if (!_val('gigName'))          missing.push('Gig Name');
  if (!_val('gigRover'))         missing.push('Rover');
  if (!_val('gigPacer'))         missing.push('Pacer');
  if (!getToggle('tog-setting')) missing.push('Setting');
  if (!getToggle('tog-scale'))   missing.push('Scale');
  return missing;
}

function nextGigCode(existingGigs) {
  const nums = existingGigs
    .map(g => parseInt((g.gig_code || '').replace(/\D/g, ''), 10))
    .filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return 'G' + String(next).padStart(2, '0');
}

/* ═══════════════════════════════════════════════════════════════
   11. TOAST NOTIFICATION
   ═══════════════════════════════════════════════════════════════ */

let _toastTimer = null;

function showToast(msg, type, duration) {
  let toast = document.getElementById('vtm-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id        = 'vtm-toast';
    toast.className = 'vtm-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className   = 'vtm-toast vtm-toast--' + (type || 'ok');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('show'), duration || 2800);
}

/* ═══════════════════════════════════════════════════════════════
   12. UTILITIES
   ═══════════════════════════════════════════════════════════════ */

function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function _setInputVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value || '';
}

/* ═══════════════════════════════════════════════════════════════
   13. INIT
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  onSettingChange();
  if (typeof calcScores === 'function') calcScores();
});
