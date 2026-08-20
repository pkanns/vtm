/**
 * report_data.js — Vidai to Mulai · Weekly Report data layer
 * Pure fetch/compute — no DOM, no rendering. weekly_report.js and
 * report_dashboard.js import from here so the underlying gigs/hours/effort/
 * task-changes computation only exists in one place.
 *
 * Nothing here is snapshotted or stored — every function computes live
 * from gigs/time_entries/gig_tasks/evaluations for whichever user+week is
 * asked for. The only persisted data in this whole feature is the
 * free-text reflection in weekly_reports (accomplishment/next_steps/
 * support_needed).
 *
 * WEEK WINDOW: Saturday → Friday (not Monday → Sunday). saturdayOf()
 * returns the most recent Saturday on/before the given date; the weekend
 * (Sat/Sun) therefore opens a week rather than closing one.
 */

import { fetchGigs, fetchAllTasksWithGigContext, esc } from './vtm_api.js'
import { enrichGig }      from './gig_filters.js'

// ── WEEK MATH ────────────────────────────────────────────────────────────

/**
 * Start of the Saturday-anchored week containing `date` — the most
 * recent Saturday on or before `date`.
 */
export function saturdayOf(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()              // 0=Sun ... 6=Sat
  const diff = -((day + 1) % 7)       // Sat->0, Sun->-1, Mon->-2 ... Fri->-6
  d.setDate(d.getDate() + diff)
  return d
}

export function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

export function toISODate(d) { return d.toISOString().split('T')[0] }

export function fmtWeekLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6)
  const opts = { month: 'short', day: 'numeric' }
  const startStr = weekStart.toLocaleDateString(undefined, opts)
  const endStr   = weekEnd.toLocaleDateString(undefined,
    weekStart.getMonth() === weekEnd.getMonth() ? { day: 'numeric' } : opts)
  return `Week of ${startStr} \u2013 ${endStr}`
}

export function fmtHours(mins) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function fmtDateTimeShort(iso) {
  if (!iso) return '\u2014'
  const d = new Date(iso)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const time = d.toTimeString().slice(0, 5)
  return `${d.getDate()} ${months[d.getMonth()]} \u00b7 ${time}`
}

// ── ACCESS MODEL ─────────────────────────────────────────────────────────
// Who the current session is allowed to view in the Data View:
//   admin  → everyone, plus an "all" aggregate option
//   pacer  → self, or exactly one Doer assigned to them (has a gig with
//            pacer_id = this lead) — one at a time, no aggregate
//   rover  → self only, no picker

export async function resolveViewableUsers(db, session) {
  if (session.role === 'admin') {
    const { data } = await db.from('vtm_users').select('user_id, name').order('name')
    return { canViewAll: true, users: data || [] }
  }

  if (session.role === 'pacer') {
    const { data } = await db
      .from('gigs')
      .select('rover_id, vtm_users!gigs_rover_id_fkey(user_id, name)')
      .eq('pacer_id', session.user_id)
      .not('rover_id', 'is', null)

    const seen = new Map()
    ;(data || []).forEach(g => {
      const u = g.vtm_users
      if (u && !seen.has(u.user_id)) seen.set(u.user_id, u.name)
    })
    const doers = Array.from(seen.entries()).map(([user_id, name]) => ({ user_id, name }))
    return { canViewAll: false, users: [{ user_id: session.user_id, name: session.name }, ...doers] }
  }

  return { canViewAll: false, users: [{ user_id: session.user_id, name: session.name }] }
}

// ── GIGS + HOURS FOR ONE PERSON, ONE WEEK ───────────────────────────────
// Deliberately NOT filtered by "is this gig currently mine" or "is this
// gig still open" — a time entry is a fact that already happened. If the
// gig was later reassigned, completed, or otherwise changed, the hours
// this person logged against it still belong in their weekly report.
// Any restriction on what counts as loggable time belongs upstream (the
// timesheet gig-picker, gig status rules) — not in the report itself.

export async function computeWeekData(db, userId, monday, sunday) {
  const { data: allGigs, error } = await fetchGigs(db)
  if (error) return { gigs: [], closedLine: '', totalMinutes: 0, timeSlices: [] }

  const gigById = {}
  ;(allGigs || []).forEach(g => { gigById[g.gig_id] = enrichGig(g) })

  const { data: entries } = await db
    .from('time_entries')
    .select('gig_id, duration_mins, entry_date')
    .eq('user_id', userId)
    .gte('entry_date', toISODate(monday))
    .lte('entry_date', toISODate(sunday))

  const minsByGig = {}
  ;(entries || []).forEach(e => {
    minsByGig[e.gig_id] = (minsByGig[e.gig_id] || 0) + (e.duration_mins || 0)
  })

  // Every gig with logged time this week — regardless of current
  // ownership or status. A gig that's been deleted since the entry was
  // logged has no row to join to; skip it rather than show a blank line.
  const gigs = Object.keys(minsByGig)
    .map(gigId => {
      const g = gigById[gigId]
      if (!g) return null
      return {
        gig_id: g.gig_id, gig_code: g.gig_code, title: g.title,
        project_code: g.projects?.project_code || null,
        status: g.status, date_due: g.date_due, isOverdue: g.isOverdue,
        minutes: minsByGig[gigId] || 0,
      }
    })
    .filter(Boolean)

  const totalMinutes = Object.values(minsByGig).reduce((s, m) => s + m, 0)
  const closedLine    = await buildClosedLine(db, userId, monday, sunday)
  const timeSlices     = buildTimeSlices(gigs)

  return { gigs, closedLine, totalMinutes, timeSlices }
}

async function buildClosedLine(db, userId, monday, sunday) {
  const nextDay = toISODate(addDays(sunday, 1))
  const { data, error } = await db
    .from('evaluations')
    .select('gig_id, created_at, gigs(gig_code, title, status, rover_id, pacer_id)')
    .gte('created_at', toISODate(monday))
    .lt('created_at', nextDay)

  if (error || !data) return ''

  const mine = data.filter(e =>
    e.gigs?.status === 'completed' &&
    (e.gigs.rover_id === userId || e.gigs.pacer_id === userId)
  )
  if (!mine.length) return ''

  return `Closed this week \u00b7 ` + mine.map(e => `<strong>${esc(e.gigs.gig_code)}</strong>`).join(', ')
}

// ── TASKS CHANGED THIS WEEK ───────────────────────────────────────────
// "Changed" = gig_tasks.updated_at falls inside the week — stamped by
// vtm_api.js on creation, toggling done, and reassignment. Visibility
// mirrors task_index.js's rule for a single user: tasks on gigs where
// they're the Lead or Doer, plus tasks assigned to them even on a gig
// they don't own.

export async function fetchTasksChangedForUser(db, userId, monday, sunday) {
  const { data, error } = await fetchAllTasksWithGigContext(db)
  if (error || !data) return []

  const windowStart = monday
  const windowEnd   = addDays(sunday, 1)   // exclusive

  return data
    .filter(t => t.gigs && t.updated_at)
    .filter(t => {
      const u = new Date(t.updated_at)
      return u >= windowStart && u < windowEnd
    })
    .filter(t =>
      t.gigs.pacer_id === userId ||
      t.gigs.rover_id === userId ||
      t.assigned_to === userId
    )
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
}

// ── TIME SLICES (project-consolidated, for bars/charts) ────────────────

const SLICE_COLORS = ['#7b3fa0', '#2a5a8a', '#3a7a6b', '#8a6e3f', '#5a4a8a']
const NON_PROJECT_COLOR = '#b4b2a9'
const WEEK_TARGET_MINS = 40 * 60

function buildTimeSlices(gigs) {
  const byProject = {}
  gigs.forEach(g => {
    const key = g.project_code || '\u2014'
    byProject[key] = (byProject[key] || 0) + g.minutes
  })

  const projectMins = Object.entries(byProject).filter(([, m]) => m > 0)
  const totalLogged = projectMins.reduce((s, [, m]) => s + m, 0)

  const slices = projectMins.map(([label, mins], i) => ({
    label, minutes: mins, color: SLICE_COLORS[i % SLICE_COLORS.length],
  }))

  if (totalLogged < WEEK_TARGET_MINS) {
    slices.push({ label: 'Non-project', minutes: WEEK_TARGET_MINS - totalLogged, color: NON_PROJECT_COLOR })
  }

  return slices.sort((a, b) => b.minutes - a.minutes)
}

// ── EFFORT BUCKETS ───────────────────────────────────────────────────────

export const EFFORT_BUCKETS = [
  { id: 'under20', label: 'Under 20h', test: m => m < 20 * 60 },
  { id: '20to40',  label: '20\u201340h',   test: m => m >= 20 * 60 && m <= 40 * 60 },
  { id: 'over40',  label: 'Over 40h',  test: m => m > 40 * 60 },
]

export function effortBucketId(totalMinutes) {
  return (EFFORT_BUCKETS.find(b => b.test(totalMinutes)) || EFFORT_BUCKETS[0]).id
}

// ── GIG CHANGES THIS WEEK (rough view — no schema change) ────────────
// True gig-level status-change history isn't tracked yet, so this is a
// deliberately rough substitute using fields we already have:
//   - gigs newly placed this week (date_placed falls in the week)
//   - gigs completed/evaluated this week (evaluations.created_at in week)
// Master/template gigs (recurring, no parent) are excluded — they're
// structural, never real placed work.

export async function fetchGigChangesForUser(db, userId, monday, sunday) {
  const { data: allGigs, error } = await fetchGigs(db)
  if (error) return { created: [], completed: [] }

  const mine = (allGigs || []).filter(g =>
    (g.rover_id === userId || g.pacer_id === userId) &&
    !(g.cadence === 'recurring' && !g.parent_gig_id)
  )

  const startISO = toISODate(monday)
  const endISO   = toISODate(sunday)
  const inWeek = iso => !!iso && iso >= startISO && iso <= endISO

  const created = mine
    .filter(g => inWeek(g.date_placed))
    .map(g => ({ gig_id: g.gig_id, gig_code: g.gig_code, title: g.title, status: g.status, date: g.date_placed }))

  const nextDay = toISODate(addDays(sunday, 1))
  const { data: evalRows } = await db
    .from('evaluations')
    .select('gig_id, created_at, gigs(gig_code, title, status, rover_id, pacer_id)')
    .gte('created_at', startISO)
    .lt('created_at', nextDay)

  const completed = (evalRows || [])
    .filter(e => e.gigs?.status === 'completed' && (e.gigs.rover_id === userId || e.gigs.pacer_id === userId))
    .map(e => ({ gig_id: e.gig_id, gig_code: e.gigs.gig_code, title: e.gigs.title, date: e.created_at }))

  return { created, completed }
}

// ── SAVED TEXT (the only persisted part) ────────────────────────────────

export async function fetchReportText(db, userId, weekStartISO) {
  const { data } = await db
    .from('weekly_reports')
    .select('*')
    .eq('user_id', userId)
    .eq('week_start_date', weekStartISO)
    .maybeSingle()
    .then(r => r, () => ({ data: null }))
  return data || null
}

export async function saveReportText(db, userId, weekStartISO, fields) {
  return db.from('weekly_reports').upsert({
    user_id: userId,
    week_start_date: weekStartISO,
    accomplishment: fields.accomplishment,
    next_steps: fields.next_steps,
    support_needed: fields.support_needed,
  }, { onConflict: 'user_id,week_start_date' })
}
