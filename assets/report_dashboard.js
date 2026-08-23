/**
 * report_dashboard.js — Vidai to Mulai · Data View
 * Rebuilt alongside weekly_report.js, same model: no arbitrary week
 * navigation, no live recompute of anything past the current week.
 *
 *   THIS WEEK  — Time View / Task View / Gig View, fully live, same as
 *                before, for whichever person (or "All users") is
 *                selected.
 *   LAST WEEK  — a fourth tab. For a single selected person, shows only
 *                what they actually saved to weekly_reports last week
 *                (Accomplishment / Next steps / Support needed),
 *                read-only. For "All users", shows a simple submitted /
 *                not-submitted table — click a row to drill into that
 *                person's saved text.
 *
 * Status scope / overdue filter only apply to Time View — dimmed and
 * disabled otherwise, same as before.
 *
 * Access model unchanged:
 *   admin  → any single user, or "All" (aggregate)
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
} from './report_data.js'
import { SCOPE_OPTIONS } from './gig_filters.js'
import { canToggleTask } from './gig_tasks.js'
import { toggleTaskDone } from './vtm_api.js'

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

// This week never moves — no offset, no navigation.
const currentMonday  = saturdayOf(new Date())
const currentSunday  = addDays(currentMonday, 6)
const lastWeekMonday = addDays(currentMonday, -7)

// History covers offsets -2 .. -11 (10 weeks) — -1 stays exclusive to
// the Last Week tab.
const HISTORY_MIN_OFFSET = -11
const HISTORY_MAX_OFFSET = -2
let historyOffset = HISTORY_MAX_OFFSET

let selectedUserId  = 'self'   // 'self' | 'all' | a user_id
let scopeId          = 'open'
let overdueOnly      = false
let viewable          = { canViewAll: false, users: [] }
let currentView       = null   // null | 'time' | 'task' | 'gig' | 'lastweek' | 'history'
let lastPersonTasks   = []     // tasks currently shown for a single selected person — for in-place toggle

const weekLabelEl   = document.getElementById('weekLabel')
const userSelect     = document.getElementById('userSelect')
const scopeSelect    = document.getElementById('scopeSelect')
const headerEl       = document.getElementById('resultsHeader')
const bodyEl         = document.getElementById('resultsBody')

async function init() {
  weekLabelEl.textContent = fmtWeekLabel(currentMonday)

  viewable = await resolveViewableUsers(db, session)

  const opts = viewable.users.map(u =>
    `<option value="${u.user_id}"${u.user_id === session.user_id ? ' selected' : ''}>${u.user_id === session.user_id ? 'Me' : u.name}</option>`
  ).join('')
  userSelect.innerHTML = (viewable.canViewAll ? '<option value="all">All users</option>' : '') + opts
  selectedUserId = session.user_id

  userSelect.addEventListener('change', () => { selectedUserId = userSelect.value; refresh() })
  scopeSelect.addEventListener('change', () => { scopeId = scopeSelect.value; refresh() })

  applyViewControlState()
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

// Status scope / overdue filters only mean anything in Time View — dim
// and disable them otherwise rather than leave controls on screen that
// silently do nothing. Never meaningful in Last Week (nothing to filter).
function applyViewControlState() {
  const disable = currentView !== 'time'
  scopeSelect.disabled = disable
  const chip = document.getElementById('chipOverdue')
  if (chip) {
    chip.style.pointerEvents = disable ? 'none' : ''
    chip.style.opacity       = disable ? '0.35' : ''
  }
}

// ── REFRESH — re-fetch and re-render whatever panel is currently open ──

async function refresh() {
  if (!currentView) return   // nothing open — filters just update state, no fetch

  bodyEl.innerHTML = '<div class="empty-state">Loading&hellip;</div>'

  if (selectedUserId === 'all') {
    headerEl.textContent = currentView === 'history'
      ? 'All users \u00b7 ' + fmtWeekLabel(addDays(currentMonday, historyOffset * 7))
      : 'All users \u00b7 ' + fmtWeekLabel(currentMonday)
    if (currentView === 'time') await renderAllUsersTime()
    else if (currentView === 'task') await renderAllUsersTasks()
    else if (currentView === 'gig') await renderAllUsersGigs()
    else if (currentView === 'lastweek') await renderAllUsersLastWeek()
    else if (currentView === 'history') await renderAllUsersHistory()
  } else {
    const person = viewable.users.find(u => u.user_id === selectedUserId)
    const label = currentView === 'history'
      ? fmtWeekLabel(addDays(currentMonday, historyOffset * 7))
      : fmtWeekLabel(currentMonday)
    headerEl.textContent = (person?.name || 'Report') + ' \u00b7 ' + label
    if (currentView === 'time') await renderOnePersonTime(selectedUserId)
    else if (currentView === 'task') await renderOnePersonTasks(selectedUserId)
    else if (currentView === 'gig') await renderOnePersonGigs(selectedUserId)
    else if (currentView === 'lastweek') await renderOnePersonLastWeek(selectedUserId)
    else if (currentView === 'history') await renderOnePersonHistory(selectedUserId)
  }
}

// ── TIME VIEW ──────────────────────────────────────────────────────────

async function renderOnePersonTime(userId) {
  const { gigs, closedLine, timeSlices } = await computeWeekData(db, userId, currentMonday, currentSunday)
  const filtered = applyGigFilters(gigs)

  bodyEl.innerHTML = `
    ${buildBarsHTML(timeSlices)}
    ${buildGigsListHTML(filtered)}
    ${closedLine ? `<div style="font-family:var(--font-mono);font-size:10px;color:var(--stone);margin-top:8px;">${closedLine}</div>` : ''}
  `
}

async function renderAllUsersTime() {
  const rows = await Promise.all(viewable.users.map(async u => {
    const { gigs, totalMinutes } = await computeWeekData(db, u.user_id, currentMonday, currentSunday)
    return { user: u, gigs: applyGigFilters(gigs), totalMinutes }
  }))

  const filteredRows = rows.filter(r => !overdueOnly || r.gigs.some(g => g.isOverdue))

  if (!filteredRows.length) {
    bodyEl.innerHTML = '<div class="empty-state">No users match these filters.</div>'
    return
  }

  bodyEl.innerHTML = `
    <table class="summary-table">
      <thead><tr><th>Name</th><th>Hours</th><th>Active gigs</th><th>Overdue</th></tr></thead>
      <tbody>
        ${filteredRows.map(r => `
          <tr onclick="window.jumpToUser('${r.user.user_id}')">
            <td>${r.user.name}</td>
            <td>${fmtHours(r.totalMinutes)}</td>
            <td>${r.gigs.length}</td>
            <td>${r.gigs.filter(g => g.isOverdue).length}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `
}

function buildBarsHTML(slices) {
  const total = (slices || []).reduce((s, x) => s + x.minutes, 0)
  if (!total) return '<div class="bars-empty">No time logged yet this week.</div>'
  const rows = slices.map(s => `
    <div class="bar-row">
      <span>${s.label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (s.minutes / (40*60)) * 100)}%;background:${s.color}"></div></div>
      <span class="bar-row-value">${fmtHours(s.minutes)}</span>
    </div>`).join('')
  return `<div class="filter-label">Time this week &middot; of 40h</div><div class="bars-section">${rows}</div>`
}

function applyGigFilters(gigs) {
  let out = gigs.filter(g => g.minutes > 0)
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

function buildTaskChangesHTML(tasks, readOnly) {
  if (!tasks.length) return '<div class="empty-state">No tasks changed this week.</div>'

  const rows = tasks.map(t => {
    const g = t.gigs
    const toggle = !readOnly && canToggleTask(t, session, g)
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

// ── LAST WEEK (static, read-only — nothing recomputed) ──────────────────

async function renderOnePersonLastWeek(userId) {
  const text = await fetchReportText(db, userId, toISODate(lastWeekMonday))
  bodyEl.innerHTML = buildLastWeekHTML(text)
}

function buildLastWeekHTML(text) {
  if (!text) {
    return `<div class="empty-state">No report was saved for last week (${fmtWeekLabel(lastWeekMonday)}).</div>`
  }
  return `
    ${textReadonlyHTML('Accomplishment', text.accomplishment)}
    ${textReadonlyHTML('Next steps',     text.next_steps)}
    ${textReadonlyHTML('Support needed', text.support_needed)}
  `
}

function textReadonlyHTML(label, value) {
  return `<div class="text-readonly"><label>${label}</label><div style="font-size:13px;color:var(--black);white-space:pre-wrap;">${esc(value) || '\u2014'}</div></div>`
}

async function renderAllUsersLastWeek() {
  const rows = await Promise.all(viewable.users.map(async u => {
    const text = await fetchReportText(db, u.user_id, toISODate(lastWeekMonday))
    return { user: u, submitted: !!text }
  }))

  bodyEl.innerHTML = `
    <table class="summary-table">
      <thead><tr><th>Name</th><th>Last Week</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr onclick="window.jumpToUser('${r.user.user_id}')">
            <td>${r.user.name}</td>
            <td><span class="bucket-tag ${r.submitted ? '20to40' : 'under20'}">${r.submitted ? 'Saved' : 'Not saved'}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>
  `
}

// ── HISTORY (weeks -2 .. -11 — Previous/Next, capped) ───────────────────

window.historyNav = async function(delta) {
  const next = historyOffset + delta
  if (next > HISTORY_MAX_OFFSET || next < HISTORY_MIN_OFFSET) return
  historyOffset = next
  await refresh()
}

function historyNavHTML(monday) {
  return `
    <div class="history-nav">
      <button class="week-nav-btn" onclick="historyNav(-1)" ${historyOffset <= HISTORY_MIN_OFFSET ? 'disabled' : ''}>&#8249;</button>
      <span class="history-label">${fmtWeekLabel(monday)}</span>
      <button class="week-nav-btn" onclick="historyNav(1)" ${historyOffset >= HISTORY_MAX_OFFSET ? 'disabled' : ''}>&#8250;</button>
    </div>`
}

async function renderOnePersonHistory(userId) {
  const monday = addDays(currentMonday, historyOffset * 7)
  const sunday = addDays(monday, 6)

  const [{ gigs, closedLine, timeSlices }, tasks, gigChanges, text] = await Promise.all([
    computeWeekData(db, userId, monday, sunday),
    fetchTasksChangedForUser(db, userId, monday, sunday),
    fetchGigChangesForUser(db, userId, monday, sunday),
    fetchReportText(db, userId, toISODate(monday)),
  ])

  bodyEl.innerHTML = `
    ${historyNavHTML(monday)}
    ${buildBarsHTML(timeSlices)}
    ${buildGigsListHTML(applyGigFilters(gigs))}
    ${closedLine ? `<div style="font-family:var(--font-mono);font-size:10px;color:var(--stone);margin-top:8px;">${closedLine}</div>` : ''}
    <div class="filter-label" style="margin-top:16px">Tasks changed</div>
    ${buildTaskChangesHTML(tasks, true)}
    ${buildGigChangesHTML(gigChanges.created, gigChanges.completed)}
    <div class="filter-label" style="margin-top:16px">${fmtWeekLabel(monday)} \u2014 as saved</div>
    ${text
      ? textReadonlyHTML('Accomplishment', text.accomplishment) + textReadonlyHTML('Next steps', text.next_steps) + textReadonlyHTML('Support needed', text.support_needed)
      : `<div class="empty-state">No report was saved for this week.</div>`}
  `
}

async function renderAllUsersHistory() {
  const monday = addDays(currentMonday, historyOffset * 7)
  const sunday = addDays(monday, 6)

  const rows = await Promise.all(viewable.users.map(async u => {
    const { totalMinutes } = await computeWeekData(db, u.user_id, monday, sunday)
    const text = await fetchReportText(db, u.user_id, toISODate(monday))
    return { user: u, totalMinutes, submitted: !!text }
  }))

  bodyEl.innerHTML = `
    ${historyNavHTML(monday)}
    <table class="summary-table">
      <thead><tr><th>Name</th><th>Hours</th><th>Report</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr onclick="window.jumpToUser('${r.user.user_id}')">
            <td>${r.user.name}</td>
            <td>${fmtHours(r.totalMinutes)}</td>
            <td><span class="bucket-tag ${r.submitted ? '20to40' : 'under20'}">${r.submitted ? 'Saved' : 'Not saved'}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>
  `
}

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── CHIPS / NAV ──────────────────────────────────────────────────────────

window.toggleChip = function(name) {
  if (name === 'overdue') {
    overdueOnly = !overdueOnly
    document.getElementById('chipOverdue').classList.toggle('active', overdueOnly)
  }
  refresh()
}

window.jumpToUser = function(userId) {
  selectedUserId = userId
  userSelect.value = userId
  refresh()
}

init()
