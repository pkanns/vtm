/**
 * vtm_api.js — Vidai to Mulai · Database API Layer
 * All Supabase read/write functions live here.
 * Pages import only what they need.
 * To fix a query: edit here once, all pages benefit.
 *
 * Sections:
 *  1. PROJECTS
 *  2. PROJECT CATEGORIES
 *  3. GIGS
 *  4. RECURRENCE SCHEDULE
 *  5. EVALUATIONS
 *  6. USERS
 *  7. COUNTS (dashboard)
 *  8. SHARED HELPERS
 */

// ── 1. PROJECTS ───────────────────────────────────────────────────────────

export async function fetchProjects(db) {
  return db
    .from('projects')
    .select('*')
    .order('project_code', { ascending: true })
}

export async function fetchProjectById(db, id) {
  return db
    .from('projects')
    .select('*')
    .eq('project_id', id)
    .single()
}

export async function fetchProjectByCode(db, code) {
  return db
    .from('projects')
    .select('*')
    .eq('project_code', code)
    .single()
}

export async function saveProject(db, payload, id = null) {
  if (id) return db.from('projects').update(payload).eq('project_id', id).select()
  return db.from('projects').insert(payload).select()
}

export async function deleteProject(db, id) {
  return db.from('projects').delete().eq('project_id', id)
}

// ── 2. PROJECT CATEGORIES ─────────────────────────────────────────────────

export async function fetchCategoriesByProject(db, projectId) {
  return db
    .from('project_categories')
    .select('*')
    .eq('project_id', projectId)
    .order('category_code', { ascending: true })
}

export async function saveCategoriesBulk(db, projectId, categories) {
  // categories = [{ category_code, category_name }, ...]
  // Upsert all rows for this project in one call
  const rows = categories.map(c => ({
    project_id:    projectId,
    category_code: c.category_code.toUpperCase().trim(),
    category_name: c.category_name.trim(),
  }))
  return db
    .from('project_categories')
    .upsert(rows, { onConflict: 'project_id,category_code' })
    .select()
}

export async function deleteCategory(db, categoryId) {
  return db
    .from('project_categories')
    .delete()
    .eq('category_id', categoryId)
}

export async function deleteCategoriesByProject(db, projectId) {
  return db
    .from('project_categories')
    .delete()
    .eq('project_id', projectId)
}

// ── 3. GIGS ───────────────────────────────────────────────────────────────

/**
 * Fetch all gigs with project and category info joined.
 * Returns: gig fields + project_code, project_name, category_code, category_name
 */
export async function fetchGigs(db) {
  return db
    .from('gigs')
    .select(`
      *,
      projects   ( project_code, project_name ),
      project_categories ( category_code, category_name )
    `)
    .order('gig_code', { ascending: true })
}

/**
 * Fetch gigs for a specific project, with categories joined.
 * Includes nested recurring instances grouped under their parent.
 */
export async function fetchGigsByProject(db, projectId) {
  return db
    .from('gigs')
    .select(`
      *,
      project_categories ( category_code, category_name )
    `)
    .eq('project_id', projectId)
    .order('gig_code', { ascending: true })
}

/**
 * Fetch all projects with their gigs nested — for project_index.
 * Returns projects array; each has a gigs array attached in JS after fetch.
 */
export async function fetchProjectsWithGigs(db) {
  const [projRes, gigsRes] = await Promise.all([
    db.from('projects')
      .select('*')
      .order('project_code', { ascending: true }),
    db.from('gigs')
      .select(`
        gig_id, gig_code, title, description, status, cadence,
        date_due, pacer_id, rover_id, parent_gig_id,
        project_id,
        project_categories ( category_code, category_name )
      `)
      .order('gig_code', { ascending: true })
  ])

  if (projRes.error) return { data: null, error: projRes.error }
  if (gigsRes.error) return { data: null, error: gigsRes.error }

  // Attach gigs to their project
  const projects = (projRes.data || []).map(p => ({
    ...p,
    gigs: (gigsRes.data || []).filter(g => g.project_id === p.project_id)
  }))

  return { data: projects, error: null }
}

export async function fetchGigById(db, id) {
  return db
    .from('gigs')
    .select(`
      *,
      projects ( project_code, project_name ),
      project_categories ( category_code, category_name )
    `)
    .eq('gig_id', id)
    .single()
}

export async function fetchGigsForEval(db) {
  return db
    .from('gigs')
    .select(`
      gig_id, gig_code, title, description, status, cadence,
      date_due, pacer_id, rover_id,
      project_categories ( category_code )
    `)
    .in('status', ['in_progress', 'delivered'])
    .order('date_due', { ascending: true })
}

/**
 * Generate the next gig code for a given project + category + type.
 * Pattern:
 *   One-off:           PROJECT_CAT_O_NNN
 *   Recurring parent:  PROJECT_CAT_R_NNN
 *   Recurring instance: PROJECT_CAT_R_NNN_MMM  (pass parentCode)
 */
export async function generateGigCode(db, projectCode, categoryCode, cadence, parentCode = null) {
  const type   = cadence === 'recurring' ? 'R' : 'O'
  const prefix = `${projectCode}_${categoryCode}_${type}_`

  if (parentCode) {
    // Recurring instance — count existing instances of this parent
    const { data, error } = await db
      .from('gigs')
      .select('gig_code')
      .like('gig_code', `${parentCode}_%`)
    if (error) return { code: null, error }
    const next = String((data?.length || 0) + 1).padStart(3, '0')
    return { code: `${parentCode}_${next}`, error: null }
  }

  // Fetch all gigs with this prefix — filter client-side for exact depth
  const { data, error } = await db
    .from('gigs')
    .select('gig_code')
    .like('gig_code', `${prefix}%`)

  if (error) return { code: null, error }

  // Count only exact parent codes — split by _ and match expected segment count
  // e.g. MULAI_AUTH_O_001 has 4 parts; instance MULAI_AUTH_O_001_001 has 5
  const prefixParts = prefix.split('_').length - 1  // prefix ends with _, so subtract 1
  const parents = (data || []).filter(g =>
    g.gig_code.split('_').length === prefixParts + 1
  )

  const next = String(parents.length + 1).padStart(3, '0')
  return { code: `${prefix}${next}`, error: null }
}

export async function saveGig(db, payload, id = null) {
  if (id) return db.from('gigs').update(payload).eq('gig_id', id).select()
  return db.from('gigs').insert(payload).select()
}

export async function updateGigStatus(db, id, status) {
  return db.from('gigs').update({ status }).eq('gig_id', id)
}

export async function deleteGig(db, id) {
  return db.from('gigs').delete().eq('gig_id', id)
}

// ── 4. RECURRENCE SCHEDULE ────────────────────────────────────────────────

export async function fetchActiveSchedules(db) {
  return db
    .from('recurrence_schedule')
    .select('*, gigs ( gig_code, title, project_id, rover_id )')
    .eq('is_active', true)
    .order('next_run_date', { ascending: true })
}

export async function saveRecurrenceSchedule(db, payload, id = null) {
  if (id) return db.from('recurrence_schedule').update(payload).eq('schedule_id', id).select()
  return db.from('recurrence_schedule').insert(payload).select()
}

export async function deactivateSchedule(db, scheduleId) {
  return db
    .from('recurrence_schedule')
    .update({ is_active: false })
    .eq('schedule_id', scheduleId)
}

export async function updateScheduleRover(db, scheduleId, roverId) {
  return db
    .from('recurrence_schedule')
    .update({ current_rover_id: roverId })
    .eq('schedule_id', scheduleId)
}

export async function advanceSchedule(db, scheduleId, nextRunDate) {
  return db
    .from('recurrence_schedule')
    .update({ next_run_date: nextRunDate })
    .eq('schedule_id', scheduleId)
}

// ── 5. EVALUATIONS ────────────────────────────────────────────────────────

export async function saveEvaluation(db, payload) {
  return db.from('evaluations').insert([payload])
}

export async function fetchEvaluations(db) {
  return db
    .from('evaluations')
    .select('*')
    .order('created_at', { ascending: false })
}

// ── 6. USERS ──────────────────────────────────────────────────────────────

export async function fetchActiveLeads(db) {
  return db
    .from('vtm_users')
    .select('user_id, name')
    .eq('role', 'pacer')
    .eq('active', true)
    .order('name')
}

export async function fetchActiveDoers(db) {
  return db
    .from('vtm_users')
    .select('user_id, name, skill_level')
    .eq('role', 'rover')
    .eq('active', true)
    .order('name')
}

// ── 7. COUNTS (dashboard) ─────────────────────────────────────────────────

export async function fetchCounts(db) {
  const [users, gigs, evals] = await Promise.all([
    db.from('vtm_users').select('*',      { count: 'exact', head: true }),
    db.from('gigs').select('*',           { count: 'exact', head: true }),
    db.from('evaluations').select('*',    { count: 'exact', head: true }),
  ])
  return {
    users: users.count ?? 0,
    gigs:  gigs.count  ?? 0,
    evals: evals.count ?? 0,
  }
}

// ── 8. SHARED HELPERS ─────────────────────────────────────────────────────

export function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, day] = iso.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${parseInt(day)} ${months[parseInt(m) - 1]} ${y}`
}

/**
 * Calculate next run date from a given date and frequency.
 * Returns ISO date string.
 */
export function calcNextRunDate(fromDate, frequency) {
  const d = new Date(fromDate)
  switch (frequency) {
    case 'weekly':      d.setDate(d.getDate() + 7);  break
    case 'fortnightly': d.setDate(d.getDate() + 14); break
    case 'monthly':     d.setMonth(d.getMonth() + 1); break
  }
  return d.toISOString().split('T')[0]
}

export function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
