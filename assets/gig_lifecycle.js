/**
 * gig_lifecycle.js — Vidai to Mulai · Gig Lifecycle
 * Admin only — vtm_admin_guard.js (loaded in the page) already redirects
 * non-admins; this is just the data-layer guard so nothing fetches before
 * that redirect has a chance to fire (same convention as dash_admin.js /
 * doer_report.js).
 *
 * FREEZE — reversible, no change to gigs.status. A row in gig_lifecycle
 * with state:'frozen' is the only record of it; unfreezing deletes that
 * row. Reason is optional.
 *
 * KILL — one-way through this UI. Sets gigs.status = 'completed' AND
 * writes a gig_lifecycle row with state:'killed' + a required reason.
 * A killed gig is a completed gig, distinguished from a normal
 * evaluated completion by that lifecycle row. There is no "unkill"
 * button anywhere — reverting one is a deliberate manual SQL operation.
 *
 * PROJECT ACTIONS — not a separate concept. Freezing/killing a project
 * applies the same gig-level action to every one of that project's
 * still-open gigs in one go. Bulk write, so both require an explicit
 * confirm naming the gig count before anything happens.
 *
 * The gig set here deliberately includes master/template gigs (unlike
 * Time Recording Gigs' pin list) — freezing/killing a master is exactly
 * how you stop it spawning new instances.
 */

import { db } from './vtm_db.js'
import { fetchLifecycleGigs, freezeGig, unfreezeGig, killGig,
         freezeProjectGigs, killProjectGigs, fetchLifecycleReasons, fmtDate, esc } from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }
if (session.role !== 'admin') { window.location.href = 'dashboard.html'; throw new Error('Admin only') }

const userId = session.user_id

// ── STATE ─────────────────────────────────────────────────────────────────
// All module-level state declared here, before init runs at the bottom
// of the file — see timesheet.js's history for why that ordering
// actually matters (a `let` declared later than where it's first used
// throws, it doesn't just silently work).

let allGigs         = []   // every manageable gig, each with .lifecycle attached (or null)
let searchTerm       = ''
let reasonSuggestions = []   // strings from gig_lifecycle_reasons, feeds the modal's datalist
let pendingAction     = null // { kind: 'freeze'|'kill'|'freezeProject'|'killProject', id, code, openCount? }

// ── LOAD ──────────────────────────────────────────────────────────────────

async function load() {
  const statusEl = document.getElementById('dbStatus')
  statusEl.textContent = 'Loading…'
  statusEl.className   = 'db-status'

  const { data, error } = await fetchLifecycleGigs(db)

  if (error) {
    statusEl.textContent = 'Could not load gigs — ' + error.message
    statusEl.className   = 'db-status err'
    return
  }

  allGigs = data || []
  updateStatus()
  renderProjects()
  renderGigs()
}

async function loadReasons() {
  const { data, error } = await fetchLifecycleReasons(db)
  if (error) return   // suggestions are a nicety — a free-text reason still works without them

  reasonSuggestions = (data || []).map(r => r.reason)
  const datalist = document.getElementById('lcReasonSuggestions')
  if (datalist) datalist.innerHTML = reasonSuggestions.map(r => `<option value="${esc(r)}"></option>`).join('')
}

function updateStatus() {
  const statusEl = document.getElementById('dbStatus')
  const frozen = allGigs.filter(g => g.lifecycle?.state === 'frozen').length
  const killed = allGigs.filter(g => g.lifecycle?.state === 'killed').length
  statusEl.textContent = `● ${allGigs.length} gig${allGigs.length !== 1 ? 's' : ''} · ${frozen} frozen · ${killed} killed`
  statusEl.className   = 'db-status ok'
}

// ── PROJECTS ──────────────────────────────────────────────────────────────

function renderProjects() {
  const wrap = document.getElementById('projectsList')

  const byProject = new Map()
  allGigs.forEach(g => {
    if (!g.project_id) return
    if (!byProject.has(g.project_id)) {
      byProject.set(g.project_id, {
        project_id: g.project_id,
        code: g.projects?.project_code || '—',
        name: g.projects?.project_name || '',
        open: 0, frozen: 0, killed: 0,
      })
    }
    const p = byProject.get(g.project_id)
    if (g.lifecycle?.state === 'killed') p.killed++
    else {
      p.open++   // status != completed, covers active + frozen
      if (g.lifecycle?.state === 'frozen') p.frozen++
    }
  })

  const projects = Array.from(byProject.values()).sort((a, b) => a.code.localeCompare(b.code))

  if (!projects.length) {
    wrap.innerHTML = '<div class="empty-state">No projects with manageable gigs.</div>'
    return
  }

  wrap.innerHTML = projects.map(p => `
    <div class="project-row${p.frozen ? ' has-frozen' : ''}">
      <div class="project-info">
        <div class="project-code">${esc(p.code)}</div>
        <div class="project-name">${esc(p.name)}</div>
        <div class="project-counts">${p.open} open${p.frozen ? ` (${p.frozen} frozen)` : ''} · ${p.killed} killed</div>
      </div>
      <div class="project-actions">
        <button type="button" class="lc-btn small" ${p.open ? '' : 'disabled'} onclick="freezeProjectRow('${p.project_id}','${esc(p.code)}',${p.open})">Freeze Project</button>
        <button type="button" class="lc-btn small danger" ${p.open ? '' : 'disabled'} onclick="killProjectRow('${p.project_id}','${esc(p.code)}',${p.open})">Kill Project</button>
      </div>
    </div>`).join('')
}

// ── GIGS ──────────────────────────────────────────────────────────────────

function renderGigs() {
  const tbody = document.getElementById('gigsTableBody')
  const term  = searchTerm.trim().toLowerCase()

  const visible = allGigs.filter(g =>
    !term || g.gig_code.toLowerCase().includes(term) || (g.title || '').toLowerCase().includes(term)
  )

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">${
      allGigs.length ? 'No gigs match your search.' : 'No manageable gigs right now.'
    }</div></td></tr>`
    return
  }

  const sorted = [...visible].sort((a, b) => a.gig_code.localeCompare(b.gig_code))
  tbody.innerHTML = sorted.map(gigRowHTML).join('')
}

function gigRowHTML(g) {
  const state    = g.lifecycle?.state || 'active'
  const reason   = g.lifecycle?.reason || ''
  const byWhen   = lifecycleByWhen(g.lifecycle)
  const tipText  = [reason, byWhen].filter(Boolean).join(' · ')
  const badge    = `<span class="lifecycle-badge ${state}"${tipText ? ` title="${esc(tipText)}"` : ''}>${state}</span>`
  const projCode = g.projects?.project_code || '—'

  let actions
  if (state === 'killed') {
    actions = `<span class="killed-note">${esc(reason || 'No reason recorded')}${byWhen ? ` <span class="killed-meta">— ${esc(byWhen)}</span>` : ''}</span>`
  } else if (state === 'frozen') {
    actions = `
      <button type="button" class="lc-btn" onclick="unfreezeRow('${g.gig_id}','${esc(g.gig_code)}')">Unfreeze</button>
      <button type="button" class="lc-btn danger" onclick="killRow('${g.gig_id}','${esc(g.gig_code)}')">Kill</button>`
  } else {
    actions = `
      <button type="button" class="lc-btn" onclick="freezeRow('${g.gig_id}','${esc(g.gig_code)}')">Freeze</button>
      <button type="button" class="lc-btn danger" onclick="killRow('${g.gig_id}','${esc(g.gig_code)}')">Kill</button>`
  }

  return `
    <tr>
      <td style="font-family:var(--font-mono);font-size:12px;font-weight:600">${esc(g.gig_code)}</td>
      <td class="gig-title-cell">${esc(g.title)}</td>
      <td style="color:var(--stone);font-size:12px">${esc(projCode)}</td>
      <td><span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span></td>
      <td>${badge}</td>
      <td>${actions}</td>
    </tr>`
}

// "by Name · 8 Sep 2026" from whatever's actually present on the row.
function lifecycleByWhen(lifecycle) {
  if (!lifecycle) return ''
  const parts = []
  if (lifecycle.changed_by_name) parts.push(`by ${lifecycle.changed_by_name}`)
  if (lifecycle.changed_at)      parts.push(fmtDate(lifecycle.changed_at))
  return parts.join(' · ')
}

// ── GIG ACTIONS ───────────────────────────────────────────────────────────

window.freezeRow = function(gigId, code) {
  openLcModal({ kind: 'freeze', id: gigId, code })
}

window.unfreezeRow = async function(gigId, code) {
  // No reason needed here — fully reversible, no modal required.
  const { error } = await unfreezeGig(db, gigId)
  if (error) { showToast('Could not unfreeze — ' + error.message, 'err'); return }
  showToast(`${code} unfrozen`, 'ok')
  await load()
}

window.killRow = function(gigId, code) {
  openLcModal({ kind: 'kill', id: gigId, code })
}

// ── PROJECT ACTIONS ───────────────────────────────────────────────────────

window.freezeProjectRow = function(projectId, code, openCount) {
  openLcModal({ kind: 'freezeProject', id: projectId, code, openCount })
}

window.killProjectRow = function(projectId, code, openCount) {
  openLcModal({ kind: 'killProject', id: projectId, code, openCount })
}

// ── REASON PICKER MODAL ─────────────────────────────────────────────────
// One modal, four use cases — the copy and required-ness of the reason
// field change per `kind`, everything else is shared. The modal's own
// sub-text carries the confirmation context (what's about to happen,
// to how many gigs) rather than stacking a separate confirm() in front
// of it — two dialogs in a row for the same decision felt like one too
// many.

function openLcModal({ kind, id, code, openCount }) {
  pendingAction = { kind, id, code }

  const title      = document.getElementById('lcModalTitle')
  const sub        = document.getElementById('lcModalSub')
  const input      = document.getElementById('lcModalReasonInput')
  const err        = document.getElementById('lcModalError')
  const confirmBtn = document.getElementById('lcModalConfirmBtn')

  input.value = ''
  err.classList.remove('visible')
  sub.classList.remove('danger')

  if (kind === 'freeze') {
    title.textContent      = `Freeze ${code}`
    sub.textContent        = 'Fully reversible — reason is optional.'
    confirmBtn.textContent = 'Freeze'
  } else if (kind === 'kill') {
    title.textContent      = `Kill ${code}`
    sub.textContent        = 'Sets this gig to Completed. No undo button — reason is required.'
    sub.classList.add('danger')
    confirmBtn.textContent = 'Kill'
  } else if (kind === 'freezeProject') {
    title.textContent      = `Freeze ${code}`
    sub.textContent        = `Freezes all ${openCount} open gig${openCount !== 1 ? 's' : ''} in this project. Reason is optional.`
    confirmBtn.textContent = 'Freeze Project'
  } else if (kind === 'killProject') {
    title.textContent      = `Kill ${code}`
    sub.textContent        = `Sets all ${openCount} open gig${openCount !== 1 ? 's' : ''} in this project to Completed. No undo button — reason is required.`
    sub.classList.add('danger')
    confirmBtn.textContent = 'Kill Project'
  }

  document.getElementById('lcModalOverlay').classList.add('open')
  input.focus()
}

window.closeLcModal = function() {
  document.getElementById('lcModalOverlay').classList.remove('open')
  pendingAction = null
}

window.confirmLcModal = async function() {
  if (!pendingAction) return

  const input  = document.getElementById('lcModalReasonInput')
  const err    = document.getElementById('lcModalError')
  const reason = input.value.trim()

  const { kind, id, code } = pendingAction
  const isKill = kind === 'kill' || kind === 'killProject'

  if (isKill && !reason) {
    err.classList.add('visible')
    input.focus()
    return
  }

  window.closeLcModal()

  if (kind === 'freeze') {
    const { error } = await freezeGig(db, id, userId, reason)
    if (error) { showToast('Could not freeze — ' + error.message, 'err'); return }
    showToast(`${code} frozen`, 'ok')
  } else if (kind === 'kill') {
    const { error } = await killGig(db, id, userId, reason)
    if (error) { showToast('Could not kill — ' + error.message, 'err'); return }
    showToast(`${code} killed`, 'ok')
  } else if (kind === 'freezeProject') {
    const { count, error } = await freezeProjectGigs(db, id, userId, reason)
    if (error) { showToast('Could not freeze project — ' + error.message, 'err'); return }
    showToast(`${count} gig${count !== 1 ? 's' : ''} in ${code} frozen`, 'ok')
  } else if (kind === 'killProject') {
    const { count, error } = await killProjectGigs(db, id, userId, reason)
    if (error) { showToast('Could not kill project — ' + error.message, 'err'); return }
    showToast(`${count} gig${count !== 1 ? 's' : ''} in ${code} killed`, 'ok')
  }

  await load()
}

document.getElementById('lcModalReasonInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') window.confirmLcModal()
})

document.getElementById('lcModalOverlay').addEventListener('click', e => {
  if (e.target.id === 'lcModalOverlay') window.closeLcModal()
})

// ── SEARCH ────────────────────────────────────────────────────────────────

document.getElementById('searchInput').addEventListener('input', e => {
  searchTerm = e.target.value
  renderGigs()
})

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── INIT ──────────────────────────────────────────────────────────────────

load()
loadReasons()
