/**
 * create_user.js — Vidai to Mulai · Create User
 * Admin only — uses Edge Function for ALL user creation
 * Email invite: sends invite email with password setup link
 * Google/Microsoft: creates auth user + vtm_users record in one call
 * No direct database inserts from frontend
 */

import { db } from './assets/vtm_db.js'

const EDGE_FUNCTION_URL = 'https://dbecwjhsewucqtfgoylv.supabase.co/functions/v1/invite-user'
const SUPABASE_ANON_KEY = 'sb_publishable_aw39P_0nn4vB0yjfDqwEvw_mU-Hc1Sp'

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

// ── AUTH METHOD SELECTION ─────────────────────────────────────────────────

let selectedMethod = 'email'

window.setAuthMethod = function(method) {
  selectedMethod = method
  document.querySelectorAll('.auth-method-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === method)
  })

  const note    = document.getElementById('oauthNote')
  const btnText = document.getElementById('submitBtn')

  if (method === 'email') {
    note.classList.remove('visible')
    btnText.textContent = 'Create User & Send Invite →'
  } else {
    note.classList.add('visible')
    btnText.textContent = 'Create User →'
  }
}

// ── LOAD USERS TABLE (no email column) ────────────────────────────────────

async function loadUsers() {
  const { data, error } = await db
    .from('vtm_users')
    .select('user_id, name, role, auth_user_id')
    .order('role')

  const statusEl = document.getElementById('dbStatus')
  const tbody    = document.getElementById('usersTableBody')

  if (error) {
    statusEl.textContent = 'Could not load users'
    statusEl.className   = 'db-status err'
    console.error('Load users error:', error)
    return
  }

  statusEl.textContent = `● ${data.length} user${data.length !== 1 ? 's' : ''}`
  statusEl.className   = 'db-status ok'

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="3"><div class="empty-state">No users yet.</div></td></tr>'
    return
  }

  const roleLabel = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' }

  tbody.innerHTML = data.map(u => `
    <tr>
      <td>
        <div style="font-weight:500;color:var(--black)">${esc(u.name)}</div>
       </td>
      <td><span class="role-pill ${u.role}">${roleLabel[u.role] || u.role}</span></td>
      <td>
        <span class="linked-dot ${u.auth_user_id ? 'yes' : 'no'}" title="${u.auth_user_id ? 'Auth linked' : 'Not yet linked'}"></span>
        <span style="font-size:11px;color:var(--stone);margin-left:6px">${u.auth_user_id ? 'Linked' : 'Pending'}</span>
      </td>
    </tr>
  `).join('')
}

// ── CREATE USER — ONE EDGE FUNCTION FOR ALL METHODS ───────────────────────

window.createUser = async function() {
  const name   = document.getElementById('userName').value.trim()
  const email  = document.getElementById('userEmail').value.trim()
  const role   = document.getElementById('userRole').value
  const btn    = document.getElementById('submitBtn')
  const result = document.getElementById('resultBar')

  hideResult()

  if (!name)  { showResult('err', 'Name is required');  return }
  if (!email) { showResult('err', 'Email is required'); return }
  if (!role)  { showResult('err', 'Please select a role'); return }

  btn.disabled  = true
  btn.innerHTML = '<span class="spinner"></span>Creating…'

  try {
    const res = await fetch(EDGE_FUNCTION_URL, {
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

// ── INVITE LINK COPY ──────────────────────────────────────────────────────

window.copyInviteLink = function() {
  const link = document.getElementById('inviteLinkBox').textContent
  navigator.clipboard.writeText(link).then(() => {
    if (typeof showToast === 'function') {
      showToast('Invite link copied', 'ok')
    } else {
      alert('Invite link copied')
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
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── INIT ──────────────────────────────────────────────────────────────────

loadUsers()