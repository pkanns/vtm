/**
 * gig_filters.js — Vidai to Mulai · Gig Index filter/sort logic
 * Deliberately simple: no live per-option counts, no facet recomputation.
 * Pure functions only — gig_index.js owns all rendering and DOM state.
 */

// ── ENRICHMENT ──────────────────────────────────────────────────────────
// Adds derived fields once per gig, so downstream logic reads as plain
// booleans instead of scattered date-math.

export function enrichGig(g) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const due   = g.date_due ? new Date(g.date_due) : null
  if (due) due.setHours(0, 0, 0, 0)

  const isOverdue = !!due && due < today && g.status !== 'completed'

  return { ...g, isOverdue }
}

// ── SCOPE (Status: Open / Complete / All) ─────────────────────────────
// Single-select. "Open" is the default — completed gigs stay out of the
// way until asked for. Only applies when no specific pipeline stage is
// picked from the flow strip — a stage selection is already a more
// specific ask than this coarse scope, so it takes precedence instead of
// fighting with it.

export const SCOPE_OPTIONS = [
  { id: 'open',     label: 'Open',     predicate: g => g.status !== 'completed' },
  { id: 'complete', label: 'Complete', predicate: g => g.status === 'completed' },
  { id: 'all',      label: 'All',      predicate: () => true },
]

// ── CHIPS (On track / Overdue) ──────────────────────────────────────────
// Multi-select in principle, OR'd together — kept to two for now per the
// "two is sufficient" call. Add more here later without touching
// gig_index.js's rendering.

export const FILTER_CHIPS = [
  { id: 'on_track', label: 'On track', predicate: g => !g.isOverdue },
  { id: 'overdue',  label: 'Overdue',  predicate: g => g.isOverdue },
]

// ── APPLY ────────────────────────────────────────────────────────────────
// activeChipIds: Set of chip ids currently toggled on (empty = no chip
// filter applied, i.e. everything passes).

export function applyFilters(gigs, { scopeId, projectId, activeChipIds }) {
  let out = gigs

  const scope = SCOPE_OPTIONS.find(s => s.id === scopeId)
  if (scope) out = out.filter(scope.predicate)

  if (projectId) out = out.filter(g => g.project_id === projectId)

  if (activeChipIds && activeChipIds.size > 0) {
    const active = FILTER_CHIPS.filter(c => activeChipIds.has(c.id))
    out = out.filter(g => active.some(c => c.predicate(g)))
  }

  return out
}

// ── SORT ─────────────────────────────────────────────────────────────────
// Fixed for now: due date, soonest first, gigs with no due date sink to
// the bottom rather than sorting as "earliest". One sort order kept
// deliberately simple — add real options here later if needed.

export function sortByDueDate(gigs) {
  return [...gigs].sort((a, b) => {
    if (!a.date_due && !b.date_due) return 0
    if (!a.date_due) return 1
    if (!b.date_due) return -1
    return new Date(a.date_due) - new Date(b.date_due)
  })
}
