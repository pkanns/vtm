/**
 * index.js — Vidai to Mulai · Dashboard
 * Page-specific logic only.
 * All DB calls via vtm_api.js · Connection via vtm_db.js
 */

import { db } from './assets/vtm_db.js'
import { fetchCounts } from './assets/vtm_api.js'

const statusEl = document.getElementById('coverStatus')

async function loadDashboard() {
  try {
    const counts = await fetchCounts(db)

    const ids = ['statPacers', 'statRovers', 'statGigs', 'statEvals']
    const vals = [counts.pacers, counts.rovers, counts.gigs, counts.evals]
    ids.forEach((id, i) => {
      const el = document.getElementById(id)
      if (!el) return
      el.textContent = vals[i]
      el.classList.add('loaded')
    })

    document.getElementById('countPacers').textContent = `${counts.pacers} registered`
    document.getElementById('countRovers').textContent = `${counts.rovers} registered`
    document.getElementById('countGigs').textContent = `${counts.gigs} active`
    document.getElementById('countGigsIndex').textContent = `${counts.gigs} total`
    document.getElementById('countEvals').textContent = `${counts.evals} completed`

    statusEl.textContent = `Connected · ${counts.pacers} doers · ${counts.rovers} leads · ${counts.gigs} gigs · ${counts.evals} evaluations`
    statusEl.className = 'cover-status ok'

  } catch (err) {
    statusEl.textContent = 'Could not connect to database'
    statusEl.className = 'cover-status err'
    console.error('fetchCounts error:', err)
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────

// First, check if we already have sessionStorage populated
let existingSession = null
try {
  existingSession = vtmGetSession()
} catch(e) {
  // vtmGetSession might not be loaded yet
}

if (existingSession && existingSession.role) {
  // Already have sessionStorage, just load dashboard
  if (typeof vtmAuthGuard === 'function') vtmAuthGuard()
  loadDashboard()
} else {
  // Need to get session from Supabase
  const { data: { session } } = await db.auth.getSession()
  
  if (!session) {
    // No Supabase session — go to login
    sessionStorage.clear()
    window.location.href = 'login.html'
  } else {
    // Have Supabase session, lookup vtm_users
    const { data: vtmUser, error } = await db
      .from('vtm_users')
      .select('role, name, ref_id, user_id')
      .eq('auth_user_id', session.user.id)
      .single()

    if (vtmUser && !error) {
      // Valid user — populate sessionStorage
      sessionStorage.setItem('vtm_role', vtmUser.role)
      sessionStorage.setItem('vtm_name', vtmUser.name)
      sessionStorage.setItem('vtm_user_id', vtmUser.user_id)
      sessionStorage.setItem('vtm_ref_id', vtmUser.ref_id || '')
      sessionStorage.setItem('vtm_email', session.user.email)

      // Inject header and load dashboard
      if (typeof vtmAuthGuard === 'function') vtmAuthGuard()
      loadDashboard()
    } else {
      // No vtm_users record — show error on page, don't redirect
      statusEl.textContent = 'Account not authorized. Contact your admin.'
      statusEl.className = 'cover-status err'
      console.error('vtm_users lookup failed:', error)
      
      // Show a message but don't redirect to login (breaks the loop)
      const coverDiv = document.querySelector('.cover')
      if (coverDiv) {
        const errorMsg = document.createElement('div')
        errorMsg.style.cssText = 'background: #fceee8; border-left: 3px solid var(--red); padding: 16px 20px; margin-top: 24px; color: var(--red); font-size: 13px;'
        errorMsg.innerHTML = '<strong>Access Denied</strong><br>Your Supabase account is not registered in vtm_users. Please contact your administrator.'
        if (!document.querySelector('.access-denied')) {
          errorMsg.className = 'access-denied'
          coverDiv.appendChild(errorMsg)
        }
      }
    }
  }
}