/**
 * report_dashboard.js — Vidai to Mulai · Data View
 * Filterable browsing across weeks/people. Cloned from weekly_report.js's
 * view pattern: nothing renders until a view tab is clicked. Time View /
 * Task View / Gig View are optional panels — clicking a tab fetches and
 * opens it; clicking the same tab again collapses it; only one is open
 * at a time. Changing the user/week/filters while a panel is open
 * refreshes that panel; if nothing is open, changing filters is a no-op
 * until a view is picked.
 *
 * Status scope / overdue / effort-bucket filters only apply to Time
 * View — they're dimmed and disabled whenever a different view (or no
 * view) is open, same as the personal Weekly Report.
 *
 * Gig View is the same rough approximation as weekly_report.js — gigs
 * placed this week (date_placed) and gigs completed/evaluated this week
 * (evaluations join) — not a true change-log.
 *
 * Access model:
 *   admin  → any single user, or "All" (aggregate summary table)
 *   pacer  → self, or exactly one Doer assigned to them — one at a time
 *   rover  → self only, no picker shown
 *
 * Week window is Saturday → Friday (see report_data.js's saturdayOf).
 */

import { db } from './vtm_db.js'
import {
  saturdayOf, addDays, toISODate, fmtWeekLabel, fmtHours, fmtDateTimeShort,
  computeWeekData, fetchReportText, resolveViewableUsers,
  fetchTasksChangedForUser, fetchGigChangesForUser,
  EFFORT_BUCKETS, effortBucketId,
} from './report_data.js'
import { SCOPE_OPTIONS } from './gig_filters.js'
import { canToggleTask } from './gig_tasks.js'
import { toggleTaskDone } from './vtm_api.js'

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

let weekOffset      = 0
let selectedUserId  = 'self'   // 'self' | 'all' | a user_id
let scopeId          = 'open'
let overdueOnly      = false
let activeBuckets    = new Set()
let viewable          = { canViewAll: false, users: [] }
let currentView       = null   // null | 'time' | 'task' | 'gig'
let currentMonday     = null
let currentSunday     = null
let lastPersonTasks   = []     // tasks currently shown for a single selected person — for in-place toggle

const weekLabelEl   = document.getElementById('weekLabel')
const nextBtn        = document.getElementById('nextWeekBtn')
const userSelect     = document.getElementById('userSelect')
const scopeSelect    = document.getElementById('scopeSelect')
const headerEl       = document.getElementById('resultsHeader')
const bodyEl         = document.getElementById('resultsBody')

async function init() {
  viewable = await resolveViewableUsers(db, session)

  const opts = viewable.users.map(u =>
    `<option value="${u.user_id}"${u.user_id === session.user_id ? ' selected' : ''}>${u.user_id === session.user_id ? 'Me' : u.name}</option>`
  ).join('')
  userSelect.innerHTML = (viewable.canViewAll ? '<option value="all">All users</option>' : '') + opts
  selectedUserId = session.user_id

  userSelect.addEventListener('change', () => { selectedUserId = userSelect.value; refresh() })
  scopeSelect.addEventListener('change', () => { scopeId = scopeSelect.value; refresh() })

  applyViewControlState()
  setWeekLabel()
}

function setWeekLabel() {
  currentMonday = addDays(saturdayOf(new Date()), weekOffset * 7)
  currentSunday = addDays(currentMonday, 6)
  weekLabelEl.textContent = fmtWeekLabel(currentMonday)
  nextBtn.disabled = weekOffset >= 0
}

// ── VIEW TOGGLE ────────────────────────────────────────────────────────

window.setView = async function(view) {
  if (currentView === view) {
    currentView = null
    headerEl.textContent = 'Select a view above'
    bodyEl.innerHTML = ''
    syncTabState()
    applyViewControlState()
    return
  }

  currentView = view
  syncTabState()
  applyViewControlState()
  await refresh()
}

function syncTabState() {
  document.querySelectorAll('.view-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.view === currentView)
  })
}

// Status scope / overdue / effort-bucket filters only mean anything in
// Time View — dim and disable them otherwise rather than leave controls
// on screen that silently do nothing.
function applyViewControlState() {
  const disable = currentView !== 'time'
  scopeSelect.disabled = disable
  ;['chipOverdue', 'chipUnder20', 'chip20to40', 'chipOver40'].forEach(id => {
    const el = document.getElementById(id)
    if (!el) return
    el.style.pointerEvents = disable ? 'none' : ''
    el.style.opacity       = disable ? '0.35' : ''
  })
}

// ── REFRESH — re-fetch and re-render whatever panel is currently open ──

async function refresh() {
  if (!currentView) return   // nothing open — filters just update state, no fetch

  setWeekLabel()
  bodyEl.innerHTML = '<div class="empty-state">Loading&hellip;</div>'

  if (selectedUserId === 'all') {
    headerEl.textContent = 'All users \u00b7 ' + fmtWeekLabel(currentMonday)
    if (currentView === 'time') await renderAllUsersTime()
    else if (currentView === 'task') await renderAllUsersTasks()
    else if (currentView === 'gig') await renderAllUsersGigs()
  } else {
    const person = viewable.users.find(u => u.user_id === selectedUserId)
    headerEl.textContent = (person?.name || 'Report') + ' \u00b7 ' + fmtWeekLabel(currentMonday)
    if (currentView === 'time') await renderOnePersonTime(selectedUserId)
    else if (currentView === 'task') await renderOnePersonTasks(selectedUserId)
    else if (currentView === 'gig') await renderOnePersonGigs(selectedUserId)
  }
}

// ── TIME VIEW ──────────────────────────────────────────────────────────

async function renderOnePersonTime(userId) {
  const [{ gigs, closedLine }, text] = await Promise.all([
    computeWeekData(db, userId, currentMonday, currentSunday),
    fetchReportText(db, userId, toISODate(currentMonday)),
  ])

  const filtered = applyGigFilters(gigs)

  bodyEl.innerHTML = `
    ${buildGigsListHTML(filtered)}
    ${closedLine ? `<div style="font-family:var(--font-mono);font-size:10px;color:var(--stone);margin-top:8px;">${closedLine}</div>` : ''}
    <div style="margin-top:20px">
      <div class="filter-label">This week</div>
      ${textReadonlyHTML('Accomplishment', text?.accomplishment)}
      ${textReadonlyHTML('Next steps',     text?.next_steps)}
      ${textReadonlyHTML('Support needed', text?.support_needed)}
    </div>
  `
}

async function renderAllUsersTime() {
  const rows = await Promise.all(viewable.users.map(async u => {
    const { gigs, totalMinutes } = await computeWeekData(db, u.user_id, currentMonday, currentSunday)
    return { user: u, gigs: applyGigFilters(gigs), totalMinutes, bucket: effortBucketId(totalMinutes) }
  }))

  const filteredRows = rows.filter(r => {
    if (activeBuckets.size && !activeBuckets.has(r.bucket)) return false
    if (overdueOnly && !r.gigs.some(g => g.isOverdue)) return false
    return true
  })

  if (!filteredRows.length) {
    bodyEl.innerHTML = '<div class="empty-state">No users match these filters.</div>'
    return
  }

  const bucketLabel = { under20: 'Under 20h', '20to40': '20\u201340h', over40: 'Over 40h' }

  bodyEl.innerHTML = `
    <table class="summary-table">
      <thead><tr><th>Name</th><th>Hours</th><th>Effort</th><th>Active gigs</th><th>Overdue</th></tr></thead>
      <tbody>
        ${filteredRows.map(r => `
          <tr onclick="window.jumpToUser('${r.user.user_id}')">
            <td>${r.user.name}</td>
            <td>${fmtHours(r.totalMinutes)}</td>
            <td><span class="bucket-tag ${r.bucket}">${bucketLabel[r.bucket]}</span></td>
            <td>${r.gigs.length}</td>
            <td>${r.gigs.filter(g => g.isOverdue).length}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `
}

function applyGigFilters(gigs) {
  let out = gigs.filter(g => g.minutes > 0)  // same declutter rule as weekly_report.js
  const scope = SCOPE_OPTIONS.find(s => s.id === scopeId)
  if (scope) out = out.filter(scope.predicate)
  if (overdueOnly) out = out.filter(g => g.isOverdue)
  return out
}

function buildGigsListHTML(gigs) {
  if (!gigs.length) return '<div class="empty-state">No gigs match these filters.</div>'
  const rows = gigs.map(g => `
    <div class="gig-row">
      <div><span class="gig-row-code">${g.gig_code}</span> ${g.title}</div>
      <span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span>
      <span class="gig-row-due${g.isOverdue ? ' overdue' : ''}">${g.date_due || '\u2014'}</span>
      <span class="gig-row-hours">${fmtHours(g.minutes)}</span>
    </div>`).join('')
  return `<div class="gigs-list">${rows}</div>`
}

function textReadonlyHTML(label, value) {
  return `<div class="text-readonly"><label>${label}</label><div style="font-size:13px;color:var(--black);white-space:pre-wrap;">${value || '\u2014'}</div></div>`
}

// ── TASK VIEW ─────────────────────────────────────────────────────────

async function renderOnePersonTasks(userId) {
  lastPersonTasks = await fetchTasksChangedForUser(db, userId, currentMonday, currentSunday)
  bodyEl.innerHTML = buildTaskChangesHTML(lastPersonTasks)
}

async function renderAllUsersTasks() {
  const rows = await Promise.all(viewable.users.map(async u => {
    const tasks = await fetchTasksChangedForUser(db, u.user_id, currentMonday, currentSunday)
    return { user: u, count: tasks.length }
  }))

  if (!rows.length) {
    bodyEl.innerHTML = '<div class="empty-state">No users match these filters.</div>'
    return
  }

  bodyEl.innerHTML = `
    <table class="summary-table">
      <thead><tr><th>Name</th><th>Tasks Changed</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr onclick="window.jumpToUser('${r.user.user_id}')">
            <td>${r.user.name}</td>
            <td>${r.count}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `
}

function buildTaskChangesHTML(tasks) {
  if (!tasks.length) return '<div class="empty-state">No tasks changed this week.</div>'

  const rows = tasks.map(t => {
    const g = t.gigs
    const toggle = canToggleTask(t, session, g)
    const checkAttr = toggle
      ? `onchange="toggleDashTask('${t.task_id}', this.checked)"`
      : 'disabled'

    return `
      <div class="gig-row">
        <div${t.done ? ' style="color:var(--stone);text-decoration:line-through;"' : ''}><span class="gig-row-code">${g.gig_code}</span> ${t.title}</div>
        <span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span>
        <span class="gig-row-due">${fmtDateTimeShort(t.updated_at)}</span>
        <input type="checkbox" ${t.done ? 'checked' : ''} ${checkAttr}>
      </div>`
  }).join('')

  return `<div class="gigs-list">${rows}</div>`
}

window.toggleDashTask = async function(taskId, done) {
  const { error } = await toggleTaskDone(db, taskId, done)
  if (error) { showToast('Could not update task', 'err'); return }

  const t = lastPersonTasks.find(x => x.task_id === taskId)
  if (t) t.done = done

  bodyEl.innerHTML = buildTaskChangesHTML(lastPersonTasks)
  showToast(done ? 'Marked done' : 'Marked not done', 'ok')
}

// ── GIG VIEW (rough — placed/completed this week) ───────────────────────

async function renderOnePersonGigs(userId) {
  const { created, completed } = await fetchGigChangesForUser(db, userId, currentMonday, currentSunday)
  bodyEl.innerHTML = buildGigChangesHTML(created, completed)
}

async function renderAllUsersGigs() {
  const rows = await Promise.all(viewable.users.map(async u => {
    const { created, completed } = await fetchGigChangesForUser(db, u.user_id, currentMonday, currentSunday)
    return { user: u, placed: created.length, completed: completed.length }
  }))

  if (!rows.length) {
    bodyEl.innerHTML = '<div class="empty-state">No users match these filters.</div>'
    return
  }

  bodyEl.innerHTML = `
    <table class="summary-table">
      <thead><tr><th>Name</th><th>Placed</th><th>Completed</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr onclick="window.jumpToUser('${r.user.user_id}')">
            <td>${r.user.name}</td>
            <td>${r.placed}</td>
            <td>${r.completed}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `
}

function buildGigChangesHTML(created, completed) {
  if (!created.length && !completed.length) {
    return '<div class="empty-state">No gigs placed or completed this week.</div>'
  }

  const section = (label, items, kind) => {
    if (!items.length) return ''
    const rows = items.map(g => `
      <div class="gig-row">
        <div><span class="gig-row-code">${g.gig_code}</span> ${g.title}</div>
        <span class="status-pill ${kind === 'completed' ? 'completed' : 'placed'}">${kind === 'completed' ? 'Completed' : 'Placed'}</span>
        <span class="gig-row-due">${g.date || '\u2014'}</span>
        <span></span>
      </div>`).join('')
    return `<div class="filter-label" style="margin-top:14px">${label}</div><div class="gigs-list">${rows}</div>`
  }

  return `${section('Gigs placed this week', created, 'placed')}${section('Gigs completed this week', completed, 'completed')}`
}

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── CHIPS / NAV ──────────────────────────────────────────────────────────

window.toggleChip = function(name) {
  if (name === 'overdue') {
    overdueOnly = !overdueOnly
    document.getElementById('chipOverdue').classList.toggle('active', overdueOnly)
  }
  refresh()
}

window.toggleBucket = function(id) {
  if (activeBuckets.has(id)) activeBuckets.delete(id); else activeBuckets.add(id)
  document.getElementById('chip' + (id === '20to40' ? '20to40' : id[0].toUpperCase() + id.slice(1)))
    ?.classList.toggle('active', activeBuckets.has(id))
  refresh()
}

window.jumpToUser = function(userId) {
  selectedUserId = userId
  userSelect.value = userId
  refresh()
}

window.goWeek = function(delta) {
  const next = weekOffset + delta
  if (next > 0) return
  weekOffset = next
  refresh()
}

init()
