import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  R2?: R2Bucket
  SUPER_ADMIN_EMAIL?: string
  RESEND_API_KEY?: string
  SENDGRID_API_KEY?: string
  MAIL_FROM?: string
  // ── LLM(AI) 연동: 키는 Cloudflare 시크릿으로만 주입. 프론트에 노출 금지. ──
  // 나중에 설정에서 키를 바꾸려면 `wrangler pages secret put AI_API_KEY` 로 교체.
  AI_API_KEY?: string          // OpenAI 호환 API 키 (Groq 등)
  AI_BASE_URL?: string         // 예) https://api.groq.com/openai/v1
  AI_MODEL?: string            // 예) openai/gpt-oss-120b
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/tables/*', cors())
app.use('/api/*', cors())

/* ════════════════════════════════════════════
   인증/권한 — Google Identity (JWT) 검증
   · 슈퍼관리자: SUPER_ADMIN (디자이너 지정 + 모든 권한)
   · 디자이너:   designers 테이블에 등록된 이메일
   · 그 외:      뷰어
════════════════════════════════════════════ */
/** 슈퍼관리자 이메일 — 환경변수 SUPER_ADMIN_EMAIL 우선, 없으면 기본값(하위호환).
 *  운영 배포 시: wrangler.jsonc vars 또는 `wrangler pages secret put SUPER_ADMIN_EMAIL` 권장. */
const SUPER_ADMIN_FALLBACK = 'designssir@gmail.com'
const SUPER_ADMIN = SUPER_ADMIN_FALLBACK // 모듈 레벨 데모/문서용 기본값
function superAdmin(c: any): string {
  const v = c?.env?.SUPER_ADMIN_EMAIL
  return (typeof v === 'string' && v.includes('@')) ? v.trim().toLowerCase() : SUPER_ADMIN_FALLBACK
}

/* ── 데모 진입(구글 로그인 없이 바로 테스트) ──
 * 구글 OAuth 클라이언트 ID가 아직 없거나, 빠른 시연이 필요할 때 사용.
 * 클라이언트가 보내는 'Bearer demo-designer' / 'Bearer demo-viewer' 토큰을 인식한다.
 * - demo-designer : 디자이너 권한(프로젝트 생성/삭제까지 테스트 가능)
 * - demo-viewer   : 뷰어 권한(열람만)
 * 운영에서 끄려면 DEMO_LOGIN_ENABLED = false 로 변경. */
const DEMO_LOGIN_ENABLED = true
const DEMO_DESIGNER = { email: 'demo.designer@seastargo.com', name: '데모 설계자', picture: '', role: 'designer' as const }
const DEMO_VIEWER = { email: 'demo.viewer@seastargo.com', name: '데모 열람자', picture: '', role: 'viewer' as const }

const DEMO_SUPER = { email: SUPER_ADMIN, name: '데모 슈퍼관리자', picture: '', role: 'super' as const }

/** 데모 토큰이면 가짜 사용자 반환, 아니면 null */
function demoUserFromToken(token: string): any | null {
  if (!DEMO_LOGIN_ENABLED) return null
  if (token === 'demo-designer') return { ...DEMO_DESIGNER, _demo: true }
  if (token === 'demo-viewer') return { ...DEMO_VIEWER, _demo: true }
  if (token === 'demo-super') return { ...DEMO_SUPER, _demo: true }
  return null
}

// 구글 공개키 캐시 (JWKS)
let _googleKeys: { keys: any[]; exp: number } | null = null

async function getGoogleKeys(): Promise<any[]> {
  const now = Date.now()
  if (_googleKeys && _googleKeys.exp > now) return _googleKeys.keys
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs')
  const json: any = await res.json()
  // Cache-Control max-age 사용, 없으면 1시간
  const cc = res.headers.get('cache-control') || ''
  const m = cc.match(/max-age=(\d+)/)
  const ttl = m ? Number(m[1]) * 1000 : 3600_000
  _googleKeys = { keys: json.keys || [], exp: now + ttl }
  return _googleKeys.keys
}

function b64urlToUint8(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeJwtPart(part: string): any {
  const json = new TextDecoder().decode(b64urlToUint8(part))
  return JSON.parse(json)
}

/**
 * 구글 ID 토큰(JWT) 검증. 성공 시 payload(이메일 등) 반환, 실패 시 null.
 * audience(clientId)는 선택적으로 검증 (설정돼 있으면).
 */
async function verifyGoogleToken(token: string): Promise<any | null> {
  try {
    const [h, p, s] = token.split('.')
    if (!h || !p || !s) return null
    const header = decodeJwtPart(h)
    const payload = decodeJwtPart(p)

    // 발급자/만료 검증
    const iss = payload.iss
    if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') return null
    if (payload.exp && Date.now() / 1000 > payload.exp) return null
    if (!payload.email || payload.email_verified === false) return null

    // 서명 검증 (RS256)
    const keys = await getGoogleKeys()
    const jwk = keys.find((k: any) => k.kid === header.kid)
    if (!jwk) return null
    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    )
    const data = new TextEncoder().encode(h + '.' + p)
    const sig = b64urlToUint8(s)
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data)
    if (!valid) return null
    return payload
  } catch {
    return null
  }
}

/* ════════════════════════════════════════════
   회사 이메일 자체가입(self-signup) — 헬퍼
   · 회사 이메일(xxx@회사.com)로 인증코드 발송 → 검증 → 비밀번호 설정
   · 발급된 로컬 세션 토큰("local-...")으로 로그인 유지 (뷰어 권한)
   · 모든 로그인은 activity_log 에 기록
════════════════════════════════════════════ */
const ONE_FREE_PROVIDERS = new Set([
  'gmail.com','naver.com','daum.net','hanmail.net','nate.com','kakao.com',
  'yahoo.com','hotmail.com','outlook.com','icloud.com','live.com','aol.com',
  'protonmail.com','proton.me','yandex.com','qq.com','163.com','126.com'
])

function normEmail(s: string): string { return String(s || '').trim().toLowerCase() }
function emailDomain(email: string): string { const i = email.indexOf('@'); return i < 0 ? '' : email.slice(i + 1) }
function isValidEmail(email: string): boolean { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) }
function gen6(): string { return String(Math.floor(100000 + Math.random() * 900000)) }
function randToken(prefix: string): string {
  const a = new Uint8Array(24); crypto.getRandomValues(a)
  let h = ''; for (const x of a) h += x.toString(16).padStart(2, '0')
  return prefix + h
}
function bufToHex(buf: ArrayBuffer): string {
  const a = new Uint8Array(buf); let h = ''
  for (const x of a) h += x.toString(16).padStart(2, '0')
  return h
}
/** PBKDF2(SHA-256) 비밀번호 해시 */
async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  let salt: Uint8Array
  if (saltHex) {
    salt = new Uint8Array(saltHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
  } else {
    salt = new Uint8Array(16); crypto.getRandomValues(salt)
  }
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, baseKey, 256)
  return { hash: bufToHex(bits), salt: bufToHex(salt.buffer) }
}
async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const { hash } = await hashPassword(password, saltHex)
  // 상수시간 비교(간이)
  if (hash.length !== hashHex.length) return false
  let diff = 0
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i)
  return diff === 0
}

/** 허용 도메인 목록(화이트리스트).
 *  projectId 지정 시: 해당 프로젝트 전용 + 전역('*') 도메인을 합산.
 *  미지정 시: 모든 도메인(전역+프로젝트별) 합산. */
async function allowedDomainList(c: any, projectId?: string): Promise<string[]> {
  try {
    let q: any
    if (projectId) {
      q = c.env.DB.prepare(
        "SELECT domain FROM allowed_domains WHERE deleted = 0 AND (project_id = ? OR project_id = '*')"
      ).bind(projectId)
    } else {
      q = c.env.DB.prepare('SELECT domain FROM allowed_domains WHERE deleted = 0')
    }
    const { results } = await q.all()
    return Array.from(new Set((results || []).map((r: any) => String(r.domain).toLowerCase())))
  } catch { return [] }
}

/** 회사 도메인 가입 가능 여부 검사. 통과 시 {ok:true}, 실패 시 사유.
 *  projectId 가 주어지면 해당 프로젝트(또는 전역) 화이트리스트만 적용. */
async function checkSignupDomain(c: any, email: string, projectId?: string): Promise<{ ok: boolean; reason?: string }> {
  if (!isValidEmail(email)) return { ok: false, reason: '올바른 이메일 형식이 아닙니다.' }
  const domain = emailDomain(email)
  if (!domain) return { ok: false, reason: '도메인을 확인할 수 없습니다.' }
  const wl = await allowedDomainList(c, projectId)
  if (wl.length > 0) {
    // 화이트리스트가 설정돼 있으면 그 안에 있는 도메인만 허용
    if (!wl.includes(domain)) {
      return { ok: false, reason: '관리자가 허용한 회사 도메인이 아닙니다: @' + domain }
    }
    return { ok: true }
  }
  // 화이트리스트 미설정: 개인용 무료 메일 제공자는 차단(회사 메일만 허용)
  if (ONE_FREE_PROVIDERS.has(domain)) {
    return { ok: false, reason: '회사 이메일(@회사도메인)로만 가입할 수 있습니다. 개인 메일은 사용할 수 없습니다.' }
  }
  return { ok: true }
}

/** 이메일 발송. RESEND_API_KEY 또는 SENDGRID_API_KEY 가 있으면 실제 발송, 없으면 dev-fallback(코드 반환). */
async function sendVerificationEmail(c: any, email: string, code: string): Promise<{ sent: boolean; devCode?: string; provider?: string }> {
  const subject = '[SEASTAR 360° 뷰어] 이메일 인증코드'
  const fromEmail = (c.env?.MAIL_FROM && String(c.env.MAIL_FROM).includes('@')) ? c.env.MAIL_FROM : 'no-reply@seastargo.com'
  const text = `SEASTAR 360° 위치 뷰어 가입 인증코드: ${code}\n\n이 코드는 10분간 유효합니다. 본인이 요청하지 않았다면 무시하세요.`
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
    <h2 style="color:#0b3a5b">SEASTAR 360° 위치 뷰어</h2>
    <p>아래 인증코드를 입력해 회원가입을 완료하세요.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f1f5f9;padding:16px 24px;border-radius:12px;text-align:center;color:#0b3a5b">${code}</div>
    <p style="color:#64748b;font-size:13px">이 코드는 10분간 유효합니다. 본인이 요청하지 않았다면 무시하세요.</p>
  </div>`
  try {
    if (c.env?.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + c.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromEmail, to: [email], subject, html, text })
      })
      if (res.ok) return { sent: true, provider: 'resend' }
    } else if (c.env?.SENDGRID_API_KEY) {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + c.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email }] }],
          from: { email: fromEmail, name: 'SEASTAR 360 Viewer' },
          subject,
          content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }]
        })
      })
      if (res.ok || res.status === 202) return { sent: true, provider: 'sendgrid' }
    }
  } catch (e) { /* 발송 실패 → dev-fallback */ }
  // dev-fallback: 메일 발송 미설정/실패 시 코드 자체를 응답에 포함(개발/시연용)
  return { sent: false, devCode: code }
}

/** 로컬 세션 토큰 검증 → 사용자 반환(없으면 null) */
async function resolveLocalSession(c: any, token: string): Promise<any | null> {
  try {
    const sess: any = await c.env.DB.prepare(
      'SELECT email, expires_at, revoked FROM local_sessions WHERE token = ?'
    ).bind(token).first()
    if (!sess || sess.revoked || (sess.expires_at && Date.now() > sess.expires_at)) return null
    const u: any = await c.env.DB.prepare(
      'SELECT email, name FROM local_users WHERE email = ? AND deleted = 0'
    ).bind(sess.email).first()
    if (!u) return null
    return { email: String(u.email).toLowerCase(), name: u.name || '', picture: '', _local: true }
  } catch { return null }
}

/** Authorization: Bearer <idToken> 에서 검증된 사용자 반환 (없으면 null) */
async function getUser(c: any): Promise<any | null> {
  const auth = c.req.header('Authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const token = m[1]
  // 데모 토큰 우선 처리 (구글 로그인 없이 바로 진입/테스트)
  const demo = demoUserFromToken(token)
  if (demo) return demo
  // 회사 이메일 자체가입 로컬 세션 토큰 ("local-...")
  if (token.startsWith('local-')) {
    const lu = await resolveLocalSession(c, token)
    if (lu) return lu
    return null
  }
  const payload = await verifyGoogleToken(token)
  if (!payload) return null
  return { email: String(payload.email).toLowerCase(), name: payload.name || '', picture: payload.picture || '' }
}

async function isDesigner(c: any, email: string): Promise<boolean> {
  if (email === superAdmin(c)) return true
  if (DEMO_LOGIN_ENABLED && email === DEMO_DESIGNER.email) return true
  const row = await c.env.DB.prepare(
    'SELECT email FROM designers WHERE email = ? AND deleted = 0'
  ).bind(email).first()
  return !!row
}

function roleOf(c: any, email: string, designer: boolean): 'super' | 'designer' | 'viewer' {
  if (email === superAdmin(c)) return 'super'
  if (designer) return 'designer'
  return 'viewer'
}

/* ── 현재 로그인 사용자 + 권한 ── */
app.get('/api/auth/me', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ authenticated: false, role: 'viewer' })
  const designer = await isDesigner(c, user.email)
  const role = roleOf(c, user.email, designer)
  // 로그인 시 디자이너의 표시 이름 갱신(존재 시, 데모 계정 제외)
  if (role === 'designer' && !user._demo) {
    await c.env.DB.prepare('UPDATE designers SET name = ?, updated_at = ? WHERE email = ?')
      .bind(user.name, Date.now(), user.email).run()
  }
  // 권한 없는(viewer) 로그인 사용자의 사용 신청 상태 동봉
  let request_status: string | null = null
  if (role === 'viewer' && !user._demo) {
    const rr: any = await c.env.DB.prepare(
      'SELECT status FROM access_requests WHERE email = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1'
    ).bind(user.email).first().catch(() => null)
    if (rr) request_status = rr.status
  }
  // 실제 로그인(데모 제외)만 로그 기록
  if (!user._demo) await logActivity(c, 'auth.login', { actor: user, targetType: 'auth', detail: { role, local: !!user._local } })
  return c.json({ authenticated: true, email: user.email, name: user.name, picture: user.picture, role, demo: !!user._demo, local: !!user._local, request_status, super_admin: superAdmin(c) })
})

/* ════════════════════════════════════════════
   AI(LLM) 연동 — OpenAI 호환 프록시
   · 키(AI_API_KEY)는 Cloudflare 시크릿으로만 주입 → 프론트에 절대 노출 안 함
   · 나중에 키 교체: `npx wrangler pages secret put AI_API_KEY`
   · GET  /api/ai/config : 활성 여부 + 모델명만 반환(키는 미반환)
   · POST /api/ai/chat   : { messages:[{role,content}], model?, temperature? } → 응답
════════════════════════════════════════════ */
const AI_DEFAULT_BASE = 'https://api.groq.com/openai/v1'
const AI_DEFAULT_MODEL = 'openai/gpt-oss-120b'

app.get('/api/ai/config', async (c) => {
  const enabled = !!(c.env?.AI_API_KEY)
  return c.json({
    enabled,
    model: c.env?.AI_MODEL || AI_DEFAULT_MODEL,
    base_url: c.env?.AI_BASE_URL || AI_DEFAULT_BASE,
    note: enabled
      ? 'AI 연동이 활성화되어 있습니다.'
      : 'AI 키가 설정되지 않았습니다. 관리자가 AI_API_KEY 시크릿을 설정하면 활성화됩니다.'
  })
})

app.post('/api/ai/chat', async (c) => {
  // 로그인 사용자만 사용 가능(키/비용 보호)
  const user = await getUser(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const apiKey = c.env?.AI_API_KEY
  if (!apiKey) {
    return c.json({
      error: 'AI 키가 설정되지 않았습니다. 관리자가 설정에서 AI_API_KEY 시크릿을 등록해야 합니다.',
      hint: 'npx wrangler pages secret put AI_API_KEY'
    }, 503)
  }

  let body: any = {}
  try { body = await c.req.json() } catch { body = {} }
  const messages = Array.isArray(body.messages) ? body.messages : null
  if (!messages || !messages.length) return c.json({ error: 'messages 배열이 필요합니다.' }, 400)

  const baseUrl = (c.env?.AI_BASE_URL || AI_DEFAULT_BASE).replace(/\/$/, '')
  const model = body.model || c.env?.AI_MODEL || AI_DEFAULT_MODEL
  const temperature = (typeof body.temperature === 'number') ? body.temperature : 1

  try {
    const resp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_completion_tokens: Math.min(body.max_tokens || 4096, 8192),
        top_p: 1,
        stream: false
      })
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      return c.json({ error: 'AI 제공자 오류(' + resp.status + ')', detail: errText.slice(0, 300) }, 502)
    }
    const data: any = await resp.json()
    const content = data?.choices?.[0]?.message?.content ?? ''
    await logActivity(c, 'ai.chat', { actor: user, targetType: 'ai', detail: { model } }).catch(() => {})
    return c.json({ content, model, usage: data?.usage || null })
  } catch (e: any) {
    return c.json({ error: 'AI 호출 실패', detail: String(e).slice(0, 200) }, 502)
  }
})

/* ════════════════════════════════════════════
   회사 이메일 자체가입(self-signup) — API
   1) POST /api/signup/send-code   : 회사 이메일로 인증코드 발송
   2) POST /api/signup/verify      : 인증코드 + 비밀번호 → 계정 생성 + 자동 로그인
   3) POST /api/signup/login       : 이메일 + 비밀번호 → 로컬 세션 토큰 발급
   4) POST /api/signup/logout      : 세션 무효화
════════════════════════════════════════════ */

// 가입 정책 안내(프론트가 폼 표시 전 호출). 화이트리스트 존재 여부 알림.
//  ?project_id=<id> 지정 시 해당 프로젝트 전용 정책.
app.get('/api/signup/policy', async (c) => {
  const projectId = c.req.query('project_id') || undefined
  const wl = await allowedDomainList(c, projectId)
  return c.json({
    whitelist_enabled: wl.length > 0,
    allowed_domains: wl,
    project_id: projectId || null,
    note: wl.length > 0 ? '아래 회사 도메인 이메일로만 가입할 수 있습니다.' : '회사 이메일(@회사도메인)로 가입할 수 있습니다. 개인 메일은 사용할 수 없습니다.'
  })
})

// 1) 인증코드 발송
app.post('/api/signup/send-code', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = normEmail(body.email)
  const projectId = body.project_id || undefined
  const chk = await checkSignupDomain(c, email, projectId)
  if (!chk.ok) return c.json({ error: chk.reason }, 400)

  // 이미 가입된 계정인지 확인
  const exist: any = await c.env.DB.prepare('SELECT email FROM local_users WHERE email = ? AND deleted = 0').bind(email).first().catch(() => null)
  if (exist) return c.json({ error: '이미 가입된 이메일입니다. 로그인해 주세요.', already: true }, 409)

  // 재발송 쿨다운: 최근 60초 내 발송 코드가 있으면 차단
  const recent: any = await c.env.DB.prepare(
    'SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1'
  ).bind(email, 'signup').first().catch(() => null)
  if (recent && Date.now() - recent.created_at < 60000) {
    return c.json({ error: '잠시 후 다시 시도해 주세요. (1분에 1회)' }, 429)
  }

  const code = gen6()
  const now = Date.now()
  const expires = now + 10 * 60 * 1000 // 10분
  // 기존 미사용 코드는 무효화
  await c.env.DB.prepare('UPDATE email_codes SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0').bind(email, 'signup').run().catch(() => {})
  await c.env.DB.prepare(
    'INSERT INTO email_codes (id, email, code, purpose, created_at, expires_at, attempts, consumed) VALUES (?, ?, ?, ?, ?, ?, 0, 0)'
  ).bind(randToken('ec-'), email, code, 'signup', now, expires).run()

  const mail = await sendVerificationEmail(c, email, code)
  await logActivity(c, 'signup.code_sent', { actor: { email }, targetType: 'signup', targetId: email, detail: { provider: mail.provider || 'dev-fallback' } })
  const resp: any = { success: true, sent: mail.sent, email }
  if (!mail.sent && mail.devCode) {
    // 메일 발송 미설정/실패 시: 시연/개발용으로 코드 직접 반환
    resp.dev_code = mail.devCode
    resp.dev_note = '메일 발송이 설정되지 않아 인증코드를 직접 반환합니다(개발/시연용). RESEND_API_KEY 또는 SENDGRID_API_KEY 시크릿을 설정하면 실제 메일이 발송됩니다.'
  }
  return c.json(resp)
})

// 2) 인증코드 검증 + 계정 생성 + 자동 로그인
app.post('/api/signup/verify', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = normEmail(body.email)
  const code = String(body.code || '').trim()
  const password = String(body.password || '')
  const name = String(body.name || '').trim()
  const projectId = body.project_id || undefined

  const chk = await checkSignupDomain(c, email, projectId)
  if (!chk.ok) return c.json({ error: chk.reason }, 400)
  if (!/^\d{6}$/.test(code)) return c.json({ error: '인증코드 6자리를 입력해 주세요.' }, 400)
  if (password.length < 8) return c.json({ error: '비밀번호는 8자 이상이어야 합니다.' }, 400)

  const row: any = await c.env.DB.prepare(
    'SELECT id, code, expires_at, attempts, consumed FROM email_codes WHERE email = ? AND purpose = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1'
  ).bind(email, 'signup').first().catch(() => null)
  if (!row) return c.json({ error: '인증코드를 먼저 발송해 주세요.' }, 400)
  if (row.attempts >= 5) {
    await c.env.DB.prepare('UPDATE email_codes SET consumed = 1 WHERE id = ?').bind(row.id).run().catch(() => {})
    return c.json({ error: '시도 횟수를 초과했습니다. 코드를 다시 발송해 주세요.' }, 429)
  }
  if (Date.now() > row.expires_at) return c.json({ error: '인증코드가 만료되었습니다. 다시 발송해 주세요.' }, 400)
  if (row.code !== code) {
    await c.env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run().catch(() => {})
    return c.json({ error: '인증코드가 일치하지 않습니다.' }, 400)
  }

  // 코드 소모
  await c.env.DB.prepare('UPDATE email_codes SET consumed = 1 WHERE id = ?').bind(row.id).run().catch(() => {})

  // 계정 생성/갱신
  const { hash, salt } = await hashPassword(password)
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, pw_hash = excluded.pw_hash, pw_salt = excluded.pw_salt, email_verified = 1, updated_at = excluded.updated_at, deleted = 0`
  ).bind(email, name || email.split('@')[0], emailDomain(email), hash, salt, now, now).run()

  // 자동 로그인: 세션 토큰 발급
  const token = randToken('local-')
  const exp = now + 30 * 24 * 60 * 60 * 1000 // 30일
  await c.env.DB.prepare('INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
    .bind(token, email, now, exp).run()
  await c.env.DB.prepare('UPDATE local_users SET last_login_at = ? WHERE email = ?').bind(now, email).run().catch(() => {})

  await logActivity(c, 'signup.completed', { actor: { email }, targetType: 'local_user', targetId: email, detail: { domain: emailDomain(email) } })
  return c.json({ success: true, token, email, name: name || email.split('@')[0], role: 'viewer' })
})

// 3) 로그인(이메일 + 비밀번호)
app.post('/api/signup/login', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = normEmail(body.email)
  const password = String(body.password || '')
  if (!isValidEmail(email) || !password) return c.json({ error: '이메일과 비밀번호를 입력해 주세요.' }, 400)

  const u: any = await c.env.DB.prepare(
    'SELECT email, name, pw_hash, pw_salt FROM local_users WHERE email = ? AND deleted = 0'
  ).bind(email).first().catch(() => null)
  if (!u) return c.json({ error: '가입되지 않은 이메일이거나 비밀번호가 올바르지 않습니다.' }, 401)
  const ok = await verifyPassword(password, u.pw_salt, u.pw_hash)
  if (!ok) {
    await logActivity(c, 'auth.login_fail', { actor: { email }, targetType: 'local_user', targetId: email })
    return c.json({ error: '가입되지 않은 이메일이거나 비밀번호가 올바르지 않습니다.' }, 401)
  }

  const now = Date.now()
  const token = randToken('local-')
  const exp = now + 30 * 24 * 60 * 60 * 1000
  await c.env.DB.prepare('INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
    .bind(token, email, now, exp).run()
  await c.env.DB.prepare('UPDATE local_users SET last_login_at = ? WHERE email = ?').bind(now, email).run().catch(() => {})
  // auth.login 은 /api/auth/me 에서 기록되므로 여기선 세션 발급만
  return c.json({ success: true, token, email: u.email, name: u.name || u.email.split('@')[0], role: 'viewer' })
})

// 4) 로그아웃(세션 무효화)
app.post('/api/signup/logout', async (c) => {
  const auth = c.req.header('Authorization') || ''
  const m = auth.match(/^Bearer\s+(local-.+)$/i)
  if (m) await c.env.DB.prepare('UPDATE local_sessions SET revoked = 1 WHERE token = ?').bind(m[1]).run().catch(() => {})
  return c.json({ success: true })
})

/* ── 회사 도메인 화이트리스트 관리(슈퍼관리자 전용, 프로젝트별) ──
   · GET    /api/allowed-domains?project_id=<id|*>  목록(프로젝트별, 미지정 시 전체)
   · POST   /api/allowed-domains  { domain, project_id?, note? }
   · DELETE /api/allowed-domains/:id  (단건 삭제 by id) */
app.get('/api/allowed-domains', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const projectId = c.req.query('project_id')
  let rows: any
  if (projectId) {
    rows = await c.env.DB.prepare(
      'SELECT id, project_id, domain, note, added_by, created_at FROM allowed_domains WHERE deleted = 0 AND project_id = ? ORDER BY created_at DESC'
    ).bind(projectId).all()
  } else {
    rows = await c.env.DB.prepare(
      'SELECT id, project_id, domain, note, added_by, created_at FROM allowed_domains WHERE deleted = 0 ORDER BY project_id, created_at DESC'
    ).all()
  }
  return c.json({ data: rows.results || [] })
})
app.post('/api/allowed-domains', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const domain = String(body.domain || '').trim().toLowerCase().replace(/^@/, '')
  const projectId = String(body.project_id || '*').trim() || '*'
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return c.json({ error: '올바른 도메인을 입력해 주세요. (예: company.com)' }, 400)
  const id = randToken('dom-')
  await c.env.DB.prepare(
    `INSERT INTO allowed_domains (id, project_id, domain, note, added_by, created_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(project_id, domain) DO UPDATE SET deleted = 0, note = excluded.note`
  ).bind(id, projectId, domain, body.note || '', su.email, Date.now()).run()
  await logActivity(c, 'domain.add', { actor: su, targetType: 'domain', targetId: domain, detail: { project_id: projectId } })
  return c.json({ success: true, domain, project_id: projectId })
})
app.delete('/api/allowed-domains/:id', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const id = decodeURIComponent(c.req.param('id'))
  // id 또는 (하위호환) domain 으로 삭제 허용
  await c.env.DB.prepare('UPDATE allowed_domains SET deleted = 1 WHERE id = ? OR domain = ?').bind(id, id.toLowerCase()).run()
  await logActivity(c, 'domain.remove', { actor: su, targetType: 'domain', targetId: id })
  return c.json({ success: true })
})

/* ── 가입 사용자 목록(슈퍼관리자 전용) — 로그인 기록과 함께 관리 ── */
app.get('/api/local-users', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT email, name, domain, created_at, last_login_at FROM local_users WHERE deleted = 0 ORDER BY created_at DESC'
  ).all()
  return c.json({ data: results || [] })
})
app.delete('/api/local-users/:email', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const email = decodeURIComponent(c.req.param('email')).toLowerCase()
  await c.env.DB.prepare('UPDATE local_users SET deleted = 1, updated_at = ? WHERE email = ?').bind(Date.now(), email).run()
  await c.env.DB.prepare('UPDATE local_sessions SET revoked = 1 WHERE email = ?').bind(email).run().catch(() => {})
  await logActivity(c, 'local_user.delete', { actor: su, targetType: 'local_user', targetId: email })
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   활동 로그 — 슈퍼관리자가 모든 기록을 관리
════════════════════════════════════════════ */
function genLogId(): string {
  return 'log_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

/**
 * 주요 액션을 activity_log 에 기록한다.
 * 실패해도 본 요청 흐름을 막지 않도록 항상 try/catch 로 감싼다.
 */
async function logActivity(
  c: any,
  action: string,
  opts: { actor?: any; targetType?: string; targetId?: string; detail?: any } = {}
): Promise<void> {
  try {
    const actor = opts.actor ?? (await getUser(c).catch(() => null))
    let role = 'guest'
    if (actor) {
      role = actor.email === superAdmin(c)
        ? 'super'
        : (await isDesigner(c, actor.email).catch(() => false)) ? 'designer' : 'viewer'
    }
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || ''
    const ua = (c.req.header('User-Agent') || '').slice(0, 180)
    const detail = opts.detail == null
      ? null
      : (typeof opts.detail === 'string' ? opts.detail : JSON.stringify(opts.detail))
    await c.env.DB.prepare(
      `INSERT INTO activity_log (id, ts, actor_email, actor_role, action, target_type, target_id, detail, ip, ua, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      genLogId(), Date.now(), actor?.email || null, role,
      action, opts.targetType || null, opts.targetId || null, detail, ip, ua
    ).run()
  } catch (e) {
    // 로깅 실패는 무시(테이블 미생성 환경 등)
  }
}

/* ════════════════════════════════════════════
   designers — 디자이너 지정(슈퍼관리자 전용)
════════════════════════════════════════════ */
async function requireSuper(c: any): Promise<any | null> {
  const user = await getUser(c)
  if (!user || user.email !== superAdmin(c)) return null
  return user
}

app.get('/api/designers', async (c) => {
  const user = await getUser(c)
  if (!user || user.email !== superAdmin(c)) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT email, name, added_by, created_at FROM designers WHERE deleted = 0 ORDER BY created_at DESC'
  ).all()
  return c.json({ data: results || [], super_admin: superAdmin(c) })
})

app.post('/api/designers', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = String(body.email || '').trim().toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'invalid email' }, 400)
  if (email === superAdmin(c)) return c.json({ error: 'super admin is always designer' }, 400)
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET deleted = 0, added_by = excluded.added_by, updated_at = excluded.updated_at`
  ).bind(email, body.name || '', su.email, now, now).run()
  return c.json({ success: true, email })
})

app.delete('/api/designers/:email', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const email = decodeURIComponent(c.req.param('email')).toLowerCase()
  await c.env.DB.prepare('UPDATE designers SET deleted = 1, updated_at = ? WHERE email = ?')
    .bind(Date.now(), email).run()
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   access_requests — 사용 신청(Request Access)
   · 권한 없는 로그인 사용자가 설계자 권한을 신청
   · 슈퍼관리자가 목록 확인 → 승인 시 designers 등록
════════════════════════════════════════════ */
function genReqId(): string {
  return 'req_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36)
}

function mapRequest(r: any) {
  return {
    id: r.id, email: r.email, name: r.name, company: r.company, country: r.country,
    phone: r.phone, message: r.message, status: r.status, reviewed_by: r.reviewed_by,
    created_at: r.created_at, updated_at: r.updated_at,
  }
}

// 신청 접수 — 로그인한(구글 인증된) 사용자만, 본인 이메일로
app.post('/api/access-requests', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  // 이미 디자이너면 신청 불필요
  if (await isDesigner(c, user.email)) return c.json({ error: 'already designer', already: true }, 400)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const name = String(body.name || user.name || '').trim()
  const company = String(body.company || '').trim()
  const country = String(body.country || '').trim()
  const phone = String(body.phone || '').trim()
  const message = String(body.message || '').trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  const now = Date.now()
  // 같은 이메일의 pending 신청이 있으면 갱신, 없으면 새로 생성
  const existing: any = await c.env.DB.prepare(
    "SELECT * FROM access_requests WHERE email = ? AND status = 'pending' AND deleted = 0 ORDER BY created_at DESC LIMIT 1"
  ).bind(user.email).first()
  if (existing) {
    await c.env.DB.prepare(
      'UPDATE access_requests SET name=?, company=?, country=?, phone=?, message=?, updated_at=? WHERE id=?'
    ).bind(name, company, country, phone, message, now, existing.id).run()
    return c.json({ success: true, id: existing.id, status: 'pending', updated: true })
  }
  const id = genReqId()
  await c.env.DB.prepare(
    `INSERT INTO access_requests (id, email, name, company, country, phone, message, status, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0)`
  ).bind(id, user.email, name, company, country, phone, message, now, now).run()
  return c.json({ success: true, id, status: 'pending' })
})

// 내 신청 상태 조회 (로그인 사용자)
app.get('/api/access-requests/me', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ authenticated: false })
  const row: any = await c.env.DB.prepare(
    'SELECT * FROM access_requests WHERE email = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1'
  ).bind(user.email).first()
  return c.json({ authenticated: true, request: row ? mapRequest(row) : null })
})

// 신청 목록 (슈퍼관리자 전용)
app.get('/api/access-requests', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const status = c.req.query('status')
  const sql = status
    ? 'SELECT * FROM access_requests WHERE status = ? AND deleted = 0 ORDER BY created_at DESC'
    : 'SELECT * FROM access_requests WHERE deleted = 0 ORDER BY created_at DESC'
  const stmt = status ? c.env.DB.prepare(sql).bind(status) : c.env.DB.prepare(sql)
  const { results } = await stmt.all()
  return c.json({ data: (results || []).map(mapRequest) })
})

// 신청 승인 → designers 등록 (슈퍼관리자 전용)
app.post('/api/access-requests/:id/approve', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  const row: any = await c.env.DB.prepare('SELECT * FROM access_requests WHERE id = ? AND deleted = 0').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET deleted = 0, added_by = excluded.added_by, updated_at = excluded.updated_at`
  ).bind(row.email, row.name || '', su.email, now, now).run()
  await c.env.DB.prepare(
    "UPDATE access_requests SET status = 'approved', reviewed_by = ?, updated_at = ? WHERE id = ?"
  ).bind(su.email, now, id).run()
  await logActivity(c, 'access.approve', { actor: su, targetType: 'designer', targetId: row.email })
  return c.json({ success: true, email: row.email })
})

// 신청 거절 (슈퍼관리자 전용)
app.post('/api/access-requests/:id/reject', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  const now = Date.now()
  await c.env.DB.prepare(
    "UPDATE access_requests SET status = 'rejected', reviewed_by = ?, updated_at = ? WHERE id = ?"
  ).bind(su.email, now, id).run()
  await logActivity(c, 'access.reject', { actor: su, targetType: 'access_request', targetId: id })
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   activity_log — 슈퍼관리자 전용 로그 관리
════════════════════════════════════════════ */
function mapLog(r: any) {
  return {
    id: r.id, ts: r.ts, actor_email: r.actor_email, actor_role: r.actor_role,
    action: r.action, target_type: r.target_type, target_id: r.target_id,
    detail: r.detail, ip: r.ip, ua: r.ua,
  }
}

// 로그 목록 조회 (슈퍼관리자 전용) — 필터: action, actor, q(검색), 페이지네이션 limit/offset
app.get('/api/activity-logs', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const action = c.req.query('action') || ''
  const actor  = c.req.query('actor') || ''
  const q      = c.req.query('q') || ''
  const limit  = Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 500)
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0

  const where: string[] = ['deleted = 0']
  const args: any[] = []
  if (action) { where.push('action = ?'); args.push(action) }
  if (actor)  { where.push('actor_email = ?'); args.push(actor) }
  if (q) {
    where.push('(action LIKE ? OR actor_email LIKE ? OR target_type LIKE ? OR target_id LIKE ? OR detail LIKE ?)')
    const like = `%${q}%`; args.push(like, like, like, like, like)
  }
  const whereSql = where.join(' AND ')

  let total = 0
  try {
    const cnt: any = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE ${whereSql}`).bind(...args).first()
    total = cnt?.n || 0
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM activity_log WHERE ${whereSql} ORDER BY ts DESC LIMIT ? OFFSET ?`
    ).bind(...args, limit, offset).all()
    return c.json({ data: (results || []).map(mapLog), total, limit, offset })
  } catch (e) {
    // 테이블 미생성 등 → 빈 결과 반환(마이그레이션 적용 전)
    return c.json({ data: [], total: 0, limit, offset, note: 'activity_log not ready' })
  }
})

// 로그 액션 종류 요약(필터 UI용)
app.get('/api/activity-logs/actions', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT action, COUNT(*) AS n FROM activity_log WHERE deleted = 0 GROUP BY action ORDER BY n DESC'
    ).all()
    return c.json({ data: results || [] })
  } catch { return c.json({ data: [] }) }
})

// 로그 단건 삭제 (슈퍼관리자 전용, soft delete)
app.delete('/api/activity-logs/:id', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE activity_log SET deleted = 1 WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// 로그 일괄 정리 (슈퍼관리자 전용) — before(ms) 이전 또는 전체 비우기(?all=1)
app.delete('/api/activity-logs', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const all = c.req.query('all') === '1'
  const before = parseInt(c.req.query('before') || '0', 10) || 0
  if (all) {
    await c.env.DB.prepare('UPDATE activity_log SET deleted = 1 WHERE deleted = 0').run()
  } else if (before > 0) {
    await c.env.DB.prepare('UPDATE activity_log SET deleted = 1 WHERE ts < ? AND deleted = 0').bind(before).run()
  } else {
    return c.json({ error: 'specify all=1 or before=<ms>' }, 400)
  }
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   projects / decks — 디자이너 전용 생성/관리
════════════════════════════════════════════ */
async function requireDesigner(c: any): Promise<any | null> {
  const user = await getUser(c)
  if (!user) return null
  const designer = await isDesigner(c, user.email)
  if (!designer) return null
  return user
}

function mapProject(r: any) {
  return { id: r.id, name: r.name, description: r.description, owner: r.owner, created_at: r.created_at, updated_at: r.updated_at }
}
function mapDeck(r: any) {
  return { id: r.id, project_id: r.project_id, name: r.name, level_no: r.level_no, deployment_id: r.deployment_id, created_at: r.created_at, updated_at: r.updated_at }
}

// 프로젝트 목록 (누구나 조회 가능 — 뷰어도 탐색)
app.get('/api/projects', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE deleted = 0 ORDER BY created_at DESC'
  ).all()
  return c.json({ data: (results || []).map(mapProject) })
})

// 프로젝트 생성 (디자이너)
app.post('/api/projects', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const name = String(body.name || '').trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  const id = genId('prj')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, name, body.description || '', user.email, now, now).run()
  await logActivity(c, 'project.create', { actor: user, targetType: 'project', targetId: id, detail: { name } })
  return c.json(mapProject({ id, name, description: body.description || '', owner: user.email, created_at: now, updated_at: now }))
})

// 프로젝트 삭제 (디자이너)
app.delete('/api/projects/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  const now = Date.now()
  await c.env.DB.prepare('UPDATE projects SET deleted = 1, updated_at = ? WHERE id = ?').bind(now, id).run()
  await c.env.DB.prepare('UPDATE decks SET deleted = 1, updated_at = ? WHERE project_id = ?').bind(now, id).run()
  await logActivity(c, 'project.delete', { actor: user, targetType: 'project', targetId: id })
  return c.json({ success: true })
})

// 데크 목록 (프로젝트별, 누구나)
app.get('/api/projects/:id/decks', async (c) => {
  const pid = c.req.param('id')
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM decks WHERE project_id = ? AND deleted = 0 ORDER BY COALESCE(level_no, 999999), created_at'
  ).bind(pid).all()
  return c.json({ data: (results || []).map(mapDeck) })
})

// 데크 생성 (디자이너)
app.post('/api/projects/:id/decks', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const pid = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const name = String(body.name || '').trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  const id = genId('dck')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO decks (id, project_id, name, level_no, deployment_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, pid, name, body.level_no ?? null, body.deployment_id || null, now, now).run()
  return c.json(mapDeck({ id, project_id: pid, name, level_no: body.level_no ?? null, deployment_id: body.deployment_id || null, created_at: now, updated_at: now }))
})

// 데크 수정 (디자이너) — 배포본 연결/이름/층번호
app.put('/api/decks/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const row: any = await c.env.DB.prepare('SELECT * FROM decks WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  const name = body.name !== undefined ? String(body.name) : row.name
  const level = body.level_no !== undefined ? body.level_no : row.level_no
  const dep = body.deployment_id !== undefined ? body.deployment_id : row.deployment_id
  await c.env.DB.prepare(
    'UPDATE decks SET name = ?, level_no = ?, deployment_id = ?, updated_at = ? WHERE id = ?'
  ).bind(name, level, dep, Date.now(), id).run()
  return c.json(mapDeck({ ...row, name, level_no: level, deployment_id: dep }))
})

// 데크 삭제 (디자이너)
app.delete('/api/decks/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE decks SET deleted = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id).run()
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   유틸
════════════════════════════════════════════ */
function genId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}

// pano_images 행 → 프론트엔드 응답 형태
function mapImage(r: any) {
  return {
    id: r.id,
    name: r.name,
    image_data: r.image_data,
    width: r.width,
    height: r.height,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: !!r.deleted
  }
}

function mapDeployment(r: any) {
  return {
    id: r.id,
    title: r.title,
    file_name: r.file_name,
    drawing_data: r.drawing_data,
    pages_data: r.pages_data,
    pins: r.pins,
    zones: r.zones || '[]',
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: !!r.deleted
  }
}

/* ════════════════════════════════════════════
   pano_images — 360° 그림 클라우드 저장
════════════════════════════════════════════ */

// 목록
app.get('/tables/pano_images', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 1000)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM pano_images WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all()
  return c.json({ data: (results || []).map(mapImage), total: (results || []).length })
})

// 단건 조회
app.get('/tables/pano_images/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM pano_images WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(mapImage(row))
})

// 생성 (업로드)
app.post('/tables/pano_images', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  if (!body || !body.image_data) return c.json({ error: 'image_data required' }, 400)

  const id = genId('img')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO pano_images (id, name, image_data, width, height, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    id,
    body.name || '',
    body.image_data,
    body.width || null,
    body.height || null,
    now, now
  ).run()

  return c.json(mapImage({
    id, name: body.name || '', image_data: body.image_data,
    width: body.width || null, height: body.height || null,
    created_at: now, updated_at: now, deleted: 0
  }))
})

// 삭제 (soft delete) — 디자이너 이상
app.delete('/tables/pano_images/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE pano_images SET deleted = 1, updated_at = ? WHERE id = ?')
    .bind(Date.now(), id).run()
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   R2 객체 저장소 — 대용량 이미지/도면 바이너리
   · D1(base64)는 소형, R2는 원본 대용량을 권장
   · 키 형식: assets/<timestamp>-<rand>.<ext>
════════════════════════════════════════════ */

// R2 사용 가능 여부
app.get('/api/r2/status', (c) => {
  return c.json({ enabled: !!c.env.R2, bucket: 'seastar-assets' })
})

// 업로드 (raw body) — Content-Type 헤더로 MIME 결정 · 디자이너 이상
app.put('/api/r2/upload', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  if (!c.env.R2) return c.json({ error: 'R2 미구성 (wrangler.jsonc r2_buckets 확인)' }, 501)
  const ct = c.req.header('Content-Type') || 'application/octet-stream'
  const ext = ct.includes('png') ? 'png' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg'
    : ct.includes('webp') ? 'webp' : ct.includes('pdf') ? 'pdf' : 'bin'
  const key = `assets/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`
  const body = await c.req.arrayBuffer()
  await c.env.R2.put(key, body, { httpMetadata: { contentType: ct } })
  return c.json({ key, url: `/api/r2/object/${key}`, size: body.byteLength, contentType: ct })
})

// 다운로드 — /api/r2/object/assets/xxxx.png
app.get('/api/r2/object/*', async (c) => {
  if (!c.env.R2) return c.json({ error: 'R2 미구성' }, 501)
  const key = c.req.path.replace('/api/r2/object/', '')
  const obj = await c.env.R2.get(key)
  if (!obj) return c.notFound()
  const headers = new Headers()
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('ETag', obj.httpEtag)
  return new Response(obj.body, { headers })
})

// 삭제 (디자이너 이상)
app.delete('/api/r2/object/*', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  if (!c.env.R2) return c.json({ error: 'R2 미구성' }, 501)
  const key = c.req.path.replace('/api/r2/object/', '')
  await c.env.R2.delete(key)
  return c.json({ success: true, key })
})

/* ════════════════════════════════════════════
   deployments — 배포 스냅샷
════════════════════════════════════════════ */

// 목록
app.get('/tables/deployments', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 1000)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM deployments WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all()
  return c.json({ data: (results || []).map(mapDeployment), total: (results || []).length })
})

// 단건 조회 (특정 배포본 고정 공유 — B1)
app.get('/tables/deployments/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM deployments WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(mapDeployment(row))
})

// 생성 (배포) — 디자이너 이상
app.post('/tables/deployments', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }

  const id = genId('dep')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO deployments (id, title, file_name, drawing_data, pages_data, pins, zones, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    id,
    body.title || '',
    body.file_name || '',
    body.drawing_data || null,
    body.pages_data || null,
    body.pins || '[]',
    body.zones || '[]',
    now, now
  ).run()

  let pinCount = 0
  try { pinCount = Array.isArray(JSON.parse(body.pins || '[]')) ? JSON.parse(body.pins || '[]').length : 0 } catch {}
  await logActivity(c, 'deployment.create', { targetType: 'deployment', targetId: id, detail: { title: body.title || '', file_name: body.file_name || '', pins: pinCount } })

  return c.json(mapDeployment({
    id, title: body.title || '', file_name: body.file_name || '',
    drawing_data: body.drawing_data || null, pages_data: body.pages_data || null,
    pins: body.pins || '[]', zones: body.zones || '[]', created_at: now, updated_at: now, deleted: 0
  }))
})

// 갱신 (자동 저장 — 도면 업로드 즉시 생성된 배포본을 핀/영역 변경 시 갱신)
//  PATCH/PUT 모두 허용. 전달된 필드만 부분 갱신.
const updateDeployment = async (c: any) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const existing = await c.env.DB.prepare('SELECT * FROM deployments WHERE id = ? AND deleted = 0').bind(id).first()
  if (!existing) return c.json({ error: 'not found' }, 404)
  const now = Date.now()
  const merged = {
    title:        body.title        != null ? body.title        : existing.title,
    file_name:    body.file_name     != null ? body.file_name    : existing.file_name,
    drawing_data: body.drawing_data  != null ? body.drawing_data : existing.drawing_data,
    pages_data:   body.pages_data    != null ? body.pages_data   : existing.pages_data,
    pins:         body.pins          != null ? body.pins         : existing.pins,
    zones:        body.zones         != null ? body.zones        : existing.zones,
  }
  await c.env.DB.prepare(
    `UPDATE deployments SET title=?, file_name=?, drawing_data=?, pages_data=?, pins=?, zones=?, updated_at=? WHERE id=?`
  ).bind(
    merged.title, merged.file_name, merged.drawing_data, merged.pages_data,
    merged.pins, merged.zones, now, id
  ).run()
  return c.json(mapDeployment(Object.assign({}, existing, merged, { id, updated_at: now })))
}
app.patch('/tables/deployments/:id', updateDeployment)
app.put('/tables/deployments/:id', updateDeployment)

// 삭제 (soft delete) — 디자이너 이상
app.delete('/tables/deployments/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE deployments SET deleted = 1, updated_at = ? WHERE id = ?')
    .bind(Date.now(), id).run()
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   배치 동기화 — 오프라인 큐 일괄 업로드 (스마트폰 현장 → 인터넷 복구 시)
   POST /api/sync/batch
   body: { ops: [ { opId, kind:'image'|'doc', name, image_data, width?, height? }, ... ] }
   · 각 op 를 pano_images 에 저장하고, 클라이언트 임시 id(opId) → 서버 id 매핑을 반환
   · 부분 실패를 허용(개별 결과 보고)하여 재시도 시 멱등성 확보
════════════════════════════════════════════ */
app.post('/api/sync/batch', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const ops = Array.isArray(body?.ops) ? body.ops : []
  if (ops.length === 0) return c.json({ ok: true, results: [] })

  const results: any[] = []
  for (const op of ops) {
    try {
      if (!op || !op.image_data) {
        results.push({ opId: op?.opId, ok: false, error: 'image_data required' })
        continue
      }
      const id = genId('img')
      const now = Date.now()
      const name = (op.kind === 'doc' ? '[doc] ' : '') + (op.name || '')
      await c.env.DB.prepare(
        `INSERT INTO pano_images (id, name, image_data, width, height, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      ).bind(id, name, op.image_data, op.width || null, op.height || null, now, now).run()
      results.push({ opId: op.opId, ok: true, id })
    } catch (e: any) {
      results.push({ opId: op?.opId, ok: false, error: String(e?.message || e) })
    }
  }
  return c.json({ ok: true, results })
})

/* ════════════════════════════════════════════
   pin_notes — 이슈/필드노트 협업 (핀 단위 코멘트 스레드)
   · 조회: 누구나 (현장 열람)
   · 작성: 누구나 (익명 가능 — 현장 협업), 로그인 시 작성자/역할 기록
   · 수정/삭제/상태변경: 작성자(이메일 일치) 또는 디자이너
════════════════════════════════════════════ */
const VALID_STATUS = ['open', 'progress', 'done']

function mapNote(r: any) {
  return {
    id: r.id,
    deployment_id: r.deployment_id,
    pin_id: r.pin_id,
    pin_label: r.pin_label,
    body: r.body,
    status: r.status,
    assignee: r.assignee,
    author: r.author,
    author_email: r.author_email,
    author_role: r.author_role,
    created_at: r.created_at,
    updated_at: r.updated_at,
    resolved_at: r.resolved_at,
  }
}

// 노트 목록 — deployment_id 필수, pin_id 선택, status 선택
app.get('/api/notes', async (c) => {
  const dep = c.req.query('deployment_id')
  if (!dep) return c.json({ error: 'deployment_id required' }, 400)
  const pin = c.req.query('pin_id')
  const status = c.req.query('status')
  const limit = Math.min(Number(c.req.query('limit') || 500), 2000)
  let sql = 'SELECT * FROM pin_notes WHERE deleted = 0 AND deployment_id = ?'
  const args: any[] = [dep]
  if (pin) { sql += ' AND pin_id = ?'; args.push(pin) }
  if (status && VALID_STATUS.includes(status)) { sql += ' AND status = ?'; args.push(status) }
  sql += ' ORDER BY created_at ASC LIMIT ?'
  args.push(limit)
  const { results } = await c.env.DB.prepare(sql).bind(...args).all()
  return c.json({ data: (results || []).map(mapNote), total: (results || []).length })
})

// 배포 단위 노트 요약(핀별 카운트/상태) — 도면 위 뱃지 표시용
app.get('/api/notes/summary', async (c) => {
  const dep = c.req.query('deployment_id')
  if (!dep) return c.json({ error: 'deployment_id required' }, 400)
  const { results } = await c.env.DB.prepare(
    `SELECT pin_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status='progress' THEN 1 ELSE 0 END) AS progress,
            SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done
     FROM pin_notes WHERE deleted = 0 AND deployment_id = ?
     GROUP BY pin_id`
  ).bind(dep).all()
  const map: any = {}
  for (const r of (results || [])) {
    map[(r as any).pin_id] = {
      total: (r as any).total, open: (r as any).open,
      progress: (r as any).progress, done: (r as any).done,
    }
  }
  return c.json({ data: map })
})

// 노트 생성 — 누구나(익명 가능)
app.post('/api/notes', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const deployment_id = String(body.deployment_id || '').trim()
  const pin_id = String(body.pin_id || '').trim()
  const text = String(body.body || '').trim()
  if (!deployment_id || !pin_id) return c.json({ error: 'deployment_id, pin_id required' }, 400)
  if (!text) return c.json({ error: 'body required' }, 400)
  if (text.length > 4000) return c.json({ error: 'body too long' }, 400)
  let status = String(body.status || 'open')
  if (!VALID_STATUS.includes(status)) status = 'open'

  // 로그인 사용자면 작성자 정보 기록
  const user = await getUser(c)
  const author = user ? (user.name || user.email) : (String(body.author || '').trim() || '익명')
  const author_email = user ? user.email : null
  const author_role = user ? (await isDesigner(c, user.email) ? (user.email === superAdmin(c) ? 'super' : 'designer') : 'viewer') : 'guest'

  const id = genId('note')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO pin_notes
      (id, deployment_id, pin_id, pin_label, body, status, assignee, author, author_email, author_role, created_at, updated_at, resolved_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    id, deployment_id, pin_id, String(body.pin_label || ''), text, status,
    String(body.assignee || '') || null, author, author_email, author_role,
    now, now, status === 'done' ? now : null
  ).run()
  return c.json(mapNote({
    id, deployment_id, pin_id, pin_label: body.pin_label || '', body: text, status,
    assignee: body.assignee || null, author, author_email, author_role,
    created_at: now, updated_at: now, resolved_at: status === 'done' ? now : null,
  }))
})

/** 노트 수정 권한: 작성자(이메일 일치) 또는 디자이너 */
async function canEditNote(c: any, note: any): Promise<boolean> {
  const user = await getUser(c)
  if (!user) return false  // 익명 노트는 디자이너만 수정 가능
  if (await isDesigner(c, user.email)) return true
  return note.author_email && note.author_email === user.email
}

// 노트 수정(내용/상태/담당자)
app.patch('/api/notes/:id', async (c) => {
  const id = c.req.param('id')
  const note = await c.env.DB.prepare('SELECT * FROM pin_notes WHERE id = ? AND deleted = 0').bind(id).first()
  if (!note) return c.json({ error: 'not found' }, 404)
  if (!(await canEditNote(c, note))) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }

  const fields: string[] = []
  const args: any[] = []
  const now = Date.now()
  if (typeof body.body === 'string') {
    const t = body.body.trim()
    if (!t) return c.json({ error: 'body required' }, 400)
    if (t.length > 4000) return c.json({ error: 'body too long' }, 400)
    fields.push('body = ?'); args.push(t)
  }
  if (typeof body.status === 'string' && VALID_STATUS.includes(body.status)) {
    fields.push('status = ?'); args.push(body.status)
    fields.push('resolved_at = ?'); args.push(body.status === 'done' ? now : null)
  }
  if (typeof body.assignee === 'string') {
    fields.push('assignee = ?'); args.push(body.assignee.trim() || null)
  }
  if (fields.length === 0) return c.json({ error: 'nothing to update' }, 400)
  fields.push('updated_at = ?'); args.push(now)
  args.push(id)
  await c.env.DB.prepare(`UPDATE pin_notes SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run()
  const updated = await c.env.DB.prepare('SELECT * FROM pin_notes WHERE id = ?').bind(id).first()
  return c.json(mapNote(updated))
})

// 노트 삭제(soft)
app.delete('/api/notes/:id', async (c) => {
  const id = c.req.param('id')
  const note = await c.env.DB.prepare('SELECT * FROM pin_notes WHERE id = ? AND deleted = 0').bind(id).first()
  if (!note) return c.json({ error: 'not found' }, 404)
  if (!(await canEditNote(c, note))) return c.json({ error: 'forbidden' }, 403)
  await c.env.DB.prepare('UPDATE pin_notes SET deleted = 1, updated_at = ? WHERE id = ?')
    .bind(Date.now(), id).run()
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   정적 파일 서빙 — Cloudflare Pages 자산에 위임
   (css/js/images/static/index.html 은 _routes.json exclude로 자동 서빙되며,
    여기 도달하는 경로는 루트('/') 또는 알 수 없는 경로 → index.html 반환)
════════════════════════════════════════════ */
app.all('*', async (c) => {
  const assets = c.env.ASSETS
  if (assets && assets.fetch) {
    // 원 요청 경로의 자산을 시도, 없으면 index.html로 폴백(SPA 진입)
    const url = new URL(c.req.url)
    const direct = await assets.fetch(new Request(c.req.url, { method: 'GET' }))
    if (direct.status !== 404) return direct
    return assets.fetch(new Request(url.origin + '/index.html', { method: 'GET' }))
  }
  return c.text('Not Found', 404)
})

export default app
