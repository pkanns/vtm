/**
 * plan_view.js — Vidai to Mulai · Plan View
 * Left: multi-user filter (admin sees everyone by default and can narrow
 * down; pacer sees self + their Doers; rover sees self only — same access
 * model as report_data.js's resolveViewableUsers, reused here).
 * Right: Mon–Fri, 8am–8pm calendar grid built from REAL time_entries —
 * each block is positioned by its actual start/end time, not bucketed.
 *
 * Read-only viewer. Defaults to the current week; "This Week" jumps back
 * to it; forward navigation is capped at the current week (no future
 * weeks — there's no timesheet data to show yet).
 */

import { db } from './vtm_db.js'
import { resolveViewableUsers } from './report_data.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }

// ── CONFIG ────────────────────────────────────────────────────────────────

const DAY_NAMES   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const DAY_START_H = 8    // 8am
const DAY_END_H   = 20   // 8pm
const WINDOW_MINS = (DAY_END_H - DAY_START_H) * 60

const USER_COLORS = ['#7b3fa0', '#2a5a8a', '#3a7a6b', '#8a6e3f', '#5a4a8a', '#a04a5c', '#4a7a8a', '#8a5a3f']
const STATUS_ACCENT = {
  placed:      '#2a5a8a',
  matched:     '#7b3fa0',
  aligned:     '#8a6200',
  in_progress: '#b5201a',
  delivered:   '#1e4d2b',
  completed:   '#6b5f4e',
}

// ── STATE ─────────────────────────────────────────────────────────────────

let viewable        = { canViewAll: false, users: [] }  // from resolveViewableUsers
let selectedUserIds  = new Set()
let weekOffset        = 0        // multiples of 7 days from THIS week's Monday
let weekEntries        = []        // fetched time_entries for the current week window
let weekUserTotals      = {}        // user_id -> total minutes this week (all entries, for the filter panel)

// ── DATE HELPERS ─────────────────────────────────────────────────────────

function mondayOf(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const diff = (day === 0 ? -6 : 1 - day)
  d.setDate(d.getDate() + diff)
  return d
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function toISO(d) { return d.toISOString().split('T')[0] }

function currentMonday() {
  return addDays(mondayOf(new Date()), weekOffset * 7)
}

function fmtWeekLabel(monday) {
  const friday = addDays(monday, 4)
  const opts = { month: 'short', day: 'numeric' }
  const startStr = monday.toLocaleDateString(undefined, opts)
  const endStr = friday.toLocaleDateString(undefined,
    monday.getMonth() === friday.getMonth() ? { day: 'numeric' } : opts)
  return `${startStr} – ${endStr}`
}

function fmtDayDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fmtHourLabel(h) {
  const period = h < 12 ? 'AM' : 'PM'
  const disp = h === 0 ? 12 : (h > 12 ? h - 12 : h)
  return `${disp} ${period}`
}

function fmtDuration(mins) {
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function minsSinceDayStart(timeStr) {
  // timeStr: "HH:MM" or "HH:MM:SS"
  const [h, m] = timeStr.split(':').map(Number)
  return (h * 60 + m) - (DAY_START_H * 60)
}

// ── INIT ──────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById('nextWeekBtn').disabled = weekOffset >= 0
  renderGridSkeleton()

  viewable = await resolveViewableUsers(db, session)
  selectedUserIds = new Set(viewable.users.map(u => u.user_id))

  document.getElementById('filterActions').style.display = viewable.users.length > 1 ? 'flex' : 'none'

  await loadWeek()
}

// ── LOAD WEEK ─────────────────────────────────────────────────────────────

async function loadWeek() {
  const statusEl = document.getElementById('dbStatus')
  statusEl.textContent = 'Loading…'
  statusEl.className   = 'db-status'
  document.getElementById('nextWeekBtn').disabled = weekOffset >= 0

  const monday = currentMonday()
  const friday = addDays(monday, 4)
  const userIds = viewable.users.map(u => u.user_id)

  if (!userIds.length) {
    weekEntries = []
    statusEl.textContent = 'No users to show'
    statusEl.className   = 'db-status err'
    renderFilterPanel()
    renderGrid()
    return
  }

  const { data, error } = await db
    .from('time_entries')
    .select('entry_id, gig_id, user_id, entry_date, start_time, end_time, is_active, duration_mins, gigs(gig_code, title, status)')
    .in('user_id', userIds)
    .gte('entry_date', toISO(monday))
    .lte('entry_date', toISO(friday))
    .order('start_time', { ascending: true })

  if (error) {
    statusEl.textContent = 'Could not load — ' + error.message
    statusEl.className   = 'db-status err'
    weekEntries = []
  } else {
    weekEntries = data || []
    statusEl.textContent = `● ${weekEntries.length} entr${weekEntries.length !== 1 ? 'ies' : 'y'} this week`
    statusEl.className   = 'db-status ok'
  }

  computeUserTotals()
  renderFilterPanel()
  renderGrid()
}

function computeUserTotals() {
  weekUserTotals = {}
  const now = new Date()

  weekEntries.forEach(e => {
    let mins = e.duration_mins
    if (mins == null && e.is_active && e.start_time) {
      // Still running — approximate elapsed only if it's today's entry
      if (e.entry_date === toISO(now)) {
        mins = Math.max(0, (now - new Date(`${e.entry_date}T${e.start_time}`)) / 60000)
      } else {
        mins = 0
      }
    }
    weekUserTotals[e.user_id] = (weekUserTotals[e.user_id] || 0) + (mins || 0)
  })
}

// ── FILTER PANEL ──────────────────────────────────────────────────────────

function renderFilterPanel() {
  const scroll = document.getElementById('filterScroll')

  if (!viewable.users.length) {
    scroll.innerHTML = '<div class="wp-empty">No users to show.</div>'
    return
  }

  scroll.innerHTML = viewable.users.map((u, i) => {
    const active = selectedUserIds.has(u.user_id)
    const color  = USER_COLORS[i % USER_COLORS.length]
    const mins   = weekUserTotals[u.user_id] || 0

    return `
      <div class="wp-user-row ${active ? 'active' : 'inactive'}"
           style="border-left-color:${color}"
           onclick="wpToggleUser('${u.user_id}')">
        <span class="wp-user-name">${escHtml(u.name)}</span>
        <span class="wp-user-hours">${fmtDuration(mins)}</span>
      </div>`
  }).join('')
}

window.wpToggleUser = function(userId) {
  if (selectedUserIds.has(userId)) selectedUserIds.delete(userId)
  else selectedUserIds.add(userId)
  renderFilterPanel()
  renderGrid()
}

window.wpSelectAll = function() {
  selectedUserIds = new Set(viewable.users.map(u => u.user_id))
  renderFilterPanel()
  renderGrid()
}

window.wpSelectNone = function() {
  selectedUserIds = new Set()
  renderFilterPanel()
  renderGrid()
}

// ── GRID SKELETON (day headers + hour labels — drawn once per week) ──────

function renderGridSkeleton() {
  const monday = currentMonday()
  document.getElementById('weekLabel').textContent = `Week of ${fmtWeekLabel(monday)}`

  const grid = document.getElementById('hourGrid')
  const hourCount = DAY_END_H - DAY_START_H

  let html = '<div class="wp-corner"></div>'
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i)
    html += `
      <div class="wp-day-head">
        <div class="wp-day-name">${DAY_NAMES[i]}</div>
        <div class="wp-day-date">${fmtDayDate(d)}</div>
      </div>`
  }

  // Hour label column
  html += '<div class="wp-hourlabel-col">'
  for (let h = DAY_START_H; h < DAY_END_H; h++) {
    html += `<div class="wp-hourlabel-cell">${fmtHourLabel(h)}</div>`
  }
  html += '</div>'

  // Day columns (blocks injected separately in renderGrid)
  for (let i = 0; i < 5; i++) {
    const dateISO = toISO(addDays(monday, i))
    html += `<div class="wp-day-col" id="daycol-${dateISO}"></div>`
  }

  grid.innerHTML = html
}

// ── RENDER GRID (blocks) ─────────────────────────────────────────────────

function renderGrid() {
  renderGridSkeleton()

  const monday = currentMonday()
  const now = new Date()
  const nowISO = toISO(now)

  const visibleUsers = viewable.users.filter(u => selectedUserIds.has(u.user_id))
  const colorByUser = {}
  viewable.users.forEach((u, i) => { colorByUser[u.user_id] = USER_COLORS[i % USER_COLORS.length] })

  const visible = weekEntries.filter(e => selectedUserIds.has(e.user_id))

  for (let i = 0; i < 5; i++) {
    const dateISO = toISO(addDays(monday, i))
    const col = document.getElementById(`daycol-${dateISO}`)
    if (!col) continue

    const dayEntries = visible.filter(e => e.entry_date === dateISO)
    if (!dayEntries.length) continue

    // Lane per visible user, in the same order every day so the grid
    // reads consistently left-to-right for a given person.
    const dayUserIds = visibleUsers.map(u => u.user_id).filter(id => dayEntries.some(e => e.user_id === id))
    const laneCount = Math.max(dayUserIds.length, 1)
    const laneWidth = 100 / laneCount

    dayEntries.forEach(e => {
      const laneIdx = Math.max(0, dayUserIds.indexOf(e.user_id))
      const user = viewable.users.find(u => u.user_id === e.user_id)
      const gig  = e.gigs || {}

      let startMin = e.start_time ? minsSinceDayStart(e.start_time) : 0
      let endMin
      const isLiveNow = e.is_active && !e.end_time && dateISO === nowISO
      if (isLiveNow) {
        endMin = minsSinceDayStart(now.toTimeString().slice(0, 5))
      } else if (e.end_time) {
        endMin = minsSinceDayStart(e.end_time)
      } else {
        endMin = startMin + 15 // stale open entry from a past day — show a sliver
      }

      startMin = Math.max(0, Math.min(WINDOW_MINS, startMin))
      endMin   = Math.max(0, Math.min(WINDOW_MINS, endMin))
      if (endMin <= startMin) endMin = Math.min(WINDOW_MINS, startMin + 8)

      const top    = (startMin / WINDOW_MINS) * 100
      const height = ((endMin - startMin) / WINDOW_MINS) * 100
      const color  = colorByUser[e.user_id] || '#555'
      const accent = STATUS_ACCENT[gig.status] || '#555'

      const block = document.createElement('div')
      block.className = 'wp-block' + (isLiveNow ? ' live' : '')
      block.style.top    = `${top}%`
      block.style.height = `${Math.max(height, 2.2)}%`
      block.style.left   = `calc(${laneIdx * laneWidth}% + 2px)`
      block.style.width  = `calc(${laneWidth}% - 4px)`
      block.style.background = color
      block.style.borderLeft = `3px solid ${accent}`
      block.title = `${user?.name || '—'} · ${gig.gig_code || '—'} · ${gig.title || ''} · ${e.start_time?.slice(0,5) || '—'}–${e.end_time ? e.end_time.slice(0,5) : (isLiveNow ? 'now' : '—')}`

      block.innerHTML = `
        <span class="who">${isLiveNow ? '<span class="live-dot"></span>' : ''}${escHtml(user?.name || '—')}</span>
        <span class="code">${escHtml(gig.gig_code || '—')}</span>`

      col.appendChild(block)
    })
  }
}

// ── WEEK NAV ──────────────────────────────────────────────────────────────

window.shiftWeek = function(delta) {
  const next = weekOffset + delta
  if (next > 0) return
  weekOffset = next
  loadWeek()
}

window.jumpToCurrentWeek = function() {
  weekOffset = 0
  loadWeek()
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── INIT ──────────────────────────────────────────────────────────────────

init()
