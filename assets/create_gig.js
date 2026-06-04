/**
 * create_gig.js — Vidai to Mulai · Create / Edit Gig V2
 * Project → Category → Cadence → auto-generates gig code
 * Recurring gigs create a recurrence_schedule row on save
 * Edit mode: load via ?gig_id=xxx
 * Pre-select project via ?project_id=xxx (from project_index)
 */

import { db }                          from './vtm_db.js'
import { fetchProjects,
         fetchCategoriesByProject,
         generateGigCode,
         saveGig,
         fetchGigById,
         updateGigStatus,
         saveRecurrenceSchedule,
         fetchActiveSchedules,
         deactivateSchedule,
         calcNextRunDate,
         fetchActiveLeads,
         fetchActiveDoers,
         esc }                         from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }

const role     = session.role
const myUserId = session.user_id

if (role === 'rover') {
  showToast('Doers cannot create gigs', 'err')
  setTimeout(() => { window.location.href = 'index.html' }, 1200)
  throw new Error('Rover blocked')
}

// ── URL PARAMS ────────────────────────────────────────────────────────────

const params      = new URLSearchParams(window.location.search)
const urlGigId    = params.get('gig_id')
const urlProjectId = params.get('project_id')
const isEditMode  = !!urlGigId

// ── STATE ─────────────────────────────────────────────────────────────────

let generatedGigCode = null   // the auto-generated code shown in preview
let currentScheduleId = null  // existing schedule id in edit mode

// ── LOAD DROPDOWNS ────────────────────────────────────────────────────────

async function loadDropdowns() {
  const [projRes, leadsRes, doersRes] = await Promise.all([
    fetchProjects(db),
    fetchActiveLeads(db),
    fetchActiveDoers(db),
  ])

  // Projects
  const projSel = document.getElementById('gigProject')
  projSel.innerHTML = '<option value="">— Select Project —</option>' +
    (projRes.data || []).map(p =>
      `<option value="${p.project_id}" data-code="${esc(p.project_code)}">${esc(p.project_code)} · ${esc(p.project_name)}</option>`
    ).join('')

  // Leads
  const pacerSel = document.getElementById('gigPacer')
  if (role === 'pacer' && myUserId) {
    const me = (leadsRes.data || []).find(u => u.user_id === myUserId)
    pacerSel.innerHTML = me
      ? `<option value="${me.user_id}" selected>${esc(me.name)}</option>`
      : `<option value="${myUserId}" selected>${esc(session.name || 'You')}</option>`
    pacerSel.disabled      = true
    pacerSel.style.opacity = '0.6'
    pacerSel.title         = 'Assigned to you as Lead'
  } else {
    pacerSel.innerHTML = '<option value="">— Select Lead —</option>' +
      (leadsRes.data || []).map(u =>
        `<option value="${u.user_id}">${esc(u.name)}</option>`
      ).join('')
  }

  // Doers
  const roverSel = document.getElementById('gigRover')
  roverSel.innerHTML = '<option value="">— Select Doer —</option>' +
    (doersRes.data || []).map(u =>
      `<option value="${u.user_id}">${esc(u.name)}${u.skill_level === 'skilled' ? ' ★' : ''}</option>`
    ).join('')
}

// ── PROJECT CHANGE → LOAD CATEGORIES ─────────────────────────────────────

window.onProjectChange = async function() {
  const projSel  = document.getElementById('gigProject')
  const projectId = projSel.value
  const catSel   = document.getElementById('gigCategory')

  catSel.innerHTML = '<option value="">— Loading —</option>'
  catSel.disabled  = true
  generatedGigCode = null
  updateCodeDisplay(null)

  if (!projectId) {
    catSel.innerHTML = '<option value="">— Select Category —</option>'
    return
  }

  const { data, error } = await fetchCategoriesByProject(db, projectId)
  if (error || !data?.length) {
    catSel.innerHTML = '<option value="">— No categories found —</option>'
    return
  }

  catSel.innerHTML = '<option value="">— Select Category —</option>' +
    data.map(c =>
      `<option value="${c.category_id}" data-code="${esc(c.category_code)}">${esc(c.category_code)} · ${esc(c.category_name)}</option>`
    ).join('')
  catSel.disabled = false

  await refreshGigCode()
}

// ── CADENCE CHANGE ────────────────────────────────────────────────────────

window.onCadenceChange = async function() {
  const isRecurring = document.querySelector('input[name="tog-cadence"]:checked')?.value === 'recurring'
  document.getElementById('recurringBlock').classList.toggle('visible', isRecurring)
  await refreshGigCode()
}

// ── CATEGORY CHANGE ───────────────────────────────────────────────────────

window.onCategoryChange = async function() {
  await refreshGigCode()
}

// ── GENERATE + DISPLAY GIG CODE ───────────────────────────────────────────

async function refreshGigCode() {
  // In edit mode the code is frozen — never regenerate
  if (isEditMode) return

  const projSel  = document.getElementById('gigProject')
  const catSel   = document.getElementById('gigCategory')
  const projOpt  = projSel.options[projSel.selectedIndex]
  const catOpt   = catSel.options[catSel.selectedIndex]

  const projectCode  = projOpt?.dataset.code  || ''
  const categoryCode = catOpt?.dataset.code   || ''
  const cadence      = document.querySelector('input[name="tog-cadence"]:checked')?.value || 'oneoff'

  if (!projectCode || !categoryCode) {
    updateCodeDisplay(null)
    return
  }

  const { code, error } = await generateGigCode(db, projectCode, categoryCode, cadence)
  if (error || !code) { updateCodeDisplay(null); return }

  generatedGigCode = code
  updateCodeDisplay(code, cadence)
}

function updateCodeDisplay(code, cadence) {
  const disp = document.getElementById('gigCodeDisplay')
  const hint = document.getElementById('gigCodeHint')

  if (!code) {
    disp.textContent = '— select project & category'
    disp.className   = 'code-preview-value dim'
    hint.textContent = ''
    return
  }

  disp.textContent = code
  disp.className   = 'code-preview-value'
  hint.textContent = cadence === 'recurring'
    ? `Instances will be ${code}_001, ${code}_002…`
    : ''
}

// ── EDIT MODE: LOAD GIG ───────────────────────────────────────────────────

async function loadGigForEdit(gigId) {
  const { data, error } = await fetchGigById(db, gigId)
  if (error || !data) { showToast('Could not load gig', 'err'); return }

  // Set project dropdown then load its categories
  const projSel = document.getElementById('gigProject')
  if (data.project_id) {
    projSel.value = data.project_id
    await onProjectChange()
  }

  // Set category
  if (data.category_id) {
    const catSel = document.getElementById('gigCategory')
    catSel.value = data.category_id
  }

  // Freeze the code display — show the existing code
  document.getElementById('gigCodeDisplay').textContent = data.gig_code || ''
  document.getElementById('gigCodeDisplay').className   = 'code-preview-value'
  document.getElementById('gigCodeHint').textContent    = 'Code is locked after creation'

  // Fields
  document.getElementById('gigName').value       = data.title       || ''
  document.getElementById('gigDesc').value       = data.description || ''
  document.getElementById('gigDatePlaced').value = data.date_placed || ''
  document.getElementById('gigDateStart').value  = data.date_start  || ''
  document.getElementById('gigDateDue').value    = data.date_due    || ''
  document.getElementById('gigNotes').value      = data.notes       || ''

  // Status row — only in edit mode
  document.getElementById('statusRow').style.display = 'block'
  document.getElementById('gigStatus').value = data.status || 'placed'

  // Toggles
  if (data.cadence)     setToggle('tog-cadence', data.cadence)
  if (data.scale)       setToggle('tog-scale',   data.scale)
  if (data.setting)     setToggle('tog-setting',  data.setting)
  if (data.skill_level) setToggle('tog-skill',    data.skill_level)

  // Show recurring block if recurring
  if (data.cadence === 'recurring') {
    document.getElementById('recurringBlock').classList.add('visible')
    document.getElementById('recurFrequency').value = data.recurrence_frequency || ''
    document.getElementById('recurEndDate').value   = data.recurrence_end_date  || ''
    document.getElementById('recurStopped').checked = data.recurrence_stopped   || false

    // Load existing schedule id
    const { data: scheds } = await fetchActiveSchedules(db)
    const sched = (scheds || []).find(s => s.parent_gig_id === gigId)
    if (sched) currentScheduleId = sched.schedule_id
  }

  // Dropdowns
  if (data.rover_id) {
    const sel = document.getElementById('gigRover')
    if (sel.querySelector(`option[value="${data.rover_id}"]`)) sel.value = data.rover_id
  }
  if (data.pacer_id && role !== 'pacer') {
    const sel = document.getElementById('gigPacer')
    if (sel.querySelector(`option[value="${data.pacer_id}"]`)) sel.value = data.pacer_id
  }

  // UI
  document.getElementById('formTitle').textContent    = `Edit · ${data.gig_code}`
  document.getElementById('formSubtitle').textContent = data.title
  document.getElementById('editBanner').classList.add('visible')
  document.getElementById('saveBtn').textContent      = 'Update Gig →'

  toggleBudgetBlock()
}

// ── SAVE ──────────────────────────────────────────────────────────────────

window.saveGigForm = async function() {
  const title   = document.getElementById('gigName').value.trim()
  const rover   = document.getElementById('gigRover').value
  const pacer   = document.getElementById('gigPacer').value
  const projSel = document.getElementById('gigProject')
  const catSel  = document.getElementById('gigCategory')
  const cadence = document.querySelector('input[name="tog-cadence"]:checked')?.value || 'oneoff'

  if (!projSel.value)      { showToast('Please select a Project',  'err'); return }
  if (!catSel.value)       { showToast('Please select a Category', 'err'); return }
  if (!title)              { showToast('Gig Title is required',    'err'); return }
  if (!pacer)              { showToast('Please select a Lead',     'err'); return }
  if (!rover)              { showToast('Please select a Doer',     'err'); return }

  if (cadence === 'recurring') {
    const freq = document.getElementById('recurFrequency').value
    if (!freq) { showToast('Please select a recurrence frequency', 'err'); return }
  }

  // In create mode the code comes from generation; in edit mode it's frozen
  const gigCode = isEditMode
    ? document.getElementById('gigCodeDisplay').textContent.trim()
    : generatedGigCode

  if (!gigCode || gigCode.startsWith('—')) {
    showToast('Could not generate gig code — check project & category', 'err')
    return
  }

  const btn = document.getElementById('saveBtn')
  btn.disabled    = true
  btn.textContent = 'Saving…'

  const payload = {
    gig_code:               gigCode,
    project_id:             projSel.value,
    category_id:            catSel.value,
    title,
    description:            document.getElementById('gigDesc').value.trim()      || null,
    pacer_id:               pacer,
    rover_id:               rover,
    cadence,
    scale:                  getToggle('tog-scale')   || 'minor',
    setting:                getToggle('tog-setting') || 'field',
    skill_level:            getToggle('tog-skill')   || 'unskilled',
    status:                 isEditMode
                              ? (document.getElementById('gigStatus').value || 'placed')
                              : 'placed',
    date_placed:            document.getElementById('gigDatePlaced').value || null,
    date_start:             document.getElementById('gigDateStart').value  || null,
    date_due:               document.getElementById('gigDateDue').value    || null,
    notes:                  document.getElementById('gigNotes').value.trim() || null,
    recurrence_frequency:   cadence === 'recurring' ? document.getElementById('recurFrequency').value : null,
    recurrence_end_date:    cadence === 'recurring' ? (document.getElementById('recurEndDate').value || null) : null,
    recurrence_stopped:     cadence === 'recurring' ? document.getElementById('recurStopped').checked : false,
  }

  const budgetItems = getBudgetItems()
  if (budgetItems.length)
    payload.budget_total = budgetItems.reduce((s, i) => s + i.estimatedCost, 0)

  const { data: saved, error } = await saveGig(db, payload, urlGigId || null)

  if (error) {
    showToast(
      error.message?.includes('unique') ? 'Gig code already exists' : 'Save failed — ' + error.message,
      'err'
    )
    btn.disabled    = false
    btn.textContent = isEditMode ? 'Update Gig →' : 'Save Gig →'
    return
  }

  const newGigId = isEditMode
    ? urlGigId
    : (Array.isArray(saved) ? saved[0]?.gig_id : saved?.gig_id)

  // Handle recurrence schedule
  if (cadence === 'recurring') {
    await saveOrUpdateSchedule(newGigId, rover, payload)
  } else if (isEditMode && currentScheduleId) {
    // Was recurring, now changed to oneoff — deactivate schedule
    await deactivateSchedule(db, currentScheduleId)
  }

  showToast(`${gigCode} ${isEditMode ? 'updated' : 'saved'}`, 'ok')
  setTimeout(() => { window.location.href = 'project_index.html' }, 1200)
}

// ── SAVE / UPDATE RECURRENCE SCHEDULE ────────────────────────────────────

async function saveOrUpdateSchedule(gigId, roverId, payload) {
  const freq    = payload.recurrence_frequency
  const endDate = payload.recurrence_end_date
  const stopped = payload.recurrence_stopped

  // If stopped, deactivate any existing schedule and return
  if (stopped && currentScheduleId) {
    await deactivateSchedule(db, currentScheduleId)
    return
  }
  if (stopped) return

  const startFrom  = payload.date_start || new Date().toISOString().split('T')[0]
  const nextRun    = calcNextRunDate(startFrom, freq)

  const schedPayload = {
    parent_gig_id:    gigId,
    frequency:        freq,
    next_run_date:    nextRun,
    end_date:         endDate || null,
    is_active:        true,
    current_rover_id: roverId,
  }

  await saveRecurrenceSchedule(db, schedPayload, currentScheduleId || null)
}

// ── RESET ─────────────────────────────────────────────────────────────────

window.cancelEdit = function() {
  window.location.href = 'project_index.html'
}

window.resetGigForm = function() {
  document.getElementById('gigProject').value    = ''
  document.getElementById('gigCategory').value   = ''
  document.getElementById('gigCategory').disabled = true
  document.getElementById('gigName').value        = ''
  document.getElementById('gigDesc').value        = ''
  document.getElementById('gigDatePlaced').value  = ''
  document.getElementById('gigDateStart').value   = ''
  document.getElementById('gigDateDue').value     = ''
  document.getElementById('gigNotes').value       = ''
  document.getElementById('recurFrequency').value = ''
  document.getElementById('recurEndDate').value   = ''
  document.getElementById('recurStopped').checked = false
  document.getElementById('recurringBlock').classList.remove('visible')
  document.getElementById('tog-oneoff').checked   = true
  document.getElementById('statusRow').style.display = 'none'
  document.getElementById('editBanner').classList.remove('visible')
  document.getElementById('formTitle').textContent    = 'New Gig'
  document.getElementById('formSubtitle').textContent = 'Create a new work package'
  document.getElementById('saveBtn').textContent      = 'Save Gig →'
  document.getElementById('saveBtn').disabled         = false

  generatedGigCode  = null
  currentScheduleId = null
  updateCodeDisplay(null)

  const budgetBody = document.getElementById('budget-body')
  if (budgetBody) budgetBody.innerHTML = ''
  recalcBudget()
  addBudgetRow()

  if (role === 'pacer' && myUserId) {
    const pacerSel = document.getElementById('gigPacer')
    if (pacerSel) pacerSel.value = myUserId
  }

  toggleBudgetBlock()
}

// ── INIT ──────────────────────────────────────────────────────────────────

await loadDropdowns()

// Pre-select project if passed via URL
if (urlProjectId && !isEditMode) {
  const projSel = document.getElementById('gigProject')
  projSel.value = urlProjectId
  await onProjectChange()
}

if (isEditMode) {
  await loadGigForEdit(urlGigId)
} else {
  toggleBudgetBlock()
  addBudgetRow()
}
