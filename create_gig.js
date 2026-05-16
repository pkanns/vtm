/**
 * create_gig.js — Vidai to Mulai · Create / Edit Gig
 * AUTH-06: Block Doer (rover) role from this page
 * AUTH-07: Pre-assign Lead to self when role is pacer
 * DB calls via vtm_api.js · Connection via vtm_db.js
 * UI helpers via vtm.js
 */

import { db }                                          from './assets/vtm_db.js'
import { fetchActiveRovers, fetchActivePacers,
         saveGig, updateGigStatus, fetchGigById }      from './assets/vtm_api.js'
import { esc }                                         from './assets/vtm_api.js'

// ── AUTH-06: Block Doer role ──────────────────────────────────────────────

const session    = vtmGetSession()
const role       = session?.role   || 'admin'
const refId      = session?.ref_id || null

if (role === 'rover') {
  // Doers cannot create or edit gigs
  showToast('Doers cannot create gigs', 'err')
  setTimeout(() => { window.location.href = 'index.html' }, 1200)
}

const urlGigId   = new URLSearchParams(window.location.search).get('gig_id')
const isEditMode = !!urlGigId

// ── LOAD DROPDOWNS ────────────────────────────────────────────────────────

async function loadDropdowns() {
  const [roversRes, pacersRes] = await Promise.all([
    fetchActiveRovers(db),
    fetchActivePacers(db)
  ])

  const roverSel = document.getElementById('gigRover')
  const pacerSel = document.getElementById('gigPacer')

  roverSel.innerHTML = '<option value="">— Select Doer —</option>' +
    (roversRes.data || []).map(r =>
      `<option value="${r.rover_id}">${esc(r.name)} (${r.skill_level})</option>`
    ).join('')

  // AUTH-07: If role is pacer, lock Lead dropdown to self
  if (role === 'pacer' && refId) {
    pacerSel.innerHTML = (pacersRes.data || [])
      .filter(p => p.pacer_id === refId)
      .map(p => `<option value="${p.pacer_id}" selected>${esc(p.name)}</option>`)
      .join('')
    pacerSel.disabled = true
    pacerSel.style.opacity = '0.6'
    pacerSel.title = 'Assigned to you as Lead'
  } else {
    pacerSel.innerHTML = '<option value="">— Select Lead —</option>' +
      (pacersRes.data || []).map(p =>
        `<option value="${p.pacer_id}">${esc(p.name)}</option>`
      ).join('')
  }
}

// ── EDIT MODE: pre-fill form ──────────────────────────────────────────────

async function loadGigForEdit(id) {
  const { data, error } = await fetchGigById(db, id)
  if (error || !data) { showToast('Could not load gig', 'err'); return }

  document.getElementById('editingGigId').value  = id
  document.getElementById('gigCode').value       = data.gig_code    || ''
  document.getElementById('gigName').value       = data.title       || ''
  document.getElementById('gigCategory').value   = data.category    || ''
  document.getElementById('gigDesc').value       = data.description || ''
  document.getElementById('gigDatePlaced').value = data.date_placed || ''
  document.getElementById('gigDateStart').value  = data.date_start  || ''
  document.getElementById('gigDateDue').value    = data.date_due    || ''
  document.getElementById('gigNotes').value      = data.notes       || ''

  // Show status selector in edit mode
  document.getElementById('statusRow').style.display = 'block'
  document.getElementById('gigStatus').value = data.status || 'placed'

  // Toggles
  if (data.setting)     setToggle('tog-setting',  data.setting)
  if (data.scale)       setToggle('tog-scale',    data.scale)
  if (data.cadence)     setToggle('tog-cadence',  data.cadence)
  if (data.skill_level) setToggle('tog-skill',    data.skill_level)

  // Rover / Pacer selects
  if (data.rover_id) {
    const sel = document.getElementById('gigRover')
    if (sel.querySelector(`option[value="${data.rover_id}"]`))
      sel.value = data.rover_id
  }

  // AUTH-07: only set pacer if admin (pacer is locked to self for Lead role)
  if (data.pacer_id && role !== 'pacer') {
    const sel = document.getElementById('gigPacer')
    if (sel.querySelector(`option[value="${data.pacer_id}"]`))
      sel.value = data.pacer_id
  }

  // UI cues
  document.getElementById('formTitle').textContent    = `Edit · ${data.gig_code}`
  document.getElementById('formSubtitle').textContent = data.title
  document.getElementById('editBanner').classList.add('visible')
  document.getElementById('saveBtn').textContent      = 'Update Gig →'

  toggleBudgetBlock()
}

// ── SAVE / UPDATE GIG ─────────────────────────────────────────────────────

window.saveGigForm = async function() {
  const code    = document.getElementById('gigCode').value.trim()
  const title   = document.getElementById('gigName').value.trim()
  const rover   = document.getElementById('gigRover').value
  const pacer   = document.getElementById('gigPacer').value
  const editId  = document.getElementById('editingGigId').value

  if (!code)  { showToast('Gig Code is required',   'err'); return }
  if (!title) { showToast('Gig Name is required',   'err'); return }
  if (!rover) { showToast('Please select a Doer',   'err'); return }
  if (!pacer) { showToast('Please select a Lead',   'err'); return }

  const payload = {
    gig_code:    code,
    title,
    category:    document.getElementById('gigCategory').value.trim() || null,
    description: document.getElementById('gigDesc').value.trim()     || null,
    rover_id:    rover,
    pacer_id:    pacer,
    setting:     getToggle('tog-setting')  || 'field',
    scale:       getToggle('tog-scale')    || 'minor',
    cadence:     getToggle('tog-cadence')  || 'oneoff',
    skill_level: getToggle('tog-skill')    || 'unskilled',
    status:      editId
                   ? (document.getElementById('gigStatus').value || 'placed')
                   : 'placed',
    date_placed: document.getElementById('gigDatePlaced').value || null,
    date_start:  document.getElementById('gigDateStart').value  || null,
    date_due:    document.getElementById('gigDateDue').value    || null,
    notes:       document.getElementById('gigNotes').value.trim() || null,
  }

  const budgetItems = getBudgetItems()
  if (budgetItems.length) {
    payload.budget_total = budgetItems.reduce((sum, i) => sum + i.estimatedCost, 0)
  }

  const { data: saved, error } = await saveGig(db, payload, editId || null)

  if (error) {
    showToast(
      error.message.includes('unique')
        ? 'Gig Code already exists'
        : 'Save failed — ' + error.message,
      'err'
    )
    return
  }

  if (editId) {
    showToast(`${code} updated`, 'ok')
    setTimeout(() => { window.location.href = 'gig_index.html' }, 1200)
  } else {
    const newGigId = Array.isArray(saved) ? saved[0]?.gig_id : saved?.gig_id
    showToast(`${code} saved`, 'ok')
    showPostSaveBar(code, newGigId)
    resetGigForm()
  }
}

// ── POST-SAVE BAR ─────────────────────────────────────────────────────────

function showPostSaveBar(code, gigId) {
  const bar      = document.getElementById('postSaveBar')
  const codeEl   = document.getElementById('postSaveCode')
  const matchBtn = document.getElementById('matchDoerBtn')
  codeEl.textContent = code
  bar.classList.add('visible')
  matchBtn.onclick = () => matchDoer(gigId, code)
}

async function matchDoer(gigId, code) {
  if (!gigId) { showToast('No gig ID — cannot match', 'err'); return }
  const { error } = await updateGigStatus(db, gigId, 'matched')
  if (error) { showToast('Could not update status', 'err'); return }
  showToast(`${code} → Matched`, 'ok')
  document.getElementById('postSaveBar').classList.remove('visible')
}

// ── RESET / CANCEL ────────────────────────────────────────────────────────

window.cancelEdit = function() {
  if (isEditMode) {
    window.location.href = 'gig_index.html'
    return
  }
  resetGigForm()
}

window.resetGigForm = function() {
  ;['gigCode','gigName','gigCategory','gigDesc',
    'gigDatePlaced','gigDateStart','gigDateDue','gigNotes']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = '' })

  ;['setup-tog-minor','setup-tog-oneoff','setup-tog-field','setup-tog-unskilled']
    .forEach(id => { const el = document.getElementById(id); if (el) el.checked = true })

  document.getElementById('editingGigId').value = ''
  document.getElementById('statusRow').style.display  = 'none'
  document.getElementById('editBanner').classList.remove('visible')
  document.getElementById('formTitle').textContent    = 'New Gig'
  document.getElementById('formSubtitle').textContent = 'Create a new work package'
  document.getElementById('saveBtn').textContent      = 'Save Gig →'

  const budgetBody = document.getElementById('budget-body')
  if (budgetBody) budgetBody.innerHTML = ''
  recalcBudget()
  addBudgetRow()

  document.getElementById('postSaveBar')?.classList.remove('visible')

  // AUTH-07: re-lock pacer dropdown if Lead role
  if (role === 'pacer') {
    const pacerSel = document.getElementById('gigPacer')
    if (pacerSel) pacerSel.value = refId
  }

  toggleBudgetBlock()
}

// ── INIT ──────────────────────────────────────────────────────────────────

await loadDropdowns()

if (isEditMode) {
  await loadGigForEdit(urlGigId)
} else {
  toggleBudgetBlock()
  addBudgetRow()
}
