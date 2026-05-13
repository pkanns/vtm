/**
 * create_pacer.js — Vidai to Mulai · Pacer Register
 * Page-specific logic only.
 * All DB calls via vtm_api.js · Connection via vtm_db.js
 */

import { db }                                          from './assets/vtm_db.js'
import { fetchPacers, savePacer, deletePacer,
         fetchPacerById }                              from './assets/vtm_api.js'
import { fmtDate, esc }                                from './assets/vtm_api.js'

const statusEl = document.getElementById('dbStatus')

// ── LOAD TABLE ────────────────────────────────────────────────────────────

async function loadPacers() {
  const { data, error } = await fetchPacers(db)

  if (error) {
    statusEl.textContent = 'Could not connect — check URL and key'
    statusEl.className = 'db-status err'
    return
  }

  statusEl.textContent = `● Connected · ${data.length} pacer${data.length !== 1 ? 's' : ''}`
  statusEl.className = 'db-status ok'

  const tbody = document.getElementById('pacerTableBody')
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">No pacers yet — add one above.</div></td></tr>'
    return
  }

  tbody.innerHTML = data.map(p => `
    <tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td style="font-family:var(--font-mono);font-size:12px">${esc(p.email)}</td>
      <td style="font-family:var(--font-mono);font-size:12px">${esc(p.phone || '—')}</td>
      <td><span class="status-pill ${p.active ? 'active' : 'inactive'}">${p.active ? 'Active' : 'Inactive'}</span></td>
      <td style="color:var(--stone);font-size:12px">${fmtDate(p.created_at)}</td>
      <td>
        <button class="tbl-btn" onclick="editPacer('${p.pacer_id}')">Edit</button>
        <button class="tbl-btn danger" onclick="deletePacerRow('${p.pacer_id}','${esc(p.name)}')">Delete</button>
      </td>
    </tr>
  `).join('')
}

// ── SAVE ──────────────────────────────────────────────────────────────────

window.savePacerForm = async function() {
  const name   = document.getElementById('pacerName').value.trim()
  const email  = document.getElementById('pacerEmail').value.trim()
  const phone  = document.getElementById('pacerPhone').value.trim()
  const active = document.getElementById('pacerActive').value === 'true'
  const editId = document.getElementById('editingId').value

  if (!name)  { showToast('Name is required',  'err'); return }
  if (!email) { showToast('Email is required', 'err'); return }

  const payload = { name, email, phone: phone || null, active }
  const { error } = await savePacer(db, payload, editId || null)

  if (error) {
    showToast(error.message.includes('unique') ? 'Email already exists' : 'Save failed — ' + error.message, 'err')
    return
  }

  showToast(editId ? 'Pacer updated' : 'Pacer added', 'ok')
  cancelEdit()
  loadPacers()
}

// ── EDIT ──────────────────────────────────────────────────────────────────

window.editPacer = async function(id) {
  const { data, error } = await fetchPacerById(db, id)
  if (error || !data) { showToast('Could not load pacer', 'err'); return }

  document.getElementById('editingId').value   = id
  document.getElementById('pacerName').value   = data.name
  document.getElementById('pacerEmail').value  = data.email
  document.getElementById('pacerPhone').value  = data.phone || ''
  document.getElementById('pacerActive').value = data.active ? 'true' : 'false'
  document.getElementById('formTitle').textContent = 'Edit Pacer'
  document.getElementById('pacerName').focus()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// ── DELETE ────────────────────────────────────────────────────────────────

window.deletePacerRow = async function(id, name) {
  if (!confirm(`Delete pacer "${name}"? This cannot be undone.`)) return
  const { error } = await deletePacer(db, id)
  if (error) { showToast('Delete failed', 'err'); return }
  showToast('Pacer deleted', 'ok')
  loadPacers()
}

// ── RESET ─────────────────────────────────────────────────────────────────

window.cancelEdit = function() {
  document.getElementById('editingId').value   = ''
  document.getElementById('pacerName').value   = ''
  document.getElementById('pacerEmail').value  = ''
  document.getElementById('pacerPhone').value  = ''
  document.getElementById('pacerActive').value = 'true'
  document.getElementById('formTitle').textContent = 'Add New Pacer'
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadPacers()
