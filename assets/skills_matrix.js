/**
 * skills_matrix.js — Vidai to Mulai · Skills
 * Ported from the skills_matrix.html prototype: same views (My skills,
 * Team matrix, Library), now reading and writing Supabase through vtm_api.js.
 *
 * - Anyone signed in can rate anyone and edit the library (access to the page
 *   itself is controlled through dashboard_pages, not in here).
 * - One rating per person per skill; clicking the same level again clears it.
 * - Skills are retired, never deleted, so old ratings survive.
 * - Roll-ups (theme averages, gaps) are computed here at read time, never stored.
 * - Profile card (Kingdomality + top 5 CliftonStrengths in rank order) sits on
 *   the My skills view for whichever person is selected.
 * - Admins get a People tab to hide users from the Skills page for everyone
 *   (a display filter: the data is kept and can be shown again).
 * - Writes are optimistic: the screen updates first and is put back with a
 *   toast if the database refuses.
 */

import { db } from './vtm_db.js'
import {
  fetchSkillLibrary, fetchSkillPeople, fetchSkillRatings,
  upsertSkillRating, deleteSkillRating,
  saveSkillFunction, saveSkillTheme, saveSkill,
  fetchKingdomalityTypes, fetchStrengthsThemes, fetchUserProfiles, fetchUserStrengths,
  saveUserKingdomality, saveUserStrengths, saveUserHidden,
  esc,
} from './vtm_api.js'

// ── SESSION ───────────────────────────────────────────────────────────────

const session = vtmGetSession()
if (!session) { window.location.replace('login.html'); throw new Error() }

// ── CONSTANTS ─────────────────────────────────────────────────────────────

const LV = ['Seed', 'Sprout', 'Sapling', 'Tree', 'Grove']
const LD = ['Learning the basics', 'Works with support', 'Works on my own', 'Teaches others', 'Grows teachers']

// Shown next to names. vtm_users.role is admin / pacer / rover; the rest of the
// app calls a pacer the Lead and a rover the Doer (fetchActiveLeads / fetchActiveDoers).
const ROLE_LABEL = { admin: 'Admin', pacer: 'Lead', rover: 'Doer' }
const isAdmin = session.role === 'admin'

const $ = s => document.querySelector(s)

// ── STATE ─────────────────────────────────────────────────────────────────

const D = {
  fns: [],      // [{ id, n, so, th: [{ id, n, so, sk: [{ id, n, so, on }] }] }]
  all: [],      // every active user [{ id, n, role }] (admins manage this list)
  hidden: new Set(),  // user ids an admin has hidden
  people: [],   // the people shown everywhere else: all minus hidden
  types: [],    // Kingdomality: [{ id, n, desc }]
  themes: [],   // CliftonStrengths: [{ id, n, domain }]
  rat: {},      // 'userId|skillId' -> level 1..5
  prof: {},     // userId -> kingdomality type id
  str: {},      // userId -> ['themeId' | '', x5] in rank order
}

const S = {
  tab: 'my',
  me: null,
  sel: null,
  openF: new Set(),
  openM: new Set(),
  gaps: false,
  ff: '',
}

// ── PUNCH STRIP (decorative — same as the other pages) ────────────────────

function buildPunchStrip() {
  const strip = document.getElementById('topPunchStrip')
  if (!strip) return
  const pattern = [1,0,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,0,1,1,0,2,0,1,0,0,1,0,1]
  for (let s = 0; s < 2; s++) {
    const div = document.createElement('div')
    div.className = 'punch-holes' + (s === 1 ? ' punch-holes-2' : '')
    for (let r = 0; r < 6; r++) {
      pattern.forEach(p => {
        const h = document.createElement('div')
        h.className = 'hole' + (p === 1 ? ' punched' : p === 2 ? ' punched red' : '')
        div.appendChild(h)
      })
    }
    strip.appendChild(div)
  }
}

// ── LOAD ──────────────────────────────────────────────────────────────────

async function loadAll() {
  const results = await Promise.all([
    fetchSkillLibrary(db),
    fetchSkillPeople(db),
    fetchSkillRatings(db),
    fetchKingdomalityTypes(db),
    fetchStrengthsThemes(db),
    fetchUserProfiles(db),
    fetchUserStrengths(db),
  ])
  const failed = results.find(r => r.error)
  if (failed) {
    $('#skApp').innerHTML = `<div class="sk-msg err">Could not load skills — ${esc(failed.error.message)}</div>`
    $('#skSub').textContent = ''
    return false
  }
  const [lib, people, ratings, types, themes, profs, strs] = results.map(r => r.data || [])

  const byOrder = (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || String(a.name).localeCompare(String(b.name))
  D.fns = lib.slice().sort(byOrder).map(f => ({
    id: f.function_id, n: f.name, so: f.sort_order || 0,
    th: (f.skill_themes || []).slice().sort(byOrder).map(t => ({
      id: t.theme_id, n: t.name, so: t.sort_order || 0,
      sk: (t.skills || []).slice().sort(byOrder).map(s => ({ id: s.skill_id, n: s.name, so: s.sort_order || 0, on: s.active !== false })),
    })),
  }))

  D.all = people.map(p => ({ id: p.user_id, n: p.name, role: p.role }))
  D.hidden = new Set(profs.filter(p => p.hidden).map(p => p.user_id))
  applyHidden()
  D.types  = types.map(t => ({ id: t.type_id, n: t.name, desc: t.description || '' }))
  D.themes = themes.map(t => ({ id: t.theme_id, n: t.name, domain: t.domain }))
  setRatings(ratings)

  D.prof = {}
  profs.forEach(p => { if (p.kingdomality_type_id) D.prof[p.user_id] = p.kingdomality_type_id })

  D.str = {}
  strs.forEach(s => {
    if (!D.str[s.user_id]) D.str[s.user_id] = ['', '', '', '', '']
    if (s.rank >= 1 && s.rank <= 5) D.str[s.user_id][s.rank - 1] = s.theme_id
  })
  return true
}

function applyHidden() {
  D.people = D.all.filter(p => !D.hidden.has(p.id))
}

function setRatings(rows) {
  D.rat = {}
  rows.forEach(r => { D.rat[r.user_id + '|' + r.skill_id] = r.level })
}

// Ratings by other people change while this page is open; refetch when the
// matrix is opened so it never shows a stale picture.
async function refreshRatings() {
  const { data, error } = await fetchSkillRatings(db)
  if (error) return false
  setRatings(data)
  return true
}

// ── LOOKUPS & ROLL-UPS ────────────────────────────────────────────────────

const act = t => t.sk.filter(s => s.on)
const lvl = (p, s) => D.rat[p + '|' + s] || 0
const allT = () => D.fns.flatMap(f => f.th)
const thOf = id => allT().find(t => t.id === id)
const fnOf = t => D.fns.find(f => f.th.includes(t))
const roll = (p, T) => {
  const v = act(T).map(s => lvl(p, s.id)).filter(Boolean)
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0
}
const strong = s => D.people.filter(p => lvl(p.id, s.id) >= 3).length
const isGap = s => strong(s) < 2
const roleLabel = r => ROLE_LABEL[r] || r

function findItem(kind, id) {
  if (kind === 'f') return D.fns.find(f => f.id === id)
  if (kind === 't') return thOf(id)
  return allT().flatMap(t => t.sk).find(s => s.id === id)
}

// ── DRAWING ───────────────────────────────────────────────────────────────

function ball(v, z = 22) {
  const P = ['', 'M20 20V3A17 17 0 0 1 37 20Z', 'M20 20V3A17 17 0 0 1 20 37Z', 'M20 20V3A17 17 0 1 1 3 20Z'][v] || ''
  const c = v === 5 ? 'var(--red)' : 'var(--black)'
  return `<svg viewBox="0 0 40 40" width="${z}" height="${z}" role="img" aria-label="${v ? LV[v - 1] : 'Not rated'}"><title>${v ? LV[v - 1] + ': ' + LD[v - 1] : 'Not rated'}</title><circle cx="20" cy="20" r="17" fill="${v > 3 ? c : '#f0ead8'}" stroke="${v ? c : '#c8bfa8'}" stroke-width="2"${v ? '' : ' stroke-dasharray="3 3"'}/>${P ? `<path d="${P}" fill="${c}"/>` : ''}</svg>`
}

const legend = () => `<div class="sk-legend">${LV.map((l, i) => `<span>${ball(i + 1, 22)}${i + 1} ${l}: ${LD[i]}</span>`).join('')}</div>`

function renderTabs() {
  const T = [['my', 'My skills'], ['mx', 'Team matrix'], ['lib', 'Library']]
  if (isAdmin) T.push(['ppl', 'People'])
  $('#skTabs').innerHTML = T.map(([k, l]) =>
    `<button role="tab" data-sk="tab" data-id="${k}" aria-selected="${S.tab === k}">${l}</button>`).join('')
  const n = allT().reduce((a, t) => a + act(t).length, 0)
  const hid = isAdmin && D.hidden.size ? `, ${D.hidden.size} hidden` : ''
  $('#skSub').textContent = `${D.fns.length} functions, ${allT().length} themes, ${n} skills, ${D.people.length} people${hid}`
}

// ── VIEW: MY SKILLS ───────────────────────────────────────────────────────

function profileCard(p) {
  const typeId = D.prof[p.id] || ''
  const type = D.types.find(t => t.id === typeId)
  const picks = D.str[p.id] || ['', '', '', '', '']
  const domains = [...new Set(D.themes.map(t => t.domain))]

  const typeOpts = '<option value="">Not set</option>' +
    D.types.map(t => `<option value="${esc(t.id)}"${t.id === typeId ? ' selected' : ''}>${esc(t.n)}</option>`).join('')

  const slots = picks.map((sel, i) => {
    const opts = '<option value="">Not set</option>' + domains.map(d =>
      `<optgroup label="${esc(d)}">${D.themes.filter(t => t.domain === d).map(t => {
        const taken = picks.some((x, j) => x === t.id && j !== i)
        return `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''}${taken ? ' disabled' : ''}>${esc(t.n)}</option>`
      }).join('')}</optgroup>`).join('')
    const th = D.themes.find(t => t.id === sel)
    return `<div class="sk-slot"><b>${i + 1}</b><select class="sk-sel" data-sk="str" data-slot="${i}" aria-label="Strength ${i + 1}">${opts}</select><small>${th ? esc(th.domain) : '&nbsp;'}</small></div>`
  }).join('')

  return `<div class="punch-card sk-prof">
    <div class="entry-card-header">
      <div class="pc-field"><div class="pc-label">Profile</div><div class="pc-val typed">${esc(p.n)}</div></div>
      <div class="pc-field"><div class="pc-label">Role</div><div class="pc-val">${esc(roleLabel(p.role))}</div></div>
    </div>
    <div class="punch-card-body sk-prof-b">
      <div><label for="skKt">Kingdomality</label><select class="sk-sel" id="skKt" data-sk="kt">${typeOpts}</select>${type && type.desc ? `<p class="sk-prof-d">${esc(type.desc)}</p>` : ''}</div>
      <div><label>CliftonStrengths, top 5 in rank order</label><div class="sk-str">${slots}</div></div>
    </div>
  </div>`
}

function vMy() {
  if (!D.people.length) return '<div class="sk-msg">No active users found.</div>'
  if (!allT().length) return '<div class="sk-msg">The library is empty. Add a function in the Library tab.</div>'

  const me = D.people.find(p => p.id === S.me) || D.people[0]
  S.me = me.id

  const rail = D.fns.map(f => {
    const all = f.th.flatMap(act), d = all.filter(s => lvl(S.me, s.id)).length, o = S.openF.has(f.id)
    return `<div class="sk-rf"><button class="sk-rfh" data-sk="tf" data-id="${f.id}"><span class="sk-car">${o ? '▾' : '▸'}</span>${esc(f.n)}<small>${d}/${all.length}</small></button>${o ? f.th.map(t => {
      const a = act(t), d2 = a.filter(s => lvl(S.me, s.id)).length
      return `<button class="sk-rt${t.id === S.sel ? ' sk-on' : ''}" data-sk="sth" data-id="${t.id}">${esc(t.n)}<small>${d2}/${a.length}</small></button>`
    }).join('') : ''}</div>`
  }).join('')

  const T = thOf(S.sel) || allT()[0]
  S.sel = T.id
  const F = fnOf(T), a = act(T), d = a.filter(s => lvl(S.me, s.id)).length

  const rows = a.map(s => {
    const v = lvl(S.me, s.id)
    return `<div class="sk-srow"><div class="sk-sname">${esc(s.n)}</div><div class="sk-lv">${[1, 2, 3, 4, 5].map(n =>
      `<button class="${v === n ? 'sk-on' : ''}" data-sk="rate" data-id="${s.id}" data-n="${n}" title="${n} ${LV[n - 1]}: ${LD[n - 1]}">${ball(n, 24)}</button>`).join('')}</div><div class="sk-lvn${v ? ' sk-on' : ''}">${v ? LV[v - 1] : 'Not rated'}</div></div>`
  }).join('')

  return `<div class="sk-bar"><label for="skMe">Person</label><select class="sk-sel" id="skMe" data-sk="me">${D.people.map(p =>
    `<option value="${p.id}"${p.id === S.me ? ' selected' : ''}>${esc(p.n)} (${esc(roleLabel(p.role))})</option>`).join('')}</select><span class="sk-sp"></span><button class="sk-btn sk-red" data-sk="next">Next unrated</button></div>
  ${profileCard(me)}
  ${legend()}
  <div class="sk-split"><div class="sk-rail">${rail}</div><div class="sk-pane"><div class="sk-crumb">${esc(F.n)} / ${esc(T.n)}</div><h2>${esc(T.n)}</h2><div class="sk-prog"><b style="width:${a.length ? d / a.length * 100 : 0}%"></b></div><div class="sk-crumb">${d} of ${a.length} rated</div>${rows || '<p class="sk-crumb" style="margin-top:16px">No skills in this theme yet. Add one in the Library.</p>'}</div></div>`
}

// ── VIEW: TEAM MATRIX ─────────────────────────────────────────────────────

function vMx() {
  if (!D.people.length) return '<div class="sk-msg">No active users found.</div>'
  const gapOnly = S.gaps, fl = S.ff ? D.fns.filter(f => f.id === S.ff) : D.fns
  let body = ''
  fl.forEach(f => {
    let rows = ''
    f.th.forEach(t => {
      const a = act(t), g = a.filter(isGap), open = S.openM.has(t.id) || gapOnly
      if (gapOnly && !g.length) return
      const c = a.filter(s => !isGap(s)).length
      rows += `<tr class="sk-trth" data-sk="tm" data-id="${t.id}"><td class="sk-f"><span class="sk-car">${open && !gapOnly ? '▾' : '▸'}</span> ${esc(t.n)}${g.length ? `<span class="sk-gapn">${g.length} gap${g.length > 1 ? 's' : ''}</span>` : ''} <span class="sk-cov">${c}/${a.length} covered</span></td>${D.people.map(p => `<td>${ball(roll(p.id, t), 26)}</td>`).join('')}</tr>`
      if (open) (gapOnly ? g : a).forEach(s => {
        rows += `<tr class="sk-trsk"><td class="sk-f">${esc(s.n)}${isGap(s) ? '<span class="sk-gapdot" title="Fewer than two people at Sapling or above"></span>' : ''}</td>${D.people.map(p => `<td>${ball(lvl(p.id, s.id), 22)}</td>`).join('')}</tr>`
      })
    })
    if (rows) body += `<tr class="sk-trfn"><td colspan="${D.people.length + 1}">${esc(f.n)}</td></tr>${rows}`
  })
  return `<div class="sk-bar"><label for="skFf">Function</label><select class="sk-sel" id="skFf" data-sk="ff"><option value="">All</option>${D.fns.map(f =>
    `<option value="${f.id}"${S.ff === f.id ? ' selected' : ''}>${esc(f.n)}</option>`).join('')}</select><button class="sk-chip" aria-pressed="${S.gaps}" data-sk="gaps">Show gaps only</button><span class="sk-sp"></span><button class="sk-btn" data-sk="exp">Unfold all</button><button class="sk-btn" data-sk="col">Fold all</button></div>${legend()}
  <div class="sk-mwrap"><table><thead><tr><th class="sk-f">Function / Theme / Skill</th>${D.people.map(p => `<th>${esc(p.n)}<small>${esc(roleLabel(p.role))}</small></th>`).join('')}</tr></thead><tbody>${body || `<tr><td class="sk-f" colspan="${D.people.length + 1}">No gaps. Every skill has two people at Sapling or above.</td></tr>`}</tbody></table></div>
  <p class="sk-crumb" style="margin-top:10px">Theme rows show each person's average. A gap means fewer than two people at Sapling or above.</p>`
}

// ── VIEW: LIBRARY ─────────────────────────────────────────────────────────

function vLib() {
  return `<div class="sk-bar"><span class="sk-sp"></span><button class="sk-btn sk-pri" data-sk="af">Add function</button></div><div class="sk-lib">${D.fns.map(f =>
    `<div class="sk-lcard"><h3><input data-sk="name" data-kind="f" data-id="${f.id}" value="${esc(f.n)}" aria-label="Function name"></h3>${f.th.map(t =>
      `<div class="sk-lth"><input class="sk-tn" data-sk="name" data-kind="t" data-id="${t.id}" value="${esc(t.n)}" aria-label="Theme name">${t.sk.map(s =>
        `<div class="sk-lsk${s.on ? '' : ' sk-off'}"><input data-sk="name" data-kind="s" data-id="${s.id}" value="${esc(s.n)}" aria-label="Skill name"><button class="sk-x" data-sk="rs" data-id="${s.id}">${s.on ? 'retire' : 'restore'}</button></div>`).join('')}<button class="sk-add" data-sk="as" data-id="${t.id}">+ skill</button></div>`).join('')}<button class="sk-add" data-sk="at" data-id="${f.id}">+ theme</button></div>`).join('')}</div>`
}

// ── VIEW: PEOPLE (admin only) ─────────────────────────────────────────────

function vPpl() {
  return `<p class="sk-crumb" style="margin-bottom:10px">Hidden people disappear from the Skills page for everyone. Their ratings and profile are kept and come back when you show them again.</p>
  <div class="sk-ppl">${D.all.map(p => {
    const h = D.hidden.has(p.id)
    return `<div class="sk-prow${h ? ' sk-hid' : ''}"><div class="sk-pn">${esc(p.n)}</div><div class="sk-pr">${esc(roleLabel(p.role))}</div><button class="sk-btn" data-sk="hide" data-id="${p.id}">${h ? 'Show' : 'Hide'}</button></div>`
  }).join('')}</div>`
}

function render() {
  if (S.tab === 'ppl' && !isAdmin) S.tab = 'my'
  renderTabs()
  $('#skApp').innerHTML = { my: vMy, mx: vMx, lib: vLib, ppl: vPpl }[S.tab]()
}

// ── WRITES ────────────────────────────────────────────────────────────────

function errText(error) {
  return error && error.code === '23505' ? 'that name already exists here' : (error?.message || 'unknown error')
}

async function rate(userId, skillId, n) {
  const key = userId + '|' + skillId
  const prev = D.rat[key]
  const clearing = prev === n
  if (clearing) delete D.rat[key]; else D.rat[key] = n
  render()

  const { error } = clearing
    ? await deleteSkillRating(db, userId, skillId)
    : await upsertSkillRating(db, userId, skillId, n, session.user_id)

  if (error) {
    if (prev) D.rat[key] = prev; else delete D.rat[key]
    render()
    showToast('Could not save rating — ' + errText(error), 'err')
  }
}

// If the person being looked at just got hidden, fall back to the first one shown.
function keepMeVisible() {
  if (!D.people.some(p => p.id === S.me)) S.me = D.people[0]?.id || null
}

async function toggleHidden(userId) {
  if (!isAdmin) return
  const wasHidden = D.hidden.has(userId)
  if (wasHidden) D.hidden.delete(userId); else D.hidden.add(userId)
  applyHidden(); keepMeVisible(); render()

  const { error } = await saveUserHidden(db, userId, !wasHidden)
  if (error) {
    if (wasHidden) D.hidden.add(userId); else D.hidden.delete(userId)
    applyHidden(); keepMeVisible(); render()
    showToast('Could not update — ' + errText(error), 'err')
  }
}

async function setKingdomality(typeId) {
  const uid = S.me
  const prev = D.prof[uid] || ''
  if (typeId) D.prof[uid] = typeId; else delete D.prof[uid]
  render()

  const { error } = await saveUserKingdomality(db, uid, typeId || null)
  if (error) {
    if (prev) D.prof[uid] = prev; else delete D.prof[uid]
    render()
    showToast('Could not save Kingdomality — ' + errText(error), 'err')
  }
}

async function setStrength(slot, themeId) {
  const uid = S.me
  const prev = (D.str[uid] || ['', '', '', '', '']).slice()
  const next = prev.slice()
  next[slot] = themeId
  D.str[uid] = next
  render()

  const picks = next.map((t, i) => t ? { theme_id: t, rank: i + 1 } : null).filter(Boolean)
  const { error } = await saveUserStrengths(db, uid, picks)
  if (error) {
    D.str[uid] = prev
    render()
    showToast('Could not save strengths — ' + errText(error), 'err')
  }
}

async function renameItem(kind, id, raw) {
  const obj = findItem(kind, id)
  const name = raw.trim()
  if (!obj || !name || name === obj.n) { render(); return }   // empty or unchanged: put the field back

  const prev = obj.n
  obj.n = name
  const save = kind === 'f' ? saveSkillFunction : kind === 't' ? saveSkillTheme : saveSkill
  const { error } = await save(db, { name }, id)
  if (error) {
    obj.n = prev
    showToast('Could not rename — ' + errText(error), 'err')
  }
  render()
}

async function toggleRetire(skillId) {
  const s = findItem('s', skillId)
  if (!s) return
  const { error } = await saveSkill(db, { active: !s.on }, skillId)
  if (error) { showToast('Could not update skill — ' + errText(error), 'err'); return }
  s.on = !s.on
}

// New items get a unique name per parent (the database enforces it), then the
// person renames them in place.
function uniqueName(existing, base) {
  const taken = new Set(existing.map(n => n.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const c = `${base} ${i}`
    if (!taken.has(c.toLowerCase())) return c
  }
}
const nextSort = list => Math.max(0, ...list.map(x => x.so || 0)) + 1
const first = data => Array.isArray(data) ? data[0] : data

async function addSkill(themeId) {
  const T = thOf(themeId)
  if (!T) return
  const { data, error } = await saveSkill(db, { theme_id: themeId, name: uniqueName(T.sk.map(s => s.n), 'New skill'), sort_order: nextSort(T.sk) })
  if (error) { showToast('Could not add skill — ' + errText(error), 'err'); return }
  const r = first(data)
  T.sk.push({ id: r.skill_id, n: r.name, so: r.sort_order, on: r.active !== false })
}

async function addTheme(functionId) {
  const F = D.fns.find(f => f.id === functionId)
  if (!F) return
  const { data, error } = await saveSkillTheme(db, { function_id: functionId, name: uniqueName(F.th.map(t => t.n), 'New theme'), sort_order: nextSort(F.th) })
  if (error) { showToast('Could not add theme — ' + errText(error), 'err'); return }
  const r = first(data)
  F.th.push({ id: r.theme_id, n: r.name, so: r.sort_order, sk: [] })
}

async function addFunction() {
  const { data, error } = await saveSkillFunction(db, { name: uniqueName(D.fns.map(f => f.n), 'New function'), sort_order: nextSort(D.fns) })
  if (error) { showToast('Could not add function — ' + errText(error), 'err'); return }
  const r = first(data)
  D.fns.push({ id: r.function_id, n: r.name, so: r.sort_order, th: [] })
}

function nextUnrated() {
  const T = allT()
  const i = T.findIndex(t => t.id === S.sel)
  for (let j = 1; j <= T.length; j++) {
    const t = T[(i + j) % T.length]
    if (act(t).some(s => !lvl(S.me, s.id))) { S.sel = t.id; S.openF.add(fnOf(t).id); return }
  }
  showToast('Everything in the library is rated for this person', 'ok')
}

// ── EVENTS ────────────────────────────────────────────────────────────────

const wrap = document.querySelector('.sk-wrap')

wrap.addEventListener('click', async e => {
  const b = e.target.closest('[data-sk]')
  if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return
  const a = b.dataset.sk, id = b.dataset.id

  if (a === 'rate') { await rate(S.me, id, +b.dataset.n); return }

  if (a === 'tab') S.tab = id
  else if (a === 'tf') S.openF.has(id) ? S.openF.delete(id) : S.openF.add(id)
  else if (a === 'sth') S.sel = id
  else if (a === 'next') nextUnrated()
  else if (a === 'tm') S.openM.has(id) ? S.openM.delete(id) : S.openM.add(id)
  else if (a === 'gaps') S.gaps = !S.gaps
  else if (a === 'exp') allT().forEach(t => S.openM.add(t.id))
  else if (a === 'col') S.openM.clear()
  else if (a === 'rs') await toggleRetire(id)
  else if (a === 'as') await addSkill(id)
  else if (a === 'at') await addTheme(id)
  else if (a === 'af') await addFunction()
  else if (a === 'hide') await toggleHidden(id)
  else return

  render()

  if (a === 'tab' && id === 'mx') {
    const ok = await refreshRatings()
    if (ok && S.tab === 'mx') render()
  }
})

wrap.addEventListener('change', async e => {
  const t = e.target, a = t.dataset.sk
  if (!a) return
  if (a === 'me')        { S.me = t.value; render() }
  else if (a === 'ff')   { S.ff = t.value; render() }
  else if (a === 'name') await renameItem(t.dataset.kind, t.dataset.id, t.value)
  else if (a === 'kt')   await setKingdomality(t.value)
  else if (a === 'str')  await setStrength(+t.dataset.slot, t.value)
})

// ── INIT (last, so every helper above exists before it runs) ──────────────

buildPunchStrip()
try {
  if (await loadAll()) {
    S.me = D.people.some(p => p.id === session.user_id) ? session.user_id : (D.people[0]?.id || null)
    const firstTheme = allT()[0]
    if (firstTheme) { S.sel = firstTheme.id; S.openF.add(fnOf(firstTheme).id) }
    render()
  }
} catch (e) {
  console.error(e)
  $('#skApp').innerHTML = `<div class="sk-msg err">Something went wrong — ${esc(e.message)}</div>`
  $('#skSub').textContent = ''
}
