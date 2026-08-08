/**
 * timesheet.js — Vidai to Mulai · Timesheet
 * Rewritten: toggle Auto/Manual, project→gig cascade,
 * Open Timesheets (null end_time), midnight-safe duration via DB,
 * auto-close guard on sign-out, owner+admin edit.
 *
 * Added: ?start=auto URL support — the dashboard's Clock block links here
 * with that flag when the person isn't clocked in yet, so this page drops
 * them straight into the Auto panel instead of the blank toggle state.
 */

import { db } from './vtm_db.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

const userId   = session.user_id
const isAdmin  = session.role === 'admin'
const TODAY    = new Date().toISOString().split('T')[0]

// ── STATE ─────────────────────────────────────────────────────────────────

let activeEntry   = null
let allEntries    = []
let openEntries   = []
let currentFilter = 'week'
let gigMap        = {}   // gig_id → { code, title, project_id }
let projectMap    = {}   // project_id → { code, name }
let editingEntryId = null // entry_id currently open for editing in the Time Log

// ── INIT ──────────────────────────────────────────────────────────────────

document.getElementById('manualDate').value = TODAY

await loadGigs()
await loadProjects()
await checkActiveTimer()
await loadEntries()
initToggle()
applyStartParam()
patchSignOut()
buildPunchStrip()

// ── ?start=auto — hand-off from the dashboard's Clock block ───────────────
// Only applies if there isn't already an active timer (matches what
// picking "Auto" manually would do anyway — it's blocked while clocked in).

function applyStartParam() {
  const startParam = new URLSearchParams(window.location.search).get('start')
  if (startParam !== 'auto' || activeEntry) return

  const autoRadio = document.getElementById('tog-auto')
  if (!autoRadio) return
  autoRadio.checked = true
  showEntryPanel('auto')
}

// ── PUNCH STRIP (decorative — mirrors the mulai.ch register motif) ────────

function buildPunchStrip() {
  const strip = document.getElementById('topPunchStrip')
  if (!strip) return
  const pattern = [1,0,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,0,1,1,0,2,0,1,0,0,1,0,1]
  for (let s = 0; s < 2; s++) {
    const div = document.createElement('div')
    div.className = 'punch-holes' + (s === 1 ? ' punch-holes-2' : '')
    for (let r = 0; r < 6; r++) {
      pattern.forEach(p => {
        const h = document.createElement('div')
        h.className = 'hole' + (p === 1 ? ' punched' : p === 2 ? ' punched red' : '')
        div.appendChild(h)
      })
    }
    strip.appendChild(div)
  }
}

// ── PATCH SIGN-OUT to warn about active timer ─────────────────────────────

function patchSignOut() {
  window._vtmSignOutOriginal = window.vtmSignOut
  window.vtmSignOut = async function() {
    if (activeEntry) {
      const go = confirm('You have an active timer running. Sign out anyway? The timer will keep running and auto-close after 24 hours.')
      if (!go) return
    }
    await window._vtmSignOutOriginal()
  }
}

// ── TOGGLE INIT ───────────────────────────────────────────────────────────

function initToggle() {
  document.querySelectorAll('input[name="tog-entry"]').forEach(radio => {
    radio.addEventListener('change', onToggleChange)
  })
  // Start with nothing shown
  showEntryPanel(null)
}

function onToggleChange() {
  const val = getToggle('tog-entry')
  showEntryPanel(val)
}

function showEntryPanel(mode) {
  const autoPanel   = document.getElementById('autoPanel')
  const manualPanel = document.getElementById('manualPanel')
  const blocked     = document.getElementById('manualBlocked')

  autoPanel.style.display   = 'none'
  manualPanel.style.display = 'none'
  if (blocked) blocked.style.display = 'none'

  if (mode === 'auto') {
    // Auto blocked if already clocked in
    if (activeEntry) {
      showToast('Already clocked in — clock out first', 'err')
      // Deselect toggle
      document.querySelectorAll('input[name="tog-entry"]').forEach(r => r.checked = false)
      return
    }
    autoPanel.style.display = 'block'
  }

  if (mode === 'manual') {
    manualPanel.style.display = 'block'
  }
}

// ── LOAD PROJECTS ─────────────────────────────────────────────────────────

async function loadProjects() {
  const { data, error } = await db
    .from('projects')
    .select('project_id, project_code, project_name')
    .order('project_code')

  if (error || !data?.length) return

  // Doers and leads only see projects that contain at least one of their own
  // gigs — the gig dropdown was already scoped in loadGigs(), this keeps the
  // project filter from ever pointing them at a project with nothing in it.
  let visible = data
  if (!isAdmin) {
    const ownProjectIds = new Set(Object.values(gigMap).map(g => g.project_id))
    visible = data.filter(p => ownProjectIds.has(p.project_id))
  }

  projectMap = {}
  visible.forEach(p => { projectMap[p.project_id] = { code: p.project_code, name: p.project_name } })

  const blankOpt = '<option value="">— All Projects —</option>'
  const opts = blankOpt + visible.map(p =>
    `<option value="${p.project_id}">${esc(p.project_code)} · ${esc(p.project_name)}</option>`
  ).join('')

  const autoProj   = document.getElementById('autoProject')
  const manualProj = document.getElementById('manualProject')
  if (autoProj)   autoProj.innerHTML   = opts
  if (manualProj) manualProj.innerHTML = opts
}

// ── LOAD GIGS ─────────────────────────────────────────────────────────────

async function loadGigs() {
  let query = db.from('gigs')
    .select('gig_id, gig_code, title, project_id, status, pacer_id, rover_id')
    .not('status', 'eq', 'completed')
    .order('gig_code')

  if (session.role === 'pacer') query = query.eq('pacer_id', userId)
  if (session.role === 'rover') query = query.eq('rover_id', userId)

  const { data, error } = await query
  if (error || !data?.length) return

  gigMap = {}
  data.forEach(g => {
    gigMap[g.gig_id] = { code: g.gig_code, title: g.title, project_id: g.project_id }
  })

  populateGigDropdown('autoGig',   null)
  populateGigDropdown('manualGig', null)
}

function populateGigDropdown(selectId, projectId) {
  const select = document.getElementById(selectId)
  if (!select) return

  const gigs = Object.entries(gigMap)
    .filter(([, g]) => !projectId || g.project_id === projectId)
    .map(([id, g]) => ({ id, ...g }))

  if (!gigs.length) {
    select.innerHTML = '<option value="">— No gigs —</option>'
    return
  }

  select.innerHTML = '<option value="">— Select Gig —</option>' +
    gigs.map(g => `<option value="${g.id}">${esc(g.code)} · ${esc(g.title)}</option>`).join('')
}

// Project filter cascades to gig dropdown
window.onProjectChange = function(sourceId, targetId) {
  const projectId = document.getElementById(sourceId).value || null
  populateGigDropdown(targetId, projectId)
}

// Gig select → mini "Card No." + status display in the panel header
window.updateCardNo = function(gigSelectId, cardNoTargetId, statusTargetId) {
  const gigId = document.getElementById(gigSelectId)?.value
  const target = document.getElementById(cardNoTargetId)
  const status = statusTargetId ? document.getElementById(statusTargetId) : null
  if (!target) return
  const gig = gigId ? gigMap[gigId] : null
  target.textContent = gig ? gig.code : '— : —'
  if (status) status.textContent = gig ? '● Ready' : '○ Awaiting'
}

// ── CHECK ACTIVE TIMER ────────────────────────────────────────────────────

async function checkActiveTimer() {
  const { data } = await db
    .from('time_entries')
    .select('*, gigs(gig_code, title)')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle()

  if (data) {
    activeEntry = data
    showActiveTimer(data)
  } else {
    hideActiveTimer()
  }
}

function showActiveTimer(entry) {
  const gig    = entry.gigs || gigMap[entry.gig_id] || {}
  const code   = gig.gig_code || gig.code || '—'
  const title  = gig.title    || '—'
  const timeIn = entry.start_time ? entry.start_time.slice(0,5) : '—'

  const card = document.getElementById('activeTimerBlock')
  document.getElementById('timerGigCode').textContent  = code
  document.getElementById('timerGigTitle').textContent = title
  document.getElementById('timerClockIn').textContent  = timeIn

  const notesEl = document.getElementById('activeNotes')
  notesEl.value = entry.notes || ''

  card.style.display = 'block'

  const pill  = document.getElementById('headerTimerPill')
  const label = document.getElementById('headerTimerLabel')
  if (pill)  pill.classList.add('visible')
  if (label) label.textContent = `In · ${timeIn}`
}

function hideActiveTimer() {
  document.getElementById('activeTimerBlock').style.display = 'none'
  document.getElementById('activeNotes').value = ''

  const pill = document.getElementById('headerTimerPill')
  if (pill) pill.classList.remove('visible')
  activeEntry = null
}

// ── CLOCK IN ──────────────────────────────────────────────────────────────

window.clockIn = async function() {
  const gigId = document.getElementById('autoGig').value
  if (!gigId) { showToast('Please select a gig', 'err'); return }

  const btn = document.getElementById('clockInBtn')
  btn.disabled    = true
  btn.textContent = 'Clocking in…'

  let lat = null, lng = null, locationLabel = null
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 })
    })
    lat = pos.coords.latitude
    lng = pos.coords.longitude
    locationLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`
  } catch {
    locationLabel = 'Denied'
  }

  const now       = new Date()
  const startTime = now.toTimeString().slice(0,5)
  const notes     = document.getElementById('autoNotesIn')?.value.trim() || null

  const payload = {
    gig_id:         gigId,
    user_id:        userId,
    entry_date:     TODAY,
    start_time:     startTime,
    entry_type:     'live',
    is_active:      true,
    clock_in_lat:   lat,
    clock_in_lng:   lng,
    location_label: locationLabel,
    notes:          notes,
  }

  const { data, error } = await db.from('time_entries').insert(payload).select().single()

  if (error) {
    showToast('Clock in failed — ' + error.message, 'err')
    btn.disabled    = false
    btn.textContent = 'Clock In →'
    return
  }

  activeEntry = { ...data, gigs: gigMap[gigId] ? { gig_code: gigMap[gigId].code, title: gigMap[gigId].title } : null }
  showActiveTimer(activeEntry)

  // Reset toggle and hide auto panel
  document.querySelectorAll('input[name="tog-entry"]').forEach(r => r.checked = false)
  showEntryPanel(null)
  document.getElementById('autoGig').value = ''
  document.getElementById('autoNotesIn').value = ''
  updateCardNo('autoGig', 'autoCardNo', 'autoCardStatus')

  showToast('Clocked in ✓', 'ok')
  await loadEntries()

  btn.disabled    = false
  btn.textContent = 'Clock In →'
}

// ── CLOCK OUT ─────────────────────────────────────────────────────────────

window.clockOut = async function() {
  if (!activeEntry) return

  const btn = document.getElementById('clockOutBtn')
  btn.disabled    = true
  btn.textContent = 'Clocking out…'

  let lat = null, lng = null
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 })
    })
    lat = pos.coords.latitude
    lng = pos.coords.longitude
  } catch { /* denied — ok */ }

  const now     = new Date()
  const endTime = now.toTimeString().slice(0,5)
  const notes   = document.getElementById('activeNotes')?.value.trim() || activeEntry.notes || null

  // No duration calc — DB generated column handles it including midnight crossover
  const { error } = await db
    .from('time_entries')
    .update({
      end_time:      endTime,
      is_active:     false,
      clock_out_lat: lat,
      clock_out_lng: lng,
      notes:         notes,
    })
    .eq('entry_id', activeEntry.entry_id)

  if (error) {
    showToast('Clock out failed — ' + error.message, 'err')
    btn.disabled    = false
    btn.textContent = 'Clock Out →'
    return
  }

  showToast('Clocked out ✓', 'ok')
  hideActiveTimer()
  await loadEntries()
}

// ── MANUAL SAVE ───────────────────────────────────────────────────────────

window.saveManual = async function() {
  const gigId = document.getElementById('manualGig').value
  const date  = document.getElementById('manualDate').value
  const start = document.getElementById('manualStart').value
  const end   = document.getElementById('manualEnd').value     // optional
  const notes = document.getElementById('manualNotes').value.trim()

  if (!gigId) { showToast('Please select a gig',       'err'); return }
  if (!date)  { showToast('Please enter a date',       'err'); return }
  if (!start) { showToast('Please enter a start time', 'err'); return }

  const btn = document.getElementById('manualSaveBtn')
  btn.disabled    = true
  btn.textContent = 'Saving…'

  if (editingEntryId) {
    const { error } = await db.from('time_entries').update({
      gig_id:     gigId,
      entry_date: date,
      start_time: start,
      end_time:   end || null,
      notes:      notes || null,
      entry_type: 'manual',
    }).eq('entry_id', editingEntryId)

    if (error) {
      showToast('Update failed — ' + error.message, 'err')
      btn.disabled    = false
      btn.textContent = 'Save Changes →'
      return
    }

    showToast('Entry updated ✓', 'ok')
    resetManual()
    await loadEntries()
    return
  }

  const { error } = await db.from('time_entries').insert({
    gig_id:     gigId,
    user_id:    userId,
    entry_date: date,
    start_time: start,
    end_time:   end   || null,
    entry_type: 'manual',
    is_active:  false,
    notes:      notes || null,
  })

  if (error) {
    showToast('Save failed — ' + error.message, 'err')
    btn.disabled    = false
    btn.textContent = 'Save →'
    return
  }

  showToast(end ? 'Time logged ✓' : 'Entry saved — add end time later ✓', 'ok')
  btn.disabled    = false
  btn.textContent = 'Save →'
  resetManual()
  await loadEntries()
}

// ── EDIT OPEN ENTRY (save updated times/notes) ────────────────────────────

window.saveOpenEntry = async function(entryId) {
  const startEl = document.getElementById(`oe-start-${entryId}`)
  const endEl   = document.getElementById(`oe-end-${entryId}`)
  const dateEl  = document.getElementById(`oe-date-${entryId}`)
  const notesEl = document.getElementById(`oe-notes-${entryId}`)

  const start = startEl?.value || null
  const end   = endEl?.value   || null
  const date  = dateEl?.value  || null
  const notes = notesEl?.value.trim() || null

  if (!start) { showToast('Start time required', 'err'); return }

  const btn = document.getElementById(`oe-btn-${entryId}`)
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…' }

  const { error } = await db
    .from('time_entries')
    .update({
      entry_date: date,
      start_time: start,
      end_time:   end || null,
      notes:      notes,
    })
    .eq('entry_id', entryId)

  if (error) {
    showToast('Update failed — ' + error.message, 'err')
    if (btn) { btn.disabled = false; btn.textContent = 'Save →' }
    return
  }

  showToast(end ? 'Entry completed ✓' : 'Entry updated ✓', 'ok')
  await loadEntries()
}

// ── LOAD ENTRIES ──────────────────────────────────────────────────────────

async function loadEntries() {
  let query = db
    .from('time_entries')
    .select('*, gigs(gig_code, title)')
    .eq('is_active', false)
    .order('entry_date', { ascending: false })
    .order('start_time', { ascending: false })

  // Admin sees all; others see own
  if (!isAdmin) query = query.eq('user_id', userId)

  const { data, error } = await query

  const statusEl = document.getElementById('dbStatus')

  if (error) {
    statusEl.textContent = 'Could not load entries'
    statusEl.className   = 'db-status err'
    return
  }

  const all = data || []

  // Split: open = no end_time, done = has end_time
  openEntries = all.filter(e => !e.end_time)
  allEntries  = all.filter(e =>  e.end_time)

  statusEl.textContent = `● ${allEntries.length} entr${allEntries.length !== 1 ? 'ies' : 'y'}`
  statusEl.className   = 'db-status ok'

  renderOpenEntries()
  renderEntries()
}

// ── RENDER OPEN TIMESHEETS ────────────────────────────────────────────────

function renderOpenEntries() {
  const container = document.getElementById('openEntriesBody')
  if (!container) return

  const section = document.getElementById('openSection')

  if (!openEntries.length) {
    if (section) section.style.display = 'none'
    return
  }

  if (section) section.style.display = 'block'

  container.innerHTML = openEntries.map(e => {
    const gig      = e.gigs || {}
    const code     = gig.gig_code || '—'
    const isAuto   = e.entry_type === 'live'
    const autoNote = e.notes?.includes('Auto-closed') ? '<span class="auto-closed-badge">Auto-closed</span>' : ''

    return `
      <div class="open-entry" id="open-${e.entry_id}">
        <div class="open-entry-header">
          <span class="gig-code-pill">${esc(code)}</span>
          <span class="open-entry-title">${esc(gig.title || '')}</span>
          ${autoNote}
          <span class="type-badge ${isAuto ? 'live' : 'manual'}">${isAuto ? 'live' : 'manual'}</span>
        </div>
        <div class="open-entry-fields">
          <div class="form-row">
            <label>Date</label>
            <input type="date" id="oe-date-${e.entry_id}" value="${e.entry_date || ''}">
          </div>
          <div class="form-row">
            <label>Start</label>
            <input type="time" id="oe-start-${e.entry_id}" value="${(e.start_time || '').slice(0,5)}">
          </div>
          <div class="form-row">
            <label>End</label>
            <input type="time" id="oe-end-${e.entry_id}" value="${(e.end_time || '').slice(0,5)}">
          </div>
          <div class="form-row open-notes">
            <label>Notes</label>
            <input type="text" id="oe-notes-${e.entry_id}" value="${esc(e.notes || '')}" placeholder="What did you work on?">
          </div>
        </div>
        <div class="open-entry-actions">
          <button class="btn-save" id="oe-btn-${e.entry_id}" onclick="saveOpenEntry('${e.entry_id}')">Save →</button>
          <button class="btn-delete" onclick="deleteEntry('${e.entry_id}')">Delete</button>
        </div>
      </div>`
  }).join('')
}

// ── RENDER COMPLETED LOG ──────────────────────────────────────────────────

function renderEntries() {
  const now   = new Date(); now.setHours(0,0,0,0)
  const list  = document.getElementById('logList')

  // Week starts Monday
  const weekStart = new Date(now)
  const day = weekStart.getDay()
  weekStart.setDate(weekStart.getDate() + ((day === 0) ? -6 : 1 - day))

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const filtered = allEntries.filter(e => {
    const d = new Date(e.entry_date); d.setHours(0,0,0,0)
    if (currentFilter === 'week')  return d >= weekStart
    if (currentFilter === 'month') return d >= monthStart
    return true
  })

  // Total + label match whichever period is currently selected — not always "this week"
  const totalMins = filtered.reduce((sum, e) => sum + (e.duration_mins || 0), 0)
  const periodLabel = currentFilter === 'week' ? 'This week' : currentFilter === 'month' ? 'This month' : 'All time'
  document.getElementById('logTotalLabel').textContent = periodLabel
  document.getElementById('weekTotal').textContent = fmtDuration(totalMins)

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">No completed entries${currentFilter !== 'all' ? ' for this period' : ''}.</div>`
    return
  }

  list.innerHTML = filtered.map(e => {
    const gig  = e.gigs || {}
    const code = gig.gig_code || '—'
    const dur  = e.duration_mins ? fmtDuration(e.duration_mins) : '—'
    const type = e.entry_type === 'live' ? 'live' : 'manual'
    const loc  = e.location_label || null
    const d    = new Date(e.entry_date)
    const dow  = d.toLocaleDateString(undefined, { weekday: 'short' })
    const dnum = fmtDate(e.entry_date)
    const active = e.entry_id === editingEntryId

    return `
      <div class="log-entry${active ? ' log-entry-editing' : ''}">
        <div class="log-entry-date"><span class="dow">${esc(dow)}</span>${esc(dnum)}</div>
        <div class="log-entry-main">
          <div class="log-entry-gig">
            <span class="log-entry-code">${esc(code)}</span> ${esc(gig.title || '')}
            ${type === 'manual' ? '<span class="log-entry-flag">manual</span>' : ''}
          </div>
          <div class="log-entry-meta">
            <span>${fmtTime(e.start_time)}–${fmtTime(e.end_time)}</span>
            ${loc ? `<span>${esc(loc)}</span>` : ''}
          </div>
          ${e.notes ? `<div class="log-entry-notes">${esc(e.notes)}</div>` : ''}
        </div>
        <div class="log-entry-right">
          <div class="log-entry-duration">${dur}</div>
          <div class="row-actions">
            <button class="btn-edit" onclick="editEntry('${e.entry_id}')">${active ? 'Editing…' : 'Edit'}</button>
            <button class="btn-delete" onclick="deleteEntry('${e.entry_id}')">×</button>
          </div>
        </div>
      </div>`
  }).join('')
}

// ── EDIT COMPLETED ENTRY ──────────────────────────────────────────────────
// Opens the same Manual Entry panel used to create entries, pre-filled with
// this entry's data — per design decision, editing should look and feel
// exactly like logging a manual entry, not a separate compact form. Save
// then updates instead of inserting (see saveManual()).

window.editEntry = async function(entryId) {
  const entry = allEntries.find(e => e.entry_id === entryId)
  if (!entry) return

  // Live (auto clock-in/out) entries can't be updated as-is — the database
  // restricts edits to manual entries. Editing one converts it to manual,
  // but only with the person's explicit go-ahead.
  const wasLive = entry.entry_type === 'live'
  if (wasLive) {
    const ok = confirm('This is a live-clocked entry — editing it will convert it to manual. Continue?')
    if (!ok) return
  }

  editingEntryId = entryId

  // Switch to the Manual tab and open its panel
  const manualRadio = document.getElementById('tog-manual')
  if (manualRadio) manualRadio.checked = true
  showEntryPanel('manual')

  // loadGigs() only loads gigs that aren't completed, to keep the "add new
  // entry" dropdowns clean — but an existing entry can point at a gig that's
  // since been marked complete. If that gig isn't in gigMap, fetch it and
  // add it in just for this edit; otherwise the Gig field can't be
  // pre-selected and Save silently blocks on "please select a gig".
  let gig = gigMap[entry.gig_id]
  if (!gig) {
    const { data, error } = await db
      .from('gigs')
      .select('gig_id, gig_code, title, project_id')
      .eq('gig_id', entry.gig_id)
      .single()
    gig = (!error && data)
      ? { code: data.gig_code, title: data.title, project_id: data.project_id }
      : {}
    if (!error && data) gigMap[entry.gig_id] = gig
  }

  document.getElementById('manualProject').value = gig.project_id || ''
  populateGigDropdown('manualGig', gig.project_id || null)
  document.getElementById('manualGig').value = entry.gig_id || ''
  updateCardNo('manualGig', 'manualCardNo', 'manualCardStatus')

  document.getElementById('manualDate').value  = entry.entry_date || ''
  document.getElementById('manualStart').value = (entry.start_time || '').slice(0,5)
  document.getElementById('manualEnd').value   = (entry.end_time   || '').slice(0,5)
  document.getElementById('manualNotes').value = entry.notes || ''

  // Relabel the panel so it reads as an edit, not a new entry
  document.getElementById('manualPanelAction').textContent   = 'Edit Entry'
  document.getElementById('manualPanelSubtitle').textContent = wasLive
    ? 'Converting a live-clocked entry to manual — update the details and save'
    : 'Editing a logged entry — update the details and save'
  document.getElementById('manualSaveBtn').textContent  = 'Save Changes →'
  document.getElementById('manualClearBtn').textContent = 'Cancel'

  renderEntries() // reflect the "Editing…" state on the row
  document.getElementById('manualPanel').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── FILTER ────────────────────────────────────────────────────────────────

window.setFilter = function(filter) {
  currentFilter = filter
  document.querySelectorAll('.week-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter)
  })
  renderEntries()
}

// ── DELETE ────────────────────────────────────────────────────────────────

window.deleteEntry = async function(id) {
  if (!confirm('Delete this time entry?')) return
  const { error } = await db.from('time_entries').delete().eq('entry_id', id)
  if (error) { showToast('Delete failed', 'err'); return }
  showToast('Entry deleted', 'ok')
  await loadEntries()
}

// ── RESET MANUAL FORM ─────────────────────────────────────────────────────

window.resetManual = function() {
  const wasEditing = !!editingEntryId

  document.getElementById('manualProject').value = ''
  populateGigDropdown('manualGig', null)
  document.getElementById('manualDate').value  = TODAY
  document.getElementById('manualStart').value = ''
  document.getElementById('manualEnd').value   = ''
  document.getElementById('manualNotes').value = ''
  updateCardNo('manualGig', 'manualCardNo', 'manualCardStatus')

  editingEntryId = null
  document.getElementById('manualPanelAction').textContent   = 'Manual Entry'
  document.getElementById('manualPanelSubtitle').textContent = 'Log time worked — end time is optional, entry stays open until added'
  document.getElementById('manualSaveBtn').textContent  = 'Save →'
  document.getElementById('manualClearBtn').textContent = 'Clear'

  // "Cancel" (leaving an edit) collapses the panel again; "Clear" while
  // adding a fresh entry just wipes the fields and stays open.
  if (wasEditing) {
    document.querySelectorAll('input[name="tog-entry"]').forEach(r => r.checked = false)
    showEntryPanel(null)
    renderEntries()
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function getToggle(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`)
  return checked ? checked.value : null
}

function fmtDuration(mins) {
  if (!mins && mins !== 0) return '—'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function fmtDate(iso) {
  if (!iso) return '—'
  const [y, mo, d] = iso.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${parseInt(d)} ${months[parseInt(mo)-1]} ${y}`
}

function fmtTime(t) {
  if (!t) return '—'
  return t.slice(0,5)
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
