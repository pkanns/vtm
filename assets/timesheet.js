/**
 * timesheet.js — Vidai to Mulai · Timesheet
 * Rewritten: toggle Auto/Manual, project→gig cascade,
 * Open Timesheets (null end_time), midnight-safe duration via DB,
 * auto-close guard on sign-out, owner+admin edit.
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

// ── INIT ──────────────────────────────────────────────────────────────────

document.getElementById('manualDate').value = TODAY

await loadProjects()
await loadGigs()
await checkActiveTimer()
await loadEntries()
initToggle()
patchSignOut()

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

  projectMap = {}
  data.forEach(p => { projectMap[p.project_id] = { code: p.project_code, name: p.project_name } })

  const blankOpt = '<option value="">— All Projects —</option>'
  const opts = blankOpt + data.map(p =>
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
  const block  = document.getElementById('activeTimerBlock')
  const pill   = document.getElementById('headerTimerPill')
  const label  = document.getElementById('headerTimerLabel')

  const gig    = entry.gigs || gigMap[entry.gig_id] || {}
  const code   = gig.gig_code || gig.code || '—'
  const title  = gig.title    || '—'
  const timeIn = entry.start_time ? entry.start_time.slice(0,5) : '—'
  const dateIn = entry.entry_date ? fmtDate(entry.entry_date)   : '—'
  const loc    = entry.location_label || null

  document.getElementById('timerGigCode').textContent  = code
  document.getElementById('timerGigTitle').textContent = title
  document.getElementById('timerClockIn').textContent  = `Clocked in at ${timeIn} · ${dateIn}`
  document.getElementById('timerLocation').textContent = loc || ''
  // Pre-fill notes if any
  const notesEl = document.getElementById('activeNotes')
  if (notesEl) notesEl.value = entry.notes || ''

  block.classList.add('visible')
  if (pill)  pill.classList.add('visible')
  if (label) label.textContent = `In · ${timeIn}`
}

function hideActiveTimer() {
  document.getElementById('activeTimerBlock').classList.remove('visible')
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

  const btn = document.querySelector('.btn-save')
  btn.disabled    = true
  btn.textContent = 'Saving…'

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
  const tbody = document.getElementById('logTableBody')

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

  // Week total
  const weekMins = allEntries
    .filter(e => { const d = new Date(e.entry_date); d.setHours(0,0,0,0); return d >= weekStart })
    .reduce((sum, e) => sum + (e.duration_mins || 0), 0)

  document.getElementById('weekTotal').textContent = fmtDuration(weekMins)

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">No completed entries${currentFilter !== 'all' ? ' for this period' : ''}.</div></td></tr>`
    return
  }

  tbody.innerHTML = filtered.map(e => {
    const gig  = e.gigs || {}
    const code = gig.gig_code || '—'
    const dur  = e.duration_mins ? fmtDuration(e.duration_mins) : '—'
    const type = e.entry_type === 'live' ? 'live' : 'manual'
    const loc  = e.location_label || '—'

    return `
      <tr>
        <td style="font-family:var(--font-mono);font-size:12px;color:var(--stone)">${fmtDate(e.entry_date)}</td>
        <td>
          <span class="gig-code-pill">${esc(code)}</span>
          <span style="font-size:12px;color:var(--stone);margin-left:8px">${esc(gig.title || '')}</span>
        </td>
        <td style="font-family:var(--font-mono);font-size:12px">${fmtTime(e.start_time)}</td>
        <td style="font-family:var(--font-mono);font-size:12px">${fmtTime(e.end_time)}</td>
        <td><span class="duration-pill">${dur}</span></td>
        <td><span class="type-badge ${type}">${type}</span></td>
        <td style="font-size:11px;color:var(--stone);font-family:var(--font-mono)">${esc(loc)}</td>
        <td style="color:var(--stone);font-size:12px">${esc(e.notes || '—')}</td>
        <td><button class="btn-delete" onclick="deleteEntry('${e.entry_id}')">×</button></td>
      </tr>`
  }).join('')
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
  document.getElementById('manualProject').value = ''
  populateGigDropdown('manualGig', null)
  document.getElementById('manualDate').value  = TODAY
  document.getElementById('manualStart').value = ''
  document.getElementById('manualEnd').value   = ''
  document.getElementById('manualNotes').value = ''
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
