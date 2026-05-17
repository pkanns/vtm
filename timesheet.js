/**
 * timesheet.js — Vidai to Mulai · Timesheet
 * Personal time log — each user sees only their own entries.
 * DB calls via vtm_db.js · Auth via vtm.js
 */

import { db } from './assets/vtm_db.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const { data: { session } } = await db.auth.getSession()

if (!session) {
  sessionStorage.clear()
  window.location.href = 'login.html'
}

if (!sessionStorage.getItem('vtm_role')) {
  const { data: vtmUser } = await db
    .from('vtm_users')
    .select('role, name, ref_id, user_id')
    .eq('auth_user_id', session.user.id)
    .single()

  if (vtmUser) {
    sessionStorage.setItem('vtm_role',    vtmUser.role)
    sessionStorage.setItem('vtm_name',    vtmUser.name)
    sessionStorage.setItem('vtm_user_id', vtmUser.user_id)
    sessionStorage.setItem('vtm_ref_id',  vtmUser.ref_id || '')
    sessionStorage.setItem('vtm_email',   session.user.email)
    vtmAuthGuard()
  }
}

const vtmSession = vtmGetSession()
const userId     = vtmSession?.user_id || null
const role       = vtmSession?.role    || null
const refId      = vtmSession?.ref_id  || null

// ── STATE ─────────────────────────────────────────────────────────────────

let currentFilter = 'week'
let allEntries    = []
let gigMap        = {}  // gig_id → { gig_code, title }

// ── INIT: set today's date ────────────────────────────────────────────────

document.getElementById('tsDate').value = new Date().toISOString().split('T')[0]

// ── LOAD GIG DROPDOWN ─────────────────────────────────────────────────────

async function loadGigs() {
  let query = db.from('gigs').select('gig_id, gig_code, title, status')

  // Filter by role — show only relevant gigs
  if (role === 'pacer' && refId) {
    query = query.eq('pacer_id', refId)
  } else if (role === 'rover' && refId) {
    query = query.eq('rover_id', refId)
  }

  // Only active gigs — no completed
  query = query.not('status', 'eq', 'completed').order('gig_code')

  const { data, error } = await query

  const sel = document.getElementById('tsGig')

  if (error || !data?.length) {
    sel.innerHTML = '<option value="">— No active gigs —</option>'
    return
  }

  // Build gig map for display in log
  data.forEach(g => { gigMap[g.gig_id] = { code: g.gig_code, title: g.title } })

  sel.innerHTML = '<option value="">— Select Gig —</option>' +
    data.map(g => `<option value="${g.gig_id}">${esc(g.gig_code)} · ${esc(g.title)}</option>`).join('')
}

// ── DURATION CALCULATOR ───────────────────────────────────────────────────

window.calcDuration = function() {
  const start = document.getElementById('tsStart').value
  const end   = document.getElementById('tsEnd').value
  const el    = document.getElementById('durationDisplay')

  if (!start || !end) {
    el.textContent = '—'
    el.className   = 'duration-display'
    return
  }

  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMins = sh * 60 + sm
  const endMins   = eh * 60 + em
  const diff      = endMins - startMins

  if (diff <= 0) {
    el.textContent = 'Invalid range'
    el.className   = 'duration-display invalid'
    return
  }

  const hours = Math.floor(diff / 60)
  const mins  = diff % 60
  el.textContent = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
  el.className   = 'duration-display valid'
}

// ── SAVE ENTRY ────────────────────────────────────────────────────────────

window.saveEntry = async function() {
  const gigId = document.getElementById('tsGig').value
  const date  = document.getElementById('tsDate').value
  const start = document.getElementById('tsStart').value
  const end   = document.getElementById('tsEnd').value
  const notes = document.getElementById('tsNotes').value.trim()

  if (!gigId) { showToast('Please select a gig',       'err'); return }
  if (!date)  { showToast('Please enter a date',       'err'); return }
  if (!start) { showToast('Please enter a start time', 'err'); return }
  if (!end)   { showToast('Please enter an end time',  'err'); return }

  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const diff = (eh * 60 + em) - (sh * 60 + sm)

  if (diff <= 0) {
    showToast('End time must be after start time', 'err')
    return
  }

  const { error } = await db.from('time_entries').insert({
    gig_id:       gigId,
    user_id:      userId,
    entry_date:   date,
    start_time:   start,
    end_time:     end,
    duration_mins: diff,
    notes:        notes || null,
  })

  if (error) {
    showToast('Save failed — ' + error.message, 'err')
    return
  }

  showToast('Time logged', 'ok')
  resetForm()
  loadEntries()
}

// ── LOAD ENTRIES ──────────────────────────────────────────────────────────

async function loadEntries() {
  const { data, error } = await db
    .from('time_entries')
    .select('*, gigs(gig_code, title)')
    .eq('user_id', userId)
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
  const now    = new Date()
  const tbody  = document.getElementById('logTableBody')

  // Filter by period
  const filtered = allEntries.filter(e => {
    const d = new Date(e.entry_date)
    if (currentFilter === 'week') {
      const startOfWeek = new Date(now)
      startOfWeek.setDate(now.getDate() - now.getDay())
      startOfWeek.setHours(0,0,0,0)
      return d >= startOfWeek
    }
    if (currentFilter === 'month') {
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    }
    return true
  })

  // Week total
  const weekEntries = allEntries.filter(e => {
    const d = new Date(e.entry_date)
    const startOfWeek = new Date(now)
    startOfWeek.setDate(now.getDate() - now.getDay())
    startOfWeek.setHours(0,0,0,0)
    return d >= startOfWeek
  })
  const weekMins = weekEntries.reduce((sum, e) => sum + (e.duration_mins || 0), 0)
  document.getElementById('weekTotal').textContent = fmtDuration(weekMins)

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No entries${currentFilter !== 'all' ? ' for this period' : ''} — log some time above.</div></td></tr>`
    return
  }

  tbody.innerHTML = filtered.map(e => {
    const gig  = e.gigs || {}
    const code = gig.gig_code || '—'
    const dur  = fmtDuration(e.duration_mins || 0)
    return `
      <tr>
        <td style="font-family:var(--font-mono);font-size:12px;color:var(--stone)">${fmtDate(e.entry_date)}</td>
        <td>
          <span class="gig-code-pill">${esc(code)}</span>
          <span style="font-size:12px;color:var(--stone);margin-left:8px">${esc(gig.title || '')}</span>
        </td>
        <td style="font-family:var(--font-mono);font-size:12px">${e.start_time?.slice(0,5) || '—'}</td>
        <td style="font-family:var(--font-mono);font-size:12px">${e.end_time?.slice(0,5) || '—'}</td>
        <td><span class="duration-pill">${dur}</span></td>
        <td style="color:var(--stone);font-size:12px">${esc(e.notes || '—')}</td>
        <td><button class="btn-delete" onclick="deleteEntry('${e.entry_id}')">×</button></td>
      </tr>
    `
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
  loadEntries()
}

// ── RESET FORM ────────────────────────────────────────────────────────────

window.resetForm = function() {
  document.getElementById('tsGig').value   = ''
  document.getElementById('tsDate').value  = new Date().toISOString().split('T')[0]
  document.getElementById('tsStart').value = ''
  document.getElementById('tsEnd').value   = ''
  document.getElementById('tsNotes').value = ''
  const el = document.getElementById('durationDisplay')
  el.textContent = '—'
  el.className   = 'duration-display'
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtDuration(mins) {
  if (!mins) return '0m'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${parseInt(d)} ${months[parseInt(m)-1]} ${y}`
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── INIT ──────────────────────────────────────────────────────────────────

await loadGigs()
loadEntries()
