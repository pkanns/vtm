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
 *  3b. ADHOC TEMPLATES
 *  4. RECURRENCE SCHEDULE
 *  5. GIG TASKS
 *  6. DASHBOARD PAGES
 *  7. EVALUATIONS
 *  8. USERS
 *  9. TIME ENTRY AGGREGATES
 * 10. COUNTS (dashboard)
 * 11. SHARED HELPERS
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
 *
 * recurrence_frequency is included so the UI can tell an adhoc template
 * (cadence:'recurring', recurrence_frequency:'adhoc', no parent_gig_id)
 * apart from a normally-scheduled recurring gig, without a second fetch.
 */
export async function fetchProjectsWithGigs(db) {
  const [projRes, gigsRes] = await Promise.all([
    db.from('projects')
      .select('*')
      .order('project_code', { ascending: true }),
    db.from('gigs')
      .select(`
        gig_id, gig_code, title, description, status, cadence,
        recurrence_frequency,
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

/**
 * Gigs eligible for evaluation — delivered only. A gig has to actually be
 * marked delivered (not just in_progress) before evaluation can start;
 * this used to also include in_progress, which cluttered the picker with
 * gigs that weren't really ready yet.
 */
export async function fetchGigsForEval(db) {
  return db
    .from('gigs')
    .select(`
      gig_id, gig_code, title, description, status, cadence,
      date_due, date_start, pacer_id, rover_id,
      setting, scale, skill_level, budget_total,
      project_categories ( category_code )
    `)
    .eq('status', 'delivered')
    .order('date_due', { ascending: true })
}

export async function fetchEvaluationByGig(db, gigId) {
  return db
    .from('evaluations')
    .select('*')
    .eq('gig_id', gigId)
    .maybeSingle()
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

// ── 3b. ADHOC TEMPLATES ─────────────────────────────────────────────────
// A "template" is just a gig saved with cadence:'recurring' and
// recurrence_frequency:'adhoc' — no recurrence_schedule row gets written,
// so the daily cron (create_recurrences.py) never touches it. It sits
// there as a reusable definition until someone triggers a copy.
//
// spawnAdhocInstance() is the manual, on-demand equivalent of what
// create_recurrences.py already does automatically for scheduled gigs:
// generate the next _NNN instance code off the template's own code, copy
// the template's fields generously (including dates/budget/notes, so the
// instance can be taken through the same steps as before and edited from
// there) plus its task checklist, and save it as a fresh instance.
//
// Instances are always saved as cadence:'oneoff' — never 'recurring' —
// so an instance can never itself become a template and re-trigger this.
// Only the true template (recurring + adhoc + no parent_gig_id) ever
// shows a "create from template" action anywhere in the UI.
//
// Status: an instance always has both Lead and Doer copied straight from
// the template, so — same as a manually-created one-off gig, and same as
// a cron-spawned scheduled recurring instance (see create_recurrences.py)
// — there's nothing left to wait on. It enters at 'matched', not 'placed'.
//
// Note on task copies: this always writes fresh gig_tasks rows via
// createTask() below (no task_id/created_at carried over from the
// template), so each instance's tasks get their own honest creation
// timestamp — never inherit the template's original (possibly old) age.

export async function spawnAdhocInstance(db, templateGigId) {
  const { data: template, error: tErr } = await fetchGigById(db, templateGigId)
  if (tErr || !template) return { data: null, error: tErr || new Error('Template not found') }

  const { code: instanceCode, error: codeErr } =
    await generateGigCode(db, null, null, null, template.gig_code)
  if (codeErr || !instanceCode) return { data: null, error: codeErr || new Error('Could not generate instance code') }

  const today = new Date().toISOString().split('T')[0]

  const payload = {
    gig_code:              instanceCode,
    project_id:            template.project_id,
    category_id:           template.category_id,
    parent_gig_id:         template.gig_id,
    title:                 template.title,
    description:           template.description,
    pacer_id:               template.pacer_id,
    rover_id:               template.rover_id,
    cadence:                'oneoff',
    scale:                  template.scale,
    setting:                template.setting,
    skill_level:            template.skill_level,
    status:                 'matched',
    date_placed:            today,
    date_start:             template.date_start,
    date_due:               template.date_due,
    notes:                  template.notes,
    budget_total:           template.budget_total,
    recurrence_frequency:   null,
    recurrence_end_date:    null,
    recurrence_stopped:     false,
  }

  const { data: saved, error: saveErr } = await saveGig(db, payload)
  if (saveErr) return { data: null, error: saveErr }
  const newGig = Array.isArray(saved) ? saved[0] : saved

  // Copy the checklist too, so the instance can be worked through the same
  // steps as the template — progress resets (done:false) but the task
  // list doesn't have to be rebuilt from scratch every time.
  const { data: tasks } = await fetchTasksByGig(db, templateGigId)
  if (tasks?.length) {
    const taskPayloads = tasks.map(t => ({
      gig_id:      newGig.gig_id,
      title:       t.title,
      assigned_to: t.assigned_to,
      created_by:  template.pacer_id || null,
      done:        false,
    }))
    await createTask(db, taskPayloads)
  }

  return { data: newGig, error: null }
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

// ── 5. GIG TASKS ───────────────────────────────────────────────────────────
// Table: gig_tasks (task_id, gig_id, title, assigned_to, done, created_by,
// created_at, updated_at). Default assignee on creation is always the
// gig's Doer; permission rules live in gig_tasks.js, not here.
//
// updated_at is stamped here — by this API layer, not by a DB trigger —
// on every write that changes a task: creation, toggling done, and
// reassignment/other field edits via updateTask(). created_at is never
// touched again after insert, so it stays the true creation time; that
// split is what lets task_index.html and the weekly report eventually
// tell "added" apart from "last changed" instead of collapsing both into
// one ambiguous timestamp.

export async function fetchTasksByGig(db, gigId) {
  return db
    .from('gig_tasks')
    .select('*')
    .eq('gig_id', gigId)
    .order('created_at', { ascending: true })
}

/**
 * Fetch every task across all gigs, with the parent gig's context joined
 * (status, due date, project, Lead/Doer, cadence/parent_gig_id) — the
 * data source for task_index.html's cross-gig register. cadence and
 * parent_gig_id are included specifically so the page can exclude tasks
 * that belong to a "master" gig (a recurring gig with no parent — the
 * checklist template copied onto each spawned instance, not real work
 * itself). No role filtering here, same convention as fetchGigs(): the
 * page applies role scoping after fetch.
 */
export async function fetchAllTasksWithGigContext(db) {
  return db
    .from('gig_tasks')
    .select(`
      *,
      gigs (
        gig_id, gig_code, title, status, date_due, cadence, parent_gig_id,
        project_id, pacer_id, rover_id,
        projects ( project_code )
      )
    `)
    .order('created_at', { ascending: false })
}

export async function createTask(db, payload) {
  const now = new Date().toISOString()
  const stamped = Array.isArray(payload)
    ? payload.map(p => ({ ...p, updated_at: now }))
    : { ...payload, updated_at: now }
  return db.from('gig_tasks').insert(stamped).select()
}

export async function updateTask(db, taskId, payload) {
  return db
    .from('gig_tasks')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('task_id', taskId)
}

export async function toggleTaskDone(db, taskId, done) {
  return db
    .from('gig_tasks')
    .update({ done, updated_at: new Date().toISOString() })
    .eq('task_id', taskId)
}

export async function deleteTask(db, taskId) {
  return db.from('gig_tasks').delete().eq('task_id', taskId)
}

// ── 6. DASHBOARD PAGES (dash_admin.html config; dashboard.html reads it) ──
// Table: dashboard_pages (page_id, label, description, url, sort_order,
// visible_admin, visible_pacer, visible_rover). No auto-discovery is
// possible on a static site — this list is maintained by hand via
// dash_admin.html, not derived from the repo's actual files.

export async function fetchDashboardPages(db) {
  return db
    .from('dashboard_pages')
    .select('*')
    .order('sort_order', { ascending: true })
}

export async function addDashboardPage(db, payload) {
  return db.from('dashboard_pages').insert(payload).select()
}

export async function updateDashboardPageVisibility(db, pageId, field, value) {
  return db.from('dashboard_pages').update({ [field]: value }).eq('page_id', pageId)
}

export async function deleteDashboardPage(db, pageId) {
  return db.from('dashboard_pages').delete().eq('page_id', pageId)
}

// ── 7. EVALUATIONS ────────────────────────────────────────────────────────

export async function saveEvaluation(db, payload) {
  return db.from('evaluations').insert([payload])
}

export async function fetchEvaluations(db) {
  return db
    .from('evaluations')
    .select('*')
    .order('created_at', { ascending: false })
}

// ── 8. USERS ──────────────────────────────────────────────────────────────

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

export async function fetchUsersByIds(db, ids) {
  const clean = (ids || []).filter(Boolean)
  if (!clean.length) return { data: [], error: null }
  return db.from('vtm_users').select('user_id, name').in('user_id', clean)
}

// ── 9. TIME ENTRY AGGREGATES ────────────────────────────────────────────
// Read-only helpers over the existing time_entries table — no schema
// changes. fetchLoggedMinutesForGig() sums completed (is_active:false)
// entries for a gig, used to show a plain "hours logged so far" line at
// clock-out / manual-save time — no target, no bar, just the number.

export async function fetchLoggedMinutesForGig(db, gigId) {
  const { data, error } = await db
    .from('time_entries')
    .select('duration_mins')
    .eq('gig_id', gigId)
    .eq('is_active', false)

  if (error || !data) return 0
  return data.reduce((sum, e) => sum + (e.duration_mins || 0), 0)
}

// ── 10. COUNTS (dashboard) ─────────────────────────────────────────────────

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

// ── 11. SHARED HELPERS ─────────────────────────────────────────────────────

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
