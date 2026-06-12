/**
 * index.js — Vidai to Mulai · Dashboard
 * Page-specific logic only.
 * All DB calls via vtm_api.js · Connection via vtm_db.js
 */

import { db }          from './vtm_db.js'
import { fetchCounts } from './vtm_api.js'

const statusEl = document.getElementById('coverStatus')

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
  // Admin card — admin only
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

// Check existing sessionStorage first
let existingSession = null
try { existingSession = vtmGetSession() } catch(e) {}

if (existingSession?.role) {
  // Session already in storage — inject header and load
  vtmAuthGuard()
  applyRoleCards(existingSession.role)
  loadDashboard()
  loadWeekTotal(existingSession.user_id)
  if (existingSession.role === 'admin') loadUserCount()

} else {
  // Need to restore from Supabase session
  const { data: { session } } = await db.auth.getSession()

  if (!session) {
    sessionStorage.clear()
    window.location.href = 'login.html'

  } else {
    const { data: vtmUser, error } = await db
      .from('vtm_users')
      .select('role, name, ref_id, user_id')
      .eq('auth_user_id', session.user.id)
      .single()

    if (vtmUser && !error) {
      sessionStorage.setItem('vtm_role',    vtmUser.role)
      sessionStorage.setItem('vtm_name',    vtmUser.name)
      sessionStorage.setItem('vtm_user_id', vtmUser.user_id)
      sessionStorage.setItem('vtm_ref_id',  vtmUser.ref_id || '')
      sessionStorage.setItem('vtm_email',   session.user.email)

      vtmAuthGuard()
      applyRoleCards(vtmUser.role)
      loadDashboard()
      loadWeekTotal(vtmUser.user_id)
      if (vtmUser.role === 'admin') loadUserCount()

    } else {
      // Supabase session exists but no vtm_users record
      statusEl.textContent = 'Account not authorized. Contact your admin.'
      statusEl.className   = 'cover-status err'

      const coverDiv = document.querySelector('.cover')
      if (coverDiv && !document.querySelector('.access-denied')) {
        const errorMsg = document.createElement('div')
        errorMsg.className = 'access-denied'
        errorMsg.style.cssText = 'background:#fceee8;border-left:3px solid var(--red);padding:16px 20px;margin-top:24px;color:var(--red);font-size:13px;'
        errorMsg.innerHTML = '<strong>Access Denied</strong><br>Your account is not registered. Contact your administrator.'
        coverDiv.appendChild(errorMsg)
      }
    }
  }
}
