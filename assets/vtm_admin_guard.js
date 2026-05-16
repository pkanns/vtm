/**
 * vtm_admin_guard.js — Vidai to Mulai
 * AUTH-09: Redirect non-admin roles away from admin-only pages.
 * Include as the FIRST module script on create_rover.html and create_pacer.html.
 *
 * Usage:
 *   <script type="module" src="assets/vtm_admin_guard.js"></script>
 *   (before the page's own module script)
 */

// vtmGetSession is available globally from vtm.js (loaded via <script src>)
const _session = vtmGetSession()
const _role    = _session?.role || null

if (_role !== 'admin') {
  showToast('This page is for admins only', 'err')
  setTimeout(() => { window.location.href = 'index.html' }, 1200)
}

// Also hide nav links that non-admins should not see.
// Called after DOM ready in case nav renders late.
document.addEventListener('DOMContentLoaded', () => {
  if (_role !== 'admin') {
    document.querySelectorAll('[data-admin-only]').forEach(el => {
      el.style.display = 'none'
    })
  }
})
