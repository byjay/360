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

/** [P61] 프로젝트명 → URL 슬러그(장식). 🔴 한글 보존 — 브라우저 주소창은 퍼센트인코딩을
 *  디코딩해 보여주므로 고객이 "선각A동" 을 그대로 읽는다.
 *  · 허용: 숫자·영소문자·한글 음절(가–힣)·한글 자모(ㄱ–ㆎ) — 실데이터 "ㅅㄷㄴㅅ1" 같은 자모 이름 대응
 *  · 그 외(공백·`/`·`?`·`#`·이모지 등)는 '-' 로 접고, 연속/양끝 '-' 를 정리한다
 *  · 빈 이름·기호뿐인 이름 → 'project' (조용히 빈 주소를 만들지 않는다)
 *  · 길이 상한 40 **코드포인트**(바이트가 아니라) — 서로게이트를 잘라 깨진 문자를 만들지 않는다
 *  🔴 반환값은 절대 '-' 로 끝나지 않는다 → `<slug>-<token>` 분리가 항상 유일하다. */
export function slugifyProjectName(name: string): string {
  const base = String(name || '').trim().toLowerCase()
    .replace(/[^0-9a-zㄱ-ㆎ가-힣]+/g, '-')
  const cut = Array.from(base).slice(0, 40).join('')
  const s = cut.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'project'
}

/** [P61] 공유 경로의 단일 생성원(SoT) — 서버 응답·테스트·클라이언트가 전부 이 한 곳에서 파생한다. */
export function sharePath(name: string, token: string): string {
  return '/srview/' + encodeURIComponent(slugifyProjectName(name)) + '-' + token
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
