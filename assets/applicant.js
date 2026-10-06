/**
 * applicant.js — Mulai · Join us
 * Public page, no sign-in. Uses the shared client from vtm_db.js, so
 * applications land in Mulai's own Supabase project:
 *   table   mulai_applications   (insert only, see scripts/migration_mulai_applications.sql)
 *   bucket  mulai-cvs            (private, upload only)
 *   rpc     mulai_email_exists   (true/false, no data returned)
 */
import { db } from './vtm_db.js'

const BUCKET = 'mulai-cvs'
const MAX_MB = 2
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
  form: $('applyForm'), name: $('fullName'), email: $('email'), location: $('location'),
  gig: $('gig'), qualification: $('qualification'), cv: $('cv'), cvField: $('cvField'),
  fileName: $('fileName'), blocked: $('blockedMsg'), submit: $('submitBtn'),
  status: $('formStatus'), hp: $('company_website'), suggest: $('emailSuggest'),
}
let sending = false

const ext = n => (n.split('.').pop() || '').toLowerCase()
const BLOCK_MSG = {
  location: 'We are currently not hiring outside Kovai. Thank you for your interest.',
  gig: 'This internship runs on a gig-based model, so we can only consider people who are open to it. Thank you for your interest.',
}
const blockReason = () => f.location.value === 'No' ? 'location' : f.gig.value === 'No' ? 'gig' : null
const blocked  = () => f.location.value === 'No' || f.gig.value === 'No'
const eligible = () => f.location.value === 'Yes' && f.gig.value === 'Yes'

function setError(key, msg) {
  const p = $('err-' + key)
  if (p) p.textContent = msg
  const el = key === 'cv' ? $('drop') : f[key]
  if (el) el.classList.toggle('invalid', !!msg)
}

function refresh() {
  f.blocked.hidden = !blocked()
  if (blocked()) f.blocked.textContent = BLOCK_MSG[blockReason()]
  f.cvField.hidden = !eligible()
  f.submit.disabled = blocked() || sending
  f.submit.textContent = blocked() ? 'Cannot apply with this answer' : 'Send application →'
  if (blocked()) { f.cv.value = ''; f.fileName.textContent = hint(); f.status.textContent = '' }
}
const hint = () => `PDF, DOC or DOCX, up to ${MAX_MB} MB`

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

f.location.addEventListener('change', () => { setError('location', ''); refresh() })
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
  ;['location', 'gig', 'qualification'].forEach(k => f[k].value ? setError(k, '') : bad(k, 'Select an option.'))
  const cvm = await cvProblem(); cvm ? bad('cv', cvm) : setError('cv', '')

  if (first) { (first === 'cv' ? $('drop') : f[first]).scrollIntoView({ block: 'center' }); return }
  if (f.hp.value) { done(email); return }   // spam trap: pretend success, send nothing

  sending = true; refresh(); f.submit.textContent = 'Sending…'
  const file = f.cv.files[0]
  const cvPath = crypto.randomUUID() + '.' + ext(file.name)

  try {
    if (await emailTaken(email)) throw Object.assign(new Error('dup'), { dup: true })

    const up = await db.storage.from(BUCKET).upload(cvPath, file, { contentType: MIME[ext(file.name)], upsert: false })
    if (up.error) throw up.error

    const ins = await db.from('mulai_applications').insert({
      full_name: name, email, location: f.location.value, gig: f.gig.value,
      qualification: f.qualification.value, cv_path: cvPath,
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
