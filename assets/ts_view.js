/**
 * ts_view.js · Vidai to Mulai · Timesheet View
 * Admin only. Replaces plan_view.html and week_planner.html.
 *
 * Shows every time entry reported by every user, live from time_entries.
 * Read-only: no editing here (people correct their own entries on the
 * Timesheet page).
 *
 * Periods: Week (Sat to Fri, same convention as report_data.js),
 * Month (calendar), Custom (capped at 62 days so the matrix stays legible).
 *
 * Views:
 *   Calendar week = time-of-day grid with a block per entry (gig, person);
 *            month/long range = day cells with a chip per entry.
 *   Hours   person x day, decimal hours, row and column totals.
 *           Clicking a person jumps to the Log filtered to them.
 *   Log     every entry grouped by day, newest first.
 *
 * Filters (person, project) apply to both views, the summary strip
 * and the CSV export, so what you see is what you export.
 */

import { db } from './vtm_db.js'
import { saturdayOf, addDays, toISODate, fmtHours } from './report_data.js'
import { fmtDate, esc } from './vtm_api.js'

// ── SESSION (admin only; vtm_admin_guard.js handles the redirect,
// this stops anything fetching before it fires) ───────────────────────────

const session = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }
if (session.role !== 'admin') { window.location.href = 'dashboard.html'; throw new Error('Admin only') }

// ── STATE ─────────────────────────────────────────────────────────────────

const MAX_CUSTOM_DAYS = 62
const PAGE_SIZE = 1000

let period   = 'week'     // 'week' | 'month' | 'custom'
let offset   = 0          // periods back from now (0 = current, negative = past)
let view     = 'calendar' // 'calendar' | 'matrix' | 'log'
let expanded = new Set()  // month cells expanded to show every gig
let userId   = ''
let projectId = ''
let users    = []         // [{ user_id, name, role, active }]
let entries  = []         // raw rows for the current range
let range    = { start: null, end: null }

const $ = id => document.getElementById(id)
const statusEl = $('dbStatus')

// ── PUNCH STRIP (decorative, same as other pages) ─────────────────────────

;(function buildPunchStrip() {
  const strip = $('topPunchStrip')
  if (!strip) return
  const pattern = [1,0,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,0,1,1,0,2,0,1,0,0,1,0,1]
  for (let s = 0; s < 2; s++) {
    const div = document.createElement('div')
    div.className = 'punch-holes' + (s === 1 ? ' punch-holes-2' : '')
    for (let r = 0; r < 6; r++) {
      pattern.forEach(p => {
        const h = document.createElement('div')
        h.className = 'hole' + (p === 1 ? ' punched' : p === 2 ? ' punched red' : '')
        div.appendChild(h)
      })
    }
    strip.appendChild(div)
  }
})()

// ── RANGE MATH ────────────────────────────────────────────────────────────

function computeRange() {
  const today = new Date()

  if (period === 'week') {
    const start = addDays(saturdayOf(today), offset * 7)
    return { start, end: addDays(start, 6) }
  }

  if (period === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth() + offset, 1)
    const end   = new Date(today.getFullYear(), today.getMonth() + offset + 1, 0)
    return { start, end }
  }

  // custom: read from the inputs, fall back to the current week
  const f = $('fromInput').value, t = $('toInput').value
  if (f && t) {
    let start = new Date(f + 'T00:00:00')
    let end   = new Date(t + 'T00:00:00')
    if (end < start) [start, end] = [end, start]
    const maxEnd = addDays(start, MAX_CUSTOM_DAYS - 1)
    if (end > maxEnd) end = maxEnd
    return { start, end }
  }
  const start = saturdayOf(today)
  return { start, end: addDays(start, 6) }
}

function rangeLabel() {
  const { start, end } = range
  if (period === 'month') {
    return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }
  const o = { day: 'numeric', month: 'short' }
  const sameYear = start.getFullYear() === end.getFullYear()
  const s = start.toLocaleDateString(undefined, sameYear ? o : { ...o, year: 'numeric' })
  const e = end.toLocaleDateString(undefined, { ...o, year: 'numeric' })
  return `${s} \u2013 ${e}`
}

function daysInRange() {
  const days = []
  for (let d = new Date(range.start); d <= range.end; d = addDays(d, 1)) days.push(new Date(d))
  return days
}

// ── LOAD ──────────────────────────────────────────────────────────────────

async function loadUsers() {
  const { data, error } = await db.from('vtm_users').select('user_id, name, role, active').order('name')
  if (error) { statusEl.textContent = 'Could not load users: ' + error.message; statusEl.className = 'db-status err'; return }
  users = data || []

  $('userSelect').innerHTML = '<option value="">All people</option>' +
    users.filter(u => u.active !== false)
         .map(u => `<option value="${u.user_id}">${esc(u.name)}</option>`).join('')
}

async function loadProjects() {
  const { data } = await db.from('projects').select('project_id, project_code, project_name').order('project_code')
  $('projectSelect').innerHTML = '<option value="">All projects</option>' +
    (data || []).map(p => `<option value="${p.project_id}">${esc(p.project_code)}</option>`).join('')
}

async function loadEntries() {
  range = computeRange()
  $('rangeLabel').textContent = rangeLabel()
  statusEl.textContent = 'Loading\u2026'
  statusEl.className = 'db-status'

  const from = toISODate(range.start), to = toISODate(range.end)
  const rows = []

  // The API returns at most 1000 rows per request, so page through.
  for (let offsetRows = 0; ; offsetRows += PAGE_SIZE) {
    const { data, error } = await db
      .from('time_entries')
      .select('entry_id, user_id, gig_id, entry_date, start_time, end_time, entry_type, is_active, duration_mins, notes, location_label, gigs ( gig_code, title, status, project_id, projects ( project_code ) )')
      .gte('entry_date', from)
      .lte('entry_date', to)
      .order('entry_date', { ascending: false })
      .order('start_time', { ascending: false })
      .range(offsetRows, offsetRows + PAGE_SIZE - 1)

    if (error) {
      statusEl.textContent = 'Could not load entries: ' + error.message
      statusEl.className = 'db-status err'
      entries = []
      render()
      return
    }
    rows.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
  }

  entries = rows
  render()
}

// ── DERIVED ───────────────────────────────────────────────────────────────

const todayISO = () => toISODate(new Date())

function entryMins(e) {
  if (e.duration_mins != null) return e.duration_mins
  // Still clocked in today: show elapsed time so far
  if (e.is_active && !e.end_time && e.entry_date === todayISO() && e.start_time) {
    const [h, m] = e.start_time.split(':').map(Number)
    const now = new Date()
    return Math.max(0, now.getHours() * 60 + now.getMinutes() - (h * 60 + m))
  }
  return 0
}

const isRunning = e => e.is_active && !e.end_time
const isOpen    = e => !e.is_active && !e.end_time

function filtered() {
  return entries.filter(e =>
    (!userId || e.user_id === userId) &&
    (!projectId || e.gigs?.project_id === projectId)
  )
}

const userById = id => users.find(u => u.user_id === id)
const nameOf   = id => userById(id)?.name || 'Unknown user'
const hoursDec = mins => (mins / 60).toFixed(1).replace(/\.0$/, '')
const ROLE_LABEL = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' }

// ── RENDER ────────────────────────────────────────────────────────────────

function render() {
  const rows = filtered()

  statusEl.textContent = `\u25CF ${rows.length} entr${rows.length !== 1 ? 'ies' : 'y'} \u00B7 ${fmtHours(rows.reduce((s, e) => s + entryMins(e), 0))}`
  statusEl.className = 'db-status ok'

  renderSummary(rows)
  $('body').innerHTML = view === 'calendar' ? calendarHTML(rows)
                    : view === 'matrix'   ? matrixHTML(rows)
                    : logHTML(rows)
}

function renderSummary(rows) {
  const total   = rows.reduce((s, e) => s + entryMins(e), 0)
  const people  = new Set(rows.map(e => e.user_id)).size
  const gigs    = new Set(rows.map(e => e.gig_id)).size
  const open    = rows.filter(isOpen).length
  const running = rows.filter(isRunning).length
  const days    = daysInRange().filter(d => d.getDay() !== 0 && d.getDay() !== 6).length || 1
  const avg     = people ? total / people : 0

  $('summary').innerHTML = `
    <div class="punch-card answer-card">
      <div class="register-grid">
        <div class="register-cell punched"><div class="register-cell-label">Total time</div>
          <div class="register-cell-val red">${fmtHours(total)}<span class="sub">${rows.length} entries</span></div></div>
        <div class="register-cell"><div class="register-cell-label">People reporting</div>
          <div class="register-cell-val">${people}<span class="sub">avg ${fmtHours(Math.round(avg))} each</span></div></div>
        <div class="register-cell"><div class="register-cell-label">Gigs touched</div>
          <div class="register-cell-val">${gigs}<span class="sub">${days} working days in range</span></div></div>
        <div class="register-cell"><div class="register-cell-label">Open entries</div>
          <div class="register-cell-val ${open ? 'red' : ''}">${open}<span class="sub">no end time yet</span></div></div>
        <div class="register-cell"><div class="register-cell-label">Running now</div>
          <div class="register-cell-val ${running ? 'green' : ''}">${running}<span class="sub">clocked in</span></div></div>
      </div>
    </div>`
}


// ── CALENDAR VIEW ─────────────────────────────────────────────────────────

const USER_COLORS = ['#7b3fa0', '#2a5a8a', '#3a7a6b', '#8a6e3f', '#5a4a8a', '#a04a5c', '#4a7a8a', '#8a5a3f', '#4a6a2a', '#9a3a2a']
const STATUS_COLORS = { placed: '#2a5a8a', matched: '#7b3fa0', aligned: '#8a6200', in_progress: '#b5201a', delivered: '#1e4d2b', completed: '#6b5f4e' }
const HOUR_PX = 52
const colorOf = id => USER_COLORS[Math.max(0, users.findIndex(u => u.user_id === id)) % USER_COLORS.length]
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
const fmtStatus = s => (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())

function calendarHTML(rows) {
  if (!rows.length) return '<div class="empty-state">No timesheet entries in this period.</div>'
  const legend = legendHTML(rows)
  const grid = (period === 'week' || (period === 'custom' && daysInRange().length <= 7))
    ? weekGridHTML(rows) : monthGridHTML(rows)
  return legend + grid
}

function legendHTML(rows) {
  const ids = [...new Set(rows.map(e => e.user_id))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  const chips = ids.map(id => `<span class="lg-chip${userId === id ? ' on' : ''}" onclick="tsPick('${id}')"><i class="lg-sw" style="background:${colorOf(id)}"></i>${esc(nameOf(id))}</span>`).join('')
  const stat = Object.entries(STATUS_COLORS).map(([k, c]) => `<span style="--c:${c}">${fmtStatus(k)}</span>`).join('')
  return `<div class="legend">${chips}</div><div class="lg-status">${stat}</div>`
}

window.tsPick = function (id) {
  userId = userId === id ? '' : id
  $('userSelect').value = userId
  render()
}

function blockTitle(e) {
  const g = e.gigs || {}
  const t = (e.start_time || '').slice(0, 5), en = (e.end_time || '').slice(0, 5) || (isRunning(e) ? 'now' : '?')
  return `${nameOf(e.user_id)} \u00B7 ${g.gig_code || ''} \u00B7 ${g.title || ''} \u00B7 ${t}\u2013${en} \u00B7 ${entryMins(e) ? fmtHours(entryMins(e)) : 'no duration'}${e.notes ? ' \u00B7 ' + e.notes : ''}`
}

// Week: time-of-day grid, one block per entry, overlaps split into lanes.
function weekGridHTML(rows) {
  const days = daysInRange()
  const timed = rows.filter(e => e.start_time)
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes(), today = todayISO()

  const spans = timed.map(e => {
    const s = toMin(e.start_time)
    let en = e.end_time ? toMin(e.end_time) : (isRunning(e) && e.entry_date === today ? nowMin : s + 30)
    if (en <= s) en = e.end_time ? 24 * 60 : s + 30   // crossed midnight: clip to end of day
    return { e, s, en }
  })

  let h0 = 8, h1 = 18
  spans.forEach(x => { h0 = Math.min(h0, Math.floor(x.s / 60)); h1 = Math.max(h1, Math.ceil(x.en / 60)) })
  h1 = Math.min(24, h1)
  const base = h0 * 60

  const hoursCol = Array.from({ length: h1 - h0 }, (_, i) => `<div>${String(h0 + i).padStart(2, '0')}:00</div>`).join('')

  const cols = days.map(d => {
    const iso = toISODate(d)
    const list = spans.filter(x => x.e.entry_date === iso).sort((a, b) => a.s - b.s || a.en - b.en)

    // lane assignment per overlap cluster
    let cluster = [], clusterEnd = -1
    const placed = []
    const flush = () => { const n = Math.max(1, ...cluster.map(c => c.lane + 1)); cluster.forEach(c => c.lanes = n); placed.push(...cluster); cluster = [] }
    list.forEach(x => {
      if (cluster.length && x.s >= clusterEnd) { flush(); clusterEnd = -1 }
      const used = new Set(cluster.filter(c => c.en > x.s).map(c => c.lane))
      let lane = 0; while (used.has(lane)) lane++
      x.lane = lane; cluster.push(x); clusterEnd = Math.max(clusterEnd, x.en)
    })
    if (cluster.length) flush()

    const blocks = placed.map(x => {
      const g = x.e.gigs || {}
      const top = (x.s - base) / 60 * HOUR_PX
      const height = Math.max(20, (x.en - x.s) / 60 * HOUR_PX - 1)
      const w = 100 / x.lanes
      return `<div class="cal-block s-${g.status || 'placed'}${isRunning(x.e) ? ' running' : ''}${isOpen(x.e) ? ' open' : ''}"
        style="top:${top}px;height:${height}px;left:calc(${x.lane * w}% + 1px);width:calc(${w}% - 3px);border-left-color:${colorOf(x.e.user_id)}"
        title="${esc(blockTitle(x.e))}">
        <span class="c">${esc(g.gig_code || '\u2014')}</span>
        <span class="w">${esc(nameOf(x.e.user_id))}</span>
        ${height > 44 ? `<span class="t">${esc(g.title || '')}</span>` : ''}
      </div>`
    }).join('')

    const nowLine = iso === today && nowMin >= base && nowMin <= h1 * 60
      ? `<div class="cal-now" style="top:${(nowMin - base) / 60 * HOUR_PX}px"></div>` : ''
    const wk = d.getDay() === 0 || d.getDay() === 6
    return `<div class="cal-col${wk ? ' weekend' : ''}${iso === today ? ' today' : ''}" style="height:${(h1 - h0) * HOUR_PX}px">${nowLine}${blocks}</div>`
  }).join('')

  const heads = days.map(d => {
    const iso = toISODate(d)
    const m = rows.filter(e => e.entry_date === iso).reduce((s, e) => s + entryMins(e), 0)
    const wk = d.getDay() === 0 || d.getDay() === 6
    return `<div class="cal-head${iso === today ? ' today' : wk ? ' weekend' : ''}">
      <div class="dn">${d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
      <div class="dd">${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</div>
      <div class="dt">${m ? fmtHours(m) : '\u00B7'}</div></div>`
  }).join('')

  const noTime = rows.length - timed.length
  return `<div class="cal-wrap"><div class="cal-grid" style="grid-template-columns:52px repeat(${days.length},minmax(0,1fr))">
      <div class="cal-head corner"></div>${heads}
      <div class="cal-hours">${hoursCol}</div>${cols}
    </div></div>
    <div class="cal-note">Hover a block for full details. Dashed edge = open entry (no end time, shown as 30 min). Green ring = running now.${noTime ? ` ${noTime} entr${noTime > 1 ? 'ies have' : 'y has'} no start time and appear only in the Log.` : ''}</div>`
}

// Month / long custom range: one cell per day with a chip per gig worked.
function monthGridHTML(rows) {
  const first = new Date(range.start)
  const lead = (first.getDay() + 6) % 7                 // Monday-first
  const gridStart = addDays(first, -lead)
  const last = new Date(range.end)
  const trail = 6 - ((last.getDay() + 6) % 7)
  const gridEnd = addDays(last, trail)
  const today = todayISO()

  const byDay = {}
  rows.forEach(e => { (byDay[e.entry_date] ||= []).push(e) })

  const heads = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="mh">${d}</div>`).join('')
  let cells = ''
  for (let d = new Date(gridStart); d <= gridEnd; d = addDays(d, 1)) {
    const iso = toISODate(d)
    const inRange = d >= range.start && d <= range.end
    const wk = d.getDay() === 0 || d.getDay() === 6
    const list = (byDay[iso] || []).slice().sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
    const total = list.reduce((s, e) => s + entryMins(e), 0)
    const open = expanded.has(iso)
    const shown = open ? list : list.slice(0, 4)
    const chips = shown.map(e => {
      const g = e.gigs || {}
      return `<div class="chip" style="border-left-color:${colorOf(e.user_id)}" title="${esc(blockTitle(e))}"><span class="cc">${esc(g.gig_code || '\u2014')}</span>${esc(nameOf(e.user_id).split(' ')[0])}</div>`
    }).join('')
    const more = list.length > 4 ? `<div class="more" onclick="tsExpand('${iso}')">${open ? 'show less' : '+' + (list.length - 4) + ' more'}</div>` : ''
    cells += `<div class="mc${inRange ? '' : ' out'}${wk ? ' weekend' : ''}${iso === today ? ' today' : ''}">
      <div class="mn"><b>${d.getDate()}</b>${total ? `<span>${hoursDec(total)}h</span>` : ''}</div>${inRange ? chips + more : ''}</div>`
  }
  return `<div class="month-grid">${heads}${cells}</div>
    <div class="cal-note">Each chip is one entry: gig code and first name, edge colour = person. Hover for details.</div>`
}

window.tsExpand = function (iso) { expanded.has(iso) ? expanded.delete(iso) : expanded.add(iso); render() }

// ── MATRIX VIEW ───────────────────────────────────────────────────────────

function matrixHTML(rows) {
  const days = daysInRange()
  if (!rows.length) return '<div class="empty-state">No timesheet entries in this period.</div>'

  // minutes[userId][dateISO]
  const minutes = {}
  rows.forEach(e => {
    minutes[e.user_id] ??= {}
    minutes[e.user_id][e.entry_date] = (minutes[e.user_id][e.entry_date] || 0) + entryMins(e)
  })

  // People who reported, busiest first
  const ids = Object.keys(minutes).sort((a, b) => totalOf(minutes[b]) - totalOf(minutes[a]))
  const today = todayISO()

  const head = days.map(d => {
    const iso = toISODate(d)
    const cls = iso === today ? 'today' : (d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : '')
    return `<th class="${cls}">${d.toLocaleDateString(undefined, { weekday: 'short' })}<span class="d">${d.getDate()}/${d.getMonth() + 1}</span></th>`
  }).join('')

  const body = ids.map(id => {
    const u = userById(id)
    const cells = days.map(d => {
      const iso = toISODate(d)
      const m = minutes[id][iso] || 0
      const wk = d.getDay() === 0 || d.getDay() === 6
      return `<td class="${wk ? 'weekend ' : ''}${m ? '' : 'zero'}" ${m ? `title="${fmtHours(m)}"` : ''}>${m ? hoursDec(m) : '\u00B7'}</td>`
    }).join('')
    return `<tr class="person">
      <td class="name-col" onclick="tsDrill('${id}')">${esc(nameOf(id))}<small>${esc(ROLE_LABEL[u?.role] || '')}</small></td>
      ${cells}<td class="total">${hoursDec(totalOf(minutes[id]))}</td></tr>`
  }).join('')

  const footCells = days.map(d => {
    const iso = toISODate(d)
    const m = ids.reduce((s, id) => s + (minutes[id][iso] || 0), 0)
    return `<td>${m ? hoursDec(m) : '\u00B7'}</td>`
  }).join('')
  const grand = ids.reduce((s, id) => s + totalOf(minutes[id]), 0)

  return `
    <div class="tt-scroll">
      <table class="tt">
        <thead><tr><th class="name-col">Person</th>${head}<th>Total h</th></tr></thead>
        <tbody>${body}
          <tr class="foot"><td class="name-col">All people</td>${footCells}<td>${hoursDec(grand)}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="hint">Decimal hours (6.5 = 6h 30m). Hover a cell for h and m. Click a name to see that person's entries.</div>`
}

const totalOf = byDay => Object.values(byDay).reduce((s, m) => s + m, 0)

window.tsDrill = function (id) {
  userId = id
  $('userSelect').value = id
  view = 'log'
  $('view-log').checked = true
  render()
}

// ── LOG VIEW ──────────────────────────────────────────────────────────────

function logHTML(rows) {
  if (!rows.length) return '<div class="empty-state">No timesheet entries in this period.</div>'

  const byDay = {}
  rows.forEach(e => { (byDay[e.entry_date] ||= []).push(e) })

  return Object.keys(byDay).sort().reverse().map(iso => {
    const list = byDay[iso]
    const dayMins = list.reduce((s, e) => s + entryMins(e), 0)
    const d = new Date(iso + 'T00:00:00')
    const dn = d.toLocaleDateString(undefined, { weekday: 'long' })

    const rowsHTML = list.map(e => {
      const g = e.gigs || {}
      const t = e.start_time ? e.start_time.slice(0, 5) : '\u2014'
      const end = e.end_time ? e.end_time.slice(0, 5) : (isRunning(e) ? 'now' : '\u2014')
      const status = isRunning(e) ? '<span class="badge running">Running</span>'
                   : isOpen(e)    ? '<span class="badge open">Open</span>'
                   : `<span class="badge ${e.entry_type === 'live' ? 'live' : 'manual'}">${e.entry_type === 'live' ? 'Live' : 'Manual'}</span>`
      const m = entryMins(e)

      return `
        <div class="log-row">
          <div class="lr-person">${esc(nameOf(e.user_id))}</div>
          <div class="lr-time">${t} \u2013 ${end}<br>${status}</div>
          <div class="lr-gig">
            <span class="code">${esc(g.gig_code || '\u2014')}</span>${esc(g.title || '')}
            ${g.projects?.project_code ? `<span class="lr-loc">${esc(g.projects.project_code)}</span>` : ''}
            ${e.notes ? `<span class="lr-notes">${esc(e.notes)}</span>` : ''}
            ${e.location_label && e.location_label !== 'Denied' ? `<span class="lr-loc">${esc(e.location_label)}</span>` : ''}
          </div>
          <div></div>
          <div class="lr-dur">${m ? fmtHours(m) : '\u2014'}</div>
        </div>`
    }).join('')

    return `
      <div class="day-block">
        <div class="day-head"><span class="dn">${dn}</span><span class="dt">${fmtDate(iso)} \u00B7 ${fmtHours(dayMins)}</span></div>
        ${rowsHTML}
      </div>`
  }).join('')
}

// ── CSV EXPORT ────────────────────────────────────────────────────────────

function csvCell(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

$('csvBtn').addEventListener('click', () => {
  const rows = filtered()
  if (!rows.length) { showToast('Nothing to export', 'err'); return }

  const header = ['Date', 'Person', 'Role', 'Project', 'Gig code', 'Gig title', 'Start', 'End', 'Minutes', 'Type', 'Status', 'Notes']
  const lines = rows
    .slice().sort((a, b) => a.entry_date.localeCompare(b.entry_date) || (a.start_time || '').localeCompare(b.start_time || ''))
    .map(e => [
      e.entry_date, nameOf(e.user_id), ROLE_LABEL[userById(e.user_id)?.role] || '',
      e.gigs?.projects?.project_code || '', e.gigs?.gig_code || '', e.gigs?.title || '',
      (e.start_time || '').slice(0, 5), (e.end_time || '').slice(0, 5), entryMins(e),
      e.entry_type || '', isRunning(e) ? 'running' : isOpen(e) ? 'open' : 'complete', e.notes || '',
    ].map(csvCell).join(','))

  const blob = new Blob(['\uFEFF' + [header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `timesheets_${toISODate(range.start)}_${toISODate(range.end)}.csv`
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(a.href)
})

// ── CONTROLS ──────────────────────────────────────────────────────────────

function syncPeriodUI() {
  const custom = period === 'custom'
  $('customCtl').style.display = custom ? 'flex' : 'none'
  $('prevBtn').disabled = custom
  $('nextBtn').disabled = custom || offset >= 0
  $('todayBtn').disabled = custom
}

document.querySelectorAll('input[name="period"]').forEach(r => r.addEventListener('change', () => {
  period = r.value
  offset = 0
  if (period === 'custom') {
    const { start, end } = computeRange()
    $('fromInput').value = toISODate(start)
    $('toInput').value = toISODate(end)
  }
  syncPeriodUI()
  loadEntries()
}))

document.querySelectorAll('input[name="view"]').forEach(r => r.addEventListener('change', () => {
  view = r.value
  render()
}))

$('prevBtn').addEventListener('click', () => { offset -= 1; syncPeriodUI(); loadEntries() })
$('nextBtn').addEventListener('click', () => { if (offset < 0) { offset += 1; syncPeriodUI(); loadEntries() } })
$('todayBtn').addEventListener('click', () => { offset = 0; syncPeriodUI(); loadEntries() })

$('fromInput').addEventListener('change', loadEntries)
$('toInput').addEventListener('change', loadEntries)
$('userSelect').addEventListener('change', e => { userId = e.target.value; render() })
$('projectSelect').addEventListener('change', e => { projectId = e.target.value; render() })

// ── INIT ──────────────────────────────────────────────────────────────────

syncPeriodUI()
await Promise.all([loadUsers(), loadProjects()])
await loadEntries()
