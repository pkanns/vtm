/**
 * create_gig.js — Vidai to Mulai · Create Gig
 * Page-specific logic only.
 * All DB calls via vtm_api.js · Connection via vtm_db.js
 * UI helpers (toggles, budget, toast) via vtm.js
 */

import { db }                                          from './assets/vtm_db.js'
import { fetchActiveRovers, fetchActivePacers,
         fetchGigs, saveGig, deleteGig,
         fetchGigById, updateGigStatus }               from './assets/vtm_api.js'
import { fmtDate, esc }                                from './assets/vtm_api.js'

const statusEl = document.getElementById('dbStatus')

// ── LOAD DROPDOWNS ────────────────────────────────────────────────────────

async function loadDropdowns() {
  const [roversRes, pacersRes] = await Promise.all([
    fetchActiveRovers(db),
    fetchActivePacers(db)
  ])

  const roverSel = document.getElementById('gigRover')
  const pacerSel = document.getElementById('gigPacer')

  roverSel.innerHTML = '<option value="">-- Select Rover --</option>' +
    (roversRes.data || []).map(r =>
      `<option value="${r.rover_id}">${esc(r.name)} (${r.skill_level})</option>`
    ).join('')

  pacerSel.innerHTML = '<option value="">-- Select Pacer --</option>' +
    (pacersRes.data || []).map(p =>
      `<option value="${p.pacer_id}">${esc(p.name)}</option>`
    ).join('')
}

// ── LOAD GIG TABLE ────────────────────────────────────────────────────────

async function loadGigs() {
  const { data, error } = await fetchGigs(db)

  if (error) {
    statusEl.textContent = 'Could not connect — check credentials'
    statusEl.className = 'db-status err'
    return
  }

  statusEl.textContent = `● Connected · ${data.length} gig${data.length !== 1 ? 's' : ''}`
  statusEl.className = 'db-status ok'

  const tbody = document.getElementById('gigTableBody')
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No gigs yet — create one above.</div></td></tr>'
    return
  }

  tbody.innerHTML = data.map(g => `
    <tr>
      <td><strong style="font-family:var(--font-mono)">${esc(g.gig_code)}</strong></td>
      <td>${esc(g.title)}</td>
      <td style="color:var(--stone)">${esc(g.category || '—')}</td>
      <td style="text-transform:capitalize">${g.setting || '—'}</td>
      <td><span class="status-pill ${(g.status || 'placed')}">${fmtStatus(g.status)}</span></td>
      <td style="color:var(--stone);font-size:12px">${fmtDate(g.date_due)}</td>
      <td>
        <button class="tbl-btn" onclick="editGigRow('${g.gig_id}')">Edit</button>
        <button class="tbl-btn danger" onclick="deleteGigRow('${g.gig_id}','${esc(g.gig_code)}')">Delete</button>
        ${g.status === 'delivered' || g.status === 'in_progress'
          ? `<button class="tbl-btn" onclick="goToEval('${g.gig_id}')">Evaluate</button>`
          : ''}
      </td>
    </tr>
  `).join('')
}

// ── SAVE GIG ──────────────────────────────────────────────────────────────

window.saveGigForm = async function() {
  const code   = document.getElementById('gigCode').value.trim()
  const title  = document.getElementById('gigName').value.trim()
  const rover  = document.getElementById('gigRover').value
  const pacer  = document.getElementById('gigPacer').value
  const editId = document.getElementById('editingGigId').value

  if (!code)  { showToast('Gig Code is required',   'err'); return }
  if (!title) { showToast('Gig Name is required',   'err'); return }
  if (!rover) { showToast('Please select a Rover',  'err'); return }
  if (!pacer) { showToast('Please select a Pacer',  'err'); return }

  const payload = {
    gig_code:    code,
    title,
    category:    document.getElementById('gigCategory').value.trim()    || null,
    description: document.getElementById('gigDesc').value.trim()        || null,
    rover_id:    rover,
    pacer_id:    pacer,
    setting:     getToggle('tog-setting') || 'field',
    scale:       getToggle('tog-scale')   || 'minor',
    status:      document.getElementById('gigStatus').value,
    date_placed: document.getElementById('gigDatePlaced').value || null,
    date_start:  document.getElementById('gigDateStart').value  || null,
    date_due:    document.getElementById('gigDateDue').value    || null,
  }

  const { error } = await saveGig(db, payload, editId || null)

  if (error) {
    showToast(error.message.includes('unique') ? 'Gig Code already exists' : 'Save failed — ' + error.message, 'err')
    return
  }

  showToast(editId ? `${code} updated` : `${code} saved`, 'ok')

  // Export XLSX + brief as backup
  if (typeof exportGigToExcel  === 'function') exportGigToExcel()
  if (typeof generateGigBrief  === 'function') generateGigBrief(code)

  if (!editId) resetGigForm()
  else cancelGigEdit()
  loadGigs()
}

// ── EDIT ──────────────────────────────────────────────────────────────────

window.editGigRow = async function(id) {
  const { data, error } = await fetchGigById(db, id)
  if (error || !data) { showToast('Could not load gig', 'err'); return }

  document.getElementById('editingGigId').value  = id
  document.getElementById('gigCode').value       = data.gig_code
  document.getElementById('gigName').value       = data.title
  document.getElementById('gigCategory').value   = data.category    || ''
  document.getElementById('gigDesc').value       = data.description || ''
  document.getElementById('gigDatePlaced').value = data.date_placed || ''
  document.getElementById('gigDateStart').value  = data.date_start  || ''
  document.getElementById('gigDateDue').value    = data.date_due    || ''
  document.getElementById('gigStatus').value     = data.status      || 'placed'

  if (data.setting) setToggle('tog-setting', data.setting)
  if (data.scale)   setToggle('tog-scale',   data.scale)

  if (data.rover_id) {
    const sel = document.getElementById('gigRover')
    if (sel.querySelector(`option[value="${data.rover_id}"]`)) sel.value = data.rover_id
  }
  if (data.pacer_id) {
    const sel = document.getElementById('gigPacer')
    if (sel.querySelector(`option[value="${data.pacer_id}"]`)) sel.value = data.pacer_id
  }

  document.getElementById('editModeBanner').classList.add('visible')
  document.getElementById('formTitle').textContent       = `Editing ${data.gig_code}`
  document.getElementById('headerSub').textContent       = `Edit Gig · ${data.gig_code}`
  toggleBudgetBlock()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// ── DELETE ────────────────────────────────────────────────────────────────

window.deleteGigRow = async function(id, code) {
  if (!confirm(`Delete gig "${code}"? This cannot be undone.`)) return
  const { error } = await deleteGig(db, id)
  if (error) { showToast('Delete failed', 'err'); return }
  showToast(`${code} deleted`, 'ok')
  loadGigs()
}

// ── GO TO EVAL ────────────────────────────────────────────────────────────

window.goToEval = function(gigId) {
  window.location.href = `gig_eval.html?gig_id=${gigId}`
}

// ── CANCEL EDIT ───────────────────────────────────────────────────────────

window.cancelGigEdit = function() {
  document.getElementById('editingGigId').value = ''
  document.getElementById('editModeBanner').classList.remove('visible')
  document.getElementById('formTitle').textContent  = 'Gig Details'
  document.getElementById('headerSub').textContent  = 'Create New Gig'
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── INIT ──────────────────────────────────────────────────────────────────

await loadDropdowns()
loadGigs()
toggleBudgetBlock()
addBudgetRow()
