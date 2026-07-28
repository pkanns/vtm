/**
 * gig_index.js — Vidai to Mulai · Gig Index
 * Full pipeline view — all gigs, status filter strip, plus a lightweight
 * filter bar (Status scope, Project, On track/Overdue chips) built on
 * gig_filters.js. Filtering/sorting logic lives there; this file owns
 * fetching, DOM state, and rendering only.
 * Role-aware: rovers see only their gigs.
 */

import { db }                                 from './vtm_db.js'
import { fetchGigs, deleteGig, fmtDate, esc } from './vtm_api.js'
import { enrichGig, SCOPE_OPTIONS, FILTER_CHIPS, applyFilters, sortByDueDate } from './gig_filters.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

const role     = session.role
const myUserId = session.user_id
const name     = session.name

// ── STATE ─────────────────────────────────────────────────────────────────

let allGigs = []   // raw + enriched, role-filtered — everything downstream reads from this

const params = new URLSearchParams(window.location.search)
const urlStatus = params.get('status')  // pipeline stage — takes precedence over scope when set

let scopeId       = params.get('scope')   || 'open'
let projectId     = params.get('project') || ''
let activeChipIds = new Set((params.get('chips') || '').split(',').filter(Boolean))

const statusEl   = document.getElementById('dbStatus')
const titleEl    = document.getElementById('registerTitle')
const subtitleEl = document.getElementById('registerSubtitle')
const scopeSelect   = document.getElementById('scopeSelect')
const projectSelect = document.getElementById('projectSelect')
const summaryEl     = document.getElementById('filterSummary')

scopeSelect.value = scopeId

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
  // A specific pipeline stage is a more specific ask than the coarse
  // Open/Complete/All scope — scope stops applying so the two controls
  // don't contradict each other.
  scopeSelect.disabled = true
  scopeSelect.style.opacity = '0.4'
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

  allGigs = filtered.map(enrichGig)

  populateProjectOptions()
  applyChipUI()
  render()
}

function populateProjectOptions() {
  const seen = new Map()
  allGigs.forEach(g => {
    if (g.project_id && g.projects?.project_code && !seen.has(g.project_id)) {
      seen.set(g.project_id, g.projects.project_code)
    }
  })

  const current = projectSelect.value
  projectSelect.innerHTML = '<option value="">Project</option>' +
    Array.from(seen.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, code]) => `<option value="${id}">${esc(code)}</option>`)
      .join('')
  projectSelect.value = current || projectId || ''
}

// ── RENDER ────────────────────────────────────────────────────────────────

function render() {
  let visible = allGigs

  // Pipeline stage (exact) takes precedence over the coarse scope filter
  if (urlStatus) {
    visible = visible.filter(g => g.status === urlStatus)
  } else {
    visible = applyFilters(visible, { scopeId, projectId: '', activeChipIds: new Set() })
  }

  // Project + chips always apply, on top of whichever status scope above
  visible = applyFilters(visible, { scopeId: null, projectId, activeChipIds })
  visible = sortByDueDate(visible)

  statusEl.textContent = `● Connected · ${visible.length} gig${visible.length !== 1 ? 's' : ''}`
  statusEl.className   = 'db-status ok'

  renderSummary(visible.length)
  renderTable(visible)
}

function renderSummary(count) {
  const parts = []
  if (urlStatus)               parts.push(fmtStatus(urlStatus))
  else if (scopeId !== 'open') parts.push(SCOPE_OPTIONS.find(s => s.id === scopeId)?.label)
  FILTER_CHIPS.forEach(c => { if (activeChipIds.has(c.id)) parts.push(c.label) })
  if (projectId) {
    const opt = Array.from(projectSelect.options).find(o => o.value === projectId)
    if (opt) parts.push(opt.textContent)
  }

  summaryEl.textContent = parts.length
    ? `${parts.join(' + ')} · ${count} gig${count !== 1 ? 's' : ''}`
    : `${count} gig${count !== 1 ? 's' : ''}`
}

function renderTable(visible) {
  const tbody = document.getElementById('gigTableBody')

  if (!visible.length) {
    const canCreate = role !== 'rover'
    tbody.innerHTML = `<tr><td colspan="8">
      <div class="empty-state">No gigs match these filters${canCreate ? ' — <a href="create_gig.html">create one</a>, or adjust the filters above' : ''}.
      </div></td></tr>`
    return
  }

  tbody.innerHTML = visible.map(g => {
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
        <td style="color:${g.isOverdue ? 'var(--red)' : 'var(--stone)'};font-size:12px${g.isOverdue ? ';font-weight:600' : ''}">${fmtDate(g.date_due)}</td>
        <td style="white-space:nowrap" onclick="event.stopPropagation()">
          ${role !== 'rover' ? `<button class="tbl-btn" onclick="editGig('${g.gig_id}')">Edit</button>` : ''}
          ${['delivered','in_progress'].includes(g.status) ? `<button class="tbl-btn" onclick="goToEval('${g.gig_id}')">Evaluate</button>` : ''}
          ${role === 'admin' ? `<button class="tbl-btn danger" onclick="deleteGigRow('${g.gig_id}','${esc(g.gig_code)}')">Delete</button>` : ''}
        </td>
      </tr>`
  }).join('')
}

// ── FILTER BAR INTERACTIONS ─────────────────────────────────────────────

function applyChipUI() {
  document.getElementById('chipOnTrack').classList.toggle('active', activeChipIds.has('on_track'))
  document.getElementById('chipOverdue').classList.toggle('active', activeChipIds.has('overdue'))
}

function syncUrl() {
  const p = new URLSearchParams(window.location.search)
  if (scopeId && scopeId !== 'open') p.set('scope', scopeId); else p.delete('scope')
  if (projectId) p.set('project', projectId); else p.delete('project')
  if (activeChipIds.size) p.set('chips', Array.from(activeChipIds).join(',')); else p.delete('chips')
  const qs = p.toString()
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname)
}

window.toggleChip = function(chipId) {
  if (activeChipIds.has(chipId)) activeChipIds.delete(chipId)
  else activeChipIds.add(chipId)
  applyChipUI()
  syncUrl()
  render()
}

scopeSelect.addEventListener('change', () => {
  scopeId = scopeSelect.value
  syncUrl()
  render()
})

projectSelect.addEventListener('change', () => {
  projectId = projectSelect.value
  syncUrl()
  render()
})

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
