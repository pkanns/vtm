/**
 * app_exp_result.js — Mulai · Join us (location experiment)
 * Same table, bucket and RPC as applicant.js:
 *   table   mulai_applications   (insert only; new columns: see app_exp_result.sql)
 *   bucket  mulai-cvs            (private, upload only)
 *   rpc     mulai_email_exists
 *
 * What changed vs applicant.js
 *   - "Coimbatore / relocate" question removed.
 *   - Browser location is asked once (button press). Blocking it blocks the application.
 *   - Straight-line distance to the office is shown, then "office 3 days a week?" is asked.
 *   - "Correct my location": applicant can search a place by name if the browser fix is wrong
 *     (VPN, weak GPS, desktop Wi-Fi guess). We store both the browser fix and the correction.
 */
import { db } from './vtm_db.js'

const BUCKET = 'mulai-cvs'
const MAX_MB = 2
const OFFICE = { lat: 11.027036445872621, lon: 76.94078795397407 }   // must match app_exp_result.sql
const EARTH_KM = 6371.0088
const FUZZY_M = 5000   // accuracy worse than this: tell the applicant it looks approximate

const MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
const DUP_MSG = 'This email address has already applied. Each email can apply only once.'
const TYPOS = {
  'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.con': 'gmail.com',
  'gmail.co': 'gmail.com', 'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com',
}
const EMAIL_RE = /^[^\s@]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

const $ = id => document.getElementById(id)
const f = {
  form: $('applyForm'), name: $('fullName'), email: $('email'), loc: $('locBtn'), office: $('office'),
  gig: $('gig'), qualification: $('qualification'), cv: $('cv'), cvField: $('cvField'),
  fileName: $('fileName'), blocked: $('blockedMsg'), submit: $('submitBtn'),
  status: $('formStatus'), hp: $('company_website'), suggest: $('emailSuggest'),
}
let sending = false

// ── LOCATION STATE ────────────────────────────────────────────────────────
// state: idle | asking | ready | denied | failed
const loc = { state: 'idle', lat: null, lon: null, accuracy: null, source: null, label: null, bLat: null, bLon: null }

const toRad = d => d * Math.PI / 180
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}
const distanceKm = () => haversineKm(loc.lat, loc.lon, OFFICE.lat, OFFICE.lon)

function askLocation() {
  if (!window.isSecureContext || !('geolocation' in navigator)) {
    loc.state = 'failed'; refresh(); return
  }
  loc.state = 'asking'; setError('loc', ''); refresh()
  navigator.geolocation.getCurrentPosition(
    p => {
      loc.state = 'ready'
      loc.lat = loc.bLat = p.coords.latitude
      loc.lon = loc.bLon = p.coords.longitude
      loc.accuracy = p.coords.accuracy
      loc.source = 'browser'; loc.label = null
      $('fixBack').hidden = true
      refresh()
    },
    err => { loc.state = err.code === 1 ? 'denied' : 'failed'; refresh() },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }   // one reading, no watching
  )
}

// "Correct my location": search a place by name (OpenStreetMap Nominatim, low volume use)
async function geocode(q) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000)
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&q=' + encodeURIComponent(q), { signal: ctl.signal })
    if (!r.ok) throw new Error('geocode ' + r.status)
    return (await r.json()).map(x => ({ lat: +x.lat, lon: +x.lon, label: String(x.display_name).slice(0, 200) }))
  } finally { clearTimeout(t) }
}

async function findPlace() {
  const q = $('fixQuery').value.trim()
  const box = $('fixResults')
  box.textContent = ''
  const note = msg => { const p = document.createElement('p'); p.textContent = msg; box.append(p) }
  if (q.length < 3) { note('Type at least 3 characters.'); return }
  $('fixFind').disabled = true; note('Searching…')
  try {
    const hits = (await geocode(q)).filter(h => Number.isFinite(h.lat) && Number.isFinite(h.lon))
    box.textContent = ''
    if (!hits.length) { note('No match. Try a nearby town or a landmark.'); return }
    hits.forEach(h => {
      const b = document.createElement('button')
      b.type = 'button'; b.textContent = h.label
      b.onclick = () => {
        loc.lat = h.lat; loc.lon = h.lon; loc.accuracy = null
        loc.source = 'corrected'; loc.label = h.label
        $('fixBox').hidden = true; $('fixBack').hidden = !loc.bLat
        box.textContent = ''; refresh()
      }
      box.append(b)
    })
  } catch {
    box.textContent = ''; note('Search is not available right now. Check your connection and try again.')
  } finally { $('fixFind').disabled = false }
}

function useBrowserFix() {
  loc.lat = loc.bLat; loc.lon = loc.bLon; loc.source = 'browser'; loc.label = null
  $('fixBack').hidden = true; $('fixBox').hidden = true; refresh()
}

// ── ELIGIBILITY ───────────────────────────────────────────────────────────

const ext = n => (n.split('.').pop() || '').toLowerCase()
const BLOCK_MSG = {
  location: 'We need your location to check the distance to our office, so we can only consider applicants who share it. If you change your mind, allow location access for this page in your browser settings and press "Try again". Thank you for your interest.',
  gig: 'This internship runs on a gig-based model, so we can only consider people who are open to it. Thank you for your interest.',
}
const blockReason = () => loc.state === 'denied' ? 'location' : f.gig.value === 'No' ? 'gig' : null
const blocked  = () => blockReason() !== null
const eligible = () => loc.state === 'ready' && f.gig.value === 'Yes'

function setError(key, msg) {
  const p = $('err-' + key)
  if (p) p.textContent = msg
  const el = key === 'cv' ? $('drop') : f[key]
  if (el) el.classList.toggle('invalid', !!msg)
}

const LOC_TEXT = {
  idle: '', asking: 'Waiting for your browser. Please press Allow.',
  denied: 'Location not shared.',
  failed: 'We could not read your location. Check that location is on for this device, then try again.',
}

function refresh() {
  // location block
  const ready = loc.state === 'ready'
  f.loc.hidden = ready
  f.loc.disabled = loc.state === 'asking'
  f.loc.textContent = loc.state === 'asking' ? 'Waiting for your browser…'
    : (loc.state === 'denied' || loc.state === 'failed') ? 'Try again' : 'Share my location'
  const st = $('locStatus')
  st.className = 'ap-loc-status'
  if (ready) {
    if (loc.source === 'corrected') {
      st.textContent = 'Using the place you chose: ' + loc.label
      st.classList.add('ok')
    } else {
      const m = Math.round(loc.accuracy || 0)
      st.textContent = m > FUZZY_M
        ? `Location captured, but it looks approximate (about ${m} m). If it is wrong, correct it below.`
        : `Location captured (accuracy about ${m} m).`
      st.classList.add(m > FUZZY_M ? 'warn' : 'ok')
    }
  } else {
    st.textContent = LOC_TEXT[loc.state]
    if (loc.state === 'denied' || loc.state === 'failed') st.classList.add('warn')
  }
  $('fixOpen').hidden = !ready
  if (!ready) $('fixBox').hidden = true

  // office question + distance
  $('officeField').hidden = !ready
  if (ready) $('distText').textContent = distanceKm().toFixed(2)

  // block message, CV, submit
  f.blocked.hidden = !blocked()
  if (blocked()) f.blocked.textContent = BLOCK_MSG[blockReason()]
  f.cvField.hidden = !eligible()
  f.submit.disabled = blocked() || sending
  f.submit.textContent = blocked() ? 'Cannot apply with this answer' : 'Send application →'
  if (blocked()) { f.cv.value = ''; f.fileName.textContent = hint(); f.status.textContent = '' }
}
const hint = () => `PDF, DOC or DOCX, up to ${MAX_MB} MB`

// ── EMAIL / CV CHECKS (unchanged from applicant.js) ───────────────────────

function emailProblem(v) {
  v = v.trim()
  if (!v) return 'Enter your email address.'
  if (!EMAIL_RE.test(v)) return 'Enter an email address like name@example.com.'
  return ''
}

function suggestEmail() {
  const v = f.email.value.trim().toLowerCase(), at = v.lastIndexOf('@')
  const fix = at > 0 && TYPOS[v.slice(at + 1)] ? v.slice(0, at) + '@' + TYPOS[v.slice(at + 1)] : ''
  f.suggest.hidden = !fix
  f.suggest.textContent = ''
  if (!fix) return
  const b = document.createElement('button')
  b.type = 'button'; b.textContent = fix
  b.onclick = () => { f.email.value = fix; f.suggest.hidden = true; setError('email', '') }
  f.suggest.append('Did you mean ', b, '?')
}

// Real file type check by signature, not just the extension
function signatureOk(file) {
  return new Promise(res => {
    const r = new FileReader()
    r.onload = () => {
      const b = new Uint8Array(r.result), e = ext(file.name)
      const pdf = b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46
      const zip = b[0] === 0x50 && b[1] === 0x4B
      const ole = b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0
      res((e === 'pdf' && pdf) || (e === 'docx' && zip) || (e === 'doc' && ole))
    }
    r.onerror = () => res(false)
    r.readAsArrayBuffer(file.slice(0, 8))
  })
}

async function cvProblem() {
  const file = f.cv.files[0]
  if (!file) return 'Choose your CV.'
  if (!MIME[ext(file.name)]) return 'Upload a PDF, DOC or DOCX file.'
  if (!file.size) return 'This file is empty. Choose another one.'
  if (file.size > MAX_MB * 1048576) return `This file is over ${MAX_MB} MB. Choose a smaller one.`
  return (await signatureOk(file)) ? '' : 'This file is damaged or not a real ' + ext(file.name).toUpperCase() + '. Choose another one.'
}

async function emailTaken(email) {
  const { data, error } = await db.rpc('mulai_email_exists', { p_email: email })
  if (error) throw error
  return data === true
}

// ── EVENTS ────────────────────────────────────────────────────────────────

f.loc.addEventListener('click', askLocation)
$('fixOpen').addEventListener('click', () => { $('fixBox').hidden = !$('fixBox').hidden; if (!$('fixBox').hidden) $('fixQuery').focus() })
$('fixFind').addEventListener('click', findPlace)
$('fixQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findPlace() } })
$('fixBack').addEventListener('click', useBrowserFix)
f.office.addEventListener('change', () => setError('office', ''))
f.gig.addEventListener('change', () => { setError('gig', ''); refresh() })
f.qualification.addEventListener('change', () => setError('qualification', ''))
f.name.addEventListener('input', () => setError('name', ''))
f.email.addEventListener('input', () => { setError('email', ''); suggestEmail() })

f.email.addEventListener('blur', async () => {
  f.email.value = f.email.value.trim()
  const bad = f.email.value ? emailProblem(f.email.value) : ''
  if (bad) { setError('email', bad); return }
  if (!f.email.value) return
  try { if (await emailTaken(f.email.value.toLowerCase())) setError('email', DUP_MSG) } catch { /* checked again on send */ }
})

f.cv.addEventListener('change', async () => {
  const file = f.cv.files[0]
  f.fileName.textContent = file ? file.name : hint()
  f.fileName.classList.toggle('has-file', !!file)
  if (!file) { setError('cv', ''); return }
  const bad = await cvProblem()
  setError('cv', bad)
  if (bad) { f.cv.value = ''; f.fileName.textContent = hint(); f.fileName.classList.remove('has-file') }
})

f.form.addEventListener('submit', async e => {
  e.preventDefault()
  if (sending || blocked()) return
  f.status.textContent = ''; f.status.className = 'ap-status'

  const name = f.name.value.trim().replace(/\s+/g, ' ')
  const email = f.email.value.trim().toLowerCase()
  let first = null
  const bad = (k, m) => { setError(k, m); first = first || k }

  name.length < 2 ? bad('name', 'Enter your full name.') : setError('name', '')
  const em = emailProblem(email); em ? bad('email', em) : setError('email', '')
  loc.state === 'ready' ? setError('loc', '') : bad('loc', 'Share your location to continue.')
  if (loc.state === 'ready') f.office.value ? setError('office', '') : bad('office', 'Select an option.')
  ;['gig', 'qualification'].forEach(k => f[k].value ? setError(k, '') : bad(k, 'Select an option.'))
  const cvm = await cvProblem(); cvm ? bad('cv', cvm) : setError('cv', '')

  if (first) { (first === 'cv' ? $('drop') : f[first]).scrollIntoView({ block: 'center' }); return }
  if (f.hp.value) { done(email); return }   // spam trap: pretend success, send nothing

  sending = true; refresh(); f.submit.textContent = 'Sending…'
  const file = f.cv.files[0]
  const cvPath = crypto.randomUUID() + '.' + ext(file.name)
  const r6 = n => n == null ? null : Math.round(n * 1e6) / 1e6

  try {
    if (await emailTaken(email)) throw Object.assign(new Error('dup'), { dup: true })

    const up = await db.storage.from(BUCKET).upload(cvPath, file, { contentType: MIME[ext(file.name)], upsert: false })
    if (up.error) throw up.error

    const ins = await db.from('mulai_applications').insert({
      full_name: name, email, gig: f.gig.value,
      qualification: f.qualification.value, cv_path: cvPath,
      // new location fields (distance_km is recomputed by the database; this value is only a hint)
      latitude: r6(loc.lat), longitude: r6(loc.lon),
      location_source: loc.source,
      location_label: loc.label,
      location_accuracy_m: loc.source === 'browser' && loc.accuracy != null ? Math.round(loc.accuracy) : null,
      browser_latitude: r6(loc.bLat), browser_longitude: r6(loc.bLon),
      distance_km: Math.round(distanceKm() * 100) / 100,
      office_3days: f.office.value === 'Yes',
    })
    if (ins.error) throw Object.assign(ins.error, { dup: ins.error.code === '23505' })

    done(email)
  } catch (err) {
    sending = false; refresh()
    if (err.dup) { setError('email', DUP_MSG); f.email.focus(); return }
    console.error('Application failed:', err)
    f.status.textContent = 'Your application was not sent. Check your connection and try again.'
    f.status.className = 'ap-status err'
  }
})

function done(email) {
  $('sentTo').textContent = email
  $('formView').hidden = true
  $('doneView').hidden = false
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// ── PUNCH STRIP + CLOCK (decorative, same motif as the rest of the site) ──

const strip = $('topStrip')
const pat = [1,0,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,0,1,1,0,1,0,1,0,0,1,0,1]
for (let s = 0; s < 2; s++) {
  const d = document.createElement('div')
  d.className = 'punch-holes' + (s ? ' punch-holes-2' : '')
  for (let r = 0; r < 6; r++) pat.forEach(p => {
    const h = document.createElement('div'); h.className = 'hole' + (p ? ' punched' : ''); d.appendChild(h)
  })
  strip.appendChild(d)
}
const tick = () => { $('apClock').textContent = new Date().toTimeString().slice(0, 5) }
tick(); setInterval(tick, 30000)

refresh()
