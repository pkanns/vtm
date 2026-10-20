/**
 * gig_controls.js · Vidai to Mulai · Gig Controls
 * One sheet for Pinned / Frozen / Killed. Replaces gig_lifecycle.html and
 * time_recording_gigs.html.
 *
 * VIEWS
 *   Gigs (default)  filterable sheet with a checkbox column per control,
 *                   row selection and bulk actions.
 *   Projects        admin only. Per project counts plus the rare
 *                   "Freeze / Kill whole project" cascade.
 *
 * FILTERS (Gigs view): search, Project, Lead, Doer, Control state
 * (Live / Any / Pinned / Not pinned / Frozen / Killed), Period, Type
 * (admin: real gigs / masters / both) and a Stage strip with live counts.
 *
 * PERIOD (the dead wood finder)
 *   Window = today +/- N days (30, 60, 90, 180).
 *   Current   dates overlap the window, or the gig has no dates at all.
 *   Inactive  has dates, and they sit entirely outside the window.
 *   A gig's span is start..due; if only one date exists it is used for both.
 *   Filter to Inactive, tick the header box, then Freeze or Kill in bulk.
 *
 * WHO SEES WHAT
 *   Everyone  Pinned column and Pin/Unpin bulk, over their own live gigs.
 *   Admin     everything: all gigs incl. masters, completed and killed,
 *             Frozen/Killed columns, Projects view, bulk Freeze/Kill.
 *
 * RULES (unchanged)
 *   Pinned  live gigs only: not a master, not frozen, not killed, not completed.
 *   Frozen  reversible, never touches gigs.status.
 *   Killed  one way here: sets gigs.status='completed' plus a 'killed' row,
 *           reason required. Un-killing is a manual SQL job.
 */

import { db } from './vtm_db.js'
import { fetchGigs, fetchLifecycleMap, fetchLifecycleReasons,
         fetchPinnedGigIds, pinGig, unpinGig, freezeGig, unfreezeGig, killGig,
         freezeProjectGigs, killProjectGigs, fetchProjects,
         fetchActiveLeads, fetchActiveDoers, esc } from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }

const role    = session.role
const userId  = session.user_id
const isAdmin = role === 'admin'
if (isAdmin) document.body.classList.add('is-admin')

// ── STATE (declared before init) ──────────────────────────────────────────

const STAGES = ['placed', 'matched', 'aligned', 'in_progress', 'delivered', 'completed']
const DEFAULTS = { search: '', project: '', lead: '', doer: '', control: 'live', period: 'current', windowDays: 30, type: 'real', stage: '' }

let view      = 'gigs'
let f         = { ...DEFAULTS }
let allGigs   = []             // enriched rows
let pinnedIds = new Set()
let nameById  = {}
let projects  = []             // [{ project_id, project_code, project_name }]
let selected  = new Set()
let shownIds  = []             // gig ids currently displayed (for select-all)
let pending   = null           // modal action

const $ = id => document.getElementById(id)

// ── DATE HELPERS ──────────────────────────────────────────────────────────

const toISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const isoPlus = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return toISO(d) }
const daysBetween = (aISO, bISO) => Math.round((new Date(bISO + 'T00:00:00') - new Date(aISO + 'T00:00:00')) / 86400000)
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function fmtShort(iso, withYear) {
  if (!iso) return '·'
  const [y, m, d] = iso.split('-')
  return `${parseInt(d)} ${MONTHS[parseInt(m) - 1]}${withYear ? ' ' + y : ''}`
}

// ── ENRICHMENT ────────────────────────────────────────────────────────────

function enrich(g, lcMap) {
  const lifecycle = lcMap[g.gig_id] || null
  return {
    ...g,
    lifecycle,
    isMaster: g.cadence === 'recurring' && !g.parent_gig_id,
    isFrozen: lifecycle?.state === 'frozen',
    isKilled: lifecycle?.state === 'killed',
  }
}

const isPinned   = g => pinnedIds.has(g.gig_id)
const isPinnable = g => g.status !== 'completed' && !g.isMaster && !g.isFrozen && !g.isKilled

// 'current' | 'inactive'. Relies on f.windowDays.
function periodOf(g) {
  const s = g.date_start || g.date_due
  const e = g.date_due || g.date_start
  if (!s && !e) return 'current'                      // undated: can't be called dead
  const wStart = isoPlus(-f.windowDays), wEnd = isoPlus(f.windowDays)
  return (s <= wEnd && e >= wStart) ? 'current' : 'inactive'
}

// ── LOAD ──────────────────────────────────────────────────────────────────

async function load() {
  const st = $('dbStatus')
  st.textContent = 'Loading…'; st.className = ''

  const [gigsRes, lcRes, pinsRes, projRes, leadsRes, doersRes, usersRes] = await Promise.all([
    fetchGigs(db),
    fetchLifecycleMap(db),
    fetchPinnedGigIds(db, userId),
    fetchProjects(db),
    fetchActiveLeads(db),
    fetchActiveDoers(db),
    db.from('vtm_users').select('user_id, name'),
  ])

  if (gigsRes.error) { st.textContent = 'Could not load gigs: ' + gigsRes.error.message; st.className = 'err'; return }

  nameById = {}
  ;(usersRes.data || []).forEach(u => { nameById[u.user_id] = u.name })
  projects  = projRes.data || []
  pinnedIds = new Set((pinsRes.data || []).map(r => r.gig_id))

  let gigs = (gigsRes.data || []).map(g => enrich(g, lcRes.data || {}))

  if (!isAdmin) {
    // Same set the Timesheet pool uses: own, live, clockable
    gigs = gigs.filter(g => isPinnable(g) &&
      (role === 'pacer' ? g.pacer_id === userId : role === 'rover' ? g.rover_id === userId : true))
  }
  allGigs = gigs

  fillSelect('fProject', projects.map(p => [p.project_id, p.project_code]), 'All projects')
  fillSelect('fLead', (leadsRes.data || []).map(u => [u.user_id, u.name]), 'All leads')
  fillSelect('fDoer', (doersRes.data || []).map(u => [u.user_id, u.name]), 'All doers')
  if (role === 'pacer') { $('fLeadWrap').style.display = 'none' }
  if (role === 'rover') { $('fDoerWrap').style.display = 'none' }

  syncControls()
  render()
}

function fillSelect(id, pairs, allLabel) {
  const el = $(id), cur = el.value
  el.innerHTML = `<option value="">${allLabel}</option>` + pairs.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')
  el.value = cur
}

async function loadReasons() {
  const { data } = await fetchLifecycleReasons(db)
  $('lcReasonSuggestions').innerHTML = (data || []).map(r => `<option value="${esc(r.reason)}"></option>`).join('')
}

// ── FILTERING ─────────────────────────────────────────────────────────────

const CONTROL = {
  all:      () => true,
  live:     g => !g.isFrozen && !g.isKilled,
  pinned:   g => isPinned(g),
  unpinned: g => !isPinned(g),
  frozen:   g => g.isFrozen,
  killed:   g => g.isKilled,
}

// Everything except Period and Stage; the counts on those two are
// computed against this base so each shows what choosing it would give.
function baseFiltered() {
  const term = f.search.trim().toLowerCase()
  return allGigs.filter(g =>
    (!f.project || g.project_id === f.project) &&
    (!f.lead    || g.pacer_id === f.lead) &&
    (!f.doer    || g.rover_id === f.doer) &&
    (CONTROL[f.control] || CONTROL.live)(g) &&
    (f.type === 'both' || (f.type === 'masters' ? g.isMaster : !g.isMaster)) &&
    (!term || g.gig_code.toLowerCase().includes(term) || (g.title || '').toLowerCase().includes(term))
  )
}

const periodPass = g => f.period === 'all' || periodOf(g) === f.period

function dueSort(a, b) {
  const da = a.date_due || a.date_start, db_ = b.date_due || b.date_start
  if (!da && !db_) return a.gig_code.localeCompare(b.gig_code)
  if (!da) return 1
  if (!db_) return -1
  return da.localeCompare(db_) || a.gig_code.localeCompare(b.gig_code)
}

// ── RENDER ────────────────────────────────────────────────────────────────

function render() {
  if (view === 'projects') { renderProjects(); return }

  const base = baseFiltered()
  const inPeriod = base.filter(periodPass)
  const rows = inPeriod.filter(g => !f.stage || g.status === f.stage).sort(dueSort)
  shownIds = rows.map(g => g.gig_id)
  // drop selections that are no longer visible
  selected = new Set([...selected].filter(id => shownIds.includes(id)))

  renderStages(inPeriod)
  renderPeriodCounts(base)
  renderSummary(rows, base)
  renderRows(rows)
  renderBulk()
  markActiveFilters()
}

function renderStages(inPeriod) {
  const count = s => inPeriod.filter(g => g.status === s).length
  const label = s => s.replace('_', ' ')
  $('stages').innerHTML =
    `<button type="button" class="stg${!f.stage ? ' on' : ''}" onclick="setStage('')">All <b>${inPeriod.length}</b></button>` +
    STAGES.map(s => `<button type="button" class="stg s-${s}${f.stage === s ? ' on' : ''}" onclick="setStage('${s}')">${label(s)} <b>${count(s)}</b></button>`).join('') +
    `<button type="button" class="clear-link" onclick="clearFilters()">Clear filters</button>`
}

function renderPeriodCounts(base) {
  const cur = base.filter(g => periodOf(g) === 'current').length
  const ina = base.length - cur
  const sel = $('fPeriod')
  sel.options[0].textContent = `Current (${cur})`
  sel.options[1].textContent = `Inactive (${ina})`
  sel.options[2].textContent = `All (${base.length})`

  const dw = $('deadwood')
  if (f.period === 'current' && ina > 0) {
    dw.innerHTML = `${ina} gig${ina !== 1 ? 's' : ''} outside the ±${f.windowDays} day window are hidden. <button type="button" onclick="setPeriod('inactive')">Review dead wood</button>`
    dw.classList.add('show')
  } else if (f.period === 'inactive' && ina > 0) {
    dw.innerHTML = `Showing ${ina} inactive gig${ina !== 1 ? 's' : ''}, sorted oldest first. Tick the header box to select all, then Freeze or Kill. <button type="button" onclick="setPeriod('current')">Back to current</button>`
    dw.classList.add('show')
  } else dw.classList.remove('show')
}

function renderSummary(rows, base) {
  const st = $('dbStatus')
  st.className = 'ok'
  st.textContent = `● ${rows.length} gig${rows.length !== 1 ? 's' : ''} shown`
  const pinned = rows.filter(isPinned).length
  let line = `${pinned} pinned`
  if (isAdmin) line += ` · ${rows.filter(g => g.isFrozen).length} frozen · ${rows.filter(g => g.isKilled).length} killed`
  $('countLine').textContent = line
}

function datesCell(g) {
  const s = g.date_start, e = g.date_due
  if (!s && !e) return '<div class="dates">No dates</div>'
  const span = s && e ? `${fmtShort(s)} → ${fmtShort(e, true)}` : fmtShort(e || s, true)
  let note = ''
  if (periodOf(g) === 'inactive') {
    const end = e || s, start = s || e, t = isoPlus(0)
    if (end < t) note = `<small class="warn">ended ${daysBetween(end, t)}d ago</small>`
    else note = `<small>starts in ${daysBetween(t, start)}d</small>`
  } else if (e && e < isoPlus(0) && g.status !== 'completed') {
    note = `<small class="warn">overdue ${daysBetween(e, isoPlus(0))}d</small>`
  }
  return `<div class="dates">${span}${note}</div>`
}

function renderRows(rows) {
  const tbody = $('gigsBody')
  const cols = isAdmin ? 9 : 7
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${cols}"><div class="empty">${allGigs.length ? 'No gigs match these filters.' : 'No gigs available right now.'}</div></td></tr>`
    $('selAll').checked = false
    return
  }

  tbody.innerHTML = rows.map(g => {
    const sel = selected.has(g.gig_id)
    const pinOff = !isPinnable(g)
    const pinTip = g.isMaster ? 'Masters are never clockable' : g.isKilled ? 'Killed gig' : g.isFrozen ? 'Frozen gigs are not clockable' : g.status === 'completed' ? 'Completed gig' : ''
    const by = [g.lifecycle?.changed_by_name && `by ${g.lifecycle.changed_by_name}`, g.lifecycle?.changed_at && fmtShort(g.lifecycle.changed_at.slice(0, 10), true)].filter(Boolean).join(' · ')
    const why = (g.isFrozen || g.isKilled)
      ? `<div class="why"><b>${g.isKilled ? 'Killed' : 'Frozen'}</b>${esc(g.lifecycle.reason || 'No reason recorded')}${by ? ` · ${esc(by)}` : ''}</div>` : ''
    const tags = (g.isMaster ? '<span class="tag">Master</span>' : '') + (periodOf(g) === 'inactive' ? '<span class="tag stale">Inactive</span>' : '')

    const adminCells = isAdmin ? `
      <td class="c"><input type="checkbox" class="chk frz" ${g.isFrozen ? 'checked' : ''} ${g.isKilled ? 'disabled title="Killed gigs can\'t be frozen"' : ''} onchange="toggleFreeze('${g.gig_id}',this.checked)"></td>
      <td class="c"><input type="checkbox" class="chk kill" ${g.isKilled ? 'checked disabled title="No undo here. Reverting a kill is a manual SQL operation."' : ''} onchange="toggleKill('${g.gig_id}',this.checked)"></td>` : ''

    return `
      <tr class="${sel ? 'sel ' : ''}${g.isKilled ? 'is-killed' : g.isFrozen ? 'is-frozen' : ''}">
        <td class="c"><input type="checkbox" class="chk sel" ${sel ? 'checked' : ''} onchange="toggleSel('${g.gig_id}',this.checked)"></td>
        <td class="gig"><div class="g-code">${esc(g.gig_code)}${tags}</div><div class="g-title">${esc(g.title)}</div>${why}</td>
        <td class="hide-md" style="font-size:12px;color:var(--stone)">${esc(g.projects?.project_code || '·')}</td>
        <td class="hide-md ppl"><span>Lead</span>${esc(nameById[g.pacer_id] || '·')}<br><span>Doer</span>${esc(nameById[g.rover_id] || '·')}</td>
        <td><span class="status-pill ${g.status || 'placed'}">${(g.status || 'placed').replace('_', ' ')}</span></td>
        <td>${datesCell(g)}</td>
        <td class="c"><input type="checkbox" class="chk pin" ${isPinned(g) ? 'checked' : ''} ${pinOff ? `disabled title="${esc(pinTip)}"` : ''} onchange="togglePin('${g.gig_id}',this.checked)"></td>
        ${adminCells}
      </tr>`
  }).join('')

  const all = shownIds.length && shownIds.every(id => selected.has(id))
  $('selAll').checked = !!all
  $('selAll').indeterminate = !all && selected.size > 0
}

function markActiveFilters() {
  const mark = (id, on) => $(id)?.closest('.f')?.classList.toggle('active', on)
  mark('fSearch', !!f.search); mark('fProject', !!f.project); mark('fLead', !!f.lead); mark('fDoer', !!f.doer)
  mark('fControl', f.control !== 'live'); mark('fPeriod', f.period !== 'current'); mark('fType', f.type !== 'real')
}

function syncControls() {
  $('fSearch').value = f.search; $('fProject').value = f.project; $('fLead').value = f.lead; $('fDoer').value = f.doer
  $('fControl').value = f.control; $('fPeriod').value = f.period; $('fWindow').value = String(f.windowDays)
  if ($('fType')) $('fType').value = f.type
}

// ── FILTER EVENTS ─────────────────────────────────────────────────────────

const bind = (id, key, num) => $(id)?.addEventListener(id === 'fSearch' ? 'input' : 'change', e => { f[key] = num ? Number(e.target.value) : e.target.value; selected.clear(); render() })
bind('fSearch', 'search'); bind('fProject', 'project'); bind('fLead', 'lead'); bind('fDoer', 'doer')
bind('fControl', 'control'); bind('fPeriod', 'period'); bind('fWindow', 'windowDays', true); bind('fType', 'type')

window.setStage  = s => { f.stage = s; selected.clear(); render() }
window.setPeriod = p => { f.period = p; selected.clear(); syncControls(); render() }
window.clearFilters = () => { f = { ...DEFAULTS, windowDays: f.windowDays }; selected.clear(); syncControls(); render() }

// ── SELECTION + BULK ──────────────────────────────────────────────────────

window.toggleSel = (id, on) => { on ? selected.add(id) : selected.delete(id); renderRows(shownRows()); renderBulk() }
window.clearSel  = () => { selected.clear(); renderRows(shownRows()); renderBulk() }
$('selAll').addEventListener('change', e => {
  selected = e.target.checked ? new Set(shownIds) : new Set()
  renderRows(shownRows()); renderBulk()
})

const shownRows = () => shownIds.map(id => allGigs.find(g => g.gig_id === id)).filter(Boolean)
const selectedGigs = () => allGigs.filter(g => selected.has(g.gig_id))

function renderBulk() {
  $('bulk').classList.toggle('show', selected.size > 0)
  $('bulkN').textContent = `${selected.size} selected`
}

const chunk = (arr, n = 50) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

window.bulkPin = async function (pin) {
  const targets = selectedGigs().filter(g => pin ? (isPinnable(g) && !isPinned(g)) : isPinned(g)).map(g => g.gig_id)
  if (!targets.length) { showToast(pin ? 'Nothing to pin: only live, unpinned gigs can be pinned' : 'None of the selected gigs are pinned', 'err'); return }

  for (const ids of chunk(targets)) {
    const { error } = pin
      ? await db.from('timesheet_pinned_gigs').insert(ids.map(gig_id => ({ user_id: userId, gig_id })))
      : await db.from('timesheet_pinned_gigs').delete().eq('user_id', userId).in('gig_id', ids)
    if (error) { showToast('Could not update pins: ' + error.message, 'err'); await load(); return }
  }
  targets.forEach(id => pin ? pinnedIds.add(id) : pinnedIds.delete(id))
  showToast(`${targets.length} gig${targets.length !== 1 ? 's' : ''} ${pin ? 'pinned' : 'unpinned'}`, 'ok')
  selected.clear(); render()
}

window.bulkFreeze = function () {
  if (!isAdmin) return
  const ids = selectedGigs().filter(g => !g.isKilled && !g.isFrozen).map(g => g.gig_id)
  if (!ids.length) { showToast('Nothing to freeze: selected gigs are already frozen or killed', 'err'); return }
  openModal({ kind: 'freezeBulk', ids, label: `${ids.length} gig${ids.length !== 1 ? 's' : ''}` })
}

window.bulkKill = function () {
  if (!isAdmin) return
  const ids = selectedGigs().filter(g => !g.isKilled).map(g => g.gig_id)
  if (!ids.length) { showToast('Nothing to kill: selected gigs are already killed', 'err'); return }
  openModal({ kind: 'killBulk', ids, label: `${ids.length} gig${ids.length !== 1 ? 's' : ''}` })
}

async function bulkLifecycle(ids, state, reason) {
  const now = new Date().toISOString()
  for (const part of chunk(ids)) {
    const rows = part.map(gig_id => ({ gig_id, state, reason: reason || null, changed_by: userId, changed_at: now }))
    const { error } = await db.from('gig_lifecycle').upsert(rows)
    if (error) return { error }
    if (state === 'killed') {
      const { error: e2 } = await db.from('gigs').update({ status: 'completed' }).in('gig_id', part)
      if (e2) return { error: e2 }
    }
  }
  return { error: null }
}

// ── SINGLE ROW ACTIONS ────────────────────────────────────────────────────

window.togglePin = async function (gigId, checked) {
  const { error } = checked ? await pinGig(db, userId, gigId) : await unpinGig(db, userId, gigId)
  if (error) { showToast('Could not update: ' + error.message, 'err'); render(); return }
  checked ? pinnedIds.add(gigId) : pinnedIds.delete(gigId)
  showToast(checked ? 'Pinned' : 'Unpinned', 'ok')
  render()
}

window.toggleFreeze = async function (gigId, checked) {
  if (!isAdmin) return
  const g = allGigs.find(x => x.gig_id === gigId)
  if (checked) { openModal({ kind: 'freeze', id: gigId, label: g?.gig_code }); return }
  const { error } = await unfreezeGig(db, gigId)
  if (error) { showToast('Could not unfreeze: ' + error.message, 'err'); render(); return }
  showToast(`${g?.gig_code} unfrozen`, 'ok')
  await load()
}

window.toggleKill = function (gigId, checked) {
  if (!isAdmin) return
  if (!checked) { render(); return }
  const g = allGigs.find(x => x.gig_id === gigId)
  openModal({ kind: 'kill', id: gigId, label: g?.gig_code })
}

// ── PROJECTS VIEW (admin) ─────────────────────────────────────────────────

function renderProjects() {
  const wrap = $('projectsList')
  const by = new Map()
  allGigs.filter(g => !g.isMaster || true).forEach(g => {
    if (!g.project_id) return
    if (!by.has(g.project_id)) by.set(g.project_id, { id: g.project_id, code: g.projects?.project_code || '·', name: g.projects?.project_name || '', open: 0, frozen: 0, killed: 0, inactive: 0 })
    const p = by.get(g.project_id)
    if (g.isKilled) { p.killed++; return }
    if (g.status === 'completed') return
    p.open++
    if (g.isFrozen) p.frozen++
    if (periodOf(g) === 'inactive') p.inactive++
  })

  const list = [...by.values()].filter(p => p.open || p.frozen || p.killed).sort((a, b) => a.code.localeCompare(b.code))
  if (!list.length) { wrap.innerHTML = '<div class="empty">No projects with open gigs.</div>'; return }

  wrap.innerHTML = list.map(p => `
    <div class="proj${p.frozen ? ' has-frozen' : ''}">
      <div><div class="pc">${esc(p.code)}</div><div class="pn">${esc(p.name)}</div></div>
      <div class="pk">
        <div><b>${p.open}</b>open</div>
        <div><b class="${p.inactive ? 'warn' : ''}">${p.inactive}</b>inactive</div>
        <div><b>${p.frozen}</b>frozen</div>
        <div><b>${p.killed}</b>killed</div>
      </div>
      <div class="pa">
        <button type="button" class="lc-btn pri" onclick="viewProject('${p.id}')">View gigs</button>
        <button type="button" class="lc-btn" ${p.open ? '' : 'disabled'} onclick="projectAction('freezeProject','${p.id}')">Freeze project</button>
        <button type="button" class="lc-btn danger" ${p.open ? '' : 'disabled'} onclick="projectAction('killProject','${p.id}')">Kill project</button>
      </div>
    </div>`).join('')
}

window.viewProject = function (id) {
  f = { ...DEFAULTS, windowDays: f.windowDays, project: id, period: 'all' }
  selected.clear(); syncControls(); setView('gigs')
}

window.projectAction = function (kind, id) {
  const p = projects.find(x => x.project_id === id)
  const openCount = allGigs.filter(g => g.project_id === id && g.status !== 'completed' && !g.isKilled).length
  openModal({ kind, id, label: p?.project_code || 'project', openCount })
}

function setView(v) {
  view = v
  $('gigsView').style.display = v === 'gigs' ? 'block' : 'none'
  $('projectsView').style.display = v === 'projects' ? 'block' : 'none'
  $(v === 'gigs' ? 'v-gigs' : 'v-projects').checked = true
  render()
}
document.querySelectorAll('input[name="view"]').forEach(r => r.addEventListener('change', () => setView(r.value)))

// ── REASON MODAL ──────────────────────────────────────────────────────────

function openModal(action) {
  pending = action
  const { kind, label, openCount, ids } = action
  const title = $('lcModalTitle'), sub = $('lcModalSub'), input = $('lcModalReasonInput'), btn = $('lcModalConfirmBtn')
  input.value = ''
  $('lcModalError').classList.remove('visible')
  sub.classList.remove('danger')

  const n = openCount, pl = n !== 1 ? 's' : ''
  const copy = {
    freeze:        [`Freeze ${label}`, 'Fully reversible. Reason is optional.', 'Freeze', false],
    kill:          [`Kill ${label}`, 'Sets this gig to Completed. No undo button. Reason is required.', 'Kill', true],
    freezeBulk:    [`Freeze ${label}`, 'Fully reversible per gig. Reason is optional and applies to all of them.', 'Freeze', false],
    killBulk:      [`Kill ${label}`, 'Sets every one to Completed. No undo button. Reason is required and applies to all of them.', 'Kill', true],
    freezeProject: [`Freeze ${label}`, `Freezes all ${n} open gig${pl} in this project. Reason is optional.`, 'Freeze project', false],
    killProject:   [`Kill ${label}`, `Sets all ${n} open gig${pl} in this project to Completed. No undo button. Reason is required.`, 'Kill project', true],
  }[kind]

  title.textContent = copy[0]; sub.textContent = copy[1]; btn.textContent = copy[2]
  if (copy[3]) sub.classList.add('danger')
  $('lcModalOverlay').classList.add('open')
  input.focus()
}

window.closeLcModal = function () {
  $('lcModalOverlay').classList.remove('open')
  pending = null
  render()   // a cancelled tick returns its checkbox to the saved state
}

window.confirmLcModal = async function () {
  if (!pending) return
  const input = $('lcModalReasonInput')
  const reason = input.value.trim()
  const { kind, id, ids, label } = pending
  const needsReason = kind === 'kill' || kind === 'killBulk' || kind === 'killProject'
  if (needsReason && !reason) { $('lcModalError').classList.add('visible'); input.focus(); return }

  $('lcModalOverlay').classList.remove('open')
  pending = null

  let res, msg
  if (kind === 'freeze')            { res = await freezeGig(db, id, userId, reason); msg = `${label} frozen` }
  else if (kind === 'kill')         { res = await killGig(db, id, userId, reason); msg = `${label} killed` }
  else if (kind === 'freezeBulk')   { res = await bulkLifecycle(ids, 'frozen', reason); msg = `${ids.length} gigs frozen` }
  else if (kind === 'killBulk')     { res = await bulkLifecycle(ids, 'killed', reason); msg = `${ids.length} gigs killed` }
  else if (kind === 'freezeProject'){ res = await freezeProjectGigs(db, id, userId, reason); msg = `${res?.count ?? 0} gigs in ${label} frozen` }
  else                              { res = await killProjectGigs(db, id, userId, reason); msg = `${res?.count ?? 0} gigs in ${label} killed` }

  if (res?.error) showToast('Could not complete: ' + res.error.message, 'err')
  else showToast(msg, 'ok')

  selected.clear()
  await load()
}

$('lcModalReasonInput').addEventListener('keydown', e => { if (e.key === 'Enter') window.confirmLcModal() })
$('lcModalOverlay').addEventListener('click', e => { if (e.target.id === 'lcModalOverlay') window.closeLcModal() })

// ── INIT ──────────────────────────────────────────────────────────────────

load()
if (isAdmin) loadReasons()
