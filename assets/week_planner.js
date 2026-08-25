/**
 * week_planner.js — Vidai to Mulai · Week Planner
 * Left: gig pool (status matched → delivered, masters excluded, role-scoped
 * same as gig_index.js). Right: Mon–Fri × AM/PM drag-and-drop grid.
 *
 * MVP / visualization only — plannerState lives in memory for this page
 * load and is NOT written to Supabase. Persisting this is a deliberate
 * step 2, once the interaction itself is confirmed to be the right shape.
 *
 * A gig can be dropped into any cell any number of times, but is capped
 * at 4 placements total *within the currently viewed week* — the cap is
 * per-week, not global, since plannerState is keyed by week.
 */

import { db }         from './vtm_db.js'
import { fetchGigs, esc } from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }

const role     = session.role
const myUserId = session.user_id

// ── CONFIG ────────────────────────────────────────────────────────────────

const PLANNABLE_STATUSES = ['matched', 'aligned', 'in_progress', 'delivered']
const MAX_PLACEMENTS_PER_WEEK = 4
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

// ── STATE ─────────────────────────────────────────────────────────────────

let allGigs      = []                 // fetched + filtered gig pool
let weekOffset    = 0                  // multiples of 7 days from the default (next) week
let plannerState  = {}                 // { [mondayISO]: { [cellKey]: [gigId, ...] } }
let draggingGigId = null

// ── DATE HELPERS ─────────────────────────────────────────────────────────

function mondayOf(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()               // 0=Sun..6=Sat
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

function defaultMonday() {
  // Always the week AFTER the current one — planning is done ahead, per
  // the "typically done on Friday for next week" pattern.
  return addDays(mondayOf(new Date()), 7)
}

function currentMonday() {
  return addDays(defaultMonday(), weekOffset * 7)
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

// ── LOAD GIGS ─────────────────────────────────────────────────────────────

async function loadGigs() {
  const statusEl = document.getElementById('dbStatus')
  const { data, error } = await fetchGigs(db)

  if (error) {
    statusEl.textContent = 'Could not connect — ' + error.message
    statusEl.className   = 'db-status err'
    return
  }

  let filtered = data || []

  // Role scope — same convention as gig_index.js
  if (role === 'pacer') filtered = filtered.filter(g => g.pacer_id === myUserId)
  if (role === 'rover') filtered = filtered.filter(g => g.rover_id === myUserId)

  // Plannable statuses only, masters excluded
  filtered = filtered.filter(g =>
    PLANNABLE_STATUSES.includes(g.status) &&
    !(g.cadence === 'recurring' && !g.parent_gig_id)
  )

  allGigs = filtered

  statusEl.textContent = `● ${allGigs.length} gig${allGigs.length !== 1 ? 's' : ''} available`
  statusEl.className   = 'db-status ok'

  renderPool()
}

// ── PLACEMENT COUNTING ───────────────────────────────────────────────────

function weekCells(monday) {
  const cells = []
  for (let i = 0; i < 5; i++) {
    const dateISO = toISO(addDays(monday, i))
    cells.push(`${dateISO}_AM`, `${dateISO}_PM`)
  }
  return cells
}

function placementCount(gigId, monday) {
  const weekKey = toISO(monday)
  const week = plannerState[weekKey]
  if (!week) return 0
  let count = 0
  Object.values(week).forEach(list => {
    count += list.filter(id => id === gigId).length
  })
  return count
}

function addPlacement(gigId, cellKey, monday) {
  const weekKey = toISO(monday)
  if (!plannerState[weekKey]) plannerState[weekKey] = {}
  if (!plannerState[weekKey][cellKey]) plannerState[weekKey][cellKey] = []
  plannerState[weekKey][cellKey].push(gigId)
}

function removePlacement(cellKey, monday, index) {
  const weekKey = toISO(monday)
  const list = plannerState[weekKey]?.[cellKey]
  if (!list) return
  list.splice(index, 1)
}

// ── RENDER — POOL ─────────────────────────────────────────────────────────

function renderPool() {
  const scroll = document.getElementById('poolScroll')

  if (!allGigs.length) {
    scroll.innerHTML = '<div class="wp-empty">No gigs between Matched and Delivered right now.</div>'
    return
  }

  const monday = currentMonday()

  scroll.innerHTML = allGigs.map(g => {
    const count  = placementCount(g.gig_id, monday)
    const maxed  = count >= MAX_PLACEMENTS_PER_WEEK
    const status = g.status || 'matched'

    return `
      <div class="wp-gig-card status-${status}${maxed ? ' maxed' : ''}"
           draggable="${maxed ? 'false' : 'true'}"
           data-gig-id="${g.gig_id}"
           ondragstart="wpDragStart(event, '${g.gig_id}')"
           ondragend="wpDragEnd(event)">
        <div class="wp-gig-top">
          <span class="wp-gig-code">${esc(g.gig_code)}</span>
          <span class="wp-gig-count${maxed ? ' full' : ''}">${count}/${MAX_PLACEMENTS_PER_WEEK}</span>
        </div>
        <div class="wp-gig-title">${esc(g.title)}</div>
        <div class="wp-gig-status">${fmtStatus(status)}</div>
      </div>`
  }).join('')
}

// ── RENDER — GRID ─────────────────────────────────────────────────────────

function renderGrid() {
  const monday = currentMonday()
  document.getElementById('weekLabel').textContent = `Week of ${fmtWeekLabel(monday)}`

  const grid = document.getElementById('weekGrid')

  let html = '<div class="wp-corner"></div>'
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i)
    html += `
      <div class="wp-day-head">
        <div class="wp-day-name">${DAY_NAMES[i]}</div>
        <div class="wp-day-date">${fmtDayDate(d)}</div>
      </div>`
  }

  ;['AM', 'PM'].forEach(slot => {
    html += `<div class="wp-row-label"><span>${slot}</span></div>`
    for (let i = 0; i < 5; i++) {
      const dateISO = toISO(addDays(monday, i))
      const cellKey = `${dateISO}_${slot}`
      html += `
        <div class="wp-cell" id="cell-${cellKey}"
             ondragover="wpDragOver(event)"
             ondragleave="wpDragLeave(event)"
             ondrop="wpDrop(event, '${cellKey}')">
          ${renderCellChips(cellKey, monday)}
        </div>`
    }
  })

  grid.innerHTML = html
}

function renderCellChips(cellKey, monday) {
  const weekKey = toISO(monday)
  const list = plannerState[weekKey]?.[cellKey] || []

  return list.map((gigId, idx) => {
    const gig = allGigs.find(g => g.gig_id === gigId)
    if (!gig) return ''
    return `
      <div class="wp-chip status-${gig.status || 'matched'}">
        <span class="code">${esc(gig.gig_code)}</span>
        <span class="title">${esc(gig.title)}</span>
        <button type="button" class="rm" onclick="wpRemoveChip('${cellKey}', ${idx})" title="Remove">×</button>
      </div>`
  }).join('')
}

// ── DRAG AND DROP ─────────────────────────────────────────────────────────

window.wpDragStart = function(ev, gigId) {
  const monday = currentMonday()
  if (placementCount(gigId, monday) >= MAX_PLACEMENTS_PER_WEEK) {
    ev.preventDefault()
    return
  }
  draggingGigId = gigId
  ev.dataTransfer.setData('text/plain', gigId)
  ev.dataTransfer.effectAllowed = 'copy'
  ev.currentTarget.classList.add('dragging')
}

window.wpDragEnd = function(ev) {
  ev.currentTarget.classList.remove('dragging')
  draggingGigId = null
}

window.wpDragOver = function(ev) {
  ev.preventDefault()
  ev.dataTransfer.dropEffect = 'copy'
  ev.currentTarget.classList.add('drag-over')
}

window.wpDragLeave = function(ev) {
  ev.currentTarget.classList.remove('drag-over')
}

window.wpDrop = function(ev, cellKey) {
  ev.preventDefault()
  ev.currentTarget.classList.remove('drag-over')

  const gigId = ev.dataTransfer.getData('text/plain') || draggingGigId
  if (!gigId) return

  const monday = currentMonday()
  if (placementCount(gigId, monday) >= MAX_PLACEMENTS_PER_WEEK) {
    showToast('This gig is already placed 4 times this week', 'err')
    return
  }

  addPlacement(gigId, cellKey, monday)
  draggingGigId = null
  renderGrid()
  renderPool()
}

window.wpRemoveChip = function(cellKey, index) {
  const monday = currentMonday()
  removePlacement(cellKey, monday, index)
  renderGrid()
  renderPool()
}

// ── WEEK NAV ──────────────────────────────────────────────────────────────

window.shiftWeek = function(delta) {
  weekOffset += delta
  renderGrid()
  renderPool()
}

window.jumpToDefaultWeek = function() {
  weekOffset = 0
  renderGrid()
  renderPool()
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── INIT ──────────────────────────────────────────────────────────────────

renderGrid()
loadGigs()
