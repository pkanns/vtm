/**
 * vtm.js — Vidai to Mulai · Shared UI Behaviours
 * UI-only: scoring, toggles, budget, toasts, utilities.
 * Auth, session, idle timeout → vtm_auth_guard.js
 *
 * Sections:
 *  0. SESSION UTILITIES
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
   0. SESSION UTILITIES
   Read-only helpers — auth guard lives in vtm_auth_guard.js
   ═══════════════════════════════════════════════════════════════ */

function vtmGetSession() {
  const role = sessionStorage.getItem('vtm_role');
  if (!role) return null;
  return {
    role,
    name:    sessionStorage.getItem('vtm_name')    || '',
    user_id: sessionStorage.getItem('vtm_user_id') || '',
    ref_id:  sessionStorage.getItem('vtm_ref_id')  || '',
    email:   sessionStorage.getItem('vtm_email')   || '',
  };
}

function vtmGuardElement(el, allowedRoles) {
  if (!el) return;
  const session = vtmGetSession();
  if (!session || !allowedRoles.includes(session.role)) el.style.display = 'none';
}

function vtmGuardPage(allowedRoles) {
  const session = vtmGetSession();
  if (!session || !allowedRoles.includes(session.role)) {
    showToast('Access restricted for your role', 'err');
    setTimeout(() => { window.location.href = 'dashboard.html'; }, 1200);
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
  if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
}

/* ═══════════════════════════════════════════════════════════════
   3. WEIGHTS + CONSTANTS
   (Reward logic removed — pricing is a separate module)
   ═══════════════════════════════════════════════════════════════ */

const VTM_WEIGHTS = {
  field: { cost: 0.33, quality: 0.33, timeline: 0.34 },
  desk:  { cost: 0.00, quality: 0.50, timeline: 0.50 },
};

/* ═══════════════════════════════════════════════════════════════
   4. SETTING CHANGE (Field / Desk)
   ═══════════════════════════════════════════════════════════════ */

function onSettingChange() {
  const setting = getToggle('tog-setting') || 'field';
  const w = VTM_WEIGHTS[setting];

  const budgetBlock = document.getElementById('budgetBlock');
  if (budgetBlock) budgetBlock.style.display = setting === 'field' ? 'block' : 'none';

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
   Final score = Lead (Pacer) weighted average only.
   D2 (Engagement) 50% + D3 (Effectiveness) 50%.
   Rover self-ratings shown for reference — not in final score.
   No reward calculation — pricing is a separate module.
   ═══════════════════════════════════════════════════════════════ */

function calcScores() {
  const setting = getToggle('tog-setting') || 'field';
  const w = VTM_WEIGHTS[setting];

  // ── D2: Engagement ────────────────────────────────────────────
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

  // ── D3: Effectiveness ─────────────────────────────────────────
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

  // ── Final score — Lead weighted average only ──────────────────
  const starsEl = document.getElementById('finalStarsDisplay');

  if (d2PacerAvg !== null && d3PacerAvg !== null) {
    const final = d2PacerAvg * 0.5 + d3PacerAvg * 0.5;
    if (starsEl) starsEl.textContent = final.toFixed(2) + ' ★';
  } else {
    if (starsEl) starsEl.textContent = '— ★';
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
    <td><input type="text"   class="desc-input"   placeholder="Description" value="${_esc(d.description || '')}"></td>
    <td><input type="number" class="amount-input" placeholder="0"           value="${d.estimatedCost || ''}" oninput="recalcBudget()"></td>
    <td><input type="text"   class="notes-inline" placeholder="Notes"       value="${_esc(d.notes || '')}"></td>
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
  tbody.querySelectorAll('.amount-input').forEach(input => { total += parseFloat(input.value) || 0; });
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
  return Array.from(list.querySelectorAll('input')).map(i => i.value.trim()).filter(Boolean);
}

/* ═══════════════════════════════════════════════════════════════
   8. TOAST NOTIFICATION
   ═══════════════════════════════════════════════════════════════ */

let _toastTimer = null;

function showToast(msg, type, duration) {
  let toast = document.getElementById('vtm-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'vtm-toast';
    toast.className = 'vtm-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className   = 'vtm-toast vtm-toast--' + (type || 'ok');
  requestAnimationFrame(() => { requestAnimationFrame(() => toast.classList.add('show')); });
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
   10. HEADER INJECTION + SIGN OUT (replaces vtm_auth_guard.js) - ADDED DEEPSEEK
   ═══════════════════════════════════════════════════════════════ */

function vtmInjectHeader(session) {
  if (!session || !session.role) return;
  
  const header = document.querySelector('header');
  if (!header) return;

  const existing = header.querySelector('.header-user');
  if (existing) existing.remove();
  
  const existingSub = header.querySelector('.header-sub');
  
  const roleLabels = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' };
  const roleClass = { admin: 'role-admin', pacer: 'role-pacer', rover: 'role-rover' };
  const roleLabel = roleLabels[session.role] || session.role;
  
  const userEl = document.createElement('div');
  userEl.className = 'header-user';
  userEl.innerHTML = `
    <span class="header-role-pill ${roleClass[session.role]}">${_esc(roleLabel)}</span>
    <span class="header-user-name">${_esc(session.name)}</span>
    <button class="header-logout" onclick="vtmSignOut()">Sign out</button>
  `;
  
  if (existingSub) existingSub.replaceWith(userEl);
  else header.appendChild(userEl);

  if (!document.getElementById('vtm-auth-styles')) {
    const style = document.createElement('style');
    style.id = 'vtm-auth-styles';
    style.textContent = `
      .header-user { display:flex; align-items:center; gap:12px; }
      .header-role-pill { font-size:9px; letter-spacing:0.12em; text-transform:uppercase;
        padding:3px 8px; font-weight:600; font-family:var(--font-mono,monospace); }
      .role-admin { background:rgba(247,246,242,0.15); color:var(--white,#f7f6f2); }
      .role-pacer { background:var(--red,#c0392b);     color:var(--white,#f7f6f2); }
      .role-rover { background:var(--green,#2d5a3d);   color:var(--white,#f7f6f2); }
      .header-user-name { font-size:12px; color:rgba(247,246,242,0.6);
        font-family:var(--font-body,sans-serif); }
      .header-logout { background:none; border:1px solid rgba(247,246,242,0.2);
        color:rgba(247,246,242,0.4); padding:4px 10px; font-size:10px;
        letter-spacing:0.1em; text-transform:uppercase; cursor:pointer;
        font-family:var(--font-body,sans-serif); transition:border-color 0.2s,color 0.2s; }
      .header-logout:hover { border-color:rgba(247,246,242,0.5); color:var(--white,#f7f6f2); }
    `;
    document.head.appendChild(style);
  }
}

function vtmSignOut() {
  sessionStorage.clear();
  // Try to sign out of Supabase if db exists
  if (typeof db !== 'undefined' && db && db.auth) {
    db.auth.signOut().catch(() => {});
  }
  window.location.replace('login.html');
}
window.vtmSignOut = vtmSignOut;

/* ═══════════════════════════════════════════════════════════════
   11. INIT
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  onSettingChange();
  if (typeof calcScores === 'function') calcScores();
});
