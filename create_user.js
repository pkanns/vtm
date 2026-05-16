/**
 * create_user.js — Vidai to Mulai · Create User
 * Admin only — guarded by vtmAuthGuard + vtmGuardPage
 * Email invite: calls Supabase Edge Function (invite-user)
 * Google/Microsoft: creates vtm_users row only, links on first OAuth login
 * DB calls via vtm_api.js · Connection via vtm_db.js
 */

import { db } from './assets/vtm_db.js'

const EDGE_FUNCTION_URL = 'https://dbecwjhsewucqtfgoylv.supabase.co/functions/v1/invite-user'
const SUPABASE_ANON_KEY = 'sb_publishable_aw39P_0nn4vB0yjfDqwEvw_mU-Hc1Sp'

// ── SESSION + AUTH GUARD ──────────────────────────────────────────────────

const { data: { session } } = await db.auth.getSession()

if (!session) {
  sessionStorage.clear()
  window.location.href = 'login.html'
}

// Repopulate sessionStorage if needed
if (!sessionStorage.getItem('vtm_role')) {
  const { data: vtmUser } = await db
    .from('vtm_users')
    .select('role, name, ref_id, user_id')
    .eq('auth_user_id', session.user.id)
    .single()

  if (vtmUser) {
    sessionStorage.setItem('vtm_role',    vtmUser.role)
    sessionStorage.setItem('vtm_name',    vtmUser.name)
    sessionStorage.setItem('vtm_user_id', vtmUser.user_id)
    sessionStorage.setItem('vtm_ref_id',  vtmUser.ref_id || '')
    sessionStorage.setItem('vtm_email',   session.user.email)
    vtmAuthGuard()
  }
}

// Guard — admin only
vtmGuardPage(['admin'])

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

// ── LOAD USERS TABLE ──────────────────────────────────────────────────────

async function loadUsers() {
  const { data, error } = await db
    .from('vtm_users')
    .select('user_id, name, email, role, auth_user_id')
    .order('role')

  const statusEl = document.getElementById('dbStatus')
  const tbody    = document.getElementById('usersTableBody')

  if (error) {
    statusEl.textContent = 'Could not load users'
    statusEl.className   = 'db-status err'
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
        <div style="font-size:11px;color:var(--stone);font-family:var(--font-mono)">${esc(u.email)}</div>
      </td>
      <td><span class="role-pill ${u.role}">${roleLabel[u.role] || u.role}</span></td>
      <td>
        <span class="linked-dot ${u.auth_user_id ? 'yes' : 'no'}" title="${u.auth_user_id ? 'Auth linked' : 'Not yet linked'}"></span>
        <span style="font-size:11px;color:var(--stone);margin-left:6px">${u.auth_user_id ? 'Linked' : 'Pending'}</span>
      </td>
    </tr>
  `).join('')
}

// ── CREATE USER ───────────────────────────────────────────────────────────

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

  if (selectedMethod === 'email') {
    await createEmailUser(name, email, role, btn)
  } else {
    await createOAuthUser(name, email, role, selectedMethod, btn)
  }
}

// ── EMAIL INVITE PATH ─────────────────────────────────────────────────────

async function createEmailUser(name, email, role, btn) {
  try {
    const res = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ name, email, role })
    })

    const data = await res.json()

    if (!res.ok || data.error) {
      showResult('err', data.error || 'Failed to create user')
      btn.disabled  = false
      btn.textContent = 'Create User & Send Invite →'
      return
    }

    // Show invite link if returned (localhost)
    if (data.invite_link) {
      showResult('ok', `Invite created for ${email}. Copy the link below and open it in a browser to activate the account.`, data.invite_link)
    } else {
      showResult('ok', `Invite email sent to ${email}. They will receive a link to set their password.`)
    }

    btn.disabled    = false
    btn.textContent = 'Create User & Send Invite →'
    resetForm()
    loadUsers()

  } catch (err) {
    showResult('err', 'Network error — ' + err.message)
    btn.disabled    = false
    btn.textContent = 'Create User & Send Invite →'
  }
}

// ── OAUTH PATH (Google / Microsoft) ──────────────────────────────────────

async function createOAuthUser(name, email, role, method, btn) {
  // For OAuth users we create the vtm_users row only
  // auth_user_id will be linked automatically on first login
  const { error } = await db
    .from('vtm_users')
    .insert({ name, email, role, auth_user_id: null })

  if (error) {
    const msg = error.message.includes('unique')
      ? 'A user with this email already exists'
      : 'Failed to create user — ' + error.message
    showResult('err', msg)
    btn.disabled    = false
    btn.textContent = 'Create User →'
    return
  }

  // Also create the pacer or rover record
  if (role === 'pacer') {
    const { data: pacer } = await db
      .from('pacers')
      .insert({ name, email, active: true })
      .select()
      .single()

    if (pacer) {
      await db
        .from('vtm_users')
        .update({ ref_id: pacer.pacer_id })
        .eq('email', email)
    }
  }

  if (role === 'rover') {
    const { data: rover } = await db
      .from('rovers')
      .insert({ name, email, skill_level: 'unskilled', active: true })
      .select()
      .single()

    if (rover) {
      await db
        .from('vtm_users')
        .update({ ref_id: rover.rover_id })
        .eq('email', email)
    }
  }

  const providerName = method === 'google' ? 'Google' : 'Microsoft'
  showResult('ok', `${name} added. They can sign in using ${providerName} with ${email} — their account will be linked automatically on first login.`)

  btn.disabled    = false
  btn.textContent = 'Create User →'
  resetForm()
  loadUsers()
}

// ── INVITE LINK COPY ──────────────────────────────────────────────────────

window.copyInviteLink = function() {
  const link = document.getElementById('inviteLinkBox').textContent
  navigator.clipboard.writeText(link).then(() => {
    showToast('Invite link copied', 'ok')
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
  document.getElementById('resultBar').className = 'result-bar'
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
