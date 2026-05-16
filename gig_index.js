/**
 * gig_index.js — Vidai to Mulai · Gig Index
 * AUTH-05: Filter gigs by role on load
 * AUTH-08: Delete button visible to Admin only
 * Lists gigs filterable by status via ?status=X
 * DB calls via vtm_api.js · Connection via vtm_db.js
 */

import { db } from './assets/vtm_db.js'
import { fetchGigs, deleteGig } from './assets/vtm_api.js'
import { fmtDate, esc } from './assets/vtm_api.js'

// ── WAIT FOR vtm.js ───────────────────────────────────────────────────────
// Ensure vtmGetSession is available before proceeding
function getSession() {
  if (typeof window.vtmGetSession !== 'undefined') {
    return window.vtmGetSession()
  }
  console.log('Waiting for vtm.js to load...')
  return null
}

// Check session with retry
let session = getSession()
if (!session) {
  // Small delay to let vtm.js finish initializing
  setTimeout(() => {
    session = getSession()
    if (!session) {
      window.location.href = 'login.html'
      return
    }
    // Session found, continue initialization
    initializePage()
  }, 50)
} else {
  initializePage()
}

// ── PAGE INITIALIZATION ───────────────────────────────────────────────────
function initializePage() {
  const role = session?.role || 'admin'
  const refId = session?.ref_id || null
  const name = session?.name || ''

  const statusEl = document.getElementById('dbStatus')
  const titleEl = document.getElementById('registerTitle')
  const subtitleEl = document.getElementById('registerSubtitle')

  // ── STATUS FILTER FROM URL ────────────────────────────────────────────────
  const urlStatus = new URLSearchParams(window.location.search).get('status')

  if (urlStatus) {
    document.querySelectorAll('.flow-step').forEach(el => {
      if (el.dataset.status === urlStatus) el.classList.add('active')
    })
    titleEl.textContent = fmtStatus(urlStatus) + ' Gigs'
    subtitleEl.textContent = `Filtered · ${urlStatus}`
  } else {
    subtitleEl.textContent = role === 'admin' ? 'All gigs' : `Your gigs · ${name}`
  }

  // ── LOAD GIGS — AUTH-05 ───────────────────────────────────────────────────
  async function loadGigs() {
    const { data: all, error } = await fetchGigs(db)

    if (error) {
      statusEl.textContent = 'Could not connect — check credentials'
      statusEl.className = 'db-status err'
      return
    }

    // AUTH-05: filter by role
    let roleFiltered = all
    if (role === 'pacer' && refId) {
      roleFiltered = all.filter(g => g.pacer_id === refId)
    } else if (role === 'rover' && refId) {
      roleFiltered = all.filter(g => g.rover_id === refId)
    }

    const data = urlStatus
      ? roleFiltered.filter(g => g.status === urlStatus)
      : roleFiltered

    statusEl.textContent = `● Connected · ${data.length} gig${data.length !== 1 ? 's' : ''}${urlStatus ? ' · filtered' : ''}`
    statusEl.className = 'db-status ok'

    const tbody = document.getElementById('gigTableBody')

    if (!data.length) {
      const canCreate = role === 'pacer' || role === 'admin'
      tbody.innerHTML = `
        <tr><td colspan="8">
          <div class="empty-state">
            No gigs ${urlStatus ? 'at this stage' : 'yet'}${canCreate ? ' — <a href="create_gig.html">create one</a>' : ''}.
          </div>
        </td></tr>`
      return
    }

    const isAdmin = role === 'admin'

    tbody.innerHTML = data.map(g => `
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
          ${isAdmin
            ? `<button class="tbl-btn danger" onclick="deleteGigRow('${g.gig_id}','${esc(g.gig_code)}')">Delete</button>`
            : ''}
        </td>
      </tr>
    `).join('')
  }

  // ── EDIT ──────────────────────────────────────────────────────────────────
  window.editGig = function(id) {
    window.location.href = `create_gig.html?gig_id=${id}`
  }

  // ── DELETE — AUTH-08 guard ────────────────────────────────────────────────
  window.deleteGigRow = async function(id, code) {
    if (role !== 'admin') {
      showToast('Only admins can delete gigs', 'err')
      return
    }
    if (!confirm(`Delete gig "${code}"? This cannot be undone.`)) return
    const { error } = await deleteGig(db, id)
    if (error) { showToast('Delete failed: ' + error.message, 'err'); return }
    showToast(`${code} deleted`, 'ok')
    loadGigs()
  }

  // ── EVALUATE ──────────────────────────────────────────────────────────────
  window.goToEval = function(id) {
    window.location.href = `gig_eval.html?gig_id=${id}`
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  function fmtStatus(s) {
    return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
  }

  // Start loading
  loadGigs()
}