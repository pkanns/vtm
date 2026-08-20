/**
 * weekly_report.js — Vidai to Mulai · Weekly Report (personal editor)
 * No lock, no draft/submitted lifecycle — any week is navigable and
 * editable, always live. Only the free text persists (weekly_reports);
 * gigs/hours/bars/tasks are computed fresh every time via report_data.js.
 *
 * Two views, toggled at the top — Time View (default, unchanged bars +
 * gigs-with-hours) and Task View (tasks whose status/assignment changed
 * this week, with a toggle-complete action). The free-text reflection
 * fields always stay visible below whichever view is active, in their
 * own #reportBody sub-container so switching views or toggling a task
 * never clobbers an unsaved draft in those fields.
 *
 * Week window is Saturday → Friday (see report_data.js's saturdayOf) —
 * the weekend opens a week rather than closing one.
 */

import { db } from './vtm_db.js'
import {
  saturdayOf, addDays, toISODate, fmtWeekLabel, fmtHours, fmtDateTimeShort,
  computeWeekData, fetchReportText, saveReportText, fetchTasksChangedForUser,
} from './report_data.js'
import { canToggleTask }  from './gig_tasks.js'
import { toggleTaskDone } from './vtm_api.js'

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }
const myUserId = session.user_id

let weekOffset = 0   // 0 = this week; negative = past weeks; forward capped at 0
let fields = { accomplishment: '', next_steps: '', support_needed: '' }
let hasExistingRow = false
let currentView = 'time'   // 'time' | 'task'
let lastTasks = []         // tasks currently shown in Task View — kept for in-place toggle updates

const weekLabelEl = document.getElementById('weekLabel')
const bodyEl       = document.getElementById('reportBody')
const nextBtn       = document.getElementById('nextWeekBtn')

async function loadWeek() {
  const monday = addDays(saturdayOf(new Date()), weekOffset * 7)
  const sunday = addDays(monday, 6)
  const weekISO = toISODate(monday)

  weekLabelEl.textContent = fmtWeekLabel(monday)
  nextBtn.disabled = weekOffset >= 0
  bodyEl.innerHTML = '<div class="empty-week">Loading&hellip;</div>'

  const [existing, viewSectionHTML] = await Promise.all([
    fetchReportText(db, myUserId, weekISO),
    buildViewSection(monday, sunday),
  ])

  hasExistingRow = !!existing
  fields = {
    accomplishment: existing?.accomplishment || '',
    next_steps:     existing?.next_steps     || '',
    support_needed: existing?.support_needed || '',
  }

  bodyEl.innerHTML = `
    <div id="viewSection">${viewSectionHTML}</div>
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

// ── VIEW SECTION ─────────────────────────────────────────────────────────

async function buildViewSection(monday, sunday) {
  if (currentView === 'task') {
    lastTasks = await fetchTasksChangedForUser(db, myUserId, monday, sunday)
    return buildTaskChangesHTML(lastTasks)
  }

  const { gigs, closedLine, timeSlices } = await computeWeekData(db, myUserId, monday, sunday)
  return `
    ${buildBarsHTML(timeSlices)}
    ${buildGigsListHTML(gigs.filter(g => g.minutes > 0))}
    ${closedLine ? `<div class="closed-line">${closedLine}</div>` : ''}
  `
}

window.setView = function(view) {
  if (view === currentView) return
  currentView = view
  document.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view))
  loadWeek()
}

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

function buildTaskChangesHTML(tasks) {
  if (!tasks.length) return '<div class="gigs-list"><div class="empty-week">No tasks changed this week.</div></div>'

  const rows = tasks.map(t => {
    const g = t.gigs
    const toggle = canToggleTask(t, session, g)
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

  return `<div class="section-label">Tasks changed this week</div><div class="gigs-list">${rows}</div>`
}

window.toggleReportTask = async function(taskId, done) {
  const { error } = await toggleTaskDone(db, taskId, done)
  if (error) { showToast('Could not update task', 'err'); return }

  const t = lastTasks.find(x => x.task_id === taskId)
  if (t) t.done = done

  const el = document.getElementById('viewSection')
  if (el) el.innerHTML = buildTaskChangesHTML(lastTasks)

  showToast(done ? 'Marked done' : 'Marked not done', 'ok')
}

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── TEXT BLOCKS ──────────────────────────────────────────────────────────

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

  const monday = addDays(saturdayOf(new Date()), weekOffset * 7)
  const { error } = await saveReportText(db, myUserId, toISODate(monday), fields)

  if (error) { showToast('Save failed \u2014 ' + error.message, 'err'); return }
  showToast('Saved', 'ok')
  hasExistingRow = true
}

window.goWeek = function(delta) {
  const next = weekOffset + delta
  if (next > 0) return
  weekOffset = next
  loadWeek()
}

loadWeek()
