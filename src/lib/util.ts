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
