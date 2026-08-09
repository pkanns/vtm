/**
 * vtm_cards.js — Vidai to Mulai · Shared Card Components
 * The generic "pick one of several gigs" card — first built for
 * gig_eval's gig picker. Deliberately gig-shaped rather than fully
 * generic for now, since a gig is the only thing being picked anywhere
 * today. Planned future consumers: gig_index's workflow-step filters,
 * and the dashboard — neither built yet; generalize further only if a
 * genuinely different "pick one of X" screen shows up later.
 *
 * Styling lives in vtm_2.css (.vtm-picker-*). Expects window.selectGig(gigId)
 * to be defined by the page using this — same convention as gig_tasks.js.
 */

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderGigPickerCard(gig, { dueLabel = '', selected = false } = {}) {
  const statusClass = `status-${gig.status || 'placed'}`
  const statusLabel = (gig.status || '').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())

  return `
    <div class="vtm-picker-card ${statusClass}${selected ? ' selected' : ''}" onclick="selectGig('${gig.gig_id}')">
      <div class="vtm-picker-code">${esc(gig.gig_code)}</div>
      <div class="vtm-picker-title">${esc(gig.title)}</div>
      <div class="vtm-picker-meta">
        <span>${esc(dueLabel)}</span>
        <span class="status-label">${esc(statusLabel)}</span>
      </div>
    </div>`
}
