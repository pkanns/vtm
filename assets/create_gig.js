/**
 * create_gig.js — Vidai to Mulai · Create / Edit Gig V2
 * Project → Category → Cadence → auto-generates gig code
 * Recurring gigs create a recurrence_schedule row on save — UNLESS the
 * frequency is 'adhoc', in which case no schedule is written at all and
 * the gig becomes a reusable template instead (see ADHOC TEMPLATES below).
 * Edit mode: load via ?gig_id=xxx
 *
 * New-gig date defaults:
 *   Date Placed / Date Start → today, Date Due → today + 14 days.
 *   One-time fill only, on create mode load — fully editable afterward,
 *   no live recompute if the Lead changes Start Date later.
 *
 * STATUS DEFAULTS (pipeline entry point):
 *   A "master" gig is any recurring gig with no parent (cadence:'recurring'
 *   && !parent_gig_id) — this covers BOTH true adhoc templates and normal
 *   scheduled (weekly/fortnightly/monthly) recurring parents. Masters are
 *   never "worked" directly, only their spawned instances are, so they
 *   always enter — and stay — at 'placed'. The Status dropdown is locked
 *   in edit mode for masters (see loadGigForEdit) so nobody can manually
 *   advance one past Placed.
 *
 *   One-off gigs (cadence:'oneoff') already require both a Lead and a
 *   Doer before they can be saved at all, so there's no reason for them
 *   to sit in 'placed' — they default straight to 'matched' on create.
 *   (Instances spawned from a template get the same treatment — see
 *   spawnAdhocInstance() in vtm_api.js.)
 *
 * ADHOC TEMPLATES:
 *   Frequency 'adhoc' skips recurrence_schedule entirely — nothing runs
 *   automatically, so the daily cron (create_recurrences.py) never sees
 *   it. On first save (create mode only) one instance is spawned
 *   immediately via spawnAdhocInstance() so there's something to work
 *   with right away. Further instances are created later from
 *   project_index.html's "Create Gig from Template →" row action, which
 *   calls the same spawnAdhocInstance() helper in vtm_api.js.
 *
 * Tasks (edit mode only — a task needs a real gig_id to attach to):
 *   Option C "Compact Register Strip" checklist. Default assignee on
 *   creation is always the gig's Doer. Permission rules and row markup
 *   live in gig_tasks.js.
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
         spawnAdhocInstance,
         fetchActiveLeads,
         fetchActiveDoers,
         fetchUsersByIds,
         fetchTasksByGig,
         createTask,
         updateTask,
         toggleTaskDone,
         deleteTask,
         esc }                         from './vtm_api.js'
import { renderTaskCellCompact }       from './gig_tasks.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }

const role     = session.role
const myUserId = session.user_id

// ── URL PARAMS ────────────────────────────────────────────────────────────

const params      = new URLSearchParams(window.location.search)
const urlGigId    = params.get('gig_id')
const urlProjectId = params.get('project_id')
const isEditMode  = !!urlGigId

// Rovers (Doers) can edit gigs assigned to them, but cannot create new ones.
// Ownership is confirmed once the gig loads in loadGigForEdit().
if (role === 'rover' && !isEditMode) {
  showToast('Doers cannot create gigs', 'err')
  setTimeout(() => { window.location.href = 'dashboard.html' }, 1200)
  throw new Error('Rover blocked — create mode')
}

// ── STATE ─────────────────────────────────────────────────────────────────

let generatedGigCode = null   // the auto-generated code shown in preview
let currentScheduleId = null  // existing schedule id in edit mode

// Tasks — edit mode only
let currentGigTasks = []
let currentGigCtx   = null   // { gig_id, pacer_id, rover_id }
let currentGigNames = { pacerName: '—', roverName: '—' }

// ── DATE DEFAULTS (new-gig creation only) ───────────────────────────────

function applyNewGigDateDefaults() {
  const today = new Date()
  const due   = new Date(today)
  due.setDate(due.getDate() + 14)

  const toISO = d => d.toISOString().split('T')[0]

  document.getElementById('gigDatePlaced').value = toISO(today)
  document.getElementById('gigDateStart').value  = toISO(today)
  document.getElementById('gigDateDue').value    = toISO(due)
}

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
    if (role === 'rover') {
      pacerSel.disabled      = true
      pacerSel.style.opacity = '0.6'
      pacerSel.title         = 'Only a Lead or Admin can reassign'
    }
  }

  // Doers
  const roverSel = document.getElementById('gigRover')
  roverSel.innerHTML = '<option value="">— Select Doer —</option>' +
    (doersRes.data || []).map(u =>
      `<option value="${u.user_id}">${esc(u.name)}${u.skill_level === 'skilled' ? ' ★' : ''}</option>`
    ).join('')
  if (role === 'rover') {
    roverSel.disabled      = true
    roverSel.style.opacity = '0.6'
    roverSel.title         = 'Only a Lead or Admin can reassign'
  }
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

// ── FREQUENCY CHANGE — Adhoc hides scheduling-only fields ──────────────
// Adhoc templates never get a recurrence_schedule row, so End Date and
// Stop-recurrence (both schedule concepts) don't apply and stay hidden.

window.onFrequencyChange = function() {
  const freq    = document.getElementById('recurFrequency').value
  const isAdhoc = freq === 'adhoc'

  const endRow  = document.getElementById('recurEndDateRow')
  const stopRow = document.getElementById('recurStoppedRow')
  const hint    = document.getElementById('adhocHint')

  if (endRow)  endRow.style.display  = isAdhoc ? 'none' : ''
  if (stopRow) stopRow.style.display = isAdhoc ? 'none' : ''
  if (hint)    hint.classList.toggle('visible', isAdhoc)
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

  if (role === 'rover' && data.rover_id !== myUserId) {
    showToast('You can only edit gigs assigned to you', 'err')
    setTimeout(() => { window.location.href = 'dashboard.html' }, 1200)
    throw new Error('Rover blocked — not their gig')
  }

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

  // Status row — only in edit mode. A "master" gig (recurring, no
  // parent — covers both adhoc templates and scheduled recurring
  // parents) never moves past Placed, so its Status dropdown is locked
  // rather than left open to a manual override that would bypass the
  // rule everywhere else in the app.
  const isMaster = data.cadence === 'recurring' && !data.parent_gig_id
  const statusRow = document.getElementById('statusRow')
  const statusSel = document.getElementById('gigStatus')
  statusRow.style.display = 'block'
  statusSel.value    = isMaster ? 'placed' : (data.status || 'placed')
  statusSel.disabled = isMaster
  statusSel.title    = isMaster ? 'Recurring templates stay in Placed' : ''
  statusSel.style.opacity = isMaster ? '0.6' : ''

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
    onFrequencyChange()

    // Load existing schedule id — adhoc templates never have one, so this
    // simply won't find a match for them and currentScheduleId stays null.
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

  // Tasks need a real gig_id to attach to — only ever shown in edit mode
  document.getElementById('tasksCard').style.display = 'block'
  await loadGigTasks(gigId, data.pacer_id, data.rover_id)
}

// ── TASKS ─────────────────────────────────────────────────────────────────

async function loadGigTasks(gigId, pacerId, roverId) {
  currentGigCtx = { gig_id: gigId, pacer_id: pacerId, rover_id: roverId }

  const { data: users } = await fetchUsersByIds(db, [pacerId, roverId])
  const nameById = {}
  ;(users || []).forEach(u => { nameById[u.user_id] = u.name })
  currentGigNames = {
    pacerName: nameById[pacerId] || '—',
    roverName: nameById[roverId] || '—',
  }

  const { data, error } = await fetchTasksByGig(db, gigId)
  if (error) { showToast('Could not load tasks', 'err'); return }
  currentGigTasks = data || []
  renderTaskList()
}

function renderTaskList() {
  const body = document.getElementById('taskListBody')
  if (!currentGigTasks.length) {
    body.innerHTML = '<div class="gtask-empty">No tasks yet — add one below.</div>'
    return
  }
  body.innerHTML = currentGigTasks
    .map(t => renderTaskCellCompact(t, session, currentGigCtx, currentGigNames))
    .join('')
}

window.addGigTask = async function() {
  const input = document.getElementById('newTaskTitle')
  const title = input.value.trim()
  if (!title)        { showToast('Enter a task title', 'err'); return }
  if (!currentGigCtx) return

  // Default assignee is always the gig's Doer, regardless of who adds it
  const payload = {
    gig_id:      currentGigCtx.gig_id,
    title,
    assigned_to: currentGigCtx.rover_id,
    created_by:  myUserId,
    done:        false,
  }

  const { error } = await createTask(db, payload)
  if (error) { showToast('Could not add task — ' + error.message, 'err'); return }

  input.value = ''
  await loadGigTasks(currentGigCtx.gig_id, currentGigCtx.pacer_id, currentGigCtx.rover_id)
}

// ── EXTRACT TASKS FROM DESCRIPTION ─────────────────────────────────────────
// Reads whatever's currently in the Description textarea, one task per
// line. Strips common leading bullet/number markers so the task title
// comes out clean regardless of how the line was formatted. Lines that
// already match an existing task's title are skipped, so clicking this
// twice on the same description doesn't create duplicates.

function parseDescriptionLines(text) {
  return (text || '')
    .split('\n')
    .map(line => line.trim())
    .map(line => line.replace(/^[-•*]\s+/, '').replace(/^\d+[.)]\s+/, ''))
    .filter(line => line.length > 0)
}

window.extractTasksFromDescription = async function() {
  if (!currentGigCtx) return

  const desc  = document.getElementById('gigDesc').value
  const lines = parseDescriptionLines(desc)

  if (!lines.length) { showToast('Description is empty', 'err'); return }

  const existingTitles = new Set(currentGigTasks.map(t => t.title.trim().toLowerCase()))
  const newLines = lines.filter(l => !existingTitles.has(l.toLowerCase()))

  if (!newLines.length) { showToast('All lines are already on the checklist', 'err'); return }

  const count = newLines.length
  if (!confirm(`Add ${count} task${count !== 1 ? 's' : ''} from the description?`)) return

  const payloads = newLines.map(title => ({
    gig_id:      currentGigCtx.gig_id,
    title,
    assigned_to: currentGigCtx.rover_id,
    created_by:  myUserId,
    done:        false,
  }))

  const { error } = await createTask(db, payloads)
  if (error) { showToast('Could not add tasks — ' + error.message, 'err'); return }

  showToast(`Added ${count} task${count !== 1 ? 's' : ''}`, 'ok')
  await loadGigTasks(currentGigCtx.gig_id, currentGigCtx.pacer_id, currentGigCtx.rover_id)
}

window.toggleGigTask = async function(taskId, done) {
  const { error } = await toggleTaskDone(db, taskId, done)
  if (error) { showToast('Could not update task', 'err'); return }
  const t = currentGigTasks.find(x => x.task_id === taskId)
  if (t) t.done = done
  renderTaskList()
}

window.reassignGigTask = async function(taskId) {
  const t = currentGigTasks.find(x => x.task_id === taskId)
  if (!t || !currentGigCtx) return
  const newAssignee = t.assigned_to === currentGigCtx.pacer_id
    ? currentGigCtx.rover_id
    : currentGigCtx.pacer_id

  const { error } = await updateTask(db, taskId, { assigned_to: newAssignee })
  if (error) { showToast('Could not reassign task', 'err'); return }
  t.assigned_to = newAssignee
  renderTaskList()
}

window.deleteGigTask = async function(taskId) {
  if (!confirm('Delete this task?')) return
  const { error } = await deleteTask(db, taskId)
  if (error) { showToast('Could not delete task', 'err'); return }
  currentGigTasks = currentGigTasks.filter(x => x.task_id !== taskId)
  renderTaskList()
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

  let freqValue = null
  if (cadence === 'recurring') {
    freqValue = document.getElementById('recurFrequency').value
    if (!freqValue) { showToast('Please select a recurrence frequency', 'err'); return }
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

  // Status on create: a master gig (recurring, no parent — covers both
  // adhoc templates and scheduled recurring parents) always enters at
  // 'placed' and stays there. A one-off gig already has both Lead and
  // Doer confirmed by the checks above, so there's nothing left to wait
  // on — it enters straight at 'matched'. In edit mode, the Status
  // dropdown is authoritative (and is itself locked to 'placed' for
  // masters — see loadGigForEdit).
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
                              : (cadence === 'recurring' ? 'placed' : 'matched'),
    date_placed:            document.getElementById('gigDatePlaced').value || null,
    date_start:             document.getElementById('gigDateStart').value  || null,
    date_due:               document.getElementById('gigDateDue').value    || null,
    notes:                  document.getElementById('gigNotes').value.trim() || null,
    recurrence_frequency:   cadence === 'recurring' ? freqValue : null,
    recurrence_end_date:    (cadence === 'recurring' && freqValue !== 'adhoc')
                               ? (document.getElementById('recurEndDate').value || null)
                               : null,
    recurrence_stopped:     (cadence === 'recurring' && freqValue !== 'adhoc')
                               ? document.getElementById('recurStopped').checked
                               : false,
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

  // Handle recurrence — scheduled frequencies get a recurrence_schedule
  // row same as before; adhoc gets none, ever, and instead spawns its
  // first instance right away (create mode only — re-saving an existing
  // template on edit shouldn't spawn a new instance every time).
  let finalMsg  = `${gigCode} ${isEditMode ? 'updated' : 'saved'}`
  let finalType = 'ok'

  if (cadence === 'recurring' && freqValue === 'adhoc') {
    if (isEditMode && currentScheduleId) {
      await deactivateSchedule(db, currentScheduleId)
      currentScheduleId = null
    }
    if (!isEditMode) {
      const { data: instance, error: instErr } = await spawnAdhocInstance(db, newGigId)
      if (instErr) {
        finalMsg  = `${gigCode} saved as template, but first instance failed — ${instErr.message}`
        finalType = 'err'
      } else if (instance) {
        finalMsg = `${gigCode} saved as template · first instance ${instance.gig_code} created`
      }
    }
  } else if (cadence === 'recurring') {
    await saveOrUpdateSchedule(newGigId, rover, payload)
  } else if (isEditMode && currentScheduleId) {
    // Was recurring, now changed to oneoff — deactivate schedule
    await deactivateSchedule(db, currentScheduleId)
  }

  showToast(finalMsg, finalType)
  // Gigs stay the foreground view — land back on the Gig Index, pre-filtered
  // to this gig's project via the filter it already supports, rather than
  // bouncing out to the Projects list every time.
  setTimeout(() => { window.location.href = `gig_index.html?project=${projSel.value}` }, 1200)
}

// ── SAVE / UPDATE RECURRENCE SCHEDULE ────────────────────────────────────
// Only ever called for scheduled frequencies (weekly/fortnightly/monthly)
// — adhoc never reaches here, see saveGigForm() above.

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
  const projSel = document.getElementById('gigProject')
  window.location.href = projSel?.value ? `gig_index.html?project=${projSel.value}` : 'gig_index.html'
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
  onFrequencyChange()
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

  // New-gig date defaults reapply on reset too, same as first load.
  applyNewGigDateDefaults()
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
  applyNewGigDateDefaults()
  toggleBudgetBlock()
  addBudgetRow()
  onFrequencyChange()
}
