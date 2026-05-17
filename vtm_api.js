/**
 * vtm_api.js — Vidai to Mulai · Database API Layer
 * All Supabase read/write functions live here.
 * Pages import only what they need.
 * To fix a query: edit here once, all pages benefit.
 */

// ── PACERS ────────────────────────────────────────────────────────────────

export async function fetchPacers(db) {
  return db.from('pacers').select('*').order('created_at', { ascending: false })
}

export async function fetchActivePacers(db) {
  return db.from('pacers').select('pacer_id, name').eq('active', true).order('name')
}

export async function savePacer(db, payload, id = null) {
  if (id) return db.from('pacers').update(payload).eq('pacer_id', id)
  return db.from('pacers').insert(payload)
}

export async function deletePacer(db, id) {
  return db.from('pacers').delete().eq('pacer_id', id)
}

export async function fetchPacerById(db, id) {
  return db.from('pacers').select('*').eq('pacer_id', id).single()
}

// ── ROVERS ────────────────────────────────────────────────────────────────

export async function fetchRovers(db) {
  return db.from('rovers').select('*').order('created_at', { ascending: false })
}

export async function fetchActiveRovers(db) {
  return db.from('rovers').select('rover_id, name, skill_level').eq('active', true).order('name')
}

export async function saveRover(db, payload, id = null) {
  if (id) return db.from('rovers').update(payload).eq('rover_id', id)
  return db.from('rovers').insert(payload)
}

export async function deleteRover(db, id) {
  return db.from('rovers').delete().eq('rover_id', id)
}

export async function fetchRoverById(db, id) {
  return db.from('rovers').select('*').eq('rover_id', id).single()
}

// ── GIGS ──────────────────────────────────────────────────────────────────

export async function fetchGigs(db) {
  return db.from('gigs').select('*').order('created_at', { ascending: false })
}

export async function fetchGigsForEval(db) {
  return db.from('gigs')
    .select('gig_id, gig_code, title, category, status, date_due, pacer_id, rover_id')
    .in('status', ['in_progress', 'delivered'])
    .order('date_due', { ascending: true })
}

export async function fetchGigById(db, id) {
  return db.from('gigs').select('*').eq('gig_id', id).single()
}

export async function saveGig(db, payload, id = null) {
  if (id) return db.from('gigs').update(payload).eq('gig_id', id)
  return db.from('gigs').insert(payload).select()
}

export async function updateGigStatus(db, id, status) {
  return db.from('gigs').update({ status }).eq('gig_id', id)
}

export async function deleteGig(db, id) {
  return db.from('gigs').delete().eq('gig_id', id)
}

// ── EVALUATIONS ───────────────────────────────────────────────────────────

export async function saveEvaluation(db, payload) {
  return db.from('evaluations').insert([payload])
}

export async function fetchEvaluations(db) {
  return db.from('evaluations').select('*').order('created_at', { ascending: false })
}

// ── COUNTS (dashboard) ────────────────────────────────────────────────────

export async function fetchCounts(db) {
  const [pacers, rovers, gigs, evals] = await Promise.all([
    db.from('pacers').select('*',      { count: 'exact', head: true }),
    db.from('rovers').select('*',      { count: 'exact', head: true }),
    db.from('gigs').select('*',        { count: 'exact', head: true }),
    db.from('evaluations').select('*', { count: 'exact', head: true }),
  ])
  return {
    pacers: pacers.count ?? 0,
    rovers: rovers.count ?? 0,
    gigs:   gigs.count   ?? 0,
    evals:  evals.count  ?? 0,
  }
}

// ── SHARED HELPERS ────────────────────────────────────────────────────────

export function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, day] = iso.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${parseInt(day)} ${months[parseInt(m) - 1]} ${y}`
}

export function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
