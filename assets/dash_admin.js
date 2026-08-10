/**
 * dash_admin.js — Vidai to Mulai · Dashboard Admin
 * Admin-only. Each checkbox auto-saves on toggle — no separate Save
 * button, matching how task completion and other simple toggles already
 * work elsewhere in the app.
 */

import { db } from './vtm_db.js'
import { fetchDashboardPages, addDashboardPage,
         updateDashboardPageVisibility, deleteDashboardPage,
         esc }                            from './vtm_api.js'

// ── SESSION — vtm_admin_guard.js already redirects non-admins away;
// this is just the data-layer guard so nothing fetches before that
// redirect has a chance to fire. ──────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.href = 'login.html'; throw new Error('No session') }
if (session.role !== 'admin') throw new Error('Admin only')

// ── STATE ─────────────────────────────────────────────────────────────────

let allPages = []

// ── LOAD ──────────────────────────────────────────────────────────────────

async function loadPages() {
  const statusEl = document.getElementById('dbStatus')
  statusEl.textContent = 'Loading…'
  statusEl.className   = 'db-status'

  const { data, error } = await fetchDashboardPages(db)

  if (error) {
    statusEl.textContent = 'Could not load — ' + error.message
    statusEl.className   = 'db-status err'
    return
  }

  allPages = data || []
  statusEl.textContent = `● ${allPages.length} page${allPages.length !== 1 ? 's' : ''} configured`
  statusEl.className   = 'db-status ok'
  renderTable()
}

// ── RENDER ────────────────────────────────────────────────────────────────

function renderTable() {
  const body = document.getElementById('pagesBody')

  if (!allPages.length) {
    body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--stone);padding:24px;">No pages registered yet — add one below.</td></tr>'
    return
  }

  body.innerHTML = allPages.map(p => `
    <tr data-page-id="${p.page_id}">
      <td>
        <div class="page-label">${esc(p.label)}</div>
        <div class="page-url">${esc(p.url)}${p.description ? ' · ' + esc(p.description) : ''}</div>
      </td>
      <td class="center"><input type="checkbox" class="config-check" ${p.visible_admin ? 'checked' : ''} onchange="toggleVisibility('${p.page_id}','visible_admin',this.checked)"></td>
      <td class="center"><input type="checkbox" class="config-check" ${p.visible_pacer ? 'checked' : ''} onchange="toggleVisibility('${p.page_id}','visible_pacer',this.checked)"></td>
      <td class="center"><input type="checkbox" class="config-check" ${p.visible_rover ? 'checked' : ''} onchange="toggleVisibility('${p.page_id}','visible_rover',this.checked)"></td>
      <td class="center"><button class="row-del" onclick="removePage('${p.page_id}','${esc(p.label)}')" title="Remove">×</button></td>
    </tr>`).join('')
}

// ── TOGGLE (auto-save) ──────────────────────────────────────────────────

window.toggleVisibility = async function(pageId, field, value) {
  const { error } = await updateDashboardPageVisibility(db, pageId, field, value)
  if (error) { showToast('Could not save — ' + error.message, 'err'); return }
  const p = allPages.find(x => x.page_id === pageId)
  if (p) p[field] = value
  showToast('Saved', 'ok')
}

// ── ADD ───────────────────────────────────────────────────────────────────

window.addPage = async function() {
  const label = document.getElementById('newLabel').value.trim()
  const url   = document.getElementById('newUrl').value.trim()
  const desc  = document.getElementById('newDesc').value.trim()

  if (!label) { showToast('Label is required', 'err'); return }
  if (!url)   { showToast('URL is required', 'err'); return }

  const payload = {
    label,
    url,
    description:   desc || null,
    sort_order:    (allPages.length ? Math.max(...allPages.map(p => p.sort_order || 0)) : 0) + 10,
    visible_admin: false,
    visible_pacer: false,
    visible_rover: false,
  }

  const { error } = await addDashboardPage(db, payload)
  if (error) { showToast('Could not add — ' + error.message, 'err'); return }

  document.getElementById('newLabel').value = ''
  document.getElementById('newUrl').value   = ''
  document.getElementById('newDesc').value  = ''

  showToast(`${label} added — check the roles that should see it`, 'ok')
  await loadPages()
}

// ── REMOVE ────────────────────────────────────────────────────────────────

window.removePage = async function(pageId, label) {
  if (!confirm(`Remove "${label}" from the dashboard config? This cannot be undone.`)) return
  const { error } = await deleteDashboardPage(db, pageId)
  if (error) { showToast('Could not remove — ' + error.message, 'err'); return }
  showToast(`${label} removed`, 'ok')
  await loadPages()
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadPages()
