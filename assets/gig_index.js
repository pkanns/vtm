/**
 * gig_index.js — Vidai to Mulai · Gig Index
 * Full pipeline view — all gigs, status filter strip, plus a filter bar
 * (Status scope incl. Masters, Project, Lead, Doer, Stage, plus On
 * track/Overdue chips) built on gig_filters.js. Filtering/sorting logic
 * lives there; this file owns fetching, DOM state, and rendering only.
 * Role-aware: rovers see only their gigs.
 *
 * VIEW SWITCHING: the fully-unfiltered default (scope=Open, nothing else
 * selected) renders as a table, same as always. Any filter being active —
 * scope changed (Masters included), a Project/Lead/Doer picked, a chip
 * on, or a pipeline stage selected — switches to a card grid instead,
 * using the same vtm-picker-card component gig_eval.html's picker uses.
 * A card's primary click varies by context (see renderGigCard): normally
 * opens the gig for editing, opens gig_eval.html directly when the
 * Evaluate stage is selected, and creates+opens a new instance when
 * browsing Masters and the card is a true adhoc template (scheduled
 * recurring parents aren't manually instanced — the cron handles those).
 *
 * Secondary actions (Edit / Move to next stage / Evaluate / Create
 * Instance / Delete) live in the shared "⋯" menu from gig_actions.js,
 * used identically in both the table and card views. Master gigs never
 * show a stage-advance or Evaluate action there — see gig_actions.js.
 *
 * "Masters" scope (id: 'masters') was previously "Templates" — renamed
 * and broadened to include scheduled recurring parents alongside true
 * adhoc templates, since neither is a real, workable gig.
 */

import { db }                                 from './vtm_db.js'
import { fetchGigs, deleteGig, fetchActiveLeads, fetchActiveDoers,
         fmtDate, esc }                       from './vtm_api.js'
import { enrichGig, SCOPE_OPTIONS, FILTER_CHIPS, applyFilters, sortByDueDate } from './gig_filters.js'
import { renderActionsMenu }                  from './gig_actions.js'

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
let leadId        = params.get('lead')    || ''
let doerId        = params.get('doer')    || ''
let activeChipIds = new Set((params.get('chips') || '').split(',').filter(Boolean))

const statusEl   = document.getElementById('dbStatus')
const titleEl    = document.getElementById('registerTitle')
const subtitleEl = document.getElementById('registerSubtitle')
const scopeSelect   = document.getElementById('scopeSelect')
const projectSelect = document.getElementById('projectSelect')
const leadSelect    = document.getElementById('leadSelect')
const doerSelect    = document.getElementById('doerSelect')
const stageSelect   = document.getElementById('stageSelect')
const summaryEl     = document.getElementById('filterSummary')
const tableWrap     = document.getElementById('gigTableWrap')
const cardWrap      = document.getElementById('gigCardWrap')

scopeSelect.value   = scopeId
projectSelect.value = projectId

// Masters is a management action (creating instances) — keep it off a
// Doer's filter bar entirely rather than relying on every downstream
// click handler to re-check role.
if (role === 'rover') {
  scopeSelect.querySelector('option[value="masters"]')?.remove()
}

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
  // Open/Complete/All/Masters scope, and than re-picking the same
  // stage from the Stage dropdown — both stop applying so the controls
  // don't contradict each other.
  scopeSelect.disabled = true
  scopeSelect.style.opacity = '0.4'
  stageSelect.value = urlStatus
  stageSelect.disabled = true
  stageSelect.style.opacity = '0.4'
} else {
  subtitleEl.textContent = role === 'admin' ? 'All gigs' : `Your gigs · ${name}`
  stageSelect.addEventListener('change', () => {
    const val = stageSelect.value
    window.location.href = val ? `gig_index.html?status=${val}` : 'gig_index.html'
  })
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

async function populateLeadDoerOptions() {
  const [leadsRes, doersRes] = await Promise.all([fetchActiveLeads(db), fetchActiveDoers(db)])

  leadSelect.innerHTML = '<option value="">Lead</option>' +
    (leadsRes.data || []).map(u => `<option value="${u.user_id}">${esc(u.name)}</option>`).join('')
  doerSelect.innerHTML = '<option value="">Doer</option>' +
    (doersRes.data || []).map(u => `<option value="${u.user_id}">${esc(u.name)}</option>`).join('')

  leadSelect.value = leadId
  doerSelect.value = doerId

  // Already self-scoped by role filter above — the dropdown would just
  // be a one-item no-op, so disable it rather than leave it misleading.
  if (role === 'pacer') { leadSelect.disabled = true; leadSelect.style.opacity = '0.4' }
  if (role === 'rover') { doerSelect.disabled = true; doerSelect.style.opacity = '0.4' }
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
    visible = applyFilters(visible, { scopeId, projectId: '', activeChipIds: new Set(), leadId: '', doerId: '' })
  }

  // Project + Lead + Doer + chips always apply, on top of whichever
  // status scope above
  visible = applyFilters(visible, { scopeId: null, projectId, activeChipIds, leadId, doerId })
  visible = sortByDueDate(visible)

  statusEl.textContent = `● Connected · ${visible.length} gig${visible.length !== 1 ? 's' : ''}`
  statusEl.className   = 'db-status ok'

  renderSummary(visible.length)

  const isFiltered = !!(urlStatus || scopeId !== 'open' || projectId || leadId || doerId || activeChipIds.size)
  tableWrap.style.display = isFiltered ? 'none'  : 'block'
  cardWrap.style.display  = isFiltered ? 'grid'  : 'none'

  if (isFiltered) renderCards(visible)
  else            renderTable(visible)
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
  if (leadId) {
    const opt = Array.from(leadSelect.options).find(o => o.value === leadId)
    if (opt) parts.push(opt.textContent)
  }
  if (doerId) {
    const opt = Array.from(doerSelect.options).find(o => o.value === doerId)
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
        <td onclick="event.stopPropagation()">${renderActionsMenu(g, session, { variant: 'row' })}</td>
      </tr>`
  }).join('')
}

function renderCards(visible) {
  if (!visible.length) {
    const canCreate = role !== 'rover'
    cardWrap.innerHTML = `<div class="empty-state" style="grid-column:1/-1">No gigs match these filters${canCreate ? ' — <a href="create_gig.html">create one</a>, or adjust the filters above' : ''}.</div>`
    return
  }

  cardWrap.innerHTML = visible.map(renderGigCard).join('')
}

function renderGigCard(g) {
  const projCode   = g.projects?.project_code || '—'
  const isTemplate = g.cadence === 'recurring' && g.recurrence_frequency === 'adhoc' && !g.parent_gig_id

  let primaryClick
  if (scopeId === 'masters' && isTemplate) {
    primaryClick = `createFromTemplate(this,'${g.gig_id}','${esc(g.gig_code)}')`
  } else if (urlStatus === 'delivered') {
    primaryClick = `goToEval('${g.gig_id}')`
  } else {
    primaryClick = `editGig('${g.gig_id}')`
  }

  return `
    <div class="vtm-picker-card status-${g.status || 'placed'}" onclick="${primaryClick}">
      <div class="vtm-picker-code">${esc(g.gig_code)}${isTemplate ? ' · Template' : ''}</div>
      <div class="vtm-picker-title">${esc(g.title)}</div>
      <div class="vtm-picker-meta">
        <span>${esc(projCode)} · ${fmtDate(g.date_due)}</span>
        <span class="status-label">${fmtStatus(g.status)}</span>
      </div>
      ${renderActionsMenu(g, session, { variant: 'card' })}
    </div>`
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
  if (leadId)    p.set('lead', leadId);       else p.delete('lead')
  if (doerId)    p.set('doer', doerId);       else p.delete('doer')
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

leadSelect.addEventListener('change', () => {
  leadId = leadSelect.value
  syncUrl()
  render()
})

doerSelect.addEventListener('change', () => {
  doerId = doerSelect.value
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

// advanceGigStage() and createFromTemplate() live in gig_actions.js (shared
// with project_index.js) — advanceGigStage doesn't know how to refresh
// this page's list itself, so it signals via this event instead.
window.addEventListener('vtm:gig-status-changed', () => loadGigs())

// ── HELPERS ───────────────────────────────────────────────────────────────

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadGigs()
populateLeadDoerOptions()
