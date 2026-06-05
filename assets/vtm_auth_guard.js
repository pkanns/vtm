/**
 * vtm_auth_guard.js — Vidai to Mulai · Auth Guard + Idle Timeout
 * Load as a regular <script> on every protected page, after vtm.js.
 * NOT loaded on login.html.
 *
 * Responsibilities:
 *  1. Session check — redirect to login if no session in sessionStorage
 *  2. Header injection — role pill, name, sign-out button
 *  3. Idle timeout — 30 min, with 2-min warning at 28 min
 *  4. Sign out — clears session, signs out of Supabase, redirects to login
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════════════ */

const _IDLE_TIMEOUT_MS  = 30 * 60 * 1000   // 30 minutes
const _WARN_BEFORE_MS   = 2  * 60 * 1000   // warn at 28 minutes
const _CHECK_INTERVAL_MS = 30 * 1000        // check every 30 seconds

const _SUPABASE_URL = 'https://dbecwjhsewucqtfgoylv.supabase.co'
const _SUPABASE_KEY = 'sb_publishable_aw39P_0nn4vB0yjfDqwEvw_mU-Hc1Sp'

const _VTM_ROLE_LABELS = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' }
const _VTM_ROLE_CLASS  = { admin: 'role-admin', pacer: 'role-pacer', rover: 'role-rover' }

/* ═══════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════ */

let _idleTimer       = null
let _warnShown       = false
const _LAST_ACTIVITY_KEY = 'vtm_last_activity'

/* ═══════════════════════════════════════════════════════════════
   SIGN OUT
   ═══════════════════════════════════════════════════════════════ */

function vtmSignOut(reason) {
  clearInterval(_idleTimer)
  sessionStorage.clear()
  const redirect = reason ? `login.html?reason=${reason}` : 'login.html'
  import('https://esm.sh/@supabase/supabase-js@2')
    .then(({ createClient }) => {
      const db = createClient(_SUPABASE_URL, _SUPABASE_KEY)
      db.auth.signOut().finally(() => { window.location.replace(redirect) })
    })
    .catch(() => { window.location.replace(redirect) })
}

// Expose globally so onclick="vtmSignOut()" works from header button
window.vtmSignOut = vtmSignOut

/* ═══════════════════════════════════════════════════════════════
   SESSION CHECK
   ═══════════════════════════════════════════════════════════════ */

function _checkSession() {
  const session = vtmGetSession()
  if (!session) {
    window.location.replace('login.html')
    return null
  }
  return session
}

/* ═══════════════════════════════════════════════════════════════
   HEADER INJECTION
   ═══════════════════════════════════════════════════════════════ */

function _injectHeader(session) {
  const header = document.querySelector('header')
  if (!header) return

  const existing = header.querySelector('.header-user')
  if (existing) existing.remove()
  const existingSub = header.querySelector('.header-sub')

  const roleLabel = _VTM_ROLE_LABELS[session.role] || session.role
  const userEl    = document.createElement('div')
  userEl.className = 'header-user'
  userEl.innerHTML = `
    <span class="header-role-pill ${_VTM_ROLE_CLASS[session.role]}">${_hesc(roleLabel)}</span>
    <span class="header-user-name">${_hesc(session.name)}</span>
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

      /* Idle warning toast — amber colour */
      .vtm-toast--warn { background: #8a6200; }
    `
    document.head.appendChild(style)
  }
}

/* ═══════════════════════════════════════════════════════════════
   IDLE TIMEOUT
   ═══════════════════════════════════════════════════════════════ */

function _resetActivity() {
  sessionStorage.setItem(_LAST_ACTIVITY_KEY, Date.now().toString())
  // If warning was shown and user is active again — dismiss it
  if (_warnShown) {
    _warnShown = false
    // Hide the toast immediately
    const toast = document.getElementById('vtm-toast')
    if (toast) toast.classList.remove('show')
  }
}

function _startIdleTimer() {
  // Set initial activity timestamp
  _resetActivity()

  // Listen for any user interaction
  const _events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click']
  _events.forEach(e => document.addEventListener(e, _resetActivity, { passive: true }))

  // Check idle state every 30 seconds
  _idleTimer = setInterval(() => {
    const last    = parseInt(sessionStorage.getItem(_LAST_ACTIVITY_KEY) || '0')
    const elapsed = Date.now() - last
    const remaining = _IDLE_TIMEOUT_MS - elapsed

    if (elapsed >= _IDLE_TIMEOUT_MS) {
      // Time's up — sign out
      clearInterval(_idleTimer)
      vtmSignOut('timeout')
      return
    }

    if (remaining <= _WARN_BEFORE_MS && !_warnShown) {
      // Show 2-minute warning
      _warnShown = true
      const mins = Math.ceil(remaining / 60000)
      if (typeof showToast === 'function') {
        showToast(
          `You'll be signed out in ${mins} minute${mins !== 1 ? 's' : ''} due to inactivity — click anywhere to stay`,
          'warn',
          (_WARN_BEFORE_MS - 5000)  // keep toast visible until almost timeout
        )
      }
    }
  }, _CHECK_INTERVAL_MS)
}

/* ═══════════════════════════════════════════════════════════════
   UTILITY
   ═══════════════════════════════════════════════════════════════ */

function _hesc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/* ═══════════════════════════════════════════════════════════════
   INIT — runs on DOMContentLoaded
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  const session = _checkSession()
  if (!session) return   // redirect already fired

  _injectHeader(session)
  _startIdleTimer()
})
