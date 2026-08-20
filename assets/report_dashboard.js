/**
 * report_dashboard.js — Vidai to Mulai · Data View
 * Filterable browsing across weeks. "By week" is the only axis today;
 * built so month/role/project become additional filters on the same
 * computeWeekData() shape later, not a rewrite.
 *
 * Two views, toggled at the top — Time View (default, unchanged) and
 * Task View (tasks changed this week for the selected person, or a
 * per-person changed-count table when "All users" is selected). The
 * Status/Overdue/effort-bucket filters only apply to Time View, so
 * they're dimmed and disabled while Task View is active.
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
  fetchTasksChangedForUser,
  EFFORT_BUCKETS, effortBucketId,
} from './report_data.js'
import { SCOPE_OPTIONS } from './gig_filters.js'
import { canToggleTask } from './gig_tasks.js'
import { toggleTaskDone } from './vtm_api.js'

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

let weekOffset = 0
let selectedUserId = 'self'   // 'self' | 'all' | a user_id
let scopeId = 'open'
let overdueOnly = false
let activeBuckets = new Set()
let viewable = { canViewAll: false, users: [] }
let currentView = 'time'      // 'time' | 'task'
let lastPersonTasks = []      // tasks currently shown for a single selected person

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

  userSelect.addEventListener('change', () => { selectedUserId = userSelect.value; render() })
  scopeSelect.addEventListener('change', () => { scopeId = scopeSelect.value; render() })

  applyViewControlState()
  render()
}

async function render() {
  const monday = addDays(saturdayOf(new Date()), weekOffset * 7)
  const sunday = addDays(monday, 6)
  weekLabelEl.textContent = fmtWeekLabel(monday)
  nextBtn.disabled = weekOffset >= 0

  bodyEl.innerHTML = '<div class="empty-state">Loading&hellip;</div>'

  if (selectedUserId === 'all') {
    headerEl.textContent = 'All users \u00b7 ' + fmtWeekLabel(monday)
    if (currentView === 'task') await renderAllUsersTasks(monday, sunday)
    else await renderAllUsers(monday, sunday)
  } else {
    const person = viewable.users.find(u => u.user_id === selectedUserId)
    headerEl.textContent = (person?.name || 'Report') + ' \u00b7 ' + fmtWeekLabel(monday)
    if (currentView === 'task') await renderOnePersonTasks(selectedUserId, monday, sunday)
    else await renderOnePerson(selectedUserId, monday, sunday)
  }
}

// ── TIME VIEW (unchanged behavior) ────────────────────────────────────

async function renderOnePerson(userId, monday, sunday) {
  const [{ gigs, closedLine }, text] = await Promise.all([
    computeWeekData(db, userId, monday, sunday),
    fetchReportText(db, userId, toISODate(monday)),
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

async function renderAllUsers(monday, sunday) {
  const rows = await Promise.all(viewable.users.map(async u => {
    const { gigs, totalMinutes } = await computeWeekData(db, u.user_id, monday, sunday)
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
      <span class="status-pill ${g.status || 'placed'}">${(g.status || 'placed').replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}</span>
      <span class="gig-row-due${g.isOverdue ? ' overdue' : ''}">${g.date_due || '\u2014'}</span>
      <span class="gig-row-hours">${fmtHours(g.minutes)}</span>
    </div>`).join('')
  return `<div class="gigs-list">${rows}</div>`
}

function textReadonlyHTML(label, value) {
  return `<div class="text-readonly"><label>${label}</label><div style="font-size:13px;color:var(--black);white-space:pre-wrap;">${value || '\u2014'}</div></div>`
}

// ── TASK VIEW ─────────────────────────────────────────────────────────

async function renderOnePersonTasks(userId, monday, sunday) {
  lastPersonTasks = await fetchTasksChangedForUser(db, userId, monday, sunday)
  bodyEl.innerHTML = buildTaskChangesHTML(lastPersonTasks)
}

async function renderAllUsersTasks(monday, sunday) {
  const rows = await Promise.all(viewable.users.map(async u => {
    const tasks = await fetchTasksChangedForUser(db, u.user_id, monday, sunday)
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
        <span class="status-pill ${g.status || 'placed'}">${(g.status || 'placed').replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}</span>
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

// ── VIEW TOGGLE ────────────────────────────────────────────────────────

window.setView = function(view) {
  if (view === currentView) return
  currentView = view
  document.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view))
  applyViewControlState()
  render()
}

// Status scope / overdue / effort-bucket filters only mean anything in
// Time View — dim and disable them while Task View is active rather than
// leave controls on screen that silently do nothing.
function applyViewControlState() {
  const disable = currentView === 'task'
  scopeSelect.disabled = disable
  ;['chipOverdue', 'chipUnder20', 'chip20to40', 'chipOver40'].forEach(id => {
    const el = document.getElementById(id)
    if (!el) return
    el.style.pointerEvents = disable ? 'none' : ''
    el.style.opacity       = disable ? '0.35' : ''
  })
}

// ── CHIPS / NAV ──────────────────────────────────────────────────────────

window.toggleChip = function(name) {
  if (name === 'overdue') {
    overdueOnly = !overdueOnly
    document.getElementById('chipOverdue').classList.toggle('active', overdueOnly)
  }
  render()
}

window.toggleBucket = function(id) {
  if (activeBuckets.has(id)) activeBuckets.delete(id); else activeBuckets.add(id)
  document.getElementById('chip' + (id === '20to40' ? '20to40' : id[0].toUpperCase() + id.slice(1)))
    ?.classList.toggle('active', activeBuckets.has(id))
  render()
}

window.jumpToUser = function(userId) {
  selectedUserId = userId
  userSelect.value = userId
  render()
}

window.goWeek = function(delta) {
  const next = weekOffset + delta
  if (next > 0) return
  weekOffset = next
  render()
}

init()
