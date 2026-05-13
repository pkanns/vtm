/**
 * create_rover.js — Vidai to Mulai · Rover Register
 * Page-specific logic only.
 * All DB calls via vtm_api.js · Connection via vtm_db.js
 */

import { db }                                          from './assets/vtm_db.js'
import { fetchRovers, saveRover, deleteRover,
         fetchRoverById }                              from './assets/vtm_api.js'
import { fmtDate, esc }                                from './assets/vtm_api.js'

const statusEl = document.getElementById('dbStatus')

// ── LOAD TABLE ────────────────────────────────────────────────────────────

async function loadRovers() {
  const { data, error } = await fetchRovers(db)

  if (error) {
    statusEl.textContent = 'Could not connect — check URL and key'
    statusEl.className = 'db-status err'
    return
  }

  statusEl.textContent = `● Connected · ${data.length} rover${data.length !== 1 ? 's' : ''}`
  statusEl.className = 'db-status ok'

  const tbody = document.getElementById('roverTableBody')
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">No rovers yet — add one above.</div></td></tr>'
    return
  }

  tbody.innerHTML = data.map(r => `
    <tr>
      <td><strong>${esc(r.name)}</strong></td>
      <td style="font-family:var(--font-mono);font-size:12px">${esc(r.email)}</td>
      <td style="text-transform:capitalize">${r.skill_level || '—'}</td>
      <td><span class="status-pill ${r.active ? 'active' : 'inactive'}">${r.active ? 'Active' : 'Inactive'}</span></td>
      <td style="color:var(--stone);font-size:12px">${fmtDate(r.created_at)}</td>
      <td>
        <button class="tbl-btn" onclick="editRover('${r.rover_id}')">Edit</button>
        <button class="tbl-btn danger" onclick="deleteRoverRow('${r.rover_id}','${esc(r.name)}')">Delete</button>
      </td>
    </tr>
  `).join('')
}

// ── SAVE ──────────────────────────────────────────────────────────────────

window.saveRoverForm = async function() {
  const name   = document.getElementById('roverName').value.trim()
  const email  = document.getElementById('roverEmail').value.trim()
  const skill  = document.getElementById('roverSkill').value
  const active = document.getElementById('roverActive').value === 'true'
  const editId = document.getElementById('editingId').value

  if (!name)  { showToast('Name is required',  'err'); return }
  if (!email) { showToast('Email is required', 'err'); return }

  const payload = { name, email, skill_level: skill, active }
  const { error } = await saveRover(db, payload, editId || null)

  if (error) {
    showToast(error.message.includes('unique') ? 'Email already exists' : 'Save failed — ' + error.message, 'err')
    return
  }

  showToast(editId ? 'Rover updated' : 'Rover added', 'ok')
  cancelEdit()
  loadRovers()
}

// ── EDIT ──────────────────────────────────────────────────────────────────

window.editRover = async function(id) {
  const { data, error } = await fetchRoverById(db, id)
  if (error || !data) { showToast('Could not load rover', 'err'); return }

  document.getElementById('editingId').value   = id
  document.getElementById('roverName').value   = data.name
  document.getElementById('roverEmail').value  = data.email
  document.getElementById('roverSkill').value  = data.skill_level || 'unskilled'
  document.getElementById('roverActive').value = data.active ? 'true' : 'false'
  document.getElementById('formTitle').textContent = 'Edit Rover'
  document.getElementById('roverName').focus()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// ── DELETE ────────────────────────────────────────────────────────────────

window.deleteRoverRow = async function(id, name) {
  if (!confirm(`Delete rover "${name}"? This cannot be undone.`)) return
  const { error } = await deleteRover(db, id)
  if (error) { showToast('Delete failed', 'err'); return }
  showToast('Rover deleted', 'ok')
  loadRovers()
}

// ── RESET ─────────────────────────────────────────────────────────────────

window.cancelEdit = function() {
  document.getElementById('editingId').value   = ''
  document.getElementById('roverName').value   = ''
  document.getElementById('roverEmail').value  = ''
  document.getElementById('roverSkill').value  = 'unskilled'
  document.getElementById('roverActive').value = 'true'
  document.getElementById('formTitle').textContent = 'Add New Rover'
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadRovers()
