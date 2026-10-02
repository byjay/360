import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { normEmail, emailDomain, isValidEmail, gen6, randToken, bufToHex, hashPassword, verifyPassword, randInviteToken, sha256Hex, randShareToken, isShareToken, sharePath, shareTokenFromSegment,
  randShareCode, normalizeShareCode, isShareCode, REAUTH_TTL_MS, reauthFresh, safeEqualStr } from './lib/util'
import { decideCompanyGate, askJevSameCompany, COMPANY_GATE_PASS_P } from './lib/jev'
import { sanitizeDupPairs, askJevDupPairs } from './lib/jevDup'
import { askJevSeverity, gateSeverity, SEVERITY_LEVELS } from './lib/jevSeverity'

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
  // [P68] Jev(TypeSafe System One) — 회사명 게이트의 2차 판정. 🔴 시크릿으로만 주입, 프론트 노출 금지.
  //   설정: `wrangler pages secret put OPENROUTER_API_KEY` (없으면 게이트는 규칙 결과=리젝트로 폴백)
  OPENROUTER_API_KEY?: string
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
// [WO 20261001-invite · 마스터 확정 ④] 전체개방 종료 → false. 소유자/super 외 멤버 관리 불가 · 허브는 테넌트/멤버 기준.
const TEMP_OPEN_ALL_TENANTS = false

/* ══ [마스터 2026-08-31] 로그인 없는 디자이너 자동입장 전용 토큰 ═════════════
 * 배경: 데모 토큰 패밀리(demo-super/demo-designer/demo-viewer)는 2026-06-23 P0 보안조치로
 *   CF 시크릿 DEMO_LOGIN='0' 봉인됨(demo-super 로 슈퍼관리자 탈취 가능했던 구멍). 그 봉인은 유지한다.
 * 따라서 자동입장은 데모 경로를 재개방하지 않고, **디자이너 권한만 가능한 별도 토큰**으로 처리한다.
 * 불변식(코드로 강제):
 *   ① 이 토큰의 이메일은 isSuperAdmin/isAdmin 에서 **항상 false** (아래 하드 denylist) → super/admin 승격 불가.
 *   ② roleOf 는 super/admin 을 통과하지 못하므로 결과가 언제나 'designer'.
 *   ③ demoLoginEnabled(c) 와 완전히 독립 — 이 스위치 하나로만 열고 닫는다.
 * 되돌리기: 아래 ENABLED=false + 클라 public/js/modules/22_Auth.js 의 AUTO_DESIGNER_ENTRY=false. */
// [WO 20261001-invite · 마스터 확정 ④] 공용석 종료 → false. 이 스위치는 **편집(designer) 공용석**만 닫는다.
//   열람 전용 서명 토큰(ae1 kind=viewer: `?d=` 배포 링크 · /srview 공유 링크 · 초대코드 게이트 통행증)은 유지된다
//   — 끄면 공유 링크 열람이 전부 끊기기 때문(autoEntryFromToken 참조).
const AUTO_DESIGNER_TOKEN_ENABLED = false
const AUTO_DESIGNER_TOKEN = 'auto-designer-entry-360'
const AUTO_DESIGNER_EMAIL = 'auto.designer@seastargo.com'   // 예약 계정(실사용자 아님)
const AUTO_DESIGNER_USER = { email: AUTO_DESIGNER_EMAIL, name: '설계자', picture: '', role: 'designer' as const }
/** 자동입장 **레거시 고정 문자열** 토큰 → 열람 전용(_readonly) 사용자.
 *  [P48 보안 2026-09-18] 이 문자열은 클라이언트 번들에 박혀 공개돼 있다(= 비밀이 아니다).
 *  따라서 더 이상 쓰기 자격으로 인정하지 않는다. 읽기만 허용해 기존 세션의 열람은 유지한다.
 *  쓰기 가능한 자동입장은 아래 서명 토큰(ae1.*)으로만 발급된다. */
function autoDesignerFromToken(token: string): any | null {
  if (!AUTO_DESIGNER_TOKEN_ENABLED) return null
  if (token !== AUTO_DESIGNER_TOKEN) return null
  return { ...AUTO_DESIGNER_USER, _auto: true, _readonly: true }
}

/* ══ [P48 보안 · 마스터 재현 2026-09-18] 배포 링크 세션이 서버 쓰기까지 가능했던 결함 ══
 * 재현: storage clear → `?d=dep_...` 만 열기 → sessionStorage 에 고정 문자열 토큰이 깔리고
 *       fetch PATCH /tables/deployments/:id → 200. UI 만 숨겼을 뿐 서버가 막지 않았다.
 * 근본원인 2개:
 *   ⓐ AUTO_DESIGNER_TOKEN 이 **클라 번들에 박힌 고정 문자열** → 비밀이 아닌데 쓰기 자격이었다.
 *   ⓑ 쓰기 차단이 클라이언트 UI(designerOnlyVisible)에만 있었다 → 서버 강제 없음.
 * 조치:
 *   ① 고정 문자열 = 열람 전용으로 강등(위 autoDesignerFromToken).
 *   ② 편집 가능한 자동입장 토큰은 **서버가 HMAC 서명해 발급**(POST /api/auth/auto-entry).
 *      비밀키: CF 시크릿 AUTO_ENTRY_SECRET → 없으면 D1 app_settings 에 암호난수로 1회 자동생성.
 *      상수가 아니므로 번들 노출·영구유효 문제가 사라지고, 키 교체 한 번으로 전량 폐기된다.
 *   ③ `?d=` 로 들어온 클라이언트는 kind='viewer'(열람전용) 토큰만 요청한다.
 *   ④ 🔴 최종 방어선은 UI 가 아니라 서버 미들웨어 readOnlyGuard — 모든 변경 메서드를 한 곳에서 거부.
 * 🔴 남은 한계(정직 보고): 발급 엔드포인트 자체가 익명이라, 환경변수 AUTO_ENTRY_DESIGNER_KEY 를
 *   설정하지 않으면 "kind=designer 를 그냥 요청"하는 우회는 남는다. 이는 마스터 모델
 *   ("로그인 없이 디자이너 진입 유지" + "?d= 없는 직접 접속은 쓰기 가능")이 요구하는 잔여 위험이며,
 *   그 키를 설정하는 순간 코드 변경 없이 완전 차단된다.
 * TEMP_OPEN_ALL_TENANTS 와의 관계: 그 플래그는 canManageProject(=프로젝트 범위)만 넓힌다.
 *   readOnlyGuard 는 그보다 앞단(메서드 단위)에서 끊으므로 플래그가 true 여도 열람전용은 쓰기 불가. */
const AUTO_ENTRY_PREFIX  = 'ae1.'
const AUTO_ENTRY_TTL_MS  = 7 * 24 * 60 * 60 * 1000     // 자동입장 서명 토큰 유효기간(7일)
const AUTO_ENTRY_SKEY    = 'auto_entry_secret'          // app_settings(scope='*') 자동생성 비밀키 행
/* ══ [P63] 뷰어 초대코드 게이트 상수 — 값의 단일 진실 소스(매직넘버 중복 금지) ══ */
/** 게이트 통과 세션 유효기간. 🔴 마스터 요구("한 번 통과하면 재입력 없이 계속 열람")와
 *  "유출 시 끊을 수 있어야 한다"의 절충: 코드 폐기가 반영돼야 하므로 무기한은 안 된다.
 *  30일이면 현장 한 공정을 재입력 없이 넘기고, 폐기 후 최장 30일 내 전원 재인증된다. */
const SHARE_GATE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 🔴 사용자에게 보여줄 문의 주소. 개발 관리자 gmail 주소는 어떤 화면에도 쓰지 않는다(마스터 확정). */
const SUPPORT_CONTACT_EMAIL = 'designsir@seastargo.com'
/** [WO 20261001-viewerhelp] 개발자 문의 — 남용 방지 상수의 단일 정본(값이 두 곳에 생기면 갈라진다). */
const INQUIRY_RATE_LIMIT_PER_MIN = 3
const INQUIRY_RATE_WINDOW_MS = 60 * 1000
const INQUIRY_TITLE_MAX = 200
const INQUIRY_BODY_MAX = 4000
/** [WO 20261001-viewreq] 열람자 요청·질문 남용 방지 상수(정본). 디자이너 작성·답변은 제한하지 않는다. */
const NOTE_REQUEST_RATE_LIMIT_PER_MIN = 5
const NOTE_BODY_MAX = 4000
const NOTE_AUTHOR_MAX = 60
const NOTE_CONTACT_MAX = 200
const NOTE_KINDS = ['note', 'request', 'question', 'reply']
const NOTE_VIEWER_KINDS = ['request', 'question']   // 열람자가 쓸 수 있는 종류
/** 🔴 개인정보(이름·소속·IP) 보관 기간 — activity_log 정리 정책의 **단일 정본**.
 *  근거: 도면 열람 기록은 계약·감사 대응상 최소 1년 필요, 그 이상은 목적 달성에 불필요
 *  (개인정보보호법 제21조 파기 원칙). 자동 삭제 배치는 마스터 확인 전이라 만들지 않았다 —
 *  정리 스크립트/배치를 붙일 때 반드시 이 상수를 참조할 것(값이 두 곳에 생기면 반드시 갈라진다). */
const PERSONAL_LOG_RETENTION_DAYS = 365
/** 변경(쓰기) HTTP 메서드 — readOnlyGuard 의 단일 진실 소스. */
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']
/** 열람전용 주체에게도 허용하는 비-콘텐츠 경로(로그인/가입/자동입장 발급 = 권한을 얻는 통로 자체).
 *  이 목록 밖의 모든 변경 요청은 거부된다(allowlist 방식 — 새 쓰기 라우트가 자동으로 보호됨). */
// [P63] '/api/share/verify' = 초대코드 제출 = **권한을 얻는 통로 자체**라 열람전용에도 열어야 한다
//   (로그인/가입 엔드포인트와 동일한 성격). 그 외 /api/share/* 쓰기는 여전히 거부된다.
// [WO 20261001-viewerhelp] '/api/inquiries' = 로그인 없는 공유/배포 링크 열람자도 보낼 수 있어야
//   하는 개발자 문의 접수 — 콘텐츠 쓰기가 아니라 "문의 제출" 통로 자체라 열람전용에도 연다.
// [WO 20261001-viewreq] '/api/notes' = 열람자(공유/배포 링크 포함)의 요청·질문 접수 통로(마스터: "보기만 + 요청은 가능").
//   🔴 가드를 통과시키는 대신 노트 라우트 자체가 열람전용 세션을 따로 판정한다(noteActor):
//   작성은 kind=request|question·status=open 으로 강제, 수정·삭제는 수정키(X-Note-Key) 일치 본인만, 답변·상태변경은 디자이너만.
const READONLY_ALLOWED_WRITE_PREFIXES = ['/api/signup/', '/api/invite/', '/api/auth/', '/api/client-log', '/api/share/verify', '/api/inquiries', '/api/notes']

const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uDec = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'))

/** 자동입장 서명 비밀키. CF 시크릿 우선, 없으면 D1 에 암호난수로 1회 자동생성(하드코딩 금지).
 *  D1 마저 불가하면 null → 서명 토큰 발급/검증 전부 실패(조용한 실패 대신 정직한 거부). */
async function autoEntrySecret(c: any): Promise<string | null> {
  const env = c?.env?.AUTO_ENTRY_SECRET
  if (typeof env === 'string' && env.length >= 16) return env
  try {
    const row: any = await c.env.DB.prepare(
      "SELECT value FROM app_settings WHERE scope = '*' AND skey = ?"
    ).bind(AUTO_ENTRY_SKEY).first()
    if (row && typeof row.value === 'string' && row.value.length >= 16) return row.value
    const fresh = randToken('aes') + randToken('')
    await c.env.DB.prepare(
      "INSERT INTO app_settings (scope, skey, value, updated_by, updated_at) VALUES ('*', ?, ?, 'system', ?) ON CONFLICT(scope, skey) DO NOTHING"
    ).bind(AUTO_ENTRY_SKEY, fresh, Date.now()).run()
    const again: any = await c.env.DB.prepare(
      "SELECT value FROM app_settings WHERE scope = '*' AND skey = ?"
    ).bind(AUTO_ENTRY_SKEY).first()
    return (again && again.value) ? String(again.value) : fresh
  } catch { return null }
}

async function hmacB64u(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  return b64u(String.fromCharCode(...new Uint8Array(sig)))
}

/** 자동입장 서명 토큰 발급. kind='designer' 면 편집 가능, 'viewer' 면 열람 전용.
 *  [P63] gatePid 를 주면 그 프로젝트의 **초대코드 게이트를 통과했다**는 클레임(g)이 실린다.
 *    🔴 게이트 통과는 열람 자격일 뿐이다 — kind 는 언제나 'viewer'(열람 전용)로 강제한다.
 *    서명이 붙으므로 클라이언트가 g 를 위조할 수 없다(기존 HMAC 경로 재사용 = SoT). */
async function mintAutoEntryToken(c: any, kind: 'designer' | 'viewer', gatePid?: string): Promise<{ token: string, exp: number } | null> {
  const secret = await autoEntrySecret(c)
  if (!secret) return null
  if (gatePid) kind = 'viewer'   // [불변식] 게이트 통과가 쓰기 권한이 되는 경로를 원천 차단
  const exp = Date.now() + (gatePid ? SHARE_GATE_TTL_MS : AUTO_ENTRY_TTL_MS)
  const body: any = { k: kind, exp, n: randToken('') }
  if (gatePid) body.g = String(gatePid)
  const payload = b64u(JSON.stringify(body))
  return { token: AUTO_ENTRY_PREFIX + payload + '.' + (await hmacB64u(secret, payload)), exp }
}

/** 자동입장 서명 토큰 검증 → 사용자(열람전용 여부 포함). 서명/만료 불일치면 null. */
async function autoEntryFromToken(c: any, token: string): Promise<any | null> {
  if (!token.startsWith(AUTO_ENTRY_PREFIX)) return null
  const rest = token.slice(AUTO_ENTRY_PREFIX.length)
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = rest.slice(0, dot), sig = rest.slice(dot + 1)
  const secret = await autoEntrySecret(c)
  if (!secret) return null
  const expect = await hmacB64u(secret, payload)
  // 길이 선비교 후 상수시간 비교(타이밍 공격 완화)
  if (expect.length !== sig.length) return null
  let diff = 0
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i)
  if (diff !== 0) return null
  let p: any
  try { p = JSON.parse(b64uDec(payload)) } catch { return null }
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null
  if (p.k !== 'designer' && p.k !== 'viewer') return null
  // [WO 20261001-invite] 공용석이 닫히면 이미 발급된 편집 토큰도 즉시 무효(열람 전용 토큰은 유지)
  if (p.k === 'designer' && !AUTO_DESIGNER_TOKEN_ENABLED) return null
  // [P63] _gate = 초대코드를 통과한 프로젝트 id(없으면 null). 🔴 쓰기 권한과 무관하다.
  return { ...AUTO_DESIGNER_USER, _auto: true, _readonly: p.k !== 'designer', _gate: (typeof p.g === 'string' && p.g) ? p.g : null }
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

/** [WO 20261002-gap 묶음D] 메일 발송 실패 사유 — 상태코드 + 응답 본문 요약(키 값 제외) + 키 폐기(401/403) 플래그. */
type MailError = { status: number | null; summary: string; keyRevoked: boolean }

/** [WO 20261002-gap 묶음D] Resend/SendGrid 공용 발송 — 성공/실패를 값으로 구분한다(🔴 삼키는 catch 금지, 실패 사유를 버리지 않는다).
 *  null = 두 키 모두 미설정(호출부가 dev-fallback 또는 '설정 안 됨'으로 처리). sendVerificationEmail·sendInquiryEmail 공유 지점(SoT) —
 *  발송 로직을 두 곳에 따로 두면 반드시 갈라진다. */
async function postMail(c: any, opts: { to: string; subject: string; html: string; text: string }):
  Promise<{ sent: true; provider: string } | { sent: false; error: MailError } | null> {
  const fromEmail = (c.env?.MAIL_FROM && String(c.env.MAIL_FROM).includes('@')) ? c.env.MAIL_FROM : 'no-reply@seastargo.com'
  const summarize = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  try {
    if (c.env?.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + c.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromEmail, to: [opts.to], subject: opts.subject, html: opts.html, text: opts.text })
      })
      if (res.ok) return { sent: true, provider: 'resend' }
      const txt = await res.text().catch(() => '')
      return { sent: false, error: { status: res.status, summary: summarize(txt), keyRevoked: res.status === 401 || res.status === 403 } }
    }
    if (c.env?.SENDGRID_API_KEY) {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + c.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: opts.to }] }],
          from: { email: fromEmail, name: 'SEASTAR 360 Viewer' },
          subject: opts.subject,
          content: [{ type: 'text/plain', value: opts.text }, { type: 'text/html', value: opts.html }]
        })
      })
      if (res.ok || res.status === 202) return { sent: true, provider: 'sendgrid' }
      const txt = await res.text().catch(() => '')
      return { sent: false, error: { status: res.status, summary: summarize(txt), keyRevoked: res.status === 401 || res.status === 403 } }
    }
    return null   // 키 미설정
  } catch (e: any) {
    const name = (e && (e.name || e.constructor?.name)) || 'error'
    return { sent: false, error: { status: null, summary: 'network:' + String(name).slice(0, 60), keyRevoked: false } }
  }
}

/** 이메일 발송. RESEND_API_KEY 또는 SENDGRID_API_KEY 가 있으면 실제 발송, 없으면 dev-fallback(코드 반환).
 *  🔴 [WO 20261002-gap R6] 키가 설정됐는데 실제로 실패하면(네트워크/4xx/5xx) dev_code 를 주지 않는다 —
 *  그걸 주면 메일 인프라가 고장 났을 때도 인증코드가 응답에 그대로 노출되는 백도어가 된다(가짜 성공 금지).
 *  dev-fallback 은 "키 자체가 없는" 의도된 개발/시연 모드에만 쓴다. */
async function sendVerificationEmail(c: any, email: string, code: string): Promise<{ sent: boolean; devCode?: string; provider?: string; mailError?: MailError }> {
  const subject = '[SEASTAR 360° 뷰어] 이메일 인증코드'
  const text = `SEASTAR 360° 위치 뷰어 가입 인증코드: ${code}\n\n이 코드는 발급 후 1시간 동안만 유효합니다. 본인이 요청하지 않았다면 무시하세요.`
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
    <h2 style="color:#0b3a5b">SEASTAR 360° 위치 뷰어</h2>
    <p>아래 인증코드를 입력해 회원가입을 완료하세요.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f1f5f9;padding:16px 24px;border-radius:12px;text-align:center;color:#0b3a5b">${code}</div>
    <p style="color:#64748b;font-size:13px">이 코드는 발급 후 <strong>1시간</strong> 동안만 유효합니다. 본인이 요청하지 않았다면 무시하세요.</p>
  </div>`
  const r = await postMail(c, { to: email, subject, html, text })
  if (r === null) return { sent: false, devCode: code }   // 키 미설정 — 의도된 개발/시연 모드(종전 동작)
  if (r.sent) return { sent: true, provider: r.provider }
  console.error('[signup mail] send failed', r.error.status, r.error.summary)
  // 🔴 키가 설정됐는데 실패 = 실제 장애. dev_code 를 주지 않는다(가짜 성공·코드 노출 백도어 금지).
  return { sent: false, mailError: r.error }
}

/** [WO 20261001-viewerhelp] HTML 이스케이프 — 사용자 입력을 메일 HTML 본문에 넣기 전 반드시 통과. */
function escapeHtmlServer(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** [WO 20261001-viewerhelp] 개발자 문의 메일 발송. sendVerificationEmail 과 같은 Resend/SendGrid
 *  경로(fromEmail·키)를 재사용한다 — 발송 로직을 두 곳에 따로 두면 반드시 갈라진다(SoT). */
async function sendInquiryEmail(c: any, row: {
  title: string; body: string; replyEmail?: string | null; senderEmail?: string | null;
  projectName?: string | null; deploymentId?: string | null; mode?: string | null;
  userAgent?: string | null; appVersion?: string | null
}): Promise<{ sent: boolean; provider?: string; mailError?: MailError }> {
  const subject = '[SEASTAR 360° 뷰어] 개발자 문의: ' + row.title.slice(0, 80)
  const esc = escapeHtmlServer
  const text = `개발자 문의\n제목: ${row.title}\n내용:\n${row.body}\n\n회신 이메일: ${row.replyEmail || '(미입력)'}\n보낸 계정: ${row.senderEmail || '(비로그인)'}\n프로젝트: ${row.projectName || '-'}\n배포본: ${row.deploymentId || '-'}\n모드: ${row.mode || '-'}\n브라우저: ${row.userAgent || '-'}\n앱 버전: ${row.appVersion || '-'}`
  const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
    <h2 style="color:#0b3a5b">SEASTAR 360° 개발자 문의</h2>
    <p><strong>제목</strong>: ${esc(row.title)}</p>
    <p style="white-space:pre-wrap;background:#f1f5f9;padding:12px 16px;border-radius:8px">${esc(row.body)}</p>
    <table style="font-size:13px;color:#334155;border-collapse:collapse">
      <tr><td style="padding:2px 8px 2px 0">회신 이메일</td><td>${esc(row.replyEmail || '(미입력)')}</td></tr>
      <tr><td style="padding:2px 8px 2px 0">보낸 계정</td><td>${esc(row.senderEmail || '(비로그인)')}</td></tr>
      <tr><td style="padding:2px 8px 2px 0">프로젝트</td><td>${esc(row.projectName || '-')}</td></tr>
      <tr><td style="padding:2px 8px 2px 0">배포본</td><td>${esc(row.deploymentId || '-')}</td></tr>
      <tr><td style="padding:2px 8px 2px 0">모드</td><td>${esc(row.mode || '-')}</td></tr>
      <tr><td style="padding:2px 8px 2px 0">브라우저</td><td>${esc(row.userAgent || '-')}</td></tr>
      <tr><td style="padding:2px 8px 2px 0">앱 버전</td><td>${esc(row.appVersion || '-')}</td></tr>
    </table>
  </div>`
  const r = await postMail(c, { to: SUPPORT_CONTACT_EMAIL, subject, html, text })
  if (r === null) {
    console.error('[inquiry mail] no mail provider configured (RESEND_API_KEY/SENDGRID_API_KEY)')
    return { sent: false, mailError: { status: null, summary: 'no mail provider configured', keyRevoked: false } }
  }
  if (r.sent) return { sent: true, provider: r.provider }
  console.error('[inquiry mail] send failed', r.error.status, r.error.summary)
  return { sent: false, mailError: r.error }
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
    return { email: String(u.email).toLowerCase(), name: u.name || '', picture: '', _local: true, must_change: Number(u.must_change_password || 0) === 1,
      _emailVerified: Number(u.email_verified || 0) === 1 }   // [WO 20261001-invite] 대기 초대 자동 편입 자격
  } catch { return null }
}

/** Authorization: Bearer <idToken> 에서 검증된 사용자 반환 (없으면 null) */
async function getUser(c: any): Promise<any | null> {
  // [P48] 요청당 1회 메모 — readOnlyGuard 와 라우트 핸들러가 둘 다 호출하므로
  //   메모가 없으면 모든 쓰기 요청에서 D1 조회/HMAC 검증이 2배로 돈다.
  const memo = c.get('__user')
  if (memo !== undefined) return memo
  const u = await resolveUser(c)
  c.set('__user', u)
  return u
}
async function resolveUser(c: any): Promise<any | null> {
  const auth = c.req.header('Authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  // ponytail: <img>/텍스처는 Authorization 헤더를 못 보내므로 ?t= 쿼리토큰 폴백 허용(R2 객체용).
  //   같은 자격증명이라 권한 동일. 한계: 토큰이 URL/로그에 남음 → 로컬세션 토큰 만료·취소로 상쇄.
  const token = m ? m[1] : (c.req.query('t') || '')
  if (!token) return null
  // 데모 토큰 우선 처리 (구글 로그인 없이 바로 진입/테스트)
  const demo = demoUserFromToken(c, token)
  if (demo) return demo
  // [P48] 서버 서명 자동입장 토큰(ae1.*) — kind 에 따라 편집 가능/열람 전용이 갈린다
  if (token.startsWith(AUTO_ENTRY_PREFIX)) return await autoEntryFromToken(c, token)
  // 로그인 없는 디자이너 자동입장 **레거시 고정 문자열** (P48 이후 열람 전용)
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
  return { email: String(payload.email).toLowerCase(), name: payload.name || payload.display_name || '', picture: payload.picture || '',
    _emailVerified: payload.email_verified === true }   // [WO 20261001-invite] Google/Firebase 가 인증한 이메일만 자동 편입
}

/* ══ [P48] 🔴 쓰기 차단 단일 지점(chokepoint) ═══════════════════════════════
 * 열람 전용 주체(`?d=` 배포 링크 세션 · 레거시 고정 문자열 토큰)의 모든 변경 요청을 거부한다.
 * 라우트마다 가드를 다는 대신 미들웨어 한 곳에서 끊는 이유(§G-2-5):
 *   쓰기 라우트가 51개이고 앞으로 더 늘어난다 — 한 군데라도 빠지면 그 구멍으로 전부 뚫린다.
 *   allowlist 방식이라 **새로 추가되는 쓰기 라우트는 자동으로 보호**된다.
 * 열람(GET/HEAD/OPTIONS)은 건드리지 않는다 → 링크 수령자의 도면·핀·파노라마 열람은 종전대로. */
app.use('*', async (c, next) => {
  if (!MUTATING_METHODS.includes(c.req.method.toUpperCase())) return next()
  const p = c.req.path
  if (READONLY_ALLOWED_WRITE_PREFIXES.some((x) => p === x || p.startsWith(x))) return next()
  const user = await getUser(c)
  if (user && user._readonly) {
    return c.json({ error: 'forbidden — read-only session (view link)', readonly: true }, 403)
  }
  return next()
})

/* ══ [P63] 🔴 열람 차단 단일 지점 — 초대코드 게이트 ═══════════════════════════
 * 마스터 요구: "코드 통과 전에는 도면 데이터를 내려보내지 마라 — UI 만 가리는 건 무의미."
 * 그래서 UI 가 아니라 **서버 미들웨어**에서 끊는다(p48 의 readOnlyGuard 와 같은 구조).
 *
 * 적용 대상(좁게): isShareGateSubject — 공유/배포 링크 세션과 데모 뷰어뿐이다.
 *   실계정(로컬 세션/구글 로그인)·설계자 자동입장은 대상이 아니다 — 그들은 이미 신원이 있다.
 *
 * 🔴 `?d=` 에도 적용한다: 적용하지 않으면 `?d=<배포ID>` 가 게이트 우회로가 되어
 *   같은 도면을 코드 없이 보게 되므로 게이트 자체가 무의미해진다.
 *   하위호환은 유지된다 — 링크가 죽는 게 아니라 **코드 입력 화면이 먼저 뜬다**.
 *
 * 🔴 "코드가 하나도 없는 프로젝트"는 게이트를 켜지 않는다(opt-in by issuance).
 *   근거: 마이그레이션 직후 기존 공유 링크가 전부 막히면 현장이 즉시 멈춘다. 오늘 상태(게이트 0)
 *   대비 회귀가 아니며, 마스터가 코드를 1개 발급하는 순간 그 프로젝트만 즉시 잠긴다.
 *
 * 🔴 정직 보고(남은 구멍): 이 게이트는 익명이 `/api/auth/auto-entry` 에 kind='designer' 를
 *   그냥 요청하는 기존 우회로(위 P48 주석)보다 강할 수 없다.
 *   **CF 시크릿 AUTO_ENTRY_DESIGNER_KEY 를 설정하는 순간** 그 우회가 막히고 게이트가 실효를 갖는다.
 *   코드 변경 없이 설정 하나로 닫힌다 — 배포 시 반드시 설정할 것.
 *
 * 게이트 대상 = **프로젝트를 특정할 수 있는** 읽기 경로만.
 * 🔴 정직 보고(범위 밖): `/tables/pano_images` 목록은 project_id 컬럼이 없어 프로젝트로 매핑할 수
 *   없다(스키마 변경 필요). 이번 작업으로 나빠지지 않았고(종전에도 동일하게 열려 있었다),
 *   실사용 경로에서는 pano id 가 게이트된 배포본 JSON 안에서만 나오므로 전이적으로 보호된다.
 *   완전 차단은 pano_images 에 project_id 를 추가하는 별도 작업이 필요하다(후속 권고). */
const GATED_READ_PREFIXES = ['/tables/deployments', '/api/notes', '/api/projects/']
app.use('*', async (c, next) => {
  const m = c.req.method.toUpperCase()
  if (m !== 'GET' && m !== 'HEAD') return next()          // 쓰기는 readOnlyGuard 가 이미 끊었다
  const p = c.req.path
  if (!GATED_READ_PREFIXES.some((x) => p.startsWith(x))) return next()
  const user = await getUser(c)
  if (!isShareGateSubject(user)) return next()
  // 🔴 한 배포본을 여러 프로젝트의 decks 가 참조할 수 있다(실측함).
  //   LIMIT 1 로 하나만 골라 판정하면 **게이트가 꺼진 쪽이 뽑히면 그대로 뚫린다**(fail-open).
  //   따라서 참조하는 프로젝트를 전부 보고, **하나라도 잠겨 있으면 잠근다**(fail-closed).
  const pids = await gatedProjectIdsOf(c, p)
  const lockedPid = await shareGateLockedPid(c, user, pids)
  if (!lockedPid) return next()                          // 특정 불가 · 통과 세션 · 코드 미발급 = 원래 라우트 판단에 맡긴다
  return c.json({
    error: 'gate required — invite code',
    gate_required: true,
    project_id: lockedPid,
    contact: SUPPORT_CONTACT_EMAIL,
    message: '초대코드가 필요합니다. ' + SUPPORT_CONTACT_EMAIL + ' 으로 링크를 다시 요청하세요.',
  }, 403)
})

/* [P48] 자동입장 토큰 발급 — 서버 서명본. 고정 문자열 상수를 대체한다.
 *  kind='viewer'  : 누구나(배포 링크 수령자 포함) — 열람 전용
 *  kind='designer': AUTO_DESIGNER_TOKEN_ENABLED 이고, AUTO_ENTRY_DESIGNER_KEY 가 설정돼 있으면
 *                   헤더 X-Auto-Entry-Key 가 일치할 때만. (미설정 = 현행 유지 = 익명 허용) */
app.post('/api/auth/auto-entry', async (c) => {
  let body: any = {}
  try { body = await c.req.json() } catch {}
  let kind: 'designer' | 'viewer' = body && body.kind === 'designer' ? 'designer' : 'viewer'
  if (kind === 'designer') {
    if (!AUTO_DESIGNER_TOKEN_ENABLED) kind = 'viewer'
    const need = c.env && (c.env as any).AUTO_ENTRY_DESIGNER_KEY
    if (typeof need === 'string' && need.length > 0 && c.req.header('X-Auto-Entry-Key') !== need) kind = 'viewer'
  }
  const minted = await mintAutoEntryToken(c, kind)
  if (!minted) return c.json({ error: 'auto entry unavailable' }, 503)
  return c.json({ token: minted.token, kind, exp: minted.exp, readonly: kind !== 'designer' })
})

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
  // [WO 20261001-invite · 마스터 확정 ②] 로그인(구글 첫 로그인 포함) 시 그 이메일 앞 대기 초대를 자동 편입.
  //   🔴 이메일 인증된 실계정만(_emailVerified) — 데모/공용석/미인증 계정은 편입 금지. 편입 후 역할 판정이 바뀌므로 먼저 수행.
  if (!user._demo && !user._auto && user._emailVerified) await claimPendingInvites(c, user.email)
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
  // [P48] readonly=true 면 서버가 모든 쓰기를 거부한다 — 클라가 UI 를 정직하게 열람 전용으로 표시하도록 동봉.
  return c.json({ authenticated: true, email: user.email, name: user.name, picture: user.picture, role, demo: !!user._demo, local: !!user._local, auto: !!user._auto, readonly: !!user._readonly, request_status, super_admin: superAdmin(c) })
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
  await logActivity(c, 'signup.code_sent', { actor: { email }, targetType: 'signup', targetId: email,
    detail: { provider: mail.provider || (mail.mailError ? 'failed' : 'dev-fallback'), invited: !!chk.invited,
      mailErrorStatus: mail.mailError ? mail.mailError.status : null, keyRevoked: mail.mailError ? mail.mailError.keyRevoked : false } })
  const resp: any = { success: true, sent: mail.sent, email, invited: !!chk.invited, expires_at: expires, valid_minutes: 60 }
  if (chk.invited) {
    const inv = await findInvite(c, email)
    if (inv) { resp.invite_company = inv.company || ''; resp.invite_role = inv.role || 'viewer' }
  }
  if (!mail.sent && mail.devCode) {
    // 메일 발송 미설정/실패 시: 시연/개발용으로 코드 직접 반환
    resp.dev_code = mail.devCode
    resp.dev_note = '메일 발송이 설정되지 않아 인증코드를 직접 반환합니다(개발/시연용). RESEND_API_KEY 또는 SENDGRID_API_KEY 시크릿을 설정하면 실제 메일이 발송됩니다.'
  } else if (!mail.sent && mail.mailError) {
    // [WO 20261002-gap R6] 🔴 키는 설정됐지만 실제 발송이 실패 — 가짜 성공 금지. 코드는 주지 않고 정확히 안내한다.
    resp.success = false
    resp.error = mail.mailError.keyRevoked
      ? '메일 발송 실패(관리자 확인 필요) — 메일 키 확인 필요'
      : '메일 발송 실패(관리자 확인 필요). 잠시 후 다시 시도하거나 관리자에게 문의하세요.'
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

  // [WO 20261001-invite · 마스터 확정 ②] 메일 인증코드 검증을 통과한 이 시점 = 이메일 소유 증명 → 대기 프로젝트 초대 자동 편입
  const claimed = await claimPendingInvites(c, email)

  // 자동 로그인: 세션 토큰 발급
  const token = randToken('local-')
  const exp = now + LOCAL_SESSION_TTL_MS // 30일 (SoT: LOCAL_SESSION_TTL_MS)
  await c.env.DB.prepare('INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
    .bind(token, email, now, exp).run()
  await c.env.DB.prepare('UPDATE local_users SET last_login_at = ? WHERE email = ?').bind(now, email).run().catch(() => {})

  let grantedRole = (invite && invite.role) ? invite.role : 'viewer'
  if (isDesignerDomain(c, email)) grantedRole = 'designer'
  await logActivity(c, 'signup.completed', { actor: { email }, targetType: 'local_user', targetId: email, detail: { domain: emailDomain(email), invited: !!invite, company, department, role: grantedRole } })
  return c.json({ success: true, token, email, name: name || email.split('@')[0], company, department, role: grantedRole, invited: !!invite, projects_joined: claimed })
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
  const exp = now + LOCAL_SESSION_TTL_MS
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

/* ══ [WO 20261001-bulkreauth] 본인 재인증 → 단기 토큰(rx1.*, REAUTH_TTL_MS) ═══════════════════
 * 핀 일괄삭제 직전 "지금 이 사람이 계정 주인인가" 를 다시 확인한다. 🔴 앱은 구글 비밀번호를 받지 않는다.
 *  · Google(Firebase) 계정: 클라이언트가 구글 공식 창(reauthenticateWithPopup/Redirect)으로 재인증한 뒤
 *    받은 **새 Firebase ID 토큰**을 보낸다 → 서명·프로젝트 검증(verifyFirebaseToken) + 이메일 일치 + auth_time 신선도.
 *  · 회사 이메일(local-) 계정: 앱 비밀번호 → 로그인과 같은 verifyPassword(local_users).
 * 성공 시 서명 토큰을 발급한다. 서명키 = 자동입장과 같은 autoEntrySecret(SoT), 도메인 분리 위해 'rx1.' 접두를 함께 서명.
 * 이 토큰은 Authorization 으로 쓸 수 없다(resolveUser 가 rx1 접두를 모른다) — X-Reauth 헤더 전용. */
const REAUTH_PREFIX = 'rx1.'
async function mintReauthToken(c: any, email: string): Promise<{ token: string, exp: number } | null> {
  const secret = await autoEntrySecret(c)
  if (!secret) return null
  const exp = Date.now() + REAUTH_TTL_MS
  const payload = b64u(JSON.stringify({ e: String(email).toLowerCase(), exp, n: randToken('') }))
  return { token: REAUTH_PREFIX + payload + '.' + (await hmacB64u(secret, REAUTH_PREFIX + payload)), exp }
}
/** X-Reauth 값이 이 사용자에게 발급된 유효(미만료) 재인증 토큰인가 */
async function reauthTokenValid(c: any, token: string, email: string): Promise<boolean> {
  if (typeof token !== 'string' || !token.startsWith(REAUTH_PREFIX)) return false
  const rest = token.slice(REAUTH_PREFIX.length)
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return false
  const payload = rest.slice(0, dot), sig = rest.slice(dot + 1)
  const secret = await autoEntrySecret(c)
  if (!secret) return false
  if (!safeEqualStr(await hmacB64u(secret, REAUTH_PREFIX + payload), sig)) return false
  let p: any
  try { p = JSON.parse(b64uDec(payload)) } catch { return false }
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return false
  return !!email && p.e === String(email).toLowerCase()
}
app.post('/api/auth/reauth', async (c) => {
  const user = await getUser(c)
  // 실계정만 — 열람 링크·공용석·데모는 "본인" 이 없다
  if (!user || user._readonly || user._auto || user._demo) return c.json({ error: 'reauth unavailable for this session' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = String(user.email || '').toLowerCase()
  if (user._local) {
    const password = String((body && body.password) || '')
    if (!password) return c.json({ error: '비밀번호를 입력해 주세요.' }, 400)
    const u: any = await c.env.DB.prepare('SELECT pw_hash, pw_salt FROM local_users WHERE email = ? AND deleted = 0').bind(email).first().catch(() => null)
    if (!u || !(await verifyPassword(password, u.pw_salt, u.pw_hash))) {
      await logActivity(c, 'auth.reauth_fail', { actor: { email }, targetType: 'local_user', targetId: email })
      return c.json({ error: '비밀번호가 올바르지 않습니다.' }, 401)
    }
  } else {
    const idToken = String((body && body.id_token) || '')
    const payload = idToken ? await verifyFirebaseToken(idToken, (c.env && c.env.FIREBASE_PROJECT_ID) || undefined) : null
    if (!payload || String(payload.email || '').toLowerCase() !== email) {
      await logActivity(c, 'auth.reauth_fail', { actor: { email }, targetType: 'auth', targetId: email })
      return c.json({ error: '구글 재인증 확인에 실패했습니다.' }, 401)
    }
    if (!reauthFresh(payload.auth_time, Date.now())) return c.json({ error: '구글 재인증이 오래되었습니다 — 다시 시도해 주세요.', stale: true }, 401)
  }
  const rx = await mintReauthToken(c, email)
  if (!rx) return c.json({ error: 'reauth signing unavailable' }, 503)
  await logActivity(c, 'auth.reauth', { actor: user, targetType: 'auth', targetId: email, detail: { local: !!user._local } })
  return c.json({ ok: true, token: rx.token, exp: rx.exp })
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
    // [P63] 🔴 IP 가 없으면 문자열 '' 가 아니라 null 로 남긴다 — "기록했는데 빈 값"과
    //   "모른다"는 다른 사실이다(로컬·프록시 미경유 시 실제로 빈 값이 들어가는 것을 라이브에서 확인했다).
    //   운영(CF)에서는 CF-Connecting-IP 가 항상 붙는다. 없는 값을 지어내지 않는다.
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null
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
   inquiries — 개발자 문의 (뷰어 배포/편집 화면 공용, 로그인 불필요)
   [WO 20261001-viewerhelp] 마스터: "뷰어로 배포된 모드에서도 도움말 기능 구현하고
   개발자 문의 노트도 추가해 designsir@seastargo.com" — 수신 주소는 SUPPORT_CONTACT_EMAIL(SoT) 하나.
════════════════════════════════════════════ */
/** 🔴 레이트리밋 공용 헬퍼(단일 지점) — 개발자 문의(/api/inquiries)와 열람자 요청(/api/notes)이 함께 쓴다.
 *  키 = IP. CF 운영환경은 CF-Connecting-IP 가 항상 붙는다. 헤더가 없는 로컬환경에서는 'anon' 버킷 하나를 공유한다. */
function rateLimitKey(c: any): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'anon'
}
/** 테이블별 최근 창(INQUIRY_RATE_WINDOW_MS = 1분) 건수 조회 SQL — 테이블명은 이 목록 밖에서 들어올 수 없다(SQL 주입 차단).
 *  pin_notes 는 삭제분도 센다(지우고 다시 써서 한도를 우회하지 못하게). 디자이너 행은 ip 를 남기지 않아 집계에서 빠진다. */
const RATE_LIMIT_SQL = {
  inquiries: 'SELECT COUNT(*) AS n FROM inquiries WHERE ip = ? AND created_at > ? AND deleted = 0',
  pin_notes: 'SELECT COUNT(*) AS n FROM pin_notes WHERE ip = ? AND created_at > ?',
} as const
async function overRateLimit(c: any, table: keyof typeof RATE_LIMIT_SQL, key: string, limitPerWindow: number): Promise<boolean> {
  try {
    const cnt: any = await c.env.DB.prepare(RATE_LIMIT_SQL[table]).bind(key, Date.now() - INQUIRY_RATE_WINDOW_MS).first()
    return (cnt?.n || 0) >= limitPerWindow
  } catch (e) { return false }   // 조회 실패(마이그레이션 전 등) — 저장 단계에서 실패가 정직하게 드러난다
}

app.post('/api/inquiries', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const title = String(body?.title || '').trim()
  const content = String(body?.body || '').trim()
  if (!title || !content) return c.json({ error: '제목과 내용을 입력하세요.' }, 400)
  if (title.length > INQUIRY_TITLE_MAX) return c.json({ error: `제목은 ${INQUIRY_TITLE_MAX}자 이내로 입력하세요.` }, 400)
  if (content.length > INQUIRY_BODY_MAX) return c.json({ error: `내용은 ${INQUIRY_BODY_MAX}자 이내로 입력하세요.` }, 400)
  const replyEmailRaw = body?.reply_email ? String(body.reply_email).trim() : ''
  if (replyEmailRaw && !isValidEmail(replyEmailRaw)) return c.json({ error: '회신 이메일 형식이 올바르지 않습니다.' }, 400)

  // 🔴 남용 방지: IP(또는 세션)당 분당 N건. CF 운영환경은 CF-Connecting-IP 가 항상 붙는다.
  //   헤더가 없는 로컬환경에서는 'anon' 버킷 하나를 공유한다(개발용 — 운영 경로엔 영향 없음).
  const limiterKey = rateLimitKey(c)
  const now = Date.now()
  if (await overRateLimit(c, 'inquiries', limiterKey, INQUIRY_RATE_LIMIT_PER_MIN)) {
    return c.json({ error: '문의가 너무 자주 접수되었습니다. 잠시 후 다시 시도해 주세요.' }, 429)
  }

  const user = await getUser(c).catch(() => null)
  const id = randToken('inq-')
  const ctx = (body && typeof body.context === 'object' && body.context) ? body.context : {}
  const row = {
    title, body: content,
    replyEmail: replyEmailRaw || null,
    // 🔴 열람전용(_readonly) 세션은 실사용자가 아니라 공유 통행증이다 — 보낸 계정으로 기록하지 않는다.
    senderEmail: (user && !user._readonly && user.email) ? user.email : null,
    projectName: ctx.project_name ? String(ctx.project_name).slice(0, 200) : null,
    deploymentId: ctx.deployment_id ? String(ctx.deployment_id).slice(0, 120) : null,
    mode: ctx.mode ? String(ctx.mode).slice(0, 40) : null,
    userAgent: (c.req.header('User-Agent') || '').slice(0, 300),
    appVersion: ctx.app_version ? String(ctx.app_version).slice(0, 80) : null
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO inquiries (id, created_at, title, body, reply_email, sender_email, project_name, deployment_id, mode, user_agent, app_version, ip, mail_sent, resolved, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`
    ).bind(id, now, row.title, row.body, row.replyEmail, row.senderEmail, row.projectName, row.deploymentId, row.mode, row.userAgent, row.appVersion, limiterKey).run()
  } catch (e) {
    // 🔴 저장까지 실패하면 조용히 숨기지 않고 실패를 알린다(조용한 실패 금지).
    return c.json({ error: '문의 저장에 실패했습니다. 잠시 후 다시 시도하거나 이메일로 직접 보내주세요: ' + SUPPORT_CONTACT_EMAIL }, 500)
  }

  const mail = await sendInquiryEmail(c, row)
  if (mail.sent) {
    try { await c.env.DB.prepare('UPDATE inquiries SET mail_sent = 1, mail_error = NULL WHERE id = ?').bind(id).run() } catch {}
  } else {
    // [WO 20261002-gap 묶음D] 🔴 실패 사유를 버리지 않는다 — 상태코드+요약을 저장(키 값 제외) + 서버 로그.
    console.error('[inquiry] mail send failed, saved only. id=' + id, mail.mailError)
    const errText = mail.mailError ? JSON.stringify(mail.mailError).slice(0, 500) : null
    try { await c.env.DB.prepare('UPDATE inquiries SET mail_error = ? WHERE id = ?').bind(errText, id).run() } catch {}
  }
  await logActivity(c, 'inquiry.create', { actor: user, targetType: 'inquiry', targetId: id, detail: { mail_sent: mail.sent, mail_error_status: mail.mailError ? mail.mailError.status : null } })
  // 🔴 저장이 됐으면(여기 도달) 메일 발송 성공 여부와 무관하게 사용자에게는 "접수됨"으로 응답한다.
  return c.json({ success: true, id, mail_sent: mail.sent })
})

/** [WO 20261002-gap 묶음D·2] 관리자 — 발송 실패한 문의 메일 재발송. 성공 시 mail_error 를 비운다. */
app.post('/api/inquiries/:id/resend', async (c) => {
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  const row: any = await c.env.DB.prepare('SELECT * FROM inquiries WHERE id = ? AND deleted = 0').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  const mail = await sendInquiryEmail(c, {
    title: row.title, body: row.body, replyEmail: row.reply_email, senderEmail: row.sender_email,
    projectName: row.project_name, deploymentId: row.deployment_id, mode: row.mode,
    userAgent: row.user_agent, appVersion: row.app_version,
  })
  if (mail.sent) {
    await c.env.DB.prepare('UPDATE inquiries SET mail_sent = 1, mail_error = NULL WHERE id = ?').bind(id).run()
  } else {
    const errText = mail.mailError ? JSON.stringify(mail.mailError).slice(0, 500) : null
    await c.env.DB.prepare('UPDATE inquiries SET mail_error = ? WHERE id = ?').bind(errText, id).run()
  }
  await logActivity(c, 'inquiry.resend', { actor: su, targetType: 'inquiry', targetId: id, detail: { mail_sent: mail.sent } })
  return c.json({ success: true, mail_sent: mail.sent, mail_error: mail.mailError || null })
})

// 문의 목록(관리자 전용) — 간단 목록
app.get('/api/inquiries', async (c) => {
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 500)
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM inquiries WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all()
    return c.json({ data: results || [] })
  } catch (e) {
    return c.json({ data: [], note: 'inquiries not ready' })
  }
})

// 문의 처리 완료 체크(관리자 전용)
app.patch('/api/inquiries/:id', async (c) => {
  const su = await requireAdmin(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { body = {} }
  const resolved = body?.resolved ? 1 : 0
  await c.env.DB.prepare('UPDATE inquiries SET resolved = ?, resolved_at = ? WHERE id = ?')
    .bind(resolved, resolved ? Date.now() : null, id).run()
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

/** [P61] 프로젝트 행 → 공유 경로(`/srview/<이름>-<토큰>`). 토큰 없으면 null(=아직 배포 전/구 프로젝트).
 *  🔴 slug 는 여기서 **매번 name 에서 파생**한다 — DB 에 저장하지 않으므로 이름 변경과 절대 갈라지지 않는다. */
function sharePathOf(r: any): string | null {
  return (r && r.share_token) ? sharePath(r.name, String(r.share_token)) : null
}

function mapProject(r: any) {
  return { id: r.id, name: r.name, description: r.description, owner: r.owner, created_at: r.created_at, updated_at: r.updated_at,
    published: !!r.published, published_at: r.published_at || null, published_by: r.published_by || null,
    subdomain: r.subdomain || null,
    // [P61] 공유 주소. 토큰이 곧 열쇠이므로 노출 범위는 호출부에서 멤버로 제한한다(/api/projects 참조).
    share_token: r.share_token || null, share_path: sharePathOf(r),
    // [WO 20260930-WP3 · C3] 프로젝트 원본(처음 등록한 전체 도면) 배포본. NULL = 미기록(레거시 → 클라 폴백 규칙)
    original_deployment_id: r.original_deployment_id || null,
    // [WO 20261001-projectinfo] 프로젝트 정보(메모+일정) — 저장 안 됐으면 빈 기본값(지어내지 않음, 결측과 빈값 구분 불필요: UI 는 둘 다 "없음"으로 취급).
    info_json: parseProjectInfo(r.info_json) }
}
/** [WO 20261001-projectinfo] 🔴 SoT — projects.info_json(TEXT) 파싱. 깨진/구버전 값은 조용히 삼키지 않고
 *  빈 기본값으로 안전 폴백(파싱 실패로 500 나던 사고 방지). PATCH 핸들러와 이 함수가 유일한 지점. */
function parseProjectInfo(raw: any): { note: string, schedule: any[], updatedAt: number | null, updatedBy: string | null } {
  if (!raw) return { note: '', schedule: [], updatedAt: null, updatedBy: null }
  try {
    const o = JSON.parse(raw)
    return {
      note: typeof o.note === 'string' ? o.note : '',
      schedule: Array.isArray(o.schedule) ? o.schedule : [],
      updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : null,
      updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy : null,
    }
  } catch { return { note: '', schedule: [], updatedAt: null, updatedBy: null } }
}
/** [P61] 비멤버 응답에서 공유 열쇠를 제거한다 — "남의 프로젝트 주소를 유추/열거 불가" 요구의 강제점.
 *  (뷰어는 배포된 프로젝트를 잠금 카드로 "보긴" 하지만, 그 주소를 손에 넣어선 안 된다) */
function stripShareKey<T extends Record<string, any>>(o: T): T {
  return { ...o, share_token: null, share_path: null }
}
/** [WO 20260929-parent-guard] 🔴 신뢰 경계 — parent_id 는 클라이언트가 보낸 값을 그대로 믿지 않는다.
 *  같은 project_id 이고 deleted=0 인 살아있는 deck 인지 DB 로 확인한다. 아니면 false(400 유도).
 *  조용히 null 로 바꾸지 않는다(§10 조용한 실패 금지) — 호출부가 명시적으로 400 을 반환한다.
 *  POST(/api/projects/:id/decks)·PUT(/api/decks/:id) 가 공유하는 단일 지점(SoT). */
async function isLiveDeckInProject(db: any, parentId: string, projectId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM decks WHERE id = ? AND project_id = ? AND deleted = 0').bind(parentId, projectId).first()
  return !!row
}
/** [WO 20260930-fixmode] 🔴 decks.mode 신뢰 경계 — 'checker' | '360' 만 허용. 미전송(undefined)은 "지정 안 함".
 *  그 외(null·빈 문자열·오타 등)는 { error } → 호출부가 400. 조용히 NULL 로 바꾸지 않는다(§10 조용한 실패 금지).
 *  POST(/api/projects/:id/decks)·PUT(/api/decks/:id) 가 공유하는 단일 지점(SoT). */
const DECK_MODES = ['checker', '360'] as const
function parseDeckMode(v: any): { mode?: string; error?: string } {
  if (v === undefined) return {}
  if (typeof v === 'string' && (DECK_MODES as readonly string[]).includes(v)) return { mode: v }
  return { error: "mode must be 'checker' or '360'" }
}
/** 영역(parent_id 있음)의 mode = 부모 구역 mode 상속. 부모가 태그돼 있는데 다른 값을 보내면 400. */
async function resolveDeckMode(db: any, parentId: string | null, sent: string | undefined, fallback: string | null): Promise<{ mode: string | null; error?: string }> {
  if (parentId) {
    const pr: any = await db.prepare('SELECT mode FROM decks WHERE id = ?').bind(parentId).first()
    const pm = pr && pr.mode ? String(pr.mode) : null
    if (pm) {
      if (sent !== undefined && sent !== pm) return { mode: null, error: 'mode must match parent deck mode' }
      return { mode: pm }
    }
  }
  return { mode: sent !== undefined ? sent : fallback }
}
/** [WO 20260930-merge] 🔴 decks.src_dep_id/src_page/src_crop 신뢰 경계 — 벡터 복사 구역의 "원본 상자" 기록(0031).
 *  셋은 한 묶음이다: 전부 미전송(undefined) = "지정 안 함", 전부 null = 지움, 그 외(일부만·형식 오류)는 { error } → 400.
 *  src_crop 은 페이지 % 상자 {x,y,w,h}(유한수, w·h > 0). 조용히 NULL 로 바꾸지 않는다(§10 조용한 실패 금지).
 *  POST(/api/projects/:id/decks)·PUT(/api/decks/:id) 가 공유하는 단일 지점(SoT). */
function parseDeckSrcBox(body: any): { set?: { dep: string | null; page: number | null; crop: string | null }; error?: string } {
  const keys = ['src_dep_id', 'src_page', 'src_crop']
  const sent = keys.filter((k) => body && body[k] !== undefined)
  if (!sent.length) return {}
  if (sent.length !== keys.length) return { error: 'src_dep_id, src_page, src_crop must be sent together' }
  if (body.src_dep_id === null && body.src_page === null && body.src_crop === null) return { set: { dep: null, page: null, crop: null } }
  const dep = typeof body.src_dep_id === 'string' ? body.src_dep_id.trim() : ''
  const page = Number(body.src_page)
  const c = body.src_crop
  const fin = (v: any) => typeof v === 'number' && Number.isFinite(v)
  if (!dep) return { error: 'src_dep_id must be a non-empty string' }
  if (!Number.isInteger(page) || page < 1) return { error: 'src_page must be a positive integer' }
  if (!c || !fin(c.x) || !fin(c.y) || !fin(c.w) || !fin(c.h) || !(c.w > 0) || !(c.h > 0)) return { error: 'src_crop must be {x,y,w,h} with w,h > 0' }
  return { set: { dep, page, crop: JSON.stringify({ x: c.x, y: c.y, w: c.w, h: c.h }) } }
}
function mapDeck(r: any) {
  // [WO 20260916] 구역=도면의 한 조각(page+crop). NULL(구버전)이면 그대로 null → 페이지 전체 취급.
  let crop: any = null
  if (r.crop) { try { crop = JSON.parse(r.crop) } catch { crop = null } }
  // [WO 20260921] parent_id — NULL = 최상위 구역(도면 바로 아래), 값 있으면 그 구역 안의 영역.
  //   마이그레이션 0025 적용 전 행(컬럼 부재)은 undefined → null 로 정규화(구버전과 동일 취급).
  const out: any = { id: r.id, project_id: r.project_id, name: r.name, level_no: r.level_no, deployment_id: r.deployment_id, page: r.page ?? null, crop, parent_id: r.parent_id ?? null, mode: r.mode ?? null, created_at: r.created_at, updated_at: r.updated_at }
  // [WO 20260930-merge] 원본 상자(0031) — 적용 전 행(컬럼 부재)·레거시는 null(좌표 변환 불가를 클라가 정직하게 표시).
  let srcCrop: any = null
  if (r.src_crop) { try { srcCrop = JSON.parse(r.src_crop) } catch { srcCrop = null } }
  out.src_dep_id = r.src_dep_id ?? null
  out.src_page = r.src_page ?? null
  out.src_crop = srcCrop
  // [WO 20260921] 도면(deployment) 이름 — 트리의 '도면' 단이 파일명을 보여줘야 한다.
  //   🔴 필드 '추가'만 한다(기존 필드 제거·개명 없음 → 기존 호출부 무해).
  //   JOIN 하지 않은 경로(POST/PUT 응답)에서는 키 자체를 넣지 않는다 — 없는 값을 날조하지 않는다.
  if (r.deployment_title !== undefined) out.deployment_title = r.deployment_title ?? null
  if (r.deployment_file_name !== undefined) out.deployment_file_name = r.deployment_file_name ?? null
  return out
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
    const isOwner = isProjectOwner(p.owner, email)
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

/** [WO 20261001-invite] 프로젝트 소유자 판정의 단일 지점(§G-2-5).
 *  🔴 공용석 예약계정(AUTO_DESIGNER_EMAIL)은 **누구의 소유자도 아니다** — 열람 전용 서명 토큰(공유 링크 방문자)도
 *  같은 이메일을 쓰므로, 이 예외가 없으면 익명 방문자가 공용석이 만든 프로젝트(sunbo 등)의 '소유자'로 둔갑한다.
 *  공용석 소유 프로젝트는 super 관리자가 관리한다(isSuperAdmin 우회). */
function isProjectOwner(owner: any, email: any): boolean {
  const e = String(email || '').trim().toLowerCase()
  if (!e || e === AUTO_DESIGNER_EMAIL) return false
  return String(owner || '').trim().toLowerCase() === e
}

/** [WO 20261001-invite · 마스터 확정 ③] 멤버 초대·제거·역할 변경(접근신청 승인·권한 매트릭스 포함) 권한 —
 *  **프로젝트 소유자와 super 관리자만**. designer 멤버·전역 designer 는 403(자기 자신 추가도 동일).
 *  근본원인(p102 B9): canManageProject 가 designer 멤버까지 허용 + TEMP_OPEN_ALL_TENANTS 로 전원 허용 →
 *  비멤버 designer 가 자기를 멤버로 추가해 B5 쓰기 경계를 우회했다. */
async function canManageMembers(c: any, user: any, projectId: string): Promise<boolean> {
  if (!user) return false
  if (isSuperAdmin(c, user.email)) return true
  const own: any = await c.env.DB.prepare('SELECT owner FROM projects WHERE id = ? AND deleted = 0').bind(projectId).first()
  return !!own && canManageMembersOf(c, user, own.owner)
}
/** canManageMembers 의 판정 본체(이미 읽은 owner 값으로) — /api/projects 목록의 can_manage_members 가 같은 판정을 쓴다(SoT).
 *  [WO 20261001-bulkreauth] 클라이언트의 핀 일괄삭제 노출도 이 값만 본다. */
function canManageMembersOf(c: any, user: any, owner: any): boolean {
  if (!user) return false
  return isSuperAdmin(c, user.email) || isProjectOwner(owner, user.email)
}

/** [WO 20261002-gap 묶음C] 🔴 마스터 확정 — '확인(verified)' 전환은 소유자·super 만. 서버에서 강제(403).
 *  노트는 deployment_id 로 프로젝트에 연결되므로(projectIdsOfDeployment), 그 프로젝트 중 하나라도
 *  관리 권한(canManageMembers, SoT)이 있으면 허용. 프로젝트를 특정 못 하면(마이그레이션 전 등) 거부(fail-closed). */
async function canVerifyNoteByDeployment(c: any, user: any, depId: string): Promise<boolean> {
  const pids = await projectIdsOfDeployment(c, depId)
  for (const pid of pids) { if (await canManageMembers(c, user, pid)) return true }
  return false
}

/** [WO 20261001-invite · 마스터 확정 ②] 이메일 앞 대기 초대(project_invites) → 멤버 자동 편입 + 초대 소진.
 *  🔴 호출부는 **이메일 소유가 증명된 시점**만: 가입 인증코드 검증(/api/signup/verify) · 인증된 계정 로그인(/api/auth/me).
 *  토큰 수락과 같은 compare-and-swap(used=0 → 1)으로 동시 요청에도 1회만 편입. 삭제된 프로젝트·만료 초대는 건너뛴다.
 *  반환: 편입된 프로젝트 수. */
async function claimPendingInvites(c: any, rawEmail: string): Promise<number> {
  const email = String(rawEmail || '').trim().toLowerCase()
  if (!email || email === AUTO_DESIGNER_EMAIL) return 0
  const now = Date.now()
  let rows: any[] = []
  try {
    const r: any = await c.env.DB.prepare(
      `SELECT i.id, i.project_id, i.role, i.invited_by FROM project_invites i JOIN projects p ON p.id = i.project_id
       WHERE lower(i.email) = ? AND i.used = 0 AND i.revoked = 0 AND i.expires_at > ? AND p.deleted = 0`
    ).bind(email, now).all()
    rows = r.results || []
  } catch { return 0 }
  let n = 0
  for (const inv of rows) {
    const consumed: any = await c.env.DB.prepare('UPDATE project_invites SET used = 1, used_at = ? WHERE id = ? AND used = 0 AND revoked = 0')
      .bind(now, inv.id).run()
    if (!Number((consumed && consumed.meta && (consumed.meta.changes ?? consumed.meta.changed_db)) ?? 0)) continue
    await grantProjectMembership(c, inv.project_id, email, inv.role, inv.invited_by || 'invite', now)
    await logActivity(c, 'project.invite.auto_claim', { actor: { email }, targetType: 'project', targetId: inv.project_id, detail: { role: inv.role, invite: inv.id } })
    n++
  }
  return n
}

/** 사용자가 특정 프로젝트를 관리(공유코드·배포·삭제·멤버목록 열람)할 수 있는가: 슈퍼 또는 소유자 또는 designer-역할 멤버.
 *  🔴 멤버 초대·제거·역할 변경은 이 함수가 아니라 canManageMembers(소유자·super 만)로 판정한다. */
async function canManageProject(c: any, user: any, projectId: string): Promise<boolean> {
  if (!user) return false
  if (isSuperAdmin(c, user.email)) return true
  // [임시개방] 완성 전까지만. 구글로그인 재개 시 TEMP_OPEN_ALL_TENANTS=false 로 되돌리면 소유자/슈퍼만 관리 가능하도록 복원됨
  if (TEMP_OPEN_ALL_TENANTS) return true
  const own: any = await c.env.DB.prepare('SELECT owner FROM projects WHERE id = ? AND deleted = 0').bind(projectId).first()
  if (own && isProjectOwner(own.owner, user.email)) return true
  const m: any = await c.env.DB.prepare("SELECT role FROM project_members WHERE project_id = ? AND email = ?").bind(projectId, user.email).first()
  return !!(m && m.role === 'designer')
}

/** [WO 20260930-WP3 · B5] 🔴 배포본 쓰기 권한 — 배포본의 project_id 기준 단일 지점(§G-2-5).
 *  POST·PATCH/PUT·ops·DELETE /tables/deployments 가 공유한다. requireDesigner(전역 게이트) **통과 후** 호출.
 *  근본원인: grantProjectMembership 이 초대 designer 를 전역 designers 에 넣어, requireDesigner 하나로
 *  다른 프로젝트 배포본까지 쓰기가 열렸다(p93 B5: prj_B 초대자 → prj_A PATCH 200).
 *  반환: null = 허용 · { status, error } = 거부.
 *   - project_id NULL(레거시·귀속 불명) → 허용(종전 규칙 유지 — 잠금 사고 방지)
 *   - 프로젝트 삭제/없음 → 409(누구도 삭제된 프로젝트의 배포본에 쓰지 않는다)
 *   - 슈퍼 · 소유자 · 그 프로젝트 designer 멤버 → 허용, 그 외 403
 *   - 자동입장 공용 계정(AUTO_DESIGNER_EMAIL)은 AUTO_DESIGNER_TOKEN_ENABLED 동안 허용 — 그 좌석은
 *     "로그인 없이 설계자 진입" 공용석이라 막으면 현 사용자 전원이 잠긴다(스위치를 끄면 자동으로 막힘).
 *  🔴 TEMP_OPEN_ALL_TENANTS 는 보지 않는다(그 플래그는 열람·관리 범위용 — 쓰기 경계를 풀면 B5 재발). */
async function deploymentWriteDenied(c: any, user: any, projectId: any): Promise<{ status: 403 | 409, error: string } | null> {
  const pid = projectId == null ? '' : String(projectId)
  if (!pid) return null
  const p: any = await c.env.DB.prepare('SELECT owner, deleted FROM projects WHERE id = ?').bind(pid).first()
  if (!p || Number(p.deleted)) return { status: 409, error: 'conflict — project deleted; deployment is read-only' }
  const email = String(user?.email || '').trim().toLowerCase()
  if (!email) return { status: 403, error: 'forbidden' }
  if (isSuperAdmin(c, email)) return null
  if (AUTO_DESIGNER_TOKEN_ENABLED && email === AUTO_DESIGNER_EMAIL) return null
  if (isProjectOwner(p.owner, email)) return null
  const m: any = await c.env.DB.prepare('SELECT role FROM project_members WHERE project_id = ? AND lower(email) = ?').bind(pid, email).first()
  if (m && m.role === 'designer') return null
  return { status: 403, error: 'forbidden — not a designer of this project' }
}

/* ── [P40] 초대/세션 상수 — 값의 단일 진실 소스(매직넘버 중복 금지) ── */
const LOCAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000   // 로컬 세션 유효기간(기존 값 그대로: 30일)
const INVITE_TTL_MS        = 14 * 24 * 60 * 60 * 1000   // 초대 링크 유효기간: 14일
const INVITE_MIN_PASSWORD  = 8                          // 초대 계정 비밀번호 최소 길이(/api/signup/verify 와 동일 기준)

/** 프로젝트 멤버십 부여 + 역할 부수효과(designer 전역권한) — 초대수락/직접배정이 공유하는 한 지점(§G-2-5). */
async function grantProjectMembership(c: any, pid: string, email: string, role: string, grantedBy: string, now: number) {
  await c.env.DB.prepare(
    `INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, email) DO UPDATE SET role = excluded.role`
  ).bind(pid, email, role, grantedBy, now).run()
  // designer 로 배정 → 모든 구역 세팅 권한. deployment 는 project_id 가 없고 tenant 단위라
  // 프로젝트별 스코프 가드가 불가 → 전역 designers 등록으로 편집권한 부여(requireDesigner 통과).
  // 뷰어는 등록하지 않음(열람만). 최고관리자는 designssir 만(isSuperAdmin)으로 별개 유지.
  if (role === 'designer') {
    await c.env.DB.prepare(
      `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, '', ?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET deleted = 0`
    ).bind(email, 'project-invite:' + pid + ' by ' + grantedBy, now, now).run()
  } else {
    // viewer 로 (재)배정 시, 과거 designer 로 받았던 전역 권한은 회수(이 프로젝트 한정 의도)
    await c.env.DB.prepare("UPDATE designers SET deleted = 1 WHERE email = ? AND added_by LIKE 'project-invite:%'").bind(email).run().catch(() => {})
  }
  await projectBands(c, pid)   // [WO 20261001-startno] 새 멤버 → 빈 번호 대역 자동 배정
}

/* ── [WO 20261001-startno] 100 단위 번호 대역(마스터 확정: 멤버별 자동 배정 + 본인 변경, 서버 저장) ──
 * 대역 k = (k-1)*100+1 … k*100. 소유자 = projects.owner_num_band(없으면 1), 멤버 = project_members.num_band.
 * NULL 멤버(0032 이전 행·직접 INSERT 경로)는 멤버 추가 순서(created_at, email)대로 **빈** 대역을 채우고 저장한다(지연 백필).
 * 같은 상태에서 몇 번 불러도 같은 결과(결정론) · `num_band IS NULL` 조건부 UPDATE 라 동시 호출에도 덮어쓰기 0.
 * 본인이 고른 대역(남과 겹침 허용 — 클라가 확인창)은 그대로 둔다. 멤버 추가 경로 전부가 이 함수 하나를 부른다(§G-2-5). */
const NUM_BAND_SIZE = 100
const NUM_BAND_MAX = 999   // 대역 번호 상한(=번호 99,900) — 입력 오류 방어용 경계
async function projectBands(c: any, pid: string): Promise<{ owner: string, ownerBand: number, members: { email: string, role: string, band: number, created_at: number }[] } | null> {
  const p: any = await c.env.DB.prepare('SELECT owner, owner_num_band FROM projects WHERE id = ? AND deleted = 0').bind(pid).first().catch(() => null)
  if (!p) return null
  const owner = String(p.owner || '').trim().toLowerCase()
  const ownerBand = Number(p.owner_num_band) >= 1 ? Number(p.owner_num_band) : 1
  const r: any = await c.env.DB.prepare('SELECT email, role, created_at, num_band FROM project_members WHERE project_id = ? ORDER BY created_at, email').bind(pid).all()
  const all = (r.results || []).filter((m: any) => String(m.email || '').trim().toLowerCase() !== owner)
  // [WO 20261001-viewreq] 🔴 마스터: 열람자(viewer)는 번호 대역을 배정받지 않는다(핀을 만들지 않는다).
  //   이미 배정된 viewer 대역은 여기서 해제(NULL)한다 — 역할 변경 경로가 몇 개든 대역 정본은 이 함수 하나라
  //   다음 조회/멤버 추가 때 자동으로 맞춰진다. viewer → designer 로 바뀌면 아래 백필이 그때 빈 대역을 준다.
  for (const m of all) {
    if (String(m.role) === 'viewer' && Number(m.num_band) >= 1) {
      await c.env.DB.prepare("UPDATE project_members SET num_band = NULL WHERE project_id = ? AND email = ? AND role = 'viewer'").bind(pid, m.email).run()
    }
  }
  const rows = all.filter((m: any) => String(m.role) !== 'viewer')
  const used = new Set<number>([ownerBand])
  for (const m of rows) if (Number(m.num_band) >= 1) used.add(Number(m.num_band))
  const members: { email: string, role: string, band: number, created_at: number }[] = []
  for (const m of rows) {
    let band = Number(m.num_band) >= 1 ? Number(m.num_band) : 0
    if (!band) {
      band = 1
      while (used.has(band)) band++
      used.add(band)
      const w: any = await c.env.DB.prepare('UPDATE project_members SET num_band = ? WHERE project_id = ? AND email = ? AND num_band IS NULL').bind(band, pid, m.email).run()
      if (!Number((w && w.meta && (w.meta.changes ?? w.meta.changed_db)) ?? 0)) {   // 동시 요청이 먼저 채웠다 → 그 값을 따른다
        const cur: any = await c.env.DB.prepare('SELECT num_band FROM project_members WHERE project_id = ? AND email = ?').bind(pid, m.email).first()
        if (cur && Number(cur.num_band) >= 1) band = Number(cur.num_band)
      }
    }
    members.push({ email: String(m.email), role: String(m.role), band, created_at: Number(m.created_at) || 0 })
  }
  return { owner, ownerBand, members }
}

/** 초대 토큰 원문 → 유효한 초대행(없으면 null). 조회는 항상 해시로 한다(원문은 DB 에 없다). */
async function lookupInvite(c: any, rawToken: string): Promise<any | null> {
  const t = String(rawToken || '')
  if (!/^[0-9a-f]{32,}$/.test(t)) return null            // 형식 검증(hex, 128비트 이상)
  const hash = await sha256Hex(t)
  const inv: any = await c.env.DB.prepare(
    'SELECT id, project_id, email, role, invited_by, expires_at, used, revoked FROM project_invites WHERE token_hash = ?'
  ).bind(hash).first().catch(() => null)
  if (!inv) return null
  if (Number(inv.used) === 1 || Number(inv.revoked) === 1) return null
  if (Date.now() > Number(inv.expires_at)) return null
  return inv
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
    const isOwner = isProjectOwner(p.owner, email)
    if (globalDesigner || isOwner || myRole.has(p.id)) return true
    return !!p.published  // 비멤버도 배포된 프로젝트는 보임(잠금 상태로)
  })
  return c.json({ data: list.map((p: any) => {
    const isOwner = isProjectOwner(p.owner, email)
    const isMember =!!(isSuperUser || globalDesigner || isOwner || myRole.has(p.id))
    // [P40] 배지용 — 이 프로젝트에서의 내 실효 역할(멤버행 > 소유자/전역디자이너/슈퍼 > 없음)
    const effRole = myRole.get(p.id) || ((isSuperUser || globalDesigner || isOwner) ? 'designer' : null)
    const base = { ...mapProject(p), is_member: isMember, my_role: effRole, my_request: myReqStatus.get(p.id) || null,
      can_manage_members: canManageMembersOf(c, user, p.owner) }   // [WO 20261001-bulkreauth] 소유자·super — 일괄삭제 노출 SoT
    // [P61] 🔴 공유 토큰은 멤버(설계자/소유자/배정멤버/슈퍼)에게만. 비멤버에게 주면 열거 차단이 무의미해진다.
    return isMember ? base : stripShareKey(base)
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

/** [WO 20261001-projectinfo] 🔴 단일 PATCH 지점(§G-2-5) — 이름 변경·원본 지정·정보메모 셋이 공유한다.
 *  필드별 권한을 각자 확인: name/original_deployment_id = 소유자·super(canManageMembersOf),
 *  info_json = 디자이너 이상(canManageProject, 멤버 포함). info_json 은 LWW + 충돌 경고
 *  (base_updated_at 이 서버 값과 다르면 409 — 클라가 확인 후 재요청하면 강제 저장). */
app.patch('/api/projects/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  const proj: any = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ? AND deleted = 0').bind(id).first()
  if (!proj) return c.json({ error: 'not found' }, 404)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const sets: string[] = []
  const binds: any[] = []
  if (body.name !== undefined) {
    if (!canManageMembersOf(c, user, proj.owner)) return c.json({ error: 'forbidden — owner/super only' }, 403)
    const name = String(body.name).replace(/[\u0000-\u001f]/g, '').trim()
    if (!name || name.length > 80) return c.json({ error: 'name must be 1-80 chars' }, 400)
    sets.push('name = ?'); binds.push(name)
  }
  if (body.original_deployment_id !== undefined) {
    if (!canManageMembersOf(c, user, proj.owner)) return c.json({ error: 'forbidden — owner/super only' }, 403)
    sets.push('original_deployment_id = ?'); binds.push(body.original_deployment_id ? String(body.original_deployment_id) : null)
  }
  if (body.info_json !== undefined) {
    if (!(await canManageProject(c, user, id))) return c.json({ error: 'forbidden — designer+ only' }, 403)
    const cur = parseProjectInfo(proj.info_json)
    if (body.base_updated_at !== undefined && cur.updatedAt && Number(body.base_updated_at) !== Number(cur.updatedAt)) {
      return c.json({ error: 'conflict — modified by someone else', data: cur }, 409)
    }
    const incoming = body.info_json || {}
    const now = Date.now()
    const next = {
      note: typeof incoming.note === 'string' ? incoming.note.slice(0, 20000) : '',
      schedule: Array.isArray(incoming.schedule) ? incoming.schedule.slice(0, 200).map((s: any) => ({
        id: String((s && s.id) || genId('sch')),
        date: (s && typeof s.date === 'string') ? s.date.slice(0, 20) : '',
        kind: (s && typeof s.kind === 'string') ? s.kind.slice(0, 40) : '',
        content: (s && typeof s.content === 'string') ? s.content.slice(0, 500) : '',
        done: !!(s && s.done),
      })) : [],
      updatedAt: now, updatedBy: user.email || '',
    }
    sets.push('info_json = ?'); binds.push(JSON.stringify(next))
  }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400)
  sets.push('updated_at = ?'); binds.push(Date.now())
  binds.push(id)
  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  await logActivity(c, 'project.update', { actor: user, targetType: 'project', targetId: id, detail: { fields: Object.keys(body) } })
  const updated: any = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first()
  return c.json({ data: mapProject(updated) })
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
   [P61] 공유 주소 — https://<도메인>/srview/<프로젝트명>-<토큰>
   마스터 2026-09-21 "scan.seastar.work/프로젝트이름 이런 식으로 배포해줘"
                     "배포되면 주소를 보이게 하고 주소 링크도 바로 복사 가능하게 해"
   마스터 2026-09-18 "배포했을 시 주소 형태는 다른 프로젝트를 유추할 수 없도록"
                     "보이는 건 seastar 과 srview 로 나오게 해줘"
   ── 두 요구의 충돌 해소: **이름은 보이되 열쇠가 아니다.**
      · 열쇠 = share_token (80비트 암호난수). 이름을 정확히 맞춰도 토큰이 없으면 404.
      · slug = 이름에서 매번 파생(DB 저장 X). 이름을 바꿔도 토큰이 같으므로 옛 링크가 산다.
      · 기존 `?d=<deployment_id>` 링크는 그대로 동작한다(하위호환, 회귀 금지).
   ════════════════════════════════════════════════════════════ */

/** 프로젝트에 공유 토큰이 없으면 1회 발급한다(있으면 손대지 않는다 = 링크 영속).
 *  유니크 인덱스 충돌(천문학적 확률이지만 조용히 실패하면 안 된다) 시 최대 5회 재시도.
 *  @returns 현재 유효한 토큰. 실패하면 null(호출부가 정직하게 null 을 응답에 싣는다). */
async function ensureShareToken(c: any, pid: string): Promise<string | null> {
  const cur: any = await c.env.DB.prepare('SELECT share_token FROM projects WHERE id = ? AND deleted = 0').bind(pid).first()
  if (cur && cur.share_token) return String(cur.share_token)
  for (let i = 0; i < 5; i++) {
    const tok = randShareToken()
    try {
      await c.env.DB.prepare('UPDATE projects SET share_token = ?, updated_at = ? WHERE id = ? AND deleted = 0 AND share_token IS NULL')
        .bind(tok, Date.now(), pid).run()
    } catch (e) { continue }   // UNIQUE 충돌 → 새 토큰으로 재시도
    const after: any = await c.env.DB.prepare('SELECT share_token FROM projects WHERE id = ? AND deleted = 0').bind(pid).first()
    if (after && after.share_token) return String(after.share_token)
  }
  return null
}

/** 공유 토큰 → 배포된 프로젝트. 미배포·삭제·형식불량·미존재는 전부 null(구분해서 알려주지 않는다 = 열거 차단). */
async function projectByShareToken(c: any, token: string): Promise<any | null> {
  if (!isShareToken(token)) return null
  const row: any = await c.env.DB.prepare(
    'SELECT id, name, share_token, published FROM projects WHERE share_token = ? AND deleted = 0'
  ).bind(token).first()
  if (!row || !row.published) return null
  return row
}

/** 공유 링크 해석(공개 · 인증 불필요) — 클라이언트가 경로에서 뽑은 토큰으로 프로젝트/배포본을 얻는다.
 *  🔴 토큰이 유효하지 않으면 404 + 본문 동일 → "이름만 맞춘" 추측에 어떤 힌트도 주지 않는다. */
app.get('/api/share/:token', async (c) => {
  const row = await projectByShareToken(c, c.req.param('token'))
  if (!row) return c.json({ matched: false }, 404)
  // 뷰어가 실제로 열 배포본(= 기존 `?d=` 가 가리키던 그 값). 없으면 null 로 정직하게 알린다.
  const deck: any = await c.env.DB.prepare(
    'SELECT deployment_id FROM decks WHERE project_id = ? AND deleted = 0 AND deployment_id IS NOT NULL ORDER BY level_no ASC, created_at ASC LIMIT 1'
  ).bind(row.id).first().catch(() => null)
  return c.json({
    matched: true,
    project: { id: row.id, name: row.name },
    deployment_id: (deck && deck.deployment_id) ? String(deck.deployment_id) : null,
    share_path: sharePath(row.name, String(row.share_token)),
  })
})

/** 앱 셸(index.html) 서빙 — 정적 자산 폴백 로직의 단일 소스. 말미 app.all('*') 와 공유한다. */
async function serveAppShell(c: any): Promise<Response> {
  const assets = c.env.ASSETS
  if (!assets || !assets.fetch) return c.text('Not Found', 404)
  const origin = new URL(c.req.url).origin
  const res = await assets.fetch(new Request(origin + '/index.html', { method: 'GET' }))
  const out = new Response(res.body, res)
  out.headers.set('Content-Type', 'text/html; charset=utf-8')
  out.headers.set('Cache-Control', 'no-cache, must-revalidate')
  // 공유 링크는 검색엔진에 올라가면 "유추 불가" 요구가 무너진다.
  out.headers.set('X-Robots-Tag', 'noindex, nofollow')
  return out
}

/** 🔴 `/srview/<이름>-<토큰>` — 토큰이 맞을 때만 앱 셸을 준다. 이름만으로는 절대 열리지 않는다.
 *  정적 자산(/js, /css, /images)은 index.html 이 **절대경로**로 참조하므로 이 경로 아래로 새지 않는다
 *  (public/index.html 의 src/href 를 `/js/...` 형태로 교정 — 상대경로였다면 /srview/js/main.js 로 요청돼 깨진다). */
app.get('/srview/:seg', async (c) => {
  const token = shareTokenFromSegment(c.req.param('seg'))
  const row = token ? await projectByShareToken(c, token) : null
  if (!row) return shareNotFound(c)
  return await serveAppShell(c)
})
// 토큰 없는 `/srview` · `/srview/` 도 동일한 404 (목록을 주지 않는다)
app.get('/srview', (c) => shareNotFound(c))
app.get('/srview/', (c) => shareNotFound(c))

/** 공유 링크 404 — 존재/미존재/미배포를 구분해서 알려주지 않는다(열거 차단). 대비 ≥ 7:1. */
function shareNotFound(c: any): Response {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>링크를 찾을 수 없습니다 — SEASTAR</title>
<style>
  html,body{height:100%;margin:0}
  body{background:#0b1220;color:#e6edf7;font-family:Pretendard,system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
  .c{max-width:520px}
  h1{font-size:20px;margin:0 0 12px;color:#e6edf7}
  p{font-size:14px;line-height:1.7;margin:0 0 8px;color:#9fb0c9}
  a{color:#f0b429;text-decoration:underline}
</style></head><body><div class="c">
<h1>링크를 찾을 수 없습니다</h1>
<p>주소가 정확하지 않거나, 공유가 해제된 링크입니다.</p>
<p>프로젝트 이름만으로는 열람할 수 없습니다.</p>
<p><strong>${SUPPORT_CONTACT_EMAIL}</strong> 으로 링크를 다시 요청하세요.</p>
<p><a href="/">SEASTAR 360° 홈으로</a></p>
</div></body></html>`
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } })
}

/* ════════════════════════════════════════════════════════════
   [P63] 뷰어 초대코드 게이트 — 코드가 열쇠, 이름·소속은 기록용
   마스터 확정: "1단계 = 접속 기록 / 차단은 초대 계정" → "좋아 그렇게 해. 초대코드"
   마스터 "그런데 그 링크가 유출된다면?" → 링크만 유출되면 코드에서 막히고,
   코드까지 유출되면 **폐기(revoke)·만료·접속기록** 3종으로 대응한다.
   ════════════════════════════════════════════════════════════ */

/** 🔴 게이트 대상 주체인가 — "링크를 가졌다"만으로 들어온 사람인가.
 *  · 자동입장 **열람전용**(공유/배포 링크 세션) → 대상
 *  · 데모 **뷰어** → 대상. 운영엔 DEMO_LOGIN='0' 으로 봉인되지만,
 *    로컬에서 이 토큰으로 게이트가 통째로 뚫리는 것을 실측했다 → 막는다.
 *  · 자동입장 designer · 데모 designer/super · 실계정(로컬세션/구글) → 대상 아니다. */
function isShareGateSubject(user: any): boolean {
  if (!user) return false
  if (user._auto) return !!user._readonly
  if (user._demo) return String(user.role || '') === 'viewer'
  return false
}

/** 요청 경로 → 게이트를 걸 프로젝트 id **목록**. 특정 불가면 빈 배열.
 *  🔴 복수인 이유: 같은 deployment_id 를 서로 다른 프로젝트의 decks 가 가리킬 수 있다.
 *  하나만 골라보면 잠긴 프로젝트를 놓치고 게이트가 뚫린다(라이브 재현함). */
async function gatedProjectIdsOf(c: any, path: string): Promise<string[]> {
  try {
    // /api/projects/<pid>/...
    let m = path.match(/^\/api\/projects\/([^/]+)/)
    if (m) return [decodeURIComponent(m[1])]
    // /tables/deployments/<depId>
    m = path.match(/^\/tables\/deployments\/([^/]+)/)
    let depId = m ? decodeURIComponent(m[1]) : ''
    // /api/notes?deployment_id=... · /api/notes/summary?deployment_id=...
    if (!depId && path.startsWith('/api/notes')) depId = String(c.req.query('deployment_id') || '')
    return await projectIdsOfDeployment(c, depId)
  } catch { return [] }
}

/** 배포본을 참조하는 프로젝트 id 전부(삭제 deck 제외). 특정 불가면 빈 배열. */
async function projectIdsOfDeployment(c: any, depId: string): Promise<string[]> {
  if (!depId) return []
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT project_id FROM decks WHERE deployment_id = ? AND deleted = 0'
    ).bind(depId).all()
    const out: string[] = []
    for (const r of (results || [])) { const v = (r as any).project_id; if (v && !out.includes(String(v))) out.push(String(v)) }
    return out
  } catch { return [] }
}

/** 🔴 게이트 판정 본체(단일 지점) — 읽기 미들웨어와 열람자 요청 작성(POST /api/notes)이 공유한다.
 *  pids 중 이 세션이 통과하지 못한 잠긴 프로젝트 id(없으면 null). 하나라도 잠겨 있으면 잠근다(fail-closed). */
async function shareGateLockedPid(c: any, user: any, pids: string[]): Promise<string | null> {
  if (!pids.length) return null
  if (user && user._gate && pids.includes(String(user._gate))) return null   // 이 프로젝트 게이트 통과 세션
  for (const pid of pids) { if (await projectHasActiveShareCode(c, pid)) return pid }
  return null
}

/** 이 프로젝트에 **살아있는** 초대코드가 하나라도 있나 = 게이트 ON 여부. */
async function projectHasActiveShareCode(c: any, pid: string): Promise<boolean> {
  try {
    const row: any = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM project_share_codes WHERE project_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)'
    ).bind(pid, Date.now()).first()
    return !!(row && row.n)
  } catch {
    // 🔴 테이블 부재(마이그레이션 전) = 게이트 미도입 상태 → 종전대로 열람(조용한 전면 차단 금지)
    return false
  }
}

/** 공유 링크/배포 링크의 게이트 상태 조회(공개). 클라이언트가 입력 화면을 띄울지 결정하는 단일 소스.
 *  🔴 경로가 `/api/share/gate` 가 아닌 이유: 위쪽에 이미 등록된 `/api/share/:token` 이 같은 요청을
 *     먼저 잡아 404 를 돌려준다(Hono 는 등록 순서대로 핸들러를 실행한다). 라우트 순서에 의존하는
 *     설계는 다음 사람이 줄을 옮기는 순간 조용히 깨지므로, 충돌하지 않는 경로를 쓴다. */
app.get('/api/share-gate', async (c) => {
  const t = String(c.req.query('t') || '')
  const d = String(c.req.query('d') || '')
  let proj: any = null, depId: string | null = null
  if (t) {
    proj = await projectByShareToken(c, t)
    if (proj) {
      const deck: any = await c.env.DB.prepare(
        'SELECT deployment_id FROM decks WHERE project_id = ? AND deleted = 0 AND deployment_id IS NOT NULL ORDER BY level_no ASC, created_at ASC LIMIT 1'
      ).bind(proj.id).first().catch(() => null)
      depId = (deck && deck.deployment_id) ? String(deck.deployment_id) : null
    }
  } else if (d) {
    const deck: any = await c.env.DB.prepare(
      'SELECT project_id FROM decks WHERE deployment_id = ? AND deleted = 0 LIMIT 1'
    ).bind(d).first().catch(() => null)
    if (deck && deck.project_id) {
      proj = await c.env.DB.prepare('SELECT id, name FROM projects WHERE id = ? AND deleted = 0').bind(deck.project_id).first()
      depId = d
    }
  }
  if (!proj) return c.json({ matched: false, contact: SUPPORT_CONTACT_EMAIL }, 404)
  const gated = await projectHasActiveShareCode(c, proj.id)
  const user = await getUser(c)
  // 실계정/설계자는 게이트 대상이 아니다 — 이미 통과한 것으로 본다.
  const exempt = !!user && !isShareGateSubject(user)
  const passed = exempt || !!(user && user._gate && String(user._gate) === String(proj.id))
  return c.json({
    matched: true,
    project: { id: proj.id, name: proj.name },
    deployment_id: depId,
    gated, passed,
    contact: SUPPORT_CONTACT_EMAIL,
  })
})

/** 🔴 초대코드 제출 → 통과 시 서명된 게이트 통행증(열람 전용) 발급 + 접속 기록.
 *  이름·회사는 **자기 신고**라 대조하지 않는다(대조할 명단이 없다) — activity_log 에 기록만 한다. */
app.post('/api/share/verify', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const company = String(body.company || '').trim().slice(0, 80)
  const person  = String(body.name || '').trim().slice(0, 60)
  const rawCode = String(body.code || '')
  const fail = (reason: string, status: 400 | 403 = 403) =>
    c.json({ error: reason, ok: false, contact: SUPPORT_CONTACT_EMAIL,
             message: '초대코드가 올바르지 않습니다. ' + SUPPORT_CONTACT_EMAIL + ' 으로 링크를 다시 요청하세요.' }, status)

  // 대상 프로젝트 해석 — 공유 토큰(t) 또는 기존 배포 링크(d)
  let proj: any = null
  const t = String(body.t || ''), d = String(body.d || '')
  if (t) proj = await projectByShareToken(c, t)
  else if (d) {
    const deck: any = await c.env.DB.prepare('SELECT project_id FROM decks WHERE deployment_id = ? AND deleted = 0 LIMIT 1').bind(d).first().catch(() => null)
    if (deck && deck.project_id) proj = await c.env.DB.prepare('SELECT id, name FROM projects WHERE id = ? AND deleted = 0').bind(deck.project_id).first()
  }
  if (!proj) return fail('link not found')
  if (!company || !person) return c.json({ error: 'company/name required', ok: false, contact: SUPPORT_CONTACT_EMAIL, message: '회사명과 이름을 입력하세요.' }, 400)
  if (!isShareCode(rawCode)) {
    await logActivity(c, 'share.denied', { actor: { email: '' }, targetType: 'project', targetId: proj.id,
      detail: { reason: 'malformed-code', company, name: person, url: c.req.header('Referer') || null } })
    return fail('invalid code')
  }
  const hash = await sha256Hex(normalizeShareCode(rawCode))
  const row: any = await c.env.DB.prepare(
    'SELECT id, label, company, expires_at, revoked FROM project_share_codes WHERE project_id = ? AND code_hash = ?'
  ).bind(proj.id, hash).first().catch(() => null)
  const now = Date.now()
  const bad = !row ? 'unknown-code' : (row.revoked ? 'revoked-code' : ((row.expires_at && row.expires_at <= now) ? 'expired-code' : null))
  if (bad) {
    await logActivity(c, 'share.denied', { actor: { email: '' }, targetType: 'project', targetId: proj.id,
      detail: { reason: bad, company, name: person, code_id: row ? row.id : null, url: c.req.header('Referer') || null } })
    return fail(bad)
  }
  /* [P68] 🔴 허락되지 않은 회사 리젝트 — 코드에 company 가 지정된 경우에만 작동한다.
   *   NULL 이면 검사 없음 = 기존 링크 무손상. 판정 순서·임계값은 src/lib/jev.ts 가 정본(SoT).
   *   ⚠️ 대조 기준은 label 이 아니라 company 다(label 은 "대한중공업 배관팀" 같은 폐기 단위 이름). */
  const gate = await decideCompanyGate({
    allowed: row.company, input: company,
    ask: (a, b) => askJevSameCompany(c.env, a, b),
  })
  if (gate.verdict !== 'pass') {
    const pending = gate.verdict === 'pending'
    await logActivity(c, pending ? 'share.pending' : 'share.denied', {
      actor: { email: '' }, targetType: 'project', targetId: proj.id,
      detail: { reason: gate.reason, company, name: person, allowed_company: row.company,
                code_id: row.id, code_label: row.label, jev: gate.jev,
                url: c.req.header('Referer') || null } })
    return c.json({
      error: pending ? 'company pending approval' : 'company not allowed',
      ok: false, contact: SUPPORT_CONTACT_EMAIL,
      // 🔴 어느 회사가 등록돼 있는지는 알려주지 않는다(추측 공격에 정답을 주는 셈).
      message: (pending
        ? '입력하신 회사명이 이 링크에 등록된 회사와 같은지 확인하지 못했습니다. 담당자 확인이 필요합니다. '
        : '이 링크는 허용된 회사만 열람할 수 있습니다. ') +
        SUPPORT_CONTACT_EMAIL + ' 으로 링크를 다시 요청하세요.',
    }, 403)
  }
  const pass = await mintAutoEntryToken(c, 'viewer', String(proj.id))
  if (!pass) return c.json({ error: 'gate unavailable', ok: false, contact: SUPPORT_CONTACT_EMAIL, message: '일시적인 오류입니다. 잠시 후 다시 시도하세요.' }, 503)
  await c.env.DB.prepare('UPDATE project_share_codes SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    .bind(now, row.id).run().catch(() => {})
  // 🔴 접속 기록 — 이름·소속·접속주소는 detail 에, IP·UA·시각은 logActivity 가 공통으로 넣는다(SoT).
  //   actor_email 은 비운다: 자기 신고 이름은 **검증된 신원이 아니다**(날조 금지).
  await logActivity(c, 'share.access', { actor: { email: '' }, targetType: 'project', targetId: proj.id,
    detail: { company, name: person, code_id: row.id, code_label: row.label,
              url: c.req.header('Referer') || (t ? sharePath(proj.name, t) : ('/?d=' + d)),
              // [P68] 회사 대조가 어떻게 통과했는지(규칙/추정) 남긴다 — 감사 질의에 답하기 위해
              allowed_company: row.company || null, gate_reason: gate.reason, jev: gate.jev,
              retention_days: PERSONAL_LOG_RETENTION_DAYS } })
  return c.json({ ok: true, token: pass.token, exp: pass.exp, readonly: true,
                  project: { id: proj.id, name: proj.name } })
})

/* ── 마스터/설계자용: 초대코드 발급·목록·폐기 ─────────────────────────── */
app.get('/api/projects/:id/share-codes', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT id, label, company, code_hint, created_by, created_at, expires_at, revoked, revoked_at, last_used_at, use_count FROM project_share_codes WHERE project_id = ? ORDER BY created_at DESC'
  ).bind(pid).all().catch(() => ({ results: [] as any[] }))
  const now = Date.now()
  return c.json({
    data: (results || []).map((r: any) => ({ ...r, revoked: !!r.revoked,
      // [P68] company 가 없는 코드는 회사 대조를 하지 않는다 — 목록에서 그 사실이 보여야 한다
      company: r.company || null, company_gate: !!r.company,
      active: !r.revoked && (!r.expires_at || r.expires_at > now) })),
    company_gate_threshold: COMPANY_GATE_PASS_P,
    // 🔴 원문은 없다 — 발급 순간에만 보여준다(해시 저장 정책). 재확인 불가 = 재발급하라.
    plaintext_available: false,
    retention_days: PERSONAL_LOG_RETENTION_DAYS,
  })
})

app.post('/api/projects/:id/share-codes', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  let body: any = {}
  try { body = await c.req.json() } catch {}
  const label = String(body.label || '').trim().slice(0, 60)
  if (!label) return c.json({ error: '발급 단위 이름(협력사/현장)을 입력하세요 — 유출 시 이 단위로 폐기합니다.' }, 400)
  /* [P68] 허용 회사(옵션). 지정하면 열람자가 입력한 소속과 대조해 다른 회사를 리젝트한다.
   *   🔴 비우면 대조하지 않는다(기존 동작). label 을 자동으로 끌어다 쓰지 않는다 —
   *      label 은 "대한중공업 배관팀" 처럼 팀명이 붙어 있어 대조 기준으로 쓰면 전원 리젝트된다. */
  const allowedCompany = String(body.company || '').trim().slice(0, 80) || null
  const days = Number(body.ttl_days)
  const expires_at = Number.isFinite(days) && days > 0 ? Date.now() + days * 86400000 : null
  const code = randShareCode()
  const norm = normalizeShareCode(code)
  const id = genId('psc')
  await c.env.DB.prepare(
    // [P68] company 는 **마지막 컬럼**으로 붙인다 — 앞쪽 바인딩 순서를 건드리지 않는다
    'INSERT INTO project_share_codes (id, project_id, label, code_hash, code_hint, created_by, created_at, expires_at, revoked, use_count, company) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)'
  ).bind(id, pid, label, await sha256Hex(norm), norm.slice(0, 4), user.email, Date.now(), expires_at, allowedCompany).run()
  await logActivity(c, 'share.code.create', { actor: user, targetType: 'project', targetId: pid, detail: { code_id: id, label, company: allowedCompany, expires_at } })
  // 🔴 원문은 이 응답에서만 나간다(DB 에는 해시만).
  return c.json({ success: true, id, label, company: allowedCompany, company_gate: !!allowedCompany, code, expires_at, once_only: true })
})

app.post('/api/share-codes/:codeId/revoke', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const cid = c.req.param('codeId')
  const row: any = await c.env.DB.prepare('SELECT id, project_id, label FROM project_share_codes WHERE id = ?').bind(cid).first().catch(() => null)
  if (!row) return c.json({ error: 'not found' }, 404)
  if (!(await canManageProject(c, user, String(row.project_id)))) return c.json({ error: 'forbidden' }, 403)
  await c.env.DB.prepare('UPDATE project_share_codes SET revoked = 1, revoked_at = ?, revoked_by = ? WHERE id = ?')
    .bind(Date.now(), user.email, cid).run()
  await logActivity(c, 'share.code.revoke', { actor: user, targetType: 'project', targetId: String(row.project_id), detail: { code_id: cid, label: row.label } })
  return c.json({ success: true })
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
  // [WO 20261001-invite ③] 초대·역할 변경 = 소유자·super 만(자기 자신 추가 포함)
  if (!(await canManageMembers(c, user, pid))) return c.json({ error: 'forbidden — only the project owner or super admin can manage members' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = normEmail(body.email)
  const role = ['viewer', 'editor', 'designer'].includes(body.role) ? body.role : 'viewer'
  if (!email || !isValidEmail(email)) return c.json({ error: 'valid email required' }, 400)
  const now = Date.now()

  // [보안 P40] 이미 계정이 있는 이메일 → 멤버로만 추가(이름·비번 재입력 없음).
  //            계정이 없는 이메일 → 🔴 계정을 만들지 않는다. 일회용 초대 토큰만 발급.
  //   종전 결함: 계정이 없으면 비밀번호 '1' 로 local_users 를 즉시 만들었다. must_change_password=1 이어도
  //   본인 첫 로그인 전에 이메일을 아는 제3자가 <email>+'1' 로 선점 로그인할 수 있었다(계정 탈취).
  const existsUser: any = await c.env.DB.prepare('SELECT email FROM local_users WHERE email = ? AND deleted = 0').bind(email).first()

  if (!existsUser) {
    const token = randInviteToken()                 // 256비트 암호난수 (Math.random 금지)
    const tokenHash = await sha256Hex(token)        // DB 에는 해시만 — 원문 저장 금지
    const expiresAt = now + INVITE_TTL_MS
    await c.env.DB.prepare(
      `INSERT INTO project_invites (id, token_hash, project_id, email, role, invited_by, created_at, expires_at, used, revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
    ).bind(randToken('inv-'), tokenHash, pid, email, role, user.email, now, expiresAt).run()
    await logActivity(c, 'project.member.invite', { actor: user, targetType: 'project', targetId: pid, detail: { email, role } })
    const origin = new URL(c.req.url).origin
    return c.json({
      success: true, email, role, created: false, invited: true,
      invite_url: origin + '/?invite=' + token,     // 토큰 원문은 이 응답(=링크)에만 존재
      expires_at: expiresAt
    })
  }

  await grantProjectMembership(c, pid, email, role, user.email, now)
  await logActivity(c, 'project.member.add', { actor: user, targetType: 'project', targetId: pid, detail: { email, role, created: false, existing: true } })
  return c.json({ success: true, email, role, created: false, existing: true })
})

/* ── [WO 20261001-startno] 번호 대역 조회/변경 ──
 * GET /api/projects/:id/bands            — 소유자·멤버·super. 대역표(소유자+멤버, 이름) + 내 대역(비멤버 super 는 null)
 * PUT /api/projects/:id/members/me/band   — body {band, email?}. 본인만 · 남의 대역은 소유자·super(canManageMembers)만.
 *     남과 같은 대역 선택은 허용(같은 대역 안에서 이어 씀 — 확인창은 클라 몫). 소유자 대역은 projects.owner_num_band. */
async function bandsPayload(c: any, pid: string, me: string) {
  const t = await projectBands(c, pid)
  if (!t) return null
  const emails = [t.owner, ...t.members.map((m) => m.email.toLowerCase())].filter(Boolean)
  const names = new Map<string, string>()
  if (emails.length) {
    const ph = emails.map(() => '?').join(',')
    const r: any = await c.env.DB.prepare(`SELECT lower(email) AS email, name FROM local_users WHERE lower(email) IN (${ph}) AND deleted = 0`).bind(...emails).all().catch(() => ({ results: [] }))
    for (const u of (r.results || [])) if (u.name) names.set(String(u.email), String(u.name))
  }
  const bands = [
    ...(t.owner ? [{ band: t.ownerBand, email: t.owner, name: names.get(t.owner) || '', owner: true }] : []),
    ...t.members.map((m) => ({ band: m.band, email: m.email, name: names.get(m.email.toLowerCase()) || '', owner: false })),
  ]
  const mine = me && me === t.owner ? t.ownerBand : (t.members.find((m) => m.email.toLowerCase() === me)?.band ?? null)
  return { band_size: NUM_BAND_SIZE, me: { email: me, band: mine, owner: !!me && me === t.owner }, bands }
}

app.get('/api/projects/:id/bands', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  const pid = c.req.param('id')
  const me = String(user.email || '').trim().toLowerCase()
  const proj: any = await c.env.DB.prepare('SELECT owner FROM projects WHERE id = ? AND deleted = 0').bind(pid).first()
  if (!proj) return c.json({ error: 'not found' }, 404)
  const isMember = !!(await c.env.DB.prepare('SELECT 1 AS x FROM project_members WHERE project_id = ? AND lower(email) = ?').bind(pid, me).first())
  if (!isSuperAdmin(c, me) && !isProjectOwner(proj.owner, me) && !isMember) return c.json({ error: 'forbidden' }, 403)
  return c.json(await bandsPayload(c, pid, me))
})

app.put('/api/projects/:id/members/me/band', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  const pid = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const band = Number(body.band)
  if (!Number.isInteger(band) || band < 1 || band > NUM_BAND_MAX) return c.json({ error: 'band must be an integer 1..' + NUM_BAND_MAX }, 400)
  const me = String(user.email || '').trim().toLowerCase()
  const target = body.email ? normEmail(body.email) : me
  if (target !== me && !(await canManageMembers(c, user, pid))) return c.json({ error: 'forbidden — only the owner or super admin can change another member\'s band' }, 403)
  const t = await projectBands(c, pid)   // 바꾸기 전에 NULL 멤버를 먼저 확정(내 이동으로 남의 백필 결과가 흔들리지 않게)
  if (!t) return c.json({ error: 'not found' }, 404)
  if (target === t.owner) {
    await c.env.DB.prepare('UPDATE projects SET owner_num_band = ? WHERE id = ?').bind(band, pid).run()
  } else if (t.members.some((m) => m.email.toLowerCase() === target)) {
    await c.env.DB.prepare('UPDATE project_members SET num_band = ? WHERE project_id = ? AND lower(email) = ?').bind(band, pid, target).run()
  } else if (await c.env.DB.prepare("SELECT 1 AS x FROM project_members WHERE project_id = ? AND lower(email) = ? AND role = 'viewer'").bind(pid, target).first()) {
    return c.json({ error: 'viewers have no number band — 열람자는 번호 대역을 쓰지 않습니다' }, 409)   // [WO 20261001-viewreq]
  } else {
    return c.json({ error: 'not a member of this project' }, 404)
  }
  await logActivity(c, 'project.member.band', { actor: user, targetType: 'project', targetId: pid, detail: { email: target, band } })
  return c.json(await bandsPayload(c, pid, me))
})

/* ── [P40] 프로젝트 초대 링크 ───────────────────────────────────────────
 * GET  /api/projects/:id/invites      대기 중 초대 목록(관리자) — 토큰 원문은 절대 반환하지 않음
 * DELETE /api/projects/:id/invites/:iid  초대 취소(revoke)
 * GET  /api/invite/:token             (공개) 토큰 검증 → 이름/비번 입력이 필요한지 알려준다
 * POST /api/invite/:token/accept      (공개) 이름+비번으로 계정 생성 & 멤버 등록 & 토큰 1회 소비 */

app.get('/api/projects/:id/invites', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const pid = c.req.param('id')
  if (!(await canManageProject(c, user, pid))) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, role, invited_by, created_at, expires_at, used FROM project_invites WHERE project_id = ? AND used = 0 AND revoked = 0 ORDER BY created_at DESC'
  ).bind(pid).all()
  const now = Date.now()
  return c.json({ data: (results || []).filter((r: any) => Number(r.expires_at) > now) })
})

app.delete('/api/projects/:id/invites/:iid', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  const pid = c.req.param('id')
  if (!(await canManageMembers(c, user, pid))) return c.json({ error: 'forbidden — only the project owner or super admin can manage members' }, 403)
  const iid = decodeURIComponent(c.req.param('iid'))
  await c.env.DB.prepare('UPDATE project_invites SET revoked = 1 WHERE id = ? AND project_id = ?').bind(iid, pid).run()
  await logActivity(c, 'project.member.invite_revoke', { actor: user, targetType: 'project', targetId: pid, detail: { invite: iid } })
  return c.json({ success: true })
})

app.get('/api/invite/:token', async (c) => {
  const inv = await lookupInvite(c, c.req.param('token'))
  if (!inv) return c.json({ error: '초대 링크가 유효하지 않거나 만료되었습니다.' }, 404)
  const exist: any = await c.env.DB.prepare('SELECT email, name FROM local_users WHERE email = ? AND deleted = 0').bind(inv.email).first().catch(() => null)
  const proj: any = await c.env.DB.prepare('SELECT name FROM projects WHERE id = ? AND deleted = 0').bind(inv.project_id).first().catch(() => null)
  return c.json({
    email: inv.email, role: inv.role, project_id: inv.project_id,
    project_name: (proj && proj.name) || inv.project_id,
    expires_at: inv.expires_at,
    needs_account: !exist,                            // false → 이름·비번을 다시 묻지 않는다
    needs_login: !!exist,                             // [WO 20261001-invite] 가입된 이메일 → 그 이메일로 로그인한 상태에서만 수락
    name: (exist && exist.name) || ''
  })
})

app.post('/api/invite/:token/accept', async (c) => {
  const inv = await lookupInvite(c, c.req.param('token'))
  if (!inv) return c.json({ error: '초대 링크가 유효하지 않거나 만료되었습니다.' }, 404)
  let body: any
  try { body = await c.req.json() } catch { body = {} }

  // [WO 20261001-invite · 마스터 확정 ①] 🔴 초대 링크는 신원 증명이 아니다 — 호출자 신원과 묶는다.
  //   근본원인(p102 B4): 종전엔 링크 소지자 누구에게나 inv.email 의 세션을 발급했다 → 기존 계정 탈취.
  //   · 로그인 상태(실계정) + 이메일 ≠ 초대 이메일 → 403 wrong_account
  //   · 로그인 상태 + 이메일 = 초대 이메일 → 멤버 편입만(새 세션 발급 0)
  //   · 비로그인 + 이미 가입된 이메일 → 401 login_required (그 이메일로 로그인 후 같은 토큰으로 재시도)
  //   · 비로그인 + 신규 이메일 → 종전대로 이름·비밀번호로 가입 + 수락
  //   공용석/열람 토큰·데모는 실계정 신원이 아니므로 '비로그인'으로 취급한다.
  const caller = await getUser(c)
  const callerEmail = (caller && !caller._auto && !caller._demo) ? String(caller.email || '').trim().toLowerCase() : ''
  const invEmail = String(inv.email || '').trim().toLowerCase()
  if (callerEmail && callerEmail !== invEmail) {
    return c.json({ error: '초대받은 이메일로 로그인하세요. (초대: ' + inv.email + ' · 현재 로그인: ' + callerEmail + ')', code: 'wrong_account', invite_email: inv.email }, 403)
  }
  const exist: any = await c.env.DB.prepare('SELECT email FROM local_users WHERE email = ? AND deleted = 0').bind(inv.email).first().catch(() => null)
  if (!callerEmail && exist) {
    return c.json({ error: '이미 가입된 이메일입니다 — ' + inv.email + ' 로 로그인하면 자동으로 참여됩니다.', code: 'login_required', invite_email: inv.email }, 401)
  }
  const selfAccept = !!callerEmail          // 초대 이메일 본인이 로그인한 상태
  const name = String(body.name || '').trim()
  const password = String(body.password || '')
  if (!exist && !selfAccept) {
    // 🔴 이름 필수 · 비밀번호 필수(가입과 동일 기준 8자) — 기본 비밀번호는 존재하지 않는다.
    if (!name) return c.json({ error: '이름을 입력해 주세요.' }, 400)
    if (password.length < INVITE_MIN_PASSWORD) return c.json({ error: `비밀번호는 ${INVITE_MIN_PASSWORD}자 이상이어야 합니다.` }, 400)
  }

  // 토큰을 '먼저' 원자적으로 소비한다(compare-and-swap). used=0 인 행을 갱신한 쪽만 1건을 얻으므로
  // 동시 요청/링크 재사용이 계정을 두 번 만들 수 없다.
  const consumed: any = await c.env.DB.prepare('UPDATE project_invites SET used = 1, used_at = ? WHERE id = ? AND used = 0 AND revoked = 0')
    .bind(Date.now(), inv.id).run()
  const changes = Number((consumed && consumed.meta && (consumed.meta.changes ?? consumed.meta.changed_db)) ?? 0)
  if (!changes) return c.json({ error: '이미 사용된 초대 링크입니다.' }, 409)

  const now = Date.now()
  if (selfAccept) {
    // 본인 로그인 상태 — 계정 생성·세션 발급 없이 멤버 편입만(이미 가진 세션을 그대로 쓴다)
    await grantProjectMembership(c, inv.project_id, inv.email, inv.role, inv.invited_by || 'invite', now)
    await logActivity(c, 'project.invite.accept', { actor: { email: inv.email }, targetType: 'project', targetId: inv.project_id, detail: { role: inv.role, created: false, logged_in: true } })
    return c.json({ success: true, email: inv.email, role: inv.role, project_id: inv.project_id, created: false, logged_in: true })
  }
  if (!exist) {
    const { hash, salt } = await hashPassword(password)
    await c.env.DB.prepare(
      `INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, must_change_password, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, pw_hash = excluded.pw_hash, pw_salt = excluded.pw_salt, must_change_password = 0, updated_at = excluded.updated_at, deleted = 0`
    ).bind(inv.email, name, emailDomain(inv.email), hash, salt, now, now).run()
    try {
      await c.env.DB.prepare(
        `INSERT INTO tenant_members (tenant_id, email, role, created_at) VALUES ('tnt_default', ?, 'viewer', ?)
         ON CONFLICT(tenant_id, email) DO NOTHING`
      ).bind(inv.email, now).run()
    } catch (e) {}
  }

  await grantProjectMembership(c, inv.project_id, inv.email, inv.role, inv.invited_by || 'invite', now)

  // 자동 로그인 — 기존 local_sessions 경로 재사용(새 세션 체계 없음)
  const token = randToken('local-')
  await c.env.DB.prepare('INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
    .bind(token, inv.email, now, now + LOCAL_SESSION_TTL_MS).run()
  await c.env.DB.prepare('UPDATE local_users SET last_login_at = ? WHERE email = ?').bind(now, inv.email).run().catch(() => {})
  await logActivity(c, 'project.invite.accept', { actor: { email: inv.email }, targetType: 'project', targetId: inv.project_id, detail: { role: inv.role, created: !exist } })

  const u: any = await c.env.DB.prepare('SELECT name FROM local_users WHERE email = ?').bind(inv.email).first().catch(() => null)
  return c.json({
    success: true, token, email: inv.email, name: (u && u.name) || name || inv.email.split('@')[0],
    role: inv.role, project_id: inv.project_id, created: !exist
  })
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
  if (!(await canManageMembers(c, user, pid))) return c.json({ error: 'forbidden — only the project owner or super admin can manage members' }, 403)
  const email = normEmail(decodeURIComponent(c.req.param('email')))
  // [WO 20261001-invite ③] 소유자 자신은 제거할 수 없다(super 포함)
  const ownRow: any = await c.env.DB.prepare('SELECT owner FROM projects WHERE id = ?').bind(pid).first()
  if (ownRow && isProjectOwner(ownRow.owner, email)) return c.json({ error: '프로젝트 소유자는 제거할 수 없습니다.' }, 400)
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
  // [WO 20261001-invite ③] 승인 = 멤버 추가 → 소유자·super 만
  if (!(await canManageMembers(c, user, pid))) return c.json({ error: 'forbidden — only the project owner or super admin can manage members' }, 403)
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
  await projectBands(c, pid)   // [WO 20261001-startno] 승인 = 멤버 추가 → 빈 번호 대역 자동 배정
  await logActivity(c, 'project.access.approved', { actor: user, targetType: 'project', targetId: pid, detail: { email: req.email } })
  return c.json({ success: true })
})

// 신청 거절
app.post('/api/projects/:id/access-requests/:rid/reject', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'login required' }, 401)
  const pid = c.req.param('id')
  if (!(await canManageMembers(c, user, pid))) return c.json({ error: 'forbidden — only the project owner or super admin can manage members' }, 403)
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
  // [WO 20261001-invite] 공용석/열람 토큰(auto.designer)은 아무 프로젝트도 관리하지 않는다(isProjectOwner 와 같은 규칙)
  if (user._auto || !isProjectOwner(user.email, user.email)) return c.json({ data: [] })
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
    // [WO 20261001-invite ③] 매트릭스도 멤버 추가·제거·역할 변경 → 소유자·super 만 · 소유자 제거 불가
    if (!(await canManageMembers(c, user, u.project_id))) continue
    const email = normEmail(u.email)
    if (!email || !isValidEmail(email)) continue
    if (u.role === 'none') {
      const ownRow: any = await c.env.DB.prepare('SELECT owner FROM projects WHERE id = ?').bind(u.project_id).first()
      if (ownRow && isProjectOwner(ownRow.owner, email)) continue
      await c.env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND email = ?').bind(u.project_id, email).run()
    } else {
      const role = ['viewer', 'editor', 'designer'].includes(u.role) ? u.role : 'viewer'
      await c.env.DB.prepare(
        `INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, email) DO UPDATE SET role = excluded.role`
      ).bind(u.project_id, email, role, user.email, now).run()
      await projectBands(c, u.project_id)   // [WO 20261001-startno] 매트릭스 추가도 빈 번호 대역 자동 배정
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
  // [WO 20260921 publish-guard] 공유할 도면이 없는 배포는 "배포됨"인데 주소가 없는 모순을 만든다
  // (뷰어 딥링크 ?d= 는 deployment_id 를 가진 decks 에서만 파생된다 — 12_ProjectHub._deployUrl 참조).
  // → 배포 전에 최소 1개 도면(구역) 등록을 강제한다. 이유는 message 로 그대로 클라이언트에 전달.
  const deckRow: any = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM decks WHERE project_id = ? AND deleted = 0 AND deployment_id IS NOT NULL'
  ).bind(pid).first()
  if (!deckRow || !deckRow.n) {
    return c.json({ error: '도면을 먼저 등록해야 배포할 수 있습니다 — 도면(구역) 없이는 공유 링크를 만들 수 없습니다.' }, 400)
  }
  const now = Date.now()
  await c.env.DB.prepare('UPDATE projects SET published = 1, published_at = ?, published_by = ?, updated_at = ? WHERE id = ? AND deleted = 0')
    .bind(now, user.email, now, pid).run()
  // [P61] 공유 주소 토큰 — 없을 때만 1회 발급한다.
  //   🔴 재배포/이름변경에서 **절대 재발급하지 않는다**: 이미 고객에게 나간 링크가 죽으면 안 된다.
  //   slug 는 저장하지 않는다(응답 시 name 에서 파생) → 이름을 바꾸면 주소의 이름 부분만 따라 바뀌고
  //   토큰은 그대로이므로 옛 링크·새 링크가 **둘 다** 열린다.
  await ensureShareToken(c, pid)
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
  // [WO 20260921] 트리의 '도면' 단을 그리려면 deployment 의 파일명이 필요하다 → LEFT JOIN 으로 동봉.
  //   d.* 로 기존 컬럼은 전부 그대로 나가고, 별칭 2개만 추가된다(응답 필드 추가 전용).
  const { results } = await c.env.DB.prepare(
    `SELECT d.*, dp.title AS deployment_title, dp.file_name AS deployment_file_name
       FROM decks d
       LEFT JOIN deployments dp ON dp.id = d.deployment_id AND dp.deleted = 0
      WHERE d.project_id = ? AND d.deleted = 0
      ORDER BY COALESCE(d.level_no, 999999), d.created_at`
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
  // [WO 20260921] parent_id — 상위 구역 id. 미전송이면 NULL(=최상위 구역, 구버전과 동일).
  const parentId = body.parent_id != null && String(body.parent_id) !== '' ? String(body.parent_id) : null
  // [WO 20260930-fixmode] mode — 'checker'|'360' 외 400. 미전송 = NULL(두 모드 공용, 구버전과 동일). 영역은 부모 상속.
  const pm = parseDeckMode(body.mode)
  if (pm.error) return c.json({ error: pm.error }, 400)
  const rm = await resolveDeckMode(c.env.DB, parentId, pm.mode, null)
  if (rm.error) return c.json({ error: rm.error }, 400)
  const mode = rm.mode
  // [WO 20260930-merge] 원본 상자(벡터 복사 구역) — 미전송이면 NULL(레거시와 동일). 형식 오류 400.
  const sb = parseDeckSrcBox(body)
  if (sb.error) return c.json({ error: sb.error }, 400)
  const src = sb.set || { dep: null, page: null, crop: null }
  // [WO 20260929-parent-guard] 🔴 신뢰 경계 — 같은 프로젝트의 살아있는 deck 이 아니면 400.
  //   조용히 null 로 바꾸지 않는다(다른 프로젝트/삭제된 deck 을 가리키는 고아 생성을 서버에서 차단).
  if (parentId && !(await isLiveDeckInProject(c.env.DB, parentId, pid))) {
    return c.json({ error: 'parent_id must reference a live deck in the same project' }, 400)
  }
  await c.env.DB.prepare(
    `INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, mode, src_dep_id, src_page, src_crop, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, pid, name, body.level_no ?? null, body.deployment_id || null, page, crop, parentId, mode, src.dep, src.page, src.crop, now, now).run()
  return c.json(mapDeck({ id, project_id: pid, name, level_no: body.level_no ?? null, deployment_id: body.deployment_id || null, page, crop, parent_id: parentId, mode, src_dep_id: src.dep, src_page: src.page, src_crop: src.crop, created_at: now, updated_at: now }))
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
  // [WO 20260921] parent_id 부분 수정 — 미전송이면 기존값 유지. 자기 자신을 부모로 두는 순환은 거부.
  let parentId = body.parent_id !== undefined
    ? (body.parent_id != null && String(body.parent_id) !== '' ? String(body.parent_id) : null)
    : (row.parent_id ?? null)
  if (parentId === id) return c.json({ error: 'parent_id cannot be self' }, 400)
  // [WO 20260929-parent-guard] 🔴 같은 신뢰 경계 — PUT 도 같은 프로젝트의 살아있는 deck 만 부모로 허용.
  if (parentId && !(await isLiveDeckInProject(c.env.DB, parentId, row.project_id))) {
    return c.json({ error: 'parent_id must reference a live deck in the same project' }, 400)
  }
  // [WO 20260930-fixmode] mode 부분 수정 — 미전송이면 기존값 유지. 'checker'|'360' 외 400. 부모 태그와 불일치 400.
  const pm = parseDeckMode(body.mode)
  if (pm.error) return c.json({ error: pm.error }, 400)
  const rm = await resolveDeckMode(c.env.DB, parentId, pm.mode, row.mode ?? null)
  if (rm.error) return c.json({ error: rm.error }, 400)
  const mode = rm.mode
  // [WO 20260930-merge] 원본 상자 부분 수정 — 미전송이면 기존값 유지. 셋 묶음·형식 오류 400.
  const sb = parseDeckSrcBox(body)
  if (sb.error) return c.json({ error: sb.error }, 400)
  const src = sb.set || { dep: row.src_dep_id ?? null, page: row.src_page ?? null, crop: row.src_crop ?? null }
  await c.env.DB.prepare(
    'UPDATE decks SET name = ?, level_no = ?, deployment_id = ?, page = ?, crop = ?, parent_id = ?, mode = ?, src_dep_id = ?, src_page = ?, src_crop = ?, updated_at = ? WHERE id = ?'
  ).bind(name, level, dep, page, crop, parentId, mode, src.dep, src.page, src.crop, Date.now(), id).run()
  return c.json(mapDeck({ ...row, name, level_no: level, deployment_id: dep, page, crop, parent_id: parentId, mode, src_dep_id: src.dep, src_page: src.page, src_crop: src.crop }))
})

// [WO 20260930-merge] 구역 합치기 미리보기 — "같은 위치 중복 핀" Jev 판정(원시 확률만). 디자이너 전용.
//   🔴 키는 서버 시크릿(OPENROUTER_API_KEY)에서만 — 응답엔 확률·라벨·실패 사유만 싣는다.
//   게이트·거리 규칙 폴백은 클라(41_RegionMerge.js RegionMerge.decideDup)가 한다. 실패도 200 + ok:false(값으로 구분).
app.post('/api/merge/dup-check', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const sp = sanitizeDupPairs(body && body.pairs)
  if (sp.error || !sp.pairs) return c.json({ error: sp.error || 'invalid pairs' }, 400)
  const t0 = Date.now()
  const res = await askJevDupPairs(c.env, sp.pairs)
  // 감사(스킬 §7-5) — 내용 없이 건수·성공 여부·지연만
  await logActivity(c, 'merge.dupcheck', { actor: user, targetType: 'merge', detail: { pairs: sp.pairs.length, ok: res.ok, error: res.ok ? null : res.error, ms: Date.now() - t0 } })
  return c.json(res)
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
    // [WO 20260930-WP3] 소속 프로젝트(NULL = 레거시·귀속 불명)
    project_id: r.project_id || null,
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
  // [설계서 D4 · 버전 폴링] ?fields=version → 편집 화면의 20초 폴링이 쓰는 경량 응답(pins 등 본문 없이 버전만).
  //   권한 가드(로그인·테넌트)는 아래 그대로 공유한다 — 별도 라우트를 만들지 않는다.
  const light = c.req.query('fields') === 'version'
  const row = await c.env.DB.prepare(light
    ? 'SELECT id, version, deleted, tenant_id FROM deployments WHERE id = ?'
    : 'SELECT * FROM deployments WHERE id = ?').bind(id).first()
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
  if (light) {
    const r = row as any
    return c.json({ id: r.id, version: (r.version != null ? r.version : 0), deleted: !!r.deleted })
  }
  return c.json(mapDeployment(row))
})

// 생성 (배포) — 디자이너 이상
app.post('/tables/deployments', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  // [WO 20260930-WP3] 소속 프로젝트 — 보냈으면 그 프로젝트 쓰기 권한 필수(남의 프로젝트에 배포본/원본을 꽂는 것 차단).
  //   미전송(구버전 클라) = NULL(레거시 규칙).
  const projectId = (typeof body.project_id === 'string' && body.project_id) ? body.project_id : null
  const denied = await deploymentWriteDenied(c, user, projectId)
  if (denied) return c.json({ error: denied.error }, denied.status)

  const id = genId('dep')
  const now = Date.now()
  // [PART 0 · Tenant 격리] 새 배포본은 작성자 테넌트로 귀속(슈퍼/미등록은 기본 테넌트)
  const ownerTenant = (await tenantOf(c, user)) || DEFAULT_TENANT
  await c.env.DB.prepare(
    `INSERT INTO deployments (id, title, file_name, drawing_data, pages_data, pins, zones, annotations, source_meta, checkboard_start, tenant_id, project_id, created_at, updated_at, version, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
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
    projectId,
    now, now
  ).run()

  // [WO 20260930-WP3 · C3] 프로젝트 원본 지정 — 클라가 "프로젝트 단위 첫 도면 등록"(original:true)으로 보낸 것만,
  //   그리고 그 프로젝트의 원본이 **비어 있을 때만**(first-wins, 조건부 UPDATE 1문 = 경합에도 1개). 구역 복사본은 original 미전송.
  let isProjectOriginal = false
  if (projectId && body.original === true) {
    const r: any = await c.env.DB.prepare(
      'UPDATE projects SET original_deployment_id = ? WHERE id = ? AND deleted = 0 AND original_deployment_id IS NULL'
    ).bind(id, projectId).run()
    isProjectOriginal = !!(r && r.meta && r.meta.changes)
  }

  let pinCount = 0
  try { pinCount = Array.isArray(JSON.parse(body.pins || '[]')) ? JSON.parse(body.pins || '[]').length : 0 } catch {}
  await logActivity(c, 'deployment.create', { targetType: 'deployment', targetId: id, detail: { title: body.title || '', file_name: body.file_name || '', pins: pinCount } })

  return c.json(Object.assign(mapDeployment({
    id, title: body.title || '', file_name: body.file_name || '',
    drawing_data: body.drawing_data || null, pages_data: body.pages_data || null,
    pins: body.pins || '[]', zones: body.zones || '[]', annotations: body.annotations || '[]',
    source_meta: body.source_meta || null,
    checkboard_start: body.checkboard_start || null,
    project_id: projectId,
    created_at: now, updated_at: now, version: 0, deleted: 0
  }), { is_project_original: isProjectOriginal }))
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
  // [WO 20260930-WP3 · B5] 프로젝트 단위 쓰기 권한(공유 지점)
  {
    const denied = await deploymentWriteDenied(c, user, (existing as any).project_id)
    if (denied) return c.json({ error: denied.error }, denied.status)
  }
  // [WO 20261001-bulkreauth] 핀 일괄삭제 저장 = X-Reauth 헤더가 실린 요청. 재인증 무효/만료 또는 소유자·super 아님 → 403.
  //   🔴 한계: pins 는 JSON 통째 저장이라 헤더를 뺀 요청은 일괄삭제인지 서버가 식별할 수 없다(UI 오조작·무단 사용 방지 목적).
  {
    const rx = c.req.header('X-Reauth')
    if (rx != null) {
      if (!(await reauthTokenValid(c, rx, user.email))) return c.json({ error: 'reauth required — expired or invalid', reauth_required: true }, 403)
      if (!(await canManageMembers(c, user, (existing as any).project_id))) return c.json({ error: 'forbidden — only the project owner or super admin can bulk delete pins' }, 403)
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
  // [WO 20260930-WP3 · B5] 프로젝트 단위 쓰기 권한(공유 지점)
  {
    const denied = await deploymentWriteDenied(c, user, dep.project_id)
    if (denied) return c.json({ error: denied.error }, denied.status)
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
          // [WO 20261002-gap 묶음C] 오프라인 생성도 due_at·severity 를 잃지 않는다(형제 호출부 = POST /api/notes).
          const dueAt = (d.due_at != null && Number.isFinite(Number(d.due_at))) ? Number(d.due_at) : null
          const severityIn = (typeof d.severity === 'string' && SEVERITY_LEVELS.includes(d.severity as any)) ? d.severity : null
          await c.env.DB.prepare(
            `INSERT INTO pin_notes
              (id, deployment_id, pin_id, pin_label, body, status, assignee, due_at, severity, author, author_email, author_role, created_at, updated_at, resolved_at, deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
          ).bind(
            newId, id, String(d.pin_id || ''), String(d.pin_label || ''),
            String(d.body || '').slice(0, 4000), status,
            (d.assignee ? String(d.assignee) : null), dueAt, severityIn, String(d.author || '익명'),
            d.author_email || null, d.author_role || 'guest',
            opTsNote, opTsNote, status === 'done' ? opTsNote : null
          ).run()
          noteIdMap[localId] = newId
        } else {
          const fields: string[] = []; const args: any[] = []
          if (typeof d.body === 'string') { fields.push('body = ?'); args.push(d.body.slice(0, 4000)) }
          // [WO 20261002-gap 묶음C] 🔴 형제 호출부(PATCH /api/notes/:id)와 같은 게이트 — 오프라인 큐도 우회 불가.
          //   권한 없는 verified 는 조용히 건너뛴다(배치의 다른 엔티티 동기화를 막지 않는다 — 조용한 실패 아님, 그 필드만 미반영).
          if (typeof d.status === 'string' && VALID_STATUS_PATCH.includes(d.status) &&
              (d.status !== 'verified' || await canManageMembers(c, user, dep.project_id))) {
            fields.push('status = ?'); args.push(d.status)
            fields.push('resolved_at = ?'); args.push((d.status === 'done' || d.status === 'verified') ? opTsNote : null)
          }
          if (typeof d.assignee === 'string') { fields.push('assignee = ?'); args.push(d.assignee.trim() || null) }
          if (d.due_at !== undefined) {
            const dueAt2 = d.due_at === null ? null : Number(d.due_at)
            if (dueAt2 === null || Number.isFinite(dueAt2)) { fields.push('due_at = ?'); args.push(dueAt2) }
          }
          if (d.severity !== undefined) {
            const sev2 = (typeof d.severity === 'string' && SEVERITY_LEVELS.includes(d.severity as any)) ? d.severity : null
            fields.push('severity = ?'); args.push(sev2)
          }
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
  const row: any = await c.env.DB.prepare('SELECT tenant_id, project_id FROM deployments WHERE id = ?').bind(id).first()
  // [PART 0 · Tenant 격리] 타 테넌트 배포본 삭제 차단(슈퍼/마이그레이션전 제외)
  const tid = await tenantOf(c, user)
  if (tid && row) {
    const rowTenant = row.tenant_id || DEFAULT_TENANT
    if (rowTenant !== tid) return c.json({ error: 'not found' }, 404)
  }
  // [WO 20260930-WP3 · B5] 프로젝트 단위 쓰기 권한(공유 지점)
  if (row) {
    const denied = await deploymentWriteDenied(c, user, row.project_id)
    if (denied) return c.json({ error: denied.error }, denied.status)
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
   [WO 20261001-viewreq] 열람자 요청·질문 — 같은 테이블(kind/parent_id/deck_id, 0034):
   · 열람자(viewer 멤버·공유/배포 링크 익명) = kind request|question · status open 고정 · 익명은 이름 필수
   · 핀 없는 요청 = pin_id ''(도면/구역 단위) + deck_id. 답변 = 디자이너만, kind reply + parent_id
   · 본인 판정: 실계정 = 이메일, 익명 = 작성 응답의 수정키(X-Note-Key, DB 엔 해시만)
════════════════════════════════════════════ */
const VALID_STATUS = ['open', 'progress', 'done']
/** [WO 20261002-gap 묶음C] 결함 노트 전용 4단계 — '확인(verified)'은 소유자·super 만(canVerifyNoteByDeployment, 아래).
 *  생성 시점(VALID_STATUS)엔 포함하지 않는다 — 확인은 완료 뒤 검토 행위라 처음부터 고를 값이 아니다. */
const VALID_STATUS_PATCH = ['open', 'progress', 'done', 'verified']

/** withContact = 디자이너 응답에만 익명 회신 이메일(author_contact)을 싣는다(열람자끼리 노출 금지). */
function mapNote(r: any, withContact = false) {
  return {
    ...(withContact ? { author_contact: r.author_contact ?? null } : {}),
    kind: r.kind || 'note',
    parent_id: r.parent_id ?? null,
    deck_id: r.deck_id ?? null,
    id: r.id,
    deployment_id: r.deployment_id,
    pin_id: r.pin_id,
    pin_label: r.pin_label,
    body: r.body,
    status: r.status,
    assignee: r.assignee,
    due_at: r.due_at ?? null,          // [WO 20261002-gap] 기한(epoch ms)
    severity: r.severity ?? null,      // [WO 20261002-gap] '상'|'중'|'하'(사람이 확정한 값만)
    author: r.author,
    author_email: r.author_email,
    author_role: r.author_role,
    created_at: r.created_at,
    updated_at: r.updated_at,
    resolved_at: r.resolved_at,
  }
}

/** [WO 20261001-viewreq] 🔴 노트 주체 판정 — 단일 지점(작성·수정·삭제·요청함이 공유).
 *  guest    = 열람전용 세션(공유/배포 링크 — 공용 계정 이메일이라 신원이 아니다) 또는 토큰 없음
 *  viewer   = 실계정 비디자이너(프로젝트 viewer 멤버 등)
 *  designer/super = 실계정 + isDesigner */
async function noteActor(c: any): Promise<{ user: any, designer: boolean, role: 'super' | 'designer' | 'viewer' | 'guest', email: string | null }> {
  const user = await getUser(c)
  if (!user || user._readonly) return { user, designer: false, role: 'guest', email: null }
  const designer = await isDesigner(c, user.email)
  return { user, designer, role: designer ? (isSuperAdmin(c, user.email) ? 'super' : 'designer') : 'viewer', email: String(user.email || '').toLowerCase() || null }
}

/** [WO 20261001-viewreq] 노트가 속한 구역/영역(decks.id) 확정 — 요청함 그룹핑 키.
 *  핀 요청: 배포본 핀 좌표(page·x·y %)를 이 배포본 deck 들의 crop(% · NULL = 페이지 전체)에 대어 **가장 작은** deck(= 가장 깊은 영역).
 *  핀 없는 요청: 클라가 보던 deck(hint)이 이 배포본 deck 이면 그것, 아니면 최상위 구역(parent_id NULL) 우선.
 *  특정 불가(이 배포본을 가리키는 deck 0) = null — 지어내지 않는다(요청함이 "구역 미지정"으로 정직하게 표시). */
async function resolveNoteDeck(c: any, depId: string, pinId: string, hint: string): Promise<string | null> {
  let decks: any[] = []
  try {
    decks = (await c.env.DB.prepare(
      'SELECT id, page, crop, parent_id FROM decks WHERE deployment_id = ? AND deleted = 0 ORDER BY COALESCE(level_no, 999999), created_at'
    ).bind(depId).all()).results || []
  } catch { return null }
  if (!decks.length) return null
  const rootFirst = decks.find((d: any) => !d.parent_id) || decks[0]
  if (!pinId) return String((hint && decks.find((d: any) => String(d.id) === hint)) ? hint : rootFirst.id)
  let pin: any = null
  try {
    const dep: any = await c.env.DB.prepare('SELECT pins FROM deployments WHERE id = ?').bind(depId).first()
    const pins = JSON.parse((dep && dep.pins) || '[]')
    pin = (Array.isArray(pins) ? pins : []).find((p: any) => p && String(p.id) === pinId) || null
  } catch { pin = null }
  if (!pin) return String(rootFirst.id)
  const pg = Number(pin.page) || 1, x = Number(pin.x), y = Number(pin.y)
  let best: any = null, bestArea = Infinity
  for (const d of decks) {
    if (d.page != null && Number(d.page) !== pg) continue
    let crop: any = null
    try { crop = d.crop ? JSON.parse(d.crop) : null } catch { crop = null }
    let area = 100 * 100
    if (crop && crop.w > 0 && crop.h > 0) {
      if (!(x >= crop.x && x <= crop.x + crop.w && y >= crop.y && y <= crop.y + crop.h)) continue
      area = crop.w * crop.h
    }
    if (area < bestArea || (area === bestArea && best && !best.parent_id && d.parent_id)) { best = d; bestArea = area }
  }
  return String((best || rootFirst).id)
}

/** [WO 20261001-viewreq] 디자이너 요청함 — 프로젝트의 모든 구역/영역 배포본에 달린 요청·질문 + 답변.
 *  권한 = 그 프로젝트 쓰기 권한(deploymentWriteDenied — 슈퍼·소유자·designer 멤버, SoT). 그룹핑은 클라가 트리 SoT(groupDecksByParent)로. */
app.get('/api/projects/:id/requests', async (c) => {
  const a = await noteActor(c)
  if (a.role === 'guest') return c.json({ error: 'unauthorized' }, 401)
  const pid = c.req.param('id')
  const denied = await deploymentWriteDenied(c, a.user, pid)
  if (denied) return c.json({ error: denied.error }, denied.status)
  const { results } = await c.env.DB.prepare(
    `SELECT n.* FROM pin_notes n
      WHERE n.deleted = 0 AND n.kind IN ('request', 'question', 'reply', 'note')
        AND n.deployment_id IN (SELECT deployment_id FROM decks WHERE project_id = ? AND deleted = 0 AND deployment_id IS NOT NULL)
      ORDER BY n.created_at ASC LIMIT 2000`
  ).bind(pid).all()
  const rows: any[] = results || []
  const tops = new Set(rows.filter((r) => r.kind !== 'reply').map((r) => String(r.id)))
  const data = rows.filter((r) => r.kind !== 'reply' || tops.has(String(r.parent_id))).map((r) => mapNote(r, true))
  // [WO 20261002-gap] 미완 = done·verified 둘 다 제외(결함 노트의 '확인' 단계까지 처리된 것으로 본다)
  const open = data.filter((n: any) => n.kind !== 'reply' && n.status !== 'done' && n.status !== 'verified').length
  return c.json({ data, open })
})

// 노트 목록 — deployment_id 필수, pin_id 선택, status 선택
app.get('/api/notes', async (c) => {
  const actor = await noteActor(c)
  if (!actor.user) return c.json({ error: 'unauthorized' }, 401)   // [보안 M2] 노트(이슈)는 로그인 사용자만
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
  return c.json({ data: (results || []).map((r: any) => mapNote(r, actor.designer)), total: (results || []).length })
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
     FROM pin_notes WHERE deleted = 0 AND deployment_id = ? AND kind != 'reply'
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
  const a = await noteActor(c)
  let deployment_id = String(body.deployment_id || '').trim()
  let pin_id = String(body.pin_id ?? '').trim()
  const text = String(body.body || '').trim()
  // [WO 20261001-viewreq] 종류 — 디자이너 기본 note(종전), 열람자 기본 request. 열람자는 request|question 만.
  let kind = String(body.kind || (a.designer ? 'note' : 'request'))
  if (!NOTE_KINDS.includes(kind)) return c.json({ error: 'invalid kind' }, 400)
  const parentId = String(body.parent_id || '').trim()
  let parent: any = null
  if (kind === 'reply' || parentId) {   // 답변 권한은 아래 단일 판정(열람자 = request|question 만)이 끊는다
    if (!parentId) return c.json({ error: 'parent_id required' }, 400)
    parent = await c.env.DB.prepare('SELECT * FROM pin_notes WHERE id = ? AND deleted = 0').bind(parentId).first()
    if (!parent) return c.json({ error: 'parent not found' }, 404)
    kind = 'reply'; deployment_id = String(parent.deployment_id); pin_id = String(parent.pin_id || '')   // 답변은 원 요청 위치를 그대로 따른다
  }
  if (!a.designer && !NOTE_VIEWER_KINDS.includes(kind)) return c.json({ error: 'forbidden — viewers can only send request or question' }, 403)
  // 핀 없는(도면/구역 단위) 글은 요청·질문·답변만 — 종전 이슈 노트(kind=note)는 핀 필수 그대로
  if (!deployment_id || (!pin_id && kind === 'note')) return c.json({ error: 'deployment_id, pin_id required' }, 400)
  if (!text) return c.json({ error: 'body required' }, 400)
  if (text.length > NOTE_BODY_MAX) return c.json({ error: 'body too long' }, 400)

  // 작성자 — 실계정은 계정 정보, 익명(공유/배포 링크·무토큰)은 자기 신고 이름(필수) + 회신 이메일(선택)
  let author: string, author_contact: string | null = null
  if (a.role === 'guest') {
    author = String(body.author || '').trim()
    if (!author) return c.json({ error: '이름을 입력하세요.' }, 400)
    if (author.length > NOTE_AUTHOR_MAX) return c.json({ error: `이름은 ${NOTE_AUTHOR_MAX}자 이내로 입력하세요.` }, 400)
    const contact = String(body.contact || '').trim()
    if (contact && (contact.length > NOTE_CONTACT_MAX || !isValidEmail(contact))) return c.json({ error: '회신 이메일 형식이 올바르지 않습니다.' }, 400)
    author_contact = contact || null
    // 🔴 초대코드 게이트 — 읽기와 같은 판정(shareGateLockedPid). 코드 미통과 링크 세션은 쓰지도 못한다.
    const locked = await shareGateLockedPid(c, a.user, await projectIdsOfDeployment(c, deployment_id))
    if (locked) return c.json({ error: 'gate required — invite code', gate_required: true, project_id: locked }, 403)
  } else {
    author = a.user.name || a.user.email
  }
  // 남용 방지 — 열람자(익명·viewer)만 IP 당 분당 N건. 디자이너 작성·답변은 ip 를 남기지 않아 집계에서 빠진다.
  const limiterKey = a.designer ? null : rateLimitKey(c)
  if (limiterKey && await overRateLimit(c, 'pin_notes', limiterKey, NOTE_REQUEST_RATE_LIMIT_PER_MIN)) {
    return c.json({ error: '요청이 너무 자주 접수되었습니다. 잠시 후 다시 시도해 주세요.' }, 429)
  }
  let status = a.designer ? String(body.status || 'open') : 'open'
  if (!VALID_STATUS.includes(status)) status = 'open'
  const assignee = a.designer ? (String(body.assignee || '') || null) : null
  // [WO 20261002-gap 묶음C] 기한·심각도 — 생성 시점은 디자이너만, '확인' 단계는 생성 시 불가(VALID_STATUS 에 verified 없음).
  const due_at = (a.designer && body.due_at != null && Number.isFinite(Number(body.due_at))) ? Number(body.due_at) : null
  let severity: string | null = a.designer && typeof body.severity === 'string' ? body.severity : null
  if (severity && !SEVERITY_LEVELS.includes(severity as any)) severity = null
  const deck_id = parent ? (parent.deck_id ?? null) : await resolveNoteDeck(c, deployment_id, pin_id, String(body.deck_id || ''))
  const pin_label = parent ? String(parent.pin_label || '') : String(body.pin_label || '').slice(0, 200)
  // 익명 본인 확인 수정키 — 원문은 이 응답에만, DB 엔 해시만(초대 토큰과 같은 규칙)
  const editKey = a.role === 'guest' ? randToken('nk-') : null
  const author_key_hash = editKey ? await sha256Hex(editKey) : null

  const id = genId('note')
  const now = Date.now()
  const row = {
    id, deployment_id, pin_id, pin_label, body: text, status, assignee, due_at, severity, author, author_email: a.email, author_role: a.role,
    created_at: now, updated_at: now, resolved_at: status === 'done' ? now : null,
    kind, parent_id: parent ? String(parent.id) : null, deck_id, author_contact,
  }
  await c.env.DB.prepare(
    `INSERT INTO pin_notes
      (id, deployment_id, pin_id, pin_label, body, status, assignee, due_at, severity, author, author_email, author_role, created_at, updated_at, resolved_at, deleted,
       kind, parent_id, deck_id, author_contact, author_key_hash, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.id, row.deployment_id, row.pin_id, row.pin_label, row.body, row.status, row.assignee, row.due_at, row.severity, row.author, row.author_email, row.author_role,
    row.created_at, row.updated_at, row.resolved_at, row.kind, row.parent_id, row.deck_id, row.author_contact, author_key_hash, limiterKey
  ).run()
  return c.json({ ...mapNote(row, a.designer || a.role === 'guest'), ...(editKey ? { edit_key: editKey } : {}) })
})

/** 노트 수정 권한 — 'designer'(내용·상태·담당자) · 'author'(자기 글) · null.
 *  🔴 열람전용 세션은 공용 계정 이메일이라 이메일 일치로 본인을 판정하면 남의 익명 글까지 고친다 → 수정키(X-Note-Key)만 인정. */
async function noteEditRight(c: any, note: any): Promise<'designer' | 'author' | null> {
  const a = await noteActor(c)
  if (a.designer) return 'designer'
  const key = c.req.header('X-Note-Key') || ''
  if (key && note.author_key_hash && (await sha256Hex(key)) === String(note.author_key_hash)) return 'author'
  if (a.email && note.author_email && String(note.author_email).toLowerCase() === a.email) return 'author'
  return null
}

// 노트 수정(내용/상태/담당자)
app.patch('/api/notes/:id', async (c) => {
  const id = c.req.param('id')
  const note = await c.env.DB.prepare('SELECT * FROM pin_notes WHERE id = ? AND deleted = 0').bind(id).first()
  if (!note) return c.json({ error: 'not found' }, 404)
  const right = await noteEditRight(c, note)
  if (!right) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  // [WO 20261001-viewreq] 요청·질문·답변의 처리 상태·담당자는 디자이너 몫 — 작성자(열람자)는 내용만 고친다.
  // [WO 20261002-gap] due_at·severity 도 같은 등급(결함 노트 전용 필드 — 요청/질문 작성자는 건드릴 수 없다).
  if (right === 'author' && String(note.kind || 'note') !== 'note' &&
      (typeof body.status === 'string' || typeof body.assignee === 'string' || body.due_at !== undefined || body.severity !== undefined)) {
    return c.json({ error: 'forbidden — only designers can change status' }, 403)
  }

  const fields: string[] = []
  const args: any[] = []
  const now = Date.now()
  if (typeof body.body === 'string') {
    const t = body.body.trim()
    if (!t) return c.json({ error: 'body required' }, 400)
    if (t.length > NOTE_BODY_MAX) return c.json({ error: 'body too long' }, 400)
    fields.push('body = ?'); args.push(t)
  }
  if (typeof body.status === 'string' && VALID_STATUS_PATCH.includes(body.status)) {
    // [WO 20261002-gap 묶음C] 🔴 마스터 확정 — '확인(verified)'은 소유자·super 만. 서버 강제(403).
    if (body.status === 'verified') {
      const actor = await noteActor(c)
      if (!(await canVerifyNoteByDeployment(c, actor.user, note.deployment_id))) {
        return c.json({ error: 'forbidden — verified requires project owner or super' }, 403)
      }
    }
    fields.push('status = ?'); args.push(body.status)
    fields.push('resolved_at = ?'); args.push((body.status === 'done' || body.status === 'verified') ? now : null)
  }
  if (typeof body.assignee === 'string') {
    fields.push('assignee = ?'); args.push(body.assignee.trim() || null)
  }
  // [WO 20261002-gap] 기한 — null 허용(해제). 숫자가 아니면 400(지어내지 않음).
  if (body.due_at !== undefined) {
    const d = body.due_at === null ? null : Number(body.due_at)
    if (d !== null && !Number.isFinite(d)) return c.json({ error: 'invalid due_at' }, 400)
    fields.push('due_at = ?'); args.push(d)
  }
  // [WO 20261002-gap] 심각도 — 사람이 저장 전 확정한 값만 저장(Jev 는 제안만, 여기서 자동확정 없음).
  if (body.severity !== undefined) {
    const s = body.severity === null ? null : String(body.severity)
    if (s && !SEVERITY_LEVELS.includes(s as any)) return c.json({ error: 'invalid severity' }, 400)
    fields.push('severity = ?'); args.push(s || null)
  }
  if (fields.length === 0) return c.json({ error: 'nothing to update' }, 400)
  fields.push('updated_at = ?'); args.push(now)
  args.push(id)
  await c.env.DB.prepare(`UPDATE pin_notes SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run()
  const updated = await c.env.DB.prepare('SELECT * FROM pin_notes WHERE id = ?').bind(id).first()
  return c.json(mapNote(updated, right === 'designer'))
})

// 노트 삭제(soft) — 원 요청을 지우면 그 답변도 함께(고아 답변 0)
app.delete('/api/notes/:id', async (c) => {
  const id = c.req.param('id')
  const note = await c.env.DB.prepare('SELECT * FROM pin_notes WHERE id = ? AND deleted = 0').bind(id).first()
  if (!note) return c.json({ error: 'not found' }, 404)
  if (!(await noteEditRight(c, note))) return c.json({ error: 'forbidden' }, 403)
  const now = Date.now()
  await c.env.DB.prepare('UPDATE pin_notes SET deleted = 1, updated_at = ? WHERE id = ? OR parent_id = ?')
    .bind(now, id, id).run()
  return c.json({ success: true })
})

/** [WO 20261002-gap 묶음C·5] 결함 노트 본문 → 심각도 제안(Jev, 원시 확률만). 🔴 사람이 저장 전 확정 —
 *  이 응답은 '제안'일 뿐 저장하지 않는다(PATCH /api/notes/:id 로 severity 를 사람이 확정해 보낸다).
 *  권한 = noteEditRight(이 노트를 고칠 수 있는 사람만 제안도 받는다). 키 없음·실패 = level:null(폴백, 거짓 성공 금지). */
app.post('/api/notes/:id/severity-suggest', async (c) => {
  const id = c.req.param('id')
  const note = await c.env.DB.prepare('SELECT * FROM pin_notes WHERE id = ? AND deleted = 0').bind(id).first()
  if (!note) return c.json({ error: 'not found' }, 404)
  if (!(await noteEditRight(c, note))) return c.json({ error: 'forbidden' }, 403)
  const t0 = Date.now()
  const probe = await askJevSeverity(c.env, String((note as any).body || ''))
  const gate = gateSeverity(probe)
  await logActivity(c, 'note.severity_suggest', { actor: await getUser(c), targetType: 'note', targetId: id,
    detail: { ok: probe.ok, p: gate.p, estimated: gate.estimated, ms: Date.now() - t0 } })
  return c.json({ level: gate.level, estimated: gate.estimated, p: gate.p, ok: probe.ok, error: probe.ok ? null : probe.error })
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
