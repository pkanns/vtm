/**
 * gig_eval.js — Vidai to Mulai · Gig Evaluation
 * Page-specific logic only.
 * All DB calls via vtm_api.js · Connection via vtm_db.js
 * Scoring/UI logic via vtm.js (global script)
 */

import { db }                                          from './assets/vtm_db.js'
import { fetchGigsForEval, fetchRoverById,
         fetchPacerById, saveEvaluation,
         updateGigStatus }                             from './assets/vtm_api.js'
import { fmtDate, esc }                                from './assets/vtm_api.js'

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
    if (error) label.textContent = 'Could not connect to database'
    return
  }

  label.textContent = `${data.length} gig${data.length !== 1 ? 's' : ''} ready for reflection — select one to begin`
  gigPickerData = data

  grid.innerHTML = data.map(g => {
    const due    = g.date_due ? fmtDate(g.date_due) : 'No due date'
    const status = g.status === 'delivered' ? 'Delivered' : 'In Progress'
    const colour = g.status === 'delivered' ? 'var(--green)' : 'var(--red)'
    return `
      <div onclick="selectGig('${g.gig_id}')" style="
        background:rgba(255,255,255,0.04);
        border:1px solid rgba(255,255,255,0.08);
        border-top:3px solid ${colour};
        padding:16px 18px; cursor:pointer;
        transition:background 0.15s, transform 0.15s;"
        onmouseover="this.style.background='rgba(255,255,255,0.09)';this.style.transform='translateY(-2px)'"
        onmouseout="this.style.background='rgba(255,255,255,0.04)';this.style.transform='none'">
        <div style="font-family:var(--font-mono);font-size:10px;color:${colour};letter-spacing:0.1em;margin-bottom:6px;">${g.gig_code}</div>
        <div style="font-family:var(--font-display);font-size:1rem;font-weight:600;color:var(--white);line-height:1.2;margin-bottom:6px;">${esc(g.title)}</div>
        <div style="font-size:11px;color:rgba(247,246,242,0.4);margin-bottom:10px;">${esc(g.category || 'Uncategorised')}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,0.07);padding-top:10px;">
          <span style="font-size:10px;font-family:var(--font-mono);color:rgba(247,246,242,0.35);">Due ${due}</span>
          <span style="font-size:9px;font-family:var(--font-mono);letter-spacing:0.08em;text-transform:uppercase;color:${colour};">${status}</span>
        </div>
      </div>`
  }).join('')
}

// ── SELECT GIG CARD ───────────────────────────────────────────────────────

window.selectGig = async function(gigId) {
  const gig = gigPickerData.find(g => g.gig_id === gigId)
  if (!gig) return

  currentGigId = gigId

  const [roverRes, pacerRes] = await Promise.all([
    gig.rover_id ? fetchRoverById(db, gig.rover_id) : Promise.resolve({ data: null }),
    gig.pacer_id ? fetchPacerById(db, gig.pacer_id) : Promise.resolve({ data: null })
  ])

  document.getElementById('gigCode').value      = gig.gig_code || ''
  document.getElementById('gigName').value      = gig.title    || ''
  document.getElementById('gigDesc').value      = gig.description || ''
  document.getElementById('gigDate').value      = new Date().toISOString().split('T')[0]
  document.getElementById('roverDisplay').value = roverRes.data?.name || ''
  document.getElementById('pacerDisplay').value = pacerRes.data?.name || ''

  if (gig.setting) setToggle('tog-setting', gig.setting)
  if (gig.scale)   setToggle('tog-scale',   gig.scale)

  document.getElementById('gigPickerSection').style.display = 'none'
  const bar = document.getElementById('loadGigBar')
  bar.style.display = 'flex'
  document.getElementById('loadStatus').textContent = `${gig.gig_code} · ${gig.title}`

  if (typeof updateTitle === 'function') updateTitle()
  if (typeof calcScores  === 'function') calcScores()
}

// ── RESET TO PICKER ───────────────────────────────────────────────────────

window.resetPicker = function() {
  currentGigId = null
  document.getElementById('gigPickerSection').style.display = 'block'
  document.getElementById('loadGigBar').style.display = 'none'
  const btn = document.getElementById('submitBtn')
  if (btn) { btn.disabled = false; btn.textContent = 'Save Evaluation →' }
}

// ── SUBMIT ────────────────────────────────────────────────────────────────

window.submitEval = async function() {
  if (!currentGigId) {
    showToast('Please select a gig first', 'err'); return
  }

  const _r = name => parseFloat(document.querySelector(`input[name="${name}"]:checked`)?.value || 0)
  const _t = id   => parseFloat(document.getElementById(id)?.textContent) || null

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
    discussion_notes:    document.getElementById('notes')?.value || null
  }

  const btn = document.getElementById('submitBtn')
  btn.disabled = true
  btn.textContent = 'Saving...'

  const { error: evalError } = await saveEvaluation(db, payload)

  if (evalError) {
    showToast('Save failed — ' + evalError.message, 'err')
    btn.disabled = false
    btn.textContent = 'Save Evaluation →'
    return
  }

  await updateGigStatus(db, currentGigId, 'completed')

  if (typeof downloadEvalXLSX === 'function') downloadEvalXLSX()

  showToast('Evaluation saved. Gig marked completed.', 'ok')
  btn.textContent = 'Saved'
}

// ── URL PRELOAD — from create_gig "Evaluate" button ───────────────────────

async function checkPreload() {
  const params  = new URLSearchParams(window.location.search)
  const gigId   = params.get('gig_id')
  if (gigId) {
    await loadGigPicker()
    selectGig(gigId)
  } else {
    loadGigPicker()
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────

checkPreload()
