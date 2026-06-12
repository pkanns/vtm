/**
 * index.js — Vidai to Mulai · Dashboard
 * Page-specific logic only.
 * All DB calls via vtm_api.js · Connection via vtm_db.js
 */

import { db } from './assets/vtm_db.js'
import { fetchCounts } from './assets/vtm_api.js'

const statusEl = document.getElementById('coverStatus')

// ── HEADER INJECTION (built-in, no external deps) ─────────────────────────

function injectHeader(session) {
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
    <button class="header-logout" onclick="window.logoutUser()">Sign out</button>
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

window.logoutUser = function() {
  sessionStorage.clear()
  db.auth.signOut().finally(() => {
    window.location.replace('login.html')
  })
}

// ── LOAD DASHBOARD ────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const counts = await fetchCounts(db)

    const ids  = ['statPacers','statRovers','statGigs','statEvals']
    const vals = [counts.pacers, counts.rovers, counts.gigs, counts.evals]
    ids.forEach((id, i) => {
      const el = document.getElementById(id)
      if (!el) return
      el.textContent = vals[i]
      el.classList.add('loaded')
    })

    document.getElementById('countGigsIndex').textContent = `${counts.gigs} gigs`

    statusEl.textContent = `Connected · ${counts.pacers} leads · ${counts.rovers} doers · ${counts.gigs} gigs · ${counts.evals} evaluations`
    statusEl.className   = 'cover-status ok'

  } catch (err) {
    statusEl.textContent = 'Could not connect to database'
    statusEl.className   = 'cover-status err'
    console.error('fetchCounts error:', err)
  }
}

// ── ROLE AWARE CARDS ──────────────────────────────────────────────────────

function applyRoleCards(role) {
  const cardUsers = document.getElementById('cardUsers')
  if (cardUsers) {
    cardUsers.classList.toggle('hidden', role !== 'admin')
  }
}

// ── TIMESHEET WEEK TOTAL ──────────────────────────────────────────────────

async function loadWeekTotal(userId) {
  if (!userId) return

  const now          = new Date()
  const startOfWeek  = new Date(now)
  startOfWeek.setDate(now.getDate() - now.getDay())
  startOfWeek.setHours(0,0,0,0)

  const { data } = await db
    .from('time_entries')
    .select('duration_mins')
    .eq('user_id', userId)
    .gte('entry_date', startOfWeek.toISOString().split('T')[0])

  if (!data?.length) return

  const totalMins = data.reduce((sum, e) => sum + (e.duration_mins || 0), 0)
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  const el = document.getElementById('tsWeekTotal')
  if (el) el.textContent = `This week: ${h > 0 ? h + 'h ' : ''}${m}m`
}

// ── USER COUNT (admin only) ───────────────────────────────────────────────

async function loadUserCount() {
  const { count } = await db
    .from('vtm_users')
    .select('*', { count: 'exact', head: true })

  const el = document.getElementById('countUsers')
  if (el && count !== null) el.textContent = `${count} registered`
}

// ── INIT ──────────────────────────────────────────────────────────────────

async function init() {
  // Check URL for OAuth return
  const hash = window.location.hash
  const isOAuthReturn = hash && (hash.includes('access_token') || hash.includes('code'))

  // Try to get session from sessionStorage first
  let sessionData = null
  const storedRole = sessionStorage.getItem('vtm_role')
  
  if (storedRole) {
    sessionData = {
      role: storedRole,
      name: sessionStorage.getItem('vtm_name') || '',
      user_id: sessionStorage.getItem('vtm_user_id') || '',
      ref_id: sessionStorage.getItem('vtm_ref_id') || '',
      email: sessionStorage.getItem('vtm_email') || ''
    }
  }

  if (sessionData?.role) {
    // Session in storage — use it
    injectHeader(sessionData)
    applyRoleCards(sessionData.role)
    loadDashboard()
    loadWeekTotal(sessionData.user_id)
    if (sessionData.role === 'admin') loadUserCount()
    return
  }

  // No session in storage — check Supabase (handles OAuth return)
  const { data: { session } } = await db.auth.getSession()

  if (!session) {
    sessionStorage.clear()
    window.location.href = 'login.html'
    return
  }

  // Fetch user from vtm_users
  const { data: vtmUser, error } = await db
    .from('vtm_users')
    .select('role, name, ref_id, user_id')
    .eq('auth_user_id', session.user.id)
    .maybeSingle()

  if (error || !vtmUser) {
    statusEl.textContent = 'Account not authorized. Contact your admin.'
    statusEl.className = 'cover-status err'
    
    const coverDiv = document.querySelector('.cover')
    if (coverDiv && !document.querySelector('.access-denied')) {
      const errorMsg = document.createElement('div')
      errorMsg.className = 'access-denied'
      errorMsg.style.cssText = 'background:#fceee8;border-left:3px solid var(--red);padding:16px 20px;margin-top:24px;color:var(--red);font-size:13px;'
      errorMsg.innerHTML = '<strong>Access Denied</strong><br>Your account is not registered. Contact your administrator.'
      coverDiv.appendChild(errorMsg)
    }
    return
  }

  // Save to sessionStorage
  sessionStorage.setItem('vtm_role', vtmUser.role)
  sessionStorage.setItem('vtm_name', vtmUser.name)
  sessionStorage.setItem('vtm_user_id', vtmUser.user_id)
  sessionStorage.setItem('vtm_ref_id', vtmUser.ref_id || '')
  sessionStorage.setItem('vtm_email', session.user.email)

  injectHeader(vtmUser)
  applyRoleCards(vtmUser.role)
  loadDashboard()
  loadWeekTotal(vtmUser.user_id)
  if (vtmUser.role === 'admin') loadUserCount()
}

// Start the app
init()