/**
 * create_gig.js — Vidai to Mulai · Create / Edit Gig
 * Dropdowns load from vtm_users filtered by role.
 * gigs.pacer_id = Lead (vtm_users.user_id where role='pacer')
 * gigs.rover_id = Doer (vtm_users.user_id where role='rover')
 */

import { db }                                     from './assets/vtm_db.js'
import { saveGig, updateGigStatus, fetchGigById } from './assets/vtm_api.js'
import { esc }                                    from './assets/vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()
const role     = session?.role    || 'admin'
const myUserId = session?.user_id || null

// Rovers (Doers) cannot create gigs
if (role === 'rover') {
  showToast('Doers cannot create gigs', 'err')
  setTimeout(() => { window.location.href = 'index.html' }, 1200)
}

const urlGigId   = new URLSearchParams(window.location.search).get('gig_id')
const isEditMode = !!urlGigId

// ── LOAD DROPDOWNS from vtm_users ────────────────────────────────────────

async function loadDropdowns() {
  const [leadsRes, doersRes] = await Promise.all([
    db.from('vtm_users').select('user_id, name, skill_level')
      .eq('role', 'pacer').eq('active', true).order('name'),
    db.from('vtm_users').select('user_id, name, skill_level')
      .eq('role', 'rover').eq('active', true).order('name')
  ])

  const pacerSel = document.getElementById('gigPacer')
  const roverSel = document.getElementById('gigRover')

  // Doer (rover) dropdown
  roverSel.innerHTML = '<option value="">— Select Doer —</option>' +
    (doersRes.data || []).map(u =>
      `<option value="${u.user_id}">${esc(u.name)}${u.skill_level === 'skilled' ? ' ★' : ''}</option>`
    ).join('')

  // Lead (pacer) dropdown — locked to self if current user is a pacer
  if (role === 'pacer' && myUserId) {
    const me = (leadsRes.data || []).find(u => u.user_id === myUserId)
    pacerSel.innerHTML = me
      ? `<option value="${me.user_id}" selected>${esc(me.name)}</option>`
      : `<option value="${myUserId}" selected>${esc(session?.name || 'You')}</option>`
    pacerSel.disabled      = true
    pacerSel.style.opacity = '0.6'
    pacerSel.title         = 'Assigned to you as Lead'
  } else {
    pacerSel.innerHTML = '<option value="">— Select Lead —</option>' +
      (leadsRes.data || []).map(u =>
        `<option value="${u.user_id}">${esc(u.name)}</option>`
      ).join('')
  }
}

// ── EDIT MODE ─────────────────────────────────────────────────────────────

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

  document.getElementById('statusRow').style.display = 'block'
  document.getElementById('gigStatus').value = data.status || 'placed'

  if (data.setting)     setToggle('tog-setting', data.setting)
  if (data.scale)       setToggle('tog-scale',   data.scale)
  if (data.cadence)     setToggle('tog-cadence', data.cadence)
  if (data.skill_level) setToggle('tog-skill',   data.skill_level)

  // Set Doer
  if (data.rover_id) {
    const sel = document.getElementById('gigRover')
    if (sel.querySelector(`option[value="${data.rover_id}"]`))
      sel.value = data.rover_id
  }

  // Set Lead — admin only (pacer is locked to self)
  if (data.pacer_id && role !== 'pacer') {
    const sel = document.getElementById('gigPacer')
    if (sel.querySelector(`option[value="${data.pacer_id}"]`))
      sel.value = data.pacer_id
  }

  document.getElementById('formTitle').textContent    = `Edit · ${data.gig_code}`
  document.getElementById('formSubtitle').textContent = data.title
  document.getElementById('editBanner').classList.add('visible')
  document.getElementById('saveBtn').textContent      = 'Update Gig →'

  toggleBudgetBlock()
}

// ── SAVE / UPDATE ─────────────────────────────────────────────────────────

window.saveGigForm = async function() {
  const code   = document.getElementById('gigCode').value.trim()
  const title  = document.getElementById('gigName').value.trim()
  const rover  = document.getElementById('gigRover').value
  const pacer  = document.getElementById('gigPacer').value
  const editId = document.getElementById('editingGigId').value

  if (!code)  { showToast('Gig Code is required', 'err'); return }
  if (!title) { showToast('Gig Name is required', 'err'); return }
  if (!rover) { showToast('Please select a Doer', 'err'); return }
  if (!pacer) { showToast('Please select a Lead', 'err'); return }

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
  if (budgetItems.length)
    payload.budget_total = budgetItems.reduce((s, i) => s + i.estimatedCost, 0)

  const { data: saved, error } = await saveGig(db, payload, editId || null)

  if (error) {
    showToast(
      error.message.includes('unique') ? 'Gig Code already exists' : 'Save failed — ' + error.message,
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

// ── RESET ─────────────────────────────────────────────────────────────────

window.cancelEdit = function() {
  if (isEditMode) { window.location.href = 'gig_index.html'; return }
  resetGigForm()
}

window.resetGigForm = function() {
  ;['gigCode','gigName','gigCategory','gigDesc',
    'gigDatePlaced','gigDateStart','gigDateDue','gigNotes']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = '' })

  ;['setup-tog-minor','setup-tog-oneoff','setup-tog-field','setup-tog-unskilled']
    .forEach(id => { const el = document.getElementById(id); if (el) el.checked = true })

  document.getElementById('editingGigId').value = ''
  document.getElementById('statusRow').style.display = 'none'
  document.getElementById('editBanner').classList.remove('visible')
  document.getElementById('formTitle').textContent    = 'New Gig'
  document.getElementById('formSubtitle').textContent = 'Create a new work package'
  document.getElementById('saveBtn').textContent      = 'Save Gig →'

  const budgetBody = document.getElementById('budget-body')
  if (budgetBody) budgetBody.innerHTML = ''
  recalcBudget()
  addBudgetRow()

  document.getElementById('postSaveBar')?.classList.remove('visible')

  if (role === 'pacer' && myUserId) {
    const pacerSel = document.getElementById('gigPacer')
    if (pacerSel) pacerSel.value = myUserId
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
