/**
 * gig_actions.js — Vidai to Mulai · Shared Gig Actions Menu
 * The "⋯" menu that replaces the growing row of separate buttons
 * (Edit / Evaluate / Move to next / Create Instance / Delete) that used
 * to sit next to every gig. One component, used by gig_index.html's
 * table AND card view, and by project_index.html's gig table — so the
 * declutter happens once instead of three times.
 *
 * Expects these globals to already exist on the page using it (same
 * convention as gig_tasks.js / vtm_cards.js):
 *   window.editGig(id)
 *   window.goToEval(id)
 *   window.deleteGigRow(id, code)
 * Both gig_index.js and project_index.js already define these.
 *
 * createFromTemplate() and advanceGigStage() are defined here, once, and
 * shared by both pages — each dispatches on success rather than knowing
 * how to refresh either page's own list:
 *   - createFromTemplate() navigates away (to the new instance), so no
 *     refresh signal is needed.
 *   - advanceGigStage() stays on the page, so it fires a
 *     'vtm:gig-status-changed' window event; each page listens for that
 *     and re-runs its own load function.
 *
 * MASTER GIGS: a "master" gig is any recurring gig with no parent
 * (cadence:'recurring' && !parent_gig_id) — covers both true adhoc
 * templates and normal scheduled (weekly/fortnightly/monthly) recurring
 * parents. Masters are never worked directly, only their spawned
 * instances are, so they never get a stage-advance or Evaluate action —
 * they stay pinned at Placed everywhere in the app. Only true adhoc
 * templates (a further subset of masters) get the manual "Create
 * Instance" action; scheduled recurring parents spawn their instances
 * automatically via the daily cron instead.
 */

import { db }                                    from './vtm_db.js'
import { updateGigStatus, spawnAdhocInstance, esc } from './vtm_api.js'

// ── STAGE ADVANCE MAP ────────────────────────────────────────────────────
// Deliberately stops at 'delivered' — going from delivered to completed
// only ever happens through gig_eval.js alongside an actual evaluation
// being saved. A one-click status bump here would let a gig reach
// 'completed' with no evaluation on record, which breaks the whole
// reflection step the app is built around. A 'delivered' gig gets an
// Evaluate action instead of a "move to next" one below.
const NEXT_STAGE = {
  placed:      { to: 'matched',     label: 'Assign'         },
  matched:     { to: 'aligned',     label: 'Approve'        },
  aligned:     { to: 'in_progress', label: 'Deliver'        },
  in_progress: { to: 'delivered',   label: 'Mark Delivered' },
}

function fmtStatusLabel(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── MENU CONTENT ──────────────────────────────────────────────────────────
// variant: 'row' (default, inline in a table cell) or 'card' (absolute-
// positioned to the card's top-right corner via .gaction-card-anchor —
// see vtm_2.css).

export function renderActionsMenu(gig, session, { variant = 'row' } = {}) {
  const role       = session?.role || null
  const isMaster   = gig.cadence === 'recurring' && !gig.parent_gig_id
  const isTemplate = isMaster && gig.recurrence_frequency === 'adhoc'

  const items = []

  if (role !== 'rover') {
    items.push(`<button type="button" class="gaction-item" onclick="editGig('${gig.gig_id}')">Edit</button>`)
  }

  // Master gigs never advance through the pipeline — they stay Placed.
  const advance = NEXT_STAGE[gig.status]
  if (advance && role !== 'rover' && !isMaster) {
    items.push(`<button type="button" class="gaction-item" onclick="advanceGigStage('${gig.gig_id}','${gig.status}')">${advance.label} →</button>`)
  }

  if (!isMaster && ['in_progress', 'delivered'].includes(gig.status)) {
    items.push(`<button type="button" class="gaction-item" onclick="goToEval('${gig.gig_id}')">Evaluate →</button>`)
  }

  if (isTemplate && role !== 'rover') {
    items.push(`<button type="button" class="gaction-item" onclick="createFromTemplate(this,'${gig.gig_id}','${esc(gig.gig_code)}')">Create Instance</button>`)
  }

  if (role === 'admin') {
    items.push(`<button type="button" class="gaction-item danger" onclick="deleteGigRow('${gig.gig_id}','${esc(gig.gig_code)}')">Delete</button>`)
  }

  if (!items.length) return ''

  const anchorClass = variant === 'card' ? ' gaction-card-anchor' : ''

  return `
    <div class="gaction-wrap${anchorClass}" onclick="event.stopPropagation()">
      <button type="button" class="gaction-trigger" onclick="toggleGigActions(this)">⋯</button>
      <div class="gaction-menu">${items.join('')}</div>
    </div>`
}

// ── OPEN / CLOSE ──────────────────────────────────────────────────────────

window.toggleGigActions = function(btn) {
  const menu    = btn.nextElementSibling
  const wasOpen = menu.classList.contains('open')
  document.querySelectorAll('.gaction-menu.open').forEach(m => m.classList.remove('open'))
  if (!wasOpen) menu.classList.add('open')
}

document.addEventListener('click', () => {
  document.querySelectorAll('.gaction-menu.open').forEach(m => m.classList.remove('open'))
})

// ── ADVANCE STAGE ─────────────────────────────────────────────────────────

window.advanceGigStage = async function(gigId, currentStatus) {
  const step = NEXT_STAGE[currentStatus]
  if (!step) return

  const { error } = await updateGigStatus(db, gigId, step.to)

  if (error) {
    showToast('Could not update status — ' + error.message, 'err')
    return
  }

  showToast(`Moved to ${fmtStatusLabel(step.to)}`, 'ok')
  window.dispatchEvent(new CustomEvent('vtm:gig-status-changed', { detail: { gigId, newStatus: step.to } }))
}

// ── CREATE INSTANCE FROM TEMPLATE ──────────────────────────────────────
// btn can be a small row/menu button OR an entire clicked card — rather
// than mutating textContent (which would wreck a card's nested markup),
// this just dims + disables pointer events on whatever was clicked, so
// it works the same regardless of what "btn" actually is.

window.createFromTemplate = async function(btn, gigId, code) {
  if (btn) { btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6' }

  const { data, error } = await spawnAdhocInstance(db, gigId)

  if (error || !data) {
    showToast('Could not create instance — ' + (error?.message || 'unknown error'), 'err')
    if (btn) { btn.style.pointerEvents = ''; btn.style.opacity = '' }
    return
  }

  showToast(`${data.gig_code} created from ${code}`, 'ok')
  window.location.href = `create_gig.html?gig_id=${data.gig_id}`
}
