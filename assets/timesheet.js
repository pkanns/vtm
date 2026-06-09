/**
 * timesheet.js — Vidai to Mulai · Timesheet
 * Auto clock-in/out with GPS + manual entry.
 * All durations stored as duration_mins (integer).
 * Displayed always as Xh Ym — never decimal.
 * Week starts Monday.
 */

import { db } from './vtm_db.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

const userId = session.user_id
const TODAY  = new Date().toISOString().split('T')[0]

// ── STATE ─────────────────────────────────────────────────────────────────

let activeEntry   = null   // current is_active=true entry if any
let allEntries    = []
let currentFilter = 'week'
let gigMap        = {}     // gig_id → { code, title }

// ── INIT ──────────────────────────────────────────────────────────────────

document.getElementById('manualDate').value = TODAY

await loadGigs()
await checkActiveTimer()
await loadEntries()

// ── LOAD GIG DROPDOWN ─────────────────────────────────────────────────────

async function loadGigs() {
  let query = db.from('gigs')
    .select('gig_id, gig_code, title, status, pacer_id, rover_id')
    .not('status', 'eq', 'completed')
    .order('gig_code')

  if (session.role === 'pacer') query = query.eq('pacer_id', userId)
  if (session.role === 'rover') query = query.eq('rover_id', userId)

  const { data, error } = await query

  if (error || !data?.length) {
    document.getElementById('clockInGig').innerHTML = '<option value="">— No active gigs —</option>'
    document.getElementById('manualGig').innerHTML  = '<option value="">— No active gigs —</option>'
    return
  }

  gigMap = {}
  data.forEach(g => { gigMap[g.gig_id] = { code: g.gig_code, title: g.title } })

  const opts = '<option value="">— Select Gig —</option>' +
    data.map(g => `<option value="${g.gig_id}">${esc(g.gig_code)} · ${esc(g.title)}</option>`).join('')

  document.getElementById('clockInGig').innerHTML = opts
  document.getElementById('manualGig').innerHTML  = opts
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
  const block    = document.getElementById('activeTimerBlock')
  const clockIn  = document.getElementById('clockInCard')
  const pill     = document.getElementById('headerTimerPill')
  const label    = document.getElementById('headerTimerLabel')

  const gig      = entry.gigs || gigMap[entry.gig_id] || {}
  const code     = gig.gig_code || gig.code || '—'
  const title    = gig.title    || '—'
  const timeIn   = entry.start_time ? entry.start_time.slice(0,5) : '—'
  const dateIn   = entry.entry_date ? fmtDate(entry.entry_date) : '—'
  const loc      = entry.location_label || null

  document.getElementById('timerGigCode').textContent  = code
  document.getElementById('timerGigTitle').textContent = title
  document.getElementById('timerClockIn').textContent  = `Clocked in at ${timeIn} · ${dateIn}`
  document.getElementById('timerLocation').textContent = loc || ''

  block.classList.add('visible')
  clockIn.style.display = 'none'

  // Header pill
  if (pill)  pill.classList.add('visible')
  if (label) label.textContent = `In · ${timeIn}`
}

function hideActiveTimer() {
  document.getElementById('activeTimerBlock').classList.remove('visible')
  document.getElementById('clockInCard').style.display = 'block'
  const pill = document.getElementById('headerTimerPill')
  if (pill) pill.classList.remove('visible')
  activeEntry = null
}

// ── CLOCK IN ──────────────────────────────────────────────────────────────

window.clockIn = async function() {
  const gigId = document.getElementById('clockInGig').value
  if (!gigId) { showToast('Please select a gig', 'err'); return }

  const btn = document.getElementById('clockInBtn')
  btn.disabled    = true
  btn.textContent = 'Clocking in…'

  // Get GPS location
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
  const startTime = now.toTimeString().slice(0,5)  // HH:MM

  const payload = {
    gig_id:         gigId,
    user_id:        userId,
    entry_date:     TODAY,
    start_time:     startTime,
    entry_type:     'auto',
    is_active:      true,
    clock_in_lat:   lat,
    clock_in_lng:   lng,
    location_label: locationLabel,
    notes:          null,
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
  showToast('Clocked in ✓', 'ok')
  await loadEntries()
}

// ── CLOCK OUT ─────────────────────────────────────────────────────────────

window.clockOut = async function() {
  if (!activeEntry) return

  const btn = document.getElementById('clockOutBtn')
  btn.disabled    = true
  btn.textContent = 'Clocking out…'

  // Get GPS location on clock out
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

  // Calculate duration in minutes
  const [sh, sm] = (activeEntry.start_time || '00:00').split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)
  const durationMins = (eh * 60 + em) - (sh * 60 + sm)

  if (durationMins <= 0) {
    showToast('End time is before start time — check clock', 'err')
    btn.disabled    = false
    btn.textContent = 'Clock Out →'
    return
  }

  const { error } = await db
    .from('time_entries')
    .update({
      end_time:       endTime,
      duration_mins:  durationMins,
      is_active:      false,
      clock_out_lat:  lat,
      clock_out_lng:  lng,
    })
    .eq('entry_id', activeEntry.entry_id)

  if (error) {
    showToast('Clock out failed — ' + error.message, 'err')
    btn.disabled    = false
    btn.textContent = 'Clock Out →'
    return
  }

  showToast(`Clocked out · ${fmtDuration(durationMins)}`, 'ok')
  hideActiveTimer()
  await loadEntries()
}

// ── MANUAL SAVE ───────────────────────────────────────────────────────────

window.saveManual = async function() {
  const gigId = document.getElementById('manualGig').value
  const date  = document.getElementById('manualDate').value
  const start = document.getElementById('manualStart').value
  const end   = document.getElementById('manualEnd').value
  const notes = document.getElementById('manualNotes').value.trim()

  if (!gigId) { showToast('Please select a gig',       'err'); return }
  if (!date)  { showToast('Please enter a date',       'err'); return }
  if (!start) { showToast('Please enter a start time', 'err'); return }
  if (!end)   { showToast('Please enter an end time',  'err'); return }

  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const durationMins = (eh * 60 + em) - (sh * 60 + sm)

  if (durationMins <= 0) { showToast('End time must be after start time', 'err'); return }

  const btn = document.querySelector('.btn-save')
  btn.disabled    = true
  btn.textContent = 'Saving…'

  const { error } = await db.from('time_entries').insert({
    gig_id:        gigId,
    user_id:       userId,
    entry_date:    date,
    start_time:    start,
    end_time:      end,
    duration_mins: durationMins,
    entry_type:    'manual',
    is_active:     false,
    notes:         notes || null,
  })

  if (error) {
    showToast('Save failed — ' + error.message, 'err')
    btn.disabled    = false
    btn.textContent = 'Save →'
    return
  }

  showToast('Time logged ✓', 'ok')
  btn.disabled    = false
  btn.textContent = 'Save →'
  resetManual()
  await loadEntries()
}

// ── LOAD ENTRIES ──────────────────────────────────────────────────────────

async function loadEntries() {
  const { data, error } = await db
    .from('time_entries')
    .select('*, gigs(gig_code, title)')
    .eq('user_id', userId)
    .eq('is_active', false)   // only completed entries in log
    .order('entry_date', { ascending: false })
    .order('start_time', { ascending: false })

  const statusEl = document.getElementById('dbStatus')

  if (error) {
    statusEl.textContent = 'Could not load entries'
    statusEl.className   = 'db-status err'
    return
  }

  allEntries = data || []
  statusEl.textContent = `● ${allEntries.length} entr${allEntries.length !== 1 ? 'ies' : 'y'}`
  statusEl.className   = 'db-status ok'

  renderEntries()
}

// ── RENDER ENTRIES ────────────────────────────────────────────────────────

function renderEntries() {
  const now   = new Date(); now.setHours(0,0,0,0)
  const tbody = document.getElementById('logTableBody')

  // Week starts Monday
  const weekStart = new Date(now)
  const day = weekStart.getDay()
  const diffToMon = (day === 0) ? -6 : 1 - day
  weekStart.setDate(weekStart.getDate() + diffToMon)

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const filtered = allEntries.filter(e => {
    const d = new Date(e.entry_date); d.setHours(0,0,0,0)
    if (currentFilter === 'week')  return d >= weekStart
    if (currentFilter === 'month') return d >= monthStart
    return true
  })

  // Week total — always from Monday
  const weekMins = allEntries
    .filter(e => { const d = new Date(e.entry_date); d.setHours(0,0,0,0); return d >= weekStart })
    .reduce((sum, e) => sum + (e.duration_mins || 0), 0)

  document.getElementById('weekTotal').textContent = fmtDuration(weekMins)

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">No entries${currentFilter !== 'all' ? ' for this period' : ''}.</div></td></tr>`
    return
  }

  tbody.innerHTML = filtered.map(e => {
    const gig  = e.gigs || {}
    const code = gig.gig_code || '—'
    const dur  = e.duration_mins ? fmtDuration(e.duration_mins) : '—'
    const type = e.entry_type || 'manual'
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
  document.getElementById('manualGig').value   = ''
  document.getElementById('manualDate').value  = TODAY
  document.getElementById('manualStart').value = ''
  document.getElementById('manualEnd').value   = ''
  document.getElementById('manualNotes').value = ''
  const el = document.getElementById('durationDisplay')
  el.textContent = '—'
  el.className   = 'duration-display'
}

// ── HELPERS (module scope) ────────────────────────────────────────────────

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
