/**
 * gig_index.js — Vidai to Mulai · Gig Index
 * Full pipeline view — all gigs, status filter strip.
 * Updated for new schema: project + category joins.
 * Role-aware: rovers see only their gigs.
 */

import { db }                              from './vtm_db.js'
import { fetchGigs, deleteGig, fmtDate, esc } from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

const role     = session.role
const myUserId = session.user_id
const name     = session.name

// ── STATUS FILTER FROM URL ────────────────────────────────────────────────

const urlStatus  = new URLSearchParams(window.location.search).get('status')
const statusEl   = document.getElementById('dbStatus')
const titleEl    = document.getElementById('registerTitle')
const subtitleEl = document.getElementById('registerSubtitle')

// Hide New Gig for rovers
if (role === 'rover') {
  document.getElementById('newGigBtn')?.remove()
  document.getElementById('newGigLink')?.remove()
}

if (urlStatus) {
  document.querySelectorAll('.flow-step').forEach(el => {
    if (el.dataset.status === urlStatus) el.classList.add('active')
  })
  titleEl.textContent    = fmtStatus(urlStatus) + ' Gigs'
  subtitleEl.textContent = `Filtered · ${urlStatus}`
} else {
  subtitleEl.textContent = role === 'admin' ? 'All gigs' : `Your gigs · ${name}`
}

// ── LOAD ──────────────────────────────────────────────────────────────────

async function loadGigs() {
  const { data: all, error } = await fetchGigs(db)

  if (error) {
    statusEl.textContent = 'Could not connect — ' + error.message
    statusEl.className   = 'db-status err'
    return
  }

  // Role filter
  let filtered = all || []
  if (role === 'pacer')  filtered = filtered.filter(g => g.pacer_id === myUserId)
  if (role === 'rover')  filtered = filtered.filter(g => g.rover_id === myUserId)

  // Status filter
  if (urlStatus) filtered = filtered.filter(g => g.status === urlStatus)

  statusEl.textContent = `● Connected · ${filtered.length} gig${filtered.length !== 1 ? 's' : ''}${urlStatus ? ' · filtered' : ''}`
  statusEl.className   = 'db-status ok'

  const tbody = document.getElementById('gigTableBody')

  if (!filtered.length) {
    const canCreate = role !== 'rover'
    tbody.innerHTML = `<tr><td colspan="8">
      <div class="empty-state">No gigs ${urlStatus ? 'at this stage' : 'yet'}${canCreate ? ' — <a href="create_gig.html">create one</a>' : ''}.
      </div></td></tr>`
    return
  }

  tbody.innerHTML = filtered.map(g => {
    const projCode = g.projects?.project_code || '—'
    const catCode  = g.project_categories?.category_code || '—'
    const isPlacement = !g.date_start || !g.date_due || !g.rover_id || !g.pacer_id || !g.category_id

    return `
      <tr onclick="editGig('${g.gig_id}')">
        <td><strong style="font-family:var(--font-mono);font-size:12px">${esc(g.gig_code)}</strong>
          ${isPlacement && role !== 'rover' ? '<br><span class="placement-flag">Needs Placement</span>' : ''}
        </td>
        <td>${esc(g.title)}</td>
        <td style="color:var(--stone);font-size:12px">${esc(projCode)}</td>
        <td><span class="cat-tag">${esc(catCode)}</span></td>
        <td><span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span></td>
        <td style="color:var(--stone);font-size:12px">${fmtDate(g.date_start)}</td>
        <td style="color:var(--stone);font-size:12px">${fmtDate(g.date_due)}</td>
        <td style="white-space:nowrap" onclick="event.stopPropagation()">
          ${role !== 'rover' ? `<button class="tbl-btn" onclick="editGig('${g.gig_id}')">Edit</button>` : ''}
          ${['delivered','in_progress'].includes(g.status) ? `<button class="tbl-btn" onclick="goToEval('${g.gig_id}')">Evaluate</button>` : ''}
          ${role === 'admin' ? `<button class="tbl-btn danger" onclick="deleteGigRow('${g.gig_id}','${esc(g.gig_code)}')">Delete</button>` : ''}
        </td>
      </tr>`
  }).join('')
}

// ── ACTIONS ───────────────────────────────────────────────────────────────

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
  loadGigs()
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadGigs()
