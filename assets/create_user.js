/**
 * create_user.js — Vidai to Mulai · Create / Edit User
 * Admin only — uses Edge Functions for ALL user creation/editing.
 * Email invite: sends invite email with password setup link (create only).
 * Google/Microsoft: creates auth user + vtm_users record in one call.
 * Editing goes through update-user, which verifies the caller is an admin
 * itself (via their session token) — not just relying on this page's guard.
 * No direct database inserts/updates from frontend for anything Auth-related.
 */

import { db } from './vtm_db.js'

const INVITE_FUNCTION_URL = 'https://dbecwjhsewucqtfgoylv.supabase.co/functions/v1/invite-user'
const UPDATE_FUNCTION_URL = 'https://dbecwjhsewucqtfgoylv.supabase.co/functions/v1/update-user'
const SUPABASE_ANON_KEY   = 'sb_publishable_aw39P_0nn4vB0yjfDqwEvw_mU-Hc1Sp'

// ── SESSION + AUTH GUARD ──────────────────────────────────────────────────

const { data: { session } } = await db.auth.getSession()

if (!session) {
  sessionStorage.clear()
  window.location.href = 'login.html'
  throw new Error('No session')
}

// Repopulate sessionStorage if needed
if (!sessionStorage.getItem('vtm_role')) {
  const { data: vtmUser } = await db
    .from('vtm_users')
    .select('role, name, user_id')
    .eq('auth_user_id', session.user.id)
    .single()

  if (vtmUser) {
    sessionStorage.setItem('vtm_role',    vtmUser.role)
    sessionStorage.setItem('vtm_name',    vtmUser.name)
    sessionStorage.setItem('vtm_user_id', vtmUser.user_id)
    sessionStorage.setItem('vtm_email',   session.user.email)
  }
}

// Guard — admin only
const role = sessionStorage.getItem('vtm_role')
if (role !== 'admin') {
  window.location.href = 'index.html'
  throw new Error('Admin only')
}

// ── STATE ─────────────────────────────────────────────────────────────────

let usersCache   = []   // last-loaded rows, so Edit doesn't need a re-fetch
let editingUserId = null
let pendingActive = true
let selectedMethod = 'email'

// ── AUTH METHOD SELECTION (create mode only) ──────────────────────────────

window.setAuthMethod = function(method) {
  selectedMethod = method
  document.querySelectorAll('.auth-method-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === method)
  })

  const note    = document.getElementById('oauthNote')
  const btnText = document.getElementById('submitBtn')

  if (method === 'email') {
    note.classList.remove('visible')
    if (!editingUserId) btnText.textContent = 'Create User & Send Invite →'
  } else {
    note.classList.add('visible')
    if (!editingUserId) btnText.textContent = 'Create User →'
  }
}

// ── ACTIVE TOGGLE (edit mode only) ─────────────────────────────────────────

window.setActiveState = function(isActive) {
  pendingActive = isActive
  document.getElementById('activeBtnOn').classList.toggle('on', isActive)
  document.getElementById('activeBtnOff').classList.toggle('off', !isActive)
}

// ── LOAD USERS TABLE ───────────────────────────────────────────────────────

async function loadUsers() {
  const { data, error } = await db
    .from('vtm_users')
    .select('user_id, name, role, auth_user_id, active, skill_level')
    .order('role')

  const statusEl = document.getElementById('dbStatus')
  const tbody    = document.getElementById('usersTableBody')

  if (error) {
    statusEl.textContent = 'Could not load users'
    statusEl.className   = 'db-status err'
    console.error('Load users error:', error)
    return
  }

  usersCache = data || []
  statusEl.textContent = `● ${data.length} user${data.length !== 1 ? 's' : ''}`
  statusEl.className   = 'db-status ok'

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">No users yet.</div></td></tr>'
    return
  }

  const roleLabel  = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' }
  const skillLabel = { unskilled: 'Unskilled', skilled: 'Skilled' }

  tbody.innerHTML = data.map(u => `
    <tr>
      <td>
        <div style="font-weight:500;color:var(--black)">${esc(u.name)}</div>
       </td>
      <td><span class="role-pill ${u.role}">${roleLabel[u.role] || u.role}</span></td>
      <td style="font-size:11px;color:var(--stone)">${skillLabel[u.skill_level] || u.skill_level || '—'}</td>
      <td>
        <span class="linked-dot ${u.active === false ? 'no' : 'yes'}"></span>
        <span style="font-size:11px;color:var(--stone);margin-left:6px">${u.active === false ? 'Inactive' : 'Active'}</span>
      </td>
      <td>
        <span class="linked-dot ${u.auth_user_id ? 'yes' : 'no'}" title="${u.auth_user_id ? 'Auth linked' : 'Not yet linked'}"></span>
        <span style="font-size:11px;color:var(--stone);margin-left:6px">${u.auth_user_id ? 'Linked' : 'Pending'}</span>
      </td>
      <td><button class="btn-edit-row" onclick="editUser('${u.user_id}')">Edit</button></td>
    </tr>
  `).join('')
}

// ── ENTER EDIT MODE ────────────────────────────────────────────────────────

window.editUser = function(userId) {
  const u = usersCache.find(x => x.user_id === userId)
  if (!u) return

  editingUserId = userId
  hideResult()

  document.getElementById('userName').value = u.name || ''
  document.getElementById('userRole').value = u.role || ''
  document.getElementById('userSkillLevel').value = u.skill_level || 'unskilled'
  document.getElementById('userNewEmail').value = ''
  document.getElementById('userSendReset').checked = false
  setActiveState(u.active !== false)

  // Swap create-only fields out, edit-only fields in
  document.getElementById('createEmailRow').style.display = 'none'
  document.getElementById('authMethodRow').style.display  = 'none'
  document.getElementById('oauthNote').classList.remove('visible')
  document.querySelectorAll('.edit-only').forEach(el => el.classList.add('visible'))

  document.getElementById('formTitle').textContent    = 'Edit User'
  document.getElementById('formSubtitle').textContent = `Editing ${u.name}`
  document.getElementById('submitBtn').textContent    = 'Save Changes →'

  document.querySelector('.form-card').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

window.cancelEdit = function() {
  editingUserId = null
  hideResult()
  resetForm()

  document.getElementById('createEmailRow').style.display = ''
  document.getElementById('authMethodRow').style.display  = ''
  document.querySelectorAll('.edit-only').forEach(el => el.classList.remove('visible'))

  document.getElementById('formTitle').textContent    = 'New User'
  document.getElementById('formSubtitle').textContent = 'Invite a Lead, Doer or Admin to the platform'
  document.getElementById('submitBtn').textContent    =
    selectedMethod === 'email' ? 'Create User & Send Invite →' : 'Create User →'
}

// ── SUBMIT DISPATCHER ──────────────────────────────────────────────────────

window.handleSubmit = function() {
  if (editingUserId) return updateUser()
  return createUser()
}

// ── CREATE USER — ONE EDGE FUNCTION FOR ALL METHODS ───────────────────────

async function createUser() {
  const name   = document.getElementById('userName').value.trim()
  const email  = document.getElementById('userEmail').value.trim()
  const role   = document.getElementById('userRole').value
  const btn    = document.getElementById('submitBtn')

  hideResult()

  if (!name)  { showResult('err', 'Name is required');  return }
  if (!email) { showResult('err', 'Email is required'); return }
  if (!role)  { showResult('err', 'Please select a role'); return }

  btn.disabled  = true
  btn.innerHTML = '<span class="spinner"></span>Creating…'

  try {
    const res = await fetch(INVITE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        name,
        email,
        role,
        auth_method: selectedMethod  // 'email', 'google', or 'microsoft'
      })
    })

    const data = await res.json()

    if (!res.ok || data.error) {
      showResult('err', data.error || 'Failed to create user')
      btn.disabled  = false
      btn.textContent = selectedMethod === 'email' ? 'Create User & Send Invite →' : 'Create User →'
      return
    }

    // Success message based on method
    if (selectedMethod === 'email') {
      if (data.invite_link) {
        showResult('ok', `Invite created for ${email}. Copy the link below to activate the account.`, data.invite_link)
      } else {
        showResult('ok', `Invite email sent to ${email}. They will receive a link to set their password.`)
      }
    } else {
      const providerName = selectedMethod === 'google' ? 'Google' : 'Microsoft'
      showResult('ok', `${name} added as ${role}. They can sign in using ${providerName} with ${email} — their account will be linked automatically on first login.`)
    }

    btn.disabled    = false
    btn.textContent = selectedMethod === 'email' ? 'Create User & Send Invite →' : 'Create User →'
    resetForm()
    loadUsers()

  } catch (err) {
    showResult('err', 'Network error — ' + err.message)
    btn.disabled    = false
    btn.textContent = selectedMethod === 'email' ? 'Create User & Send Invite →' : 'Create User →'
  }
}

// ── UPDATE USER — vtm_users fields + optional Auth email/reset ────────────

async function updateUser() {
  const name        = document.getElementById('userName').value.trim()
  const roleVal     = document.getElementById('userRole').value
  const skillLevel  = document.getElementById('userSkillLevel').value
  const newEmail    = document.getElementById('userNewEmail').value.trim()
  const sendReset   = document.getElementById('userSendReset').checked
  const btn         = document.getElementById('submitBtn')

  hideResult()

  if (!name)    { showResult('err', 'Name is required'); return }
  if (!roleVal) { showResult('err', 'Please select a role'); return }

  btn.disabled  = true
  btn.innerHTML = '<span class="spinner"></span>Saving…'

  try {
    const res = await fetch(UPDATE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Real session token — update-user verifies this server-side and
        // checks the caller is actually an admin. Not the anon key.
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        user_id:              editingUserId,
        name,
        role:                 roleVal,
        skill_level:          skillLevel,
        active:               pendingActive,
        email:                newEmail || undefined,
        send_password_reset:  sendReset,
      })
    })

    const data = await res.json()

    if (!res.ok || data.error) {
      showResult('err', data.error || 'Failed to update user')
      btn.disabled    = false
      btn.textContent = 'Save Changes →'
      return
    }

    if (data.reset_link) {
      showResult('ok', `${name} updated. Copy the password reset link below to send them.`, data.reset_link)
    } else {
      showResult('ok', `${name} updated.`)
    }

    btn.disabled    = false
    btn.textContent = 'Save Changes →'
    loadUsers()

  } catch (err) {
    showResult('err', 'Network error — ' + err.message)
    btn.disabled    = false
    btn.textContent = 'Save Changes →'
  }
}

// ── INVITE / RESET LINK COPY ───────────────────────────────────────────────

window.copyInviteLink = function() {
  const link = document.getElementById('inviteLinkBox').textContent
  navigator.clipboard.writeText(link).then(() => {
    if (typeof showToast === 'function') {
      showToast('Link copied', 'ok')
    } else {
      alert('Link copied')
    }
  })
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function showResult(type, msg, link) {
  const bar      = document.getElementById('resultBar')
  const title    = document.getElementById('resultTitle')
  const msgEl    = document.getElementById('resultMsg')
  const linkWrap = document.getElementById('inviteLinkWrap')
  const linkBox  = document.getElementById('inviteLinkBox')

  bar.className    = `result-bar visible ${type}`
  title.textContent = type === 'ok' ? 'Success' : 'Error'
  msgEl.textContent = msg

  if (link) {
    linkWrap.style.display = 'block'
    linkBox.textContent    = link
  } else {
    linkWrap.style.display = 'none'
  }
}

function hideResult() {
  const bar = document.getElementById('resultBar')
  if (bar) bar.className = 'result-bar'
}

function resetForm() {
  document.getElementById('userName').value  = ''
  document.getElementById('userEmail').value = ''
  document.getElementById('userRole').value  = ''
  document.getElementById('userNewEmail').value = ''
  document.getElementById('userSendReset').checked = false
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── INIT ──────────────────────────────────────────────────────────────────

setActiveState(true)
loadUsers()
