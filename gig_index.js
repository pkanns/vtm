/**
 * gig_index.js — Vidai to Mulai · Gig Index
 * Filters gigs by role using session.user_id matched against
 * gigs.pacer_id (Lead) or gigs.rover_id (Doer).
 * No dependency on pacers or rovers tables.
 */

import { db } from './assets/vtm_db.js'
import { fetchGigs, deleteGig, fmtDate, esc } from './assets/vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────
// vtm.js is loaded as a regular script before this module, so
// vtmGetSession() is available on window immediately.

const session = vtmGetSession()

if (!session) {
  window.location.href = 'login.html'
}

const role     = session?.role    || 'admin'
const myUserId = session?.user_id || null
const name     = session?.name    || ''

// ── STATUS FILTER FROM URL ────────────────────────────────────────────────

const urlStatus  = new URLSearchParams(window.location.search).get('status')
const statusEl   = document.getElementById('dbStatus')
const titleEl    = document.getElementById('registerTitle')
const subtitleEl = document.getElementById('registerSubtitle')

if (urlStatus) {
  document.querySelectorAll('.flow-step').forEach(el => {
    if (el.dataset.status === urlStatus) el.classList.add('active')
  })
  titleEl.textContent    = fmtStatus(urlStatus) + ' Gigs'
  subtitleEl.textContent = `Filtered · ${urlStatus}`
} else {
  subtitleEl.textContent = role === 'admin' ? 'All gigs' : `Your gigs · ${name}`
}

// ── LOAD GIGS ─────────────────────────────────────────────────────────────

async function loadGigs() {
  const { data: all, error } = await fetchGigs(db)

  if (error) {
    statusEl.textContent = 'Could not connect — ' + error.message
    statusEl.className   = 'db-status err'
    return
  }

  // Filter by role using user_id
  let filtered = all || []
  if (role === 'pacer' && myUserId) {
    filtered = filtered.filter(g => g.pacer_id === myUserId)
  } else if (role === 'rover' && myUserId) {
    filtered = filtered.filter(g => g.rover_id === myUserId)
  }

  // Further filter by pipeline status if URL param set
  if (urlStatus) {
    filtered = filtered.filter(g => g.status === urlStatus)
  }

  statusEl.textContent = `● Connected · ${filtered.length} gig${filtered.length !== 1 ? 's' : ''}${urlStatus ? ' · filtered' : ''}`
  statusEl.className   = 'db-status ok'

  const tbody = document.getElementById('gigTableBody')

  if (!filtered.length) {
    const canCreate = role === 'pacer' || role === 'admin'
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">
          No gigs ${urlStatus ? 'at this stage' : 'yet'}${canCreate ? ' — <a href="create_gig.html">create one</a>' : ''}.
        </div>
      </td></tr>`
    return
  }

  tbody.innerHTML = filtered.map(g => `
    <tr>
      <td><strong style="font-family:var(--font-mono);font-size:12px">${esc(g.gig_code)}</strong></td>
      <td>${esc(g.title)}</td>
      <td style="color:var(--stone)">${esc(g.category || '—')}</td>
      <td style="text-transform:capitalize;color:var(--stone)">${g.setting || '—'}</td>
      <td style="text-transform:capitalize;color:var(--stone)">${g.scale || '—'}</td>
      <td><span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span></td>
      <td style="color:var(--stone);font-size:12px">${fmtDate(g.date_due)}</td>
      <td style="white-space:nowrap">
        ${role !== 'rover'
          ? `<button class="tbl-btn" onclick="editGig('${g.gig_id}')">Edit</button>`
          : ''}
        ${g.status === 'delivered' || g.status === 'in_progress'
          ? `<button class="tbl-btn" onclick="goToEval('${g.gig_id}')">Evaluate</button>`
          : ''}
        ${role === 'admin'
          ? `<button class="tbl-btn danger" onclick="deleteGigRow('${g.gig_id}','${esc(g.gig_code)}')">Delete</button>`
          : ''}
      </td>
    </tr>
  `).join('')
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
