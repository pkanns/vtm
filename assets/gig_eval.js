/**
 * gig_eval.js — Vidai to Mulai · Gig Evaluation
 * Decluttered: no D2/D3 dimension grouping, no field/desk weighting, no
 * incentive math. One flat table of attributes; the only calculation
 * left is Final Score = simple average of the Lead's star ratings.
 *
 * Role-split, same as before:
 *   rover (Doer)  → saves their own rating column only, does not complete gig
 *   pacer (Lead)  → saves their own rating column + final score, completes gig
 *   admin         → saves everything in one shot, completes gig
 *
 * Detail panels pull real gig facts so the rating isn't made blind:
 *   Planning → Budget (estimate only — no itemized lines or actual spend
 *              are persisted anywhere yet)
 *   Timeline → Dates (due vs. today, plus how many checklist tasks were
 *              still open — pulled from gig_tasks)
 *   Quality  → Tasks (the full checklist, done/not-done)
 *   Execution, Reflection, Cost → no panel, no objective data source
 */

import { db }                              from './vtm_db.js'
import { fetchGigsForEval, fetchEvaluationByGig,
         fetchUsersByIds, fetchTasksByGig,
         updateGigStatus, esc }            from './vtm_api.js'
import { renderGigPickerCard }             from './vtm_cards.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()
const role     = session?.role    || 'admin'
const myUserId = session?.user_id || null

// ── ATTRIBUTE CONFIG ─────────────────────────────────────────────────────
// key → existing evaluations table column names (unchanged, no schema
// migration needed — d2_score/d3_score simply stop being written).

const ATTRS = [
  { key: 'planning',   label: 'Planning',   desc: 'Ability to foresee needs, think long term',                         details: 'budget', fieldOnly: false },
  { key: 'execution',  label: 'Execution',  desc: 'Relationships maintained · Partnerships built',                     details: null,     fieldOnly: false },
  { key: 'reflection', label: 'Reflection', desc: 'Learnings documented · Improvement opportunities identified',       details: null,     fieldOnly: false },
  { key: 'cost',       label: 'Cost',       desc: 'Delivered within agreed budget',                                    details: null,     fieldOnly: true  },
  { key: 'quality',    label: 'Quality',    desc: 'Quality of deliverable meets agreed standard',                      details: 'tasks',  fieldOnly: false },
  { key: 'timeline',   label: 'Timeline',   desc: 'Delivered on time as agreed',                                       details: 'dates',  fieldOnly: false },
]

const DB_FIELD = {
  planning:   { rover: 'd2_planning_rover',   pacer: 'd2_planning_pacer'   },
  execution:  { rover: 'd2_execution_rover',  pacer: 'd2_execution_pacer'  },
  reflection: { rover: 'd2_reflection_rover', pacer: 'd2_reflection_pacer' },
  cost:       { rover: 'd3_cost_rover',       pacer: 'd3_cost_pacer'       },
  quality:    { rover: 'd3_quality_rover',    pacer: 'd3_quality_pacer'    },
  timeline:   { rover: 'd3_timeline_rover',   pacer: 'd3_timeline_pacer'   },
}

const DETAILS_LABEL = { budget: 'View Budget', dates: 'View Dates', tasks: 'View Tasks' }

// ── STATE ─────────────────────────────────────────────────────────────────

let gigPickerData = []
let currentGig    = null   // full gig row for the selected gig
let currentTasks  = []
let currentEval   = null   // existing evaluations row, or null

// ── GIG PICKER ────────────────────────────────────────────────────────────

async function loadGigPicker() {
  const { data, error } = await fetchGigsForEval(db)

  const grid  = document.getElementById('gigPickerGrid')
  const empty = document.getElementById('pickerEmpty')
  const label = document.getElementById('pickerLabel')

  if (error || !data || !data.length) {
    grid.style.display  = 'none'
    empty.style.display = 'block'
    empty.textContent   = error ? 'Could not connect to database' : 'No gigs are ready for reflection right now.'
    label.textContent   = 'Ready for Reflection'
    return
  }

  // Filter by role
  let visible = data
  if (role === 'rover' && myUserId) visible = data.filter(g => g.rover_id === myUserId)
  if (role === 'pacer' && myUserId) visible = data.filter(g => g.pacer_id === myUserId)

  if (!visible.length) {
    grid.style.display  = 'none'
    empty.style.display = 'block'
    empty.textContent   = 'No gigs assigned to you are ready for evaluation.'
    return
  }

  grid.style.display  = 'grid'
  empty.style.display = 'none'
  label.textContent   = `${visible.length} gig${visible.length !== 1 ? 's' : ''} ready for reflection — select one to begin`
  gigPickerData = visible

  grid.innerHTML = visible.map(g =>
    renderGigPickerCard(g, { dueLabel: g.date_due ? `Due ${fmtDateShort(g.date_due)}` : 'No due date' })
  ).join('')
}

// ── SELECT GIG ────────────────────────────────────────────────────────────

window.selectGig = async function(gigId) {
  const gig = gigPickerData.find(g => g.gig_id === gigId)
  if (!gig) return
  currentGig = gig

  const [namesRes, tasksRes, evalRes] = await Promise.all([
    fetchUsersByIds(db, [gig.pacer_id, gig.rover_id]),
    fetchTasksByGig(db, gigId),
    fetchEvaluationByGig(db, gigId),
  ])

  const nameById = {}
  ;(namesRes.data || []).forEach(u => { nameById[u.user_id] = u.name })
  currentGig.pacerName = nameById[gig.pacer_id] || '—'
  currentGig.roverName = nameById[gig.rover_id] || '—'

  currentTasks = tasksRes.data || []
  currentEval  = evalRes.error ? null : evalRes.data

  // Meta strip
  document.getElementById('metaGigCode').textContent = gig.gig_code || '—'
  document.getElementById('metaRover').textContent   = currentGig.roverName
  document.getElementById('metaPacer').textContent   = currentGig.pacerName
  document.getElementById('metaSetting').textContent = gig.setting === 'desk' ? 'Desk' : 'Field'
  document.getElementById('loadedGigLabel').textContent = `${gig.gig_code} · ${gig.title}`
  document.getElementById('reflectionDate').value = currentEval?.eval_date || new Date().toISOString().split('T')[0]
  document.getElementById('notes').value = currentEval?.discussion_notes || ''

  renderRatingsTable()
  _applyRoleButtons()
  recalcFinal()

  document.getElementById('pickerSection').style.display = 'none'
  document.getElementById('loadedSection').style.display = 'block'
}

// ── RESET TO PICKER ───────────────────────────────────────────────────────

window.resetPicker = function() {
  currentGig = null
  document.getElementById('pickerSection').style.display = 'block'
  document.getElementById('loadedSection').style.display = 'none'
}

// ── RATINGS TABLE ─────────────────────────────────────────────────────────

function renderRatingsTable() {
  const body = document.getElementById('ratingsBody')
  body.innerHTML = ATTRS.map(attrRowHTML).join('')

  // Wire star → slider sync + slider → star sync for every widget just rendered
  ATTRS.forEach(cfg => {
    ;['rover', 'pacer'].forEach(who => {
      document.querySelectorAll(`input[name="${cfg.key}-${who}"]`).forEach(radio => {
        radio.addEventListener('change', () => onStarChange(cfg.key, who, radio.value))
      })
    })
  })
}

function attrRowHTML(cfg) {
  const roverVal = currentEval ? currentEval[DB_FIELD[cfg.key].rover] : null
  const pacerVal = currentEval ? currentEval[DB_FIELD[cfg.key].pacer] : null

  const roverEditable = role === 'rover' || role === 'admin'
  const pacerEditable = role === 'pacer' || role === 'admin'

  const hidden = cfg.fieldOnly && currentGig.setting === 'desk'

  const detailsBtn = cfg.details
    ? `<button type="button" class="attr-details-toggle" id="toggle-${cfg.key}" onclick="toggleDetails('${cfg.key}')">${DETAILS_LABEL[cfg.details]} ⌄</button>`
    : ''

  const rowsHTML = `
    <tr class="attr-row" data-attr="${cfg.key}"${hidden ? ' style="display:none"' : ''}>
      <td>
        <div class="attr-name">${cfg.label}</div>
        <div class="attr-desc">${cfg.desc}</div>
        ${detailsBtn}
      </td>
      <td class="center">${starWidgetHTML(cfg.key, 'rover', roverVal, roverEditable)}</td>
      <td class="center">${starWidgetHTML(cfg.key, 'pacer', pacerVal, pacerEditable)}</td>
      <td class="center score-cell" id="score-${cfg.key}">${pacerVal || '—'}</td>
    </tr>`

  const detailsHTML = cfg.details
    ? `<tr class="details-row" id="details-row-${cfg.key}" style="display:none"${hidden ? ' hidden' : ''}>
         <td colspan="4"><div class="details-panel">${buildDetailsPanel(cfg.details)}</div></td>
       </tr>`
    : ''

  return rowsHTML + detailsHTML
}

function starWidgetHTML(attr, who, value, editable) {
  const stars = [5, 4, 3, 2, 1].map(n => `
    <input type="radio" name="${attr}-${who}" id="${attr}-${who}-${n}" value="${n}" ${Number(value) === n ? 'checked' : ''} ${editable ? '' : 'disabled'}>
    <label for="${attr}-${who}-${n}">★</label>`).join('')

  return `
    <div class="star-rating-widget${editable ? '' : ' disabled'}">
      <div class="stars">${stars}</div>
      <input type="range" class="star-slider" id="slider-${attr}-${who}" min="1" max="5"
        value="${value || 3}" ${editable ? '' : 'disabled'}
        oninput="onSliderInput('${attr}','${who}',this.value)">
    </div>`
}

// ── STAR / SLIDER SYNC ───────────────────────────────────────────────────

window.onSliderInput = function(attr, who, val) {
  const radio = document.getElementById(`${attr}-${who}-${val}`)
  if (radio) radio.checked = true
  onStarChange(attr, who, val)
}

function onStarChange(attr, who, val) {
  const slider = document.getElementById(`slider-${attr}-${who}`)
  if (slider) slider.value = val
  if (who === 'pacer') {
    const cell = document.getElementById(`score-${attr}`)
    if (cell) cell.textContent = val
    recalcFinal()
  }
}

// ── FINAL SCORE — simple average of whatever Lead ratings are set ────────

function recalcFinal() {
  const visibleAttrs = ATTRS.filter(a => !(a.fieldOnly && currentGig?.setting === 'desk'))
  const vals = visibleAttrs
    .map(a => document.querySelector(`input[name="${a.key}-pacer"]:checked`)?.value)
    .filter(v => v !== undefined)
    .map(Number)

  const numEl = document.getElementById('finalNum')
  const subEl = document.getElementById('finalSub')
  const starsEl = document.getElementById('finalStars')

  if (!vals.length) {
    numEl.textContent = '—'
    subEl.textContent = 'Average of Lead ratings'
    starsEl.textContent = ''
    return
  }

  const avg = vals.reduce((s, v) => s + v, 0) / vals.length
  numEl.textContent = avg.toFixed(1)
  subEl.textContent = `Average of ${vals.length} of ${visibleAttrs.length} rating${visibleAttrs.length !== 1 ? 's' : ''}`
  const rounded = Math.round(avg)
  starsEl.textContent = '★'.repeat(rounded) + '☆'.repeat(5 - rounded)
}

// ── DETAILS PANELS ────────────────────────────────────────────────────────

window.toggleDetails = function(attr) {
  const row = document.getElementById(`details-row-${attr}`)
  const btn = document.getElementById(`toggle-${attr}`)
  if (!row) return
  const open = row.style.display === 'none'
  row.style.display = open ? 'table-row' : 'none'
  if (btn) {
    btn.classList.toggle('open', open)
    btn.textContent = btn.textContent.replace(open ? '⌄' : '⌃', open ? '⌃' : '⌄')
  }
}

function buildDetailsPanel(type) {
  if (type === 'budget') return budgetPanelHTML()
  if (type === 'dates')  return datesPanelHTML()
  if (type === 'tasks')  return tasksPanelHTML()
  return ''
}

function budgetPanelHTML() {
  const total = currentGig.budget_total
  return `
    <div class="details-row-line"><span class="k">Estimated Total</span><span class="v">${total ? '₹ ' + Number(total).toLocaleString('en-IN') : '—'}</span></div>
    <div class="details-note">Only the estimate is tracked today — individual line items and actual spend aren't persisted, so this is all there is to show.</div>`
}

function datesPanelHTML() {
  const due   = currentGig.date_due
  const start = currentGig.date_start
  const today = new Date()

  const dueDate = due ? new Date(due) : null
  let resultLine = ''
  if (dueDate) {
    const diffDays = Math.round((today - dueDate) / (1000 * 60 * 60 * 24))
    if (diffDays > 0)  resultLine = `<div class="details-row-line"><span class="k">Status</span><span class="v warn">${diffDays} day${diffDays !== 1 ? 's' : ''} overdue</span></div>`
    if (diffDays <= 0) resultLine = `<div class="details-row-line"><span class="k">Status</span><span class="v">${-diffDays} day${-diffDays !== 1 ? 's' : ''} remaining</span></div>`
  }

  const openTasks = currentTasks.filter(t => !t.done).length
  const taskLine = currentTasks.length
    ? `<div class="details-note">${openTasks} of ${currentTasks.length} checklist task${currentTasks.length !== 1 ? 's' : ''} ${openTasks ? 'still open' : 'were complete'} as of now — worth weighing against Quality.</div>`
    : ''

  return `
    ${start ? `<div class="details-row-line"><span class="k">Started</span><span class="v">${fmtDateShort(start)}</span></div>` : ''}
    <div class="details-row-line"><span class="k">Due</span><span class="v">${due ? fmtDateShort(due) : '—'}</span></div>
    ${resultLine}
    ${taskLine}`
}

function tasksPanelHTML() {
  if (!currentTasks.length) {
    return `<div class="details-note">No checklist tasks on this gig.</div>`
  }
  const done = currentTasks.filter(t => t.done).length
  const rows = currentTasks.map(t => `<div>${t.done ? '☑' : '☐'} ${esc(t.title)}</div>`).join('')
  return `
    <div class="details-row-line"><span class="k">Checklist</span><span class="v">${done} of ${currentTasks.length} completed</span></div>
    <div class="details-list">${rows}</div>`
}

// ── ROLE-BASED SUBMIT BUTTONS ─────────────────────────────────────────────

function _applyRoleButtons() {
  const submitRover = document.getElementById('submitRoverBtn')
  const submitPacer = document.getElementById('submitPacerBtn')
  const submitBoth  = document.getElementById('submitBtn')

  submitRover.style.display = role === 'rover' ? 'inline-block' : 'none'
  submitPacer.style.display = role === 'pacer' ? 'inline-block' : 'none'
  submitBoth.style.display  = role === 'admin' ? 'inline-block' : 'none'
}

// ── VALUE READERS ─────────────────────────────────────────────────────────

const _r = (attr, who) => {
  const v = document.querySelector(`input[name="${attr}-${who}"]:checked`)?.value
  return v ? parseFloat(v) : null
}

function computeFinalScore() {
  const visibleAttrs = ATTRS.filter(a => !(a.fieldOnly && currentGig?.setting === 'desk'))
  const vals = visibleAttrs.map(a => _r(a.key, 'pacer')).filter(v => v !== null)
  if (!vals.length) return null
  return vals.reduce((s, v) => s + v, 0) / vals.length
}

// ── SUBMIT — ROVER (Doer self-rating only) ────────────────────────────────

window.submitRoverEval = async function() {
  if (!currentGig) { showToast('Please select a gig first', 'err'); return }

  const payload = { gig_id: currentGig.gig_id, eval_date: document.getElementById('reflectionDate').value || null }
  ATTRS.forEach(a => { payload[DB_FIELD[a.key].rover] = _r(a.key, 'rover') })
  payload.submitted_by_rover = true
  payload.submitted_by       = 'rover'
  payload.discussion_notes   = document.getElementById('notes').value || null

  const btn = document.getElementById('submitRoverBtn')
  btn.disabled = true; btn.textContent = 'Saving…'

  const { error } = await db.from('evaluations').upsert(payload, { onConflict: 'gig_id' })

  if (error) {
    showToast('Save failed — ' + error.message, 'err')
    btn.disabled = false; btn.textContent = 'Save Self-Rating →'
    return
  }

  showToast('Self-rating saved', 'ok')
  btn.textContent = 'Saved ✓'
}

// ── SUBMIT — PACER (Lead rates Doer, completes gig) ───────────────────────

window.submitPacerEval = async function() {
  if (!currentGig) { showToast('Please select a gig first', 'err'); return }

  const finalScore = computeFinalScore()
  const payload = { gig_id: currentGig.gig_id, eval_date: document.getElementById('reflectionDate').value || null }
  ATTRS.forEach(a => { payload[DB_FIELD[a.key].pacer] = _r(a.key, 'pacer') })
  payload.final_score        = finalScore
  payload.submitted_by_pacer = true
  payload.submitted_by       = 'pacer'
  payload.discussion_notes   = document.getElementById('notes').value || null

  const btn = document.getElementById('submitPacerBtn')
  btn.disabled = true; btn.textContent = 'Saving…'

  const { error } = await db.from('evaluations').upsert(payload, { onConflict: 'gig_id' })

  if (error) {
    showToast('Save failed — ' + error.message, 'err')
    btn.disabled = false; btn.textContent = 'Save Evaluation →'
    return
  }

  await updateGigStatus(db, currentGig.gig_id, 'completed')
  showToast('Evaluation saved. Gig marked completed.', 'ok')
  btn.textContent = 'Saved ✓'
}

// ── SUBMIT — ADMIN (everything in one shot) ───────────────────────────────

window.submitEval = async function() {
  if (!currentGig) { showToast('Please select a gig first', 'err'); return }

  const finalScore = computeFinalScore()
  const payload = { gig_id: currentGig.gig_id, eval_date: document.getElementById('reflectionDate').value || null }
  ATTRS.forEach(a => {
    payload[DB_FIELD[a.key].rover] = _r(a.key, 'rover')
    payload[DB_FIELD[a.key].pacer] = _r(a.key, 'pacer')
  })
  payload.final_score        = finalScore
  payload.submitted_by_rover = true
  payload.submitted_by_pacer = true
  payload.submitted_by       = 'admin'
  payload.discussion_notes   = document.getElementById('notes').value || null

  const btn = document.getElementById('submitBtn')
  btn.disabled = true; btn.textContent = 'Saving…'

  const { error } = await db.from('evaluations').upsert(payload, { onConflict: 'gig_id' })

  if (error) {
    showToast('Save failed — ' + error.message, 'err')
    btn.disabled = false; btn.textContent = 'Save Evaluation →'
    return
  }

  await updateGigStatus(db, currentGig.gig_id, 'completed')
  downloadEvalXLSX(finalScore)
  showToast('Evaluation saved. Gig marked completed.', 'ok')
  btn.textContent = 'Saved ✓'
}

// ── XLSX EXPORT (admin only, unchanged behaviour, simplified content) ─────

function downloadEvalXLSX(finalScore) {
  if (typeof XLSX === 'undefined') return
  const code = currentGig.gig_code || 'G00'

  const rows = [
    ['Gig Code', code],
    ['Gig Title', currentGig.title || ''],
    ['Doer', currentGig.roverName || ''],
    ['Lead', currentGig.pacerName || ''],
    ['Reflection Date', document.getElementById('reflectionDate').value || ''],
    [],
    ['Attribute', 'Doer Rating', 'Lead Rating'],
    ...ATTRS
      .filter(a => !(a.fieldOnly && currentGig.setting === 'desk'))
      .map(a => [a.label, _r(a.key, 'rover') ?? '', _r(a.key, 'pacer') ?? '']),
    [],
    ['Final Score (Lead average)', finalScore !== null ? finalScore.toFixed(2) : ''],
    [],
    ['Notes', document.getElementById('notes').value || ''],
  ]

  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, code)
  XLSX.writeFile(wb, code + '_eval.xlsx')
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtDateShort(iso) {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${parseInt(d)} ${months[parseInt(m) - 1]}`
}

// ── URL PRELOAD ───────────────────────────────────────────────────────────

async function checkPreload() {
  const gigId = new URLSearchParams(window.location.search).get('gig_id')
  await loadGigPicker()
  if (gigId) selectGig(gigId)
}

// ── INIT ──────────────────────────────────────────────────────────────────

checkPreload()
