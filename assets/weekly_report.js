/**
 * weekly_report.js — Vidai to Mulai · Weekly Report (personal editor)
 *
 *   THIS WEEK  — fully live. Time View / Task View / Gig View compute
 *                fresh, same as always. Text fields (Accomplishment /
 *                Next steps / Support needed) are editable and saved.
 *
 *   LAST WEEK  — a dedicated tab. Shows ONLY the saved text fields for
 *                last week, read-only — the quick "what did I say I'd
 *                do" check against this week's accomplishments.
 *
 *   HISTORY    — a separate tab covering weeks -2 through -11 (10 weeks,
 *                capped). Time/Task/Gig View + saved text for whichever
 *                past week is selected via Previous/Next. Safe to
 *                recompute for any past week because report_data.js
 *                anchors everything to fixed dated facts (entry_date,
 *                updated_at, created_at), not a gig's current status or
 *                assignment — see that file's header comment.
 *
 * Week window is Saturday → Friday (see report_data.js's saturdayOf).
 */

import { db } from './vtm_db.js'
import {
  saturdayOf, addDays, toISODate, fmtWeekLabel, fmtHours, fmtDateTimeShort,
  computeWeekData, fetchReportText, saveReportText,
  fetchTasksChangedForUser, fetchGigChangesForUser,
} from './report_data.js'
import { canToggleTask }  from './gig_tasks.js'
import { toggleTaskDone } from './vtm_api.js'

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }
const myUserId = session.user_id

// This week never moves — no offset, no navigation.
const currentMonday  = saturdayOf(new Date())
const currentSunday  = addDays(currentMonday, 6)
const lastWeekMonday = addDays(currentMonday, -7)

// History covers offsets -2 .. -11 (10 weeks) — -1 stays exclusive to
// the Last Week tab so the two don't overlap.
const HISTORY_MIN_OFFSET = -11
const HISTORY_MAX_OFFSET = -2
let historyOffset = HISTORY_MAX_OFFSET

let fields         = { accomplishment: '', next_steps: '', support_needed: '' }
let hasExistingRow = false
let currentView    = null    // null | 'time' | 'task' | 'gig' | 'lastweek' | 'history'
let lastTasks       = []     // tasks currently shown in Task View — kept for in-place toggle updates

const weekLabelEl = document.getElementById('weekLabel')
const bodyEl       = document.getElementById('reportBody')

async function init() {
  weekLabelEl.textContent = fmtWeekLabel(currentMonday)

  const existing = await fetchReportText(db, myUserId, toISODate(currentMonday))
  hasExistingRow = !!existing
  fields = {
    accomplishment: existing?.accomplishment || '',
    next_steps:     existing?.next_steps     || '',
    support_needed: existing?.support_needed || '',
  }

  bodyEl.innerHTML = `
    <div id="viewPanel"></div>
    <div class="text-block">
      <div class="section-label">This week</div>
      ${textBlockHTML('Accomplishment', fields.accomplishment, 'accomplishment', 'What moved forward this week\u2026')}
      ${textBlockHTML('Next steps',     fields.next_steps,     'next_steps',     'What\u2019s planned for next week\u2026')}
      ${textBlockHTML('Support needed', fields.support_needed, 'support_needed', 'Specific ask, or \u2018None\u2019\u2026')}
      <div class="report-actions">
        <span class="save-note" id="saveNote"></span>
        <button class="btn-save" onclick="saveReport()">Save</button>
      </div>
    </div>
  `
}

// ── VIEW TOGGLE ──────────────────────────────────────────────────────────

window.setView = async function(view) {
  const panel = document.getElementById('viewPanel')

  if (currentView === view) {
    currentView = null
    if (panel) panel.innerHTML = ''
    syncTabState()
    return
  }

  currentView = view
  syncTabState()
  if (panel) panel.innerHTML = '<div class="empty-week">Loading\u2026</div>'
  await renderViewPanel(view)
}

function syncTabState() {
  document.querySelectorAll('.view-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.view === currentView)
  })
}

async function renderViewPanel(view) {
  const panel = document.getElementById('viewPanel')
  if (!panel) return

  if (view === 'time') {
    const { gigs, closedLine, timeSlices } = await computeWeekData(db, myUserId, currentMonday, currentSunday)
    panel.innerHTML = `
      ${buildBarsHTML(timeSlices)}
      ${buildGigsListHTML(gigs.filter(g => g.minutes > 0))}
      ${closedLine ? `<div class="closed-line">${closedLine}</div>` : ''}
    `
  } else if (view === 'task') {
    lastTasks = await fetchTasksChangedForUser(db, myUserId, currentMonday, currentSunday)
    panel.innerHTML = `<div class="section-label">Tasks changed this week</div>${buildTaskChangesHTML(lastTasks)}`
  } else if (view === 'gig') {
    const { created, completed } = await fetchGigChangesForUser(db, myUserId, currentMonday, currentSunday)
    panel.innerHTML = buildGigChangesHTML(created, completed)
  } else if (view === 'lastweek') {
    const text = await fetchReportText(db, myUserId, toISODate(lastWeekMonday))
    panel.innerHTML = buildLastWeekHTML(text)
  } else if (view === 'history') {
    await renderHistoryPanel()
  }
}

// ── HISTORY (weeks -2 .. -11 — Previous/Next, capped) ───────────────────

window.historyNav = async function(delta) {
  const next = historyOffset + delta
  if (next > HISTORY_MAX_OFFSET || next < HISTORY_MIN_OFFSET) return
  historyOffset = next
  await renderHistoryPanel()
}

async function renderHistoryPanel() {
  const panel = document.getElementById('viewPanel')
  if (!panel) return

  const monday = addDays(currentMonday, historyOffset * 7)
  const sunday = addDays(monday, 6)

  const [{ gigs, closedLine, timeSlices }, tasks, gigChanges, text] = await Promise.all([
    computeWeekData(db, myUserId, monday, sunday),
    fetchTasksChangedForUser(db, myUserId, monday, sunday),
    fetchGigChangesForUser(db, myUserId, monday, sunday),
    fetchReportText(db, myUserId, toISODate(monday)),
  ])

  panel.innerHTML = `
    <div class="history-nav">
      <button class="history-nav-btn" onclick="historyNav(-1)" ${historyOffset <= HISTORY_MIN_OFFSET ? 'disabled' : ''}>&#8249;</button>
      <span class="history-label">${fmtWeekLabel(monday)}</span>
      <button class="history-nav-btn" onclick="historyNav(1)" ${historyOffset >= HISTORY_MAX_OFFSET ? 'disabled' : ''}>&#8250;</button>
    </div>
    ${buildBarsHTML(timeSlices)}
    ${buildGigsListHTML(gigs.filter(g => g.minutes > 0))}
    ${closedLine ? `<div class="closed-line">${closedLine}</div>` : ''}
    <div class="section-label" style="margin-top:16px">Tasks changed</div>
    ${buildTaskChangesHTML(tasks, true)}
    ${buildGigChangesHTML(gigChanges.created, gigChanges.completed)}
    <div class="section-label" style="margin-top:16px">${fmtWeekLabel(monday)} \u2014 as saved</div>
    ${text
      ? textReadonlyHTML('Accomplishment', text.accomplishment) + textReadonlyHTML('Next steps', text.next_steps) + textReadonlyHTML('Support needed', text.support_needed)
      : `<div class="empty-week">No report was saved for this week.</div>`}
  `


// ── LAST WEEK (static, read-only — nothing recomputed) ──────────────────

function buildLastWeekHTML(text) {
  if (!text) {
    return `<div class="empty-week">No report was saved for last week (${fmtWeekLabel(lastWeekMonday)}).</div>`
  }
  return `
    <div class="section-label">${fmtWeekLabel(lastWeekMonday)} \u2014 as saved</div>
    ${textReadonlyHTML('Accomplishment', text.accomplishment)}
    ${textReadonlyHTML('Next steps',     text.next_steps)}
    ${textReadonlyHTML('Support needed', text.support_needed)}
  `
}

function textReadonlyHTML(label, value) {
  return `<div class="text-readonly"><label>${label}</label><div style="font-size:13px;color:var(--black);white-space:pre-wrap;">${esc(value) || '\u2014'}</div></div>`
}

// ── TIME VIEW ──────────────────────────────────────────────────────────

function buildBarsHTML(slices) {
  const total = slices.reduce((s, x) => s + x.minutes, 0)
  if (!total) return '<div class="bars-empty">No time logged yet this week.</div>'
  const rows = slices.map(s => `
    <div class="bar-row">
      <span>${s.label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (s.minutes / (40*60)) * 100)}%;background:${s.color}"></div></div>
      <span class="bar-row-value">${fmtHours(s.minutes)}</span>
    </div>`).join('')
  return `<div class="section-label">Time this week &middot; of 40h</div><div class="bars-section">${rows}</div>`
}

function buildGigsListHTML(gigs) {
  if (!gigs.length) return '<div class="gigs-list"><div class="empty-week">No time logged against any gig this week.</div></div>'
  const rows = gigs.map(g => `
    <div class="gig-row">
      <div class="gig-row-title"><span class="gig-row-code">${g.gig_code}</span> ${g.title}</div>
      <span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span>
      <span class="gig-row-due${g.isOverdue ? ' overdue' : ''}">${g.date_due || '\u2014'}</span>
      <span class="gig-row-hours">${fmtHours(g.minutes)}</span>
    </div>`).join('')
  return `<div class="section-label">Active gigs &middot; auto-filled</div><div class="gigs-list">${rows}</div>`
}

// ── TASK VIEW ─────────────────────────────────────────────────────────

function buildTaskChangesHTML(tasks, readOnly) {
  if (!tasks.length) return '<div class="gigs-list"><div class="empty-week">No tasks changed this week.</div></div>'

  const rows = tasks.map(t => {
    const g = t.gigs
    const toggle = !readOnly && canToggleTask(t, session, g)
    const checkAttr = toggle
      ? `onchange="toggleReportTask('${t.task_id}', this.checked)"`
      : 'disabled'

    return `
      <div class="gig-row">
        <div class="gig-row-title${t.done ? ' task-title-done' : ''}"><span class="gig-row-code">${g.gig_code}</span> ${t.title}</div>
        <span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span>
        <span class="gig-row-due">${fmtDateTimeShort(t.updated_at)}</span>
        <input type="checkbox" class="task-check" ${t.done ? 'checked' : ''} ${checkAttr}>
      </div>`
  }).join('')

  return `<div class="gigs-list">${rows}</div>`
}

window.toggleReportTask = async function(taskId, done) {
  const { error } = await toggleTaskDone(db, taskId, done)
  if (error) { showToast('Could not update task', 'err'); return }

  const t = lastTasks.find(x => x.task_id === taskId)
  if (t) t.done = done

  const panel = document.getElementById('viewPanel')
  if (panel) panel.innerHTML = buildTaskChangesHTML(lastTasks)

  showToast(done ? 'Marked done' : 'Marked not done', 'ok')
}

// ── GIG VIEW (rough — placed/completed this week) ───────────────────────

function buildGigChangesHTML(created, completed) {
  if (!created.length && !completed.length) {
    return '<div class="gigs-list"><div class="empty-week">No gigs placed or completed this week.</div></div>'
  }

  const section = (label, items, kind) => {
    if (!items.length) return ''
    const rows = items.map(g => `
      <div class="gig-row">
        <div class="gig-row-title"><span class="gig-row-code">${g.gig_code}</span> ${g.title}</div>
        <span class="status-pill ${kind === 'completed' ? 'completed' : 'placed'}">${kind === 'completed' ? 'Completed' : 'Placed'}</span>
        <span class="gig-row-due">${g.date || '\u2014'}</span>
        <span></span>
      </div>`).join('')
    return `<div class="section-label">${label}</div><div class="gigs-list">${rows}</div>`
  }

  return `
    ${section('Gigs placed this week', created, 'placed')}
    ${section('Gigs completed this week', completed, 'completed')}
  `
}

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── TEXT BLOCKS (this week — editable) ────────────────────────────────────

function textBlockHTML(label, value, fieldId, placeholder) {
  return `<div class="text-block-card">
    <label>${label}</label>
    <textarea id="field_${fieldId}" placeholder="${placeholder}" oninput="fields.${fieldId} = this.value">${value}</textarea>
  </div>`
}

window.saveReport = async function() {
  ;['accomplishment', 'next_steps', 'support_needed'].forEach(f => {
    const el = document.getElementById('field_' + f)
    if (el) fields[f] = el.value
  })

  if (hasExistingRow && !confirm('You already have a saved report for this week \u2014 overwrite it?')) return

  const { error } = await saveReportText(db, myUserId, toISODate(currentMonday), fields)

  if (error) { showToast('Save failed \u2014 ' + error.message, 'err'); return }
  showToast('Saved', 'ok')
  hasExistingRow = true
}

// ── INIT ─────────────────────────────────────────────────────────────────

init()
