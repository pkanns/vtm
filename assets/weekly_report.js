/**
 * weekly_report.js — Vidai to Mulai · Weekly Report
 * Personal report only for now — a Lead's read access into their Doers'
 * reports is a deliberately separate, later page (the pacer/rover
 * relationship isn't a clean one-to-one, worth its own design pass).
 *
 * Requires a `weekly_reports` table (not yet created — SQL comes after
 * this). Save Draft / Submit will fail with a clear error until that
 * table exists; everything else (the live gigs/hours/pie summary) works
 * today since it only reads from gigs/time_entries/evaluations.
 */

import { db }                       from './vtm_db.js'
import { fetchGigs, fmtDate, esc }  from './vtm_api.js'
import { enrichGig }                from './gig_filters.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }
const myUserId = session.user_id

// ── WEEK MATH ────────────────────────────────────────────────────────────

function mondayOf(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()               // 0 = Sun ... 6 = Sat
  const diff = day === 0 ? -6 : 1 - day  // shift back to Monday
  d.setDate(d.getDate() + diff)
  return d
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function toISODate(d) {
  return d.toISOString().split('T')[0]
}

function fmtWeekLabel(monday) {
  const sunday = addDays(monday, 6)
  const opts = { month: 'short', day: 'numeric' }
  const startStr = monday.toLocaleDateString(undefined, opts)
  const endStr   = sunday.toLocaleDateString(undefined,
    monday.getMonth() === sunday.getMonth() ? { day: 'numeric' } : opts)
  return `Week of ${startStr} \u2013 ${endStr}`
}

// ── STATE ─────────────────────────────────────────────────────────────────

let weekOffset  = 0          // 0 = current week; negative = past weeks
let allMyGigs   = []         // loaded once, filtered/enriched
let draftFields = { accomplishment: '', next_steps: '', support_needed: '' }

const weekLabelEl  = document.getElementById('weekLabel')
const statusChipEl = document.getElementById('statusChip')
const bodyEl       = document.getElementById('reportBody')
const nextBtn      = document.getElementById('nextWeekBtn')

// ── LOAD MY GIGS (once — role-agnostic, "gigs I'm on") ─────────────────────

async function loadMyGigs() {
  const { data, error } = await fetchGigs(db)
  if (error) { allMyGigs = []; return }
  allMyGigs = (data || [])
    .filter(g => g.rover_id === myUserId || g.pacer_id === myUserId)
    .map(enrichGig)
}

// ── LOAD ONE WEEK ────────────────────────────────────────────────────────

async function loadWeek() {
  const monday = addDays(mondayOf(new Date()), weekOffset * 7)
  const sunday = addDays(monday, 6)
  const isCurrent = weekOffset === 0

  weekLabelEl.textContent = fmtWeekLabel(monday)
  nextBtn.disabled = weekOffset >= 0

  bodyEl.innerHTML = '<div class="empty-week">Loading\u2026</div>'

  // Existing saved row for this week, if any
  const { data: existing } = await db
    .from('weekly_reports')
    .select('*')
    .eq('user_id', myUserId)
    .eq('week_start_date', toISODate(monday))
    .maybeSingle()
    .then(r => r, () => ({ data: null }))  // table may not exist yet — degrade quietly here

  if (existing?.status === 'submitted') {
    statusChipEl.textContent = 'Submitted'
    statusChipEl.className = 'status-chip submitted'
    renderSubmitted(existing)
    return
  }

  if (!isCurrent) {
    statusChipEl.textContent = 'No report'
    statusChipEl.className = 'status-chip missed'
    bodyEl.innerHTML = '<div class="empty-week">No report was submitted for this week.</div>'
    return
  }

  // Current week — live, editable draft
  statusChipEl.textContent = 'Draft'
  statusChipEl.className = 'status-chip draft'
  draftFields = {
    accomplishment: existing?.accomplishment || '',
    next_steps:     existing?.next_steps     || '',
    support_needed: existing?.support_needed || '',
  }

  await renderDraft(monday, sunday)
}

// ── RENDER: SUBMITTED (read-only, from frozen snapshot) ────────────────────

function renderSubmitted(row) {
  const snap = row.snapshot_data || {}
  bodyEl.innerHTML = `
    ${buildPieHTML(snap.pie_slices || [])}
    ${buildGigsListHTML(snap.gigs || [])}
    ${snap.closed_line ? `<div class="closed-line">${snap.closed_line}</div>` : ''}
    <div class="text-block">
      <div class="section-label">This week</div>
      ${textBlockHTML('Accomplishment', row.accomplishment, true)}
      ${textBlockHTML('Next steps',     row.next_steps, true)}
      ${textBlockHTML('Support needed', row.support_needed, true)}
    </div>
  `
}

// ── RENDER: DRAFT (live data, editable) ─────────────────────────────────────

async function renderDraft(monday, sunday) {
  const { data: entries } = await db
    .from('time_entries')
    .select('gig_id, duration_mins, entry_date')
    .eq('user_id', myUserId)
    .gte('entry_date', toISODate(monday))
    .lte('entry_date', toISODate(sunday))

  const minsByGig = {}
  ;(entries || []).forEach(e => {
    minsByGig[e.gig_id] = (minsByGig[e.gig_id] || 0) + (e.duration_mins || 0)
  })

  const activeGigs = allMyGigs.filter(g => g.status !== 'completed')
  const gigsForDisplay = activeGigs.map(g => ({
    gig_id: g.gig_id,
    gig_code: g.gig_code,
    title: g.title,
    project_code: g.projects?.project_code || null,
    status: g.status,
    date_due: g.date_due,
    isOverdue: g.isOverdue,
    minutes: minsByGig[g.gig_id] || 0,
  }))

  const closedLine = await buildClosedLine(monday, sunday)
  const pieSlices  = buildPieSlices(gigsForDisplay)

  bodyEl.innerHTML = `
    ${buildPieHTML(pieSlices)}
    ${buildGigsListHTML(gigsForDisplay)}
    ${closedLine ? `<div class="closed-line">${closedLine}</div>` : ''}
    <div class="text-block">
      <div class="section-label">This week</div>
      ${textBlockHTML('Accomplishment', draftFields.accomplishment, false, 'accomplishment', 'What moved forward this week\u2026')}
      ${textBlockHTML('Next steps',     draftFields.next_steps,     false, 'next_steps',     'What\u2019s planned for next week\u2026')}
      ${textBlockHTML('Support needed', draftFields.support_needed, false, 'support_needed', 'Specific ask, or \u2018None\u2019\u2026')}
      <div class="report-actions">
        <button class="btn-save-draft" onclick="saveDraft()">Save draft</button>
        <button class="btn-submit-week" onclick="submitWeek()">Submit week \u2192</button>
      </div>
    </div>
  `
}

async function buildClosedLine(monday, sunday) {
  const nextDay = toISODate(addDays(sunday, 1))
  const { data, error } = await db
    .from('evaluations')
    .select('gig_id, created_at, gigs(gig_code, title, status, rover_id, pacer_id)')
    .gte('created_at', toISODate(monday))
    .lt('created_at', nextDay)

  if (error || !data) return ''

  const mine = data.filter(e =>
    e.gigs?.status === 'completed' &&
    (e.gigs.rover_id === myUserId || e.gigs.pacer_id === myUserId)
  )
  if (!mine.length) return ''

  return `Closed this week \u00b7 ` + mine.map(e =>
    `<strong>${esc(e.gigs.gig_code)}</strong>`
  ).join(', ')
}

// ── PIE ──────────────────────────────────────────────────────────────────

const PIE_COLORS = ['#7b3fa0', '#2a5a8a', '#3a7a6b', '#8a6e3f', '#5a4a8a']
const NON_PROJECT_COLOR = '#b4b2a9'
const WEEK_TARGET_MINS = 40 * 60

function buildPieSlices(gigs) {
  const byProject = {}
  gigs.forEach(g => {
    const key = g.project_code || '\u2014'
    byProject[key] = (byProject[key] || 0) + g.minutes
  })

  const projectMins = Object.entries(byProject).filter(([, m]) => m > 0)
  const totalLogged = projectMins.reduce((s, [, m]) => s + m, 0)

  const slices = projectMins.map(([label, mins], i) => ({
    label, minutes: mins, color: PIE_COLORS[i % PIE_COLORS.length],
  }))

  if (totalLogged < WEEK_TARGET_MINS) {
    slices.push({ label: 'Non-project', minutes: WEEK_TARGET_MINS - totalLogged, color: NON_PROJECT_COLOR })
  }

  return slices
}

function buildPieHTML(slices) {
  const total = slices.reduce((s, x) => s + x.minutes, 0)
  if (!total) return '<div class="pie-empty">No time logged yet this week.</div>'

  const cx = 110, cy = 120, r = 90
  let angle = 0
  const paths = []
  const labels = []

  slices.forEach(s => {
    if (s.minutes <= 0) return
    const frac  = s.minutes / total
    const start = angle
    const end   = angle + frac * 360
    angle = end

    const large = (end - start) > 180 ? 1 : 0
    const p1 = polar(cx, cy, r, start)
    const p2 = polar(cx, cy, r, end)
    paths.push(`<path d="M${cx},${cy} L${p1.x},${p1.y} A${r},${r} 0 ${large},1 ${p2.x},${p2.y} Z" fill="${s.color}"></path>`)

    const mid = (start + end) / 2
    const hrs = fmtHours(s.minutes)
    const dark = s.color === NON_PROJECT_COLOR

    if ((end - start) < 22) {
      // Thin slice — leader line + label just outside
      const edge = polar(cx, cy, r, mid)
      const out  = polar(cx, cy, r * 1.28, mid)
      labels.push(`<line x1="${edge.x}" y1="${edge.y}" x2="${out.x}" y2="${out.y}" stroke="var(--stone)" stroke-width="1"></line>`)
      labels.push(`<text x="${out.x}" y="${out.y - 6}" text-anchor="middle" font-family="'DM Mono',monospace" font-size="9" font-weight="700" fill="var(--charcoal)">${esc(s.label)}</text>`)
      labels.push(`<text x="${out.x}" y="${out.y + 6}" text-anchor="middle" font-family="'Courier Prime',monospace" font-size="10" fill="var(--charcoal)">${hrs}</text>`)
    } else {
      const inPt = polar(cx, cy, r * 0.6, mid)
      labels.push(`<text x="${inPt.x}" y="${inPt.y - 4}" text-anchor="middle" font-family="'DM Mono',monospace" font-size="10" font-weight="700" fill="${dark ? 'var(--charcoal)' : 'var(--white)'}">${esc(s.label)}</text>`)
      labels.push(`<text x="${inPt.x}" y="${inPt.y + 11}" text-anchor="middle" font-family="'Courier Prime',monospace" font-size="12" fill="${dark ? 'var(--charcoal)' : 'var(--white)'}">${hrs}</text>`)
    }
  })

  return `<div class="pie-section"><svg viewBox="0 0 220 250" width="240">${paths.join('')}${labels.join('')}</svg></div>`
}

function polar(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) }
}

function fmtHours(mins) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// ── GIGS LIST ────────────────────────────────────────────────────────────

function buildGigsListHTML(gigs) {
  if (!gigs.length) return '<div class="gigs-list"><div class="empty-week">No active gigs.</div></div>'

  const rows = gigs.map(g => `
    <div class="gig-row">
      <div class="gig-row-title"><span class="gig-row-code">${esc(g.gig_code)}</span> ${esc(g.title)}</div>
      <span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span>
      <span class="gig-row-due${g.isOverdue ? ' overdue' : ''}">${g.date_due ? fmtDate(g.date_due) : '\u2014'}</span>
      <span class="gig-row-hours">${g.minutes ? fmtHours(g.minutes) : '0h'}</span>
    </div>`).join('')

  return `<div class="section-label">Active gigs \u00b7 auto-filled</div><div class="gigs-list">${rows}</div>`
}

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── TEXT BLOCKS ──────────────────────────────────────────────────────────

function textBlockHTML(label, value, readonly, fieldId, placeholder) {
  if (readonly) {
    return `<div class="text-block-card readonly">
      <label>${label}</label>
      <div style="font-size:13px;color:var(--black);white-space:pre-wrap;">${esc(value) || '\u2014'}</div>
    </div>`
  }
  return `<div class="text-block-card">
    <label>${label}</label>
    <textarea id="field_${fieldId}" placeholder="${esc(placeholder)}" oninput="draftFields.${fieldId} = this.value">${esc(value)}</textarea>
  </div>`
}

// ── SAVE / SUBMIT ────────────────────────────────────────────────────────
// Both require the weekly_reports table — not yet created. Until then these
// will fail with a clear toast rather than silently doing nothing.

window.saveDraft = async function() {
  const monday = mondayOf(new Date())
  syncFieldsFromDOM()

  const { error } = await db.from('weekly_reports').upsert({
    user_id:         myUserId,
    week_start_date: toISODate(monday),
    status:          'draft',
    accomplishment:  draftFields.accomplishment,
    next_steps:      draftFields.next_steps,
    support_needed:  draftFields.support_needed,
  }, { onConflict: 'user_id,week_start_date' })

  if (error) { showToast('Save failed \u2014 ' + error.message, 'err'); return }
  showToast('Draft saved', 'ok')
}

window.submitWeek = async function() {
  const monday = mondayOf(new Date())
  const sunday = addDays(monday, 6)
  syncFieldsFromDOM()

  if (!confirm('Submit this week\u2019s report? It will be locked as-is.')) return

  const { data: entries } = await db
    .from('time_entries')
    .select('gig_id, duration_mins, entry_date')
    .eq('user_id', myUserId)
    .gte('entry_date', toISODate(monday))
    .lte('entry_date', toISODate(sunday))

  const minsByGig = {}
  ;(entries || []).forEach(e => { minsByGig[e.gig_id] = (minsByGig[e.gig_id] || 0) + (e.duration_mins || 0) })

  const activeGigs = allMyGigs.filter(g => g.status !== 'completed')
  const gigsSnapshot = activeGigs.map(g => ({
    gig_id: g.gig_id, gig_code: g.gig_code, title: g.title,
    project_code: g.projects?.project_code || null,
    status: g.status, date_due: g.date_due, isOverdue: g.isOverdue,
    minutes: minsByGig[g.gig_id] || 0,
  }))

  const closedLine = await buildClosedLine(monday, sunday)
  const pieSlices   = buildPieSlices(gigsSnapshot)

  const { error } = await db.from('weekly_reports').upsert({
    user_id:         myUserId,
    week_start_date: toISODate(monday),
    status:          'submitted',
    submitted_at:    new Date().toISOString(),
    accomplishment:  draftFields.accomplishment,
    next_steps:      draftFields.next_steps,
    support_needed:  draftFields.support_needed,
    snapshot_data:   { gigs: gigsSnapshot, pie_slices: pieSlices, closed_line: closedLine },
  }, { onConflict: 'user_id,week_start_date' })

  if (error) { showToast('Submit failed \u2014 ' + error.message, 'err'); return }
  showToast('Week submitted', 'ok')
  loadWeek()
}

function syncFieldsFromDOM() {
  ;['accomplishment', 'next_steps', 'support_needed'].forEach(f => {
    const el = document.getElementById('field_' + f)
    if (el) draftFields[f] = el.value
  })
}

// ── WEEK NAV ─────────────────────────────────────────────────────────────

window.goWeek = function(delta) {
  const next = weekOffset + delta
  if (next > 0) return
  weekOffset = next
  loadWeek()
}

// ── INIT ─────────────────────────────────────────────────────────────────

await loadMyGigs()
await loadWeek()
