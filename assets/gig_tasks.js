/**
 * gig_tasks.js — Vidai to Mulai · Gig Tasks
 * Pure logic + row rendering — no DB calls here (those live in
 * vtm_api.js). Used by create_gig.js today; if another page wants the
 * same checklist view later, import from here rather than duplicating.
 *
 * Permission model:
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

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Option C — "Compact Register Strip" row: checkbox / title / assignee
 * badge / delete. Expects window.toggleGigTask / reassignGigTask /
 * deleteGigTask to be defined by the page using this (same convention
 * as the rest of the codebase — onclick handlers referencing
 * window-level functions rather than closures).
 *
 * The assignee badge doubles as the reassign control — clicking "Doer"
 * or "Lead" flips it — shown as a button only for whoever has manage
 * rights on this task; everyone else sees it as a plain label. There's
 * no separate reassign button, to keep the row as dense as designed.
 */
export function renderTaskCellCompact(task, session, gig, names) {
  const manage = canManageTask(task, session, gig)
  const toggle = canToggleTask(task, session, gig)
  const isLead = task.assigned_to === gig.pacer_id
  const roleLabel = isLead ? 'Lead' : (task.assigned_to === gig.rover_id ? 'Doer' : '—')

  const checkAttr = toggle
    ? `onchange="toggleGigTask('${task.task_id}', this.checked)"`
    : 'disabled'

  const assigneeEl = manage
    ? `<button type="button" class="gtask-assignee${isLead ? ' lead' : ''}" onclick="reassignGigTask('${task.task_id}')" title="Click to reassign">${roleLabel}</button>`
    : `<span class="gtask-assignee${isLead ? ' lead' : ''}">${roleLabel}</span>`

  const delBtn = manage
    ? `<button type="button" class="gtask-del" onclick="deleteGigTask('${task.task_id}')" title="Delete task">×</button>`
    : `<span></span>`

  return `
    <div class="gtask-cell${task.done ? ' done' : ''}" data-task-id="${task.task_id}">
      <input type="checkbox" class="gtask-check" ${task.done ? 'checked' : ''} ${checkAttr}>
      <span class="gtask-title">${esc(task.title)}</span>
      ${assigneeEl}
      ${delBtn}
    </div>`
}
