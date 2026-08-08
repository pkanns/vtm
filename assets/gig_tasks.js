/**
 * gig_tasks.js — Vidai to Mulai · Gig Tasks
 * Pure logic + shared row rendering — no DB calls here (those live in
 * vtm_api.js, as usual). Used by:
 *   - create_gig.js   → full management view (add/edit/reassign/delete)
 *   - project_index.js → lightweight check-off view, no manage controls
 *
 * Permission model (agreed):
 *   - Whoever created the task (Lead or Doer) → full control
 *   - The gig's Lead (pacer_id) → full control, even on tasks they
 *     didn't create — consistent with Leads having broad rights
 *     everywhere else on their own gigs
 *   - Admin → full control, always
 *   - Everyone else who's part of the gig (typically: a Doer on a task
 *     they didn't create) → toggle complete/incomplete only
 */

export function canManageTask(task, session, gig) {
  if (session.role === 'admin') return true
  if (session.role === 'pacer' && gig.pacer_id === session.user_id) return true
  if (task.created_by === session.user_id) return true
  return false
}

export function canToggleTask(task, session, gig) {
  if (canManageTask(task, session, gig)) return true
  return gig.pacer_id === session.user_id || gig.rover_id === session.user_id
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function assigneeLabel(task, gig, names) {
  if (task.assigned_to === gig.pacer_id) return { role: 'Lead', name: names.pacerName || '—' }
  if (task.assigned_to === gig.rover_id) return { role: 'Doer', name: names.roverName || '—' }
  return { role: '—', name: '—' }
}

// ── ROW RENDERING ─────────────────────────────────────────────────────────

/**
 * Full task row — gig edit form. Checkbox, title, assignee pill, and
 * (when permitted) a reassign toggle + delete button.
 * Expects window.toggleGigTask / window.reassignGigTask / window.deleteGigTask
 * to be defined by the page using this — same convention as the rest of
 * the codebase (onclick handlers referencing window-level functions).
 */
export function renderTaskRowFull(task, session, gig, names) {
  const manage = canManageTask(task, session, gig)
  const toggle = canToggleTask(task, session, gig)
  const { role, name } = assigneeLabel(task, gig, names)

  return `
    <div class="task-row${task.done ? ' task-done' : ''}" data-task-id="${task.task_id}">
      <input type="checkbox" class="task-check" ${task.done ? 'checked' : ''}
        ${toggle ? `onchange="toggleGigTask('${task.task_id}', this.checked)"` : 'disabled'}>
      <span class="task-title">${esc(task.title)}</span>
      <span class="task-assignee-pill">${role} · ${esc(name)}</span>
      ${manage ? `
        <button type="button" class="task-btn" onclick="reassignGigTask('${task.task_id}')">Reassign</button>
        <button type="button" class="task-btn task-btn-danger" onclick="deleteGigTask('${task.task_id}')">×</button>
      ` : ''}
    </div>`
}

/**
 * Lightweight task row — Project Index gig panel. Checkbox + title +
 * assignee only, no manage controls, even for people who could manage it
 * from the gig form — this view is deliberately read/check-off only.
 * Expects window.toggleGigTaskLight(taskId, done, gigId) to be defined.
 */
export function renderTaskRowLight(task, session, gig, names) {
  const toggle = canToggleTask(task, session, gig)
  const { name } = assigneeLabel(task, gig, names)

  return `
    <div class="task-row-light${task.done ? ' task-done' : ''}" data-task-id="${task.task_id}">
      <input type="checkbox" class="task-check" ${task.done ? 'checked' : ''}
        ${toggle ? `onchange="toggleGigTaskLight('${task.task_id}', this.checked, '${gig.gig_id}')"` : 'disabled'}>
      <span class="task-title">${esc(task.title)}</span>
      <span class="task-assignee-mini">${esc(name)}</span>
    </div>`
}
