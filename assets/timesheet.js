/**
 * timesheet.js — Vidai to Mulai · Timesheet
 * Rewritten: toggle Auto/Manual, project→gig cascade,
 * Open Timesheets (null end_time), midnight-safe duration via DB,
 * auto-close guard on sign-out, owner+admin edit.
 *
 * Added: ?start=auto URL support — the dashboard's Clock block links here
 * with that flag when the person isn't clocked in yet, so this page drops
 * them straight into the Auto panel instead of the blank toggle state.
 *
 * MASTER GIGS: a "master" gig (cadence:'recurring' with no parent_gig_id
 * — covers both true adhoc templates and scheduled recurring parents) is
 * never itself clockable — only the instances spawned from it are real,
 * workable gigs. fetchClockableGigs() (vtm_api.js) excludes masters at
 * the source, shared with Time Recording Gigs, so neither page can drift.
 *
 * Added: task checklist + plain logged-hours line at clock-out and manual
 * save time (see loadTaskChecklist()/loadLoggedHours() below). No schema
 * change — reads existing gig_tasks (via fetchTasksByGig) and time_entries
 * (via fetchLoggedMinutesForGig) as they already exist. Ticking a task
 * here calls the same toggleTaskDone() used everywhere else in the app;
 * there's no separate "touched" state, just done/not done.
 */

import { db } from './vtm_db.js'
import { fetchTasksByGig, toggleTaskDone, fetchLoggedMinutesForGig,
         fetchClockableGigs, fetchPinnedGigIds, esc as apiEsc } from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

const userId   = session.user_id
const isAdmin  = session.role === 'admin'
const TODAY    = new Date().toISOString().split('T')[0]

// ── STATE ─────────────────────────────────────────────────────────────────

let activeEntry   = null
let allEntries    = []
let openEntries   = []
let currentFilter = null   // null = no range picked yet — Time Log stays empty until asked for
let gigMap        = {}   // gig_id → { code, title, project_id, status, date_due }
let projectMap    = {}   // project_id → { code, name }
let editingEntryId = null // entry_id currently open for editing in the Time Log
let pinnedGigIds  = new Set()   // gig_ids pinned via Time Recording Gigs — shown within the fold
let showingMore   = false        // whether the collapsed "rest of your gigs" pool is expanded

// Drag/tap + geolocation state — deliberately declared here, at the very
// top, rather than near the functions that use them. checkActiveTimer()
// and initGigPoolDrag() both run as part of the synchronous init sequence
// below, and if any of these were still declared further down the file
// as `let`, referencing them before that later line had executed would
// throw "Cannot access before initialization" (the temporal dead zone) —
// which is exactly the bug that shipped here once already and silently
// aborted the rest of page setup on every load. Consolidating all
// module-level state up here removes that whole category of ordering
// bug regardless of where a given function is defined.
let armed          = null    // { kind: 'gig', gigId } | { kind: 'zone' } | null
let dragState      = null    // { kind, gigId?, moved }
let committing     = false   // guards against a double clock-in submit
let cachedLocation = null    // { lat, lng, label, timestamp } | null
const LOCATION_MAX_AGE_MS = 30000

// ── INIT ─────────────────────────────────────────────────────────────────
// Loading is staged by priority. Clocking in/out is the whole point of this
// page, so checkActiveTimer() — one small query — runs alone, first, and
// everything else that touches the Auto/Manual panels waits for it. Gigs,
// pins, projects, and Open Timesheets load right after, in parallel, but
// don't block the active-timer render. The historical Time Log is the
// heaviest query on this page and is genuinely optional most visits, so
// it's not fetched at all until the person picks a range — see
// setFilter() / loadCompletedEntries() / renderLogEmptyState().

document.getElementById('manualDate').value = TODAY

buildPunchStrip()
initToggle()
initGigPoolDrag()
patchSignOut()

await checkActiveTimer()
applyStartParam()

Promise.all([loadGigs(), loadPinnedGigIds()]).then(() => {
  renderGigPool()
  loadProjects()
})
loadOpenEntries()
renderLogEmptyState()

// ── ?start=auto — hand-off from the dashboard's Clock block ───────────────
// Only applies if there isn't already an active timer (matches what
// picking "Auto" manually would do anyway — it's blocked while clocked in).

function applyStartParam() {
  const startParam = new URLSearchParams(window.location.search).get('start')
  if (startParam !== 'auto' || activeEntry) return

  const autoRadio = document.getElementById('tog-auto')
  if (!autoRadio) return
  autoRadio.checked = true
  showEntryPanel('auto')
}

// ── PUNCH STRIP (decorative — mirrors the mulai.ch register motif) ────────

function buildPunchStrip() {
  const strip = document.getElementById('topPunchStrip')
  if (!strip) return
  const pattern = [1,0,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,0,1,1,0,2,0,1,0,0,1,0,1]
  for (let s = 0; s < 2; s++) {
    const div = document.createElement('div')
    div.className = 'punch-holes' + (s === 1 ? ' punch-holes-2' : '')
    for (let r = 0; r < 6; r++) {
      pattern.forEach(p => {
        const h = document.createElement('div')
        h.className = 'hole' + (p === 1 ? ' punched' : p === 2 ? ' punched red' : '')
        div.appendChild(h)
      })
    }
    strip.appendChild(div)
  }
}

// ── PATCH SIGN-OUT to warn about active timer ─────────────────────────────

function patchSignOut() {
  window._vtmSignOutOriginal = window.vtmSignOut
  window.vtmSignOut = async function() {
    if (activeEntry) {
      const go = confirm('You have an active timer running. Sign out anyway? The timer will keep running and auto-close after 24 hours.')
      if (!go) return
    }
    await window._vtmSignOutOriginal()
  }
}

// ── TOGGLE INIT ───────────────────────────────────────────────────────────

function initToggle() {
  document.querySelectorAll('input[name="tog-entry"]').forEach(radio => {
    radio.addEventListener('change', onToggleChange)
  })
  // Start with nothing shown
  showEntryPanel(null)
}

function onToggleChange() {
  const val = getToggle('tog-entry')
  showEntryPanel(val)
}

function showEntryPanel(mode) {
  const autoPanel   = document.getElementById('autoPanel')
  const manualPanel = document.getElementById('manualPanel')
  const blocked     = document.getElementById('manualBlocked')

  autoPanel.style.display   = 'none'
  manualPanel.style.display = 'none'
  if (blocked) blocked.style.display = 'none'

  if (mode === 'auto') {
    // Auto blocked if already clocked in
    if (activeEntry) {
      showToast('Already clocked in — clock out first', 'err')
      // Deselect toggle
      document.querySelectorAll('input[name="tog-entry"]').forEach(r => r.checked = false)
      return
    }
    autoPanel.style.display = 'block'
    clearArmed()
    prefetchLocation()
  }

  if (mode === 'manual') {
    manualPanel.style.display = 'block'
  }
}

// ── LOAD PROJECTS ─────────────────────────────────────────────────────────

async function loadProjects() {
  const { data, error } = await db
    .from('projects')
    .select('project_id, project_code, project_name')
    .order('project_code')

  if (error || !data?.length) return

  // Doers and leads only see projects that contain at least one of their own
  // gigs — the gig dropdown was already scoped in loadGigs(), this keeps the
  // project filter from ever pointing them at a project with nothing in it.
  let visible = data
  if (!isAdmin) {
    const ownProjectIds = new Set(Object.values(gigMap).map(g => g.project_id))
    visible = data.filter(p => ownProjectIds.has(p.project_id))
  }

  projectMap = {}
  visible.forEach(p => { projectMap[p.project_id] = { code: p.project_code, name: p.project_name } })

  const blankOpt = '<option value="">— All Projects —</option>'
  const opts = blankOpt + visible.map(p =>
    `<option value="${p.project_id}">${esc(p.project_code)} · ${esc(p.project_name)}</option>`
  ).join('')

  const manualProj = document.getElementById('manualProject')
  if (manualProj) manualProj.innerHTML = opts
}

// ── LOAD GIGS ─────────────────────────────────────────────────────────────

async function loadGigs() {
  const { data, error } = await fetchClockableGigs(db, session.role, userId)
  if (error || !data?.length) return

  gigMap = {}
  data.forEach(g => {
    gigMap[g.gig_id] = { code: g.gig_code, title: g.title, project_id: g.project_id, status: g.status, date_due: g.date_due }
  })

  populateGigDropdown('manualGig', null)
}

async function loadPinnedGigIds() {
  const { data, error } = await fetchPinnedGigIds(db, userId)
  if (error) { pinnedGigIds = new Set(); return }
  pinnedGigIds = new Set((data || []).map(r => r.gig_id))
}

function populateGigDropdown(selectId, projectId) {
  const select = document.getElementById(selectId)
  if (!select) return

  const gigs = Object.entries(gigMap)
    .filter(([, g]) => !projectId || g.project_id === projectId)
    .map(([id, g]) => ({ id, ...g }))

  if (!gigs.length) {
    select.innerHTML = '<option value="">— No gigs —</option>'
    return
  }

  select.innerHTML = '<option value="">— Select Gig —</option>' +
    gigs.map(g => `<option value="${g.id}">${esc(g.code)} · ${esc(g.title)}</option>`).join('')
}

// Project filter cascades to gig dropdown
window.onProjectChange = function(sourceId, targetId) {
  const projectId = document.getElementById(sourceId).value || null
  populateGigDropdown(targetId, projectId)
}

// Gig select → mini "Card No." + status display in the panel header
window.updateCardNo = function(gigSelectId, cardNoTargetId, statusTargetId) {
  const gigId = document.getElementById(gigSelectId)?.value
  const target = document.getElementById(cardNoTargetId)
  const status = statusTargetId ? document.getElementById(statusTargetId) : null
  if (!target) return
  const gig = gigId ? gigMap[gigId] : null
  target.textContent = gig ? gig.code : '— : —'
  if (status) status.textContent = gig ? '● Ready' : '○ Awaiting'
}

// ── DRAG-TO-CLOCK-IN (Auto panel) ───────────────────────────────────────
// Pointer-events based rather than native HTML5 drag-and-drop, so the
// exact same code path handles mouse AND touch. Two ways to clock in,
// both wired through the same pointerdown/pointermove/pointerup
// listeners:
//   - Press-and-drag a gig card onto the Clock In zone, or drag the zone
//     onto a card, then release.
//   - Tap a card to arm it, then tap the zone to commit — or tap the
//     zone first, then tap a card. No continuous hold needed.
// A pointerdown that never moves is treated as a tap (arm/commit); one
// that moves is treated as a genuine drag. Cards use the same
// .vtm-picker-card component as Gig Index / Gig Eval — no new card look,
// just a new way to act on it.

function renderGigPool() {
  const pool    = document.getElementById('autoGigPool')
  const morePool = document.getElementById('autoGigPoolMore')
  const moreBtn  = document.getElementById('autoShowMoreBtn')
  if (!pool || !morePool || !moreBtn) return

  clearArmed()

  const gigs   = Object.entries(gigMap).map(([id, g]) => ({ id, ...g }))
  const pinned = gigs.filter(g => pinnedGigIds.has(g.id))
  const rest   = gigs.filter(g => !pinnedGigIds.has(g.id))

  if (!gigs.length) {
    pool.innerHTML = '<div class="empty-state">No gigs available to clock into.</div>'
    moreBtn.style.display  = 'none'
    morePool.style.display = 'none'
    morePool.innerHTML     = ''
    return
  }

  pool.innerHTML = pinned.length
    ? pinned.map(gigCardHTML).join('')
    : '<div class="empty-state">No gigs pinned yet — <a href="time_recording_gigs.html">manage which show up here</a>, or tap "Show more gigs" below.</div>'

  if (rest.length) {
    moreBtn.style.display  = 'block'
    moreBtn.textContent    = showingMore ? 'Show fewer gigs' : `Show more gigs (${rest.length})`
    morePool.innerHTML     = rest.map(gigCardHTML).join('')
    morePool.style.display = showingMore ? 'grid' : 'none'
  } else {
    moreBtn.style.display  = 'none'
    morePool.style.display = 'none'
    morePool.innerHTML     = ''
  }
}

function gigCardHTML(g) {
  return `
    <div class="vtm-picker-card status-${g.status || 'placed'}" data-gig-id="${g.id}">
      <div class="vtm-picker-code">${esc(g.code)}</div>
      <div class="vtm-picker-title">${esc(g.title)}</div>
      <div class="vtm-picker-meta">
        <span>${g.date_due ? fmtDate(g.date_due) : 'No due date'}</span>
        <span class="status-label">${fmtStatus(g.status)}</span>
      </div>
    </div>`
}

window.toggleShowMoreGigs = function() {
  showingMore = !showingMore
  renderGigPool()
}

function fmtStatus(s) {
  return (s || 'placed').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// Wired once, on the wrap that contains BOTH the pinned pool and the
// collapsed "rest" pool — cards are re-rendered by renderGigPool() and
// toggleShowMoreGigs() on every reload/expand, so this listens via event
// delegation on the stable parent rather than on individual cards.

function initGigPoolDrag() {
  const wrap = document.getElementById('autoGigPoolWrap')
  const zone = document.getElementById('autoDropzone')
  if (!wrap || !zone) return

  wrap.addEventListener('pointerdown', e => {
    const card = e.target.closest('.vtm-picker-card')
    if (card) startDrag('gig', card, e)
  })
  zone.addEventListener('pointerdown', e => startDrag('zone', zone, e))

  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)

  wrap.addEventListener('click', e => {
    if (dragState) return   // a real drag just ended — the trailing click isn't a tap
    const card = e.target.closest('.vtm-picker-card')
    if (card) onTap('gig', card)
  })
  zone.addEventListener('click', e => {
    if (dragState) return
    onTap('zone', zone)
  })
}

function startDrag(kind, el, e) {
  dragState = { kind, gigId: kind === 'gig' ? el.dataset.gigId : null, moved: false, el }
  el.setPointerCapture?.(e.pointerId)
  el.classList.add(kind === 'gig' ? 'drag-source' : 'busy')
}

function onPointerMove(e) {
  if (!dragState) return
  dragState.moved = true

  const ghost = document.getElementById('dragGhost')
  ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`
  if (!ghost.innerHTML) {
    ghost.innerHTML = dragState.kind === 'gig'
      ? dragState.el.outerHTML
      : '<div class="vtm-picker-card status-matched" style="border-top-color:var(--red)"><div class="vtm-picker-title">Clock In</div></div>'
    ghost.style.opacity = '0.92'
  }

  const zone = document.getElementById('autoDropzone')
  const under = document.elementFromPoint(e.clientX, e.clientY)

  if (dragState.kind === 'gig') {
    zone.classList.toggle('drag-over', !!under && zone.contains(under))
  } else {
    document.querySelectorAll('#autoGigPoolWrap .vtm-picker-card').forEach(card => {
      card.classList.toggle('armed', !!under && card.contains(under))
    })
  }
}

function onPointerUp(e) {
  if (!dragState) return
  const zone = document.getElementById('autoDropzone')
  const under = document.elementFromPoint(e.clientX, e.clientY)

  if (dragState.moved) {
    if (dragState.kind === 'gig' && under && zone.contains(under)) {
      commitClockIn(dragState.gigId)
    } else if (dragState.kind === 'zone' && under) {
      const card = under.closest('.vtm-picker-card')
      if (card) commitClockIn(card.dataset.gigId)
    }
  }

  cleanupDrag()
}

function cleanupDrag() {
  const ghost = document.getElementById('dragGhost')
  ghost.style.opacity = '0'
  ghost.innerHTML = ''

  document.querySelectorAll('#autoGigPoolWrap .vtm-picker-card').forEach(c => c.classList.remove('drag-source', 'armed'))
  const zone = document.getElementById('autoDropzone')
  zone.classList.remove('drag-over', 'busy')

  const stateWasDrag = dragState?.moved
  dragState = null
  // A completed drag already resolved (or missed) the drop — clear any
  // tap-armed state too so a stray tap-arm doesn't linger afterward.
  if (stateWasDrag) clearArmed()
}

function onTap(kind, el) {
  if (kind === 'gig') {
    const gigId = el.dataset.gigId
    if (armed?.kind === 'zone') { commitClockIn(gigId); return }
    if (armed?.kind === 'gig' && armed.gigId === gigId) { clearArmed(); return }
    armGig(gigId)
  } else {
    if (armed?.kind === 'gig') { commitClockIn(armed.gigId); return }
    if (armed?.kind === 'zone') { clearArmed(); return }
    armZone()
  }
}

function armGig(gigId) {
  clearArmed()
  armed = { kind: 'gig', gigId }
  const card = document.querySelector(`#autoGigPoolWrap .vtm-picker-card[data-gig-id="${gigId}"]`)
  card?.classList.add('armed')
  const zone = document.getElementById('autoDropzone')
  zone.classList.add('drag-over')
  document.getElementById('autoZoneLabel').textContent = 'Tap here to clock in'
  updateAutoHeader(gigId)
}

function armZone() {
  clearArmed()
  armed = { kind: 'zone' }
  document.getElementById('autoDropzone').classList.add('armed')
  document.getElementById('autoZoneLabel').textContent = 'Tap a gig to clock in'
}

function clearArmed() {
  document.querySelectorAll('#autoGigPoolWrap .vtm-picker-card').forEach(c => c.classList.remove('armed'))
  const zone = document.getElementById('autoDropzone')
  zone.classList.remove('armed', 'drag-over')
  document.getElementById('autoZoneLabel').textContent = 'Drag a gig here to clock in'
  armed = null
  updateAutoHeader(null)
}

function updateAutoHeader(gigId) {
  const gig = gigId ? gigMap[gigId] : null
  document.getElementById('autoCardNo').textContent = gig ? gig.code : '— : —'
  document.getElementById('autoCardStatus').textContent = gig ? '● Ready' : '○ Awaiting'
}

// ── LOCATION CACHE ───────────────────────────────────────────────────────
// The actual cause of clock-in/out feeling slow: getCurrentPosition() with
// no maximumAge forces a brand-new GPS/network fix from scratch every
// single time, which routinely takes 2-8s on a phone, especially indoors
// — and the DB write only happens AFTER that resolves. Two changes fix
// this together:
//   1. maximumAge lets a recent fix (<30s old) be reused instantly rather
//      than re-acquired every time.
//   2. prefetchLocation() kicks the request off ahead of the actual
//      commit — when the Auto panel opens, and again right after a
//      successful clock-in (anticipating the eventual clock-out) — so by
//      the time someone actually taps/drops, resolveLocation() usually
//      just returns the already-resolved cache instead of waiting on
//      anything.
// Falls back to a real (still capped) request on a cold start, same
// timeout as before — this never blocks longer than the old behavior,
// it just very often doesn't have to wait at all.
// (LOCATION_MAX_AGE_MS and cachedLocation are declared in the STATE
// block at the top of the file — see the note there on why.)

function prefetchLocation() {
  navigator.geolocation.getCurrentPosition(
    pos => {
      cachedLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        label: `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`,
        timestamp: Date.now(),
      }
    },
    () => { cachedLocation = { lat: null, lng: null, label: 'Denied', timestamp: Date.now() } },
    { timeout: 8000, maximumAge: LOCATION_MAX_AGE_MS }
  )
}

async function resolveLocation() {
  if (cachedLocation && (Date.now() - cachedLocation.timestamp) < LOCATION_MAX_AGE_MS) {
    return cachedLocation
  }
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000, maximumAge: LOCATION_MAX_AGE_MS })
    })
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      label: `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`,
      timestamp: Date.now(),
    }
  } catch {
    return { lat: null, lng: null, label: 'Denied', timestamp: Date.now() }
  }
}

// (committing is declared in the STATE block at the top of the file)

async function commitClockIn(gigId) {
  if (!gigId || !gigMap[gigId]) return
  if (activeEntry) { showToast('Already clocked in — clock out first', 'err'); clearArmed(); return }
  if (committing) return
  committing = true

  const zone  = document.getElementById('autoDropzone')
  const label = document.getElementById('autoZoneLabel')
  zone.classList.add('busy')
  zone.classList.remove('armed', 'drag-over')
  label.textContent = 'Clocking in…'

  const loc = await resolveLocation()

  const now = new Date()
  const payload = {
    gig_id:         gigId,
    user_id:        userId,
    entry_date:     TODAY,
    start_time:     now.toTimeString().slice(0, 5),
    entry_type:     'live',
    is_active:      true,
    clock_in_lat:   loc.lat,
    clock_in_lng:   loc.lng,
    location_label: loc.label,
    notes:          null,   // notes are added from the active-timer card after clock-in instead
  }

  const { data, error } = await db.from('time_entries').insert(payload).select().single()

  zone.classList.remove('busy')

  if (error) {
    showToast('Clock in failed — ' + error.message, 'err')
    clearArmed()
    committing = false
    return
  }

  activeEntry = { ...data, gigs: { gig_code: gigMap[gigId].code, title: gigMap[gigId].title } }
  showActiveTimer(activeEntry)

  zone.classList.add('success')
  label.textContent = `Clocked in — ${gigMap[gigId].code}`
  showToast('Clocked in ✓', 'ok')

  armed = null
  committing = false
  document.querySelectorAll('input[name="tog-entry"]').forEach(r => r.checked = false)
  showEntryPanel(null)
}

// ── TASK CHECKLIST + LOGGED HOURS (clock-out / manual save context) ───────
// No schema changes here. loadTaskChecklist() reads the gig's existing
// open tasks (fetchTasksByGig) so a Doer can check one off in the same
// motion as logging time — ticking calls the same toggleTaskDone() used
// on the gig edit page and Task Register, nothing new. loadLoggedHours()
// sums existing time_entries for the gig — a plain number, no target, no
// bar, just enough context to write an honest note by.

async function loadTaskChecklist(gigId, containerId) {
  const container = document.getElementById(containerId)
  if (!container) return
  if (!gigId) { container.innerHTML = ''; return }

  const { data, error } = await fetchTasksByGig(db, gigId)
  if (error) { container.innerHTML = ''; return }

  const open = (data || []).filter(t => !t.done)
  if (!open.length) {
    container.innerHTML = '<div class="ts-task-empty">No open tasks on this gig.</div>'
    return
  }

  container.innerHTML = `
    <div class="ts-task-label">Tasks on this gig</div>
    ${open.map(t => `
      <label class="ts-task-row">
        <input type="checkbox" onchange="checkOffTask('${t.task_id}', this)">
        <span>${esc(t.title)}</span>
      </label>`).join('')}`
}

window.checkOffTask = async function(taskId, checkbox) {
  checkbox.disabled = true
  const { error } = await toggleTaskDone(db, taskId, true)
  if (error) {
    showToast('Could not update task', 'err')
    checkbox.disabled = false
    checkbox.checked  = false
    return
  }
  const row = checkbox.closest('.ts-task-row')
  if (row) row.style.opacity = '0.5'
  showToast('Task marked done', 'ok')
}

async function loadLoggedHours(gigId, elId) {
  const el = document.getElementById(elId)
  if (!el) return
  if (!gigId) { el.textContent = ''; return }

  const mins = await fetchLoggedMinutesForGig(db, gigId)
  el.textContent = mins ? `${fmtDuration(mins)} logged on this gig so far` : 'No time logged on this gig yet'
}

window.onManualGigChange = function() {
  const gigId = document.getElementById('manualGig').value
  loadTaskChecklist(gigId, 'manualTaskChecklist')
  loadLoggedHours(gigId, 'manualLoggedHours')
}

// ── CHECK ACTIVE TIMER ────────────────────────────────────────────────────

async function checkActiveTimer() {
  const { data } = await db
    .from('time_entries')
    .select('*, gigs(gig_code, title)')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle()

  if (data) {
    activeEntry = data
    showActiveTimer(data)
  } else {
    hideActiveTimer()
  }
}

function showActiveTimer(entry) {
  const gig    = entry.gigs || gigMap[entry.gig_id] || {}
  const code   = gig.gig_code || gig.code || '—'
  const title  = gig.title    || '—'
  const timeIn = entry.start_time ? entry.start_time.slice(0,5) : '—'

  const card = document.getElementById('activeTimerBlock')
  document.getElementById('timerGigCode').textContent  = code
  document.getElementById('timerGigTitle').textContent = title
  document.getElementById('timerClockIn').textContent  = timeIn

  const notesEl = document.getElementById('activeNotes')
  notesEl.value = entry.notes || ''

  card.style.display = 'block'

  const pill  = document.getElementById('headerTimerPill')
  const label = document.getElementById('headerTimerLabel')
  if (pill)  pill.classList.add('visible')
  if (label) label.textContent = `In · ${timeIn}`

  loadTaskChecklist(entry.gig_id, 'timerTaskChecklist')
  loadLoggedHours(entry.gig_id, 'timerLoggedHours')
  prefetchLocation()   // get ready for the eventual clock-out
}

function hideActiveTimer() {
  document.getElementById('activeTimerBlock').style.display = 'none'
  document.getElementById('activeNotes').value = ''

  const pill = document.getElementById('headerTimerPill')
  if (pill) pill.classList.remove('visible')
  activeEntry = null
  cachedLocation = null
}

// ── CLOCK IN — see commitClockIn() in the drag-to-clock-in section above ──

// ── CLOCK OUT ─────────────────────────────────────────────────────────────

window.clockOut = async function() {
  if (!activeEntry) return

  const btn = document.getElementById('clockOutBtn')
  btn.disabled    = true
  btn.textContent = 'Clocking out…'

  const loc = await resolveLocation()

  const now     = new Date()
  const endTime = now.toTimeString().slice(0,5)
  const notes   = document.getElementById('activeNotes')?.value.trim() || activeEntry.notes || null

  // No duration calc — DB generated column handles it including midnight crossover
  const { error } = await db
    .from('time_entries')
    .update({
      end_time:      endTime,
      is_active:     false,
      clock_out_lat: loc.lat,
      clock_out_lng: loc.lng,
      notes:         notes,
    })
    .eq('entry_id', activeEntry.entry_id)

  if (error) {
    showToast('Clock out failed — ' + error.message, 'err')
    btn.disabled    = false
    btn.textContent = 'Clock Out →'
    return
  }

  showToast('Clocked out ✓', 'ok')
  hideActiveTimer()
  await refreshLogs()
}

// ── MANUAL SAVE ───────────────────────────────────────────────────────────

window.saveManual = async function() {
  const gigId = document.getElementById('manualGig').value
  const date  = document.getElementById('manualDate').value
  const start = document.getElementById('manualStart').value
  const end   = document.getElementById('manualEnd').value     // optional
  const notes = document.getElementById('manualNotes').value.trim()

  if (!gigId) { showToast('Please select a gig',       'err'); return }
  if (!date)  { showToast('Please enter a date',       'err'); return }
  if (!start) { showToast('Please enter a start time', 'err'); return }

  const btn = document.getElementById('manualSaveBtn')
  btn.disabled    = true
  btn.textContent = 'Saving…'

  if (editingEntryId) {
    const { error } = await db.from('time_entries').update({
      gig_id:     gigId,
      entry_date: date,
      start_time: start,
      end_time:   end || null,
      notes:      notes || null,
      entry_type: 'manual',
    }).eq('entry_id', editingEntryId)

    if (error) {
      showToast('Update failed — ' + error.message, 'err')
      btn.disabled    = false
      btn.textContent = 'Save Changes →'
      return
    }

    showToast('Entry updated ✓', 'ok')
    resetManual()
    await refreshLogs()
    return
  }

  const { error } = await db.from('time_entries').insert({
    gig_id:     gigId,
    user_id:    userId,
    entry_date: date,
    start_time: start,
    end_time:   end   || null,
    entry_type: 'manual',
    is_active:  false,
    notes:      notes || null,
  })

  if (error) {
    showToast('Save failed — ' + error.message, 'err')
    btn.disabled    = false
    btn.textContent = 'Save →'
    return
  }

  showToast(end ? 'Time logged ✓' : 'Entry saved — add end time later ✓', 'ok')
  btn.disabled    = false
  btn.textContent = 'Save →'
  resetManual()
  await refreshLogs()
}

// ── EDIT OPEN ENTRY (save updated times/notes) ────────────────────────────

window.saveOpenEntry = async function(entryId) {
  const startEl = document.getElementById(`oe-start-${entryId}`)
  const endEl   = document.getElementById(`oe-end-${entryId}`)
  const dateEl  = document.getElementById(`oe-date-${entryId}`)
  const notesEl = document.getElementById(`oe-notes-${entryId}`)

  const start = startEl?.value || null
  const end   = endEl?.value   || null
  const date  = dateEl?.value  || null
  const notes = notesEl?.value.trim() || null

  if (!start) { showToast('Start time required', 'err'); return }

  const btn = document.getElementById(`oe-btn-${entryId}`)
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…' }

  const { error } = await db
    .from('time_entries')
    .update({
      entry_date: date,
      start_time: start,
      end_time:   end || null,
      notes:      notes,
    })
    .eq('entry_id', entryId)

  if (error) {
    showToast('Update failed — ' + error.message, 'err')
    if (btn) { btn.disabled = false; btn.textContent = 'Save →' }
    return
  }

  showToast(end ? 'Entry completed ✓' : 'Entry updated ✓', 'ok')
  await refreshLogs()
}

// ── LOAD ENTRIES ──────────────────────────────────────────────────────────
// Split in two, deliberately:
//
//   loadOpenEntries()      — entries missing an end_time. Small, and
//                            actionable (they need finishing), so this
//                            loads eagerly alongside gigs/projects — not
//                            gated behind a filter pick.
//
//   loadCompletedEntries() — the actual historical log. This is the
//                            expensive query on the page, and most visits
//                            to Timesheet are "clock in" or "clock out",
//                            not "review my history" — so nothing here is
//                            fetched until the person explicitly picks a
//                            range (see setFilter()). The query itself is
//                            date-bounded server-side per range, rather
//                            than fetching everything and filtering in
//                            the browser.
//
// refreshLogs() is the shared "something changed" entry point: open
// entries always get refreshed (any save could add/remove one), the
// completed log only refreshes if a range is currently being viewed.

async function loadOpenEntries() {
  let query = db
    .from('time_entries')
    .select('*, gigs(gig_code, title)')
    .eq('is_active', false)
    .is('end_time', null)
    .order('entry_date', { ascending: false })

  if (!isAdmin) query = query.eq('user_id', userId)

  const { data, error } = await query
  if (error) return   // Open Timesheets section just stays hidden — non-critical path

  openEntries = data || []
  renderOpenEntries()
}

function getFilterStartDate(filter) {
  const now = new Date(); now.setHours(0, 0, 0, 0)
  if (filter === 'week') {
    const start = new Date(now)
    const day = start.getDay()
    start.setDate(start.getDate() + ((day === 0) ? -6 : 1 - day))
    return start
  }
  if (filter === 'month') return new Date(now.getFullYear(), now.getMonth(), 1)
  return null   // 'all' — no lower bound
}

async function loadCompletedEntries(filter) {
  const statusEl = document.getElementById('dbStatus')
  statusEl.textContent = 'Loading…'
  statusEl.className   = 'db-status'

  let query = db
    .from('time_entries')
    .select('*, gigs(gig_code, title)')
    .eq('is_active', false)
    .not('end_time', 'is', null)
    .order('entry_date', { ascending: false })
    .order('start_time', { ascending: false })

  if (!isAdmin) query = query.eq('user_id', userId)

  const startDate = getFilterStartDate(filter)
  if (startDate) query = query.gte('entry_date', startDate.toISOString().split('T')[0])

  const { data, error } = await query

  if (error) {
    statusEl.textContent = 'Could not load entries'
    statusEl.className   = 'db-status err'
    allEntries = []
    return
  }

  allEntries = data || []
  statusEl.textContent = `● ${allEntries.length} entr${allEntries.length !== 1 ? 'ies' : 'y'}`
  statusEl.className   = 'db-status ok'
}

async function refreshLogs() {
  await loadOpenEntries()
  if (currentFilter) await loadCompletedEntries(currentFilter)
  renderEntries()
}

function renderLogEmptyState() {
  const list = document.getElementById('logList')
  list.innerHTML = '<div class="empty-state">Select a range above to view your time log.</div>'
  document.getElementById('dbStatus').textContent = 'No range selected'
  document.getElementById('dbStatus').className   = 'db-status'
  document.getElementById('logTotalLabel').textContent = 'Time Log'
  document.getElementById('weekTotal').textContent = '—'
}

// ── RENDER OPEN TIMESHEETS ────────────────────────────────────────────────

function renderOpenEntries() {
  const container = document.getElementById('openEntriesBody')
  if (!container) return

  const section = document.getElementById('openSection')

  if (!openEntries.length) {
    if (section) section.style.display = 'none'
    return
  }

  if (section) section.style.display = 'block'

  container.innerHTML = openEntries.map(e => {
    const gig      = e.gigs || {}
    const code     = gig.gig_code || '—'
    const isAuto   = e.entry_type === 'live'
    const autoNote = e.notes?.includes('Auto-closed') ? '<span class="auto-closed-badge">Auto-closed</span>' : ''

    return `
      <div class="open-entry" id="open-${e.entry_id}">
        <div class="open-entry-header">
          <span class="gig-code-pill">${esc(code)}</span>
          <span class="open-entry-title">${esc(gig.title || '')}</span>
          ${autoNote}
          <span class="type-badge ${isAuto ? 'live' : 'manual'}">${isAuto ? 'live' : 'manual'}</span>
        </div>
        <div class="open-entry-fields">
          <div class="form-row">
            <label>Date</label>
            <input type="date" id="oe-date-${e.entry_id}" value="${e.entry_date || ''}">
          </div>
          <div class="form-row">
            <label>Start</label>
            <input type="time" id="oe-start-${e.entry_id}" value="${(e.start_time || '').slice(0,5)}">
          </div>
          <div class="form-row">
            <label>End</label>
            <input type="time" id="oe-end-${e.entry_id}" value="${(e.end_time || '').slice(0,5)}">
          </div>
          <div class="form-row open-notes">
            <label>Notes</label>
            <input type="text" id="oe-notes-${e.entry_id}" value="${esc(e.notes || '')}" placeholder="What did you work on?">
          </div>
        </div>
        <div class="open-entry-actions">
          <button class="btn-save" id="oe-btn-${e.entry_id}" onclick="saveOpenEntry('${e.entry_id}')">Save →</button>
          <button class="btn-delete" onclick="deleteEntry('${e.entry_id}')">Delete</button>
        </div>
      </div>`
  }).join('')
}

// ── RENDER COMPLETED LOG ──────────────────────────────────────────────────

function renderEntries() {
  const list = document.getElementById('logList')

  if (!currentFilter) { renderLogEmptyState(); return }

  // Total + label match whichever period is currently selected — not always "this week"
  const totalMins = allEntries.reduce((sum, e) => sum + (e.duration_mins || 0), 0)
  const periodLabel = currentFilter === 'week' ? 'This week' : currentFilter === 'month' ? 'This month' : 'All time'
  document.getElementById('logTotalLabel').textContent = periodLabel
  document.getElementById('weekTotal').textContent = fmtDuration(totalMins)

  if (!allEntries.length) {
    list.innerHTML = `<div class="empty-state">No completed entries${currentFilter !== 'all' ? ' for this period' : ''}.</div>`
    return
  }

  list.innerHTML = allEntries.map(e => {
    const gig  = e.gigs || {}
    const code = gig.gig_code || '—'
    const dur  = e.duration_mins ? fmtDuration(e.duration_mins) : '—'
    const type = e.entry_type === 'live' ? 'live' : 'manual'
    const loc  = e.location_label || null
    const d    = new Date(e.entry_date)
    const dow  = d.toLocaleDateString(undefined, { weekday: 'short' })
    const dnum = fmtDate(e.entry_date)
    const active = e.entry_id === editingEntryId

    return `
      <div class="log-entry${active ? ' log-entry-editing' : ''}">
        <div class="log-entry-date"><span class="dow">${esc(dow)}</span>${esc(dnum)}</div>
        <div class="log-entry-main">
          <div class="log-entry-gig">
            <span class="log-entry-code">${esc(code)}</span> ${esc(gig.title || '')}
            ${type === 'manual' ? '<span class="log-entry-flag">manual</span>' : ''}
          </div>
          <div class="log-entry-meta">
            <span>${fmtTime(e.start_time)}–${fmtTime(e.end_time)}</span>
            ${loc ? `<span>${esc(loc)}</span>` : ''}
          </div>
          ${e.notes ? `<div class="log-entry-notes">${esc(e.notes)}</div>` : ''}
        </div>
        <div class="log-entry-right">
          <div class="log-entry-duration">${dur}</div>
          <div class="row-actions">
            <button class="btn-edit" onclick="editEntry('${e.entry_id}')">${active ? 'Editing…' : 'Edit'}</button>
            <button class="btn-delete" onclick="deleteEntry('${e.entry_id}')">×</button>
          </div>
        </div>
      </div>`
  }).join('')
}

// ── EDIT COMPLETED ENTRY ──────────────────────────────────────────────────
// Opens the same Manual Entry panel used to create entries, pre-filled with
// this entry's data — per design decision, editing should look and feel
// exactly like logging a manual entry, not a separate compact form. Save
// then updates instead of inserting (see saveManual()).

window.editEntry = async function(entryId) {
  const entry = allEntries.find(e => e.entry_id === entryId)
  if (!entry) return

  // Live (auto clock-in/out) entries can't be updated as-is — the database
  // restricts edits to manual entries. Editing one converts it to manual,
  // but only with the person's explicit go-ahead.
  const wasLive = entry.entry_type === 'live'
  if (wasLive) {
    const ok = confirm('This is a live-clocked entry — editing it will convert it to manual. Continue?')
    if (!ok) return
  }

  editingEntryId = entryId

  // Switch to the Manual tab and open its panel
  const manualRadio = document.getElementById('tog-manual')
  if (manualRadio) manualRadio.checked = true
  showEntryPanel('manual')

  // loadGigs() only loads gigs that aren't completed (and excludes master
  // gigs) to keep the "add new entry" dropdowns clean — but an existing
  // entry can point at a gig that's since been marked complete. If that
  // gig isn't in gigMap, fetch it and add it in just for this edit;
  // otherwise the Gig field can't be pre-selected and Save silently
  // blocks on "please select a gig".
  let gig = gigMap[entry.gig_id]
  if (!gig) {
    const { data, error } = await db
      .from('gigs')
      .select('gig_id, gig_code, title, project_id')
      .eq('gig_id', entry.gig_id)
      .single()
    gig = (!error && data)
      ? { code: data.gig_code, title: data.title, project_id: data.project_id }
      : {}
    if (!error && data) gigMap[entry.gig_id] = gig
  }

  document.getElementById('manualProject').value = gig.project_id || ''
  populateGigDropdown('manualGig', gig.project_id || null)
  document.getElementById('manualGig').value = entry.gig_id || ''
  updateCardNo('manualGig', 'manualCardNo', 'manualCardStatus')
  onManualGigChange()

  document.getElementById('manualDate').value  = entry.entry_date || ''
  document.getElementById('manualStart').value = (entry.start_time || '').slice(0,5)
  document.getElementById('manualEnd').value   = (entry.end_time   || '').slice(0,5)
  document.getElementById('manualNotes').value = entry.notes || ''

  // Relabel the panel so it reads as an edit, not a new entry
  document.getElementById('manualPanelAction').textContent   = 'Edit Entry'
  document.getElementById('manualPanelSubtitle').textContent = wasLive
    ? 'Converting a live-clocked entry to manual — update the details and save'
    : 'Editing a logged entry — update the details and save'
  document.getElementById('manualSaveBtn').textContent  = 'Save Changes →'
  document.getElementById('manualClearBtn').textContent = 'Cancel'

  renderEntries() // reflect the "Editing…" state on the row
  document.getElementById('manualPanel').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── FILTER ────────────────────────────────────────────────────────────────

window.setFilter = async function(filter) {
  currentFilter = filter
  document.querySelectorAll('.week-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter)
  })
  await loadCompletedEntries(filter)
  renderEntries()
}

// ── DELETE ────────────────────────────────────────────────────────────────

window.deleteEntry = async function(id) {
  if (!confirm('Delete this time entry?')) return
  const { error } = await db.from('time_entries').delete().eq('entry_id', id)
  if (error) { showToast('Delete failed', 'err'); return }
  showToast('Entry deleted', 'ok')
  await refreshLogs()
}

// ── RESET MANUAL FORM ─────────────────────────────────────────────────────

window.resetManual = function() {
  const wasEditing = !!editingEntryId

  document.getElementById('manualProject').value = ''
  populateGigDropdown('manualGig', null)
  document.getElementById('manualDate').value  = TODAY
  document.getElementById('manualStart').value = ''
  document.getElementById('manualEnd').value   = ''
  document.getElementById('manualNotes').value = ''
  updateCardNo('manualGig', 'manualCardNo', 'manualCardStatus')
  document.getElementById('manualTaskChecklist').innerHTML = ''
  document.getElementById('manualLoggedHours').textContent = ''

  editingEntryId = null
  document.getElementById('manualPanelAction').textContent   = 'Manual Entry'
  document.getElementById('manualPanelSubtitle').textContent = 'Log time worked — end time is optional, entry stays open until added'
  document.getElementById('manualSaveBtn').textContent  = 'Save →'
  document.getElementById('manualSaveBtn').disabled     = false
  document.getElementById('manualClearBtn').textContent = 'Clear'

  // "Cancel" (leaving an edit) collapses the panel again; "Clear" while
  // adding a fresh entry just wipes the fields and stays open.
  if (wasEditing) {
    document.querySelectorAll('input[name="tog-entry"]').forEach(r => r.checked = false)
    showEntryPanel(null)
    renderEntries()
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function getToggle(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`)
  return checked ? checked.value : null
}

function fmtDuration(mins) {
  if (!mins && mins !== 0) return '—'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function fmtDate(iso) {
  if (!iso) return '—'
  const [y, mo, d] = iso.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${parseInt(d)} ${months[parseInt(mo)-1]} ${y}`
}

function fmtTime(t) {
  if (!t) return '—'
  return t.slice(0,5)
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
