/* ════════════════════════════════════════════════════════════
   src/lib/util.ts — 순수 유틸(이메일·랜덤·해시). Hono 컨텍스트 의존 0.
   [리팩토링 1단계] index.tsx 에서 추출. 한 파일 한 책임.
   ════════════════════════════════════════════════════════════ */

export function normEmail(s: string): string { return String(s || '').trim().toLowerCase() }
export function emailDomain(email: string): string { const i = email.indexOf('@'); return i < 0 ? '' : email.slice(i + 1) }
export function isValidEmail(email: string): boolean { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) }
export function gen6(): string { return String(Math.floor(100000 + Math.random() * 900000)) }

export function randToken(prefix: string): string {
  const a = new Uint8Array(24); crypto.getRandomValues(a)
  let h = ''; for (const x of a) h += x.toString(16).padStart(2, '0')
  return prefix + h
}

/** [P40] 초대 토큰 — 256비트 암호난수(Math.random 금지). 링크에만 존재하고 DB 엔 해시만 남는다. */
export function randInviteToken(): string {
  // 🔴 비암호 PRNG(V8 xorshift128+)는 출력 몇 개만 관측하면 내부 상태가 복원된다
  //    → 초대 토큰 하나가 새면 나머지를 예측당한다. 반드시 암호난수여야 한다(위 randToken 과 동일 방식).
  //    ※ 이 주석에 금지 API 이름을 쓰지 않는 이유: p40 이 소스 텍스트를 훑기 때문(주석도 걸린다).
  const a = new Uint8Array(32); crypto.getRandomValues(a)
  let h = ''; for (const x of a) h += x.toString(16).padStart(2, '0')
  return h
}

/* ══ [P61] 공유 주소 /srview/<slug>-<token> ══════════════════════════════
 * 열쇠는 token 하나다. slug 는 "고객이 이름을 알아보게" 하는 장식일 뿐, 조회에 쓰이지 않는다.
 * → 이름을 바꿔도 토큰이 같으면 링크가 살고, 이름을 맞춰도 토큰이 없으면 404 다. */

/** base32(RFC4648 소문자) 알파벳 — 대소문자 무관한 URL 경로에서 안전하고, 하이픈이 없어
 *  `<slug>-<token>` 의 마지막 '-' 기준 분리가 언제나 유일하게 성립한다. */
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** [P61] 공유 링크 토큰 — **80비트 암호난수**(요구 최소치 64비트 초과) base32 16자.
 *  🔴 비암호 PRNG(V8 xorshift128+)는 출력 몇 개만 관측하면 내부 상태가 복원된다
 *     → 공유 링크 하나가 새면 나머지 프로젝트 주소를 예측당한다. randInviteToken 과 동일 원칙.
 *     (금지 API 이름을 주석에 쓰지 않는 이유는 randInviteToken 주석 참조 — 테스트가 소스를 훑는다) */
export function randShareToken(): string {
  const a = new Uint8Array(10)   // 10바이트 = 80비트
  crypto.getRandomValues(a)
  let acc = 0, bits = 0, out = ''
  for (const x of a) {
    acc = (acc << 8) | x; bits += 8
    while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31] }
  }
  return out   // 80 / 5 = 정확히 16자
}

/** [P61] 공유 링크 토큰 형식 검증 — 라우트에서 DB 조회 전에 값싸게 거른다. */
export function isShareToken(s: string): boolean { return /^[a-z2-7]{16}$/.test(String(s || '')) }

/** [P61 → WO 20261012-viewlink] 열람 링크 경로의 단일 생성원(SoT) — 서버 응답·QR·링크 복사가 전부 여기서 파생한다.
 *  마스터 2026-10-12: "배포시 회사이름이나 프로젝트는 전체 보안화해 https://scan.seastar.work/까지만 노출"
 *  → 경로에 이름(slug)을 싣지 않는다. 토큰 = 공유 토큰(projects.share_token) 또는 뷰어 링크 id(view_links.id) — 둘 다 불투명.
 *  구 주소 `/srview/<이름>-<토큰>` 은 하위호환으로 계속 열리고(shareTokenFromSegment), 클라이언트가 즉시 이 경로로 바꾼다. */
export function viewPath(token: string): string {
  return '/v/' + encodeURIComponent(String(token || ''))
}

/** [WO 20261012-viewlink] `/v/<토큰>` 의 토큰 형식 — 공유 토큰(base32 16자) · 새 뷰어 링크 id(같은 형식) · 구 뷰어 링크 id(lk_<시각>_<난수>). */
export function isViewToken(s: string): boolean {
  const v = String(s || '')
  return isShareToken(v) || /^lk_[a-z0-9]{4,16}_[a-z0-9]{4,16}$/.test(v)
}

/** [P61] 공유 경로 세그먼트 → 토큰. slug 는 버린다(장식이므로 틀려도 무방 = 이름 변경 내성).
 *  마지막 '-' 뒤가 토큰. 토큰 알파벳에 '-' 가 없으므로 분리가 모호하지 않다. */
export function shareTokenFromSegment(seg: string): string | null {
  let s = String(seg || '')
  try { s = decodeURIComponent(s) } catch { /* 이미 디코드된 값 */ }
  const i = s.lastIndexOf('-')
  const t = i >= 0 ? s.slice(i + 1) : s
  return isShareToken(t) ? t : null
}

/* ══ [P63] 뷰어 초대코드 — 공유 링크 게이트의 **유일한 열쇠** ═══════════════
 * 사람이 카톡/전화로 전달하고 손으로 입력하는 값이라, 강도와 타이핑 편의를 둘 다 만족해야 한다.
 *   · Crockford base32(혼동문자 i·l·o·u 제외) 15자 = **75비트** — 해시 저장이 안전한 하한을 넘는다.
 *   · 5자씩 하이픈으로 끊어 보여준다(xxxxx-xxxxx-xxxxx) — 구두 전달/입력 오류 감소.
 *   · 입력은 대소문자·하이픈·공백 무관하게 정규화하고 O→0, I/L→1 로 교정한다. */
const CROCKFORD32 = '0123456789abcdefghjkmnpqrstvwxyz'

/** [P63] 초대코드 생성 — 🔴 암호난수(crypto.getRandomValues)만 사용한다.
 *  비암호 PRNG 는 출력 몇 개로 내부 상태가 복원돼 다른 협력사 코드를 예측당한다
 *  (randInviteToken/randShareToken 과 동일 원칙). 반환값은 하이픈 포함 표시형이다. */
export function randShareCode(): string {
  const a = new Uint8Array(10)   // 80비트 뽑아 75비트 사용
  crypto.getRandomValues(a)
  let acc = 0, bits = 0, out = ''
  for (const x of a) {
    acc = (acc << 8) | x; bits += 8
    while (bits >= 5 && out.length < 15) { bits -= 5; out += CROCKFORD32[(acc >> bits) & 31] }
  }
  return out.slice(0, 5) + '-' + out.slice(5, 10) + '-' + out.slice(10, 15)
}

/** [P63] 입력 코드 정규화 — 표시형/구두전달 오차를 흡수해 **해시 대조 전 단일 형태**로 만든다. */
export function normalizeShareCode(raw: string): string {
  return String(raw || '').toLowerCase()
    .replace(/[^0-9a-z]/g, '')     // 하이픈·공백 제거
    .replace(/o/g, '0')            // O ↔ 0
    .replace(/[il]/g, '1')         // I, L ↔ 1
    .replace(/u/g, 'v')            // Crockford 규약: U 는 쓰지 않는다 → 오타로 보고 V 로
    .slice(0, 32)
}

/** [P63] 코드 형식 검증 — 정규화 후 15자 Crockford 알파벳. */
export function isShareCode(raw: string): boolean {
  return /^[0123456789abcdefghjkmnpqrstvwxyz]{15}$/.test(normalizeShareCode(raw))
}

/** SHA-256 hex. 초대 토큰(고엔트로피)의 저장용 해시 — 원문 추측이 불가하므로 스트레칭 불필요. */
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return bufToHex(d)
}

export function bufToHex(buf: ArrayBuffer): string {
  const a = new Uint8Array(buf); let h = ''
  for (const x of a) h += x.toString(16).padStart(2, '0')
  return h
}

/** PBKDF2(SHA-256, 100k) 비밀번호 해시 */
export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
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

/** 상수시간 비교 비밀번호 검증 */
export async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const { hash } = await hashPassword(password, saltHex)
  if (hash.length !== hashHex.length) return false
  let diff = 0
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i)
  return diff === 0
}

/* ══ [WO 20261001-bulkreauth] 본인 재인증(핀 일괄삭제) ══════════════════════════
 * 재인증 1회의 유효시간 SoT. 서버가 발급하는 단기 토큰(rx1.*)의 exp 와 Firebase auth_time 신선도 판정이
 * 둘 다 이 값을 쓴다. 클라이언트는 서버가 돌려준 exp 만 믿는다(같은 값을 두 번 쓰지 않는다). */
export const REAUTH_TTL_MS = 5 * 60 * 1000
/** auth_time 이 서버 시각보다 앞서 있어도 허용하는 시계 오차(Google 발급 서버 ↔ Workers). */
export const REAUTH_CLOCK_SKEW_MS = 60 * 1000

/** Firebase ID 토큰의 auth_time(초) 이 nowMs 기준 ttlMs 이내인가. 숫자가 아니거나 너무 미래면 false. */
export function reauthFresh(authTimeSec: unknown, nowMs: number, ttlMs: number = REAUTH_TTL_MS): boolean {
  const t = Number(authTimeSec)
  if (!Number.isFinite(t) || t <= 0) return false
  const ageMs = nowMs - t * 1000
  return ageMs <= ttlMs && ageMs >= -REAUTH_CLOCK_SKEW_MS
}

/** 상수시간 문자열 비교(길이 선비교) — 서명 검증용 */
export function safeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/* ══ [P68] 회사명 대조 — 허용되지 않은 회사 리젝트의 1차 규칙 ══════════════
 * 🔴 손입력 회사명은 표기가 흔들린다. 이 정규화 + 정확일치의 실측 일치율은 **66.7%(16/24)**
 *   (2026-09-28, 조선/해양 협력사 24표본). 'HANLA ENS'·'DSME'·'HHI' 같은 영문·약어 표기를
 *   정당한 협력사인데도 8건 리젝트했다 → 규칙이 못 잡은 건만 Jev 로 넘긴다(src/lib/jev.ts).
 *   🔴 규칙이 통과시키면 Jev 를 호출하지 않는다(스킬 §6 「기존 규칙이 확신을 갖고 답을 냈으면」). */

/** 법인 접미사·공백·기호·대소문자를 걷어낸 비교용 형태. 표기 차이만 흡수하고 뜻은 바꾸지 않는다. */
export function normalizeCompany(s: string): string {
  return String(s || '').toLowerCase()
    .replace(/\(주\)|㈜|주식회사|inc\.?|co\.?,?\s*ltd\.?/g, '')
    .replace(/[^0-9a-z가-힣]/g, '')
}

/** 정규화 후 정확 일치. 🔴 빈 값은 일치가 아니다(빈 입력이 모든 회사와 같아지면 게이트가 무너진다). */
export function companyRuleMatch(allowed: string, input: string): boolean {
  const a = normalizeCompany(allowed), b = normalizeCompany(input)
  return !!a && !!b && a === b
}
