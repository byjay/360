import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { normEmail, emailDomain, isValidEmail, gen6, randToken, bufToHex, hashPassword, verifyPassword } from './lib/util'

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
  // [P0-3] 데모 로그인 스위치. 운영 봉인 시 `wrangler pages secret put DEMO_LOGIN` (값 0).
  DEMO_LOGIN?: string
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

const app = new Hono<{ Bindings: Bindings }>()

// [보안] CORS 와이드오픈(*) 차단 — 앱 도메인(localhost/*.pages.dev/*.seastar.work)만 반사.
//   동일출처 호출은 CORS 비대상이라 영향 없음. 타 사이트의 토큰 도용 반경 축소.
const corsCfg = cors({
  origin: (o) => (o && /^https?:\/\/(localhost(:\d+)?|([a-z0-9-]+\.)*pages\.dev|([a-z0-9-]+\.)*seastar\.work)$/i.test(o)) ? o : '',
})
app.use('/tables/*', corsCfg)
app.use('/api/*', corsCfg)

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

// [마스터 2026-08-31 지시] 구글 로그인 재개 전까지 테넌트 구분 없이 전체 프로젝트/도면 노출.
//   AUTO_DESIGNER_ENTRY(로그인 없는 데모 디자이너 자동입장)와 짝을 이루는 임시 스위치.
//   구글 로그인을 재개하면 이 값을 false 로 되돌려 테넌트 격리를 즉시 복원한다.
//   권한 체크(requireDesigner/requireAdmin/isSuperAdmin)는 절대 건드리지 않음 — "보이는 범위"만 확장.
const TEMP_OPEN_ALL_TENANTS = true

/* ══ [마스터 2026-08-31] 로그인 없는 디자이너 자동입장 전용 토큰 ═════════════
 * 배경: 데모 토큰 패밀리(demo-super/demo-designer/demo-viewer)는 2026-06-23 P0 보안조치로
 *   CF 시크릿 DEMO_LOGIN='0' 봉인됨(demo-super 로 슈퍼관리자 탈취 가능했던 구멍). 그 봉인은 유지한다.
 * 따라서 자동입장은 데모 경로를 재개방하지 않고, **디자이너 권한만 가능한 별도 토큰**으로 처리한다.
 * 불변식(코드로 강제):
 *   ① 이 토큰의 이메일은 isSuperAdmin/isAdmin 에서 **항상 false** (아래 하드 denylist) → super/admin 승격 불가.
 *   ② roleOf 는 super/admin 을 통과하지 못하므로 결과가 언제나 'designer'.
 *   ③ demoLoginEnabled(c) 와 완전히 독립 — 이 스위치 하나로만 열고 닫는다.
 * 되돌리기: 아래 ENABLED=false + 클라 public/js/modules/22_Auth.js 의 AUTO_DESIGNER_ENTRY=false. */
const AUTO_DESIGNER_TOKEN_ENABLED = true   // 2026-08-31 마스터 지시: 로그인 없이 디자이너 진입. 구글로그인 재개 시 false.
const AUTO_DESIGNER_TOKEN = 'auto-designer-entry-360'
const AUTO_DESIGNER_EMAIL = 'auto.designer@seastargo.com'   // 예약 계정(실사용자 아님)
const AUTO_DESIGNER_USER = { email: AUTO_DESIGNER_EMAIL, name: '설계자', picture: '', role: 'designer' as const }
/** 자동입장 전용 토큰이면 디자이너 고정 사용자 반환, 아니면 null. 스위치 off 면 무조건 null. */
function autoDesignerFromToken(token: string): any | null {
  if (!AUTO_DESIGNER_TOKEN_ENABLED) return null
  if (token !== AUTO_DESIGNER_TOKEN) return null
  return { ...AUTO_DESIGNER_USER, _auto: true }
}

function superAdmin(c: any): string {
  const v = c?.env?.SUPER_ADMIN_EMAIL
  return (typeof v === 'string' && v.includes('@')) ? v.trim().toLowerCase() : SUPER_ADMIN_FALLBACK
}
/** [SEcMS 차용] 슈퍼관리자 이메일 allowlist — 다중 슈퍼관리자 지원.
 *  env SUPER_ADMIN_EMAILS(쉼표구분) + SUPER_ADMIN_EMAIL(단일) 합산, 기본 designssir@gmail.com.
 *  SEcMS functions/lib/superAdmin.ts 의 isSuperAdminEmail 패턴과 동일. */
function superAdminList(c: any): string[] {
  const out = new Set<string>([SUPER_ADMIN_FALLBACK])
  const single = c?.env?.SUPER_ADMIN_EMAIL
  if (typeof single === 'string' && single.includes('@')) out.add(single.trim().toLowerCase())
  const multi = c?.env?.SUPER_ADMIN_EMAILS
  if (typeof multi === 'string') multi.split(',').map((s: string) => s.trim().toLowerCase()).filter((e: string) => e.includes('@')).forEach((e: string) => out.add(e))
  return Array.from(out)
}
function isSuperAdmin(c: any, email: string): boolean {
  const e = String(email || '').trim().toLowerCase()
  if (e === AUTO_DESIGNER_EMAIL) return false   // [불변식①] 자동입장 예약계정은 슈퍼관리자가 될 수 없다
  return !!e && superAdminList(c).includes(e)
}
/** [역할모델] 일반관리자 allowlist — env ADMIN_EMAILS(쉼표구분). 마스터가 지정.
 *  슈퍼관리자(마스터)는 항상 관리자에 포함. 기본 비어있으면 관리자=슈퍼(마스터)뿐.
 *  ⚠️ 정책: 슈퍼관리자=마스터 전용 / 일반관리자=별도 티어 / 디자이너=관리자 아님(설계만) / 뷰어. */
function adminList(c: any): string[] {
  const v = c?.env?.ADMIN_EMAILS
  if (typeof v === 'string') return v.split(',').map((s: string) => s.trim().toLowerCase()).filter((e: string) => e.includes('@'))
  return []
}
function isAdmin(c: any, email: string): boolean {
  const e = String(email || '').trim().toLowerCase()
  if (e === AUTO_DESIGNER_EMAIL) return false   // [불변식①] 자동입장 예약계정은 관리자가 될 수 없다(ADMIN_EMAILS 에 넣어도 무효)
  return !!e && (isSuperAdmin(c, e) || adminList(c).includes(e))
}

/** 회사 자동 설계자(디자이너) 도메인 — 이 도메인 계정은 로그인 경로(구글/자체가입)와 무관하게
 *  항상 설계자 권한을 부여한다. 환경변수 DESIGNER_DOMAINS(쉼표구분) 로 확장 가능.
 *  단일 정책 소스: 자체가입·구글로그인 양쪽이 모두 이 함수를 사용해 권한 불일치를 방지한다. */
const DESIGNER_DOMAIN_FALLBACK = ['seastargo.com']
function designerDomains(c?: any): string[] {
  const v = c?.env?.DESIGNER_DOMAINS
  if (typeof v === 'string' && v.trim()) {
    return v.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)
  }
  return DESIGNER_DOMAIN_FALLBACK
}
function isDesignerDomain(c: any, email: string): boolean {
  const d = emailDomain(String(email || '').toLowerCase())
  return !!d && designerDomains(c).includes(d)
}

/* ── 데모 진입(구글 로그인 없이 바로 테스트) ──
 * 구글 OAuth 클라이언트 ID가 아직 없거나, 빠른 시연이 필요할 때 사용.
 * 클라이언트가 보내는 'Bearer demo-designer' / 'Bearer demo-viewer' 토큰을 인식한다.
 * - demo-designer : 디자이너 권한(프로젝트 생성/삭제까지 테스트 가능)
 * - demo-viewer   : 뷰어 권한(열람만)
 * [P0-3 🟠 보안] 운영에서는 Cloudflare 시크릿 DEMO_LOGIN='0' 으로 끈다.
 *   기본값(미설정)은 true 라 개발/시연 환경에선 종전대로 동작하고,
 *   운영 배포 시 `wrangler pages secret put DEMO_LOGIN`(값 0) 한 번이면 봉인된다. */
function demoLoginEnabled(c: any): boolean {
  try { return String(c?.env?.DEMO_LOGIN ?? '1') !== '0' } catch { return true }
}
const DEMO_DESIGNER = { email: 'demo.designer@seastargo.com', name: '설계자', picture: '', role: 'designer' as const }
// 주의: 데모 열람자 이메일은 디자이너 도메인(seastargo.com)이면 안 된다 — isDesignerDomain 으로 designer 승격되어 '뷰어' 의미가 깨짐.
const DEMO_VIEWER = { email: 'demo.viewer@example.com', name: '데모 열람자', picture: '', role: 'viewer' as const }

const DEMO_SUPER = { email: SUPER_ADMIN, name: '데모 슈퍼관리자', picture: '', role: 'super' as const }

/** 데모 토큰이면 가짜 사용자 반환, 아니면 null */
function demoUserFromToken(c: any, token: string): any | null {
  if (!demoLoginEnabled(c)) return null
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

/* ════════════════════════════════════════════════════════════
   Firebase ID 토큰 검증 (마스터가 Firebase ID만 연결하면 바로 로그인)
   · Firebase 토큰 iss = https://securetoken.google.com/<projectId>
   · 서명 키는 X.509 PEM 인증서 (JWK가 아님) →
     https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
   · kid → PEM 매핑을 받아 SubtleCrypto(spki)로 import 후 RS256 검증
   ──────────────────────────────────────────────────────────── */
let _fbCerts: { map: Record<string, string>; exp: number } | null = null
async function getFirebaseCerts(): Promise<Record<string, string>> {
  const now = Date.now()
  if (_fbCerts && _fbCerts.exp > now) return _fbCerts.map
  const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com')
  const json: any = await res.json()  // { kid: "-----BEGIN CERTIFICATE-----..." }
  const cc = res.headers.get('cache-control') || ''
  const m = cc.match(/max-age=(\d+)/)
  const ttl = m ? Number(m[1]) * 1000 : 3600_000
  _fbCerts = { map: json || {}, exp: now + ttl }
  return _fbCerts.map
}

/** PEM(X.509 인증서)에서 공개키를 추출해 RS256 verify 키로 import */
async function importX509Spki(pem: string): Promise<CryptoKey> {
  // 인증서 PEM → DER. 인증서 전체를 importKey('spki')에 넣으면 일부 런타임에서 실패할 수 있어
  // WebCrypto가 인증서에서 공개키를 뽑도록 'spki' 시도, 실패 시 인증서 본문 그대로 시도.
  const body = pem.replace(/-----BEGIN CERTIFICATE-----/g, '')
                  .replace(/-----END CERTIFICATE-----/g, '')
                  .replace(/\s+/g, '')
  const der = b64urlToUint8(body.replace(/\+/g, '-').replace(/\//g, '_'))
  // X.509 인증서에서 SubjectPublicKeyInfo 추출
  const spki = extractSpkiFromCert(der)
  return crypto.subtle.importKey(
    'spki', spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  )
}

/** DER 인코딩된 X.509 인증서에서 SubjectPublicKeyInfo(SPKI) 블록을 추출.
 *  ASN.1을 가볍게 순회: Certificate → TBSCertificate → ... → SPKI(SEQUENCE).
 *  SPKI는 rsaEncryption OID(1.2.840.113549.1.1.1)를 포함하는 SEQUENCE다. */
function extractSpkiFromCert(der: Uint8Array): Uint8Array {
  // rsaEncryption OID 바이트열
  const oid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]
  let idx = -1
  for (let i = 0; i < der.length - oid.length; i++) {
    let ok = true
    for (let j = 0; j < oid.length; j++) { if (der[i + j] !== oid[j]) { ok = false; break } }
    if (ok) { idx = i; break }
  }
  if (idx < 0) throw new Error('SPKI OID not found')
  // OID 앞쪽으로 거슬러: AlgorithmIdentifier SEQUENCE 시작 → 그 앞 SPKI SEQUENCE 시작
  // AlgorithmIdentifier: 30 LL 06 09 ...  → SEQUENCE 태그(0x30)는 oid 바로 앞 2바이트(태그+길이) 위치
  const algSeqStart = idx - 2
  // SPKI SEQUENCE는 AlgorithmIdentifier를 감싸는 바깥 SEQUENCE. 그 앞에서 0x30 태그를 찾는다.
  // 길이 인코딩(short/long)을 고려해 algSeqStart 앞 1~4바이트 내에서 0x30을 탐색.
  let spkiStart = -1
  for (let k = algSeqStart - 1; k >= Math.max(0, algSeqStart - 6); k--) {
    if (der[k] === 0x30) { spkiStart = k; break }
  }
  if (spkiStart < 0) throw new Error('SPKI SEQUENCE start not found')
  // 길이 파싱
  const { len, hdr } = readDerLen(der, spkiStart + 1)
  const total = 1 + hdr + len
  return der.slice(spkiStart, spkiStart + total)
}

function readDerLen(buf: Uint8Array, p: number): { len: number; hdr: number } {
  const first = buf[p]
  if (first < 0x80) return { len: first, hdr: 1 }
  const n = first & 0x7f
  let len = 0
  for (let i = 0; i < n; i++) len = (len << 8) | buf[p + 1 + i]
  return { len, hdr: 1 + n }
}

/** Firebase ID 토큰 검증. 성공 시 payload 반환, 실패 시 null. */
async function verifyFirebaseToken(token: string, expectedProjectId?: string): Promise<any | null> {
  try {
    const [h, p, s] = token.split('.')
    if (!h || !p || !s) return null
    const header = decodeJwtPart(h)
    const payload = decodeJwtPart(p)
    const iss = String(payload.iss || '')
    // Firebase 발급자만 통과 (securetoken.google.com/<projectId>)
    if (!iss.startsWith('https://securetoken.google.com/')) return null
    // projectId 설정 시(env.FIREBASE_PROJECT_ID): 우리 프로젝트(sedmsys) 토큰만 신뢰
    //   iss = securetoken.google.com/<projectId> AND aud = <projectId>
    if (expectedProjectId) {
      if (iss !== 'https://securetoken.google.com/' + expectedProjectId) return null
      if (payload.aud && payload.aud !== expectedProjectId) return null
    }
    if (payload.exp && Date.now() / 1000 > payload.exp) return null
    if (!payload.email) return null
    const certs = await getFirebaseCerts()
    const pem = certs[header.kid]
    if (!pem) return null
    const key = await importX509Spki(pem)
    const data = new TextEncoder().encode(h + '.' + p)
    const sig = b64urlToUint8(s.replace(/-/g, '+').replace(/_/g, '/'))
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data)
    if (!valid) return null
    return payload
  } catch {
    return null
  }
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
 * @param expectedAud  설정되면(예: env.GOOGLE_CLIENT_ID) payload.aud 와 일치 강제(토큰 오용 방지).
 *                     비어 있으면 aud 검증 생략(하위호환).
 */
async function verifyGoogleToken(token: string, expectedAud?: string): Promise<any | null> {
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
    // audience 검증(설정 시): 우리 클라이언트 ID 로 발급된 토큰만 신뢰
    if (expectedAud && payload.aud && payload.aud !== expectedAud) return null

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

// [리팩토링 1단계] 순수 유틸(normEmail·emailDomain·isValidEmail·gen6·randToken·bufToHex·hashPassword·verifyPassword)
//   → src/lib/util.ts 로 추출. 상단 import 참조.

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

/** 사전 등록(초대) 이메일 조회. 등록돼 있으면 invite 레코드, 없으면 null. */
async function findInvite(c: any, email: string): Promise<any | null> {
  try {
    const inv: any = await c.env.DB.prepare(
      'SELECT email, company, role, project_id, used FROM invited_users WHERE email = ? AND deleted = 0'
    ).bind(email).first()
    return inv || null
  } catch { return null }
}

/** 회사 도메인 가입 가능 여부 검사. 통과 시 {ok:true}, 실패 시 사유.
 *  projectId 가 주어지면 해당 프로젝트(또는 전역) 화이트리스트만 적용.
 *  사전 등록(초대)된 이메일은 도메인 검사를 우회하고 즉시 허용. */
async function checkSignupDomain(c: any, email: string, projectId?: string): Promise<{ ok: boolean; reason?: string; invited?: boolean }> {
  if (!isValidEmail(email)) return { ok: false, reason: '올바른 이메일 형식이 아닙니다.' }
  const domain = emailDomain(email)
  if (!domain) return { ok: false, reason: '도메인을 확인할 수 없습니다.' }
  // 0순위: 관리자가 사전 등록(초대)한 이메일이면 도메인 무관 즉시 허용
  const inv = await findInvite(c, email)
  if (inv) return { ok: true, invited: true }
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
  const text = `SEASTAR 360° 위치 뷰어 가입 인증코드: ${code}\n\n이 코드는 발급 후 1시간 동안만 유효합니다. 본인이 요청하지 않았다면 무시하세요.`
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
    <h2 style="color:#0b3a5b">SEASTAR 360° 위치 뷰어</h2>
    <p>아래 인증코드를 입력해 회원가입을 완료하세요.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f1f5f9;padding:16px 24px;border-radius:12px;text-align:center;color:#0b3a5b">${code}</div>
    <p style="color:#64748b;font-size:13px">이 코드는 발급 후 <strong>1시간</strong> 동안만 유효합니다. 본인이 요청하지 않았다면 무시하세요.</p>
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
      'SELECT * FROM local_users WHERE email = ? AND deleted = 0'
    ).bind(sess.email).first()
    if (!u) return null
    // SELECT * 라 must_change_password 컬럼 미적용(migration 전)이면 undefined→false 로 안전
    return { email: String(u.email).toLowerCase(), name: u.name || '', picture: '', _local: true, must_change: Number(u.must_change_password || 0) === 1 }
  } catch { return null }
}

/** Authorization: Bearer <idToken> 에서 검증된 사용자 반환 (없으면 null) */
async function getUser(c: any): Promise<any | null> {
  const auth = c.req.header('Authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  // ponytail: <img>/텍스처는 Authorization 헤더를 못 보내므로 ?t= 쿼리토큰 폴백 허용(R2 객체용).
  //   같은 자격증명이라 권한 동일. 한계: 토큰이 URL/로그에 남음 → 로컬세션 토큰 만료·취소로 상쇄.
  const token = m ? m[1] : (c.req.query('t') || '')
  if (!token) return null
  // 데모 토큰 우선 처리 (구글 로그인 없이 바로 진입/테스트)
  const demo = demoUserFromToken(c, token)
  if (demo) return demo
  // 로그인 없는 디자이너 자동입장 전용 토큰 (데모 봉인 DEMO_LOGIN=0 과 무관한 별도 경로, designer 고정)
  const autoD = autoDesignerFromToken(token)
  if (autoD) return autoD
  // 회사 이메일 자체가입 로컬 세션 토큰 ("local-...")
  if (token.startsWith('local-')) {
    const lu = await resolveLocalSession(c, token)
    if (lu) return lu
    return null
  }
  // 1) 표준 Google ID 토큰(GIS) 검증 — env.GOOGLE_CLIENT_ID 설정 시 audience 강제
  let payload = await verifyGoogleToken(token, (c.env && c.env.GOOGLE_CLIENT_ID) || undefined)
  // 2) 실패 시 Firebase ID 토큰 검증 — env.FIREBASE_PROJECT_ID(sedmsys) 설정 시 해당 프로젝트만 신뢰
  if (!payload) payload = await verifyFirebaseToken(token, (c.env && c.env.FIREBASE_PROJECT_ID) || undefined)
  if (!payload) return null
  return { email: String(payload.email).toLowerCase(), name: payload.name || payload.display_name || '', picture: payload.picture || '' }
}

async function isDesigner(c: any, email: string): Promise<boolean> {
  // 자동입장 예약계정: 스위치가 켜져 있을 때만 디자이너. designers 테이블 self-heal INSERT 도 타지 않게 최상단 처리.
  if (String(email || '').trim().toLowerCase() === AUTO_DESIGNER_EMAIL) return AUTO_DESIGNER_TOKEN_ENABLED
  if (isAdmin(c, email)) return true   // 관리자(슈퍼/일반)는 설계 권한도 보유(관리자 ≥ 디자이너)
  if (demoLoginEnabled(c) && email === DEMO_DESIGNER.email) return true
  // 회사 도메인(@seastargo.com 등) 계정은 로그인 경로와 무관하게 설계자 권한 (자체가입과 정책 일치)
  if (isDesignerDomain(c, email)) {
    // self-heal: designers 테이블에도 자동 등록해 두어 관리 화면/통계에서 일관되게 보이도록 함
    try {
      const now = Date.now()
      await c.env.DB.prepare(
        `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(email) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at`
      ).bind(email, email.split('@')[0], 'auto:designer-domain', now, now).run()
    } catch (e) {}
    return true
  }
  const row = await c.env.DB.prepare(
    'SELECT email FROM designers WHERE email = ? AND deleted = 0'
  ).bind(email).first()
  return !!row
}

function roleOf(c: any, email: string, designer: boolean): 'super' | 'admin' | 'designer' | 'viewer' {
  if (isSuperAdmin(c, email)) return 'super'   // 슈퍼관리자 = 마스터 전용
  if (isAdmin(c, email)) return 'admin'        // 일반관리자 = 마스터가 지정한 별도 티어
  if (designer) return 'designer'              // 디자이너 = 관리자 아님, 설계만
  return 'viewer'
}

/* ── 현재 로그인 사용자 + 권한 ── */
app.get('/api/auth/me', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ authenticated: false, role: 'viewer' })
  const designer = await isDesigner(c, user.email)
  const role = roleOf(c, user.email, designer)
  // 로그인 시 디자이너의 표시 이름 갱신(존재 시, 데모 계정 제외)
  if (role === 'designer' && !user._demo && !user._auto) {
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
  // 실제 로그인(데모/자동입장 제외)만 로그 기록 — 자동입장은 방문마다 발생해 로그를 오염시킨다
  if (!user._demo && !user._auto) await logActivity(c, 'auth.login', { actor: user, targetType: 'auth', detail: { role, local: !!user._local } })
  return c.json({ authenticated: true, email: user.email, name: user.name, picture: user.picture, role, demo: !!user._demo, local: !!user._local, auto: !!user._auto, request_status, super_admin: superAdmin(c) })
})

/* ── 클라이언트 인증 설정(공개 가능 값만) ──
 * Google OAuth Client ID 는 "공개 식별자"라 프론트 노출 OK(시크릿 아님).
 * 운영 주입: `npx wrangler pages secret put GOOGLE_CLIENT_ID` (빌드 파일 수정 불필요)
 * 미설정 시 빈 문자열 → 클라는 index.html 의 인라인 WM_GOOGLE_CLIENT_ID 로 폴백.
 */
app.get('/api/auth/config', (c) => {
  return c.json({
    google_client_id: (c.env && c.env.GOOGLE_CLIENT_ID) || '',
    demo_login: demoLoginEnabled(c),
    primary_domain: (c.env && c.env.PRIMARY_DOMAIN) || 'scan.seastar.work',
    firebase_project_id: (c.env && c.env.FIREBASE_PROJECT_ID) || '',
  })
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
  const expires = now + 60 * 60 * 1000 // 1시간 (요구사항: 1시간 이내 입력해야 유효)
  // 기존 미사용 코드는 무효화
  await c.env.DB.prepare('UPDATE email_codes SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0').bind(email, 'signup').run().catch(() => {})
  await c.env.DB.prepare(
    'INSERT INTO email_codes (id, email, code, purpose, created_at, expires_at, attempts, consumed) VALUES (?, ?, ?, ?, ?, ?, 0, 0)'
  ).bind(randToken('ec-'), email, code, 'signup', now, expires).run()

  const mail = await sendVerificationEmail(c, email, code)
  await logActivity(c, 'signup.code_sent', { actor: { email }, targetType: 'signup', targetId: email, detail: { provider: mail.provider || 'dev-fallback', invited: !!chk.invited } })
  const resp: any = { success: true, sent: mail.sent, email, invited: !!chk.invited, expires_at: expires, valid_minutes: 60 }
  if (chk.invited) {
    const inv = await findInvite(c, email)
    if (inv) { resp.invite_company = inv.company || ''; resp.invite_role = inv.role || 'viewer' }
  }
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
  const company = String(body.company || '').trim()
  const department = String(body.department || '').trim()
  const projectId = body.project_id || undefined

  const chk = await checkSignupDomain(c, email, projectId)
  if (!chk.ok) return c.json({ error: chk.reason }, 400)
  // 사전 등록(초대) 사용자는 회사명을 반드시 입력하도록 요구
  const invite = chk.invited ? await findInvite(c, email) : null
  if (chk.invited && !company) return c.json({ error: '회사명을 입력해 주세요.' }, 400)
  if (!name) return c.json({ error: '이름을 입력해 주세요.' }, 400)
  if (!department) return c.json({ error: '부서/소속을 입력해 주세요.' }, 400)
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
    `INSERT INTO local_users (email, name, domain, company, department, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, company = excluded.company, department = excluded.department, pw_hash = excluded.pw_hash, pw_salt = excluded.pw_salt, email_verified = 1, updated_at = excluded.updated_at, deleted = 0`
  ).bind(email, name || email.split('@')[0], emailDomain(email), company || (invite && invite.company) || '', department || '', hash, salt, now, now).run()

  // [보안 H1] 자체가입자를 기본 테넌트 멤버로 등록 — tenant_members 미삽입 시 테넌트 격리 스코프 누락
  try {
    await c.env.DB.prepare(
      `INSERT INTO tenant_members (tenant_id, email, role, created_at) VALUES ('tnt_default', ?, 'viewer', ?)
       ON CONFLICT(tenant_id, email) DO NOTHING`
    ).bind(email, now).run()
  } catch (e) {}

  // 회사 도메인(@seastargo.com 등) 계정은 설계자(디자이너) 권한 자동 부여 — 단일 정책(designerDomains)
  if (isDesignerDomain(c, email)) {
    await c.env.DB.prepare(
      `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET deleted = 0, name = excluded.name, updated_at = excluded.updated_at`
    ).bind(email, name || email.split('@')[0], 'auto:designer-domain', now, now).run().catch(() => {})
  }
  // 초대 레코드가 있으면 사용 처리(used=1) 및 회사명 동기화
  if (invite) {
    await c.env.DB.prepare('UPDATE invited_users SET used = 1, company = ? WHERE email = ?')
      .bind(company || invite.company || '', email).run().catch(() => {})
    // designer 로 초대된 경우 designers 테이블에 등록하여 로그인 시 디자이너 권한 부여
    if (invite.role === 'designer') {
      await c.env.DB.prepare(
        `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(email) DO UPDATE SET deleted = 0, name = excluded.name, updated_at = excluded.updated_at`
      ).bind(email, name || (company ? company : email.split('@')[0]), invite.invited_by || 'invite', now, now).run().catch(() => {})
    }
  }

  // 자동 로그인: 세션 토큰 발급
  const token = randToken('local-')
  const exp = now + 30 * 24 * 60 * 60 * 1000 // 30일
  await c.env.DB.prepare('INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
    .bind(token, email, now, exp).run()
  await c.env.DB.prepare('UPDATE local_users SET last_login_at = ? WHERE email = ?').bind(now, email).run().catch(() => {})

  let grantedRole = (invite && invite.role) ? invite.role : 'viewer'
  if (isDesignerDomain(c, email)) grantedRole = 'designer'
  await logActivity(c, 'signup.completed', { actor: { email }, targetType: 'local_user', targetId: email, detail: { domain: emailDomain(email), invited: !!invite, company, department, role: grantedRole } })
  return c.json({ success: true, token, email, name: name || email.split('@')[0], company, department, role: grantedRole, invited: !!invite })
})

// 3) 로그인(이메일 + 비밀번호)
app.post('/api/signup/login', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = normEmail(body.email)
  const password = String(body.password || '')
  if (!isValidEmail(email) || !password) return c.json({ error: '이메일과 비밀번호를 입력해 주세요.' }, 400)

  const u: any = await c.env.DB.prepare(
    'SELECT * FROM local_users WHERE email = ? AND deleted = 0'
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
  // must_change: 초대 계정(비번 '1')의 첫 로그인 → 클라가 비번 변경 모달을 띄운다
  const mustChange = Number(u.must_change_password || 0) === 1
  return c.json({ success: true, token, email: u.email, name: u.name || u.email.split('@')[0], role: 'viewer', must_change: mustChange })
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
  const su = await requireAdmin(c)
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
  const su = await requireAdmin(c)
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
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const id = decodeURIComponent(c.req.param('id'))
  // id 또는 (하위호환) domain 으로 삭제 허용
  await c.env.DB.prepare('UPDATE allowed_domains SET deleted = 1 WHERE id = ?').bind(id).run()  // [보안 M4] id 단건만 — 'OR domain' 제거(도메인명으로 전 프로젝트 일괄삭제 방지)
  await logActivity(c, 'domain.remove', { actor: su, targetType: 'domain', targetId: id })
  return c.json({ success: true })
})

/* ── 가입 사용자 목록(슈퍼관리자 전용) — 로그인 기록과 함께 관리 ── */
app.get('/api/local-users', async (c) => {
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT email, name, domain, company, created_at, last_login_at FROM local_users WHERE deleted = 0 ORDER BY created_at DESC'
  ).all()
  return c.json({ data: results || [] })
})

/* ── 사전 등록(초대) 이메일 관리(슈퍼관리자 전용) ──
   · GET    /api/invites                목록
   · POST   /api/invites  { email, company?, role?, note?, project_id? }
   · DELETE /api/invites/:email */
app.get('/api/invites', async (c) => {
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT email, company, role, note, invited_by, project_id, created_at, used FROM invited_users WHERE deleted = 0 ORDER BY created_at DESC'
  ).all()
  return c.json({ data: results || [] })
})
app.post('/api/invites', async (c) => {
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = normEmail(body.email)
  if (!isValidEmail(email)) return c.json({ error: '올바른 이메일을 입력해 주세요.' }, 400)
  const role = (body.role === 'designer') ? 'designer' : 'viewer'
  const company = String(body.company || '').trim()
  const note = String(body.note || '').trim()
  const projectId = String(body.project_id || '*').trim() || '*'
  // 이미 가입된 사용자인지 안내(차단은 아님)
  const exist: any = await c.env.DB.prepare('SELECT email FROM local_users WHERE email = ? AND deleted = 0').bind(email).first().catch(() => null)
  await c.env.DB.prepare(
    `INSERT INTO invited_users (email, company, role, note, invited_by, project_id, created_at, used, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
     ON CONFLICT(email) DO UPDATE SET company = excluded.company, role = excluded.role, note = excluded.note, project_id = excluded.project_id, deleted = 0`
  ).bind(email, company, role, note, su.email, projectId, Date.now()).run()
  await logActivity(c, 'invite.add', { actor: su, targetType: 'invite', targetId: email, detail: { role, company, project_id: projectId } })
  return c.json({ success: true, email, role, company, already_registered: !!exist })
})
app.delete('/api/invites/:email', async (c) => {
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const email = decodeURIComponent(c.req.param('email')).toLowerCase()
  await c.env.DB.prepare('UPDATE invited_users SET deleted = 1 WHERE email = ?').bind(email).run()
  await logActivity(c, 'invite.remove', { actor: su, targetType: 'invite', targetId: email })
  return c.json({ success: true })
})

/* ── 앱 설정(기능/메뉴/레이아웃/AI) — 최상위 관리자가 프로젝트별로 관장 ──
   · GET  /api/app-settings?scope=<*|projectId>&key=<features|layout|ai>  (읽기는 로그인 사용자 허용 — 프론트가 메뉴 토글에 사용)
   · PUT  /api/app-settings  { scope?, key, value }  (슈퍼관리자만 쓰기) */
app.get('/api/app-settings', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)
  const scope = String(c.req.query('scope') || '*')
  const key = String(c.req.query('key') || '')
  try {
    if (key) {
      const row: any = await c.env.DB.prepare('SELECT value, updated_at, updated_by FROM app_settings WHERE scope = ? AND skey = ?').bind(scope, key).first()
      let value = {}
      try { value = row ? JSON.parse(row.value) : {} } catch { value = {} }
      return c.json({ scope, key, value, updated_at: row?.updated_at || 0 })
    }
    const { results } = await c.env.DB.prepare('SELECT scope, skey, value, updated_at FROM app_settings WHERE scope = ?').bind(scope).all()
    const out: any = {}
    ;(results || []).forEach((r: any) => { try { out[r.skey] = JSON.parse(r.value) } catch { out[r.skey] = {} } })
    return c.json({ scope, settings: out })
  } catch (e: any) { return c.json({ scope, settings: {}, value: {} }) }
})
app.put('/api/app-settings', async (c) => {
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const scope = String(body.scope || '*').trim() || '*'
  const key = String(body.key || '').trim()
  if (!key) return c.json({ error: 'key가 필요합니다.' }, 400)
  let valueStr = '{}'
  try { valueStr = JSON.stringify(body.value ?? {}) } catch { valueStr = '{}' }
  await c.env.DB.prepare(
    `INSERT INTO app_settings (scope, skey, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, skey) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(scope, key, valueStr, su.email, Date.now()).run()
  await logActivity(c, 'settings.update', { actor: su, targetType: 'settings', targetId: scope + ':' + key })
  return c.json({ success: true, scope, key })
})

/* 프론트엔드 사용자 액션 로깅 — 로그인 이후 모든 주요 행위 추적용.
   허용된 액션 화이트리스트만 기록(스팸/위조 방지). 로그인 필요. */
const CLIENT_LOG_ACTIONS = new Set([
  'app.open', 'viewer.open', 'pin.add', 'pin.edit', 'pin.delete', 'pin.view',
  'pdf.register', 'pdf.page', 'drawing.upload', 'deploy.click', 'export.json',
  'zone.add', 'zone.delete', 'pano.open', 'fls.attach', 'settings.open', 'logout'
])
app.post('/api/client-log', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  let body: any = {}
  try { body = await c.req.json() } catch {}
  const action = String(body.action || '').trim()
  if (!CLIENT_LOG_ACTIONS.has(action)) return c.json({ error: 'unknown action' }, 400)
  await logActivity(c, 'client.' + action, {
    actor: user,
    targetType: String(body.targetType || 'client').slice(0, 40),
    targetId: body.targetId ? String(body.targetId).slice(0, 120) : undefined,
    detail: body.detail ?? null
  })
  return c.json({ success: true })
})

app.delete('/api/local-users/:email', async (c) => {
  const su = await requireAdmin(c)
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
      role = isSuperAdmin(c, actor.email)
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
  if (!user || !isSuperAdmin(c, user.email)) return null
  return user
}
/** [역할모델] 관리자(슈퍼 또는 일반관리자) 게이트 — 관리자 모드/패널 접근용.
 *  기본(ADMIN_EMAILS 미설정) = 슈퍼관리자(마스터)뿐 → "관리자는 오직 마스터". 디자이너는 통과 못 함. */
async function requireAdmin(c: any): Promise<any | null> {
  const user = await getUser(c)
  if (!user || !isAdmin(c, user.email)) return null
  return user
}

app.get('/api/designers', async (c) => {
  const user = await getUser(c)
  if (!user || !isSuperAdmin(c, user.email)) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT email, name, added_by, created_at FROM designers WHERE deleted = 0 ORDER BY created_at DESC'
  ).all()
  return c.json({ data: results || [], super_admin: superAdmin(c) })
})

app.post('/api/designers', async (c) => {
  const su = await requireSuper(c)   // [보안 C1] 디자이너 지정=권한부여 → 슈퍼관리자(마스터) 전용(일반관리자 escalation 차단)
  if (!su) return c.json({ error: 'forbidden — super admin only' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = String(body.email || '').trim().toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'invalid email' }, 400)
  if (isSuperAdmin(c, email)) return c.json({ error: 'super admin is always designer' }, 400)
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET deleted = 0, added_by = excluded.added_by, updated_at = excluded.updated_at`
  ).bind(email, body.name || '', su.email, now, now).run()
  return c.json({ success: true, email })
})

app.delete('/api/designers/:email', async (c) => {
  const su = await requireSuper(c)   // [보안 C1] 디자이너 해제도 슈퍼관리자(마스터) 전용
  if (!su) return c.json({ error: 'forbidden — super admin only' }, 403)
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
  const su = await requireAdmin(c)
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
  const su = await requireAdmin(c)
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
  const su = await requireAdmin(c)
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
  const su = await requireAdmin(c)
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
  const su = await requireAdmin(c)
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
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE activity_log SET deleted = 1 WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// 로그 일괄 정리 (슈퍼관리자 전용) — before(ms) 이전 또는 전체 비우기(?all=1)
app.delete('/api/activity-logs', async (c) => {
  const su = await requireAdmin(c)
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

/* ── [PART 0 · Tenant 스코핑 헬퍼] ────────────────────────────────────
 * 멀티테넌트(회사별 격리)의 단일 진실 소스.
 * 모든 테넌트-스코프 쿼리는 tenantOf() 가 돌려준 tenant_id 로 필터해야 한다.
 *
 * 정책:
 *  - 슈퍼관리자(superAdmin)는 전 테넌트 접근 가능 → null 반환(= 필터 없음)
 *  - tenant_members 에 등록된 사용자는 자신의 tenant_id 로 한정
 *  - 미등록 사용자/구버전 데이터는 'tnt_default' 로 귀속(하위호환)
 *  - tenants/tenant_members 테이블이 아직 없으면(마이그레이션 전) 안전하게 null(필터 해제)
 * 반환:
 *  - string  → 해당 tenant_id 로 스코프
 *  - null    → 스코프 없음(슈퍼/마이그레이션 전) = 전체 접근
 */
const DEFAULT_TENANT = 'tnt_default'
async function tenantOf(c: any, user: any): Promise<string | null> {
  try {
    if (!user || !user.email) return DEFAULT_TENANT
    // 슈퍼관리자는 전 테넌트 접근
    if (isSuperAdmin(c, user.email)) return null
    const row = await c.env.DB.prepare(
      'SELECT tenant_id FROM tenant_members WHERE email = ? LIMIT 1'
    ).bind(user.email).first()
    if (row && row.tenant_id) return String(row.tenant_id)
    // 미등록 → 기본 테넌트(하위호환)
    return DEFAULT_TENANT
  } catch (e) {
    // tenant_members 테이블 부재(마이그레이션 전) 등 → 안전하게 필터 해제
    return null
  }
}

function mapProject(r: any) {
  return { id: r.id, name: r.name, description: r.description, owner: r.owner, created_at: r.created_at, updated_at: r.updated_at,
    published: !!r.published, published_at: r.published_at || null, published_by: r.published_by || null,
    subdomain: r.subdomain || null }
}
function mapDeck(r: any) {
  // [WO 20260916] 구역=도면의 한 조각(page+crop). NULL(구버전)이면 그대로 null → 페이지 전체 취급.
  let crop: any = null
  if (r.crop) { try { crop = JSON.parse(r.crop) } catch { crop = null } }
  return { id: r.id, project_id: r.project_id, name: r.name, level_no: r.level_no, deployment_id: r.deployment_id, page: r.page ?? null, crop, created_at: r.created_at, updated_at: r.updated_at }
}

// 프로젝트 목록 (누구나 조회 가능 — 뷰어도 탐색)
/* ── [PART 0 · 프로젝트별 접근제어 헬퍼] ────────────────────────────
 * 정책(하위호환 우선):
 *  - superAdmin → 전 프로젝트
 *  - 그 외 → ① 내가 멤버인 프로젝트 ② 내가 소유(생성)한 프로젝트
 *           ③ 아무에게도 배정 안 된 "공개" 프로젝트(=멤버 0명, 기존 데이터 보존)
 *  → 관리자가 어떤 프로젝트에 멤버를 1명이라도 배정하면 그 프로젝트는 즉시 '제한'되어
 *    멤버/소유자/슈퍼에게만 보인다. 기존 프로젝트는 배정 전까지 종전처럼 모두 보임. */
async function visibleProjectFilter(c: any, user: any): Promise<((p: any) => boolean) | null> {
  if (user && isSuperAdmin(c, user.email)) return null  // null = 필터 없음(전체)
  const email = user ? user.email : ''
  // 내 프로젝트별 역할 맵 (project_id → role)
  const myRole = new Map<string, string>()
  if (email) {
    const mr: any = await c.env.DB.prepare('SELECT project_id, role FROM project_members WHERE email = ?').bind(email).all()
    for (const r of (mr.results || [])) myRole.set(String(r.project_id), String(r.role))
  }
  const ar: any = await c.env.DB.prepare('SELECT DISTINCT project_id FROM project_members').all()
  const restricted = new Set<string>((ar.results || []).map((r: any) => String(r.project_id)))
  // 전역 설계자 여부(회사도메인/슈퍼/designers 테이블) — 설계자는 미배포 프로젝트도 봐야 편집/배포 가능
  const globalDesigner = email ? await isDesigner(c, email) : false
  return (p: any) => {
    const role = myRole.get(p.id)
    const isOwner = !!email && p.owner === email
    // (턴④) 기본 가시성: 멤버 OR 미배정(공개) OR 소유자
    const baseVisible = role != null || !restricted.has(p.id) || isOwner
    if (!baseVisible) return false
    // 설계자(전역 designer / 소유자 / designer·editor 역할 멤버)는 미배포 포함 전체 열람(편집·배포 위해)
    const isProjectDesigner = globalDesigner || isOwner || role === 'designer' || role === 'editor'
    if (isProjectDesigner) return true
    // 순수 뷰어 → 배포(published)된 프로젝트만
    return !!p.published
  }
}

/** 사용자가 특정 프로젝트의 멤버를 관리(배정/해제)할 수 있는가: 슈퍼 또는 소유자 또는 designer-역할 멤버 */
async function canManageProject(c: any, user: any, projectId: string): Promise<boolean> {
  if (!user) return false
  if (isSuperAdmin(c, user.email)) return true
  // [임시개방] 완성 전까지만. 구글로그인 재개 시 TEMP_OPEN_ALL_TENANTS=false 로 되돌리면 소유자/슈퍼만 관리 가능하도록 복원됨
  if (TEMP_OPEN_ALL_TENANTS) return true
  const own: any = await c.env.DB.prepare('SELECT owner FROM projects WHERE id = ? AND deleted = 0').bind(projectId).first()
  if (own && own.owner === user.email) return true
  const m: any = await c.env.DB.prepare("SELECT role FROM project_members WHERE project_id = ? AND email = ?").bind(projectId, user.email).first()
  return !!(m && m.role === 'designer')
}

app.get('/api/projects', async (c) => {
  const user = await getUser(c)
  const email = user?.email || ''
  const isSuperUser = !!(user && isSuperAdmin(c, user.email))
  const { results } = await c.env.DB.prepare('SELECT * FROM projects WHERE deleted = 0 ORDER BY created_at DESC').all()
  // 멤버십 + 신청 상태 맵 구성
  const myRole = new Map<string, string>()
  const myReqStatus = new Map<string, string>()
  let globalDesigner = false
  if (email) {
    const [mr, rr]: any[] = await Promise.all([
      c.env.DB.prepare('SELECT project_id, role FROM project_members WHERE email = ?').bind(email).all(),
      c.env.DB.prepare('SELECT project_id, status FROM project_access_requests WHERE email = ?').bind(email).all(),
    ])
    for (const r of (mr.results || [])) myRole.set(String(r.project_id), String(r.role))
    for (const r of (rr.results || [])) myReqStatus.set(String(r.project_id), String(r.status))
    globalDesigner = await isDesigner(c, email)
  }
  const list = TEMP_OPEN_ALL_TENANTS ? (results || []) : (results || []).filter((p: any) => {
    if (isSuperUser) return true
    const isOwner = !!email && p.owner === email
    if (globalDesigner || isOwner || myRole.has(p.id)) return true
    return !!p.published  // 비멤버도 배포된 프로젝트는 보임(잠금 상태로)
  })
  return c.json({ data: list.map((p: any) => {
    const isOwner = !!email && p.owner === email
    const isMember = !!(isSuperUser || globalDesigner || isOwner || myRole.has(p.id))
    return { ...mapProject(p), is_member: isMember, my_request: myReqStatus.get(p.id) || null }
  }) })
})

// 프로젝트 생성 (디자이너)
app.post('/api/projects', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const name = String(body.name || '').trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  // [수익화] 요금제 프로젝트 한도 게이팅 — 슈퍼관리자는 면제, 한도 초과면 402(업그레이드 안내)
  if (!isSuperAdmin(c, user.email)) {
    const tid = await tenantOf(c, user)
    const plan = await tenantPlanInfo(c, tid)
    const usage = await tenantUsage(c, tid)
    if (plan.maxProjects >= 0 && usage.projects >= plan.maxProjects) {
      return c.json({ error: `요금제 한도 초과 — ${plan.name} 플랜은 프로젝트 ${plan.maxProjects}개까지입니다. 업그레이드가 필요합니다.`, upgrade: true, planId: plan.planId, limit: plan.maxProjects }, 402)
    }
  }
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
  // [버그수정 H3] 소유권/관리권 체크 — 아무 디자이너나 남의 프로젝트를 삭제하던 것 차단
  if (!(await canManageProject(c, user, id))) return c.json({ error: 'forbidden — not project owner/admin' }, 403)
  const now = Date.now()
  await c.env.DB.prepare('UPDATE projects SET deleted = 1, updated_at = ? WHERE id = ?').bind(now, id).run()
  await c.env.DB.prepare('UPDATE decks SET deleted = 1, updated_at = ? WHERE project_id = ?').bind(now, id).run()
  await logActivity(c, 'project.delete', { actor: user, targetType: 'project', targetId: id })
  return c.json({ success: true })
})

/* ════════════════════════════════════════════════════════════
   [마스터: 멀티테넌트 서브도메인] <subdomain>.seastar.work → 프로젝트 직접 진입
   · 슈퍼/관리자가 프로젝트에 슬러그 부여 → 와일드카드 DNS(*.seastar.work)+호스트라우팅으로 직접 접속
   ════════════════════════════════════════════════════════════ */
const RESERVED_SUBDOMAINS = new Set(['scan', 'scan360', 'www', 'app', 'api', 'admin', 'mail', 'cdn', 'static', 'assets', 'm', 'dev', 'staging'])
function baseDomainOf(c: any): string {
  const pd = String((c.env && c.env.PRIMARY_DOMAIN) || 'scan.seastar.work')
  const parts = pd.split('.')
  return parts.length >= 2 ? parts.slice(-2).join('.') : pd   // scan.seastar.work → seastar.work
}
function subdomainFromHost(host: string, base: string): string | null {
  if (!host) return null
  const h = host.split(':')[0].toLowerCase()
  if (!h.endsWith('.' + base)) return null
  const sub = h.slice(0, h.length - base.length - 1)
  if (!sub || sub.indexOf('.') !== -1) return null
  if (RESERVED_SUBDOMAINS.has(sub)) return null
  return sub
}
function normalizeSubdomain(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}
// 현재 호스트(또는 ?host=)가 가리키는 프로젝트 해석 — 클라 자동진입용(공개 조회)
app.get('/api/tenant/resolve', async (c) => {
  const base = baseDomainOf(c)
  const host = String(c.req.query('host') || c.req.header('host') || '')
  const sub = subdomainFromHost(host, base)
  if (!sub) return c.json({ matched: false, base })
  const row: any = await c.env.DB.prepare(
    'SELECT id, name, subdomain, published FROM projects WHERE subdomain = ? AND deleted = 0'
  ).bind(sub).first()
  if (!row) return c.json({ matched: false, base, subdomain: sub })
  return c.json({ matched: true, base, subdomain: sub, project: { id: row.id, name: row.name, published: !!row.published } })
})
// 슈퍼/관리자: 프로젝트에 서브도메인 부여(도메인 이름만 입력 → 세팅). null/빈값이면 해제.
app.post('/api/projects/:id/subdomain', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  let body: any; try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  if (body.subdomain === null || String(body.subdomain || '').trim() === '') {
    await c.env.DB.prepare('UPDATE projects SET subdomain = NULL, updated_at = ? WHERE id = ?').bind(Date.now(), id).run()
    return c.json({ success: true, subdomain: null })
  }
  const sub = normalizeSubdomain(body.subdomain)
  if (sub.length < 2 || sub.length > 40) return c.json({ error: '서브도메인은 2~40자(영문/숫자/하이픈)' }, 400)
  if (RESERVED_SUBDOMAINS.has(sub)) return c.json({ error: '예약된 이름입니다' }, 400)
  const dup: any = await c.env.DB.prepare('SELECT id FROM projects WHERE subdomain = ? AND deleted = 0 AND id <> ?').bind(sub, id).first()
  if (dup) return c.json({ error: '이미 사용 중인 서브도메인입니다' }, 409)
  await c.env.DB.prepare('UPDATE projects SET subdomain = ?, updated_at = ? WHERE id = ?').bind(sub, Date.now(), id).run()
  await logActivity(c, 'project.subdomain', { actor: user, targetType: 'project', targetId: id, detail: { subdomain: sub } })
  const fqdn = sub + '.' + baseDomainOf(c)
  // [자동 세팅] CF Pages 커스텀 도메인 자동 추가 — 시크릿(CF_API_TOKEN+CF_ACCOUNT_ID) 설정 시
  //   <slug>.seastar.work 를 Pages 프로젝트에 등록 → 1분 내 SSL 발급+활성(도메인 이름만 입력=자동 세팅).
  //   미설정 시 슬러그만 저장(앱 호스트라우팅은 동작, 도메인은 수동 1회 추가 필요).
  let domain = 'slug-saved (CF 시크릿 미설정 → 도메인 수동추가 필요)'
  try {
    const tok = (c.env as any).CF_API_TOKEN, acc = (c.env as any).CF_ACCOUNT_ID
    const proj = (c.env as any).CF_PAGES_PROJECT || 'scan360'
    if (tok && acc) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/pages/projects/${proj}/domains`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fqdn })
      })
      const j: any = await r.json().catch(() => ({}))
      domain = (j && j.success) ? 'provisioning (1분 내 활성)' : ('error: ' + JSON.stringify(j && (j.errors || j.messages)))
    }
  } catch (e: any) { domain = 'exception: ' + (e && e.message) }
  return c.json({ success: true, subdomain: sub, url: 'https://' + fqdn, domain })
})

/* ════════════════════════════════════════════════════════════
   [마스터: 수익화] 과금/구독(Billing) — 테넌트(고객사)별 요금제 + 사용량 게이팅
   · 결제 PG(Toss 등)는 키 설정 후 결합. 지금은 요금제 정의/구독상태/한도/관리자 수동설정.
   ════════════════════════════════════════════════════════════ */
const PLANS: Record<string, any> = {
  free:       { id: 'free',       name: 'Free',       price: 0,      currency: 'KRW', maxProjects: 1,  maxMembers: 3,  maxPanos: 50,   features: ['기본 뷰어', '오프라인', '1 프로젝트'] },
  team:       { id: 'team',       name: 'Team',       price: 49000,  currency: 'KRW', maxProjects: 10, maxMembers: 25, maxPanos: 2000, features: ['전 기능', '전용 도메인', '10 프로젝트', '우선 지원'] },
  enterprise: { id: 'enterprise', name: 'Enterprise', price: 199000, currency: 'KRW', maxProjects: -1, maxMembers: -1, maxPanos: -1,   features: ['무제한 프로젝트/멤버', 'SSO', '전담 지원', 'SLA'] },
}
function planOf(planId: string): any { return PLANS[planId] || PLANS.free }
async function tenantPlanInfo(c: any, tid: string | null): Promise<any> {
  if (!tid) return { ...planOf('free'), planId: 'free', status: 'active', current_period_end: null }
  const t: any = await c.env.DB.prepare('SELECT plan, status, current_period_end, trial_ends_at FROM tenants WHERE id = ?').bind(tid).first().catch(() => null)
  const planId = (t && t.plan) || 'free'
  return { ...planOf(planId), planId, status: (t && t.status) || 'active', current_period_end: (t && t.current_period_end) || null, trial_ends_at: (t && t.trial_ends_at) || null }
}
async function tenantUsage(c: any, tid: string | null): Promise<any> {
  if (!tid) return { projects: 0, members: 0 }
  const pj: any = await c.env.DB.prepare('SELECT COUNT(*) n FROM projects WHERE (tenant_id = ? OR tenant_id IS NULL) AND deleted = 0').bind(tid).first().catch(() => null)
  const mb: any = await c.env.DB.prepare('SELECT COUNT(*) n FROM tenant_members WHERE tenant_id = ?').bind(tid).first().catch(() => null)
  return { projects: (pj && pj.n) || 0, members: (mb && mb.n) || 0 }
}
// 요금제 카탈로그(공개 — 가격 페이지)
app.get('/api/billing/plans', (c) => c.json({ plans: Object.values(PLANS) }))
// 내 테넌트의 구독 상태 + 사용량 + 한도(로그인 필요)
app.get('/api/billing/me', async (c) => {
  const user = await getUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401)
  const tid = await tenantOf(c, user)
  const plan = await tenantPlanInfo(c, tid)
  const usage = await tenantUsage(c, tid)
  const over = {
    projects: plan.maxProjects >= 0 && usage.projects >= plan.maxProjects,
    members: plan.maxMembers >= 0 && usage.members >= plan.maxMembers,
  }
  return c.json({ tenant: tid, plan, usage, over, super_admin: isSuperAdmin(c, user.email) })
})
// 슈퍼관리자: 테넌트 요금제 수동 설정(결제 PG 전 수동 과금/강제변경)
app.post('/api/admin/billing/plan', async (c) => {
  const user = await requireSuper(c); if (!user) return c.json({ error: 'forbidden' }, 403)
  let body: any; try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const tid = String(body.tenant_id || DEFAULT_TENANT)
  const plan = String(body.plan || 'free')
  if (!PLANS[plan]) return c.json({ error: 'unknown plan' }, 400)
  const status = String(body.status || 'active')
  const periodEnd = body.current_period_end != null ? Number(body.current_period_end) : null
  const tname = String(body.name || tid)
  // UPSERT — 테넌트가 없으면 생성하며 요금제 설정(신규 고객사도 즉시 과금 적용)
  await c.env.DB.prepare(
    `INSERT INTO tenants (id, name, plan, status, current_period_end, created_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, status = excluded.status, current_period_end = excluded.current_period_end`
  ).bind(tid, tname, plan, status, periodEnd, Date.now()).run()
  await logActivity(c, 'billing.plan', { actor: user, targetType: 'tenant', targetId: tid, detail: { plan, status } })
  return c.json({ success: true, tenant: tid, plan, status })
})

/* ── 프로젝트 멤버 관리 (어느 프로젝트에 누구를 배정) ──
 * 마스터 요구: 관리자가 프로젝트별로 사용자+역할 세팅 → 뷰어는 배정받은 프로젝트만 열람. */
// 멤버 목록
app.get('/api/projects/:id/members', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT email, role, granted_by, created_at FROM project_members WHERE project_id = ? ORDER BY created_at'
  ).bind(pid).all()
  return c.json({ data: results || [] })
})

// 멤버 배정/수정 (email + role)
app.post('/api/projects/:id/members', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = normEmail(body.email)
  const role = ['viewer', 'editor', 'designer'].includes(body.role) ? body.role : 'viewer'
  if (!email || !isValidEmail(email)) return c.json({ error: 'valid email required' }, 400)
  const now = Date.now()
  // 1) 프로젝트 멤버 등록(접근 권한 + 역할)
  await c.env.DB.prepare(
    `INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, email) DO UPDATE SET role = excluded.role`
  ).bind(pid, email, role, user.email, now).run()

  // 2) [마스터] 초대 = 그 이메일로 바로 로그인 가능하게 — 로컬 계정이 없으면 비번 '1'로 자동 생성.
  //    must_change_password=1 → 첫 로그인 후 본인이 변경. (이미 가입된 계정은 건드리지 않음)
  let created = false
  const existsUser: any = await c.env.DB.prepare('SELECT email FROM local_users WHERE email = ?').bind(email).first()
  if (!existsUser) {
    const { hash, salt } = await hashPassword('1')
    const domain = email.split('@')[1] || ''
    await c.env.DB.prepare(
      `INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, must_change_password, created_at, updated_at, deleted)
       VALUES (?, '', ?, ?, ?, 1, 1, ?, ?, 0)
       ON CONFLICT(email) DO NOTHING`
    ).bind(email, domain, hash, salt, now, now).run()
    created = true
  }

  // 3) [마스터] 디자이너로 초대 → 모든 구역 세팅 권한. deployment 는 project_id 가 없고 tenant 단위라
  //    프로젝트별 스코프 가드가 불가 → 전역 designers 등록으로 편집권한 부여(requireDesigner 통과).
  //    뷰어는 등록하지 않음(열람만). 최고관리자는 designssir 만(isSuperAdmin)으로 별개 유지.
  if (role === 'designer') {
    await c.env.DB.prepare(
      `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, '', ?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET deleted = 0`
    ).bind(email, 'project-invite:' + pid + ' by ' + user.email, now, now).run()
  } else {
    // viewer 로 (재)배정 시, 과거 designer 로 받았던 전역 권한은 회수(이 프로젝트 한정 의도)
    // — 단, 다른 경로(도메인/슈퍼)로 designer 인 경우 isDesigner 가 여전히 true 이므로 안전.
    await c.env.DB.prepare("UPDATE designers SET deleted = 1 WHERE email = ? AND added_by LIKE 'project-invite:%'").bind(email).run().catch(() => {})
  }

  await logActivity(c, 'project.member.add', { actor: user, targetType: 'project', targetId: pid, detail: { email, role, created } })
  return c.json({ success: true, email, role, created })
})

// [마스터] 비밀번호 변경 — 로그인한 로컬 계정 본인(초대 계정의 초기 비번 '1' 변경 포함)
app.post('/api/account/password', async (c) => {
  const user = await getUser(c)
  if (!user || !user._local) return c.json({ error: '로컬 계정만 비밀번호를 변경할 수 있습니다.' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const newPw = String(body.newPassword || '')
  if (newPw.length < 4) return c.json({ error: '새 비밀번호는 4자 이상이어야 합니다.' }, 400)
  const u: any = await c.env.DB.prepare('SELECT pw_hash, pw_salt FROM local_users WHERE email = ? AND deleted = 0').bind(user.email).first()
  if (!u) return c.json({ error: 'not found' }, 404)
  // 현재 비번이 전달되면 검증(자발적 변경). 강제 변경(must_change)일 땐 세션 인증으로 충분하므로 선택적.
  if (body.currentPassword != null && String(body.currentPassword) !== '') {
    const ok = await verifyPassword(String(body.currentPassword), u.pw_salt, u.pw_hash)
    if (!ok) return c.json({ error: '현재 비밀번호가 올바르지 않습니다.' }, 401)
  }
  const { hash, salt } = await hashPassword(newPw)
  await c.env.DB.prepare('UPDATE local_users SET pw_hash = ?, pw_salt = ?, must_change_password = 0, updated_at = ? WHERE email = ?')
    .bind(hash, salt, Date.now(), user.email).run()
  await logActivity(c, 'account.password_change', { actor: user, targetType: 'local_user', targetId: user.email })
  return c.json({ success: true })
})

// 멤버 해제
app.delete('/api/projects/:id/members/:email', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  const email = normEmail(decodeURIComponent(c.req.param('email')))
  await c.env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND email = ?').bind(pid, email).run()
  await logActivity(c, 'project.member.remove', { actor: user, targetType: 'project', targetId: pid, detail: { email } })
  return c.json({ success: true })
})

// ── 프로젝트 접근 신청 / 관리 ──────────────────────────────────────────────

// 비멤버 → 접근 신청 (POST, 로그인 필수)
app.post('/api/projects/:id/request-access', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  const pid = c.req.param('id')
  const proj: any = await c.env.DB.prepare('SELECT id, published FROM projects WHERE id = ? AND deleted = 0').bind(pid).first()
  if (!proj || !proj.published) return c.json({ error: 'not found' }, 404)
  // 이미 멤버면 신청 불필요
  const existing: any = await c.env.DB.prepare('SELECT role FROM project_members WHERE project_id = ? AND email = ?').bind(pid, user.email).first()
  if (existing) return c.json({ error: 'already a member', status: 'member' }, 409)
  let body: any = {}
  try { body = await c.req.json() } catch {}
  const message = String(body.message || '').slice(0, 500)
  const now = Date.now()
  const rid = genId('par')
  await c.env.DB.prepare(
    `INSERT INTO project_access_requests (id, project_id, email, message, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(project_id, email) DO UPDATE SET message = excluded.message, status = 'pending', updated_at = excluded.updated_at`
  ).bind(rid, pid, user.email, message, now, now).run()
  await logActivity(c, 'project.access.request', { actor: user, targetType: 'project', targetId: pid, detail: { email: user.email } })
  return c.json({ success: true, status: 'pending' })
})

// 접근 신청 목록 조회 (프로젝트 관리자 — canManageProject)
app.get('/api/projects/:id/access-requests', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  const status = c.req.query('status') || 'pending'
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM project_access_requests WHERE project_id = ? AND status = ? ORDER BY created_at DESC'
  ).bind(pid, status).all()
  return c.json({ data: results || [] })
})

// 신청 승인 → viewer 자동 배정
app.post('/api/projects/:id/access-requests/:rid/approve', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  const rid = c.req.param('rid')
  const req: any = await c.env.DB.prepare('SELECT * FROM project_access_requests WHERE id = ? AND project_id = ?').bind(rid, pid).first()
  if (!req) return c.json({ error: 'not found' }, 404)
  const now = Date.now()
  await c.env.DB.prepare("UPDATE project_access_requests SET status = 'approved', handled_by = ?, updated_at = ? WHERE id = ?")
    .bind(user.email, now, rid).run()
  await c.env.DB.prepare(
    `INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'viewer', ?, ?)
     ON CONFLICT(project_id, email) DO UPDATE SET role = 'viewer', granted_by = excluded.granted_by`
  ).bind(pid, req.email, user.email, now).run()
  await logActivity(c, 'project.access.approved', { actor: user, targetType: 'project', targetId: pid, detail: { email: req.email } })
  return c.json({ success: true })
})

// 신청 거절
app.post('/api/projects/:id/access-requests/:rid/reject', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  const rid = c.req.param('rid')
  const req: any = await c.env.DB.prepare('SELECT id FROM project_access_requests WHERE id = ? AND project_id = ?').bind(rid, pid).first()
  if (!req) return c.json({ error: 'not found' }, 404)
  const now = Date.now()
  await c.env.DB.prepare("UPDATE project_access_requests SET status = 'rejected', handled_by = ?, updated_at = ? WHERE id = ?")
    .bind(user.email, now, rid).run()
  await logActivity(c, 'project.access.rejected', { actor: user, targetType: 'project', targetId: pid, detail: { email: req.email } })
  return c.json({ success: true })
})

// 전체 프로젝트 접근 신청 목록 (관리자 전용)
app.get('/api/admin/project-access-requests', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  const status = c.req.query('status') || 'pending'
  if (isSuperAdmin(c, user.email)) {
    const { results } = await c.env.DB.prepare(
      "SELECT r.*, p.name as project_name FROM project_access_requests r JOIN projects p ON p.id = r.project_id WHERE r.status = ? ORDER BY r.created_at DESC"
    ).bind(status).all()
    return c.json({ data: results || [] })
  }
  // 내가 관리하는 프로젝트만 (소유자 OR designer 역할)
  const [owned, designerOf]: any[] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM projects WHERE owner = ? AND deleted = 0").bind(user.email).all(),
    c.env.DB.prepare("SELECT project_id FROM project_members WHERE email = ? AND role = 'designer'").bind(user.email).all(),
  ])
  const myPids = [...new Set<string>([
    ...(owned.results || []).map((p: any) => String(p.id)),
    ...(designerOf.results || []).map((r: any) => String(r.project_id)),
  ])]
  if (!myPids.length) return c.json({ data: [] })
  const ph = myPids.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, p.name as project_name FROM project_access_requests r JOIN projects p ON p.id = r.project_id WHERE r.project_id IN (${ph}) AND r.status = ? ORDER BY r.created_at DESC`
  ).bind(...myPids, status).all()
  return c.json({ data: results || [] })
})

// ── 권한 매트릭스 (프로젝트 × 사용자 2D 뷰) ─────────────────────────────

app.get('/api/admin/access-matrix', async (c) => {
  // [보안 2026-08-31] 종전에는 "로그인만 하면" 통과라, 이 응답의 users(=local_users+멤버+신청자 전체 이메일)를
  //   디자이너/뷰어 누구나 열람할 수 있었다. 자동입장 토큰 도입으로 익명에게까지 노출되므로 관리자 전용으로 좁힌다.
  //   호출부는 관리자 패널(25_Designers.loadMatrix) 뿐이고 짝 POST 는 이미 슈퍼 전용 → UX 회귀 없음.
  const user = await requireAdmin(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const superUser = isSuperAdmin(c, user.email)
  // 사용자 목록: project_members + local_users + access_requests 합집합
  const [pm, lu, ar]: any[] = await Promise.all([
    c.env.DB.prepare('SELECT DISTINCT email FROM project_members ORDER BY email').all(),
    c.env.DB.prepare('SELECT email, name FROM local_users WHERE deleted = 0 ORDER BY email').all(),
    c.env.DB.prepare('SELECT DISTINCT email FROM project_access_requests ORDER BY email').all(),
  ])
  const userMap = new Map<string, {email: string, name?: string}>()
  for (const r of (pm.results || [])) userMap.set(r.email, { email: r.email })
  for (const r of (lu.results || [])) userMap.set(r.email, { email: r.email, name: r.name || undefined })
  for (const r of (ar.results || [])) if (!userMap.has(r.email)) userMap.set(r.email, { email: r.email })
  const users = [...userMap.values()]
  // 프로젝트 목록
  let projects: any[]
  if (superUser) {
    const { results } = await c.env.DB.prepare('SELECT id, name FROM projects WHERE deleted = 0 ORDER BY name').all()
    projects = results || []
  } else {
    const [owned, dof]: any[] = await Promise.all([
      c.env.DB.prepare('SELECT id, name FROM projects WHERE owner = ? AND deleted = 0').bind(user.email).all(),
      c.env.DB.prepare("SELECT p.id, p.name FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.email = ? AND m.role = 'designer' AND p.deleted = 0").bind(user.email).all(),
    ])
    const seen = new Set<string>()
    projects = []
    for (const p of [...(owned.results || []), ...(dof.results || [])]) {
      if (!seen.has(p.id)) { seen.add(p.id); projects.push(p) }
    }
  }
  const { results: cells } = await c.env.DB.prepare('SELECT project_id, email, role FROM project_members').all()
  return c.json({ users, projects, cells: cells || [] })
})

app.post('/api/admin/access-matrix', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const updates: {email: string, project_id: string, role: string}[] = body.updates || []
  if (!updates.length) return c.json({ success: true, updated: 0 })
  const now = Date.now()
  let count = 0
  for (const u of updates) {
    if (!isSuperAdmin(c, user.email) && !(await canManageProject(c, user, u.project_id))) continue
    const email = normEmail(u.email)
    if (!email || !isValidEmail(email)) continue
    if (u.role === 'none') {
      await c.env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND email = ?').bind(u.project_id, email).run()
    } else {
      const role = ['viewer', 'editor', 'designer'].includes(u.role) ? u.role : 'viewer'
      await c.env.DB.prepare(
        `INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, email) DO UPDATE SET role = excluded.role`
      ).bind(u.project_id, email, role, user.email, now).run()
    }
    count++
  }
  await logActivity(c, 'admin.access.matrix.update', { actor: user, targetType: 'matrix', targetId: '*', detail: { count } })
  return c.json({ success: true, updated: count })
})

// ── 시스템 플래그 (app_settings scope='*' skey='flag:KEY') ───────────────

app.get('/api/admin/system-flags', async (c) => {
  const user = await getUser(c)
  if (!user || !isSuperAdmin(c, user.email)) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    "SELECT skey, value, updated_by, updated_at FROM app_settings WHERE scope = '*' AND skey LIKE 'flag:%' ORDER BY skey"
  ).all()
  return c.json({ data: results || [] })
})

app.put('/api/admin/system-flags', async (c) => {
  const user = await getUser(c)
  if (!user || !isSuperAdmin(c, user.email)) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const key = String(body.key || '')
  const value = String(body.value ?? 'false')
  if (!/^[A-Z_]+$/.test(key)) return c.json({ error: 'invalid key' }, 400)
  const skey = 'flag:' + key
  const now = Date.now()
  await c.env.DB.prepare(
    "INSERT INTO app_settings (scope, skey, value, updated_by, updated_at) VALUES ('*', ?, ?, ?, ?) ON CONFLICT(scope, skey) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
  ).bind(skey, value, user.email, now).run()
  await logActivity(c, 'admin.flag.set', { actor: user, targetType: 'system', targetId: key, detail: { value } })
  return c.json({ success: true, key, value })
})

/* ── 프로젝트 배포(Publish) / 배포취소 ──
 * 마스터 워크플로: 설계자 모드에서 설계·핀·등록 완료 → 배포 → 권한받은 뷰어가 그 프로젝트 열람.
 * 배포 전(published=0)에는 설계자/소유자/슈퍼만 보이고, 배포 후에만 뷰어에게 노출된다(visibleProjectFilter). */
app.post('/api/projects/:id/publish', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  const now = Date.now()
  await c.env.DB.prepare('UPDATE projects SET published = 1, published_at = ?, published_by = ?, updated_at = ? WHERE id = ? AND deleted = 0')
    .bind(now, user.email, now, pid).run()
  await logActivity(c, 'project.publish', { actor: user, targetType: 'project', targetId: pid })
  const row: any = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(pid).first()
  return c.json({ success: true, project: row ? mapProject(row) : null })
})

app.post('/api/projects/:id/unpublish', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  const now = Date.now()
  await c.env.DB.prepare('UPDATE projects SET published = 0, updated_at = ? WHERE id = ? AND deleted = 0').bind(now, pid).run()
  await logActivity(c, 'project.unpublish', { actor: user, targetType: 'project', targetId: pid })
  return c.json({ success: true })
})

// 데크 목록 (프로젝트별, 로그인 사용자)
app.get('/api/projects/:id/decks', async (c) => {
  if (!(await getUser(c))) return c.json({ error: 'unauthorized' }, 401)  // [보안] 무인증 프로젝트 구조 열람 차단
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
  // [WO 20260916] page/crop — 미전송(undefined)이면 NULL(구버전과 동일 취급). 새 필드는 추가만.
  const page = body.page != null ? Number(body.page) : null
  const crop = body.crop != null ? JSON.stringify(body.crop) : null
  await c.env.DB.prepare(
    `INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, pid, name, body.level_no ?? null, body.deployment_id || null, page, crop, now, now).run()
  return c.json(mapDeck({ id, project_id: pid, name, level_no: body.level_no ?? null, deployment_id: body.deployment_id || null, page, crop, created_at: now, updated_at: now }))
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
  // [WO 20260916] page/crop 부분 수정 지원 — 미전송 필드는 기존값 유지(추가 전용)
  const page = body.page !== undefined ? body.page : row.page
  const crop = body.crop !== undefined ? (body.crop != null ? JSON.stringify(body.crop) : null) : row.crop
  await c.env.DB.prepare(
    'UPDATE decks SET name = ?, level_no = ?, deployment_id = ?, page = ?, crop = ?, updated_at = ? WHERE id = ?'
  ).bind(name, level, dep, page, crop, Date.now(), id).run()
  return c.json(mapDeck({ ...row, name, level_no: level, deployment_id: dep, page, crop }))
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
    annotations: r.annotations || '[]',
    // [P14 · 뷰어 확대 화질] 원본 PDF 위치 + 실제 저장 픽셀(JSON). 구버전 배포본은 NULL.
    source_meta: r.source_meta != null ? r.source_meta : null,
    // [WO 20260917 멀티유저 ①] 페이지별 체크보드 시작번호(JSON). 구버전 배포본(컬럼 없음)은 '{}'
    //   → 클라이언트 _checkboardStart() 가 종전대로 1 반환(하위호환).
    checkboard_start: r.checkboard_start || '{}',
    created_at: r.created_at,
    updated_at: r.updated_at,
    version: (r.version != null ? r.version : 0),
    deleted: !!r.deleted
  }
}

/* ════════════════════════════════════════════
   pano_images — 360° 그림 클라우드 저장
════════════════════════════════════════════ */

// 목록
app.get('/tables/pano_images', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'unauthorized' }, 401)   // [보안 H4] 360 이미지 무인증 열거 차단
  const limit = Math.min(Number(c.req.query('limit') || 100), 1000)
  // [Tenant 격리] 자신의 테넌트 360만 열거(슈퍼/마이그레이션전은 전체). NULL 구행은 기본테넌트 귀속.
  //   [TEMP_OPEN_ALL_TENANTS] true면 테넌트 필터 생략 — 전체 열거(deleted=0 유지).
  let results: any[] = []
  if (TEMP_OPEN_ALL_TENANTS) {
    const r = await c.env.DB.prepare(
      'SELECT * FROM pano_images WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all()
    results = r.results || []
  } else {
    const tid = await tenantOf(c, user)
    if (tid) {
      const includeNull = (tid === DEFAULT_TENANT)
      const sql = includeNull
        ? 'SELECT * FROM pano_images WHERE deleted = 0 AND (tenant_id = ? OR tenant_id IS NULL) ORDER BY created_at DESC LIMIT ?'
        : 'SELECT * FROM pano_images WHERE deleted = 0 AND tenant_id = ? ORDER BY created_at DESC LIMIT ?'
      const r = await c.env.DB.prepare(sql).bind(tid, limit).all()
      results = r.results || []
    } else {
      const r = await c.env.DB.prepare(
        'SELECT * FROM pano_images WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?'
      ).bind(limit).all()
      results = r.results || []
    }
  }
  return c.json({ data: results.map(mapImage), total: results.length })
})

// 단건 조회
app.get('/tables/pano_images/:id', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'unauthorized' }, 401)   // [보안 H4] 로그인 사용자만 360 이미지 조회
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM pano_images WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  // [Tenant 격리] 타 테넌트 360 조회 차단. NULL 구행은 기본테넌트로 간주(하위호환).
  //   [TEMP_OPEN_ALL_TENANTS] true면 테넌트 체크 생략.
  if (!TEMP_OPEN_ALL_TENANTS) {
    const tid = await tenantOf(c, user)
    if (tid) {
      const rowTenant = (row as any).tenant_id || DEFAULT_TENANT
      if (rowTenant !== tid) return c.json({ error: 'not found' }, 404)
    }
  }
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
  const ownTid = (await tenantOf(c, user)) || DEFAULT_TENANT  // [Tenant] 생성자 테넌트로 귀속
  await c.env.DB.prepare(
    `INSERT INTO pano_images (id, name, image_data, width, height, created_at, updated_at, deleted, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(
    id,
    body.name || '',
    body.image_data,
    body.width || null,
    body.height || null,
    now, now, ownTid
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
  // [보안] 로그인 필수 — 도면/파노 바이너리가 URL만으로 공개되던 구멍 차단.
  //   tenant 교차는 S2(pin.imageUrl 이 tenant 격리된 deployment 에서만 나옴)로 차단됨.
  const user = await getUser(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const key = c.req.path.replace('/api/r2/object/', '')
  const obj = await c.env.R2.get(key)
  if (!obj) return c.notFound()
  const headers = new Headers()
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
  // private: 인증된 콘텐츠가 공유 엣지캐시에 남지 않도록(브라우저 캐시는 유지)
  headers.set('Cache-Control', 'private, max-age=31536000, immutable')
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

// 목록 — [P0-2 🔴 보안 봉인] 로그인 사용자(뷰어 이상)만 도면 목록 열람
app.get('/tables/deployments', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'unauthorized — login required' }, 401)
  const limit = Math.min(Number(c.req.query('limit') || 100), 1000)
  // [PART 0 · Tenant 격리] 자신의 테넌트 배포본만 열거(슈퍼/마이그레이션전은 전체)
  //   [TEMP_OPEN_ALL_TENANTS] true면 테넌트 필터 생략 — 전체 열거(deleted=0 유지).
  let results: any[] = []
  if (TEMP_OPEN_ALL_TENANTS) {
    const r = await c.env.DB.prepare(
      'SELECT * FROM deployments WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all()
    results = r.results || []
  } else {
    const tid = await tenantOf(c, user)
    if (tid) {
      // tenant_id 가 NULL 인 구버전 행도 기본 테넌트 사용자에게는 함께 보이도록(하위호환)
      const includeNull = (tid === DEFAULT_TENANT)
      const sql = includeNull
        ? 'SELECT * FROM deployments WHERE deleted = 0 AND (tenant_id = ? OR tenant_id IS NULL) ORDER BY created_at DESC LIMIT ?'
        : 'SELECT * FROM deployments WHERE deleted = 0 AND tenant_id = ? ORDER BY created_at DESC LIMIT ?'
      const r = await c.env.DB.prepare(sql).bind(tid, limit).all()
      results = r.results || []
    } else {
      const r = await c.env.DB.prepare(
        'SELECT * FROM deployments WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?'
      ).bind(limit).all()
      results = r.results || []
    }
  }
  return c.json({ data: results.map(mapDeployment), total: results.length })
})

// 단건 조회 (특정 배포본 고정 공유 — B1)
// [P0-2 🔴 보안 봉인] 로그인 사용자(뷰어 이상)만 단건 도면 열람 가능.
//   (서명 공유링크 기능은 P3-2 에서 별도 토큰으로 분리 제공 예정)
app.get('/tables/deployments/:id', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'unauthorized — login required' }, 401)
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM deployments WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  // [PART 0 · Tenant 격리] 타 테넌트 자원 접근 차단(슈퍼/마이그레이션전 제외).
  //   tenant_id NULL 구행은 기본 테넌트로 간주(하위호환).
  //   [TEMP_OPEN_ALL_TENANTS] true면 테넌트 체크 생략.
  if (!TEMP_OPEN_ALL_TENANTS) {
    const tid = await tenantOf(c, user)
    if (tid) {
      const rowTenant = (row as any).tenant_id || DEFAULT_TENANT
      if (rowTenant !== tid) return c.json({ error: 'not found' }, 404)
    }
  }
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
  // [PART 0 · Tenant 격리] 새 배포본은 작성자 테넌트로 귀속(슈퍼/미등록은 기본 테넌트)
  const ownerTenant = (await tenantOf(c, user)) || DEFAULT_TENANT
  await c.env.DB.prepare(
    `INSERT INTO deployments (id, title, file_name, drawing_data, pages_data, pins, zones, annotations, source_meta, checkboard_start, tenant_id, created_at, updated_at, version, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
  ).bind(
    id,
    body.title || '',
    body.file_name || '',
    body.drawing_data || null,
    body.pages_data || null,
    body.pins || '[]',
    body.zones || '[]',
    body.annotations || '[]',
    body.source_meta || null,
    // [WO 20260917 멀티유저 ①] 페이지별 체크보드 시작번호(폴백값). 사용자 대역(1순위)은
    // 클라이언트 localStorage 에만 있어 서버가 알 필요 없다 — 여기는 구버전/비로그인 폴백뿐.
    body.checkboard_start || null,
    ownerTenant,
    now, now
  ).run()

  let pinCount = 0
  try { pinCount = Array.isArray(JSON.parse(body.pins || '[]')) ? JSON.parse(body.pins || '[]').length : 0 } catch {}
  await logActivity(c, 'deployment.create', { targetType: 'deployment', targetId: id, detail: { title: body.title || '', file_name: body.file_name || '', pins: pinCount } })

  return c.json(mapDeployment({
    id, title: body.title || '', file_name: body.file_name || '',
    drawing_data: body.drawing_data || null, pages_data: body.pages_data || null,
    pins: body.pins || '[]', zones: body.zones || '[]', annotations: body.annotations || '[]',
    source_meta: body.source_meta || null,
    checkboard_start: body.checkboard_start || null,
    created_at: now, updated_at: now, version: 0, deleted: 0
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
  // [PART 0 · Tenant 격리] 타 테넌트 배포본 수정 차단(슈퍼/마이그레이션전 제외)
  {
    const tid = await tenantOf(c, user)
    if (tid) {
      const rowTenant = (existing as any).tenant_id || DEFAULT_TENANT
      if (rowTenant !== tid) return c.json({ error: 'not found' }, 404)
    }
  }
  const now = Date.now()
  const curVersion = (existing.version != null ? Number(existing.version) : 0)

  // ── [멀티유저 충돌 방지 — 낙관적 잠금] ─────────────────────────────
  // 클라이언트가 base_version 을 보냈고, 서버의 현재 version 과 다르면
  // 그 사이 다른 사용자가 저장한 것 → 409 충돌. 서버 최신본(pins/zones/version)을
  // 함께 돌려주어 클라이언트가 병합 후 재시도하게 한다.
  // base_version 미전송(구버전 클라이언트)이면 종전처럼 그대로 갱신(하위호환).
  if (body.base_version != null && Number(body.base_version) !== curVersion) {
    return c.json({
      error: 'conflict',
      message: '다른 사용자가 먼저 저장했습니다. 최신본과 병합 후 다시 저장하세요.',
      current: mapDeployment(existing)
    }, 409)
  }

  const merged = {
    title:        body.title        != null ? body.title        : existing.title,
    file_name:    body.file_name     != null ? body.file_name    : existing.file_name,
    drawing_data: body.drawing_data  != null ? body.drawing_data : existing.drawing_data,
    pages_data:   body.pages_data    != null ? body.pages_data   : existing.pages_data,
    pins:         body.pins          != null ? body.pins         : existing.pins,
    zones:        body.zones         != null ? body.zones        : existing.zones,
    annotations:  body.annotations   != null ? body.annotations  : (existing.annotations || '[]'),
    // [P14] 미전송 시 기존 값 보존(부분 갱신) — 원본 없는 구버전 저장 흐름이 기존 원본을 지우지 않는다.
    source_meta:  body.source_meta   != null ? body.source_meta  : (existing.source_meta != null ? existing.source_meta : null),
    // [WO 20260917 멀티유저 ①] 페이지별 체크보드 시작번호(폴백값, 부분 갱신 — 미전송이면 기존값 보존).
    checkboard_start: body.checkboard_start != null ? body.checkboard_start : (existing.checkboard_start != null ? existing.checkboard_start : null),
  }
  const newVersion = curVersion + 1
  await c.env.DB.prepare(
    `UPDATE deployments SET title=?, file_name=?, drawing_data=?, pages_data=?, pins=?, zones=?, annotations=?, source_meta=?, checkboard_start=?, updated_at=?, version=? WHERE id=?`
  ).bind(
    merged.title, merged.file_name, merged.drawing_data, merged.pages_data,
    merged.pins, merged.zones, merged.annotations, merged.source_meta, merged.checkboard_start, now, newVersion, id
  ).run()
  return c.json(mapDeployment(Object.assign({}, existing, merged, { id, updated_at: now, version: newVersion })))
}
app.patch('/tables/deployments/:id', updateDeployment)
app.put('/tables/deployments/:id', updateDeployment)

/* ── [오프라인 작업지시서 ❶/❾] 충돌 없는 op 일괄 적용 ─────────────────
 * 배열 통째 덮어쓰기 금지. 핀/구역/주석을 id 기준 개별 op 로 적용한다.
 *  - 두 작업자가 서로 다른 핀을 추가 → 둘 다 보존(충돌 없음)
 *  - 같은 엔티티 동시 수정 → 필드단위 얕은 병합 + ts 최신(LWW)
 *  - delete → tombstone(_deleted) 보존(재생성 방지)
 *  - 같은 opId 재전송 → applied_ops 로 멱등 차단(version 추가증가 없음)
 * body: { base_version?, ops:[ {opId, entity:'pin'|'zone'|'anno'|'note', action:'upsert'|'delete', id, data?, ts, author} ] }
 *  - entity:'note' 는 pins/zones/annotations 와 달리 배포본 JSON blob이 아니라 별도 pin_notes 테이블에 씀.
 *    op.id 는 클라이언트 임시 id(오프라인 작성) 또는 이미 동기화된 실제 note id. 임시 id는 최초 upsert에서
 *    행을 새로 만들고 실제 id를 생성해 응답 noteIdMap[임시id]=실제id 로 돌려준다(화면 참조 치환용).
 *    applied_ops 멱등 체크는 위 공통 로직 그대로 재사용(같은 opId 재전송 시 중복 생성 없음).
 */
app.post('/tables/deployments/:id/ops', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const ops = Array.isArray(body?.ops) ? body.ops : []

  const dep: any = await c.env.DB.prepare('SELECT * FROM deployments WHERE id = ? AND deleted = 0').bind(id).first()
  if (!dep) return c.json({ error: 'not found' }, 404)
  // [PART 0 · Tenant 격리] 타 테넌트 배포본 op 적용 차단(슈퍼/마이그레이션전 제외)
  {
    const tid = await tenantOf(c, user)
    if (tid) {
      const rowTenant = dep.tenant_id || DEFAULT_TENANT
      if (rowTenant !== tid) return c.json({ error: 'not found' }, 404)
    }
  }

  // 현재 서버 상태를 id→객체 맵으로 로드
  const toMap = (j: string) => {
    const arr = (() => { try { return JSON.parse(j || '[]') } catch { return [] } })()
    const m = new Map<string, any>()
    for (const o of arr) if (o && o.id != null) m.set(String(o.id), o)
    return m
  }
  const pins = toMap(dep.pins), zones = toMap(dep.zones), annos = toMap(dep.annotations)
  const pick = (e: string) => e === 'pin' ? pins : e === 'zone' ? zones : annos

  const applied: string[] = []
  let newlyApplied = 0   // 멱등: 실제로 새로 적용된 op만 카운트 → version 증가 판정에 사용
  const noteIdMap: Record<string, string> = {}   // 클라 임시 note id → 서버 실제 id
  for (const op of ops) {
    if (!op || !op.opId || !op.entity || op.id == null) continue
    // 멱등: 이미 적용된 opId면 건너뜀(중복 업로드 무해, version 증가에 기여하지 않음)
    const dup = await c.env.DB.prepare('SELECT op_id FROM applied_ops WHERE op_id = ?').bind(op.opId).first()
    if (dup) { applied.push(op.opId); continue }
    const opTsNote = Number(op.ts || Date.now())

    // ── entity:'note' — pin_notes 테이블 직접 반영(배포본 blob과 무관, version 불변) ──
    if (op.entity === 'note') {
      const localId = String(op.id)
      const realId = noteIdMap[localId] || localId
      const isTemp = realId.indexOf('tmp-note-') === 0
      if (op.action === 'delete') {
        if (!isTemp) {
          await c.env.DB.prepare('UPDATE pin_notes SET deleted = 1, updated_at = ? WHERE id = ?')
            .bind(opTsNote, realId).run()
        }
        // isTemp(한 번도 서버에 생성된 적 없는 노트) → 삭제할 행이 없으므로 no-op
      } else { // upsert
        const d = op.data || {}
        if (isTemp) {
          const newId = genId('note')
          const status = VALID_STATUS.includes(d.status) ? d.status : 'open'
          await c.env.DB.prepare(
            `INSERT INTO pin_notes
              (id, deployment_id, pin_id, pin_label, body, status, assignee, author, author_email, author_role, created_at, updated_at, resolved_at, deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
          ).bind(
            newId, id, String(d.pin_id || ''), String(d.pin_label || ''),
            String(d.body || '').slice(0, 4000), status,
            (d.assignee ? String(d.assignee) : null), String(d.author || '익명'),
            d.author_email || null, d.author_role || 'guest',
            opTsNote, opTsNote, status === 'done' ? opTsNote : null
          ).run()
          noteIdMap[localId] = newId
        } else {
          const fields: string[] = []; const args: any[] = []
          if (typeof d.body === 'string') { fields.push('body = ?'); args.push(d.body.slice(0, 4000)) }
          if (typeof d.status === 'string' && VALID_STATUS.includes(d.status)) {
            fields.push('status = ?'); args.push(d.status)
            fields.push('resolved_at = ?'); args.push(d.status === 'done' ? opTsNote : null)
          }
          if (typeof d.assignee === 'string') { fields.push('assignee = ?'); args.push(d.assignee.trim() || null) }
          if (fields.length) {
            fields.push('updated_at = ?'); args.push(opTsNote)
            args.push(realId)
            await c.env.DB.prepare(`UPDATE pin_notes SET ${fields.join(', ')} WHERE id = ? AND deleted = 0`).bind(...args).run()
          }
        }
      }
      await c.env.DB.prepare('INSERT OR IGNORE INTO applied_ops (op_id, deployment_id, applied_at) VALUES (?, ?, ?)')
        .bind(op.opId, id, Date.now()).run()
      applied.push(op.opId)
      continue
    }

    const m = pick(op.entity)
    const cur = m.get(String(op.id))
    const opTs = Number(op.ts || Date.now())
    if (op.action === 'delete') {
      // tombstone 보존 — 더 최신 의도만 반영
      if (!cur || opTs >= Number(cur.ts || 0)) {
        m.set(String(op.id), { id: op.id, _deleted: true, ts: opTs })
      }
    } else { // upsert — 필드단위 얕은 병합(둘 다 보존) + 같은 필드는 ts 최신
      if (cur && !cur._deleted) {
        const merged = Object.assign({}, cur, op.data, { id: op.id, ts: Math.max(opTs, Number(cur.ts || 0)) })
        m.set(String(op.id), merged)
      } else if (cur && cur._deleted && opTs < Number(cur.ts || 0)) {
        // [버그수정] 더 최신 삭제(tombstone)는 옛 upsert(ts 더 과거)로 부활 금지 — 삭제 유지
      } else {
        m.set(String(op.id), Object.assign({}, op.data, { id: op.id, ts: opTs }))
      }
    }
    await c.env.DB.prepare('INSERT OR IGNORE INTO applied_ops (op_id, deployment_id, applied_at) VALUES (?, ?, ?)')
      .bind(op.opId, id, Date.now()).run()
    applied.push(op.opId)
    newlyApplied++
  }

  const dump = (m: Map<string, any>) => JSON.stringify(Array.from(m.values()))
  const curVersion = (dep.version != null ? Number(dep.version) : 0)
  // 새로 적용된 op가 있을 때만 version 증가(중복 opId 재전송은 version 불변 — 멱등)
  const changed = newlyApplied > 0
  const newVersion = changed ? curVersion + 1 : curVersion
  if (changed) {
    await c.env.DB.prepare(
      'UPDATE deployments SET pins=?, zones=?, annotations=?, updated_at=?, version=? WHERE id=?'
    ).bind(dump(pins), dump(zones), dump(annos), Date.now(), newVersion, id).run()
  }

  return c.json({
    ok: true, applied, version: newVersion, noteIdMap,
    current: mapDeployment(Object.assign({}, dep, {
      pins: dump(pins), zones: dump(zones), annotations: dump(annos), version: newVersion
    }))
  })
})

// 삭제 (soft delete) — 디자이너 이상
app.delete('/tables/deployments/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const id = c.req.param('id')
  // [PART 0 · Tenant 격리] 타 테넌트 배포본 삭제 차단(슈퍼/마이그레이션전 제외)
  const tid = await tenantOf(c, user)
  if (tid) {
    const row = await c.env.DB.prepare('SELECT tenant_id FROM deployments WHERE id = ?').bind(id).first()
    if (row) {
      const rowTenant = (row as any).tenant_id || DEFAULT_TENANT
      if (rowTenant !== tid) return c.json({ error: 'not found' }, 404)
    }
  }
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

  const ownTid = (await tenantOf(c, user)) || DEFAULT_TENANT  // [Tenant] 업로더 테넌트로 귀속
  const results: any[] = []
  for (const op of ops) {
    try {
      if (!op || !op.image_data) {
        // 결정적(영구) 거부 — 클라가 큐에서 제거해도 됨(재시도해도 같은 실패)
        results.push({ opId: op?.opId, ok: false, permanent: true, error: 'image_data required' })
        continue
      }
      // [멱등] 같은 opId 가 이미 저장됐으면(응답유실 후 재전송) 새로 만들지 말고 기존 id 반환
      if (op.opId) {
        const ex: any = await c.env.DB.prepare(
          `SELECT id FROM pano_images WHERE source_op_id = ? AND deleted = 0 LIMIT 1`
        ).bind(op.opId).first()
        if (ex && ex.id) { results.push({ opId: op.opId, ok: true, id: ex.id, dedup: true }); continue }
      }
      const id = genId('img')
      const now = Date.now()
      const name = (op.kind === 'doc' ? '[doc] ' : '') + (op.name || '')
      await c.env.DB.prepare(
        `INSERT INTO pano_images (id, name, image_data, width, height, created_at, updated_at, deleted, source_op_id, tenant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).bind(id, name, op.image_data, op.width || null, op.height || null, now, now, op.opId || null, ownTid).run()
      results.push({ opId: op.opId, ok: true, id })
    } catch (e: any) {
      // 일시적 오류(D1 장애/타임아웃 등) — permanent 아님. 클라는 큐를 보존하고 다음 동기화 때 재시도
      //   → 일시 오류로 360 사진이 영구 삭제되던 데이터손실 차단.
      results.push({ opId: op?.opId, ok: false, permanent: false, error: String(e?.message || e) })
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
  if (!(await getUser(c))) return c.json({ error: 'unauthorized' }, 401)   // [보안 M2] 노트(이슈)는 로그인 사용자만
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
  if (!(await getUser(c))) return c.json({ error: 'unauthorized' }, 401)   // [보안 M2]
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
  const author_role = user ? (await isDesigner(c, user.email) ? (isSuperAdmin(c, user.email) ? 'super' : 'designer') : 'viewer') : 'guest'

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
    let res = await assets.fetch(new Request(c.req.url, { method: 'GET' }))
    if (res.status === 404) {
      res = await assets.fetch(new Request(url.origin + '/index.html', { method: 'GET' }))
    }
    // [근본수정] 앱 셸(HTML/JS/CSS/SW/manifest)을 항상 재검증(no-cache) → 배포 즉시 반영 +
    //   HTML/JS/CSS 버전 일치(옛 JS+새 CSS 불일치로 스타일 깨지는 문제 차단).
    //   ⚠ _worker.js(Advanced Mode)에선 _headers 가 무시되므로 워커에서 직접 헤더를 씌운다.
    //   CF ASSETS 기본 max-age=14400(4시간)이 "배포해도 새로고침 안 됨 + 깨짐"의 원인이었다.
    const p = url.pathname
    const isShell = p === '/' || p === '/sw.js' || p === '/manifest.webmanifest' || /\.(html|css|js)$/i.test(p)
    if (isShell) {
      res = new Response(res.body, res)   // 헤더 수정 가능하도록 복제
      res.headers.set('Cache-Control', 'no-cache, must-revalidate')
    }
    return res
  }
  return c.text('Not Found', 404)
})

export default app
