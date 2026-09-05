/**
 * time_recording_gigs.js — Vidai to Mulai · Time Recording Gigs
 * Lets a person choose which of their clockable gigs show up "within the
 * fold" in the Timesheet's drag-to-clock-in pool. Pinning is per-person
 * and self-managed — each checkbox auto-saves on toggle, no separate
 * Save button, same convention as Dashboard Admin's page-visibility
 * table.
 *
 * The gig set here is exactly what the Timesheet pool itself pulls from
 * — both pages call fetchClockableGigs() in vtm_api.js so they can never
 * silently drift into showing different gigs.
 */

import { db } from './vtm_db.js'
import { fetchClockableGigs, fetchPinnedGigIds,
         pinGig, unpinGig, fmtDate, esc } from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }

const role   = session.role
const userId = session.user_id

// ── STATE ─────────────────────────────────────────────────────────────────

let allGigs     = []
let pinnedGigIds = new Set()
let searchTerm   = ''

// ── LOAD ──────────────────────────────────────────────────────────────────

async function load() {
  const statusEl = document.getElementById('dbStatus')
  statusEl.textContent = 'Loading…'
  statusEl.className   = 'db-status'

  const [gigsRes, pinsRes] = await Promise.all([
    fetchClockableGigs(db, role, userId),
    fetchPinnedGigIds(db, userId),
  ])

  if (gigsRes.error) {
    statusEl.textContent = 'Could not load gigs — ' + gigsRes.error.message
    statusEl.className   = 'db-status err'
    return
  }

  allGigs      = gigsRes.data || []
  pinnedGigIds = new Set((pinsRes.data || []).map(r => r.gig_id))

  updateStatus()
  render()
}

function updateStatus() {
  const statusEl = document.getElementById('dbStatus')
  statusEl.textContent = `● ${pinnedGigIds.size} pinned of ${allGigs.length} gig${allGigs.length !== 1 ? 's' : ''}`
  statusEl.className   = 'db-status ok'
}

// ── RENDER ────────────────────────────────────────────────────────────────

function render() {
  const tbody = document.getElementById('gigsTableBody')
  const term  = searchTerm.trim().toLowerCase()

  const visible = allGigs.filter(g =>
    !term || g.gig_code.toLowerCase().includes(term) || (g.title || '').toLowerCase().includes(term)
  )

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">${
      allGigs.length ? 'No gigs match your search.' : 'No clockable gigs right now.'
    }</div></td></tr>`
    return
  }

  // Pinned first, then by gig code — the current picture is visible at a
  // glance without needing a second, separate "pinned" section.
  const sorted = [...visible].sort((a, b) => {
    const pa = pinnedGigIds.has(a.gig_id), pb = pinnedGigIds.has(b.gig_id)
    if (pa !== pb) return pa ? -1 : 1
    return a.gig_code.localeCompare(b.gig_code)
  })

  tbody.innerHTML = sorted.map(g => `
    <tr>
      <td class="center">
        <input type="checkbox" class="pin-check" ${pinnedGigIds.has(g.gig_id) ? 'checked' : ''}
               onchange="togglePin('${g.gig_id}', this.checked)">
      </td>
      <td style="font-family:var(--font-mono);font-size:12px;font-weight:600">${esc(g.gig_code)}</td>
      <td>${esc(g.title)}</td>
      <td><span class="status-pill ${g.status || 'placed'}">${fmtStatus(g.status)}</span></td>
      <td style="color:var(--stone);font-size:12px">${g.date_due ? fmtDate(g.date_due) : '—'}</td>
    </tr>`).join('')
}

// ── TOGGLE (auto-save) ──────────────────────────────────────────────────

window.togglePin = async function(gigId, checked) {
  const { error } = checked
    ? await pinGig(db, userId, gigId)
    : await unpinGig(db, userId, gigId)

  if (error) {
    showToast('Could not update — ' + error.message, 'err')
    render()   // revert the checkbox back to the actual saved state
    return
  }

  if (checked) pinnedGigIds.add(gigId)
  else pinnedGigIds.delete(gigId)

  updateStatus()
  showToast(checked ? 'Pinned' : 'Unpinned', 'ok')
}

// ── SEARCH ────────────────────────────────────────────────────────────────

document.getElementById('searchInput').addEventListener('input', e => {
  searchTerm = e.target.value
  render()
})

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── INIT ──────────────────────────────────────────────────────────────────

load()
