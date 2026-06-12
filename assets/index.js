/**
 * index.js — Vidai to Mulai · Dashboard
 * Complete auth + dashboard logic (replaces vtm_auth_guard.js)
 */

import { db } from './assets/vtm_db.js'
import { fetchCounts } from './assets/vtm_api.js'

// =============================================================
// CONFIG
// =============================================================
const IDLE_TIMEOUT_MS = 30 * 60 * 1000   // 30 minutes
const WARN_BEFORE_MS  = 2 * 60 * 1000    // warn at 28 minutes
const CHECK_INTERVAL_MS = 30 * 1000      // check every 30 seconds

const ROLE_LABELS = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' }
const ROLE_CLASS  = { admin: 'role-admin', pacer: 'role-pacer', rover: 'role-rover' }

let idleTimer = null
let warnShown = false
const LAST_ACTIVITY_KEY = 'vtm_last_activity'

// =============================================================
// UTILITIES
// =============================================================
function hesc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function showToast(msg, type = 'warn', duration = 5000) {
  // Remove existing toast
  const existing = document.getElementById('vtm-toast')
  if (existing) existing.remove()
  
  const toast = document.createElement('div')
  toast.id = 'vtm-toast'
  toast.textContent = msg
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; background: ${type === 'warn' ? '#8a6200' : '#c0392b'};
    color: white; padding: 12px 20px; font-size: 13px; font-family: var(--font-mono, monospace);
    z-index: 10000; opacity: 0; transition: opacity 0.2s; pointer-events: none;
    border-left: 3px solid white; max-width: 320px;
  `
  document.body.appendChild(toast)
  setTimeout(() => { toast.style.opacity = '1' }, 10)
  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = '0'
      setTimeout(() => toast.remove(), 200)
    }
  }, duration)
}

// =============================================================
// SIGN OUT
// =============================================================
async function vtmSignOut(reason) {
  if (idleTimer) clearInterval(idleTimer)
  sessionStorage.clear()
  
  try {
    await db.auth.signOut()
  } catch (e) { /* ignore */ }
  
  const redirect = reason ? `login.html?reason=${reason}` : 'login.html'
  window.location.replace(redirect)
}

// =============================================================
// HEADER INJECTION (replaces auth guard's header)
// =============================================================
function injectHeader(session) {
  const header = document.querySelector('header')
  if (!header) return

  const existing = header.querySelector('.header-user')
  if (existing) existing.remove()
  
  const existingSub = header.querySelector('.header-sub')
  const roleLabel = ROLE_LABELS[session.role] || session.role
  
  const userEl = document.createElement('div')
  userEl.className = 'header-user'
  userEl.innerHTML = `
    <span class="header-role-pill ${ROLE_CLASS[session.role]}">${hesc(roleLabel)}</span>
    <span class="header-user-name">${hesc(session.name)}</span>
    <button class="header-logout" onclick="window.vtmSignOut && window.vtmSignOut()">Sign out</button>
  `
  
  if (existingSub) existingSub.replaceWith(userEl)
  else header.appendChild(userEl)

  // Add styles if not present
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

// =============================================================
// IDLE TIMEOUT
// =============================================================
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
    const remaining = IDLE_TIMEOUT_MS - elapsed
    
    if (elapsed >= IDLE_TIMEOUT_MS) {
      clearInterval(idleTimer)
      vtmSignOut('timeout')
      return
    }
    
    if (remaining <= WARN_BEFORE_MS && !warnShown) {
      warnShown = true
      const mins = Math.ceil(remaining / 60000)
      showToast(`You'll be signed out in ${mins} minute${mins !== 1 ? 's' : ''} due to inactivity — move your mouse to stay`, 'warn')
    }
  }, CHECK_INTERVAL_MS)
}

// =============================================================
// SESSION RESTORATION (handles OAuth + regular login)
// =============================================================
async function restoreSession() {
  // First, check if we have a session in sessionStorage (email/password flow)
  let sessionData = null
  try {
    sessionData = window.vtmGetSession ? window.vtmGetSession() : {
      role: sessionStorage.getItem('vtm_role'),
      name: sessionStorage.getItem('vtm_name'),
      user_id: sessionStorage.getItem('vtm_user_id'),
      email: sessionStorage.getItem('vtm_email')
    }
  } catch(e) {}
  
  if (sessionData?.role) {
    return sessionData
  }
  
  // No sessionStorage — check Supabase auth (handles OAuth return)
  const { data: { session } } = await db.auth.getSession()
  
  if (!session) {
    return null
  }
  
  // We have a Supabase session — fetch user from vtm_users
  const { data: vtmUser, error } = await db
    .from('vtm_users')
    .select('role, name, user_id')
    .eq('auth_user_id', session.user.id)
    .maybeSingle()
  
  if (error || !vtmUser) {
    console.error('No vtm_users record for auth user:', session.user.id)
    await db.auth.signOut()
    return null
  }
  
  // Save to sessionStorage for future page loads
  sessionStorage.setItem('vtm_role', vtmUser.role)
  sessionStorage.setItem('vtm_name', vtmUser.name)
  sessionStorage.setItem('vtm_user_id', vtmUser.user_id)
  sessionStorage.setItem('vtm_email', session.user.email)
  
  return {
    role: vtmUser.role,
    name: vtmUser.name,
    user_id: vtmUser.user_id,
    email: session.user.email
  }
}

// =============================================================
// DASHBOARD LOADING
// =============================================================
async function loadDashboard() {
  const statusEl = document.getElementById('coverStatus') || document.getElementById('dbStatus')
  try {
    const counts = await fetchCounts(db)
    
    // Update stats strip
    const statActive = document.getElementById('statActive')
    const statPlacement = document.getElementById('statPlacement')
    const statUpcoming = document.getElementById('statUpcoming')
    const statDoneWeek = document.getElementById('statDoneWeek')
    
    if (statActive) statActive.textContent = counts.active_today || '0'
    if (statPlacement) statPlacement.textContent = counts.needs_placement || '0'
    if (statUpcoming) statUpcoming.textContent = counts.upcoming || '0'
    if (statDoneWeek) statDoneWeek.textContent = counts.done_week || '0'
    
    // Update active count and upcoming count if elements exist
    const activeCount = document.getElementById('activeCount')
    const upcomingCount = document.getElementById('upcomingCount')
    const placementCount = document.getElementById('placementCount')
    
    if (activeCount) activeCount.textContent = counts.active_today || '0'
    if (upcomingCount) upcomingCount.textContent = counts.upcoming || '0'
    if (placementCount) placementCount.textContent = counts.needs_placement || '0'
    
    if (statusEl) {
      statusEl.textContent = `Connected · ${counts.pacers || 0} leads · ${counts.rovers || 0} doers · ${counts.gigs || 0} gigs`
      statusEl.className = 'db-status ok'
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Could not connect to database'
      statusEl.className = 'db-status err'
    }
    console.error('loadDashboard error:', err)
  }
}

// =============================================================
// ROLE-BASED UI
// =============================================================
function applyRoleCards(role) {
  const placementSection = document.getElementById('placementSection')
  if (placementSection) {
    placementSection.style.display = (role === 'admin' || role === 'pacer') ? 'block' : 'none'
  }
  
  const coverSub = document.getElementById('coverSub')
  if (coverSub) {
    const name = sessionStorage.getItem('vtm_name') || ''
    coverSub.textContent = `${role === 'admin' ? 'Admin' : role === 'pacer' ? 'Lead' : 'Doer'} · ${name}`
  }
}

// =============================================================
// INIT — Main entry point
// =============================================================
async function init() {
  // Check for OAuth return parameters FIRST — if present, let Supabase handle before any redirect
  const hash = window.location.hash
  const hasOAuthReturn = hash && (hash.includes('access_token') || hash.includes('code'))
  
  // Restore session (handles both OAuth and existing sessions)
  const session = await restoreSession()
  
  if (!session) {
    // No valid session — redirect to login
    window.location.replace('login.html')
    return
  }
  
  // Session exists — setup page
  injectHeader(session)
  startIdleTimer()
  applyRoleCards(session.role)
  loadDashboard()
  
  // Expose signout globally for header button
  window.vtmSignOut = vtmSignOut
}

// Start the app
init()