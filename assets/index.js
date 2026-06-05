/**
 * index.js — Vidai to Mulai · Dashboard / Cockpit
 * Role-aware task view:
 *   admin/pacer — Needs Placement + Active Today + Upcoming
 *   rover       — Active Today + Upcoming (own gigs only)
 */

import { db }          from './vtm_db.js'
import { fetchGigs, fmtDate, esc } from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

const role     = session.role
const myUserId = session.user_id
const TODAY    = new Date().toISOString().split('T')[0]

// ── STATE ─────────────────────────────────────────────────────────────────

let allGigs   = []
let sortMode  = 'due'

// ── LOAD ──────────────────────────────────────────────────────────────────

async function loadDashboard() {
  const statusEl = document.getElementById('dbStatus')

  // Set cover greeting
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  document.getElementById('coverSub').textContent =
    `${greeting}, ${session.name} · ${new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' })}`

  // Hide New Gig button for rovers
  if (role === 'rover') {
    document.getElementById('coverActions').querySelector('.btn-new-gig')?.remove()
  }

  const { data, error } = await fetchGigs(db)

  if (error) {
    statusEl.textContent = 'Could not connect — ' + error.message
    statusEl.className   = 'db-status err'
    return
  }

  // Role filter
  let gigs = data || []
  if (role === 'rover') {
    gigs = gigs.filter(g => g.rover_id === myUserId)
  } else if (role === 'pacer') {
    gigs = gigs.filter(g => g.pacer_id === myUserId)
  }

  allGigs = gigs
  statusEl.textContent = `● ${gigs.length} gig${gigs.length !== 1 ? 's' : ''}`
  statusEl.className   = 'db-status ok'

  renderDashboard()
}

// ── RENDER ────────────────────────────────────────────────────────────────

function renderDashboard() {
  const today    = new Date(); today.setHours(0,0,0,0)

  // Partition gigs
  const completed = allGigs.filter(g => ['completed','delivered'].includes(g.status))
  const open      = allGigs.filter(g => !['completed','delivered'].includes(g.status))

  // Needs placement — missing key fields (admin/pacer only)
  const needsPlacement = (role !== 'rover') ? open.filter(g =>
    !g.date_start || !g.date_due || !g.rover_id || !g.pacer_id || !g.category_id
  ) : []
  const needsPlacementIds = new Set(needsPlacement.map(g => g.gig_id))

  // Active today — start date <= today or null, not needs placement
  const activeToday = open.filter(g => {
    if (needsPlacementIds.has(g.gig_id)) return false
    if (!g.date_start) return true  // no start date = show it
    return new Date(g.date_start) <= today
  })

  // Upcoming — start date in future, not needs placement
  const upcoming = open.filter(g => {
    if (needsPlacementIds.has(g.gig_id)) return false
    if (!g.date_start) return false
    return new Date(g.date_start) > today
  })

  // Done this week
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0,0,0,0)
  const doneWeek  = completed.filter(g => g.updated_at && new Date(g.updated_at) >= weekStart)

  // Stats
  _setText('statActive',    activeToday.length)
  _setText('statPlacement', needsPlacement.length)
  _setText('statUpcoming',  upcoming.length)
  _setText('statDoneWeek',  doneWeek.length)

  // Needs placement section
  const placeSec = document.getElementById('placementSection')
  if (needsPlacement.length && role !== 'rover') {
    placeSec.style.display = 'block'
    _setText('placementCount', needsPlacement.length)
    document.getElementById('placementList').innerHTML =
      needsPlacement.map(g => renderGigRow(g, true)).join('') ||
      '<div class="empty-section">None — all gigs are fully configured.</div>'
  } else {
    placeSec.style.display = 'none'
  }

  // Active today
  const sorted  = sortGigs(activeToday)
  const activeEl = document.getElementById('activeList')
  _setText('activeCount', activeToday.length)

  if (!sorted.length) {
    activeEl.innerHTML = `<div class="empty-section">
      No active gigs for today${role !== 'rover' ? ' — <a href="create_gig.html">create one</a>' : ''}.
    </div>`
  } else {
    activeEl.innerHTML = `<div class="gig-list">${sorted.map(g => renderGigRow(g, false)).join('')}</div>`
  }

  // Upcoming
  _setText('upcomingCount', upcoming.length)
  const upcomingEl = document.getElementById('upcomingList')
  if (!upcoming.length) {
    upcomingEl.innerHTML = '<div class="empty-section" style="border-top-color:var(--light)">No upcoming gigs.</div>'
  } else {
    upcomingEl.innerHTML = `<div class="gig-list">${sortGigs(upcoming).map(g => renderGigRow(g, false)).join('')}</div>`
  }
}

// ── RENDER GIG ROW ────────────────────────────────────────────────────────

function renderGigRow(g, isPlacement) {
  const projCode = g.projects?.project_code || ''
  const catCode  = g.project_categories?.category_code || ''
  const due      = g.date_due
  const start    = g.date_start
  const isOverdue = due && due < TODAY && !['completed','delivered'].includes(g.status)

  return `
    <a class="gig-row${isPlacement ? ' needs-placement' : ''}" href="create_gig.html?gig_id=${g.gig_id}">
      <div>
        <div class="gig-code">${esc(g.gig_code)}</div>
        <div class="gig-project">${esc(projCode)}${catCode ? ' · ' + esc(catCode) : ''}</div>
      </div>
      <div>
        <div class="gig-title">${esc(g.title)}</div>
      </div>
      <div><span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span></div>
      <div class="gig-start">${start ? fmtDate(start) : '—'}</div>
      <div class="gig-due${isOverdue ? ' overdue' : ''}">${due ? fmtDate(due) : '—'}${isOverdue ? ' !' : ''}</div>
      <div>${isPlacement ? '<span class="placement-flag">Needs Placement</span>' : ''}</div>
    </a>`
}

// ── SORT ──────────────────────────────────────────────────────────────────

function sortGigs(gigs) {
  return [...gigs].sort((a, b) => {
    switch (sortMode) {
      case 'due':
        return (a.date_due || '9999') < (b.date_due || '9999') ? -1 : 1
      case 'start':
        return (a.date_start || '9999') < (b.date_start || '9999') ? -1 : 1
      case 'project':
        return (a.projects?.project_code || '') < (b.projects?.project_code || '') ? -1 : 1
      case 'status':
        const order = ['placed','matched','aligned','in_progress','delivered','completed']
        return order.indexOf(a.status) - order.indexOf(b.status)
      default:
        return 0
    }
  })
}

window.setSort = function(mode) {
  sortMode = mode
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === mode)
  })
  renderDashboard()
}

// ── UPCOMING TOGGLE ───────────────────────────────────────────────────────

window.toggleUpcoming = function() {
  const list  = document.getElementById('upcomingList')
  const arrow = document.getElementById('upcomingArrow')
  const open  = list.classList.toggle('visible')
  arrow.classList.toggle('open', open)
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function _setText(id, val) {
  const el = document.getElementById(id)
  if (el) el.textContent = val
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadDashboard()
