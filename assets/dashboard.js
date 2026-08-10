/**
 * dashboard.js — Vidai to Mulai · Dashboard
 * Session handling deliberately goes through vtmAuthGuard() rather than
 * a plain vtmGetSession() check like most other pages — dashboard.html
 * is the one page that might be reached before sessionStorage has data
 * (a fresh landing right after login, an OAuth return, or a direct /
 * refreshed visit with the tab's sessionStorage empty but Supabase's own
 * session still valid). vtmAuthGuard() already contains that fast-path
 * (cached session) / slow-path (live Supabase check + repopulate
 * sessionStorage) logic — reusing it here instead of reimplementing it.
 *
 * The shared header can't be statically included for the same reason:
 * vtm_header.js reads sessionStorage the instant it loads, so it has to
 * wait until vtmAuthGuard() has guaranteed that data exists.
 */

import { db }                    from './vtm_db.js'
import { fetchDashboardPages }   from './vtm_api.js'
import { renderMenuPickerCard }  from './vtm_cards.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = await vtmAuthGuard()
if (!session) throw new Error('No session')

// sessionStorage is now guaranteed populated — safe to bring in the header.
const headerScript = document.createElement('script')
headerScript.src = 'assets/vtm_header.js'
document.body.appendChild(headerScript)

// ── COVER ─────────────────────────────────────────────────────────────────

const firstName = (session.name || session.email || 'User').split(' ')[0]
document.getElementById('coverFirstName').textContent = firstName
if (session.email) document.getElementById('coverEmail').textContent = session.email

const ROLE_LABEL = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' }
const ROLE_CLASS = { admin: 'role-admin', pacer: 'role-pacer', rover: 'role-rover' }
const rolePill = document.getElementById('coverRolePill')
rolePill.textContent = ROLE_LABEL[session.role] || session.role
rolePill.classList.add(ROLE_CLASS[session.role] || '')

// ── WORKSPACE PICKER ──────────────────────────────────────────────────────

const ROLE_FIELD = { admin: 'visible_admin', pacer: 'visible_pacer', rover: 'visible_rover' }

async function loadWorkspace() {
  const grid  = document.getElementById('pagesGrid')
  const empty = document.getElementById('pagesEmpty')

  const { data, error } = await fetchDashboardPages(db)

  if (error) {
    grid.style.display  = 'none'
    empty.style.display = 'block'
    empty.textContent   = 'Could not load your dashboard — ' + error.message
    return
  }

  const field   = ROLE_FIELD[session.role]
  const visible = (data || []).filter(p => p[field])

  if (!visible.length) {
    grid.style.display  = 'none'
    empty.style.display = 'block'
    empty.textContent   = session.role === 'admin'
      ? 'Nothing configured yet — set it up from Dashboard Admin.'
      : 'Nothing configured for you yet — ask your admin to set up your dashboard.'
    return
  }

  grid.style.display  = 'grid'
  empty.style.display = 'none'
  grid.innerHTML = visible.map(renderMenuPickerCard).join('')
}

await loadWorkspace()
