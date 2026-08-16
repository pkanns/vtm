/**
 * vtm_header.js — Vidai to Mulai · Shared Header
 * Single source of truth for site chrome: brand, nav (desktop + mobile),
 * active-link highlight, and the role/name/sign-out corner.
 *
 * Nav trimmed to four items — Home, Gigs, Tasks, Timesheet. Projects and
 * Evaluate are dropped from the header itself; both pages still exist
 * and work exactly as before (project_index.html reachable from the
 * dashboard picker and from gig_actions.js's "Edit"/row links,
 * gig_eval.html reachable via the "Evaluate →" action on delivered gigs
 * — see gig_actions.js's renderActionsMenu) — they're just not in the
 * top-level nav anymore.
 *
 * A page using this needs, in this order:
 *   <script src="assets/vtm_auth_guard.js"></script>   (vtmGetSession, vtmSignOut)
 *   ...
 *   <div id="vtmHeader"></div>                          (mount point)
 *   <script src="assets/vtm_header.js"></script>        (plain script — must
 *                                                         run before any
 *                                                         deferred/module
 *                                                         script that reads
 *                                                         header elements,
 *                                                         so do NOT add
 *                                                         type="module" or
 *                                                         defer to this tag)
 * and, on <body>:
 *   <body data-page="timesheet">   one of: home, gigs, tasks, timesheet
 *                                   (projects/evaluate pages can still set
 *                                   data-page="projects"/"evaluate" — there's
 *                                   just no nav link that highlights as
 *                                   active for them anymore)
 *
 * A page needing extra header-right content (timesheet's active-timer
 * pill, for example) can populate #vtmHeaderExtra right after this script
 * runs — see timesheet.html for the pattern. This file has no opinion on
 * what goes in that slot; keeping it that way is what keeps this file
 * page-agnostic.
 */

'use strict';

const VTM_NAV_ITEMS = [
  { page: 'home',      label: 'Home',      href: 'dashboard.html' },
  { page: 'gigs',      label: 'Gigs',      href: 'gig_index.html' },
  { page: 'tasks',     label: 'Tasks',     href: 'task_index.html' },
  { page: 'timesheet', label: 'Timesheet', href: 'timesheet.html' },
];

const VTM_ROLE_LABELS = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' };
const VTM_ROLE_CLASS  = { admin: 'role-admin', pacer: 'role-pacer', rover: 'role-rover' };

function _navLinks(currentPage) {
  return VTM_NAV_ITEMS.map(item =>
    `<a href="${item.href}" data-page="${item.page}"${item.page === currentPage ? ' class="active"' : ''}>${item.label}</a>`
  ).join('');
}

function vtmRenderHeader() {
  const mount = document.getElementById('vtmHeader');
  if (!mount) return;

  const currentPage = document.body.dataset.page || '';

  mount.innerHTML = `
    <div class="vtm-header">
      <div class="vtm-header-inner">
        <a href="dashboard.html" class="vtm-brand">MULAI</a>
        <nav class="vtm-nav">${_navLinks(currentPage)}</nav>
        <div class="vtm-header-right">
          <span id="vtmHeaderExtra"></span>
          <span class="vtm-role-pill" id="headerRolePill"></span>
          <span class="vtm-user-name" id="headerUserName"></span>
          <button class="vtm-signout" onclick="vtmSignOut()">Sign out</button>
        </div>
        <button class="vtm-hamburger" id="hamburgerBtn" onclick="toggleMobileNav()" aria-label="Menu">
          <span></span><span></span><span></span>
        </button>
      </div>
      <div class="vtm-nav-dropdown" id="mobileNav">
        ${_navLinks(currentPage)}
        <div class="vtm-dropdown-user">
          <span class="vtm-role-pill" id="mobileRolePill"></span>
          <span class="vtm-user-name" id="mobileUserName"></span>
          <button class="vtm-signout" style="margin-left:auto" onclick="vtmSignOut()">Sign out</button>
        </div>
      </div>
    </div>`;

  const s = (typeof vtmGetSession === 'function') ? vtmGetSession() : null;
  if (s) {
    ['headerRolePill', 'mobileRolePill'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = VTM_ROLE_LABELS[s.role] || s.role; el.classList.add(VTM_ROLE_CLASS[s.role] || ''); }
    });
    ['headerUserName', 'mobileUserName'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = s.name;
    });
  }
}

window.toggleMobileNav = function() {
  document.getElementById('mobileNav')?.classList.toggle('open');
  document.getElementById('hamburgerBtn')?.classList.toggle('open');
};

// Runs immediately, in document order — NOT on DOMContentLoaded. Deferred
// module scripts (like timesheet.js) run after this either way, but other
// plain scripts placed below this one in the page depend on the header
// elements existing right away, so this can't wait for an event.
vtmRenderHeader();
