/**
 * project_index.js — Vidai to Mulai · Project Index
 * Loads all projects with nested gigs.
 * Role-aware: rovers see only gigs assigned to them.
 * Each gig row expands (click) into a lazy-loaded, read/check-off task
 * checklist — fetched only the first time that row is opened, so the
 * initial project list load stays as fast as it was before tasks existed.
 */

import { db }                    from './vtm_db.js'
import { fetchProjectsWithGigs,
         fetchCategoriesByProject,
         deleteProject,
         deleteGig,
         fetchTasksByGig,
         fetchUsersByIds,
         toggleTaskDone,
         fmtDate, esc }          from './vtm_api.js'
import { renderTaskRowLight }    from './gig_tasks.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()

if (!session) {
  window.location.href = 'login.html'
  throw new Error('No session')
}

const role     = session.role
const myUserId = session.user_id

if (role === 'rover') {
  document.getElementById('newProjectBtn')?.remove()
}

// ── STATE ─────────────────────────────────────────────────────────────────

let allProjects = []
const loadedTaskGigIds = new Set()   // gigs whose task panel has already been fetched once

// ── LOAD ──────────────────────────────────────────────────────────────────

async function loadProjects() {
  const statusEl = document.getElementById('dbStatus')
  statusEl.textContent = 'Connecting…'
  statusEl.className   = 'db-status'

  const { data, error } = await fetchProjectsWithGigs(db)

  if (error) {
    statusEl.textContent = 'Could not connect — ' + error.message
    statusEl.className   = 'db-status err'
    return
  }

  allProjects = data || []

  // Role filter — rovers only see their own gigs
  if (role === 'rover') {
    allProjects = allProjects.map(p => ({
      ...p,
      gigs: p.gigs.filter(g => g.rover_id === myUserId)
    })).filter(p => p.gigs.length > 0)
  }

  const totalGigs = allProjects.reduce((s, p) => s + p.gigs.length, 0)

  statusEl.textContent = `● ${allProjects.length} project${allProjects.length !== 1 ? 's' : ''} · ${totalGigs} gig${totalGigs !== 1 ? 's' : ''}`
  statusEl.className   = 'db-status ok'

  renderProjects()
}

// ── RENDER ────────────────────────────────────────────────────────────────

function renderProjects() {
  const container = document.getElementById('projectsContainer')

  if (!allProjects.length) {
    container.innerHTML = `
      <div style="background:var(--white);padding:48px;text-align:center;color:var(--stone);font-size:13px;">
        No projects yet —
        ${role !== 'rover' ? '<a href="create_project.html" style="color:var(--red);text-decoration:none;">create one</a>' : 'ask your admin to create a project'}
      </div>`
    return
  }

  container.innerHTML = allProjects.map(p => renderProjectCard(p)).join('')
}

function renderProjectCard(p) {
  const catCodes  = [...new Set(p.gigs.map(g =>
    g.project_categories?.category_code).filter(Boolean))]
  const gigCount  = p.gigs.length
  const catPills  = catCodes.map(c => `<span class="cat-pill">${esc(c)}</span>`).join('')

  const editBtn   = role !== 'rover'
    ? `<button class="tbl-btn" onclick="editProject('${p.project_id}')">Edit</button>`
    : ''
  const deleteBtn = role === 'admin'
    ? `<button class="tbl-btn danger" onclick="deleteProjectRow('${p.project_id}','${esc(p.project_code)}')">Delete</button>`
    : ''

  return `
    <div class="project-card" id="proj-${p.project_id}">
      <div class="project-row" onclick="toggleProject('proj-${p.project_id}')">
        <div class="project-code">${esc(p.project_code)}</div>
        <div>
          <div class="project-name">${esc(p.project_name)}</div>
          ${p.description ? `<div class="project-desc">${esc(p.description)}</div>` : ''}
          ${catPills ? `<div class="cat-list">${catPills}</div>` : ''}
        </div>
        <div class="project-meta">
          <span class="project-gig-count">${gigCount} gig${gigCount !== 1 ? 's' : ''}</span>
          ${editBtn}
          ${deleteBtn}
          <span class="expand-arrow">›</span>
        </div>
      </div>
      <div class="gig-panel">
        <div class="gig-panel-header">
          <span class="gig-panel-label">Gigs — ${esc(p.project_code)}</span>
          ${role !== 'rover'
            ? `<a href="create_gig.html?project_id=${p.project_id}" class="btn-secondary btn-sm">+ New Gig</a>`
            : ''}
        </div>
        ${renderGigTable(p)}
      </div>
    </div>`
}

function renderGigTable(p) {
  if (!p.gigs.length) {
    return `<div class="empty-gigs">No gigs yet —
      ${role !== 'rover'
        ? `<a href="create_gig.html?project_id=${p.project_id}">create one</a>`
        : 'no gigs assigned to you in this project'}
    </div>`
  }

  // Separate parents and instances
  const parents   = p.gigs.filter(g => !g.parent_gig_id)
  const instances = p.gigs.filter(g =>  g.parent_gig_id)

  // Build rows — parents first, instances indented below their parent
  const rows = []
  parents.forEach(g => {
    rows.push(renderGigRow(g, false))
    const childInstances = instances.filter(i => i.parent_gig_id === g.gig_id)
    childInstances.forEach(i => rows.push(renderGigRow(i, true)))
  })

  return `
    <table class="gig-table">
      <thead>
        <tr>
          <th>Code</th>
          <th>Title</th>
          <th>Category</th>
          <th>Cadence</th>
          <th>Status</th>
          <th>Due</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows.join('')}</tbody>
    </table>`
}

function renderGigRow(g, isInstance) {
  const catCode  = g.project_categories?.category_code || '—'
  const isRecurParent = g.cadence === 'recurring' && !g.parent_gig_id
  const rowStyle = isInstance
    ? 'background:rgba(181,32,26,0.015)'
    : isRecurParent ? 'background:rgba(181,32,26,0.025)' : ''

  const codeStyle = isInstance
    ? 'padding-left:28px;color:var(--stone)'
    : ''

  const cadenceBadge = isInstance
    ? `<span class="gig-type-badge instance">Instance</span>`
    : g.cadence === 'recurring'
      ? `<span class="gig-type-badge R">Recurring</span>`
      : `<span class="gig-type-badge O">One-off</span>`

  const editBtn = role !== 'rover'
    ? `<button class="tbl-btn" onclick="editGig('${g.gig_id}')">Edit</button>`
    : ''

  const evalBtn = ['in_progress','delivered'].includes(g.status)
    ? `<button class="tbl-btn" onclick="goToEval('${g.gig_id}')">Evaluate</button>`
    : ''

  const deleteBtn = role === 'admin'
    ? `<button class="tbl-btn danger" onclick="deleteGigRow('${g.gig_id}','${esc(g.gig_code)}')">Delete</button>`
    : ''

  return `
    <tr style="${rowStyle}" class="gig-row-clickable" onclick="toggleGigTasks('${g.gig_id}')">
      <td class="gig-code-cell" style="${codeStyle}">${esc(g.gig_code)}</td>
      <td style="${isInstance ? 'color:var(--mid)' : ''}">${esc(g.title)}</td>
      <td><span class="cat-tag">${esc(catCode)}</span></td>
      <td>${cadenceBadge}</td>
      <td><span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span></td>
      <td style="color:var(--stone);font-size:11px">${fmtDate(g.date_due)}</td>
      <td style="white-space:nowrap" onclick="event.stopPropagation()">${editBtn}${evalBtn}${deleteBtn}</td>
    </tr>
    <tr class="task-subrow" id="tasksRow-${g.gig_id}" style="display:none">
      <td colspan="7"><div class="task-list-inline" id="taskListInline-${g.gig_id}"></div></td>
    </tr>`
}

// ── TASK CHECKLIST (lazy-loaded per gig row) ───────────────────────────────

function findGigById(gigId) {
  for (const p of allProjects) {
    const g = p.gigs.find(x => x.gig_id === gigId)
    if (g) return g
  }
  return null
}

window.toggleGigTasks = async function(gigId) {
  const row = document.getElementById(`tasksRow-${gigId}`)
  if (!row) return

  const isHidden = row.style.display === 'none'
  row.style.display = isHidden ? 'table-row' : 'none'

  if (isHidden && !loadedTaskGigIds.has(gigId)) {
    loadedTaskGigIds.add(gigId)
    await loadTasksForGigRow(gigId)
  }
}

async function loadTasksForGigRow(gigId) {
  const container = document.getElementById(`taskListInline-${gigId}`)
  const gig = findGigById(gigId)
  if (!container || !gig) return

  container.innerHTML = '<div class="tasks-empty">Loading…</div>'

  const [taskRes, userRes] = await Promise.all([
    fetchTasksByGig(db, gigId),
    fetchUsersByIds(db, [gig.pacer_id, gig.rover_id]),
  ])

  if (taskRes.error) {
    container.innerHTML = '<div class="tasks-empty">Could not load tasks.</div>'
    return
  }

  const nameById = {}
  ;(userRes.data || []).forEach(u => { nameById[u.user_id] = u.name })
  const names = {
    pacerName: nameById[gig.pacer_id] || '—',
    roverName: nameById[gig.rover_id] || '—',
  }

  const tasks = taskRes.data || []
  if (!tasks.length) {
    container.innerHTML = '<div class="tasks-empty">No tasks on this gig yet — add one from the gig edit page.</div>'
    return
  }

  container.innerHTML = tasks.map(t => renderTaskRowLight(t, session, gig, names)).join('')
}

window.toggleGigTaskLight = async function(taskId, done, gigId) {
  const { error } = await toggleTaskDone(db, taskId, done)
  if (error) { showToast('Could not update task', 'err'); return }
  // Re-render just this gig's inline list so state stays current.
  await loadTasksForGigRow(gigId)
}

// ── TOGGLE ACCORDION ──────────────────────────────────────────────────────

window.toggleProject = function(id) {
  document.getElementById(id)?.classList.toggle('expanded')
}

// ── ACTIONS ───────────────────────────────────────────────────────────────

window.editProject = function(id) {
  window.location.href = `create_project.html?project_id=${id}`
}

window.editGig = function(id) {
  window.location.href = `create_gig.html?gig_id=${id}`
}

window.goToEval = function(id) {
  window.location.href = `gig_eval.html?gig_id=${id}`
}

window.deleteGigRow = async function(id, code) {
  if (role !== 'admin') { showToast('Only admins can delete gigs', 'err'); return }
  if (!confirm(`Delete gig "${code}"? This cannot be undone.`)) return
  const { error } = await deleteGig(db, id)
  if (error) { showToast('Delete failed: ' + error.message, 'err'); return }
  showToast(`${code} deleted`, 'ok')
  loadProjects()
}

window.deleteProjectRow = async function(id, code) {
  if (role !== 'admin') { showToast('Only admins can delete projects', 'err'); return }
  if (!confirm(`Delete project "${code}" and ALL its gigs? This cannot be undone.`)) return
  const { error } = await deleteProject(db, id)
  if (error) { showToast('Delete failed: ' + error.message, 'err'); return }
  showToast(`${code} deleted`, 'ok')
  loadProjects()
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadProjects()
