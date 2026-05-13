/**
 * index.js — Vidai to Mulai · Dashboard
 * Page-specific logic only.
 * All DB calls via vtm_api.js · Connection via vtm_db.js
 */

import { db }          from './assets/vtm_db.js'
import { fetchCounts } from './assets/vtm_api.js'

const statusEl = document.getElementById('coverStatus')

async function loadDashboard() {
  try {
    const counts = await fetchCounts(db)

    // Stats strip
    const ids = ['statPacers','statRovers','statGigs','statEvals']
    const vals = [counts.pacers, counts.rovers, counts.gigs, counts.evals]
    ids.forEach((id, i) => {
      const el = document.getElementById(id)
      if (!el) return
      el.textContent = vals[i]
      el.classList.add('loaded')
    })

    // Tool card counts
    document.getElementById('countPacers').textContent = `${counts.pacers} registered`
    document.getElementById('countRovers').textContent = `${counts.rovers} registered`
    document.getElementById('countGigs').textContent   = `${counts.gigs} active`
    document.getElementById('countEvals').textContent  = `${counts.evals} completed`

    statusEl.textContent = `Connected · ${counts.pacers} pacers · ${counts.rovers} rovers · ${counts.gigs} gigs · ${counts.evals} evaluations`
    statusEl.className = 'cover-status ok'

  } catch (err) {
    statusEl.textContent = 'Could not connect to database'
    statusEl.className = 'cover-status err'
  }
}

loadDashboard()
