/**
 * task_index.js — Vidai to Mulai · Task Register
 * Cross-gig view of gig_tasks — the "low visibility into status changes"
 * problem is solved by putting the parent gig's pipeline stage directly
 * on every row.
 *
 * Modelled directly on gig_index.js's filter-bar pattern (Scope / Stage /
 * Project / Lead / Doer selects), with one task-specific addition:
 * "Assigned To" (Lead vs Doer, per-task — distinct from the gig's own
 * Lead/Doer).
 *
 * Table only for now, no card view — gig_index's table→card switch isn't
 * carried over here; a task list reads fine as a dense table on its own.
 *
 * Lead/Doer filter options are scoped to whoever actually appears on
 * tasks this person can see — never the full org roster — for
 * pacer/rover. Admins still get the full roster, since they see every
 * task anyway. Same fix as gig_index.js's populateLeadDoerOptions().
 *
 * Permission rules (who can toggle/reassign/delete a given task) are not
 * reimplemented here — canManageTask()/canToggleTask() are imported
 * straight from gig_tasks.js, same source of truth create_gig.html uses.
 */

import { db }                                        from './vtm_db.js'
import { fetchAllTasksWithGigContext, toggleTaskDone,
         updateTask, deleteTask, fetchActiveLeads,
         fetchActiveDoers, fetchUsersByIds,
         fmtDate, esc }                               from './vtm_api.js'
import { canManageTask, canToggleTask }               from './gig_tasks.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

const role     = session.role
const myUserId = session.user_id

// ── STATE ─────────────────────────────────────────────────────────────────

let allTasks = []   // raw + enriched, role-filtered — everything downstream reads from this

let scopeId      = 'open'   // 'open' | 'done' | 'all'
let stageId      = ''       // gig status, or '' for any
let projectId    = ''
let leadId       = ''
let doerId       = ''
let assignedRole = ''       // '' | 'pacer' (Lead) | 'rover' (Doer)

const statusEl   = document.getElementById('dbStatus')
const subtitleEl = document.getElementById('registerSubtitle')
const summaryEl  = document.getElementById('filterSummary')
const tbody      = document.getElementById('taskTableBody')

const scopeSelect    = document.getElementById('scopeSelect')
const stageSelect    = document.getElementById('stageSelect')
const projectSelect  = document.getElementById('projectSelect')
const leadSelect     = document.getElementById('leadSelect')
const doerSelect     = document.getElementById('doerSelect')
const assignedSelect = document.getElementById('assignedSelect')

subtitleEl.textContent = role === 'admin' ? 'All tasks' : `Your tasks · ${session.name}`

// ── LOAD ──────────────────────────────────────────────────────────────────

async function loadTasks() {
  const { data, error } = await fetchAllTasksWithGigContext(db)

  if (error) {
    statusEl.textContent = 'Could not connect — ' + error.message
    statusEl.className   = 'db-status err'
    return
  }

  // Role filter — a task is visible if its gig belongs to this person
  // (Lead on gig.pacer_id, Doer on gig.rover_id), OR — for Doers only —
  // the task itself is assigned to them even on a gig they don't own,
  // per the "full view on tasks assigned to them" rule.
  let visible = data || []
  visible = visible.filter(t => t.gigs) // orphaned tasks (gig deleted) shouldn't appear

  if (role === 'pacer') {
    visible = visible.filter(t => t.gigs.pacer_id === myUserId)
  } else if (role === 'rover') {
    visible = visible.filter(t => t.gigs.rover_id === myUserId || t.assigned_to === myUserId)
  }

  allTasks = visible.map(enrichTask)

  populateProjectOptions()
  await populateLeadDoerOptions()
  render()
}

// Admins get the full org roster (they see every task anyway, so the
// dropdown wouldn't hide anything by scoping it). Pacer/rover only see
// the Leads/Doers that actually appear on tasks visible to them — a
// Doer shouldn't be offered every Lead in the company as a filter, only
// the ones whose gigs they actually work on.
async function populateLeadDoerOptions() {
  if (role === 'admin') {
    const [leadsRes, doersRes] = await Promise.all([fetchActiveLeads(db), fetchActiveDoers(db)])
    leadSelect.innerHTML = '<option value="">Lead</option>' +
      (leadsRes.data || []).map(u => `<option value="${u.user_id}">${esc(u.name)}</option>`).join('')
    doerSelect.innerHTML = '<option value="">Doer</option>' +
      (doersRes.data || []).map(u => `<option value="${u.user_id}">${esc(u.name)}</option>`).join('')
  } else {
    const leadIds = new Set()
    const doerIds = new Set()
    allTasks.forEach(t => {
      if (t.gigs?.pacer_id) leadIds.add(t.gigs.pacer_id)
      if (t.gigs?.rover_id) doerIds.add(t.gigs.rover_id)
    })

    const { data: users } = await fetchUsersByIds(db, [...leadIds, ...doerIds])
    const nameById = {}
    ;(users || []).forEach(u => { nameById[u.user_id] = u.name })

    leadSelect.innerHTML = '<option value="">Lead</option>' +
      Array.from(leadIds).map(id => `<option value="${id}">${esc(nameById[id] || '—')}</option>`).join('')
    doerSelect.innerHTML = '<option value="">Doer</option>' +
      Array.from(doerIds).map(id => `<option value="${id}">${esc(nameById[id] || '—')}</option>`).join('')
  }

  leadSelect.value = leadId
  doerSelect.value = doerId

  // Already self-scoped by role filter above — the dropdown would just
  // be a one-item no-op, so disable it rather than leave it misleading.
  if (role === 'pacer') { leadSelect.disabled = true; leadSelect.style.opacity = '0.4' }
  if (role === 'rover') { doerSelect.disabled = true; doerSelect.style.opacity = '0.4' }
}

function populateProjectOptions() {
  const seen = new Map()
  allTasks.forEach(t => {
    const g = t.gigs
    if (g?.project_id && g.projects?.project_code && !seen.has(g.project_id)) {
      seen.set(g.project_id, g.projects.project_code)
    }
  })

  const current = projectSelect.value
  projectSelect.innerHTML = '<option value="">Project</option>' +
    Array.from(seen.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, code]) => `<option value="${id}">${esc(code)}</option>`)
      .join('')
  projectSelect.value = current || projectId || ''
}

// ── ENRICHMENT ───────────────────────────────────────────────────────────

function enrichTask(t) {
  const g = t.gigs || {}
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const due   = g.date_due ? new Date(g.date_due) : null
  if (due) due.setHours(0, 0, 0, 0)

  const isOverdue = !!due && due < today && !t.done && g.status !== 'completed'

  return { ...t, _isOverdue: isOverdue }
}

// ── RENDER ────────────────────────────────────────────────────────────────

function render() {
  let visible = allTasks

  if (scopeId === 'open') visible = visible.filter(t => !t.done)
  if (scopeId === 'done') visible = visible.filter(t => t.done)

  if (stageId)   visible = visible.filter(t => t.gigs.status === stageId)
  if (projectId) visible = visible.filter(t => t.gigs.project_id === projectId)
  if (leadId)    visible = visible.filter(t => t.gigs.pacer_id === leadId)
  if (doerId)    visible = visible.filter(t => t.gigs.rover_id === doerId)

  if (assignedRole === 'pacer') visible = visible.filter(t => t.assigned_to === t.gigs.pacer_id)
  if (assignedRole === 'rover') visible = visible.filter(t => t.assigned_to === t.gigs.rover_id)

  visible = sortTasks(visible)

  statusEl.textContent = `● Connected · ${visible.length} task${visible.length !== 1 ? 's' : ''}`
  statusEl.className   = 'db-status ok'

  renderSummary(visible.length)
  renderTable(visible)
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const dueA = a.gigs.date_due, dueB = b.gigs.date_due
    if (!dueA && !dueB) return 0
    if (!dueA) return 1
    if (!dueB) return -1
    return new Date(dueA) - new Date(dueB)
  })
}

function renderSummary(count) {
  const parts = []
  if (scopeId !== 'open') parts.push(scopeId === 'done' ? 'Done' : 'All')
  if (stageId)   parts.push(fmtStatus(stageId))
  if (assignedRole) parts.push(assignedRole === 'pacer' ? 'Assigned: Lead' : 'Assigned: Doer')
  if (projectId) {
    const opt = Array.from(projectSelect.options).find(o => o.value === projectId)
    if (opt) parts.push(opt.textContent)
  }
  if (leadId) {
    const opt = Array.from(leadSelect.options).find(o => o.value === leadId)
    if (opt) parts.push(opt.textContent)
  }
  if (doerId) {
    const opt = Array.from(doerSelect.options).find(o => o.value === doerId)
    if (opt) parts.push(opt.textContent)
  }

  summaryEl.textContent = parts.length
    ? `${parts.join(' + ')} · ${count} task${count !== 1 ? 's' : ''}`
    : `${count} task${count !== 1 ? 's' : ''}`
}

function renderTable(visible) {
  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No tasks match these filters.</div></td></tr>`
    return
  }

  tbody.innerHTML = visible.map(renderRow).join('')
}

function renderRow(t) {
  const g       = t.gigs
  const projCode = g.projects?.project_code || '—'
  const isLead   = t.assigned_to === g.pacer_id
  const roleLabel = isLead ? 'Lead' : (t.assigned_to === g.rover_id ? 'Doer' : '—')

  const manage = canManageTask(t, session, g)
  const toggle = canToggleTask(t, session, g)

  const checkAttr = toggle
    ? `onchange="toggleTaskRow('${t.task_id}', this.checked)"`
    : 'disabled'

  const assigneeEl = toggle
    ? `<button type="button" class="task-assignee-pill${isLead ? ' lead' : ''}" onclick="reassignTaskRow('${t.task_id}')" title="Click to reassign">${roleLabel}</button>`
    : `<span class="task-assignee-pill${isLead ? ' lead' : ''}">${roleLabel}</span>`

  const delBtn = manage
    ? `<button type="button" class="task-btn task-btn-danger" onclick="deleteTaskRow('${t.task_id}','${esc(t.title)}')" title="Delete task">×</button>`
    : ''

  const dueColor = t._isOverdue ? 'var(--red)' : 'var(--stone)'
  const dueWeight = t._isOverdue ? ';font-weight:600' : ''

  return `
    <tr>
      <td>
        <a href="create_gig.html?gig_id=${g.gig_id}" class="task-gig-link">${esc(g.gig_code || '—')}</a>
        <div class="task-gig-proj">${esc(projCode)}</div>
      </td>
      <td class="${t.done ? 'task-title-done' : ''}">${esc(t.title)}</td>
      <td><span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span></td>
      <td style="color:${dueColor};font-size:12px${dueWeight}">${fmtDate(g.date_due)}</td>
      <td>${assigneeEl}</td>
      <td style="text-align:center"><input type="checkbox" class="task-check" ${t.done ? 'checked' : ''} ${checkAttr}></td>
      <td>${delBtn}</td>
    </tr>`
}

// ── QUICK ACTIONS ─────────────────────────────────────────────────────────

window.toggleTaskRow = async function(taskId, done) {
  const { error } = await toggleTaskDone(db, taskId, done)
  if (error) { showToast('Could not update task', 'err'); return }
  const t = allTasks.find(x => x.task_id === taskId)
  if (t) t.done = done
  allTasks = allTasks.map(enrichTask)
  render()
}

window.reassignTaskRow = async function(taskId) {
  const t = allTasks.find(x => x.task_id === taskId)
  if (!t) return
  const g = t.gigs
  const newAssignee = t.assigned_to === g.pacer_id ? g.rover_id : g.pacer_id

  const { error } = await updateTask(db, taskId, { assigned_to: newAssignee })
  if (error) { showToast('Could not reassign task', 'err'); return }
  t.assigned_to = newAssignee
  render()
}

window.deleteTaskRow = async function(taskId, title) {
  if (!confirm(`Delete task "${title}"?`)) return
  const { error } = await deleteTask(db, taskId)
  if (error) { showToast('Could not delete task', 'err'); return }
  allTasks = allTasks.filter(x => x.task_id !== taskId)
  render()
}

// ── FILTER BAR INTERACTIONS ─────────────────────────────────────────────

scopeSelect.addEventListener('change',    () => { scopeId      = scopeSelect.value;    render() })
stageSelect.addEventListener('change',    () => { stageId      = stageSelect.value;    render() })
projectSelect.addEventListener('change',  () => { projectId    = projectSelect.value;  render() })
leadSelect.addEventListener('change',     () => { leadId       = leadSelect.value;     render() })
doerSelect.addEventListener('change',     () => { doerId       = doerSelect.value;     render() })
assignedSelect.addEventListener('change', () => { assignedRole = assignedSelect.value; render() })

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadTasks()
