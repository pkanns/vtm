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
 *  3c. CLOCKABLE GIGS (shared — Timesheet + Time Recording Gigs)
 *  3d. GIG LIFECYCLE (freeze / kill)
 *  3e. GIG LIFECYCLE REASONS (suggestion list)
 *  3f. LIFECYCLE MAP (shared — hide frozen/killed from fetched lists)
 *  4. RECURRENCE SCHEDULE
 *  5. GIG TASKS
 *  6. DASHBOARD PAGES
 *  7. EVALUATIONS
 *  8. USERS
 *  9. TIME ENTRY AGGREGATES
 *  9b. TIMESHEET PINNED GIGS
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

  // Same intent as create_recurrences.py's cron check — freezing/killing
  // a master should stop it spawning new instances, whether that spawn
  // is automatic (the cron) or manual (this function, triggered by the
  // "Create Instance" action). Checked live, not a synced flag — see
  // the cron script's comment on the same check for why.
  const { data: lifecycle } = await db.from('gig_lifecycle').select('state').eq('gig_id', templateGigId).maybeSingle()
  if (lifecycle?.state === 'frozen' || lifecycle?.state === 'killed') {
    return { data: null, error: new Error(`This template is ${lifecycle.state} — unfreeze it before creating a new instance`) }
  }

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

// ── 3c. CLOCKABLE GIGS (shared — Timesheet's drag pool + Time Recording
//         Gigs pin manager) ────────────────────────────────────────────
// Non-completed, non-master (a "master" gig — cadence:'recurring' with no
// parent_gig_id — is never itself worked, only its spawned instances
// are), non-frozen, role-scoped the same way everywhere else in the app:
// Lead/Doer see only their own, Admin sees all. This is the single
// source of truth for "what can this person clock time to" — every page
// that calls it (Timesheet, Time Recording Gigs, and via fetchGigs()
// downstream consumers) can never silently drift into showing different
// gig sets. Killed gigs are excluded for free (status:'completed' is
// already filtered out) — frozen needs an explicit check since freezing
// deliberately never touches status.

export async function fetchClockableGigs(db, role, userId) {
  let query = db.from('gigs')
    .select('gig_id, gig_code, title, project_id, status, pacer_id, rover_id, cadence, parent_gig_id, date_due')
    .not('status', 'eq', 'completed')
    .order('gig_code')

  if (role === 'pacer') query = query.eq('pacer_id', userId)
  if (role === 'rover') query = query.eq('rover_id', userId)

  const [{ data, error }, frozenRes] = await Promise.all([
    query,
    db.from('gig_lifecycle').select('gig_id').eq('state', 'frozen'),
  ])
  if (error) return { data: null, error }

  const frozenIds = new Set((frozenRes.data || []).map(r => r.gig_id))
  const clockable = (data || []).filter(g =>
    !(g.cadence === 'recurring' && !g.parent_gig_id) && !frozenIds.has(g.gig_id)
  )
  return { data: clockable, error: null }
}

// ── 3f. LIFECYCLE MAP (shared — anywhere that needs to hide frozen/
//         killed gigs from an ALREADY-FETCHED gig list) ────────────────
// Returns { [gig_id]: { state, reason } } for every gig with a
// gig_lifecycle row. Deliberately a plain lookup rather than baked into
// fetchGigs()/fetchProjectsWithGigs() themselves — those two are also
// used for HISTORICAL reporting (report_data.js), which must keep
// showing a gig's past activity regardless of its current lifecycle
// state. Consumers that need to hide frozen/killed (Gig Index, Project
// Index, Task Register, Week Planner) fetch this alongside their normal
// gig query and filter client-side; reporting consumers simply don't
// call this at all.

export async function fetchLifecycleMap(db) {
  const { data, error } = await db.from('gig_lifecycle').select('gig_id, state, reason')
  if (error) return { data: {}, error }

  const map = {}
  ;(data || []).forEach(r => { map[r.gig_id] = r })
  return { data: map, error: null }
}

// ── 3d. GIG LIFECYCLE (freeze / kill) ──────────────────────────────────────
// Table: gig_lifecycle (gig_id, state, reason, changed_by, changed_at) —
// see scripts/migration_gig_lifecycle.sql, not created by this file.
// A row present = frozen or killed (state tells you which). No row =
// active. Killing ALSO sets gigs.status = 'completed' — a killed gig IS
// a completed gig, distinguished from a normal evaluated completion by
// having a gig_lifecycle row. Unlike fetchClockableGigs(), this
// deliberately INCLUDES master/template gigs — freezing/killing a
// master is how you stop it spawning new instances (see Stage 3, the
// daily cron), so it must be manageable here even though it's never
// itself "clockable".
//
// fetchLifecycleGigs() returns every gig that's either still open
// (status != 'completed', which also covers currently-frozen gigs,
// since freezing never touches status) OR has been killed (so a killed
// gig — now status:'completed' — stays visible/searchable here even
// though its status changed). Ordinary gigs that reached 'completed'
// the normal way (an evaluation) are excluded — nothing to manage there.

export async function fetchLifecycleGigs(db) {
  const GIG_FIELDS = 'gig_id, gig_code, title, project_id, status, cadence, parent_gig_id, date_due, projects ( project_code, project_name )'

  const [openRes, killedIdsRes] = await Promise.all([
    db.from('gigs').select(GIG_FIELDS).not('status', 'eq', 'completed').order('gig_code'),
    db.from('gig_lifecycle').select('gig_id').eq('state', 'killed'),
  ])

  if (openRes.error) return { data: null, error: openRes.error }

  const killedIds = (killedIdsRes.data || []).map(r => r.gig_id)
  let killedGigs = []
  if (killedIds.length) {
    const { data, error } = await db.from('gigs').select(GIG_FIELDS).in('gig_id', killedIds)
    if (error) return { data: null, error }
    killedGigs = data || []
  }

  const merged = [...(openRes.data || []), ...killedGigs]
  if (!merged.length) return { data: [], error: null }

  const { data: lifecycleRows, error: lcErr } = await db
    .from('gig_lifecycle')
    .select('*')
    .in('gig_id', merged.map(g => g.gig_id))
  if (lcErr) return { data: null, error: lcErr }

  const lifecycleByGig = {}
  ;(lifecycleRows || []).forEach(r => { lifecycleByGig[r.gig_id] = r })

  return { data: merged.map(g => ({ ...g, lifecycle: lifecycleByGig[g.gig_id] || null })), error: null }
}

export async function freezeGig(db, gigId, userId, reason) {
  return db.from('gig_lifecycle').upsert({
    gig_id: gigId, state: 'frozen', reason: reason || null, changed_by: userId, changed_at: new Date().toISOString(),
  })
}

// Only ever removes a state:'frozen' row — a state:'killed' row can
// never be deleted through this (or any UI) path, by design.
export async function unfreezeGig(db, gigId) {
  return db.from('gig_lifecycle').delete().eq('gig_id', gigId).eq('state', 'frozen')
}

// Two writes, sequential rather than a single transaction — same
// convention already used for evaluations (gig_eval.js writes the
// evaluation row, then separately calls updateGigStatus()).
export async function killGig(db, gigId, userId, reason) {
  const { error: lcErr } = await db.from('gig_lifecycle').upsert({
    gig_id: gigId, state: 'killed', reason, changed_by: userId, changed_at: new Date().toISOString(),
  })
  if (lcErr) return { error: lcErr }
  return db.from('gigs').update({ status: 'completed' }).eq('gig_id', gigId)
}

// ── PROJECT-LEVEL CASCADE ───────────────────────────────────────────────
// "Freeze/kill a project" is not its own concept — it's applying the
// same gig-level action to every one of that project's still-open gigs
// in one go. No separate project table or project-level field anywhere;
// every downstream view keeps checking gig_lifecycle exactly as before.

export async function freezeProjectGigs(db, projectId, userId, reason) {
  const { data: gigs, error } = await db.from('gigs').select('gig_id').eq('project_id', projectId).not('status', 'eq', 'completed')
  if (error) return { count: 0, error }
  const ids = (gigs || []).map(g => g.gig_id)
  if (!ids.length) return { count: 0, error: null }

  const rows = ids.map(gig_id => ({ gig_id, state: 'frozen', reason: reason || null, changed_by: userId, changed_at: new Date().toISOString() }))
  const { error: upsertErr } = await db.from('gig_lifecycle').upsert(rows)
  return { count: ids.length, error: upsertErr }
}

export async function killProjectGigs(db, projectId, userId, reason) {
  const { data: gigs, error } = await db.from('gigs').select('gig_id').eq('project_id', projectId).not('status', 'eq', 'completed')
  if (error) return { count: 0, error }
  const ids = (gigs || []).map(g => g.gig_id)
  if (!ids.length) return { count: 0, error: null }

  const rows = ids.map(gig_id => ({ gig_id, state: 'killed', reason, changed_by: userId, changed_at: new Date().toISOString() }))
  const { error: lcErr } = await db.from('gig_lifecycle').upsert(rows)
  if (lcErr) return { count: 0, error: lcErr }

  const { error: statusErr } = await db.from('gigs').update({ status: 'completed' }).in('gig_id', ids)
  return { count: ids.length, error: statusErr }
}

// ── 3e. GIG LIFECYCLE REASONS (suggestion list) ─────────────────────────
// Table: gig_lifecycle_reasons (id, reason, sort_order, created_at) —
// see scripts/migration_gig_lifecycle_reasons.sql. Powers the reason
// picker's autocomplete suggestions on gig_lifecycle.html — a free-text
// input, not a locked dropdown, so a reason outside this list can still
// be typed. Managed directly via SQL for now; short list, changes rarely.

export async function fetchLifecycleReasons(db) {
  return db
    .from('gig_lifecycle_reasons')
    .select('reason')
    .order('sort_order', { ascending: true })
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

// ── 9b. TIMESHEET PINNED GIGS ─────────────────────────────────────────────
// Table: timesheet_pinned_gigs (id, user_id, gig_id, created_at) — see the
// migration in the Time Recording Gigs build notes; not created by this
// file. Pinning is per-person, self-managed: what shows up "within the
// fold" in the Timesheet's drag pool vs behind "Show more gigs".

export async function fetchPinnedGigIds(db, userId) {
  return db
    .from('timesheet_pinned_gigs')
    .select('gig_id')
    .eq('user_id', userId)
}

export async function pinGig(db, userId, gigId) {
  return db
    .from('timesheet_pinned_gigs')
    .insert({ user_id: userId, gig_id: gigId })
}

export async function unpinGig(db, userId, gigId) {
  return db
    .from('timesheet_pinned_gigs')
    .delete()
    .eq('user_id', userId)
    .eq('gig_id', gigId)
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
