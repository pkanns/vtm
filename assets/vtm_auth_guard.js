/**
 * vtm_auth_guard.js — Vidai to Mulai · Auth Guard + Idle Timeout
 * MODIFIED to work with Google OAuth
 */

'use strict';

const SUPABASE_URL = 'https://dbecwjhsewucqtfgoylv.supabase.co'
const SUPABASE_KEY = 'sb_publishable_aw39P_0nn4vB0yjfDqwEvw_mU-Hc1Sp'

let idleTimer = null
let warnShown = false
const LAST_ACTIVITY_KEY = 'vtm_last_activity'
const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const WARN_BEFORE_MS = 2 * 60 * 1000
const CHECK_INTERVAL_MS = 30 * 1000

// ── SESSION CHECK (works with both email AND OAuth) ───────────────────────

async function vtmCheckAndRestoreSession() {
  // First check sessionStorage (email login)
  let session = vtmGetSession()
  if (session) return session

  // No sessionStorage — check Supabase (handles OAuth return)
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const db = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data: { session: supabaseSession } } = await db.auth.getSession()
    
    if (!supabaseSession) return null
    
    // Fetch user from vtm_users
    const { data: vtmUser, error } = await db
      .from('vtm_users')
      .select('role, name, user_id, active')
      .eq('auth_user_id', supabaseSession.user.id)
      .single()
    
    if (error || !vtmUser) return null
    if (vtmUser.active === false) return null

    // Restore to sessionStorage
    sessionStorage.setItem('vtm_role',    vtmUser.role)
    sessionStorage.setItem('vtm_name',    vtmUser.name)
    sessionStorage.setItem('vtm_user_id', vtmUser.user_id)
    sessionStorage.setItem('vtm_email',   supabaseSession.user.email)
    
    return {
      role:    vtmUser.role,
      name:    vtmUser.name,
      user_id: vtmUser.user_id,
      email:   supabaseSession.user.email
    }
  } catch (err) {
    console.error('Session restore error:', err)
    return null
  }
}

function vtmGetSession() {
  const role = sessionStorage.getItem('vtm_role');
  if (!role) return null;
  return {
    role,
    name:    sessionStorage.getItem('vtm_name')    || '',
    user_id: sessionStorage.getItem('vtm_user_id') || '',
    email:   sessionStorage.getItem('vtm_email')   || '',
  };
}

// ── HEADER INJECTION ──────────────────────────────────────────────────────

function vtmInjectHeader(session) {
  const header = document.querySelector('header')
  if (!header) return

  const existing = header.querySelector('.header-user')
  if (existing) existing.remove()
  
  const existingSub = header.querySelector('.header-sub')
  
  const roleLabels = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' }
  const roleClass = { admin: 'role-admin', pacer: 'role-pacer', rover: 'role-rover' }
  const roleLabel = roleLabels[session.role] || session.role
  
  const userEl = document.createElement('div')
  userEl.className = 'header-user'
  userEl.innerHTML = `
    <span class="header-role-pill ${roleClass[session.role]}">${escapeHtml(roleLabel)}</span>
    <span class="header-user-name">${escapeHtml(session.name)}</span>
    <button class="header-logout" onclick="vtmSignOut()">Sign out</button>
  `
  
  if (existingSub) existingSub.replaceWith(userEl)
  else header.appendChild(userEl)

  if (!document.getElementById('vtm-auth-styles')) {
    const style = document.createElement('style')
    style.id = 'vtm-auth-styles'
    style.textContent = `
      .header-user { display:flex; align-items:center; gap:12px; }
      .header-role-pill { font-size:9px; letter-spacing:0.12em; text-transform:uppercase;
        padding:3px 8px; font-weight:600; font-family:var(--font-mono,monospace); }
      .role-admin { background:rgba(247,246,242,0.15); color:var(--white,#f7f6f2); }
      .role-pacer { background:var(--red,#c0392b);     color:var(--white,#f7f6f2); }
      .role-rover { background:var(--green,#2d5a3d);   color:var(--white,#f7f6f2); }
      .header-user-name { font-size:12px; color:rgba(247,246,242,0.6);
        font-family:var(--font-body,sans-serif); }
      .header-logout { background:none; border:1px solid rgba(247,246,242,0.2);
        color:rgba(247,246,242,0.4); padding:4px 10px; font-size:10px;
        letter-spacing:0.1em; text-transform:uppercase; cursor:pointer;
        font-family:var(--font-body,sans-serif); transition:border-color 0.2s,color 0.2s; }
      .header-logout:hover { border-color:rgba(247,246,242,0.5); color:var(--white,#f7f6f2); }
    `
    document.head.appendChild(style)
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── SIGN OUT ─────────────────────────────────────────────────────────────

async function vtmSignOut() {
  if (idleTimer) clearInterval(idleTimer)
  sessionStorage.clear()
  
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const db = createClient(SUPABASE_URL, SUPABASE_KEY)
    await db.auth.signOut()
  } catch(e) {}
  
  window.location.replace('login.html')
}
window.vtmSignOut = vtmSignOut

// ── IDLE TIMEOUT ─────────────────────────────────────────────────────────

function resetActivity() {
  sessionStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString())
  if (warnShown) {
    warnShown = false
    const toast = document.getElementById('vtm-toast')
    if (toast) toast.classList.remove('show')
  }
}

function startIdleTimer() {
  resetActivity()
  const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click']
  events.forEach(e => document.addEventListener(e, resetActivity, { passive: true }))
  
  idleTimer = setInterval(() => {
    const last = parseInt(sessionStorage.getItem(LAST_ACTIVITY_KEY) || '0')
    const elapsed = Date.now() - last
    
    if (elapsed >= IDLE_TIMEOUT_MS) {
      clearInterval(idleTimer)
      vtmSignOut('timeout')
    }
  }, CHECK_INTERVAL_MS)
}

// ── AUTH GUARD (main entry point) ────────────────────────────────────────

async function vtmAuthGuard() {
  // Check for OAuth return - if present, don't redirect
  const hash = window.location.hash
  const isOAuthReturn = hash && (hash.includes('access_token') || hash.includes('code'))
  
  // Try to restore session (handles both email and OAuth)
  const session = await vtmCheckAndRestoreSession()
  
  if (!session && !isOAuthReturn) {
    window.location.replace('login.html')
    return null
  }
  
  if (session) {
    vtmInjectHeader(session)
    startIdleTimer()
  }
  
  return session
}

// Make functions available globally
window.vtmGetSession = vtmGetSession
window.vtmAuthGuard = vtmAuthGuard
window.vtmSignOut = vtmSignOut