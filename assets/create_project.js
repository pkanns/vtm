/**
 * create_project.js — Vidai to Mulai · Create / Edit Project
 * Admin and pacer roles only.
 * Saves project + categories to Supabase.
 * Edit mode: load via ?project_id=xxx
 */

import { db }                        from './vtm_db.js'
import { saveProject, fetchProjectById,
         saveCategoriesBulk,
         deleteCategoriesByProject,
         fetchCategoriesByProject }  from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session  = vtmGetSession()
const role     = session?.role || null

if (!session) {
  window.location.href = 'login.html'
  throw new Error('No session')
}

if (role === 'rover') {
  showToast('Doers cannot create projects', 'err')
  setTimeout(() => { window.location.href = 'index.html' }, 1200)
  throw new Error('Rover blocked')
}

// ── EDIT MODE ─────────────────────────────────────────────────────────────

const urlProjectId = new URLSearchParams(window.location.search).get('project_id')
const isEditMode   = !!urlProjectId

// ── CATEGORY ROW COUNTER ──────────────────────────────────────────────────

let catRowId = 0

// ── LOAD FOR EDIT ─────────────────────────────────────────────────────────

async function loadProjectForEdit(id) {
  const [projRes, catsRes] = await Promise.all([
    fetchProjectById(db, id),
    fetchCategoriesByProject(db, id)
  ])

  if (projRes.error || !projRes.data) {
    showToast('Could not load project', 'err')
    return
  }

  const p = projRes.data

  document.getElementById('projectCode').value = p.project_code || ''
  document.getElementById('projectCode').style.textTransform = 'uppercase'
  document.getElementById('projectName').value = p.project_name || ''
  document.getElementById('projectDesc').value = p.description  || ''

  // Lock code in edit mode — code is immutable once set
  document.getElementById('projectCode').disabled = true
  document.getElementById('projectCode').title    = 'Project code cannot be changed after creation'

  document.getElementById('formTitle').textContent    = `Edit · ${p.project_code}`
  document.getElementById('formSubtitle').textContent = p.project_name
  document.getElementById('editBanner').classList.add('visible')
  document.getElementById('saveBtn').textContent      = 'Update Project →'

  // Load existing categories
  const tbody = document.getElementById('catBody')
  tbody.innerHTML = ''
  catRowId = 0
  ;(catsRes.data || []).forEach(c => addCatRow(c.category_code, c.category_name, c.category_id))

  updatePreview()
}

// ── CATEGORY ROW ──────────────────────────────────────────────────────────

window.addCatRow = function(code, name, dbId) {
  const tbody = document.getElementById('catBody')
  const id    = ++catRowId
  const tr    = document.createElement('tr')
  tr.id = 'cat-' + id
  if (dbId) tr.dataset.categoryId = dbId

  tr.innerHTML = `
    <td><input type="text" class="cat-input code" placeholder="e.g. AUTH" maxlength="8" value="${esc(code || '')}" oninput="updateRowPreview(${id})"></td>
    <td><input type="text" class="cat-input" placeholder="e.g. Authentication" value="${esc(name || '')}"></td>
    <td><span class="cat-preview" id="cprev-${id}">—</span></td>
    <td><button type="button" class="del-btn" onclick="removeCatRow('cat-${id}')">×</button></td>
  `
  tbody.appendChild(tr)
  updateRowPreview(id)
}

window.removeCatRow = function(rowId) {
  const row = document.getElementById(rowId)
  if (row) row.remove()
}

window.updateRowPreview = function(id) {
  const row      = document.getElementById('cat-' + id)
  if (!row) return
  const code     = (row.querySelector('.code')?.value || '').toUpperCase().trim()
  const projCode = document.getElementById('projectCode').value.toUpperCase().trim()
  const prev     = document.getElementById('cprev-' + id)
  if (prev) prev.textContent = (projCode && code) ? `${projCode}_${code}_O_001` : '—'
}

window.updatePreview = function() {
  const code = document.getElementById('projectCode').value.toUpperCase().trim()
  document.getElementById('previewCode').textContent  = code || '—'
  document.getElementById('previewSample').textContent = code ? `${code}_AUTH_O_001` : '—'
  document.querySelectorAll('#catBody tr').forEach(tr => {
    const id = tr.id.replace('cat-', '')
    if (id) updateRowPreview(parseInt(id))
  })
}

// ── COLLECT CATEGORIES FROM TABLE ────────────────────────────────────────

function getCategoryRows() {
  const rows = []
  document.querySelectorAll('#catBody tr').forEach(tr => {
    const code = (tr.querySelector('.code')?.value || '').toUpperCase().trim()
    const name = (tr.querySelectorAll('.cat-input')[1]?.value || '').trim()
    if (code && name) rows.push({ category_code: code, category_name: name })
  })
  return rows
}

// ── SAVE ──────────────────────────────────────────────────────────────────

window.saveProjectForm = async function() {
  const code = document.getElementById('projectCode').value.toUpperCase().trim()
  const name = document.getElementById('projectName').value.trim()
  const desc = document.getElementById('projectDesc').value.trim()
  const btn  = document.getElementById('saveBtn')

  if (!code) { showToast('Project Code is required', 'err'); return }
  if (!name) { showToast('Project Name is required', 'err'); return }

  const categories = getCategoryRows()
  if (!categories.length) {
    showToast('Add at least one category', 'err')
    return
  }

  btn.disabled    = true
  btn.textContent = 'Saving…'

  const payload = {
    project_code: code,
    project_name: name,
    description:  desc || null,
  }

  // Save or update project
  const { data: saved, error: projErr } = await saveProject(db, payload, urlProjectId || null)

  if (projErr) {
    const msg = projErr.message?.includes('unique')
      ? `Project code "${code}" already exists`
      : 'Save failed — ' + projErr.message
    showToast(msg, 'err')
    btn.disabled    = false
    btn.textContent = isEditMode ? 'Update Project →' : 'Save Project →'
    return
  }

  const projectId = isEditMode
    ? urlProjectId
    : (Array.isArray(saved) ? saved[0]?.project_id : saved?.project_id)

  // In edit mode — delete existing categories then re-save all
  // This handles renames, deletions and additions in one pass
  if (isEditMode) {
    await deleteCategoriesByProject(db, projectId)
  }

  const { error: catErr } = await saveCategoriesBulk(db, projectId, categories)

  if (catErr) {
    showToast('Project saved but categories failed — ' + catErr.message, 'err')
    btn.disabled    = false
    btn.textContent = isEditMode ? 'Update Project →' : 'Save Project →'
    return
  }

  showToast(`${code} ${isEditMode ? 'updated' : 'saved'}`, 'ok')
  setTimeout(() => { window.location.href = 'project_index.html' }, 1200)
}

// ── RESET ─────────────────────────────────────────────────────────────────

window.cancelForm = function() {
  if (isEditMode) { window.location.href = 'project_index.html'; return }
  document.getElementById('projectCode').value = ''
  document.getElementById('projectName').value = ''
  document.getElementById('projectDesc').value = ''
  document.getElementById('catBody').innerHTML = ''
  catRowId = 0
  updatePreview()
  addCatRow()
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── INIT ──────────────────────────────────────────────────────────────────

if (isEditMode) {
  await loadProjectForEdit(urlProjectId)
} else {
  addCatRow()
  updatePreview()
}
