/**
 * weekly_report.js — Vidai to Mulai · Weekly Report (personal editor)
 * No lock, no draft/submitted lifecycle — any week is navigable and
 * editable, always live. Only the free text persists (weekly_reports);
 * gigs/hours/bars are computed fresh every time via report_data.js.
 */

import { db } from './vtm_db.js'
import {
  mondayOf, addDays, toISODate, fmtWeekLabel, fmtHours,
  computeWeekData, fetchReportText, saveReportText,
} from './report_data.js'

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }
const myUserId = session.user_id

let weekOffset = 0   // 0 = this week; negative = past weeks; forward capped at 0
let fields = { accomplishment: '', next_steps: '', support_needed: '' }
let hasExistingRow = false

const weekLabelEl = document.getElementById('weekLabel')
const bodyEl       = document.getElementById('reportBody')
const nextBtn       = document.getElementById('nextWeekBtn')

async function loadWeek() {
  const monday = addDays(mondayOf(new Date()), weekOffset * 7)
  const sunday = addDays(monday, 6)
  const weekISO = toISODate(monday)

  weekLabelEl.textContent = fmtWeekLabel(monday)
  nextBtn.disabled = weekOffset >= 0
  bodyEl.innerHTML = '<div class="empty-week">Loading&hellip;</div>'

  const [{ gigs, closedLine, timeSlices }, existing] = await Promise.all([
    computeWeekData(db, myUserId, monday, sunday),
    fetchReportText(db, myUserId, weekISO),
  ])

  hasExistingRow = !!existing
  fields = {
    accomplishment: existing?.accomplishment || '',
    next_steps:     existing?.next_steps     || '',
    support_needed: existing?.support_needed || '',
  }

  bodyEl.innerHTML = `
    ${buildBarsHTML(timeSlices)}
    ${buildGigsListHTML(gigs.filter(g => g.minutes > 0))}
    ${closedLine ? `<div class="closed-line">${closedLine}</div>` : ''}
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

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

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

  const monday = addDays(mondayOf(new Date()), weekOffset * 7)
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
