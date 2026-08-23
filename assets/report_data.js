/**
 * report_data.js — Vidai to Mulai · Weekly Report data layer
 * Pure fetch/compute — no DOM, no rendering. Both weekly_report.js and
 * report_dashboard.js import from here so the underlying gigs/hours/effort
 * computation only exists in one place.
 *
 * The only persisted, hand-written data in this whole feature is the
 * free-text reflection in weekly_reports (accomplishment/next_steps/
 * support_needed) — that's the only thing that requires an actual saved
 * row to exist; if nothing was saved for a week, nothing is shown for it.
 *
 * Everything else (Time/Task/Gig View) computes live, safely, for ANY
 * week — including past ones — because it's anchored to fixed, dated
 * facts (time_entries.entry_date, gig_tasks.updated_at,
 * evaluations.created_at, gigs.date_placed), not to a gig's *current*
 * status or *current* Lead/Doer assignment. A gig closing or being
 * reassigned after the fact doesn't change what actually happened that
 * week. (Gig title/status shown still reflect today's state, not the
 * gig's state back then — that's a display label, not a filter, so it's
 * honest but not perfectly period-accurate.)
 */

import { fetchGigs, esc } from './vtm_api.js'

// ── WEEK MATH ────────────────────────────────────────────────────────────

export function mondayOf(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

// Saturday → Friday week anchor. The weekend opens a week rather than
// closing one — used by weekly_report.js / report_dashboard.js instead
// of mondayOf().
export function saturdayOf(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()               // 0 = Sun ... 6 = Sat
  const diff = day === 6 ? 0 : -(day + 1)
  d.setDate(d.getDate() + diff)
  return d
}

export function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

export function toISODate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function fmtWeekLabel(monday) {
  const sunday = addDays(monday, 6)
  const opts = { month: 'short', day: 'numeric' }
  const startStr = monday.toLocaleDateString(undefined, opts)
  const endStr   = sunday.toLocaleDateString(undefined,
    monday.getMonth() === sunday.getMonth() ? { day: 'numeric' } : opts)
  return `Week of ${startStr} \u2013 ${endStr}`
}

export function fmtHours(mins) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// Short "date, time" label for a task's updated_at, e.g. "14 Aug, 3:05 PM"
export function fmtDateTimeShort(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const h24 = d.getHours()
  const h12 = h24 % 12 || 12
  const m   = String(d.getMinutes()).padStart(2, '0')
  return `${d.getDate()} ${months[d.getMonth()]}, ${h12}:${m} ${h24 < 12 ? 'AM' : 'PM'}`
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

export async function computeWeekData(db, userId, monday, sunday) {
  const { data: entries, error } = await db
    .from('time_entries')
    .select('gig_id, duration_mins, entry_date')
    .eq('user_id', userId)
    .eq('is_active', false)   // only submitted/completed entries — a still-running
                               // clock-in isn't "reported" time yet
    .gte('entry_date', toISODate(monday))
    .lte('entry_date', toISODate(sunday))

  if (error) return { gigs: [], closedLine: '', totalMinutes: 0, timeSlices: [] }

  const minsByGig = {}
  ;(entries || []).forEach(e => {
    minsByGig[e.gig_id] = (minsByGig[e.gig_id] || 0) + (e.duration_mins || 0)
  })

  // Only fetch the gigs actually touched this week — for title/code/status
  // labels only, never used to decide which rows appear. A gig closing,
  // getting reassigned, or being marked master doesn't erase real hours
  // logged against it earlier in the week.
  const gigIds = Object.keys(minsByGig)
  let gigRows = []
  if (gigIds.length) {
    const { data } = await db
      .from('gigs')
      .select('gig_id, gig_code, title, status, date_due, projects ( project_code )')
      .in('gig_id', gigIds)
    gigRows = data || []
  }

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const gigs = gigRows.map(g => {
    const due = g.date_due ? new Date(g.date_due) : null
    if (due) due.setHours(0, 0, 0, 0)
    return {
      gig_id: g.gig_id, gig_code: g.gig_code, title: g.title,
      project_code: g.projects?.project_code || null,
      status: g.status, date_due: g.date_due,
      isOverdue: !!due && due < today && g.status !== 'completed',
      minutes: minsByGig[g.gig_id] || 0,
    }
  })

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

// ── TASKS CHANGED THIS WEEK (Task View) ─────────────────────────────────
// Any gig_task whose updated_at falls in the given week, relevant to this
// user (assigned to them, or on a gig they lead/do). Master-gig tasks
// (the template checklist copied onto every spawned instance) are
// excluded, same rule as computeWeekData() above.

export async function fetchTasksChangedForUser(db, userId, monday, sunday) {
  const startISO = toISODate(monday)
  const endISO   = toISODate(addDays(sunday, 1))   // updated_at is a timestamp — use "< next day"

  const { data, error } = await db
    .from('gig_tasks')
    .select(`
      *,
      gigs ( gig_code, title, status, pacer_id, rover_id, cadence, parent_gig_id )
    `)
    .gte('updated_at', startISO)
    .lt('updated_at', endISO)
    .order('updated_at', { ascending: false })

  if (error || !data) return []

  return data.filter(t => {
    const g = t.gigs
    if (!g) return false
    if (g.cadence === 'recurring' && !g.parent_gig_id) return false
    return t.assigned_to === userId || g.pacer_id === userId || g.rover_id === userId
  })
}

// ── GIGS PLACED / COMPLETED THIS WEEK (Gig View) ────────────────────────
// Rough approximation, not a true change-log — no gig-level status
// history in the schema (deliberately, per scope). "Placed" = date_placed
// falls in the week; "Completed" = an evaluation was recorded in the
// week, same join buildClosedLine() already uses above.

export async function fetchGigChangesForUser(db, userId, monday, sunday) {
  const { data: allGigs, error } = await fetchGigs(db)
  if (error) return { created: [], completed: [] }

  const startISO = toISODate(monday)
  const endISO   = toISODate(sunday)

  const myGigs = (allGigs || []).filter(g =>
    (g.rover_id === userId || g.pacer_id === userId) &&
    !(g.cadence === 'recurring' && !g.parent_gig_id)
  )

  const created = myGigs
    .filter(g => g.date_placed && g.date_placed >= startISO && g.date_placed <= endISO)
    .map(g => ({ gig_id: g.gig_id, gig_code: g.gig_code, title: g.title, date: g.date_placed }))

  const nextDay = toISODate(addDays(sunday, 1))
  const { data: evals } = await db
    .from('evaluations')
    .select('gig_id, created_at, gigs(gig_code, title, status, rover_id, pacer_id)')
    .gte('created_at', startISO)
    .lt('created_at', nextDay)

  const completed = (evals || [])
    .filter(e => e.gigs?.status === 'completed' && (e.gigs.rover_id === userId || e.gigs.pacer_id === userId))
    .map(e => ({ gig_id: e.gig_id, gig_code: e.gigs.gig_code, title: e.gigs.title, date: (e.created_at || '').split('T')[0] }))

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
