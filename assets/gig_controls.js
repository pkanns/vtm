/**
 * gig_controls.js · Vidai to Mulai · Gig Controls
 * Replaces gig_lifecycle.html (freeze / kill) and time_recording_gigs.html
 * (pin) with one sheet and a checkbox column per category.
 *
 * WHO SEES WHAT
 *   Everyone  -> Pinned column. Pinning is per person and self-managed,
 *                auto-saves on toggle, over the gigs that person can
 *                clock time to (fetchClockableGigs, same as Timesheet).
 *   Admin     -> also Frozen + Killed columns, the Projects block with
 *                bulk Freeze/Kill, and masters/frozen/killed rows.
 *
 * RULES (unchanged from the two old pages)
 *   Pinned  Only on live gigs: not a master, not frozen, not killed.
 *   Frozen  Reversible. Check = freeze (reason optional), uncheck =
 *           unfreeze. Never touches gigs.status.
 *   Killed  One way through the UI. Check = reason required, sets
 *           gigs.status = 'completed' and writes a 'killed' lifecycle
 *           row. The box then locks. Un-killing is a manual SQL job.
 *   A killed gig can't also be frozen, so its Frozen box locks too.
 *
 * A cancelled modal simply re-renders, which puts the checkbox back to
 * its real saved state.
 */

import { db } from './vtm_db.js'
import { fetchLifecycleGigs, freezeGig, unfreezeGig, killGig,
         freezeProjectGigs, killProjectGigs, fetchLifecycleReasons,
         fetchClockableGigs, fetchPinnedGigIds, pinGig, unpinGig,
         fetchProjects, fmtDate, esc } from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }

const role    = session.role
const userId  = session.user_id
const isAdmin = role === 'admin'
if (isAdmin) document.body.classList.add('is-admin')

// ── STATE (declared before init, see timesheet.js history on why) ────────

let allGigs       = []     // every row shown: { ...gig, lifecycle: row|null }
let pinnedIds     = new Set()
let projectCodes  = {}     // project_id -> project_code
let searchTerm    = ''
let filterId      = 'open'
let pendingAction = null   // { kind: 'freeze'|'kill'|'freezeProject'|'killProject', id, code, openCount? }

// ── DERIVED FLAGS ─────────────────────────────────────────────────────────

const isMaster = g => g.cadence === 'recurring' && !g.parent_gig_id
const isFrozen = g => g.lifecycle?.state === 'frozen'
const isKilled = g => g.lifecycle?.state === 'killed'
const isPinned = g => pinnedIds.has(g.gig_id)
// Same definition as fetchClockableGigs(): live, not a master, not frozen/killed
const isPinnable = g => g.status !== 'completed' && !isMaster(g) && !isFrozen(g) && !isKilled(g)

// ── LOAD ──────────────────────────────────────────────────────────────────

async function load() {
  const statusEl = $id('dbStatus')
  statusEl.textContent = 'Loading…'
  statusEl.className = 'db-status'

  const [gigsRes, pinsRes, projRes] = await Promise.all([
    isAdmin
      ? fetchLifecycleGigs(db)   // admin: every open gig, masters included, plus killed
      : fetchClockableGigs(db, role, userId).then(r => ({ data: (r.data || []).map(g => ({ ...g, lifecycle: null })), error: r.error })),
    fetchPinnedGigIds(db, userId),
    fetchProjects(db),
  ])

  if (gigsRes.error) {
    statusEl.textContent = 'Could not load gigs: ' + gigsRes.error.message
    statusEl.className = 'db-status err'
    return
  }

  allGigs   = gigsRes.data || []
  pinnedIds = new Set((pinsRes.data || []).map(r => r.gig_id))
  projectCodes = {}
  ;(projRes.data || []).forEach(p => { projectCodes[p.project_id] = p.project_code })

  render()
}

async function loadReasons() {
  const { data, error } = await fetchLifecycleReasons(db)
  if (error) return   // suggestions are a nicety; free text still works
  $id('lcReasonSuggestions').innerHTML = (data || []).map(r => `<option value="${esc(r.reason)}"></option>`).join('')
}

// ── RENDER ────────────────────────────────────────────────────────────────

function render() {
  updateStatus()
  if (isAdmin) renderProjects()
  renderGigs()
}

function updateStatus() {
  const pinned = allGigs.filter(isPinned).length
  const pinnable = allGigs.filter(isPinnable).length
  let txt = `● ${pinned} pinned of ${pinnable} clockable`
  if (isAdmin) {
    txt += ` · ${allGigs.filter(isFrozen).length} frozen · ${allGigs.filter(isKilled).length} killed · ${allGigs.length} gigs total`
  }
  const el = $id('dbStatus')
  el.textContent = txt
  el.className = 'db-status ok'
}

function projectCode(g) { return g.projects?.project_code || projectCodes[g.project_id] || '—' }

// Projects block (admin): same cascade actions as before
function renderProjects() {
  const wrap = $id('projectsList')
  const byProject = new Map()

  allGigs.forEach(g => {
    if (!g.project_id) return
    if (!byProject.has(g.project_id)) {
      byProject.set(g.project_id, { id: g.project_id, code: projectCode(g), name: g.projects?.project_name || '', open: 0, frozen: 0, killed: 0 })
    }
    const p = byProject.get(g.project_id)
    if (isKilled(g)) p.killed++
    else { p.open++; if (isFrozen(g)) p.frozen++ }
  })

  const projects = [...byProject.values()].sort((a, b) => a.code.localeCompare(b.code))
  if (!projects.length) { wrap.innerHTML = '<div class="empty-state">No projects with manageable gigs.</div>'; return }

  wrap.innerHTML = projects.map(p => `
    <div class="project-row${p.frozen ? ' has-frozen' : ''}">
      <div>
        <div class="project-code">${esc(p.code)}</div>
        <div class="project-name">${esc(p.name)}</div>
        <div class="project-counts">${p.open} open${p.frozen ? ` (${p.frozen} frozen)` : ''} · ${p.killed} killed</div>
      </div>
      <div class="project-actions">
        <button type="button" class="lc-btn" ${p.open ? '' : 'disabled'} onclick="freezeProjectRow('${p.id}','${esc(p.code)}',${p.open})">Freeze Project</button>
        <button type="button" class="lc-btn danger" ${p.open ? '' : 'disabled'} onclick="killProjectRow('${p.id}','${esc(p.code)}',${p.open})">Kill Project</button>
      </div>
    </div>`).join('')
}

const FILTERS = {
  open:    g => !isKilled(g) && !isMaster(g),
  all:     () => true,
  pinned:  g => isPinned(g),
  frozen:  g => isFrozen(g),
  killed:  g => isKilled(g),
  masters: g => isMaster(g),
}

function renderGigs() {
  const tbody = $id('gigsTableBody')
  const term = searchTerm.trim().toLowerCase()
  const pass = FILTERS[filterId] || FILTERS.open

  const visible = allGigs
    .filter(pass)
    .filter(g => !term || g.gig_code.toLowerCase().includes(term) || (g.title || '').toLowerCase().includes(term))
    .sort((a, b) => a.gig_code.localeCompare(b.gig_code))

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">${allGigs.length ? 'No gigs match.' : 'No gigs available right now.'}</div></td></tr>`
    return
  }
  tbody.innerHTML = visible.map(rowHTML).join('')
}

function rowHTML(g) {
  const killed = isKilled(g), frozen = isFrozen(g), master = isMaster(g)
  const reason = g.lifecycle?.reason || ''
  const by = [g.lifecycle?.changed_by_name && `by ${g.lifecycle.changed_by_name}`, g.lifecycle?.changed_at && fmtDate(g.lifecycle.changed_at.slice(0, 10))].filter(Boolean).join(' · ')

  const pinOff = !isPinnable(g)
  const pinTip = master ? 'Masters are never clockable' : killed ? 'Killed gig' : frozen ? 'Frozen gigs are not clockable' : g.status === 'completed' ? 'Completed gig' : ''

  const tags = (master ? '<span class="tag">Master</span>' : '') + (frozen ? '<span class="tag">Frozen</span>' : '') + (killed ? '<span class="tag">Killed</span>' : '')

  const adminCells = isAdmin ? `
      <td class="center admin-only"><input type="checkbox" class="chk frz" ${frozen ? 'checked' : ''} ${killed ? 'disabled title="Killed gigs can\'t be frozen"' : ''}
          onchange="toggleFreeze('${g.gig_id}','${esc(g.gig_code)}',this.checked)"></td>
      <td class="center admin-only"><input type="checkbox" class="chk kill" ${killed ? 'checked disabled title="No undo here. Reverting a kill is a manual SQL operation."' : ''}
          onchange="toggleKill('${g.gig_id}','${esc(g.gig_code)}',this.checked)"></td>
      <td class="admin-only hide-sm">${(frozen || killed) ? `<span class="why">${esc(reason || 'No reason recorded')}${by ? ` <span class="by">${esc(by)}</span>` : ''}</span>` : ''}</td>` : ''

  return `
    <tr class="${killed ? 'is-killed' : frozen ? 'is-frozen' : ''}">
      <td class="code-cell">${esc(g.gig_code)}${tags}</td>
      <td class="txt">${esc(g.title)}</td>
      <td class="hide-sm" style="color:var(--stone);font-size:12px">${esc(projectCode(g))}</td>
      <td><span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span></td>
      <td class="center"><input type="checkbox" class="chk pin" ${isPinned(g) ? 'checked' : ''} ${pinOff ? `disabled title="${esc(pinTip)}"` : ''}
          onchange="togglePin('${g.gig_id}',this.checked)"></td>
      ${adminCells}
    </tr>`
}

// ── PIN (auto-save, everyone) ──────────────────────────────────────────────

window.togglePin = async function (gigId, checked) {
  const { error } = checked ? await pinGig(db, userId, gigId) : await unpinGig(db, userId, gigId)
  if (error) { showToast('Could not update: ' + error.message, 'err'); renderGigs(); return }
  if (checked) pinnedIds.add(gigId); else pinnedIds.delete(gigId)
  updateStatus()
  showToast(checked ? 'Pinned' : 'Unpinned', 'ok')
}

// ── FREEZE / KILL (admin) ──────────────────────────────────────────────────

window.toggleFreeze = async function (gigId, code, checked) {
  if (!isAdmin) return
  if (checked) { openLcModal({ kind: 'freeze', id: gigId, code }); return }
  // Unfreeze needs no reason: fully reversible
  const { error } = await unfreezeGig(db, gigId)
  if (error) { showToast('Could not unfreeze: ' + error.message, 'err'); renderGigs(); return }
  showToast(`${code} unfrozen`, 'ok')
  await load()
}

window.toggleKill = function (gigId, code, checked) {
  if (!isAdmin) return
  if (!checked) { renderGigs(); return }   // a killed box is disabled, this is only a safety net
  openLcModal({ kind: 'kill', id: gigId, code })
}

window.freezeProjectRow = (id, code, openCount) => openLcModal({ kind: 'freezeProject', id, code, openCount })
window.killProjectRow   = (id, code, openCount) => openLcModal({ kind: 'killProject',   id, code, openCount })

// ── REASON MODAL ──────────────────────────────────────────────────────────
// One modal, four cases. The sub-text carries the confirmation context
// (what will happen, how many gigs), so there is no second confirm().

function openLcModal({ kind, id, code, openCount }) {
  pendingAction = { kind, id, code }
  const title = $id('lcModalTitle'), sub = $id('lcModalSub'), input = $id('lcModalReasonInput')
  const err = $id('lcModalError'), btn = $id('lcModalConfirmBtn')

  input.value = ''
  err.classList.remove('visible')
  sub.classList.remove('danger')

  const n = openCount, plural = n !== 1 ? 's' : ''
  if (kind === 'freeze') {
    title.textContent = `Freeze ${code}`; sub.textContent = 'Fully reversible. Reason is optional.'; btn.textContent = 'Freeze'
  } else if (kind === 'kill') {
    title.textContent = `Kill ${code}`; sub.textContent = 'Sets this gig to Completed. No undo button. Reason is required.'; sub.classList.add('danger'); btn.textContent = 'Kill'
  } else if (kind === 'freezeProject') {
    title.textContent = `Freeze ${code}`; sub.textContent = `Freezes all ${n} open gig${plural} in this project. Reason is optional.`; btn.textContent = 'Freeze Project'
  } else {
    title.textContent = `Kill ${code}`; sub.textContent = `Sets all ${n} open gig${plural} in this project to Completed. No undo button. Reason is required.`; sub.classList.add('danger'); btn.textContent = 'Kill Project'
  }

  $id('lcModalOverlay').classList.add('open')
  input.focus()
}

window.closeLcModal = function () {
  $id('lcModalOverlay').classList.remove('open')
  pendingAction = null
  renderGigs()   // a cancelled check puts its checkbox back to the saved state
}

window.confirmLcModal = async function () {
  if (!pendingAction) return
  const input = $id('lcModalReasonInput'), err = $id('lcModalError')
  const reason = input.value.trim()
  const { kind, id, code } = pendingAction
  const isKill = kind === 'kill' || kind === 'killProject'

  if (isKill && !reason) { err.classList.add('visible'); input.focus(); return }

  $id('lcModalOverlay').classList.remove('open')
  pendingAction = null

  let res
  if (kind === 'freeze')             res = await freezeGig(db, id, userId, reason)
  else if (kind === 'kill')          res = await killGig(db, id, userId, reason)
  else if (kind === 'freezeProject') res = await freezeProjectGigs(db, id, userId, reason)
  else                               res = await killProjectGigs(db, id, userId, reason)

  if (res?.error) { showToast('Could not complete: ' + res.error.message, 'err'); await load(); return }

  const n = res?.count
  const msg = kind === 'freeze' ? `${code} frozen`
            : kind === 'kill'   ? `${code} killed`
            : kind === 'freezeProject' ? `${n} gig${n !== 1 ? 's' : ''} in ${code} frozen`
            : `${n} gig${n !== 1 ? 's' : ''} in ${code} killed`
  showToast(msg, 'ok')
  await load()
}

$id('lcModalReasonInput').addEventListener('keydown', e => { if (e.key === 'Enter') window.confirmLcModal() })
$id('lcModalOverlay').addEventListener('click', e => { if (e.target.id === 'lcModalOverlay') window.closeLcModal() })

// ── TOOLBAR ───────────────────────────────────────────────────────────────

$id('searchInput').addEventListener('input', e => { searchTerm = e.target.value; renderGigs() })
$id('filterSelect').addEventListener('change', e => { filterId = e.target.value; renderGigs() })

// ── HELPERS ───────────────────────────────────────────────────────────────

function $id(id) { return document.getElementById(id) }
function fmtStatus(s) { return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) }

// ── INIT ──────────────────────────────────────────────────────────────────

load()
if (isAdmin) loadReasons()
