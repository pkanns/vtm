/**
 * gig_eval.js — Vidai to Mulai · Gig Evaluation
 * Role-split scoring:
 *   rover (Doer)  → saves rover columns only, does not complete gig
 *   pacer (Lead)  → saves pacer columns + final score, completes gig
 *   admin         → saves everything in one shot, completes gig
 *
 * Lead/Doer names resolved from vtm_users — no pacers/rovers tables.
 * Filtering by role uses session.user_id matched to gigs.pacer_id / rover_id.
 */

import { db }                              from './assets/vtm_db.js'
import { fetchGigsForEval, updateGigStatus,
         fmtDate, esc }                    from './assets/vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()
const role     = session?.role    || 'admin'
const myUserId = session?.user_id || null

// ── STATE ─────────────────────────────────────────────────────────────────

let gigPickerData = []
let currentGigId  = null

// ── GIG PICKER ────────────────────────────────────────────────────────────

async function loadGigPicker() {
  const { data, error } = await fetchGigsForEval(db)

  const grid  = document.getElementById('gigPickerGrid')
  const empty = document.getElementById('pickerEmpty')
  const label = document.getElementById('pickerLabel')

  if (error || !data || !data.length) {
    grid.style.display  = 'none'
    empty.style.display = 'block'
    label.textContent   = error ? 'Could not connect to database' : 'Ready for Reflection'
    return
  }

  // Filter by role using user_id
  let visible = data
  if (role === 'rover' && myUserId) {
    visible = data.filter(g => g.rover_id === myUserId)
  } else if (role === 'pacer' && myUserId) {
    visible = data.filter(g => g.pacer_id === myUserId)
  }

  if (!visible.length) {
    grid.style.display  = 'none'
    empty.style.display = 'block'
    label.textContent   = 'No gigs assigned to you are ready for evaluation'
    return
  }

  label.textContent = `${visible.length} gig${visible.length !== 1 ? 's' : ''} ready for reflection — select one to begin`
  gigPickerData = visible

  grid.innerHTML = visible.map(g => {
    const due    = g.date_due ? fmtDate(g.date_due) : 'No due date'
    const status = g.status === 'delivered' ? 'Delivered' : 'In Progress'
    const colour = g.status === 'delivered' ? 'var(--green)' : 'var(--red)'
    return `
      <div onclick="selectGig('${g.gig_id}')" style="
        background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
        border-top:3px solid ${colour};padding:16px 18px;cursor:pointer;
        transition:background 0.15s,transform 0.15s;"
        onmouseover="this.style.background='rgba(255,255,255,0.09)';this.style.transform='translateY(-2px)'"
        onmouseout="this.style.background='rgba(255,255,255,0.04)';this.style.transform='none'">
        <div style="font-family:var(--font-mono);font-size:10px;color:${colour};letter-spacing:0.1em;margin-bottom:6px;">${esc(g.gig_code)}</div>
        <div style="font-family:var(--font-display);font-size:1rem;font-weight:600;color:var(--white);line-height:1.2;margin-bottom:6px;">${esc(g.title)}</div>
        <div style="font-size:11px;color:rgba(247,246,242,0.4);margin-bottom:10px;">${esc(g.category || 'Uncategorised')}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,0.07);padding-top:10px;">
          <span style="font-size:10px;font-family:var(--font-mono);color:rgba(247,246,242,0.35);">Due ${due}</span>
          <span style="font-size:9px;font-family:var(--font-mono);letter-spacing:0.08em;text-transform:uppercase;color:${colour};">${status}</span>
        </div>
      </div>`
  }).join('')
}

// ── SELECT GIG ────────────────────────────────────────────────────────────

window.selectGig = async function(gigId) {
  const gig = gigPickerData.find(g => g.gig_id === gigId)
  if (!gig) return

  currentGigId = gigId

  // Resolve Lead and Doer names from vtm_users
  const [leadRes, doerRes] = await Promise.all([
    gig.pacer_id
      ? db.from('vtm_users').select('name').eq('user_id', gig.pacer_id).single()
      : Promise.resolve({ data: null }),
    gig.rover_id
      ? db.from('vtm_users').select('name').eq('user_id', gig.rover_id).single()
      : Promise.resolve({ data: null })
  ])

  document.getElementById('gigCode').value      = gig.gig_code    || ''
  document.getElementById('gigName').value      = gig.title       || ''
  document.getElementById('gigDesc').value      = gig.description || ''
  document.getElementById('gigDate').value      = new Date().toISOString().split('T')[0]
  document.getElementById('roverDisplay').value = doerRes.data?.name  || '—'
  document.getElementById('pacerDisplay').value = leadRes.data?.name  || '—'

  if (gig.setting) setToggle('tog-setting', gig.setting)
  if (gig.scale)   setToggle('tog-scale',   gig.scale)

  document.getElementById('gigPickerSection').style.display = 'none'
  const bar = document.getElementById('loadGigBar')
  bar.style.display = 'flex'
  document.getElementById('loadStatus').textContent = `${gig.gig_code} · ${gig.title}`

  _applyRoleButtons()

  if (typeof updateTitle === 'function') updateTitle()
  if (typeof calcScores  === 'function') calcScores()
}

// ── ROLE-BASED SUBMIT BUTTONS ─────────────────────────────────────────────

function _applyRoleButtons() {
  const submitRover = document.getElementById('submitRoverBtn')
  const submitPacer = document.getElementById('submitPacerBtn')
  const submitBoth  = document.getElementById('submitBtn')

  if (role === 'rover') {
    if (submitRover) submitRover.style.display = 'inline-block'
    if (submitPacer) submitPacer.style.display = 'none'
    if (submitBoth)  submitBoth.style.display  = 'none'
  } else if (role === 'pacer') {
    if (submitRover) submitRover.style.display = 'none'
    if (submitPacer) submitPacer.style.display = 'inline-block'
    if (submitBoth)  submitBoth.style.display  = 'none'
  } else {
    if (submitRover) submitRover.style.display = 'none'
    if (submitPacer) submitPacer.style.display = 'none'
    if (submitBoth)  submitBoth.style.display  = 'inline-block'
  }
}

// ── RESET TO PICKER ───────────────────────────────────────────────────────

window.resetPicker = function() {
  currentGigId = null
  document.getElementById('gigPickerSection').style.display = 'block'
  document.getElementById('loadGigBar').style.display = 'none'
  const btn  = document.getElementById('submitBtn')
  const rBtn = document.getElementById('submitRoverBtn')
  const pBtn = document.getElementById('submitPacerBtn')
  if (btn)  { btn.disabled  = false; btn.textContent  = 'Save Evaluation →' }
  if (rBtn) { rBtn.disabled = false; rBtn.textContent = 'Save Self-Rating →' }
  if (pBtn) { pBtn.disabled = false; pBtn.textContent = 'Save Evaluation →' }
}

// ── VALUE READERS ─────────────────────────────────────────────────────────

const _r = name => parseFloat(document.querySelector(`input[name="${name}"]:checked`)?.value || 0)
const _t = id   => parseFloat(document.getElementById(id)?.textContent) || null

// ── SUBMIT — ROVER (Doer self-rating only) ────────────────────────────────

window.submitRoverEval = async function() {
  if (!currentGigId) { showToast('Please select a gig first', 'err'); return }

  const payload = {
    gig_id:              currentGigId,
    eval_date:           document.getElementById('gigDate').value || null,
    d2_planning_rover:   _r('d2p1rover'),
    d2_execution_rover:  _r('d2p2rover'),
    d2_reflection_rover: _r('d2p3rover'),
    d3_cost_rover:       _r('d3p1rover'),
    d3_quality_rover:    _r('d3p2rover'),
    d3_timeline_rover:   _r('d3p3rover'),
    submitted_by_rover:  true,
    submitted_by:        'rover',
    discussion_notes:    document.getElementById('notes')?.value || null,
  }

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
  if (!currentGigId) { showToast('Please select a gig first', 'err'); return }

  const payload = {
    gig_id:              currentGigId,
    eval_date:           document.getElementById('gigDate').value || null,
    d2_planning_pacer:   _r('d2p1pacer'),
    d2_execution_pacer:  _r('d2p2pacer'),
    d2_reflection_pacer: _r('d2p3pacer'),
    d2_score:            _t('d2final'),
    d3_cost_pacer:       _r('d3p1pacer'),
    d3_quality_pacer:    _r('d3p2pacer'),
    d3_timeline_pacer:   _r('d3p3pacer'),
    d3_score:            _t('d3final'),
    final_score:         _t('finalStarsDisplay'),
    reward_pct:          _t('finalPct'),
    reward_rs:           _t('finalRs'),
    submitted_by_pacer:  true,
    submitted_by:        'pacer',
    discussion_notes:    document.getElementById('notes')?.value || null,
  }

  const btn = document.getElementById('submitPacerBtn')
  btn.disabled = true; btn.textContent = 'Saving…'

  const { error } = await db.from('evaluations').upsert(payload, { onConflict: 'gig_id' })

  if (error) {
    showToast('Save failed — ' + error.message, 'err')
    btn.disabled = false; btn.textContent = 'Save Evaluation →'
    return
  }

  await updateGigStatus(db, currentGigId, 'completed')
  showToast('Evaluation saved. Gig marked completed.', 'ok')
  btn.textContent = 'Saved ✓'
}

// ── SUBMIT — ADMIN (everything in one shot) ───────────────────────────────

window.submitEval = async function() {
  if (!currentGigId) { showToast('Please select a gig first', 'err'); return }

  const payload = {
    gig_id:              currentGigId,
    eval_date:           document.getElementById('gigDate').value || null,
    d2_planning_rover:   _r('d2p1rover'),
    d2_planning_pacer:   _r('d2p1pacer'),
    d2_execution_rover:  _r('d2p2rover'),
    d2_execution_pacer:  _r('d2p2pacer'),
    d2_reflection_rover: _r('d2p3rover'),
    d2_reflection_pacer: _r('d2p3pacer'),
    d2_score:            _t('d2final'),
    d3_cost_rover:       _r('d3p1rover'),
    d3_cost_pacer:       _r('d3p1pacer'),
    d3_quality_rover:    _r('d3p2rover'),
    d3_quality_pacer:    _r('d3p2pacer'),
    d3_timeline_rover:   _r('d3p3rover'),
    d3_timeline_pacer:   _r('d3p3pacer'),
    d3_score:            _t('d3final'),
    final_score:         _t('finalStarsDisplay'),
    reward_pct:          _t('finalPct'),
    reward_rs:           _t('finalRs'),
    submitted_by_rover:  true,
    submitted_by_pacer:  true,
    submitted_by:        'admin',
    discussion_notes:    document.getElementById('notes')?.value || null,
  }

  const btn = document.getElementById('submitBtn')
  btn.disabled = true; btn.textContent = 'Saving…'

  const { error } = await db.from('evaluations').upsert(payload, { onConflict: 'gig_id' })

  if (error) {
    showToast('Save failed — ' + error.message, 'err')
    btn.disabled = false; btn.textContent = 'Save Evaluation →'
    return
  }

  await updateGigStatus(db, currentGigId, 'completed')
  if (typeof downloadEvalXLSX === 'function') downloadEvalXLSX()
  showToast('Evaluation saved. Gig marked completed.', 'ok')
  btn.textContent = 'Saved ✓'
}

// ── URL PRELOAD ───────────────────────────────────────────────────────────

async function checkPreload() {
  const gigId = new URLSearchParams(window.location.search).get('gig_id')
  await loadGigPicker()
  if (gigId) selectGig(gigId)
}

// ── INIT ──────────────────────────────────────────────────────────────────

checkPreload()
