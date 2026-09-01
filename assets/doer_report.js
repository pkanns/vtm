/**
 * doer_report.js — Vidai to Mulai · Doer Report
 * Admin-only. Replaces the local Python (mulai_field_report.py) workflow —
 * pick a Doer + period, generate the same field-report shape entirely from
 * live Supabase data, in-browser. No service role key, no CSV round-trip.
 *
 * Period presets: This Week / Last Week (Sat–Fri, same convention as
 * Weekly Report and Data View — see report_data.js's saturdayOf), This
 * Month / Last Month (calendar month), All Time (no date filter).
 *
 * Three sections are click-to-expand, reusing existing app data shapes
 * rather than inventing new ones:
 *   - Time by Gig    → per-gig time_entries (same fields timesheet.js logs)
 *   - Evaluations    → full Lead/Doer attribute breakdown (same shape as
 *                       gig_eval.js's ATTRS/DB_FIELD)
 *   - Tasks          → the actual task list (gig code + title + done state)
 *
 * "Where the Work Happened" stays a static summary (centroid + 20km
 * clustering, ported from the Python script's logic) — no drill-down,
 * per scope decision.
 *
 * Tasks are counted as "existing by end of period" — assigned_to this
 * doer, created_at on/before the period end — with done/open reflecting
 * CURRENT state, not state-as-of-then (no historical status tracking
 * exists, so this matches what the old Python report did).
 */

import { db }                          from './vtm_db.js'
import { fetchActiveDoers,
         fetchAllTasksWithGigContext,
         esc, fmtDate }                from './vtm_api.js'
import { saturdayOf, addDays, toISODate,
         fmtWeekLabel, fmtHours }      from './report_data.js'

// ── SESSION — admin only. vtm_admin_guard.js (loaded in the page) already
// redirects non-admins; this is just the data-layer guard so nothing
// fetches before that redirect has a chance to fire. ─────────────────────

const session = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }
if (session.role !== 'admin') { window.location.href = 'dashboard.html'; throw new Error('Admin only') }

// ── EVAL ATTRIBUTE MAP — same fields/labels as gig_eval.js's ATTRS, kept
// minimal here since this page only needs to read + display them. ────────

const EVAL_ATTRS = [
  { key: 'planning',   label: 'Planning',   rover: 'd2_planning_rover',   pacer: 'd2_planning_pacer',   fieldOnly: false },
  { key: 'execution',  label: 'Execution',  rover: 'd2_execution_rover',  pacer: 'd2_execution_pacer',  fieldOnly: false },
  { key: 'reflection', label: 'Reflection', rover: 'd2_reflection_rover', pacer: 'd2_reflection_pacer', fieldOnly: false },
  { key: 'cost',       label: 'Cost',       rover: 'd3_cost_rover',       pacer: 'd3_cost_pacer',       fieldOnly: true  },
  { key: 'quality',    label: 'Quality',    rover: 'd3_quality_rover',    pacer: 'd3_quality_pacer',    fieldOnly: false },
  { key: 'timeline',   label: 'Timeline',   rover: 'd3_timeline_rover',   pacer: 'd3_timeline_pacer',   fieldOnly: false },
]

// ── PERIOD MATH ────────────────────────────────────────────────────────

function periodRange(id) {
  const today = new Date()

  if (id === 'week') {
    const start = saturdayOf(today)
    return { start, end: addDays(start, 6) }
  }
  if (id === 'week-1') {
    const start = addDays(saturdayOf(today), -7)
    return { start, end: addDays(start, 6) }
  }
  if (id === 'month') {
    return {
      start: new Date(today.getFullYear(), today.getMonth(), 1),
      end:   new Date(today.getFullYear(), today.getMonth() + 1, 0),
    }
  }
  if (id === 'month-1') {
    return {
      start: new Date(today.getFullYear(), today.getMonth() - 1, 1),
      end:   new Date(today.getFullYear(), today.getMonth(), 0),
    }
  }
  return { start: null, end: null } // 'all'
}

function periodLabel(id, start, end) {
  if (id === 'all') return 'All Time'
  if (id === 'week' || id === 'week-1') return fmtWeekLabel(start)
  const opts = { day: 'numeric', month: 'short', year: 'numeric' }
  const s = start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const e = end.toLocaleDateString(undefined, opts)
  return `${s} \u2013 ${e}`
}

// ── HAVERSINE (km) — for the location-clustering summary ─────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── FETCHERS ──────────────────────────────────────────────────────────────

async function fetchDoerProfile(doerId) {
  return db.from('vtm_users').select('user_id, name, created_at').eq('user_id', doerId).single()
}

async function fetchEntries(doerId, start, end) {
  let q = db.from('time_entries')
    .select('entry_id, gig_id, entry_date, start_time, end_time, entry_type, duration_mins, notes, clock_in_lat, clock_in_lng, gigs(gig_code, title, status)')
    .eq('user_id', doerId)
    .eq('is_active', false)
    .order('entry_date', { ascending: true })

  if (start) q = q.gte('entry_date', toISODate(start))
  if (end)   q = q.lte('entry_date', toISODate(end))

  const { data, error } = await q
  return error ? [] : (data || [])
}

// Tasks assigned to this doer that existed by the period end — same
// "existed by end of period" framing the old Python report used. No lower
// bound: a task created before the window but still open/closed during it
// is still relevant. Master-gig tasks (the template checklist copied onto
// every spawned instance) are excluded, same convention as task_index.js.
async function fetchTasksForDoer(doerId, end) {
  const { data, error } = await fetchAllTasksWithGigContext(db)
  if (error || !data) return []

  const cutoff = end ? addDays(end, 1) : null // exclusive upper bound

  return data
    .filter(t => t.gigs)
    .filter(t => !(t.gigs.cadence === 'recurring' && !t.gigs.parent_gig_id))
    .filter(t => t.assigned_to === doerId)
    .filter(t => !cutoff || new Date(t.created_at) < cutoff)
}

async function fetchEvalsForDoer(doerId, start, end) {
  let q = db.from('evaluations')
    .select('*, gigs!inner(gig_code, title, setting, rover_id, pacer_id)')
    .eq('gigs.rover_id', doerId)
    .order('created_at', { ascending: true })

  if (start) q = q.gte('created_at', toISODate(start))
  if (end)   q = q.lt('created_at', toISODate(addDays(end, 1)))

  const { data, error } = await q
  return error ? [] : (data || [])
}

// ── STATS ─────────────────────────────────────────────────────────────────

function computeStats(entries, tasks, evalRows) {
  const totalMinutes = entries.reduce((s, e) => s + (e.duration_mins || 0), 0)

  const byGig = {}
  entries.forEach(e => {
    if (!e.gig_id) return
    if (!byGig[e.gig_id]) {
      byGig[e.gig_id] = {
        gig_id: e.gig_id,
        gig_code: e.gigs?.gig_code || '\u2014',
        title:    e.gigs?.title    || '',
        status:   e.gigs?.status   || 'placed',
        minutes: 0,
        entries: [],
      }
    }
    byGig[e.gig_id].minutes += (e.duration_mins || 0)
    byGig[e.gig_id].entries.push(e)
  })
  const hoursByGig = Object.values(byGig).sort((a, b) => b.minutes - a.minutes)

  const tasksDone  = tasks.filter(t => t.done).length
  const tasksTotal = tasks.length

  const scored  = evalRows.filter(e => e.final_score !== null && e.final_score !== undefined)
  const evalAvg = scored.length ? scored.reduce((s, e) => s + e.final_score, 0) / scored.length : null

  const geo = entries.filter(e =>
    e.clock_in_lat !== null && e.clock_in_lat !== undefined &&
    e.clock_in_lng !== null && e.clock_in_lng !== undefined)

  let geoStats = null
  if (geo.length) {
    const cLat = geo.reduce((s, e) => s + e.clock_in_lat, 0) / geo.length
    const cLng = geo.reduce((s, e) => s + e.clock_in_lng, 0) / geo.length
    const dists = geo.map(e => haversineKm(e.clock_in_lat, e.clock_in_lng, cLat, cLng))
    const within20 = dists.filter(d => d <= 20).length
    geoStats = { total: geo.length, within20, far: geo.length - within20, maxDist: Math.max(...dists) }
  }

  return {
    totalMinutes, hoursByGig,
    gigsWorked: hoursByGig.length,
    tasksDone, tasksTotal,
    evalAvg, evalCount: scored.length,
    geoStats,
  }
}

// ── RENDER ────────────────────────────────────────────────────────────────

function renderReport(doer, id, start, end, stats, evalRows, tasks) {
  const activeSince = doer.created_at ? fmtDate(doer.created_at.slice(0, 10)) : '\u2014'

  document.getElementById('reportWrap').innerHTML = `
    <div class="rp-card">
      <div class="rp-header">
        <div>
          <div class="rp-eyebrow">Doer Performance &middot; Field Report</div>
          <div class="rp-name">${esc(doer.name)}</div>
          <div class="rp-sub">Doer &middot; Active since ${esc(activeSince)}</div>
        </div>
        <div class="rp-period">${esc(periodLabel(id, start, end))}</div>
      </div>

      <div class="rp-stats">
        <div class="rp-stat"><div class="rp-stat-val">${fmtHours(stats.totalMinutes)}</div><div class="rp-stat-lbl">Time Logged</div></div>
        <div class="rp-stat"><div class="rp-stat-val">${stats.tasksDone}<span class="unit">/ ${stats.tasksTotal}</span></div><div class="rp-stat-lbl">Tasks Closed</div></div>
        <div class="rp-stat"><div class="rp-stat-val">${stats.evalAvg !== null ? stats.evalAvg.toFixed(2) : '\u2014'}<span class="unit">/ 5 &#9733;</span></div><div class="rp-stat-lbl">Avg. Final Score</div></div>
        <div class="rp-stat"><div class="rp-stat-val">${stats.gigsWorked}<span class="unit">gigs</span></div><div class="rp-stat-lbl">Gigs Worked</div></div>
      </div>

      <div class="rp-body">
        <div class="rp-panel">
          <div class="rp-panel-title">Time by Gig</div>
          <div class="rp-panel-sub">Click a gig to see individual timesheet entries</div>
          <div id="rpChart">${renderTimeByGig(stats.hoursByGig)}</div>
        </div>

        <div class="rp-right">
          <div class="rp-block">
            <div class="rp-block-title">Evaluation Scores</div>
            ${renderEvalList(evalRows)}
          </div>
          <div class="rp-block">
            <div class="rp-block-title">Tasks</div>
            ${renderTaskSummary(stats.tasksDone, stats.tasksTotal, tasks)}
          </div>
          <div class="rp-block">
            <div class="rp-block-title">Where the Work Happened</div>
            ${renderGeo(stats.geoStats)}
          </div>
        </div>
      </div>
    </div>`

  document.getElementById('reportWrap').style.display = 'block'
}

function renderTimeByGig(hoursByGig) {
  if (!hoursByGig.length) return '<div class="rp-empty">No time logged in this period.</div>'

  const max = Math.max(...hoursByGig.map(g => g.minutes), 1)

  return hoursByGig.map((g, i) => {
    const pct = Math.round((g.minutes / max) * 100)
    const doneClass = g.status === 'completed' ? ' done' : ''
    return `
      <div class="rp-bar-row" onclick="toggleGigDetail(${i})">
        <div class="rp-bar-label">${esc(g.gig_code)}</div>
        <div class="rp-bar-track"><div class="rp-bar-fill${doneClass}" style="width:${pct}%"></div></div>
        <div class="rp-bar-val">${fmtHours(g.minutes)}</div>
      </div>
      <div class="rp-gig-detail" id="gigDetail-${i}">${renderGigEntries(g.entries)}</div>`
  }).join('')
}

function renderGigEntries(entries) {
  if (!entries.length) return '<div class="rp-empty">No entries.</div>'
  return `<div class="rp-entry-list">${entries.map(e => `
    <div class="rp-entry-row">
      <span class="rp-entry-date">${fmtDate(e.entry_date)}</span>
      <span class="rp-entry-type">${e.entry_type === 'live' ? 'Live' : 'Manual'}</span>
      <span class="rp-entry-time">${(e.start_time || '\u2014').slice(0, 5)}\u2013${(e.end_time || '\u2014').slice(0, 5)}</span>
      <span class="rp-entry-dur">${e.duration_mins ? fmtHours(e.duration_mins) : '\u2014'}</span>
      <span class="rp-entry-notes">${esc(e.notes || '')}</span>
    </div>`).join('')}</div>`
}

window.toggleGigDetail = function(i) {
  document.getElementById('gigDetail-' + i)?.classList.toggle('open')
}

function renderEvalList(evalRows) {
  if (!evalRows.length) return '<div class="rp-empty">No evaluations in this period.</div>'

  return evalRows.map((e, i) => {
    const g = e.gigs || {}
    const score = e.final_score !== null && e.final_score !== undefined ? e.final_score.toFixed(2) : '\u2014'
    return `
      <div class="rp-eval-row" onclick="toggleEvalDetail(${i})">
        <div class="rp-eval-gig"><strong>${esc(g.gig_code || '\u2014')}</strong><br>${esc(g.title || '')} &middot; ${fmtDate(e.eval_date)}</div>
        <div class="rp-eval-score">${score} &#9733;</div>
      </div>
      <div class="rp-eval-detail" id="evalDetail-${i}">
        ${renderEvalAttrs(e)}
        ${e.discussion_notes ? `<div class="rp-eval-notes">${esc(e.discussion_notes)}</div>` : ''}
      </div>`
  }).join('')
}

function renderEvalAttrs(e) {
  const isDesk = e.gigs?.setting === 'desk'
  return `<div class="rp-attr-table">
    ${EVAL_ATTRS.filter(a => !(a.fieldOnly && isDesk)).map(a => `
      <div class="rp-attr-row">
        <span class="rp-attr-label">${a.label}</span>
        <span class="rp-attr-val">Doer ${e[a.rover] ?? '\u2014'}</span>
        <span class="rp-attr-val">Lead ${e[a.pacer] ?? '\u2014'}</span>
      </div>`).join('')}
  </div>`
}

window.toggleEvalDetail = function(i) {
  document.getElementById('evalDetail-' + i)?.classList.toggle('open')
}

function renderTaskSummary(done, total, tasks) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return `
    <div class="rp-task-summary" onclick="toggleTaskDetail()">
      <div class="rp-task-num">${done}<span>/${total}</span></div>
      <div class="rp-task-bar"><div class="rp-task-bar-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="rp-task-detail" id="taskDetail">
      ${tasks.length ? tasks.map(t => `
        <div class="rp-task-row">
          <span class="${t.done ? 'rp-task-done' : ''}">${esc(t.gigs?.gig_code || '\u2014')} &middot; ${esc(t.title)}</span>
          <span class="rp-task-status">${t.done ? 'Done' : 'Open'}</span>
        </div>`).join('') : '<div class="rp-empty">No tasks.</div>'}
    </div>`
}

window.toggleTaskDetail = function() {
  document.getElementById('taskDetail')?.classList.toggle('open')
}

function renderGeo(geoStats) {
  if (!geoStats) return '<div class="rp-empty">No GPS-tagged clock-ins in this period.</div>'

  const dots = Array.from({ length: Math.min(geoStats.total, 24) }).map((_, i) =>
    `<div class="rp-loc-dot${i >= geoStats.within20 ? ' far' : ''}"></div>`).join('')

  const farLine = geoStats.far
    ? `, with <strong>${geoStats.far}</strong> recorded farther out \u2014 up to roughly <strong>${Math.round(geoStats.maxDist)} km</strong> away.`
    : '.'

  return `
    <div class="rp-loc-line">Clock-ins mostly cluster near a common base (<strong>${geoStats.within20} of ${geoStats.total}</strong> within 20km of the group's center)${farLine}</div>
    <div class="rp-loc-dots">${dots}</div>
    <div class="rp-loc-note">Centroid-based clustering, 20km threshold.</div>`
}

// ── UI WIRING ─────────────────────────────────────────────────────────────

async function loadDoers() {
  const sel = document.getElementById('doerSelect')
  const { data, error } = await fetchActiveDoers(db)
  if (error || !data?.length) {
    sel.innerHTML = '<option value="">\u2014 No doers found \u2014</option>'
    return
  }
  sel.innerHTML = '<option value="">\u2014 Select Doer \u2014</option>' +
    data.map(u => `<option value="${u.user_id}">${esc(u.name)}</option>`).join('')
}

document.querySelectorAll('.period-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-pill').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
  })
})

window.generateReport = async function() {
  const doerId = document.getElementById('doerSelect').value
  if (!doerId) { showToast('Select a Doer first', 'err'); return }

  const periodId = document.querySelector('.period-pill.active')?.dataset.period || 'week'
  const { start, end } = periodRange(periodId)

  const btn = document.getElementById('generateBtn')
  btn.disabled = true
  btn.textContent = 'Generating\u2026'

  try {
    const [doerRes, entries, tasks, evalRows] = await Promise.all([
      fetchDoerProfile(doerId),
      fetchEntries(doerId, start, end),
      fetchTasksForDoer(doerId, end),
      fetchEvalsForDoer(doerId, start, end),
    ])

    if (doerRes.error || !doerRes.data) {
      showToast('Could not load doer profile', 'err')
      return
    }

    const stats = computeStats(entries, tasks, evalRows)
    renderReport(doerRes.data, periodId, start, end, stats, evalRows, tasks)

  } catch (err) {
    showToast('Report generation failed \u2014 ' + err.message, 'err')
  } finally {
    btn.disabled = false
    btn.textContent = 'Generate Report \u2192'
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadDoers()
