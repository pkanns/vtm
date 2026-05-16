/**
 * vtm.js — Vidai to Mulai · Shared Behaviours
 * Single source of truth for all pages.
 *
 * Sections:
 *  0. AUTH GUARD + SESSION
 *  1. STAR RATING + SLIDER SYNC
 *  2. TOGGLE HELPERS
 *  3. WEIGHTS + CONSTANTS
 *  4. SETTING CHANGE
 *  5. EVALUATION SCORING
 *  6. BUDGET TABLE
 *  7. DELIVERABLES LIST
 *  8. TOAST NOTIFICATION
 *  9. UTILITIES
 * 10. INIT
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   0. AUTH GUARD + SESSION
   ═══════════════════════════════════════════════════════════════ */

// Pages that do NOT require authentication
const _PUBLIC_PAGES = ['login.html'];

// Role → UI label mapping
const VTM_ROLE_LABELS = {
  admin: 'Admin',
  pacer: 'Lead',
  rover: 'Doer',
};

// Role → pill colour class
const VTM_ROLE_CLASS = {
  admin: 'role-admin',
  pacer: 'role-pacer',
  rover: 'role-rover',
};

/**
 * Returns the current session object from sessionStorage.
 * { role, name, user_id, ref_id, email } or null
 */
function vtmGetSession() {
  const role = sessionStorage.getItem('vtm_role');
  if (!role) return null;
  return {
    role:    role,
    name:    sessionStorage.getItem('vtm_name')    || '',
    user_id: sessionStorage.getItem('vtm_user_id') || '',
    ref_id:  sessionStorage.getItem('vtm_ref_id')  || '',
    email:   sessionStorage.getItem('vtm_email')   || '',
  };
}

/**
 * Clears session and signs out of Supabase, then redirects to login.
 * Called by the Sign out button.
 */
function vtmSignOut() {
  sessionStorage.clear();
  
  // Sign out via Supabase client dynamically imported
  import('https://esm.sh/@supabase/supabase-js@2').then(({ createClient }) => {
    const db = createClient(
      'https://dbecwjhsewucqtfgoylv.supabase.co',
      'sb_publishable_aw39P_0nn4vB0yjfDqwEvw_mU-Hc1Sp'
    );
    db.auth.signOut().finally(() => {
      window.location.href = 'login.html';
    });
  }).catch(() => {
    // If import fails, still redirect
    window.location.href = 'login.html';
  });
}

/**
 * Auth guard — injects header user info if session exists.
 * Does NOT redirect — redirection is handled by each page's
 * module JS after db.auth.getSession() resolves asynchronously.
 * Safe to call multiple times — replaces existing header-user element.
 */
function vtmAuthGuard() {
  const page = window.location.pathname.split('/').pop() || 'index.html';

  // Skip entirely on public pages
  if (_PUBLIC_PAGES.some(p => page.endsWith(p))) return;

  const session = vtmGetSession();

  // If session exists inject header — if not, module JS will redirect
  if (session) {
    _vtmInjectHeaderUser(session);
  }
}

/**
 * Injects role pill + name + logout into the header.
 * Replaces .header-sub or .header-user if already present.
 */
function _vtmInjectHeaderUser(session) {
  const header = document.querySelector('header');
  if (!header) return;

  // Remove any existing injected user element first
  const existingUser = header.querySelector('.header-user');
  if (existingUser) existingUser.remove();

  // Also remove static subtitle if present
  const existingSub = header.querySelector('.header-sub');

  const roleLabel = VTM_ROLE_LABELS[session.role] || session.role;

  const userEl = document.createElement('div');
  userEl.className = 'header-user';
  userEl.innerHTML = `
    <span class="header-role-pill ${VTM_ROLE_CLASS[session.role]}">${roleLabel}</span>
    <span class="header-user-name">${_esc(session.name)}</span>
    <button class="header-logout" onclick="vtmSignOut()">Sign out</button>
  `;

  if (existingSub) {
    existingSub.replaceWith(userEl);
  } else {
    header.appendChild(userEl);
  }

  // Inject styles once
  if (!document.getElementById('vtm-auth-styles')) {
    const style = document.createElement('style');
    style.id = 'vtm-auth-styles';
    style.textContent = `
      .header-user {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .header-role-pill {
        font-size: 9px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        padding: 3px 8px;
        font-weight: 600;
        font-family: var(--font-mono, monospace);
      }
      .role-admin { background: rgba(247,246,242,0.15); color: var(--white, #f7f6f2); }
      .role-pacer { background: var(--red, #c0392b);    color: var(--white, #f7f6f2); }
      .role-rover { background: var(--green, #2d5a3d);  color: var(--white, #f7f6f2); }
      .header-user-name {
        font-size: 12px;
        color: rgba(247,246,242,0.6);
        font-family: var(--font-body, sans-serif);
      }
      .header-logout {
        background: none;
        border: 1px solid rgba(247,246,242,0.2);
        color: rgba(247,246,242,0.4);
        padding: 4px 10px;
        font-size: 10px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        cursor: pointer;
        font-family: var(--font-body, sans-serif);
        transition: border-color 0.2s, color 0.2s;
      }
      .header-logout:hover {
        border-color: rgba(247,246,242,0.5);
        color: var(--white, #f7f6f2);
      }
    `;
    document.head.appendChild(style);
  }
}

/**
 * Role-based visibility helper.
 * Hides element if current role not in allowedRoles.
 * Usage: vtmGuardElement(document.getElementById('deleteBtn'), ['admin'])
 */
function vtmGuardElement(el, allowedRoles) {
  if (!el) return;
  const session = vtmGetSession();
  if (!session || !allowedRoles.includes(session.role)) {
    el.style.display = 'none';
  }
}

/**
 * Role-based page guard.
 * Redirects to index.html if current role not in allowedRoles.
 * Usage: vtmGuardPage(['pacer', 'admin'])
 */
function vtmGuardPage(allowedRoles) {
  const session = vtmGetSession();
  if (!session || !allowedRoles.includes(session.role)) {
    showToast('Access restricted for your role', 'err');
    setTimeout(() => { window.location.href = 'index.html'; }, 1200);
  }
}

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
   ═══════════════════════════════════════════════════════════════ */

function onSettingChange() {
  const setting = getToggle('tog-setting') || 'field';
  const w = VTM_WEIGHTS[setting];

  const budgetBlock = document.getElementById('budgetBlock');
  if (budgetBlock) {
    budgetBlock.style.display = setting === 'field' ? 'block' : 'none';
  }

  const costRow = document.getElementById('costRow');
  if (costRow) costRow.classList.toggle('hidden', setting === 'desk');

  const wCost     = document.getElementById('wCost');
  const wQuality  = document.getElementById('wQuality');
  const wTimeline = document.getElementById('wTimeline');
  if (wCost)     wCost.textContent     = w.cost > 0 ? Math.round(w.cost * 100) + '%' : '—';
  if (wQuality)  wQuality.textContent  = Math.round(w.quality * 100) + '%';
  if (wTimeline) wTimeline.textContent = Math.round(w.timeline * 100) + '%';

  if (typeof calcScores === 'function') calcScores();
}

function toggleBudgetBlock() { onSettingChange(); }

/* ═══════════════════════════════════════════════════════════════
   5. EVALUATION SCORING
   ═══════════════════════════════════════════════════════════════ */

function calcScores() {
  const setting = getToggle('tog-setting') || 'field';
  const scale   = getToggle('tog-scale')   || 'minor';
  const w    = VTM_WEIGHTS[setting];
  const base = BASE_REWARD[scale];

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

function _setRawCell(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val !== null ? val + ' ★' : '—';
}

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
    <tr><input type="text"   class="desc-input"   placeholder="Description" value="${_esc(d.description || '')}"></td>
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
}

function getBudgetItems() {
  const tbody = document.getElementById('budget-body');
  if (!tbody) return [];
  return Array.from(tbody.querySelectorAll('tr')).map(row => ({
    description:   (row.querySelector('.desc-input')   || {}).value || '',
    estimatedCost: parseFloat((row.querySelector('.amount-input') || {}).value) || 0,
    notes:         (row.querySelector('.notes-inline') || {}).value || '',
  })).filter(item => item.description || item.estimatedCost);
}

/* ═══════════════════════════════════════════════════════════════
   7. DELIVERABLES LIST (parked for MVP)
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
   8. TOAST NOTIFICATION
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
   9. UTILITIES
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
   10. INIT
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  // Try to inject header from sessionStorage immediately.
  // If sessionStorage is empty, module JS will repopulate it
  // and call vtmAuthGuard() again after db.auth.getSession() resolves.
  vtmAuthGuard();

  onSettingChange();
  if (typeof calcScores === 'function') calcScores();
});